// Mock data: Milestone XProtect VMS + cameras + recording servers
// All fictional, plausible for Tuscaloosa City Schools

function gen(n, lo, hi) {
  const arr = [];
  let v = (lo + hi) / 2;
  for (let i = 0; i < n; i++) {
    v += (Math.random() - 0.5) * (hi - lo) * 0.25;
    v = Math.max(lo, Math.min(hi, v));
    arr.push(Number(v.toFixed(2)));
  }
  return arr;
}

// ───── Milestone XProtect environment ─────
const MILESTONE = {
  product: "XProtect Corporate 2024 R2",
  version: "24.2.4.12",
  managementServer: "tcs-mgmt-01.tcs.local",
  smtpRouted: true,
  licenseDeviceTotal: 1200,
  licenseDeviceUsed: 1147,
  licenseHwTotal: 1200,
  recordingServers: 6,
  recordingServersOnline: 6,
  failoverServers: 2,
  mobileServers: 1,
  smartClientSessions: 18,
  webClientSessions: 4,
  activeAlarms: 12,
  alarmsAck: 3,
  retentionDays: 30,
  storageTotalTB: 96.0,
  storageUsedTB: 71.4,
  evidenceLockSlots: 24,
  evidenceLockUsed: 7
};

// ───── Recording servers / DVRs ─────
const SERVERS = [{
  id: "tcs-rec-bhs-01",
  site: "Bryant HS",
  role: "Recording Server",
  os: "Win Server 2022",
  cpu: 38,
  mem: 64,
  disk: 71,
  raid: "ok",
  chans: 224,
  recording: 224,
  archiveLagH: 0.3,
  agent: "zbx-agent2 6.4.10",
  ip: "10.10.50.21",
  uptimeD: 47,
  lastBackup: "06h ago"
}, {
  id: "tcs-rec-chs-01",
  site: "Central HS",
  role: "Recording Server",
  os: "Win Server 2022",
  cpu: 41,
  mem: 58,
  disk: 68,
  raid: "ok",
  chans: 196,
  recording: 196,
  archiveLagH: 0.2,
  agent: "zbx-agent2 6.4.10",
  ip: "10.10.51.21",
  uptimeD: 47,
  lastBackup: "06h ago"
}, {
  id: "tcs-rec-nhs-01",
  site: "Northridge HS",
  role: "Recording Server",
  os: "Win Server 2022",
  cpu: 52,
  mem: 71,
  disk: 84,
  raid: "warn",
  chans: 208,
  recording: 206,
  archiveLagH: 1.4,
  agent: "zbx-agent2 6.4.10",
  ip: "10.10.52.21",
  uptimeD: 14,
  lastBackup: "06h ago"
}, {
  id: "tcs-rec-pms-01",
  site: "Paul W. Bryant",
  role: "Recording Server",
  os: "Win Server 2022",
  cpu: 22,
  mem: 49,
  disk: 54,
  raid: "ok",
  chans: 144,
  recording: 144,
  archiveLagH: 0.1,
  agent: "zbx-agent2 6.4.10",
  ip: "10.10.53.21",
  uptimeD: 91,
  lastBackup: "06h ago"
}, {
  id: "tcs-rec-ws-01",
  site: "Westlawn MS",
  role: "Recording Server",
  os: "Win Server 2019",
  cpu: 64,
  mem: 78,
  disk: 91,
  raid: "warn",
  chans: 128,
  recording: 121,
  archiveLagH: 2.8,
  agent: "zbx-agent2 6.0.31",
  ip: "10.10.54.21",
  uptimeD: 6,
  lastBackup: "30h ago"
}, {
  id: "tcs-rec-elem-01",
  site: "Elementary Pool",
  role: "Recording Server",
  os: "Win Server 2022",
  cpu: 33,
  mem: 54,
  disk: 62,
  raid: "ok",
  chans: 247,
  recording: 247,
  archiveLagH: 0.4,
  agent: "zbx-agent2 6.4.10",
  ip: "10.10.55.21",
  uptimeD: 47,
  lastBackup: "06h ago"
}, {
  id: "tcs-mgmt-01",
  site: "District DC",
  role: "Management Server",
  os: "Win Server 2022",
  cpu: 12,
  mem: 41,
  disk: 36,
  raid: "ok",
  chans: 0,
  recording: 0,
  archiveLagH: 0,
  agent: "zbx-agent2 6.4.10",
  ip: "10.10.40.10",
  uptimeD: 91,
  lastBackup: "06h ago"
}, {
  id: "tcs-fail-01",
  site: "District DC",
  role: "Failover",
  os: "Win Server 2022",
  cpu: 4,
  mem: 22,
  disk: 18,
  raid: "ok",
  chans: 0,
  recording: 0,
  archiveLagH: 0,
  agent: "zbx-agent2 6.4.10",
  ip: "10.10.40.11",
  uptimeD: 91,
  lastBackup: "06h ago"
}];

