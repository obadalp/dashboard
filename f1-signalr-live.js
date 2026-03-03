/**
 * F1 SignalR Live Integration pro dashboard
 * ==========================================
 * Přidej tento soubor do dashboardu PŘED </body>:
 *   <script src="f1-signalr-live.js"></script>
 * 
 * Co to dělá:
 * - Připojí se k F1 SignalR přes tvůj Cloudflare Worker
 * - Přijímá real-time data (TimingData, DriverList, TrackStatus, atd.)
 * - Převádí SignalR formát na formát kompatibilní s tvým stávajícím renderem
 * - Fallback na OpenF1 polling pokud SignalR selže
 * 
 * Worker URL: https://f1-live-proxy.obadalp.workers.dev
 */

(function() {
  'use strict';

  // ═══ CONFIG ═══
  const WORKER_URL = 'https://f1-live-proxy.obadalp.workers.dev';
  
  // ═══ STATE ═══
  let signalrConnected = false;
  let signalrWs = null;
  let signalrReconnectAttempts = 0;
  const MAX_RECONNECT = 10;
  let heartbeatTimer = null;
  
  // Živý state z SignalR (deep-merged)
  let srState = {
    TimingData: {},
    DriverList: {},
    SessionInfo: {},
    SessionData: {},
    TrackStatus: {},
    WeatherData: {},
    ExtrapolatedClock: {},
    TopThree: {},
    LapCount: {},
    RaceControlMessages: {},
    TimingStats: {},
    TimingAppData: {}
  };

  // ═══ DEEP MERGE ═══
  function mergeDeep(target, source) {
    if (!source || typeof source !== 'object') return target;
    for (const key of Object.keys(source)) {
      if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
        if (!target[key] || typeof target[key] !== 'object') target[key] = {};
        mergeDeep(target[key], source[key]);
      } else {
        target[key] = source[key];
      }
    }
    return target;
  }

  // ═══ SIGNALR → OPENF1 FORMAT CONVERTER ═══
  // Tvůj dashboard čeká data ve formátu OpenF1 (pole objektů)
  // SignalR posílá jiný formát — tady ho převádíme
  
  function convertTimingToOpenF1() {
    const td = srState.TimingData;
    const dl = srState.DriverList;
    if (!td.Lines) return { positions: [], intervals: [], laps: [] };

    const positions = [];
    const intervals = [];
    const laps = [];

    Object.entries(td.Lines).forEach(([driverNum, data]) => {
      const num = parseInt(driverNum);
      const driver = dl[driverNum] || {};
      
      // Position
      if (data.Position) {
        positions.push({
          driver_number: num,
          position: parseInt(data.Position),
          date: new Date().toISOString()
        });
      }

      // Intervals / Gap
      const gapVal = data.GapToLeader;
      const intVal = data.IntervalToPositionAhead?.Value;
      if (gapVal !== undefined || intVal !== undefined) {
        intervals.push({
          driver_number: num,
          gap_to_leader: gapVal || null,
          interval: intVal || null,
          date: new Date().toISOString()
        });
      }

      // Laps
      if (data.LastLapTime?.Value || data.NumberOfLaps) {
        const lapTimeStr = data.LastLapTime?.Value;
        let lapDuration = null;
        if (lapTimeStr) {
          // Parsuj "1:23.456" → sekundy
          const parts = lapTimeStr.split(':');
          if (parts.length === 2) {
            lapDuration = parseInt(parts[0]) * 60 + parseFloat(parts[1]);
          } else if (parts.length === 1) {
            lapDuration = parseFloat(parts[0]);
          }
        }
        laps.push({
          driver_number: num,
          lap_number: data.NumberOfLaps || 0,
          lap_duration: lapDuration,
          date: new Date().toISOString()
        });
      }
    });

    return { positions, intervals, laps };
  }

  function convertDriverListToLiveDrivers() {
    const dl = srState.DriverList;
    const result = {};
    Object.entries(dl).forEach(([num, d]) => {
      result[parseInt(num)] = {
        driver_number: parseInt(d.RacingNumber || num),
        name_acronym: d.Tla || '',
        full_name: d.FullName || d.BroadcastName || '',
        team_name: d.TeamName || '',
        team_colour: d.TeamColour || '555555'
      };
    });
    return result;
  }

  function convertStints() {
    // TimingAppData obsahuje stint info
    const tad = srState.TimingAppData;
    const stints = [];
    if (tad.Lines) {
      Object.entries(tad.Lines).forEach(([num, data]) => {
        if (data.Stints) {
          // Najdi poslední stint
          const stintKeys = Object.keys(data.Stints).sort((a,b) => parseInt(b) - parseInt(a));
          if (stintKeys.length) {
            const latest = data.Stints[stintKeys[0]];
            stints.push({
              driver_number: parseInt(num),
              compound: latest.Compound || '?',
              stint_number: parseInt(stintKeys[0]) + 1,
              tyre_age_at_pit: latest.TotalLaps || latest.New === false ? (latest.TotalLaps || 0) : 0,
              lap_start: latest.StartLaps || 0,
              lap_end: (latest.StartLaps || 0) + (latest.TotalLaps || 0)
            });
          }
        }
      });
    }
    return stints;
  }

  function convertRaceControl() {
    const rcm = srState.RaceControlMessages;
    const messages = [];
    if (rcm.Messages) {
      Object.values(rcm.Messages).forEach(msg => {
        messages.push({
          date: msg.Utc || new Date().toISOString(),
          message: msg.Message || '',
          flag: msg.Flag || '',
          category: msg.Category || '',
          sector: msg.Sector || null
        });
      });
    }
    return messages;
  }

  function getTrackFlag() {
    const ts = srState.TrackStatus;
    if (!ts.Status) return '';
    // Status: 1=Green, 2=Yellow, 4=SC, 5=Red, 6=VSC, 7=VSCEnding
    switch (ts.Status) {
      case '2': return 'flag-yellow';
      case '4': return 'flag-sc';
      case '5': return 'flag-red';
      case '6': return 'flag-vsc';
      case '7': return 'flag-scend';
      default: return '';
    }
  }

  // ═══ RENDER — přepíše fetchLiveData s SignalR daty ═══
  function renderSignalRData() {
    if (!signalrConnected) return;
    
    const { positions, intervals, laps } = convertTimingToOpenF1();
    if (positions.length === 0) return; // Ještě nemáme data
    
    const stints = convertStints();
    const rc = convertRaceControl();
    const flag = getTrackFlag();

    // Převeď drivery z SignalR
    const srDrivers = convertDriverListToLiveDrivers();
    // Merge se stávajícím liveDrivers (fallback data)
    Object.keys(srDrivers).forEach(num => {
      if (!window.liveDrivers) window.liveDrivers = {};
      // SignalR driver data mají přednost
      if (srDrivers[num].full_name) {
        liveDrivers[parseInt(num)] = { ...liveDrivers[parseInt(num)], ...srDrivers[num] };
      }
    });

    // Deduplicate
    const latestPos = {}, latestInt = {}, latestStint = {}, latestLap = {};
    positions.forEach(p => { latestPos[p.driver_number] = p; });
    intervals.forEach(i => { latestInt[i.driver_number] = i; });
    stints.forEach(s => {
      if (!latestStint[s.driver_number] || s.stint_number > (latestStint[s.driver_number].stint_number || 0))
        latestStint[s.driver_number] = s;
    });
    laps.forEach(l => {
      if (!latestLap[l.driver_number] || l.lap_number > (latestLap[l.driver_number].lap_number || 0))
        latestLap[l.driver_number] = l;
    });

    const sorted = Object.values(latestPos).sort((a, b) => (a.position || 99) - (b.position || 99));

    // Fastest lap
    let fastestDriver = null, bestLapTime = Infinity;
    Object.values(latestLap).forEach(l => {
      if (l.lap_duration && l.lap_duration < bestLapTime) {
        bestLapTime = l.lap_duration;
        fastestDriver = l.driver_number;
      }
    });

    // Gap mode
    if (!window._liveGapMode) window._liveGapMode = 'leader';

    // Lap count
    const lapCount = srState.LapCount;
    const currentLap = lapCount.CurrentLap || '';
    const totalLaps = lapCount.TotalLaps || '';
    const lapInfo = totalLaps ? ` · Kolo ${currentLap}/${totalLaps}` : '';

    // Session clock
    const clock = srState.ExtrapolatedClock;
    const remaining = clock.Remaining || '';

    // ── Build HTML (stejný formát jako tvůj fetchLiveData) ──
    let h = `<div class="card"><div class="stitle" style="display:flex;justify-content:space-between;align-items:center"><span>LIVE POŘADÍ${lapInfo}</span><div style="display:flex;align-items:center;gap:8px"><div style="display:flex;gap:4px">`;
    h += `<button onclick="window._liveGapMode='leader'" style="padding:3px 10px;border-radius:5px;border:1px solid ${window._liveGapMode === 'leader' ? 'var(--red)' : 'var(--line)'};background:${window._liveGapMode === 'leader' ? 'rgba(232,0,45,0.15)' : 'transparent'};color:${window._liveGapMode === 'leader' ? 'var(--red)' : 'var(--dim)'};font-size:11px;font-weight:600;cursor:pointer">Lídr</button>`;
    h += `<button onclick="window._liveGapMode='interval'" style="padding:3px 10px;border-radius:5px;border:1px solid ${window._liveGapMode === 'interval' ? 'var(--red)' : 'var(--line)'};background:${window._liveGapMode === 'interval' ? 'rgba(232,0,45,0.15)' : 'transparent'};color:${window._liveGapMode === 'interval' ? 'var(--red)' : 'var(--dim)'};font-size:11px;font-weight:600;cursor:pointer">Interval</button>`;
    h += `</div>`;
    // Remaining time
    if (remaining) {
      h += `<span style="font-size:12px;color:var(--mid);font-weight:600;font-family:'Orbitron',monospace">${remaining}</span>`;
    }
    h += `<span style="font-size:10px;color:#39B54A;font-weight:700;letter-spacing:1px">● SIGNALR</span>`;
    h += `<span style="font-size:12px;color:var(--red);font-weight:600;letter-spacing:0;text-transform:none">↻ ${new Date().toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>`;
    h += `</div></div>`;

    sorted.forEach((p, idx) => {
      const d = liveDrivers[p.driver_number] || {};
      const name = d.full_name || d.name_acronym || `#${p.driver_number}`;
      const team = d.team_name || '';
      const color = '#' + (d.team_colour || '555555');
      const pos2 = p.position || '?';
      const intData = latestInt[p.driver_number];
      const gap = intData ? intData.gap_to_leader : null;
      const interval = intData ? intData.interval : null;
      const stint = latestStint[p.driver_number];
      const tire = stint ? stint.compound : '?';
      const tireAge = stint ? stint.tyre_age_at_pit : null;
      const lap = latestLap[p.driver_number];
      const lapTime = lap?.lap_duration ? formatLapTime(lap.lap_duration) : null;
      const posClass = pos2 === 1 ? 'p1' : pos2 === 2 ? 'p2' : pos2 === 3 ? 'p3' : '';
      const tireClass = tire && tire !== '?' ? 'tire-' + tire.charAt(0).toUpperCase() : '';
      const isFastest = fastestDriver === p.driver_number;

      let gapText = pos2 === 1 ? 'LEADER' : '';
      if (pos2 > 1) {
        if (window._liveGapMode === 'leader' && gap != null) gapText = '+' + gap + 's';
        else if (window._liveGapMode === 'interval' && interval != null) gapText = '+' + interval + 's';
        else if (gap != null) gapText = '+' + gap + 's';
      }

      h += `<div class="live-row" data-driver="${p.driver_number}">`;
      h += `<div class="live-pos ${posClass}">${pos2}</div>`;
      h += `<div class="live-bar" style="background:${color}"></div>`;
      h += `<div class="live-info"><div class="live-name${isFastest ? ' fastest-lap' : ''}">${name}</div><div class="live-team" style="color:${color}">${team}${lapTime ? ' · ' + lapTime : ''}</div></div>`;
      if (tireClass) {
        h += `<div class="live-tire ${tireClass}"><span style="font-size:11px;line-height:1">${tire ? tire.charAt(0) : '?'}</span>${tireAge != null ? `<span style="font-size:8px;color:${tire?.charAt(0) === 'M' ? 'rgba(0,0,0,0.5)' : tire?.charAt(0) === 'H' ? 'rgba(0,0,0,0.4)' : 'rgba(255,255,255,0.6)'};font-weight:500;line-height:1">${tireAge}</span>` : ''}</div>`;
      }
      h += `<div class="live-gap" style="min-width:100px;text-align:right;font-variant-numeric:tabular-nums">${gapText}</div>`;
      h += `</div>`;
    });
    h += `</div>`;

    // Weather
    const wx = srState.WeatherData;
    if (wx.AirTemp) {
      h += `<div class="card alt"><div class="stitle">POČASÍ NA TRATI</div><div class="wx-grid">`;
      h += `<div class="wx-card"><div class="wx-icon">🌡️</div><div class="wx-val">${wx.AirTemp}°C</div><div class="wx-label">Vzduch</div></div>`;
      h += `<div class="wx-card"><div class="wx-icon">🛣️</div><div class="wx-val">${wx.TrackTemp}°C</div><div class="wx-label">Trať</div></div>`;
      h += `<div class="wx-card"><div class="wx-icon">💧</div><div class="wx-val">${wx.Humidity}%</div><div class="wx-label">Vlhkost</div></div>`;
      h += `<div class="wx-card"><div class="wx-icon">💨</div><div class="wx-val">${wx.WindSpeed} km/h</div><div class="wx-label">Vítr</div></div>`;
      h += `<div class="wx-card"><div class="wx-icon">🌧️</div><div class="wx-val">${wx.Rainfall === '1' ? 'ANO' : 'NE'}</div><div class="wx-label">Déšť</div></div>`;
      h += `<div class="wx-card"><div class="wx-icon">📊</div><div class="wx-val">${wx.Pressure} hPa</div><div class="wx-label">Tlak</div></div>`;
      h += `</div></div>`;
    }

    // Race control
    if (rc.length) {
      h += `<div class="card alt"><div class="stitle">RACE CONTROL</div>`;
      rc.slice(-15).reverse().forEach(m => {
        const time = m.date ? new Date(m.date).toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
        let fc = '';
        if (/yellow/i.test(m.flag)) fc = 'rc-yellow';
        else if (/red/i.test(m.flag)) fc = 'rc-red';
        else if (/green|clear/i.test(m.flag)) fc = 'rc-green';
        else if (/chequered/i.test(m.flag)) fc = 'rc-chequered';

        let msgClass = '';
        const msg = (m.message || '').toUpperCase();
        if (msg.includes('PENALTY')) msgClass = 'rc-penalty';
        else if (msg.includes('INVESTIGAT') || msg.includes('NOTED')) msgClass = 'rc-investigation';
        else if (msg.includes('VIRTUAL SAFETY CAR') || msg.includes('VSC')) msgClass = 'rc-vsc';
        else if (msg.includes('SAFETY CAR') && !msg.includes('VIRTUAL')) msgClass = 'rc-sc';

        h += `<div class="rc-msg ${msgClass}"><div class="rc-time">${time}</div>${fc ? `<div class="rc-flag ${fc}"></div>` : ''}<div class="rc-text">${m.message || ''}</div></div>`;
      });
      h += `</div>`;
    }

    // Apply flag animation
    const grid = document.querySelector('.live-grid');
    if (grid) {
      grid.className = 'live-grid ' + flag;
    }

    document.getElementById('liveContent').innerHTML = h;
  }

  // ═══ SIGNALR CONNECTION ═══
  async function connectSignalR() {
    try {
      console.log('[SignalR] Negotiating...');
      updateStatus('negotiating');

      const resp = await fetch(`${WORKER_URL}/negotiate`);
      if (!resp.ok) throw new Error('Negotiate failed: ' + resp.status);
      
      const data = await resp.json();
      if (!data.ConnectionToken) throw new Error('No ConnectionToken');

      console.log('[SignalR] Got token, connecting WebSocket...');
      updateStatus('connecting');

      const wsScheme = WORKER_URL.startsWith('https') ? 'wss' : 'ws';
      const wsBase = WORKER_URL.replace(/^https?/, wsScheme);
      const wsUrl = `${wsBase}/connect?token=${encodeURIComponent(data.ConnectionToken)}&cookie=${encodeURIComponent(data.Cookie || '')}`;

      signalrWs = new WebSocket(wsUrl);

      signalrWs.onopen = () => {
        console.log('[SignalR] Connected! Subscribing...');
        signalrConnected = true;
        signalrReconnectAttempts = 0;
        updateStatus('connected');

        // Zastaví OpenF1 polling
        if (window.liveInterval) {
          clearInterval(window.liveInterval);
          window.liveInterval = null;
          console.log('[SignalR] OpenF1 polling stopped — using real-time data');
        }

        // Subscribe na všechny hlavní topics
        signalrWs.send(JSON.stringify({
          H: 'Streaming',
          M: 'Subscribe',
          A: [[
            'TimingData', 'TimingStats', 'TimingAppData',
            'DriverList', 'SessionInfo', 'SessionData',
            'TrackStatus', 'RaceControlMessages', 'WeatherData',
            'ExtrapolatedClock', 'TopThree', 'LapCount', 'Heartbeat'
          ]],
          I: 1
        }));

        resetHeartbeat();
      };

      signalrWs.onmessage = (event) => {
        resetHeartbeat();
        if (!event.data || event.data === '{}') return;

        try {
          const msg = JSON.parse(event.data);
          handleSignalRMessage(msg);
        } catch (e) {
          // non-JSON
        }
      };

      signalrWs.onclose = (event) => {
        console.log('[SignalR] Disconnected:', event.code, event.reason);
        signalrConnected = false;
        clearHeartbeat();
        updateStatus('disconnected');
        
        // Fallback na OpenF1 polling
        restoreOpenF1Polling();
        scheduleReconnect();
      };

      signalrWs.onerror = (err) => {
        console.error('[SignalR] Error:', err);
      };

    } catch (err) {
      console.error('[SignalR] Connection failed:', err);
      updateStatus('error');
      restoreOpenF1Polling();
      scheduleReconnect();
    }
  }

  function handleSignalRMessage(msg) {
    // Subscribe response — contains initial state snapshot
    if (msg.R && typeof msg.R === 'object') {
      console.log('[SignalR] Got initial state, topics:', Object.keys(msg.R).join(', '));
      Object.entries(msg.R).forEach(([topic, data]) => {
        if (srState[topic] !== undefined) {
          srState[topic] = data;
        }
      });
      // Zobraz hned
      showLiveBanner();
      renderSignalRData();
      // Start render interval (pro aktualizaci hodin)
      if (!window._signalrRenderInterval) {
        window._signalrRenderInterval = setInterval(renderSignalRData, 2000);
      }
      return;
    }

    // Live data updates
    if (msg.M && Array.isArray(msg.M)) {
      msg.M.forEach(m => {
        if (m.M === 'feed' && m.A) {
          const topic = m.A[0];
          const data = m.A[1];
          
          if (srState[topic] !== undefined) {
            mergeDeep(srState[topic], data);
          }
        }
      });
      // Render after batch of updates
      renderSignalRData();
    }
  }

  // ═══ HEARTBEAT ═══
  function resetHeartbeat() {
    clearHeartbeat();
    heartbeatTimer = setTimeout(() => {
      console.warn('[SignalR] Heartbeat timeout');
      if (signalrWs) {
        try { signalrWs.close(); } catch (_) {}
      }
    }, 50000); // 50s timeout
  }

  function clearHeartbeat() {
    if (heartbeatTimer) {
      clearTimeout(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  // ═══ RECONNECT ═══
  function scheduleReconnect() {
    if (signalrReconnectAttempts >= MAX_RECONNECT) {
      console.error('[SignalR] Max reconnect attempts — staying on OpenF1');
      return;
    }
    const delay = Math.min(2000 * Math.pow(1.5, signalrReconnectAttempts), 30000);
    signalrReconnectAttempts++;
    console.log(`[SignalR] Reconnecting in ${Math.round(delay / 1000)}s (attempt ${signalrReconnectAttempts}/${MAX_RECONNECT})`);
    setTimeout(connectSignalR, delay);
  }

  // ═══ FALLBACK — restore OpenF1 polling ═══
  function restoreOpenF1Polling() {
    if (window._signalrRenderInterval) {
      clearInterval(window._signalrRenderInterval);
      window._signalrRenderInterval = null;
    }
    // Restart OpenF1 polling if we have a session
    if (liveSessionKey && !window.liveInterval) {
      console.log('[SignalR] Falling back to OpenF1 polling');
      window.liveInterval = setInterval(fetchLiveData, 10000);
      fetchLiveData();
    }
  }

  // ═══ UI STATUS ═══
  function updateStatus(status) {
    const dot = document.getElementById('liveDot');
    const btn = document.getElementById('liveBtn');
    
    if (status === 'connected') {
      if (dot) { dot.style.display = 'block'; }
      if (btn) { btn.style.color = '#E8002D'; }
    }
  }

  function showLiveBanner() {
    const banner = document.getElementById('homeLiveBanner');
    const si = srState.SessionInfo;
    const sessionName = si.Meeting?.Name || si.Meeting?.OfficialName || '';
    const sessionType = si.Name || si.Type || 'Session';
    const label = sessionName ? `LIVE: ${sessionType} · ${sessionName}` : 'LIVE SESSION (SignalR)';
    
    if (banner) {
      banner.style.display = 'block';
      document.getElementById('liveBannerText').textContent = label;
    }
    const dot = document.getElementById('liveDot');
    if (dot) dot.style.display = 'block';
    const btn = document.getElementById('liveBtn');
    if (btn) btn.style.color = '#E8002D';
    
    // Schovej "no session" placeholder
    const noSess = document.querySelector('.no-session');
    if (noSess) noSess.style.display = 'none';
  }

  // ═══ STARTUP ═══
  // Počkej až se načte stránka a initLive() doběhne, pak zkus SignalR
  // SignalR se pokusí připojit vždy — pokud žádná session neběží, negotiate selže a nic se nestane
  
  function startSignalR() {
    // Check worker health first
    fetch(`${WORKER_URL}/health`)
      .then(r => r.json())
      .then(data => {
        if (data.status === 'ok') {
          console.log('[SignalR] Worker is healthy, connecting...');
          connectSignalR();
        } else {
          console.log('[SignalR] Worker not ready, staying on OpenF1');
        }
      })
      .catch(err => {
        console.log('[SignalR] Worker unreachable, staying on OpenF1:', err.message);
      });
  }

  // Spustit po 3s — dá čas stávajícímu initLive() aby se načetl
  setTimeout(startSignalR, 3000);

  // Export pro debugování v konzoli
  window._signalr = {
    state: srState,
    connect: connectSignalR,
    disconnect: () => {
      signalrReconnectAttempts = MAX_RECONNECT;
      if (signalrWs) { try { signalrWs.close(); } catch(_) {} }
    },
    isConnected: () => signalrConnected
  };

  console.log('[SignalR] Module loaded. Worker:', WORKER_URL);
  console.log('[SignalR] Debug: window._signalr.state / .connect() / .disconnect() / .isConnected()');

})();
