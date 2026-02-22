/**
 * F1 SignalR Live Integration pro dashboard
 * Long-polling transport (funguje na Cloudflare Workers free tier)
 * 
 * Přidej do dashboardu PŘED </body>:
 *   <script src="f1-signalr-live.js"></script>
 */

(function() {
  'use strict';

  const WORKER_URL = 'https://f1-live-proxy.obadalp.workers.dev';
  
  let signalrConnected = false;
  let signalrReconnectAttempts = 0;
  const MAX_RECONNECT = 10;
  let pollActive = false;
  let connectionToken = null;
  let connectionCookie = '';
  let messageId = '';
  let groupsToken = '';

  // Živý state z SignalR
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

  // ═══ CONNECT FLOW ═══
  // 1. negotiate → 2. start → 3. subscribe → 4. poll loop
  
  async function connectSignalR() {
    try {
      console.log('[SignalR] Negotiating...');

      // 1) Negotiate
      const negResp = await fetch(`${WORKER_URL}/negotiate`);
      if (!negResp.ok) throw new Error('Negotiate failed: ' + negResp.status);
      const negData = await negResp.json();
      
      if (!negData.ConnectionToken) throw new Error('No ConnectionToken');
      connectionToken = negData.ConnectionToken;
      connectionCookie = negData.Cookie || '';
      
      console.log('[SignalR] Got token, starting transport...');

      // 2) Start long-polling transport
      const startResp = await fetch(`${WORKER_URL}/start?token=${enc(connectionToken)}&cookie=${enc(connectionCookie)}`);
      if (!startResp.ok) throw new Error('Start failed: ' + startResp.status);
      const startData = await startResp.json();
      console.log('[SignalR] Transport started:', startData);

      // 3) Subscribe
      console.log('[SignalR] Subscribing to topics...');
      const subResp = await fetch(`${WORKER_URL}/subscribe?token=${enc(connectionToken)}&cookie=${enc(connectionCookie)}`);
      if (!subResp.ok) throw new Error('Subscribe failed: ' + subResp.status);
      const subData = await subResp.json();
      console.log('[SignalR] Subscribe response:', subData);

      // Zpracuj initial data z subscribe response
      if (subData.I && subData.R) {
        handleInitialData(subData.R);
      }

      // 4) Start polling
      signalrConnected = true;
      signalrReconnectAttempts = 0;
      pollActive = true;
      
      // Zastaví OpenF1 polling
      if (window.liveInterval) {
        clearInterval(window.liveInterval);
        window.liveInterval = null;
        console.log('[SignalR] OpenF1 polling stopped — using SignalR');
      }

      showLiveBanner();
      pollLoop();

      // Start render interval
      if (!window._signalrRenderInterval) {
        window._signalrRenderInterval = setInterval(renderSignalRData, 2000);
      }

    } catch (err) {
      console.error('[SignalR] Connection failed:', err);
      scheduleReconnect();
    }
  }

  // ═══ POLL LOOP ═══
  async function pollLoop() {
    while (pollActive) {
      try {
        let url = `${WORKER_URL}/poll?token=${enc(connectionToken)}&cookie=${enc(connectionCookie)}`;
        if (messageId) url += `&messageId=${enc(messageId)}`;
        if (groupsToken) url += `&groupsToken=${enc(groupsToken)}`;

        const resp = await fetch(url);
        if (!resp.ok) {
          console.warn('[SignalR] Poll error:', resp.status);
          throw new Error('Poll failed: ' + resp.status);
        }

        const data = await resp.json();
        
        // Update cursors pro next poll
        if (data.C) messageId = data.C;
        if (data.G) groupsToken = data.G;

        // Zpracuj zprávy
        if (data.M && Array.isArray(data.M)) {
          data.M.forEach(m => {
            if (m.M === 'feed' && m.A) {
              const topic = m.A[0];
              const payload = m.A[1];
              if (srState[topic] !== undefined) {
                mergeDeep(srState[topic], payload);
              }
            }
          });
          // Render po batch updatu
          renderSignalRData();
        }

        // Pokud data.R existuje (initial/reconnect snapshot)
        if (data.R) {
          handleInitialData(data.R);
        }

      } catch (err) {
        console.error('[SignalR] Poll error:', err);
        pollActive = false;
        signalrConnected = false;
        restoreOpenF1Polling();
        scheduleReconnect();
        return;
      }
    }
  }

  function handleInitialData(R) {
    if (typeof R === 'object') {
      console.log('[SignalR] Got initial state, topics:', Object.keys(R).join(', '));
      Object.entries(R).forEach(([topic, data]) => {
        if (srState[topic] !== undefined) {
          srState[topic] = data;
        }
      });
      renderSignalRData();
    }
  }

  // ═══ CONVERT SIGNALR → OPENF1 FORMAT ═══
  
  function convertTimingToOpenF1() {
    const td = srState.TimingData;
    const dl = srState.DriverList;
    if (!td.Lines) return { positions: [], intervals: [], laps: [] };

    const positions = [];
    const intervals = [];
    const laps = [];

    Object.entries(td.Lines).forEach(([driverNum, data]) => {
      const num = parseInt(driverNum);
      
      if (data.Position) {
        positions.push({
          driver_number: num,
          position: parseInt(data.Position),
          date: new Date().toISOString()
        });
      }

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

      if (data.LastLapTime?.Value || data.NumberOfLaps) {
        const lapTimeStr = data.LastLapTime?.Value;
        let lapDuration = null;
        if (lapTimeStr) {
          const parts = lapTimeStr.split(':');
          if (parts.length === 2) lapDuration = parseInt(parts[0]) * 60 + parseFloat(parts[1]);
          else if (parts.length === 1) lapDuration = parseFloat(parts[0]);
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

  function convertStints() {
    const tad = srState.TimingAppData;
    const stints = [];
    if (tad.Lines) {
      Object.entries(tad.Lines).forEach(([num, data]) => {
        if (data.Stints) {
          const stintKeys = Object.keys(data.Stints).sort((a, b) => parseInt(b) - parseInt(a));
          if (stintKeys.length) {
            const latest = data.Stints[stintKeys[0]];
            stints.push({
              driver_number: parseInt(num),
              compound: latest.Compound || '?',
              stint_number: parseInt(stintKeys[0]) + 1,
              tyre_age_at_pit: latest.TotalLaps || 0,
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
          category: msg.Category || ''
        });
      });
    }
    return messages;
  }

  function getTrackFlag() {
    const ts = srState.TrackStatus;
    if (!ts.Status) return '';
    switch (ts.Status) {
      case '2': return 'flag-yellow';
      case '4': return 'flag-sc';
      case '5': return 'flag-red';
      case '6': return 'flag-vsc';
      case '7': return 'flag-scend';
      default: return '';
    }
  }

  // ═══ RENDER ═══
  function renderSignalRData() {
    if (!signalrConnected) return;
    
    const { positions, intervals, laps } = convertTimingToOpenF1();
    if (positions.length === 0) return;
    
    const stints = convertStints();
    const rc = convertRaceControl();
    const flag = getTrackFlag();

    // Merge SignalR drivers do liveDrivers
    const dl = srState.DriverList;
    Object.entries(dl).forEach(([num, d]) => {
      const n = parseInt(d.RacingNumber || num);
      if (!liveDrivers[n]) liveDrivers[n] = {};
      if (d.FullName || d.BroadcastName) liveDrivers[n].full_name = d.FullName || d.BroadcastName;
      if (d.Tla) liveDrivers[n].name_acronym = d.Tla;
      if (d.TeamName) liveDrivers[n].team_name = d.TeamName;
      if (d.TeamColour) liveDrivers[n].team_colour = d.TeamColour;
      liveDrivers[n].driver_number = n;
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

    let fastestDriver = null, bestLapTime = Infinity;
    Object.values(latestLap).forEach(l => {
      if (l.lap_duration && l.lap_duration < bestLapTime) {
        bestLapTime = l.lap_duration;
        fastestDriver = l.driver_number;
      }
    });

    if (!window._liveGapMode) window._liveGapMode = 'leader';

    const lapCount = srState.LapCount;
    const currentLap = lapCount.CurrentLap || '';
    const totalLaps = lapCount.TotalLaps || '';
    const lapInfo = totalLaps ? ` · Kolo ${currentLap}/${totalLaps}` : '';
    const remaining = srState.ExtrapolatedClock.Remaining || '';

    let h = `<div class="card"><div class="stitle" style="display:flex;justify-content:space-between;align-items:center"><span>LIVE POŘADÍ${lapInfo}</span><div style="display:flex;align-items:center;gap:8px"><div style="display:flex;gap:4px">`;
    h += `<button onclick="window._liveGapMode='leader'" style="padding:3px 10px;border-radius:5px;border:1px solid ${window._liveGapMode === 'leader' ? 'var(--red)' : 'var(--line)'};background:${window._liveGapMode === 'leader' ? 'rgba(232,0,45,0.15)' : 'transparent'};color:${window._liveGapMode === 'leader' ? 'var(--red)' : 'var(--dim)'};font-size:11px;font-weight:600;cursor:pointer">Lídr</button>`;
    h += `<button onclick="window._liveGapMode='interval'" style="padding:3px 10px;border-radius:5px;border:1px solid ${window._liveGapMode === 'interval' ? 'var(--red)' : 'var(--line)'};background:${window._liveGapMode === 'interval' ? 'rgba(232,0,45,0.15)' : 'transparent'};color:${window._liveGapMode === 'interval' ? 'var(--red)' : 'var(--dim)'};font-size:11px;font-weight:600;cursor:pointer">Interval</button>`;
    h += `</div>`;
    if (remaining) h += `<span style="font-size:12px;color:var(--mid);font-weight:600;font-family:'Orbitron',monospace">${remaining}</span>`;
    h += `<span style="font-size:10px;color:#39B54A;font-weight:700;letter-spacing:1px">● LIVE</span>`;
    h += `<span style="font-size:12px;color:var(--red);font-weight:600;letter-spacing:0;text-transform:none">↻ ${new Date().toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>`;
    h += `</div></div>`;

    sorted.forEach((p) => {
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

    // Apply flag
    const grid = document.querySelector('.live-grid');
    if (grid) grid.className = 'live-grid ' + flag;

    document.getElementById('liveContent').innerHTML = h;
  }

  // ═══ RECONNECT ═══
  function scheduleReconnect() {
    if (signalrReconnectAttempts >= MAX_RECONNECT) {
      console.error('[SignalR] Max reconnect attempts — staying on OpenF1');
      return;
    }
    const delay = Math.min(3000 * Math.pow(1.5, signalrReconnectAttempts), 30000);
    signalrReconnectAttempts++;
    console.log(`[SignalR] Reconnecting in ${Math.round(delay / 1000)}s (attempt ${signalrReconnectAttempts}/${MAX_RECONNECT})`);
    setTimeout(connectSignalR, delay);
  }

  function restoreOpenF1Polling() {
    if (window._signalrRenderInterval) {
      clearInterval(window._signalrRenderInterval);
      window._signalrRenderInterval = null;
    }
    if (liveSessionKey && !window.liveInterval) {
      console.log('[SignalR] Falling back to OpenF1 polling');
      window.liveInterval = setInterval(fetchLiveData, 10000);
      fetchLiveData();
    }
  }

  function showLiveBanner() {
    const si = srState.SessionInfo;
    const sessionName = si.Meeting?.Name || si.Meeting?.OfficialName || '';
    const sessionType = si.Name || si.Type || 'Session';
    const label = sessionName ? `LIVE: ${sessionType} · ${sessionName}` : 'LIVE SESSION';
    
    const banner = document.getElementById('homeLiveBanner');
    if (banner) {
      banner.style.display = 'block';
      document.getElementById('liveBannerText').textContent = label;
    }
    const dot = document.getElementById('liveDot');
    if (dot) dot.style.display = 'block';
    const btn = document.getElementById('liveBtn');
    if (btn) btn.style.color = '#E8002D';
    const noSess = document.querySelector('.no-session');
    if (noSess) noSess.style.display = 'none';
  }

  function enc(s) { return encodeURIComponent(s); }

  // ═══ STARTUP ═══
  function startSignalR() {
    fetch(`${WORKER_URL}/health`)
      .then(r => r.json())
      .then(data => {
        if (data.status === 'ok') {
          console.log('[SignalR] Worker healthy, connecting...');
          connectSignalR();
        }
      })
      .catch(err => {
        console.log('[SignalR] Worker unreachable:', err.message);
      });
  }

  setTimeout(startSignalR, 3000);

  window._signalr = {
    state: srState,
    connect: connectSignalR,
    disconnect: () => { pollActive = false; signalrConnected = false; signalrReconnectAttempts = MAX_RECONNECT; },
    isConnected: () => signalrConnected
  };

  console.log('[SignalR] Module loaded (long-polling). Worker:', WORKER_URL);

})();
