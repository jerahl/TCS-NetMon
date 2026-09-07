// Extreme switch fleet data — fictional, modeled on a typical EXOS/Universal stack

window.SWITCH_SITES = [
  {
    id: "arc", name: "Arcadia", expanded: true, problems: 0,
    switches: [
      { id: "ARC-GYM",    ip: "10.24.1.5",  model: "5520-24T",       members: 1, ports: 24,  up: 18, down: 4,  poe: 6,  cpu: 18, mem: 31, temp: 64, problems: 0 },
      { id: "ARC-IDF-109",ip: "10.24.1.9",  model: "5520-48T",       members: 1, ports: 48,  up: 41, down: 5,  poe: 22, cpu: 22, mem: 34, temp: 66, problems: 0 },
      { id: "ARC-IDF-217",ip: "10.24.1.17", model: "5320-48P-8XE",   members: 1, ports: 48,  up: 39, down: 7,  poe: 28, cpu: 24, mem: 38, temp: 68, problems: 0 },
      { id: "ARC-MDF",    ip: "10.24.0.1",  model: "5520-VIM-4XE",   members: 4, ports: 240, up: 79, down: 144,poe: 38, cpu: 25, mem: 36, temp: 69, problems: 0, selected: true },
      { id: "ARCSBC",     ip: "10.24.0.6",  model: "5320-24P-8XE",   members: 1, ports: 24,  up: 9,  down: 13, poe: 4,  cpu: 11, mem: 28, temp: 60, problems: 0 },
    ],
  },
  {
    id: "bhs", name: "Bryant High", expanded: true, problems: 2,
    switches: [
      { id: "BHS-135", ip: "10.30.1.35", model: "5520-48T",     members: 2, ports: 96, up: 81, down: 12, poe: 44, cpu: 31, mem: 41, temp: 71, problems: 0 },
      { id: "BHS-MDF", ip: "10.30.0.1",  model: "5720-48MXW",   members: 4, ports: 192, up: 158, down: 27, poe: 92, cpu: 38, mem: 47, temp: 74, problems: 1 },
      { id: "BHS-IDF-A", ip: "10.30.1.10", model: "5320-48P-8XE", members: 1, ports: 48, up: 38, down: 8, poe: 24, cpu: 21, mem: 35, temp: 67, problems: 1 },
    ],
  },
  {
    id: "chs", name: "Central High", expanded: false, problems: 1,
    switches: [
      { id: "CHS-MDF", ip: "10.40.0.1", model: "5720-48MW", members: 4, ports: 192, up: 144, down: 41, poe: 88, cpu: 33, mem: 44, temp: 72, problems: 1 },
      { id: "CHS-IDF-1", ip: "10.40.1.5", model: "5520-48T", members: 1, ports: 48, up: 41, down: 5, poe: 22, cpu: 19, mem: 32, temp: 65, problems: 0 },
    ],
  },
  {
    id: "nrh", name: "Northridge High", expanded: false, problems: 0,
    switches: [
      { id: "NRH-MDF", ip: "10.50.0.1", model: "5720-24MXW", members: 2, ports: 96, up: 78, down: 13, poe: 41, cpu: 27, mem: 40, temp: 68, problems: 0 },
    ],
  },
  {
    id: "tcs", name: "Tuscaloosa Career & Technology Academy", expanded: false, problems: 0,
    switches: [
      { id: "TCTA-MDF",  ip: "10.60.0.1", model: "5520-48T", members: 1, ports: 48, up: 42, down: 5, poe: 22, cpu: 20, mem: 33, temp: 65, problems: 0 },
      { id: "TCTA-IDF-2",ip: "10.60.1.2", model: "5320-24P", members: 1, ports: 24, up: 19, down: 4, poe: 11, cpu: 14, mem: 29, temp: 62, problems: 0 },
    ],
  },
  {
    id: "wms", name: "Westlawn Middle", expanded: false, problems: 0,
    switches: [
      { id: "WMS-MDF", ip: "10.70.0.1", model: "5520-24T", members: 1, ports: 24, up: 21, down: 2, poe: 12, cpu: 16, mem: 30, temp: 63, problems: 0 },
    ],
  },
  {
    id: "ehs", name: "Eastwood Middle", expanded: false, problems: 0,
    switches: [
      { id: "EMS-MDF", ip: "10.80.0.1", model: "5520-24T", members: 1, ports: 24, up: 18, down: 5, poe: 9, cpu: 13, mem: 29, temp: 62, problems: 0 },
    ],
  },
];

