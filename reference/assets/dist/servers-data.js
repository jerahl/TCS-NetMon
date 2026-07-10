// Server fleet data — physical + virtual hosts under Zabbix monitoring

window.SERVER_SITES = [{
  id: "dc-arc",
  name: "Arcadia Data Closet",
  expanded: true,
  problems: 1,
  servers: [{
    id: "arc-dc01",
    fqdn: "arc-dc01.tcs.local",
    ip: "10.24.0.10",
    role: "Domain Controller",
    os: "Win Server 2022",
    model: "Dell R650",
    cores: 16,
    ram: 64,
    diskTb: 1.92,
    cpu: 18,
    mem: 42,
    diskPct: 31,
    netMbps: 24,
    uptimeDays: 142,
    status: "ok",
    problems: 0,
    kind: "phys"
  }, {
    id: "arc-file01",
    fqdn: "arc-file01.tcs.local",
    ip: "10.24.0.12",
    role: "File Server",
    os: "Win Server 2022",
    model: "Dell R750xs",
    cores: 24,
    ram: 128,
    diskTb: 24,
    cpu: 31,
    mem: 58,
    diskPct: 67,
    netMbps: 412,
    uptimeDays: 88,
    status: "ok",
    problems: 0,
    kind: "phys"
  }, {
    id: "arc-print01",
    fqdn: "arc-print01.tcs.local",
    ip: "10.24.0.14",
    role: "Print Server",
    os: "Win Server 2019",
    model: "VM (vSphere)",
    cores: 4,
    ram: 16,
    diskTb: 0.5,
    cpu: 9,
    mem: 33,
    diskPct: 22,
    netMbps: 6,
    uptimeDays: 211,
    status: "ok",
    problems: 0,
    kind: "vm"
  }, {
    id: "arc-app01",
    fqdn: "arc-app01.tcs.local",
    ip: "10.24.0.18",
    role: "Skyward SIS App",
    os: "Win Server 2022",
    model: "VM (vSphere)",
    cores: 8,
    ram: 32,
    diskTb: 2,
    cpu: 47,
    mem: 71,
    diskPct: 54,
    netMbps: 88,
    uptimeDays: 46,
    status: "warn",
    problems: 1,
    kind: "vm"
  }, {
    id: "arc-sql01",
    fqdn: "arc-sql01.tcs.local",
    ip: "10.24.0.20",
    role: "MS SQL 2022",
    os: "Win Server 2022",
    model: "Dell R750",
    cores: 32,
    ram: 256,
    diskTb: 8,
    cpu: 38,
    mem: 78,
    diskPct: 61,
    netMbps: 142,
    uptimeDays: 46,
    status: "ok",
    problems: 0,
    kind: "phys",
    selected: true
  }, {
    id: "arc-esxi01",
    fqdn: "arc-esxi01.tcs.local",
    ip: "10.24.0.30",
    role: "vSphere Host",
    os: "ESXi 8.0 U2",
    model: "Dell R650",
    cores: 32,
    ram: 384,
    diskTb: 3.84,
    cpu: 41,
    mem: 64,
    diskPct: 38,
    netMbps: 612,
    uptimeDays: 92,
    status: "ok",
    problems: 0,
    kind: "phys"
  }, {
    id: "arc-esxi02",
    fqdn: "arc-esxi02.tcs.local",
    ip: "10.24.0.31",
    role: "vSphere Host",
    os: "ESXi 8.0 U2",
    model: "Dell R650",
    cores: 32,
    ram: 384,
    diskTb: 3.84,
    cpu: 33,
    mem: 51,
    diskPct: 38,
    netMbps: 488,
    uptimeDays: 92,
    status: "ok",
    problems: 0,
    kind: "phys"
  }]
}, {
  id: "dc-bhs",
  name: "Bryant High MDF",
  expanded: true,
  problems: 2,
  servers: [{
    id: "bhs-dc02",
    fqdn: "bhs-dc02.tcs.local",
    ip: "10.30.0.10",
    role: "Domain Controller",
    os: "Win Server 2022",
    model: "HPE DL360 G11",
    cores: 16,
    ram: 64,
    diskTb: 1.92,
    cpu: 21,
    mem: 47,
    diskPct: 28,
    netMbps: 31,
    uptimeDays: 211,
    status: "ok",
    problems: 0,
    kind: "phys"
  }, {
    id: "bhs-vault",
    fqdn: "bhs-vault.tcs.local",
    ip: "10.30.0.22",
    role: "Milestone Recorder",
    os: "Win Server 2022",
    model: "HPE DL380 G11",
    cores: 24,
    ram: 128,
    diskTb: 96,
    cpu: 62,
    mem: 81,
    diskPct: 73,
    netMbps: 1240,
    uptimeDays: 18,
    status: "warn",
    problems: 1,
    kind: "phys"
  }, {
    id: "bhs-papercut",
    fqdn: "bhs-papercut.tcs.local",
    ip: "10.30.0.24",
    role: "PaperCut",
    os: "Ubuntu 22.04",
    model: "VM (Proxmox)",
    cores: 4,
    ram: 8,
    diskTb: 0.25,
    cpu: 6,
    mem: 38,
    diskPct: 19,
    netMbps: 3,
    uptimeDays: 304,
    status: "ok",
    problems: 0,
    kind: "vm"
  }, {
    id: "bhs-pf01",
    fqdn: "bhs-pf01.tcs.local",
    ip: "10.30.0.40",
    role: "PacketFence",
    os: "Rocky Linux 9",
    model: "VM (Proxmox)",
    cores: 8,
    ram: 32,
    diskTb: 1,
    cpu: 24,
    mem: 51,
    diskPct: 41,
    netMbps: 44,
    uptimeDays: 62,
    status: "err",
    problems: 2,
    kind: "vm"
  }]
}, {
  id: "dc-chs",
  name: "Central High MDF",
  expanded: false,
  problems: 0,
  servers: [{
    id: "chs-dc03",
    fqdn: "chs-dc03.tcs.local",
    ip: "10.40.0.10",
    role: "Domain Controller",
    os: "Win Server 2022",
    model: "HPE DL360 G11",
    cores: 16,
    ram: 64,
    diskTb: 1.92,
    cpu: 14,
    mem: 39,
    diskPct: 24,
    netMbps: 18,
    uptimeDays: 188,
    status: "ok",
    problems: 0,
    kind: "phys"
  }, {
    id: "chs-vault",
    fqdn: "chs-vault.tcs.local",
    ip: "10.40.0.22",
    role: "Milestone Recorder",
    os: "Win Server 2022",
    model: "HPE DL380 G11",
    cores: 24,
    ram: 128,
    diskTb: 96,
    cpu: 51,
    mem: 73,
    diskPct: 64,
    netMbps: 980,
    uptimeDays: 31,
    status: "ok",
    problems: 0,
    kind: "phys"
  }]
}, {
  id: "dc-tcs",
  name: "TCS Central Office",
  expanded: false,
  problems: 0,
  servers: [{
    id: "tcs-zbx01",
    fqdn: "tcs-zbx01.tcs.local",
    ip: "10.10.0.5",
    role: "Zabbix Server",
    os: "Rocky Linux 9",
    model: "VM (Proxmox)",
    cores: 16,
    ram: 64,
    diskTb: 4,
    cpu: 22,
    mem: 49,
    diskPct: 51,
    netMbps: 72,
    uptimeDays: 144,
    status: "ok",
    problems: 0,
    kind: "vm"
  }, {
    id: "tcs-zbxprx",
    fqdn: "tcs-zbxprx.tcs.local",
    ip: "10.10.0.6",
    role: "Zabbix Proxy",
    os: "Rocky Linux 9",
    model: "VM (Proxmox)",
    cores: 4,
    ram: 16,
    diskTb: 0.5,
    cpu: 11,
    mem: 27,
    diskPct: 18,
    netMbps: 18,
    uptimeDays: 144,
    status: "ok",
    problems: 0,
    kind: "vm"
  }, {
    id: "tcs-bkup01",
    fqdn: "tcs-bkup01.tcs.local",
    ip: "10.10.0.10",
    role: "Veeam Repository",
    os: "Win Server 2022",
    model: "Dell R750xs",
    cores: 16,
    ram: 64,
    diskTb: 192,
    cpu: 9,
    mem: 31,
    diskPct: 78,
    netMbps: 322,
    uptimeDays: 77,
    status: "ok",
    problems: 0,
    kind: "phys"
  }, {
    id: "tcs-mdm",
    fqdn: "tcs-mdm.tcs.local",
    ip: "10.10.0.14",
    role: "Jamf Pro / MDM",
    os: "Ubuntu 22.04",
    model: "VM (Proxmox)",
    cores: 8,
    ram: 32,
    diskTb: 2,
    cpu: 19,
    mem: 44,
    diskPct: 36,
    netMbps: 28,
    uptimeDays: 144,
    status: "ok",
    problems: 0,
    kind: "vm"
  }]
}];