// ───── Cameras (subset rendered, total 1147) ─────
const CAMERAS = [{
  id: "BHS-C-101",
  site: "Bryant HS",
  loc: "1F Hallway 100s",
  model: "Axis P3265-LV",
  res: "1920×1080",
  fps: 25,
  bitrate: 4800,
  codec: "H.264",
  recording: "Continuous",
  state: "ok",
  ip: "10.20.50.101",
  mac: "B8:A4:4F:11:22:33",
  poe: 6.8,
  server: "tcs-rec-bhs-01",
  motion12h: 142
}, {
  id: "BHS-C-102",
  site: "Bryant HS",
  loc: "Cafeteria",
  model: "Axis P3265-LV",
  res: "1920×1080",
  fps: 25,
  bitrate: 5200,
  codec: "H.264",
  recording: "Continuous",
  state: "ok",
  ip: "10.20.50.102",
  mac: "B8:A4:4F:11:22:34",
  poe: 6.9,
  server: "tcs-rec-bhs-01",
  motion12h: 388
}, {
  id: "BHS-C-104",
  site: "Bryant HS",
  loc: "Gym A North",
  model: "Axis Q6135-LE",
  res: "2560×1440",
  fps: 30,
  bitrate: 8200,
  codec: "H.265",
  recording: "Continuous",
  state: "ok",
  ip: "10.20.50.104",
  mac: "B8:A4:4F:11:22:36",
  poe: 12.4,
  server: "tcs-rec-bhs-01",
  motion12h: 88
}, {
  id: "BHS-C-110",
  site: "Bryant HS",
  loc: "Main Entrance",
  model: "Axis P1448-LE",
  res: "3840×2160",
  fps: 25,
  bitrate: 9800,
  codec: "H.265",
  recording: "Continuous",
  state: "ok",
  ip: "10.20.50.110",
  mac: "B8:A4:4F:11:22:42",
  poe: 8.1,
  server: "tcs-rec-bhs-01",
  motion12h: 612
}, {
  id: "BHS-C-118",
  site: "Bryant HS",
  loc: "Bus Loop",
  model: "Hanwha XNV-8082R",
  res: "3840×2160",
  fps: 20,
  bitrate: 7400,
  codec: "H.265",
  recording: "Motion+Cont",
  state: "ok",
  ip: "10.20.50.118",
  mac: "B8:A4:4F:11:22:50",
  poe: 9.6,
  server: "tcs-rec-bhs-01",
  motion12h: 244
}, {
  id: "BHS-C-122",
  site: "Bryant HS",
  loc: "Bldg B Stairwell",
  model: "Axis P3265-LV",
  res: "1920×1080",
  fps: 12,
  bitrate: 1100,
  codec: "H.264",
  recording: "Motion",
  state: "warn",
  warnMsg: "FPS below target (12 / 25)",
  ip: "10.20.50.122",
  mac: "B8:A4:4F:11:22:54",
  poe: 5.4,
  server: "tcs-rec-bhs-01",
  motion12h: 14
}, {
  id: "BHS-C-127",
  site: "Bryant HS",
  loc: "Library",
  model: "Axis P3265-LV",
  res: "1920×1080",
  fps: 0,
  bitrate: 0,
  codec: "—",
  recording: "—",
  state: "err",
  errMsg: "Stream lost · ICMP unreachable 4m",
  ip: "10.20.50.127",
  mac: "B8:A4:4F:11:22:59",
  poe: 0,
  server: "tcs-rec-bhs-01",
  motion12h: 0
}, {
  id: "CHS-C-204",
  site: "Central HS",
  loc: "Cafeteria SE",
  model: "Axis P3265-LV",
  res: "1920×1080",
  fps: 25,
  bitrate: 4900,
  codec: "H.264",
  recording: "Continuous",
  state: "ok",
  ip: "10.20.51.204",
  mac: "B8:A4:4F:22:11:04",
  poe: 6.7,
  server: "tcs-rec-chs-01",
  motion12h: 412
}, {
  id: "CHS-C-211",
  site: "Central HS",
  loc: "Gym Lobby",
  model: "Hanwha PNV-A9081R",
  res: "3840×2160",
  fps: 25,
  bitrate: 8800,
  codec: "H.265",
  recording: "Continuous",
  state: "ok",
  ip: "10.20.51.211",
  mac: "B8:A4:4F:22:11:11",
  poe: 11.2,
  server: "tcs-rec-chs-01",
  motion12h: 199
}, {
  id: "NHS-C-310",
  site: "Northridge HS",
  loc: "Auditorium",
  model: "Axis P3265-LV",
  res: "1920×1080",
  fps: 25,
  bitrate: 4700,
  codec: "H.264",
  recording: "Continuous",
  state: "ok",
  ip: "10.20.52.310",
  mac: "B8:A4:4F:33:11:10",
  poe: 6.7,
  server: "tcs-rec-nhs-01",
  motion12h: 76
}, {
  id: "NHS-C-315",
  site: "Northridge HS",
  loc: "Parking East",
  model: "Axis Q6135-LE",
  res: "2560×1440",
  fps: 30,
  bitrate: 8400,
  codec: "H.265",
  recording: "Continuous",
  state: "warn",
  warnMsg: "Tampering · scene change detected",
  ip: "10.20.52.315",
  mac: "B8:A4:4F:33:11:15",
  poe: 12.6,
  server: "tcs-rec-nhs-01",
  motion12h: 1208
}, {
  id: "PMS-C-401",
  site: "Paul W. Bryant",
  loc: "Front Office",
  model: "Axis P3265-LV",
  res: "1920×1080",
  fps: 25,
  bitrate: 4600,
  codec: "H.264",
  recording: "Continuous",
  state: "ok",
  ip: "10.20.53.401",
  mac: "B8:A4:4F:44:11:01",
  poe: 6.6,
  server: "tcs-rec-pms-01",
  motion12h: 318
}, {
  id: "WS-C-512",
  site: "Westlawn MS",
  loc: "Bus Loop",
  model: "Hanwha XNV-8082R",
  res: "3840×2160",
  fps: 18,
  bitrate: 6800,
  codec: "H.265",
  recording: "Continuous",
  state: "warn",
  warnMsg: "Recording lag 14s vs server clock",
  ip: "10.20.54.512",
  mac: "B8:A4:4F:55:11:12",
  poe: 9.4,
  server: "tcs-rec-ws-01",
  motion12h: 511
}, {
  id: "WS-C-519",
  site: "Westlawn MS",
  loc: "Cafeteria",
  model: "Axis P3265-LV",
  res: "1920×1080",
  fps: 0,
  bitrate: 0,
  codec: "—",
  recording: "—",
  state: "err",
  errMsg: "Auth failed · invalid ONVIF cred",
  ip: "10.20.54.519",
  mac: "B8:A4:4F:55:11:19",
  poe: 0,
  server: "tcs-rec-ws-01",
  motion12h: 0
}, {
  id: "ELEM-C-014",
  site: "Verner Elem",
  loc: "Main Entrance",
  model: "Axis P3265-LV",
  res: "1920×1080",
  fps: 25,
  bitrate: 4500,
  codec: "H.264",
  recording: "Continuous",
  state: "ok",
  ip: "10.20.55.014",
  mac: "B8:A4:4F:66:11:14",
  poe: 6.5,
  server: "tcs-rec-elem-01",
  motion12h: 412
}];