// Build a port array for a given switch member.
// Each port: { n: number, state: "up"|"down"|"disabled"|"absent", speed: 10|100|1000|10000, poe: bool, alert: bool }
function buildMember(seed, count, opts = {}) {
  // seed-based pseudo-random so the layout is stable across renders
  let x = seed;
  const rnd = () => {
    x = (x * 9301 + 49297) % 233280;
    return x / 233280;
  };
  const ports = [];
  const upRatio = opts.upRatio ?? 0.5;
  const poeRatio = opts.poeRatio ?? 0.25;
  const absentTail = opts.absentTail ?? 6; // last few ports unused
  for (let i = 1; i <= count; i++) {
    const r = rnd();
    let state;
    if (i > count - absentTail && r > 0.35) state = "absent";
    else if (r < 0.05) state = "disabled";
    else if (r < 0.05 + (1 - upRatio)) state = "down";
    else state = "up";
    let speed = 1000;
    if (state === "up") {
      const sp = rnd();
      if (sp < 0.04) speed = 10;
      else if (sp < 0.22) speed = 100;
      else if (sp < 0.93) speed = 1000;
      else speed = 10000;
    }
    const poe = state === "up" && rnd() < poeRatio;
    const alert = i === opts.alertPort;
    ports.push({ n: i, state, speed, poe, alert });
  }
  // SFP cage: last 4 ports as fiber (uplinks)
  return ports;
}

// Build SFP uplink ports separately (57-60 style)
function buildSfp(seed, startNum = 57) {
  let x = seed;
  const rnd = () => { x = (x * 9301 + 49297) % 233280; return x / 233280; };
  return [0,1,2,3].map(i => {
    const r = rnd();
    let state = r < 0.5 ? "up" : "absent";
    return { n: startNum + i, state, speed: state === "up" ? 10000 : 1000, sfp: true };
  });
}

// Pre-built stack for ARC-MDF (selected) — 4 members of 56 ports each + 4 SFP cage each
window.ARC_MDF_STACK = [
  { idx: 1, ports: buildMember(11, 56, { upRatio: 0.55, poeRatio: 0.22, absentTail: 8, alertPort: 18 }), sfp: buildSfp(31, 57), upCount: 20, downCount: 32, poeCount: 9 },
  { idx: 2, ports: buildMember(23, 56, { upRatio: 0.45, poeRatio: 0.30, absentTail: 8 }),                sfp: buildSfp(43, 57), upCount: 17, downCount: 35, poeCount: 12 },
  { idx: 3, ports: buildMember(37, 56, { upRatio: 0.50, poeRatio: 0.28, absentTail: 8 }),                sfp: buildSfp(59, 57), upCount: 22, downCount: 30, poeCount: 8 },
  { idx: 4, ports: buildMember(53, 56, { upRatio: 0.42, poeRatio: 0.25, absentTail: 8 }),                sfp: buildSfp(71, 57), upCount: 19, downCount: 33, poeCount: 9 },
];

// 24h history for ARC-MDF
window.ARC_MDF_HISTORY = {
  cpu:        [22,21,23,25,24,22,20,21,24,28,33,38,42,36,29,26,25,24,26,27,25,23,22,25],
  mem:        [33,33,34,34,35,35,35,36,36,37,38,38,39,38,37,36,36,35,35,36,36,36,36,36],
  temp:       [62,62,63,63,64,64,65,65,66,67,68,69,70,70,69,68,67,67,68,69,69,69,69,69],
  uplinkRx:   [820,840,910,1020,1180,1340,1480,1620,1730,1820,1880,1900,1880,1810,1700,1600,1480,1320,1180,1080,990,920,880,860],
  uplinkTx:   [410,420,440,490,560,640,720,800,860,910,950,970,940,890,820,760,690,620,550,490,450,420,400,390],
  poeWatts:   [380,378,382,388,392,398,410,418,428,440,452,462,468,470,470,468,460,450,438,422,410,400,390,386],
};

