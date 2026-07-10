// Synthetic data for the Global Dashboard.
// Mirrors the per-domain dashboards so totals look consistent across pages.

const GLOBAL_TOTALS = {
  hosts:     { total: 2418, up: 2371, down: 23, unknown: 24 },
  problems:  { disaster: 2, high: 7, warning: 38, info: 14, ack: 19 },
  sla:       { value: 99.86, target: 99.5 },
  devices:   { total: 12847, online: 12502, quarantine: 2, byod: 1843 },
  proxies:   { total: 6, online: 6 },
  templates: { total: 184, version: "tcs/2024-09" },
};

// 26 sites, each rolled up
const GLOBAL_SITES = [
  { id: "BHS", name: "Bryant High School",        type: "high",   hosts: 187, problems: 12, sev: "high",     sla: 99.91, kind: "primary" },
  { id: "CHS", name: "Central High School",       type: "high",   hosts: 162, problems: 8,  sev: "warning",  sla: 99.78 },
  { id: "NRH", name: "Northridge High School",    type: "high",   hosts: 154, problems: 4,  sev: "warning",  sla: 99.92 },
  { id: "PHS", name: "Paul W. Bryant Middle",     type: "middle", hosts: 98,  problems: 6,  sev: "warning",  sla: 99.83 },
  { id: "ECS", name: "Eastwood Middle School",    type: "middle", hosts: 92,  problems: 1,  sev: "info",     sla: 99.97 },
  { id: "WMS", name: "Westlawn Middle School",    type: "middle", hosts: 87,  problems: 3,  sev: "warning",  sla: 99.88 },
  { id: "TMS", name: "Tuscaloosa Magnet Middle",  type: "middle", hosts: 76,  problems: 0,  sev: "ok",       sla: 99.99 },
  { id: "ALV", name: "Alberta Elementary",        type: "elem",   hosts: 64,  problems: 2,  sev: "warning",  sla: 99.92 },
  { id: "AED", name: "Arcadia Elementary",        type: "elem",   hosts: 58,  problems: 1,  sev: "info",     sla: 99.95 },
  { id: "CRS", name: "Central Elementary",        type: "elem",   hosts: 61,  problems: 14, sev: "disaster", sla: 98.21, kind: "outage" },
  { id: "MTV", name: "Martin Luther King Jr Elem",type: "elem",   hosts: 54,  problems: 0,  sev: "ok",       sla: 99.99 },
  { id: "OAK", name: "Oakdale Elementary",        type: "elem",   hosts: 48,  problems: 2,  sev: "warning",  sla: 99.81 },
  { id: "RCK", name: "Rock Quarry Elementary",    type: "elem",   hosts: 51,  problems: 1,  sev: "info",     sla: 99.94 },
  { id: "SKL", name: "Skyland Elementary",        type: "elem",   hosts: 47,  problems: 0,  sev: "ok",       sla: 99.98 },
  { id: "STA", name: "Stafford Elementary",       type: "elem",   hosts: 49,  problems: 4,  sev: "warning",  sla: 99.74 },
  { id: "TKM", name: "Tuscaloosa Magnet Elem",    type: "elem",   hosts: 56,  problems: 0,  sev: "ok",       sla: 100.0 },
  { id: "UPL", name: "University Place Elem",     type: "elem",   hosts: 52,  problems: 1,  sev: "info",     sla: 99.93 },
  { id: "VWS", name: "Verner Elementary",         type: "elem",   hosts: 46,  problems: 0,  sev: "ok",       sla: 99.99 },
  { id: "WDS", name: "Woodland Forrest Elem",     type: "elem",   hosts: 44,  problems: 2,  sev: "warning",  sla: 99.86 },
  { id: "TCT", name: "Tuscaloosa Career & Tech",  type: "career", hosts: 81,  problems: 1,  sev: "info",     sla: 99.95 },
  { id: "AOL", name: "Tuscaloosa Online",         type: "career", hosts: 14,  problems: 0,  sev: "ok",       sla: 100.0 },
  { id: "OAS", name: "Oak Hill Special Ed",       type: "elem",   hosts: 22,  problems: 0,  sev: "ok",       sla: 99.99 },
  { id: "TCS", name: "TCS Central Office",        type: "admin",  hosts: 142, problems: 5,  sev: "warning",  sla: 99.81, kind: "primary" },
  { id: "TCO", name: "Operations / Warehouse",    type: "admin",  hosts: 38,  problems: 0,  sev: "ok",       sla: 99.97 },
  { id: "TDC", name: "Datacenter (CO Annex)",     type: "admin",  hosts: 41,  problems: 1,  sev: "warning",  sla: 99.99, kind: "primary" },
  { id: "TBS", name: "Bus Operations",            type: "admin",  hosts: 21,  problems: 0,  sev: "ok",       sla: 99.94 },
];