// Active server detail — arc-sql01
window.ACTIVE_SERVER_HISTORY = {
  cpu1m: [22, 21, 24, 25, 28, 31, 34, 38, 41, 44, 46, 42, 38, 36, 33, 31, 30, 32, 35, 38, 40, 38, 36, 38],
  cpu5m: [25, 24, 25, 26, 28, 30, 33, 36, 38, 40, 42, 40, 38, 36, 34, 32, 31, 32, 34, 36, 37, 36, 35, 36],
  memUsed: [62, 62, 63, 64, 65, 66, 68, 71, 73, 75, 77, 78, 78, 77, 76, 75, 75, 76, 77, 77, 78, 78, 77, 78],
  diskRead: [12, 14, 18, 22, 30, 42, 68, 88, 110, 140, 162, 180, 170, 142, 118, 98, 82, 68, 54, 42, 32, 28, 22, 18],
  diskWrite: [8, 9, 10, 12, 18, 28, 42, 58, 72, 88, 98, 108, 102, 86, 72, 58, 48, 38, 30, 22, 18, 14, 12, 10],
  netIn: [110, 112, 120, 128, 138, 150, 170, 194, 210, 222, 234, 228, 210, 188, 168, 148, 132, 118, 108, 102, 98, 96, 94, 92],
  netOut: [62, 64, 68, 72, 78, 86, 98, 108, 118, 124, 128, 124, 116, 104, 92, 82, 72, 64, 58, 52, 50, 48, 46, 44],
  swap: [0, 0, 0, 0, 0, 0, 0, 0, 0.1, 0.4, 1.1, 1.8, 2.2, 1.9, 1.4, 0.8, 0.4, 0.2, 0, 0, 0, 0, 0, 0],
  load1m: [0.6, 0.6, 0.7, 0.8, 0.9, 1.1, 1.3, 1.6, 1.9, 2.2, 2.5, 2.3, 2.0, 1.7, 1.5, 1.3, 1.2, 1.3, 1.4, 1.5, 1.5, 1.4, 1.3, 1.4]
};

