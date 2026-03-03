/**
 * F1 SignalR Live — DEMO MODE (Závod)
 * Simuluje živý závod s realistickými daty
 * PO OTESTOVÁNÍ NAHRAĎ OSTRÝM SOUBOREM!
 */

(function() {
  'use strict';

  const WORKER_URL = 'https://f1-live-proxy.obadalp.workers.dev';
  let signalrConnected = false;
  let demoTick = 0;
  let demoInterval = null;

  // Živý state
  let srState = {
    TimingData: { Lines: {} },
    DriverList: {},
    SessionInfo: { Name: 'Race', Type: 'Race', Meeting: { Name: 'Australian Grand Prix', OfficialName: '2026 Australian Grand Prix' } },
    SessionData: {},
    TrackStatus: { Status: '1', Message: 'AllClear' },
    WeatherData: { AirTemp: '28.4', TrackTemp: '43.2', Humidity: '42', Pressure: '1015.3', Rainfall: '0', WindSpeed: '4.8', WindDirection: '215' },
    ExtrapolatedClock: { Remaining: '01:12:34', Extrapolating: true },
    TopThree: {},
    LapCount: { CurrentLap: 1, TotalLaps: 58 },
    RaceControlMessages: { Messages: {} },
    TimingStats: {},
    TimingAppData: { Lines: {} }
  };

  // 2026 grid
  const DRIVERS = [
    { num: '1', tla: 'NOR', name: 'Lando NORRIS', team: 'McLaren', color: 'FF8000' },
    { num: '81', tla: 'PIA', name: 'Oscar PIASTRI', team: 'McLaren', color: 'FF8000' },
    { num: '3', tla: 'VER', name: 'Max VERSTAPPEN', team: 'Red Bull Racing', color: '3671C6' },
    { num: '6', tla: 'HAD', name: 'Isack HADJAR', team: 'Red Bull Racing', color: '3671C6' },
    { num: '63', tla: 'RUS', name: 'George RUSSELL', team: 'Mercedes', color: '27F4D2' },
    { num: '12', tla: 'ANT', name: 'Kimi ANTONELLI', team: 'Mercedes', color: '27F4D2' },
    { num: '16', tla: 'LEC', name: 'Charles LECLERC', team: 'Ferrari', color: 'E8002D' },
    { num: '44', tla: 'HAM', name: 'Lewis HAMILTON', team: 'Ferrari', color: 'E8002D' },
    { num: '14', tla: 'ALO', name: 'Fernando ALONSO', team: 'Aston Martin', color: '229971' },
    { num: '18', tla: 'STR', name: 'Lance STROLL', team: 'Aston Martin', color: '229971' },
    { num: '23', tla: 'ALB', name: 'Alex ALBON', team: 'Williams', color: '64C4FF' },
    { num: '55', tla: 'SAI', name: 'Carlos SAINZ', team: 'Williams', color: '64C4FF' },
    { num: '10', tla: 'GAS', name: 'Pierre GASLY', team: 'Alpine', color: '0093CC' },
    { num: '43', tla: 'COL', name: 'Franco COLAPINTO', team: 'Alpine', color: '0093CC' },
    { num: '30', tla: 'LAW', name: 'Liam LAWSON', team: 'Racing Bulls', color: '6692FF' },
    { num: '41', tla: 'LIN', name: 'Arvid LINDBLAD', team: 'Racing Bulls', color: '6692FF' },
    { num: '31', tla: 'OCO', name: 'Esteban OCON', team: 'Haas', color: 'B6BABD' },
    { num: '87', tla: 'BEA', name: 'Oliver BEARMAN', team: 'Haas', color: 'B6BABD' },
    { num: '27', tla: 'HUL', name: 'Nico HÜLKENBERG', team: 'Audi', color: 'E4002B' },
    { num: '5', tla: 'BOR', name: 'Gabriel BORTOLETO', team: 'Audi', color: 'E4002B' }
  ];

  const COMPOUNDS = ['SOFT', 'MEDIUM', 'HARD'];
  const RC_EVENTS = [
    { lap: 1, msg: 'LIGHTS OUT AND AWAY WE GO', flag: 'GREEN', cat: 'Race' },
    { lap: 3, msg: 'DRS ENABLED', flag: 'GREEN', cat: 'Drs' },
    { lap: 8, msg: 'CAR 41 (LIN) TRACK LIMITS TURN 9 — LAP TIME DELETED', flag: '', cat: 'Other' },
    { lap: 12, msg: 'YELLOW FLAG IN SECTOR 2', flag: 'YELLOW', cat: 'Flag' },
    { lap: 12, msg: 'CAR 5 (BOR) SPUN OFF TRACK — TURN 6', flag: 'YELLOW', cat: 'Flag' },
    { lap: 13, msg: 'GREEN FLAG — ALL CLEAR', flag: 'GREEN', cat: 'Flag' },
    { lap: 18, msg: 'CAR 18 (STR) — 5 SECOND TIME PENALTY — CAUSING A COLLISION', flag: '', cat: 'Penalty' },
    { lap: 22, msg: 'VIRTUAL SAFETY CAR DEPLOYED', flag: 'YELLOW', cat: 'SafetyCar' },
    { lap: 22, msg: 'CAR 43 (COL) STOPPED ON TRACK — TURN 11', flag: 'YELLOW', cat: 'SafetyCar' },
    { lap: 25, msg: 'VIRTUAL SAFETY CAR ENDING', flag: 'GREEN', cat: 'SafetyCar' },
    { lap: 25, msg: 'GREEN FLAG — DRS ENABLED IN 2 LAPS', flag: 'GREEN', cat: 'Drs' },
    { lap: 33, msg: 'SAFETY CAR DEPLOYED', flag: 'YELLOW', cat: 'SafetyCar' },
    { lap: 33, msg: 'DEBRIS ON TRACK — TURN 3', flag: 'YELLOW', cat: 'SafetyCar' },
    { lap: 36, msg: 'SAFETY CAR IN THIS LAP', flag: 'GREEN', cat: 'SafetyCar' },
    { lap: 37, msg: 'GREEN FLAG — RACING RESUMES', flag: 'GREEN', cat: 'Flag' },
    { lap: 42, msg: 'FASTEST LAP — CAR 3 (VER) 1:19.876', flag: '', cat: 'Other' },
    { lap: 48, msg: 'CAR 12 (ANT) UNDER INVESTIGATION — FORCING ANOTHER DRIVER OFF TRACK', flag: '', cat: 'Investigation' },
    { lap: 50, msg: 'CAR 12 (ANT) — NO FURTHER ACTION', flag: '', cat: 'Investigation' },
    { lap: 55, msg: 'FASTEST LAP — CAR 1 (NOR) 1:19.543', flag: '', cat: 'Other' },
    { lap: 58, msg: 'CHEQUERED FLAG', flag: 'CHEQUERED', cat: 'Race' }
  ];

  // Race state per driver
  let raceState = {};

  function initRaceState() {
    // Randomize starting grid slightly from DRIVERS order
    const grid = DRIVERS.map((d, i) => ({ ...d, pos: i + 1 }));
    
    grid.forEach(d => {
      const baseLap = 79.5 + Math.random() * 3; // 79.5-82.5s base lap
      const startCompound = d.pos <= 10 ? 'SOFT' : (Math.random() > 0.5 ? 'MEDIUM' : 'SOFT');
      raceState[d.num] = {
        position: d.pos,
        gap: d.pos === 1 ? '' : (d.pos * (0.8 + Math.random() * 0.6)).toFixed(3),
        interval: d.pos === 1 ? '' : ((0.5 + Math.random() * 1.2)).toFixed(3),
        lastLap: null,
        bestLap: null,
        baseLapTime: baseLap,
        compound: startCompound,
        stintLaps: 0,
        stintNumber: 0,
        numLaps: 0,
        pitLap: Math.floor(15 + Math.random() * 10), // First pit window
        pitted: false,
        pitted2: false,
        retired: false,
        retireLap: d.num === '43' ? 22 : (d.num === '5' ? 45 : null) // COL retires lap 22, BOR lap 45
      };
    });

    // Init DriverList
    DRIVERS.forEach(d => {
      srState.DriverList[d.num] = {
        RacingNumber: d.num,
        Tla: d.tla,
        FullName: d.name,
        BroadcastName: d.tla,
        TeamName: d.team,
        TeamColour: d.color
      };
    });
  }

  function simulateLap() {
    demoTick++;
    const lap = Math.min(Math.floor(demoTick / 2) + 1, 58);
    
    srState.LapCount = { CurrentLap: lap, TotalLaps: 58 };
    
    // Update remaining time
    const totalSec = Math.max(0, (58 - lap) * 82);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    srState.ExtrapolatedClock = {
      Remaining: `${h.toString().padStart(2,'0')}:${m.toString().padStart(2,'0')}:${s.toString().padStart(2,'0')}`,
      Extrapolating: true
    };

    // Simulate each driver
    Object.keys(raceState).forEach(num => {
      const rs = raceState[num];
      if (rs.retired) return;

      // Check retirement
      if (rs.retireLap && lap >= rs.retireLap) {
        rs.retired = true;
        rs.position = 20;
        return;
      }

      rs.numLaps = lap;
      rs.stintLaps++;

      // Lap time variation
      const variation = (Math.random() - 0.5) * 1.5;
      const tireWear = rs.stintLaps * 0.03;
      const lapTime = rs.baseLapTime + variation + tireWear;
      
      rs.lastLap = lapTime;
      if (!rs.bestLap || lapTime < rs.bestLap) rs.bestLap = lapTime;

      // Pit stop logic
      if (!rs.pitted && lap >= rs.pitLap && lap < rs.pitLap + 2) {
        rs.pitted = true;
        rs.compound = rs.compound === 'SOFT' ? 'HARD' : 'MEDIUM';
        rs.stintLaps = 0;
        rs.stintNumber++;
        rs.lastLap += 22; // Pit delta
      }
      if (rs.pitted && !rs.pitted2 && lap >= rs.pitLap + 18 && lap < rs.pitLap + 20) {
        rs.pitted2 = true;
        rs.compound = 'HARD';
        rs.stintLaps = 0;
        rs.stintNumber++;
        rs.lastLap += 22;
      }
    });

    // Sort by accumulated time (simplified — use gaps)
    const active = Object.entries(raceState)
      .filter(([_, rs]) => !rs.retired)
      .sort((a, b) => {
        const aScore = a[1].baseLapTime * 100 + (a[1].pitted ? -2 : 0) + (a[1].pitted2 ? -1 : 0);
        const bScore = b[1].baseLapTime * 100 + (b[1].pitted ? -2 : 0) + (b[1].pitted2 ? -1 : 0);
        return aScore - bScore;
      });

    // Assign positions and gaps
    active.forEach(([num, rs], idx) => {
      rs.position = idx + 1;
      if (idx === 0) {
        rs.gap = '';
        rs.interval = '';
      } else {
        const baseGap = idx * (0.6 + Math.random() * 0.8);
        rs.gap = baseGap.toFixed(3);
        rs.interval = (0.3 + Math.random() * 1.5).toFixed(3);
      }
    });

    // Retired drivers at bottom
    Object.entries(raceState).filter(([_, rs]) => rs.retired).forEach(([num, rs], idx) => {
      rs.position = active.length + idx + 1;
    });

    // Update srState.TimingData
    Object.entries(raceState).forEach(([num, rs]) => {
      const lapMin = Math.floor(rs.lastLap / 60);
      const lapSec = (rs.lastLap % 60).toFixed(3).padStart(6, '0');
      const lapStr = rs.lastLap ? `${lapMin}:${lapSec}` : '';
      
      const bestMin = Math.floor((rs.bestLap || 0) / 60);
      const bestSec = ((rs.bestLap || 0) % 60).toFixed(3).padStart(6, '0');
      const bestStr = rs.bestLap ? `${bestMin}:${bestSec}` : '';

      srState.TimingData.Lines[num] = {
        Position: String(rs.position),
        RacingNumber: num,
        GapToLeader: rs.gap || '',
        IntervalToPositionAhead: { Value: rs.interval || '' },
        LastLapTime: { Value: lapStr },
        BestLapTime: { Value: bestStr },
        NumberOfLaps: rs.numLaps,
        InPit: false,
        Retired: rs.retired,
        Stopped: rs.retired
      };
    });

    // Update TimingAppData (stints)
    Object.entries(raceState).forEach(([num, rs]) => {
      if (!srState.TimingAppData.Lines[num]) srState.TimingAppData.Lines[num] = { Stints: {} };
      srState.TimingAppData.Lines[num].Stints[String(rs.stintNumber)] = {
        Compound: rs.compound,
        TotalLaps: rs.stintLaps,
        New: rs.stintLaps < 2,
        StartLaps: Math.max(0, rs.numLaps - rs.stintLaps)
      };
    });

    // Track status events
    const trackEvents = {
      12: { Status: '2', Message: 'Yellow' },
      13: { Status: '1', Message: 'AllClear' },
      22: { Status: '6', Message: 'VSCDeployed' },
      25: { Status: '7', Message: 'VSCEnding' },
      26: { Status: '1', Message: 'AllClear' },
      33: { Status: '4', Message: 'SCDeployed' },
      36: { Status: '7', Message: 'SCEnding' },
      37: { Status: '1', Message: 'AllClear' },
      58: { Status: '1', Message: 'AllClear' }
    };
    if (trackEvents[lap]) {
      srState.TrackStatus = trackEvents[lap];
    }

    // Race control messages
    RC_EVENTS.forEach(ev => {
      if (ev.lap === lap) {
        const msgId = Object.keys(srState.RaceControlMessages.Messages).length;
        srState.RaceControlMessages.Messages[String(msgId)] = {
          Utc: new Date().toISOString(),
          Message: ev.msg,
          Flag: ev.flag,
          Category: ev.cat
        };
      }
    });

    // Weather small variations
    srState.WeatherData.AirTemp = (28 + Math.random() * 1.5).toFixed(1);
    srState.WeatherData.TrackTemp = (42 + Math.random() * 3).toFixed(1);
    srState.WeatherData.WindSpeed = (3 + Math.random() * 4).toFixed(1);

    // Render
    renderSignalRData();

    // Stop at lap 58
    if (lap >= 58 && demoTick > 116) {
      clearInterval(demoInterval);
      console.log('[SignalR DEMO] Race finished!');
    }
  }

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

  // ═══ CONVERT & RENDER (same as production) ═══
  function convertTimingToOpenF1() {
    const td = srState.TimingData;
    if (!td.Lines) return { positions: [], intervals: [], laps: [] };
    const positions = [], intervals = [], laps = [];
    Object.entries(td.Lines).forEach(([num, data]) => {
      const n = parseInt(num);
      if (data.Position) positions.push({ driver_number: n, position: parseInt(data.Position), date: new Date().toISOString() });
      const gapVal = data.GapToLeader;
      const intVal = data.IntervalToPositionAhead?.Value;
      if (gapVal !== undefined || intVal !== undefined) intervals.push({ driver_number: n, gap_to_leader: gapVal || null, interval: intVal || null, date: new Date().toISOString() });
      if (data.LastLapTime?.Value || data.NumberOfLaps) {
        const lapTimeStr = data.LastLapTime?.Value;
        let lapDuration = null;
        if (lapTimeStr) {
          const parts = lapTimeStr.split(':');
          if (parts.length === 2) lapDuration = parseInt(parts[0]) * 60 + parseFloat(parts[1]);
          else if (parts.length === 1) lapDuration = parseFloat(parts[0]);
        }
        laps.push({ driver_number: n, lap_number: data.NumberOfLaps || 0, lap_duration: lapDuration, date: new Date().toISOString() });
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
            stints.push({ driver_number: parseInt(num), compound: latest.Compound || '?', stint_number: parseInt(stintKeys[0]) + 1, tyre_age_at_pit: latest.TotalLaps || 0 });
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
        messages.push({ date: msg.Utc || new Date().toISOString(), message: msg.Message || '', flag: msg.Flag || '', category: msg.Category || '' });
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

  function renderSignalRData() {
    const { positions, intervals, laps } = convertTimingToOpenF1();
    if (positions.length === 0) return;
    const stints = convertStints();
    const rc = convertRaceControl();
    const flag = getTrackFlag();

    const dl = srState.DriverList;
    Object.entries(dl).forEach(([num, d]) => {
      const n = parseInt(d.RacingNumber || num);
      if (!liveDrivers[n]) liveDrivers[n] = {};
      if (d.FullName) liveDrivers[n].full_name = d.FullName;
      if (d.Tla) liveDrivers[n].name_acronym = d.Tla;
      if (d.TeamName) liveDrivers[n].team_name = d.TeamName;
      if (d.TeamColour) liveDrivers[n].team_colour = d.TeamColour;
      liveDrivers[n].driver_number = n;
    });

    const latestPos = {}, latestInt = {}, latestStint = {}, latestLap = {};
    positions.forEach(p => { latestPos[p.driver_number] = p; });
    intervals.forEach(i => { latestInt[i.driver_number] = i; });
    stints.forEach(s => { if (!latestStint[s.driver_number] || s.stint_number > (latestStint[s.driver_number].stint_number || 0)) latestStint[s.driver_number] = s; });
    laps.forEach(l => { if (!latestLap[l.driver_number] || l.lap_number > (latestLap[l.driver_number].lap_number || 0)) latestLap[l.driver_number] = l; });

    const sorted = Object.values(latestPos).sort((a, b) => (a.position || 99) - (b.position || 99));

    let fastestDriver = null, bestLapTime = Infinity;
    Object.values(latestLap).forEach(l => { if (l.lap_duration && l.lap_duration < bestLapTime) { bestLapTime = l.lap_duration; fastestDriver = l.driver_number; } });

    if (!window._liveGapMode) window._liveGapMode = 'leader';
    const lapCount = srState.LapCount;
    const lapInfo = lapCount.TotalLaps ? ` · Kolo ${lapCount.CurrentLap}/${lapCount.TotalLaps}` : '';
    const remaining = srState.ExtrapolatedClock.Remaining || '';

    let h = `<div class="card"><div class="stitle" style="display:flex;justify-content:space-between;align-items:center"><span>LIVE POŘADÍ${lapInfo}</span><div style="display:flex;align-items:center;gap:8px"><div style="display:flex;gap:4px">`;
    h += `<button onclick="window._liveGapMode='leader'" style="padding:3px 10px;border-radius:5px;border:1px solid ${window._liveGapMode === 'leader' ? 'var(--red)' : 'var(--line)'};background:${window._liveGapMode === 'leader' ? 'rgba(232,0,45,0.15)' : 'transparent'};color:${window._liveGapMode === 'leader' ? 'var(--red)' : 'var(--dim)'};font-size:11px;font-weight:600;cursor:pointer">Lídr</button>`;
    h += `<button onclick="window._liveGapMode='interval'" style="padding:3px 10px;border-radius:5px;border:1px solid ${window._liveGapMode === 'interval' ? 'var(--red)' : 'var(--line)'};background:${window._liveGapMode === 'interval' ? 'rgba(232,0,45,0.15)' : 'transparent'};color:${window._liveGapMode === 'interval' ? 'var(--red)' : 'var(--dim)'};font-size:11px;font-weight:600;cursor:pointer">Interval</button>`;
    h += `</div>`;
    if (remaining) h += `<span style="font-size:12px;color:var(--mid);font-weight:600;font-family:'Orbitron',monospace">${remaining}</span>`;
    h += `<span style="font-size:10px;color:#39B54A;font-weight:700;letter-spacing:1px">● LIVE</span>`;
    h += `<span style="font-size:12px;color:var(--red);font-weight:600">↻ ${new Date().toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>`;
    h += `</div></div>`;

    sorted.forEach(p => {
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
      const isRetired = raceState[String(p.driver_number)]?.retired;

      let gapText = pos2 === 1 ? 'LEADER' : '';
      if (isRetired) {
        gapText = 'DNF';
      } else if (pos2 > 1) {
        if (window._liveGapMode === 'leader' && gap != null) gapText = '+' + gap + 's';
        else if (window._liveGapMode === 'interval' && interval != null) gapText = '+' + interval + 's';
        else if (gap != null) gapText = '+' + gap + 's';
      }

      h += `<div class="live-row" data-driver="${p.driver_number}" style="${isRetired ? 'opacity:0.4' : ''}">`;
      h += `<div class="live-pos ${posClass}">${pos2}</div>`;
      h += `<div class="live-bar" style="background:${color}"></div>`;
      h += `<div class="live-info"><div class="live-name${isFastest ? ' fastest-lap' : ''}">${name}${isRetired ? ' <span style="color:#E8002D;font-size:11px">DNF</span>' : ''}</div><div class="live-team" style="color:${color}">${team}${lapTime && !isRetired ? ' · ' + lapTime : ''}</div></div>`;
      if (tireClass && !isRetired) {
        h += `<div class="live-tire ${tireClass}"><span style="font-size:11px;line-height:1">${tire ? tire.charAt(0) : '?'}</span>${tireAge != null ? `<span style="font-size:8px;color:${tire?.charAt(0) === 'M' ? 'rgba(0,0,0,0.5)' : tire?.charAt(0) === 'H' ? 'rgba(0,0,0,0.4)' : 'rgba(255,255,255,0.6)'};font-weight:500;line-height:1">${tireAge}</span>` : ''}</div>`;
      }
      h += `<div class="live-gap" style="min-width:100px;text-align:right;font-variant-numeric:tabular-nums;${isRetired ? 'color:#E8002D' : ''}">${gapText}</div>`;
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
        else if (msg.includes('INVESTIGAT') || msg.includes('NOTED') || msg.includes('NO FURTHER')) msgClass = 'rc-investigation';
        else if (msg.includes('VIRTUAL SAFETY CAR') || msg.includes('VSC')) msgClass = 'rc-vsc';
        else if (msg.includes('SAFETY CAR') && !msg.includes('VIRTUAL')) msgClass = 'rc-sc';
        let msgStyle = '';
        if (msg.includes('FASTEST')) msgStyle = 'color:#A020F0;font-weight:600;';
        h += `<div class="rc-msg ${msgClass}" style="${msgStyle}"><div class="rc-time">${time}</div>${fc ? `<div class="rc-flag ${fc}"></div>` : ''}<div class="rc-text">${m.message || ''}</div></div>`;
      });
      h += `</div>`;
    }

    // Apply flag
    const grid = document.querySelector('.live-grid');
    if (grid) grid.className = 'live-grid ' + flag;

    document.getElementById('liveContent').innerHTML = h;
  }

  // ═══ STARTUP ═══
  function startDemo() {
    console.log('[SignalR DEMO] Starting race simulation — Australian GP 2026');
    signalrConnected = true;
    initRaceState();

    // Show banner
    const banner = document.getElementById('homeLiveBanner');
    if (banner) { banner.style.display = 'block'; document.getElementById('liveBannerText').textContent = 'LIVE: Race · Australian Grand Prix'; }
    const dot = document.getElementById('liveDot');
    if (dot) dot.style.display = 'block';
    const btn = document.getElementById('liveBtn');
    if (btn) btn.style.color = '#E8002D';
    const noSess = document.querySelector('.no-session');
    if (noSess) noSess.style.display = 'none';

    // Stop existing OpenF1 polling
    if (window.liveInterval) { clearInterval(window.liveInterval); window.liveInterval = null; }

    // Navigate to LIVE tab
    if (typeof go === 'function') go('live', document.getElementById('liveBtn'));

    // Start simulation — new lap every 2 seconds
    renderSignalRData();
    demoInterval = setInterval(simulateLap, 2000);
  }

  // Wait for page load, then start demo
  setTimeout(startDemo, 2000);

  window._signalr = {
    state: srState,
    raceState: raceState,
    isConnected: () => signalrConnected,
    stop: () => { if (demoInterval) clearInterval(demoInterval); }
  };

  console.log('[SignalR DEMO] Module loaded. Race simulation will start in 2s...');

})();