// 4 infrastructure domains — drive the System Snapshot tiles.
// Shape mirrors the design's GLOBAL_SYSTEMS entries: each tile has a
// label/sub/icon/src/status header, 3 KPIs, a sparkline + label, and a
// "top" headline that gets rendered with a severity-coloured left border.
const GLOBAL_DOMAINS = [
  {
    id: "wireless",
    label: "Wireless · XIQ",
    sub: "ExtremeCloud IQ · 1,184 APs",
    icon: "wifi", src: "ext", status: "warning",
    href: "zabbix.php?action=tcs.xiq.view",
    total: 1184, ok: 1162, warn: 18, err: 4, problems: 22,
    kpis: [
      { label: "APs online",        value: "1,162 / 1,184", note: "22 APs with problems" },
      { label: "Connected clients", value: "4,328",         note: "ax 3,981 · ac 295" },
      { label: "RF health",         value: "94", unit: "/100", note: "target ≥ 90 · 2.4 GHz dragging" },
    ],
    spark: [4101,4218,4256,4302,4288,4275,4310,4350,4391,4406,4380,4350,4318,4292,4280,4262,4255,4271,4290,4308,4327,4322,4329,4328],
    sparkColor: "var(--ext)", sparkLabel: "Connected clients · 24h",
    top: "BHS-23-Cafe lost LAN uplink (5m) · 22 APs with active problems",
  },
  {
    id: "switches",
    label: "Switches",
    sub: "Extreme Universal · 312 stacks",
    icon: "ethernet", src: "zbx", status: "high",
    href: "zabbix.php?action=tcs.switches.view",
    total: 312, ok: 304, warn: 6, err: 2, problems: 11,
    kpis: [
      { label: "Switches up", value: "310 / 312",    note: "2 unreachable" },
      { label: "Ports up",    value: "6,184 / 7,008", note: "88% utilised" },
      { label: "PoE budget",  value: "73", unit: "%", note: "12 ports throttled" },
    ],
    spark: [6122,6140,6155,6170,6188,6201,6214,6220,6212,6201,6188,6175,6160,6152,6149,6151,6160,6172,6181,6186,6190,6187,6184,6184],
    sparkColor: "var(--zbx)", sparkLabel: "Ports up · 24h",
    top: "TCS-CO-CORE-01 PSU2 failed · running on PSU1 only",
  },
  {
    id: "servers",
    label: "Servers",
    sub: "Linux / Windows · physical + VM",
    icon: "ap", src: "zbx", status: "high",
    href: "zabbix.php?action=tcs.servers.view",
    total: 17, ok: 14, warn: 2, err: 1, problems: 6,
    kpis: [
      { label: "Servers up",    value: "16 / 17",       note: "1 down (db replica)" },
      { label: "CPU avg",       value: "42", unit: "%", note: "peak 71% (zbx-db-01)" },
      { label: "Disk pressure", value: "3",             note: "vols >80% used" },
    ],
    spark: [28,30,32,35,38,40,42,45,48,52,55,58,60,58,55,52,48,45,43,42,42,42,42,42],
    sparkColor: "var(--zbx)", sparkLabel: "Avg CPU % · 24h",
    top: "infra-zbx-db-01 disk /var/lib > 88% · 2 hosts under disk pressure",
  },
  {
    id: "nvr",
    label: "Surveillance · Milestone",
    sub: "XProtect 2024 R2 · 6 recorders",
    icon: "shield", src: "ext", status: "high",
    href: "zabbix.php?action=tcs.surveillance.view",
    total: 1147, ok: 1098, warn: 38, err: 11, problems: 18,
    kpis: [
      { label: "Cameras online",   value: "1,098 / 1,147", note: "49 unreachable" },
      { label: "Recording health", value: "94", unit: "%", note: "11 cams lagging" },
      { label: "Storage used",     value: "78", unit: "%", note: "rec-04 at 92%" },
    ],
    spark: [1110,1112,1115,1108,1100,1095,1098,1102,1104,1100,1098,1096,1094,1092,1090,1095,1098,1100,1098,1097,1098,1098,1098,1098],
    sparkColor: "var(--ext)", sparkLabel: "Cameras online · 24h",
    top: "11 cameras unreachable at Central Elem · 2 RAID rebuilds on rec-04",
  },
];