// Filesystem mounts for active server
window.ACTIVE_SERVER_FS = [{
  mount: "C:\\",
  fs: "NTFS",
  sizeGb: 200,
  usedPct: 38,
  freeGb: 124,
  latMs: 0.4,
  status: "ok"
}, {
  mount: "D:\\SQLData",
  fs: "NTFS",
  sizeGb: 4096,
  usedPct: 64,
  freeGb: 1474,
  latMs: 1.2,
  status: "ok"
}, {
  mount: "E:\\SQLLogs",
  fs: "NTFS",
  sizeGb: 512,
  usedPct: 41,
  freeGb: 302,
  latMs: 0.6,
  status: "ok"
}, {
  mount: "F:\\TempDB",
  fs: "NTFS",
  sizeGb: 256,
  usedPct: 12,
  freeGb: 225,
  latMs: 0.3,
  status: "ok"
}, {
  mount: "G:\\Backups",
  fs: "NTFS",
  sizeGb: 8192,
  usedPct: 88,
  freeGb: 983,
  latMs: 2.1,
  status: "warn"
}];

// Service / process checks (Zabbix item state)
window.ACTIVE_SERVER_SERVICES = [{
  name: "MSSQLSERVER",
  state: "running",
  auto: true,
  pid: 4128,
  cpu: 22.1,
  mem: 18.4,
  since: "2026-03-24 09:14",
  check: "service.info[MSSQLSERVER]"
}, {
  name: "SQLAgent$MSSQLSERVER",
  state: "running",
  auto: true,
  pid: 4180,
  cpu: 1.4,
  mem: 2.1,
  since: "2026-03-24 09:14",
  check: "service.info[SQLAgent]"
}, {
  name: "MSDTC",
  state: "running",
  auto: true,
  pid: 812,
  cpu: 0.0,
  mem: 0.3,
  since: "2026-03-24 09:09",
  check: "service.info[MSDTC]"
}, {
  name: "Veeam Backup VSS",
  state: "running",
  auto: true,
  pid: 1240,
  cpu: 0.1,
  mem: 0.4,
  since: "2026-03-24 09:11",
  check: "service.info[VeeamVssSupport]"
}, {
  name: "WinRM",
  state: "running",
  auto: true,
  pid: 748,
  cpu: 0.0,
  mem: 0.2,
  since: "2026-03-24 09:08",
  check: "service.info[WinRM]"
}, {
  name: "ZabbixAgent2",
  state: "running",
  auto: true,
  pid: 2104,
  cpu: 0.2,
  mem: 0.6,
  since: "2026-03-24 09:09",
  check: "agent.ping"
}, {
  name: "SNMP Trap",
  state: "stopped",
  auto: false,
  pid: null,
  cpu: 0.0,
  mem: 0.0,
  since: "—",
  check: "service.info[SNMPTRAP]"
}, {
  name: "Print Spooler",
  state: "running",
  auto: true,
  pid: 1932,
  cpu: 0.0,
  mem: 0.3,
  since: "2026-03-24 09:09",
  check: "service.info[Spooler]"
}];