// ───── Active Milestone alarms ─────
const VMS_ALARMS = [{
  ts: "09:42:14",
  sev: "high",
  cam: "BHS-C-127",
  msg: "Camera not responding · Communication error",
  site: "Bryant HS",
  ack: false
}, {
  ts: "09:38:01",
  sev: "warning",
  cam: "WS-C-512",
  msg: "Recording lag exceeds 10s threshold",
  site: "Westlawn MS",
  ack: false
}, {
  ts: "09:21:47",
  sev: "warning",
  cam: "NHS-C-315",
  msg: "Camera tampering · scene change detected",
  site: "Northridge HS",
  ack: false
}, {
  ts: "09:14:09",
  sev: "high",
  cam: "WS-C-519",
  msg: "ONVIF authentication failure (3 attempts)",
  site: "Westlawn MS",
  ack: false
}, {
  ts: "08:48:33",
  sev: "warning",
  cam: "BHS-C-122",
  msg: "Configured FPS not met (12 actual / 25 target)",
  site: "Bryant HS",
  ack: false
}, {
  ts: "08:12:00",
  sev: "warning",
  srv: "tcs-rec-nhs-01",
  msg: "RAID rebuild in progress · disk 4 replaced",
  site: "Northridge HS",
  ack: true
}, {
  ts: "07:55:18",
  sev: "warning",
  srv: "tcs-rec-ws-01",
  msg: "Disk usage 91% · retention may roll early",
  site: "Westlawn MS",
  ack: true
}, {
  ts: "07:32:42",
  sev: "info",
  cam: "BHS-C-110",
  msg: "Motion event count anomaly (+187% vs 7-day mean)",
  site: "Bryant HS",
  ack: true
}, {
  ts: "Yesterday 23:14",
  sev: "high",
  cam: "CHS-C-204",
  msg: "Stream restarted by recording server (3rd today)",
  site: "Central HS",
  ack: true
}];