// Recent problems / triggers (Zabbix-style)
window.SWITCH_PROBLEMS = [
  { ts: "07:14:22", sev: "warning", host: "BHS-MDF",   trig: "Member 2 PoE budget > 80%",       age: "01:24",  ack: false },
  { ts: "06:51:08", sev: "high",    host: "BHS-IDF-A", trig: "Port 1/12 link flapping (8/m)",   age: "01:47",  ack: false },
  { ts: "05:33:55", sev: "warning", host: "CHS-MDF",   trig: "Stack member 3 temp > 75°C",      age: "03:05",  ack: true  },
  { ts: "Yesterday",sev: "info",    host: "ARC-MDF",   trig: "Configuration saved by admin",    age: "14:22",  ack: true  },
];

// Per-port detail data — keyed by "memberIdx:portN"
// PacketFence device + bandwidth/error history
const _devices = [
  { mac: "30:13:8b:25:8d:02", ip: "10.24.0.101", host: "ARC-205-4264L3C.tcs.local", vendor: "HP Inc.",      os: "Windows OS",  owner: "host/ARC-205-4264L3C.tcs", dhcpFp: "1,3,6,15,31,33,43,44,46,47,121,249,252", role: "faculty",   reg: "UNREG", lastSeen: "2026-05-09 17:35:35", lastDhcp: "2026-05-08 23:00:57" },
  { mac: "f4:39:09:1b:c2:1e", ip: "10.24.0.142", host: "BHS-WAP-N4-21",            vendor: "Extreme Networks", os: "ExtremeWiNG",  owner: "device/wap",              dhcpFp: "1,3,6,15,28,42,121",                  role: "av",        reg: "REG",   lastSeen: "2026-05-09 17:38:11", lastDhcp: "2026-05-09 03:14:22" },
  { mac: "ac:1f:6b:7d:09:44", ip: "10.24.0.118", host: "TEACHER-IPAD-091",         vendor: "Apple, Inc.",   os: "iPadOS 17",   owner: "user/jdoe",               dhcpFp: "1,3,6,15,119,252",                    role: "byod",      reg: "REG",   lastSeen: "2026-05-09 17:34:02", lastDhcp: "2026-05-09 14:21:08" },
  { mac: "00:1b:21:a4:33:09", ip: "10.24.0.221", host: "ARC-LAB-PC-22",           vendor: "Dell Inc.",     os: "Windows 11",  owner: "host/ARC-LAB-PC-22.tcs",  dhcpFp: "1,3,6,15,31,33,43,44,121",            role: "student",   reg: "REG",   lastSeen: "2026-05-09 17:33:57", lastDhcp: "2026-05-09 11:22:14" },
  { mac: "b8:27:eb:1f:5a:30", ip: "10.24.0.95",  host: "ARC-PRINTER-014",         vendor: "Raspberry Pi",  os: "Linux",       owner: "device/printer",          dhcpFp: "1,3,6,12,15,28,42,121",               role: "av",        reg: "REG",   lastSeen: "2026-05-09 17:30:22", lastDhcp: "2026-05-08 14:15:33" },
];

// hist seed -> traffic curve generator
function _trafGen(seed, base, peak) {
  let x = seed;
  const rnd = () => { x = (x * 9301 + 49297) % 233280; return x / 233280; };
  return Array.from({ length: 60 }, (_, i) => {
    const r = rnd();
    return Math.round(base + (peak - base) * r * r);
  });
}