// Logged-in / SQL sessions
window.ACTIVE_SERVER_SESSIONS = [{
  user: "skyward_svc",
  src: "10.24.0.18",
  type: "TDS",
  db: "Skyward_Prod",
  start: "07:14",
  state: "RUNNING",
  waits: "PAGEIOLATCH_SH"
}, {
  user: "skyward_svc",
  src: "10.24.0.18",
  type: "TDS",
  db: "Skyward_Prod",
  start: "07:14",
  state: "SLEEPING",
  waits: "—"
}, {
  user: "papercut_svc",
  src: "10.30.0.24",
  type: "TDS",
  db: "PaperCut",
  start: "06:32",
  state: "RUNNING",
  waits: "—"
}, {
  user: "tcs\\dba.k",
  src: "10.10.4.21",
  type: "RDP",
  db: "—",
  start: "Yesterday 16:02",
  state: "ACTIVE",
  waits: "—"
}, {
  user: "ZabbixAgent2",
  src: "127.0.0.1",
  type: "Local",
  db: "master",
  start: "—",
  state: "RUNNING",
  waits: "—"
}];

// Recent triggers / problems for fleet
window.SERVER_PROBLEMS = [{
  ts: "07:42:11",
  sev: "high",
  host: "bhs-pf01",
  trig: "PacketFence radiusd: process not running",
  age: "00:18",
  ack: false
}, {
  ts: "07:38:42",
  sev: "high",
  host: "bhs-pf01",
  trig: "MariaDB replication lag > 30s",
  age: "00:21",
  ack: false
}, {
  ts: "07:11:09",
  sev: "warning",
  host: "bhs-vault",
  trig: "Disk D:\\Recordings free space < 25%",
  age: "00:48",
  ack: false
}, {
  ts: "06:48:33",
  sev: "warning",
  host: "arc-app01",
  trig: "Memory utilization > 70% for 5m",
  age: "01:11",
  ack: true
}, {
  ts: "Yesterday",
  sev: "info",
  host: "arc-sql01",
  trig: "SQL Agent job 'Index Maintenance' completed",
  age: "14:22",
  ack: true
}, {
  ts: "Yesterday",
  sev: "warning",
  host: "arc-sql01",
  trig: "G:\\Backups free space < 15%",
  age: "16:01",
  ack: true
}];

// Top processes for active server
window.ACTIVE_SERVER_PROCS = [{
  name: "sqlservr.exe",
  user: "NT SERVICE\\MSSQL",
  cpu: 22.1,
  mem: 184.2,
  threads: 84,
  pid: 4128
}, {
  name: "ReportingServices.exe",
  user: "NT SERVICE\\SSRS",
  cpu: 4.8,
  mem: 46.1,
  threads: 22,
  pid: 6204
}, {
  name: "MsMpEng.exe",
  user: "SYSTEM",
  cpu: 3.4,
  mem: 28.5,
  threads: 18,
  pid: 524
}, {
  name: "zabbix_agent2.exe",
  user: "SYSTEM",
  cpu: 0.4,
  mem: 8.4,
  threads: 9,
  pid: 2104
}, {
  name: "veeamagent.exe",
  user: "SYSTEM",
  cpu: 0.3,
  mem: 12.1,
  threads: 6,
  pid: 1240
}, {
  name: "explorer.exe",
  user: "tcs\\dba.k",
  cpu: 0.2,
  mem: 44.8,
  threads: 32,
  pid: 9012
}];

// Network interfaces
window.ACTIVE_SERVER_IFACES = [{
  name: "Mgmt 0",
  speed: 10000,
  ip: "10.24.0.20",
  mac: "B0:7B:25:14:A9:01",
  inMbps: 142,
  outMbps: 38,
  errs: 0,
  status: "up"
}, {
  name: "iSCSI A",
  speed: 25000,
  ip: "10.24.50.20",
  mac: "B0:7B:25:14:A9:02",
  inMbps: 612,
  outMbps: 88,
  errs: 0,
  status: "up"
}, {
  name: "iSCSI B",
  speed: 25000,
  ip: "10.24.51.20",
  mac: "B0:7B:25:14:A9:03",
  inMbps: 588,
  outMbps: 92,
  errs: 0,
  status: "up"
}, {
  name: "iDRAC",
  speed: 1000,
  ip: "10.24.99.20",
  mac: "B0:7B:25:14:A9:00",
  inMbps: 0.4,
  outMbps: 0.2,
  errs: 0,
  status: "up"
}];