// ───── Per-site rollup ─────
const SITES = [{
  name: "Bryant HS",
  cams: 224,
  online: 223,
  warn: 1,
  err: 1,
  server: "tcs-rec-bhs-01",
  storageGB: 12400,
  storageCapGB: 16000
}, {
  name: "Central HS",
  cams: 196,
  online: 196,
  warn: 0,
  err: 0,
  server: "tcs-rec-chs-01",
  storageGB: 11200,
  storageCapGB: 16000
}, {
  name: "Northridge HS",
  cams: 208,
  online: 206,
  warn: 1,
  err: 0,
  server: "tcs-rec-nhs-01",
  storageGB: 13800,
  storageCapGB: 16000
}, {
  name: "Paul W. Bryant",
  cams: 144,
  online: 144,
  warn: 0,
  err: 0,
  server: "tcs-rec-pms-01",
  storageGB: 7800,
  storageCapGB: 14000
}, {
  name: "Westlawn MS",
  cams: 128,
  online: 121,
  warn: 1,
  err: 1,
  server: "tcs-rec-ws-01",
  storageGB: 13100,
  storageCapGB: 14400
}, {
  name: "Elementary Pool",
  cams: 247,
  online: 247,
  warn: 0,
  err: 0,
  server: "tcs-rec-elem-01",
  storageGB: 13100,
  storageCapGB: 18000
}];

// ───── Time-series for fleet ─────
const FLEET_HISTORY = {
  totalIngressGbps: gen(48, 1.6, 2.4),
  storageWriteMBps: gen(48, 720, 980),
  recordingServersCpu: gen(48, 28, 58),
  camerasOnline: gen(48, 1140, 1147),
  alarmsPerHour: gen(48, 0, 8),
  archiveLagMin: gen(48, 0.2, 3.0)
};

// ───── Per-camera 24h history ─────
const CAM_HISTORY = {
  fps: gen(48, 23, 26),
  bitrate: gen(48, 4400, 5200),
  packetLoss: gen(48, 0, 0.1),
  motion: gen(48, 0, 18),
  cpu: gen(48, 18, 32),
  temp: gen(48, 36, 44)
};

// ───── Per-server 24h history ─────
const SERVER_HISTORY = {
  cpu: gen(48, 30, 55),
  mem: gen(48, 55, 75),
  diskWrite: gen(48, 110, 180),
  diskRead: gen(48, 18, 60),
  netIn: gen(48, 1200, 1900),
  netOut: gen(48, 80, 240),
  recChannels: gen(48, 220, 224)
};
window.MILESTONE = MILESTONE;
window.SERVERS = SERVERS;
window.CAMERAS = CAMERAS;
window.VMS_ALARMS = VMS_ALARMS;
window.SITES = SITES;
window.FLEET_HISTORY = FLEET_HISTORY;
window.CAM_HISTORY = CAM_HISTORY;
window.SERVER_HISTORY = SERVER_HISTORY;