window.PORT_DETAILS = {
  "1:18": {
    label: "1:18",
    state: "up",
    speed: 1000,
    poe: true,
    poeWatts: 7.4,
    inKbps: 1.8,
    outKbps: 10.5,
    utilPct: 0,
    inHist: _trafGen(11, 0.5, 12),
    outHist: _trafGen(13, 1, 18),
    onlineHist: Array.from({ length: 60 }, (_, i) => i < 60 ? "ok" : "down"),
    errors1h: 0,
    discards1h: 0,
    device: _devices[0],
    extraMacs: 1,
    ifIndex: 1018,
    ageMin: 30,
  },
  "1:7": {
    label: "1:7",
    state: "up",
    speed: 1000,
    poe: true,
    poeWatts: 12.1,
    inKbps: 8.4,
    outKbps: 24.2,
    utilPct: 1,
    inHist: _trafGen(21, 1, 22),
    outHist: _trafGen(23, 2, 28),
    onlineHist: Array.from({ length: 60 }, () => "ok"),
    errors1h: 0,
    discards1h: 0,
    device: _devices[1],
    extraMacs: 0,
    ifIndex: 1007,
    ageMin: 14,
  },
  "1:13": {
    label: "1:13",
    state: "up",
    speed: 100,
    poe: false,
    poeWatts: 0,
    inKbps: 32,
    outKbps: 410,
    utilPct: 4,
    inHist: _trafGen(31, 2, 60),
    outHist: _trafGen(35, 8, 420),
    onlineHist: Array.from({ length: 60 }, () => "ok"),
    errors1h: 2,
    discards1h: 0,
    device: _devices[2],
    extraMacs: 0,
    ifIndex: 1013,
    ageMin: 4,
  },
  "1:29": {
    label: "1:29",
    state: "up",
    speed: 1000,
    poe: false,
    poeWatts: 0,
    inKbps: 184,
    outKbps: 1240,
    utilPct: 1,
    inHist: _trafGen(41, 10, 200),
    outHist: _trafGen(43, 20, 1500),
    onlineHist: Array.from({ length: 60 }, (_, i) => i === 23 || i === 24 ? "down" : "ok"),
    errors1h: 0,
    discards1h: 4,
    device: _devices[3],
    extraMacs: 0,
    ifIndex: 1029,
    ageMin: 12,
  },
  "1:33": {
    label: "1:33",
    state: "up",
    speed: 1000,
    poe: true,
    poeWatts: 4.2,
    inKbps: 0.4,
    outKbps: 0.8,
    utilPct: 0,
    inHist: _trafGen(51, 0, 1.2),
    outHist: _trafGen(53, 0, 1.6),
    onlineHist: Array.from({ length: 60 }, () => "ok"),
    errors1h: 0,
    discards1h: 0,
    device: _devices[4],
    extraMacs: 0,
    ifIndex: 1033,
    ageMin: 240,
  },
};

// Generic detail builder for any port — falls back to synthetic data
window.makePortDetail = function(memberIdx, port) {
  const key = `${memberIdx}:${port.n}`;
  if (window.PORT_DETAILS[key]) return window.PORT_DETAILS[key];
  const seed = memberIdx * 100 + port.n;
  // synthetic for any other UP port
  if (port.state === "up") {
    const dev = _devices[(seed) % _devices.length];
    const peakIn = port.speed === 10000 ? 1800 : port.speed === 1000 ? 80 : port.speed === 100 ? 12 : 2;
    const peakOut = peakIn * 0.6;
    return {
      label: key,
      state: "up",
      speed: port.speed,
      poe: port.poe,
      poeWatts: port.poe ? Math.round((4 + (seed % 25)) * 10) / 10 : 0,
      inKbps: Math.round(peakIn * 0.1 * 10) / 10,
      outKbps: Math.round(peakOut * 0.1 * 10) / 10,
      utilPct: Math.max(0, Math.round(peakIn / (port.speed * 100))),
      inHist: _trafGen(seed, 0, peakIn),
      outHist: _trafGen(seed + 7, 0, peakOut),
      onlineHist: Array.from({ length: 60 }, () => "ok"),
      errors1h: 0,
      discards1h: 0,
      device: dev,
      extraMacs: 0,
      ifIndex: 1000 + port.n,
      ageMin: 5 + (seed % 600),
    };
  }
  return {
    label: key,
    state: port.state,
    speed: 0,
    poe: false,
    poeWatts: 0,
    inKbps: 0,
    outKbps: 0,
    utilPct: 0,
    inHist: Array.from({ length: 60 }, () => 0),
    outHist: Array.from({ length: 60 }, () => 0),
    onlineHist: Array.from({ length: 60 }, () => port.state === "down" ? "down" : "off"),
    errors1h: 0,
    discards1h: 0,
    device: null,
    extraMacs: 0,
    ifIndex: 1000 + port.n,
    ageMin: 0,
  };
};

// Top talkers / link utilization for ARC-MDF (uplinks)
window.ARC_MDF_LINKS = [
  { name: "1:57",  type: "10G SR", peer: "core-arc-1 Te1/0/13", rxMbps: 1820, txMbps: 940, util: 18, errors: 0 },
  { name: "1:59",  type: "10G SR", peer: "core-arc-2 Te1/0/13", rxMbps: 1640, txMbps: 720, util: 16, errors: 0 },
  { name: "2:57",  type: "10G SR", peer: "ARC-IDF-109 1:49",    rxMbps: 982,  txMbps: 412, util: 10, errors: 0 },
  { name: "3:59",  type: "10G SR", peer: "ARC-IDF-217 1:49",    rxMbps: 412,  txMbps: 188, util: 4,  errors: 2 },
];