// Top active triggers — what an operator sees at the very top of the problem list
const GLOBAL_TRIGGERS = [
  { sev: "disaster", age: "00:04:11", host: "CRS-CORE-01",         site: "CRS", domain: "switches", source: "zbx", trigger: "Stack member offline (slot 2)", ack: false },
  { sev: "disaster", age: "00:06:42", host: "CRS-DIST-01",         site: "CRS", domain: "switches", source: "zbx", trigger: "Uplink to TCS-CO down (Te1/49)",   ack: false },
  { sev: "high",     age: "00:11:08", host: "infra-zbx-db-01",     site: "TDC", domain: "servers",  source: "zbx", trigger: "Disk /var/lib > 88% (delta +12%/24h)", ack: true },
  { sev: "high",     age: "00:14:33", host: "BHS-23-Cafe",         site: "BHS", domain: "wireless", source: "zbx", trigger: "AP lost LAN connectivity",            ack: false },
  { sev: "high",     age: "00:18:51", host: "nvr-rec-04",          site: "TDC", domain: "nvr",      source: "zbx", trigger: "Recording lag > 4s on 11 cameras",    ack: false },
  { sev: "high",     age: "00:22:14", host: "TCS-CO-CORE-01",      site: "TCS", domain: "switches", source: "zbx", trigger: "PSU2 failed — running on PSU1 only",  ack: true },
  { sev: "high",     age: "00:31:02", host: "pf-srv-01",           site: "TDC", domain: "servers",  source: "pf",  trigger: "PacketFence radius queue > 200",      ack: false },
  { sev: "warning",  age: "00:42:18", host: "BHS-56-Hallway",      site: "BHS", domain: "wireless", source: "zbx", trigger: "5 GHz utilization > 75% (sustained)", ack: false },
  { sev: "warning",  age: "00:48:09", host: "CHS-LIB-AP-12",       site: "CHS", domain: "wireless", source: "zbx", trigger: "Client roam failure rate > 4%",       ack: false },
  { sev: "warning",  age: "01:03:55", host: "NRH-ACC-04",          site: "NRH", domain: "switches", source: "zbx", trigger: "PoE budget > 92% (Gi1/0/24)",         ack: false },
  { sev: "warning",  age: "01:14:21", host: "infra-pf-mariadb",    site: "TDC", domain: "servers",  source: "pf",  trigger: "Replication lag > 30s",               ack: true },
  { sev: "warning",  age: "01:22:47", host: "BHS-CAM-N-014",       site: "BHS", domain: "nvr",      source: "zbx", trigger: "Camera reboot loop (3 in 10m)",       ack: false },
  { sev: "info",     age: "01:38:02", host: "PHS-AP-Lib-03",       site: "PHS", domain: "wireless", source: "ext", trigger: "Firmware out of date (32.7.0.5)",     ack: false },
  { sev: "info",     age: "02:04:31", host: "WMS-ACC-12",          site: "WMS", domain: "switches", source: "zbx", trigger: "SFP receive power low (-22.4 dBm)",   ack: true },
];

// Recent events stream — wider than just unresolved triggers, includes resolutions
const GLOBAL_EVENTS = [
  { ts: "10:14:22", source: "zbx", host: "BHS-23-Cafe",     msg: "Trigger:",     obj: "AP lost LAN connectivity", sev: "high" },
  { ts: "10:13:48", source: "pf",  host: "F4:5C:89:0B:32:71", msg: "Quarantined:", obj: "policy violation (rogue DHCP)", sev: "warning" },
  { ts: "10:11:02", source: "zbx", host: "infra-zbx-db-01", msg: "Trigger:",     obj: "Disk /var/lib > 88%", sev: "high" },
  { ts: "10:09:51", source: "zbx", host: "TCS-CO-CORE-01",  msg: "Resolved:",    obj: "PSU2 voltage out of range", sev: "ok" },
  { ts: "10:08:13", source: "ext", host: "PHS-AP-Lib-03",   msg: "Drift:",       obj: "firmware 32.7.0.5 → 32.7.0.7 available", sev: "info" },
  { ts: "10:06:42", source: "zbx", host: "CRS-DIST-01",     msg: "Trigger:",     obj: "Uplink to TCS-CO down (Te1/49)", sev: "disaster" },
  { ts: "10:04:11", source: "zbx", host: "CRS-CORE-01",     msg: "Trigger:",     obj: "Stack member offline (slot 2)", sev: "disaster" },
  { ts: "10:03:08", source: "pf",  host: "k.davis@tcs",     msg: "Auth:",        obj: "EAP-TLS success on BHS-56-Hallway", sev: "ok" },
  { ts: "10:01:54", source: "zbx", host: "BHS-CAM-N-014",   msg: "Trigger:",     obj: "Camera reboot loop (3 in 10m)", sev: "warning" },
  { ts: "09:58:33", source: "zbx", host: "NRH-ACC-04",      msg: "Resolved:",    obj: "Client count anomaly", sev: "ok" },
  { ts: "09:55:21", source: "pf",  host: "guest-staff-iPad",msg: "Onboard:",     obj: "BYOD provisioning OK (VLAN 50)", sev: "ok" },
  { ts: "09:52:09", source: "zbx", host: "nvr-rec-04",      msg: "Trigger:",     obj: "Recording lag > 4s on 11 cameras", sev: "high" },
];

// 24h timeline of new problems opened — used for the trend strip at the top
const PROBLEM_TIMELINE = [
  3,4,2,3,5,4,6,8,11,14,18,21,19,17,16,15,17,19,22,24,28,34,41,47,
];

window.GLOBAL_TOTALS = GLOBAL_TOTALS;
window.GLOBAL_SITES = GLOBAL_SITES;
window.GLOBAL_DOMAINS = GLOBAL_DOMAINS;
window.GLOBAL_TRIGGERS = GLOBAL_TRIGGERS;
window.GLOBAL_EVENTS = GLOBAL_EVENTS;
window.PROBLEM_TIMELINE = PROBLEM_TIMELINE;
