// Cortex XDR — TCS Security tenant. Mock data shaped after a real EDR/XDR
// console: tenant + agent inventory, MITRE ATT&CK coverage, active incidents
// with kill-chain steps, risky users/hosts, detection sources, hunts, events.

const XDR_TENANT = {
  name: "tcs-secops",
  region: "us-central-1",
  tenantId: "91A8-7C44-DE12",
  console: "tcs-secops.xdr.local",
  lastSync: "12 s ago",
  retentionDays: 365,
  agentsDeployed: 12847,
  agentsTotal: 13218,
  policyVersion: "AlwaysOn-v18.2",
  contentPack: "CP-2026.05.16",
  uptime: "127 d 04:18"
};

// 6 KPI tiles
const XDR_KPI = {
  incidents: {
    open: 23,
    critical: 4,
    high: 7,
    med: 9,
    low: 3,
    new24h: 6
  },
  alerts24h: {
    total: 1842,
    suppressed: 1390,
    investigated: 408,
    promoted: 44
  },
  agents: {
    healthy: 12_511,
    degraded: 218,
    disconnected: 78,
    outdated: 40,
    covered_pct: 97.2
  },
  mttd: {
    value: 4.8,
    unit: "min",
    trend: -1.2
  },
  // mean time to detect (24h)
  mttr: {
    value: 38,
    unit: "min",
    trend: -7
  },
  // mean time to respond
  coverage: {
    pct: 84.5,
    mitreTactics: 12,
    covered: 144,
    total: 207
  },
  isolated: {
    hosts: 3,
    accounts: 2
  }
};

// 7-day incident severity breakdown (one entry per day, oldest → newest)
const XDR_INC_7D = [{
  d: "Sat",
  crit: 1,
  high: 3,
  med: 6,
  low: 5
}, {
  d: "Sun",
  crit: 0,
  high: 2,
  med: 4,
  low: 7
}, {
  d: "Mon",
  crit: 2,
  high: 5,
  med: 8,
  low: 6
}, {
  d: "Tue",
  crit: 1,
  high: 4,
  med: 7,
  low: 4
}, {
  d: "Wed",
  crit: 3,
  high: 6,
  med: 10,
  low: 8
}, {
  d: "Thu",
  crit: 2,
  high: 7,
  med: 9,
  low: 6
}, {
  d: "Fri",
  crit: 4,
  high: 7,
  med: 9,
  low: 3
}];

// Featured active incident — used for the kill-chain timeline
const XDR_ACTIVE_INC = {
  id: "INC-2026-0418",
  title: "Suspected credential-theft → lateral movement · Bryant HS staff segment",
  sev: "high",
  status: "Investigating",
  opened: "2026-05-16 08:42",
  age: "2 h 14 m",
  assignee: "k.rodriguez@tcs.k12",
  hosts: ["bhs-lib-pc-04", "bhs-staff-laptop-22", "bhs-staff-laptop-09"],
  users: ["jharris@tcs.k12", "svc_sccm"],
  score: 87,
  // 0-100 risk score
  alertsLinked: 14,
  techniques: 6,
  kill: [{
    ts: "08:41:08",
    tactic: "Initial Access",
    tid: "T1566.001",
    name: "Phishing: Spearphishing attachment",
    detail: "Macro-enabled .docm opened from staff inbox",
    host: "bhs-lib-pc-04",
    sev: "high"
  }, {
    ts: "08:42:22",
    tactic: "Execution",
    tid: "T1059.001",
    name: "PowerShell encoded command",
    detail: "powershell.exe -enc JABzAD0AJwBoAHQAdABwAHMAOg…",
    host: "bhs-lib-pc-04",
    sev: "high"
  }, {
    ts: "08:43:50",
    tactic: "Defense Evasion",
    tid: "T1218.011",
    name: "Rundll32 LOLBin abuse",
    detail: "rundll32 url.dll,FileProtocolHandler → suspicious payload",
    host: "bhs-lib-pc-04",
    sev: "medium"
  }, {
    ts: "08:51:14",
    tactic: "Credential Access",
    tid: "T1003.001",
    name: "LSASS memory access",
    detail: "Read handle on lsass.exe by unknown process",
    host: "bhs-staff-laptop-22",
    sev: "critical"
  }, {
    ts: "09:06:33",
    tactic: "Discovery",
    tid: "T1018",
    name: "Remote system discovery",
    detail: "Burst of SMB enumeration to 122 hosts (10.40.0.0/22)",
    host: "bhs-staff-laptop-22",
    sev: "medium"
  }, {
    ts: "10:42:01",
    tactic: "Lateral Movement",
    tid: "T1021.002",
    name: "SMB/Windows admin shares",
    detail: "Auth as svc_sccm to 3 hosts within 38 s",
    host: "bhs-staff-laptop-09",
    sev: "high"
  }],
  actions: [{
    ts: "10:43:14",
    actor: "auto-iso",
    what: "Isolated bhs-staff-laptop-22 (network containment)"
  }, {
    ts: "10:44:02",
    actor: "auto-iso",
    what: "Isolated bhs-staff-laptop-09"
  }, {
    ts: "10:45:21",
    actor: "k.rodriguez",
    what: "Revoked Kerberos TGT for jharris@tcs.k12"
  }, {
    ts: "10:46:09",
    actor: "playbook",
    what: "Triggered AD password reset · MFA re-enroll required"
  }]
};

// MITRE ATT&CK heatmap — 12 enterprise tactics, ~5 techniques per column.
// hits = count last 7d; cov = coverage class (none/partial/full)
const XDR_MITRE = [{
  tactic: "Initial Access",
  techs: [{
    id: "T1566",
    n: "Phishing",
    hits: 142,
    cov: "full"
  }, {
    id: "T1190",
    n: "Exploit Public-Facing",
    hits: 8,
    cov: "full"
  }, {
    id: "T1078",
    n: "Valid Accounts",
    hits: 41,
    cov: "partial"
  }, {
    id: "T1133",
    n: "External Remote Svcs",
    hits: 3,
    cov: "full"
  }, {
    id: "T1200",
    n: "Hardware Additions",
    hits: 0,
    cov: "none"
  }]
}, {
  tactic: "Execution",
  techs: [{
    id: "T1059",
    n: "Cmd/Script Interpreter",
    hits: 88,
    cov: "full"
  }, {
    id: "T1204",
    n: "User Execution",
    hits: 56,
    cov: "full"
  }, {
    id: "T1053",
    n: "Scheduled Task/Job",
    hits: 12,
    cov: "full"
  }, {
    id: "T1569",
    n: "System Services",
    hits: 4,
    cov: "partial"
  }, {
    id: "T1106",
    n: "Native API",
    hits: 9,
    cov: "partial"
  }]
}, {
  tactic: "Persistence",
  techs: [{
    id: "T1547",
    n: "Boot/Logon Autostart",
    hits: 22,
    cov: "full"
  }, {
    id: "T1543",
    n: "Create/Mod Sys Process",
    hits: 11,
    cov: "full"
  }, {
    id: "T1136",
    n: "Create Account",
    hits: 3,
    cov: "partial"
  }, {
    id: "T1505",
    n: "Server Software Comp.",
    hits: 1,
    cov: "partial"
  }, {
    id: "T1098",
    n: "Account Manipulation",
    hits: 7,
    cov: "full"
  }]
}, {
  tactic: "Priv Escalation",
  techs: [{
    id: "T1068",
    n: "Exploit for Priv Esc",
    hits: 6,
    cov: "partial"
  }, {
    id: "T1055",
    n: "Process Injection",
    hits: 19,
    cov: "full"
  }, {
    id: "T1134",
    n: "Access Token Manip.",
    hits: 4,
    cov: "partial"
  }, {
    id: "T1484",
    n: "Domain Policy Mod.",
    hits: 0,
    cov: "partial"
  }, {
    id: "T1548",
    n: "Abuse Elevation Ctrl",
    hits: 8,
    cov: "full"
  }]
}, {
  tactic: "Defense Evasion",
  techs: [{
    id: "T1027",
    n: "Obfuscated Files",
    hits: 31,
    cov: "full"
  }, {
    id: "T1070",
    n: "Indicator Removal",
    hits: 7,
    cov: "full"
  }, {
    id: "T1218",
    n: "System Binary Proxy",
    hits: 24,
    cov: "full"
  }, {
    id: "T1036",
    n: "Masquerading",
    hits: 18,
    cov: "partial"
  }, {
    id: "T1112",
    n: "Modify Registry",
    hits: 15,
    cov: "full"
  }]
}, {
  tactic: "Credential Access",
  techs: [{
    id: "T1003",
    n: "OS Credential Dumping",
    hits: 5,
    cov: "full"
  }, {
    id: "T1110",
    n: "Brute Force",
    hits: 47,
    cov: "full"
  }, {
    id: "T1555",
    n: "Creds from Stores",
    hits: 8,
    cov: "partial"
  }, {
    id: "T1558",
    n: "Steal/Forge Kerberos",
    hits: 2,
    cov: "full"
  }, {
    id: "T1552",
    n: "Unsecured Credentials",
    hits: 13,
    cov: "partial"
  }]
}, {
  tactic: "Discovery",
  techs: [{
    id: "T1018",
    n: "Remote System Disc.",
    hits: 21,
    cov: "full"
  }, {
    id: "T1082",
    n: "System Info Disc.",
    hits: 64,
    cov: "partial"
  }, {
    id: "T1083",
    n: "File & Dir Disc.",
    hits: 39,
    cov: "partial"
  }, {
    id: "T1087",
    n: "Account Discovery",
    hits: 17,
    cov: "full"
  }, {
    id: "T1135",
    n: "Network Share Disc.",
    hits: 9,
    cov: "full"
  }]
}, {
  tactic: "Lateral Movement",
  techs: [{
    id: "T1021",
    n: "Remote Services",
    hits: 11,
    cov: "full"
  }, {
    id: "T1570",
    n: "Lateral Tool Transfer",
    hits: 4,
    cov: "full"
  }, {
    id: "T1534",
    n: "Internal Spearphish",
    hits: 1,
    cov: "partial"
  }, {
    id: "T1080",
    n: "Taint Shared Content",
    hits: 2,
    cov: "partial"
  }, {
    id: "T1550",
    n: "Use Alt. Auth Mat'l",
    hits: 3,
    cov: "partial"
  }]
}, {
  tactic: "Collection",
  techs: [{
    id: "T1005",
    n: "Data from Local Sys",
    hits: 12,
    cov: "partial"
  }, {
    id: "T1560",
    n: "Archive Collected",
    hits: 4,
    cov: "full"
  }, {
    id: "T1113",
    n: "Screen Capture",
    hits: 0,
    cov: "partial"
  }, {
    id: "T1056",
    n: "Input Capture",
    hits: 1,
    cov: "full"
  }, {
    id: "T1039",
    n: "Data from Net Share",
    hits: 6,
    cov: "partial"
  }]
}, {
  tactic: "Command & Control",
  techs: [{
    id: "T1071",
    n: "App Layer Protocol",
    hits: 28,
    cov: "full"
  }, {
    id: "T1573",
    n: "Encrypted Channel",
    hits: 19,
    cov: "partial"
  }, {
    id: "T1090",
    n: "Proxy",
    hits: 7,
    cov: "full"
  }, {
    id: "T1095",
    n: "Non-App Layer Proto",
    hits: 2,
    cov: "partial"
  }, {
    id: "T1568",
    n: "Dynamic Resolution",
    hits: 11,
    cov: "full"
  }]
}, {
  tactic: "Exfiltration",
  techs: [{
    id: "T1041",
    n: "Exfil over C2",
    hits: 3,
    cov: "full"
  }, {
    id: "T1567",
    n: "Exfil to Cloud Stor.",
    hits: 9,
    cov: "partial"
  }, {
    id: "T1048",
    n: "Exfil Alt Protocol",
    hits: 2,
    cov: "partial"
  }, {
    id: "T1029",
    n: "Scheduled Transfer",
    hits: 0,
    cov: "none"
  }, {
    id: "T1052",
    n: "Exfil over Phys Med",
    hits: 0,
    cov: "none"
  }]
}, {
  tactic: "Impact",
  techs: [{
    id: "T1486",
    n: "Data Encrypted (Ransom)",
    hits: 1,
    cov: "full"
  }, {
    id: "T1490",
    n: "Inhibit Sys Recovery",
    hits: 0,
    cov: "full"
  }, {
    id: "T1489",
    n: "Service Stop",
    hits: 5,
    cov: "partial"
  }, {
    id: "T1485",
    n: "Data Destruction",
    hits: 0,
    cov: "partial"
  }, {
    id: "T1491",
    n: "Defacement",
    hits: 0,
    cov: "none"
  }]
}];

// Detection sources — pie/bar breakdown of where alerts came from in 24h.
const XDR_SOURCES = [{
  id: "ep",
  label: "Endpoint EDR",
  count: 982,
  pct: 53.3,
  color: "var(--xdr)"
}, {
  id: "net",
  label: "Network analytics",
  count: 412,
  pct: 22.4,
  color: "var(--info)"
}, {
  id: "id",
  label: "Identity (AD/Azure)",
  count: 198,
  pct: 10.7,
  color: "var(--ok)"
}, {
  id: "mail",
  label: "Email gateway",
  count: 161,
  pct: 8.7,
  color: "var(--warn)"
}, {
  id: "cld",
  label: "Cloud / SaaS",
  count: 89,
  pct: 4.9,
  color: "var(--ext)"
}];

// Endpoint agent OS breakdown
const XDR_AGENTS_OS = [{
  os: "Windows 11",
  count: 7642,
  healthy: 7588,
  ver: "8.4.2"
}, {
  os: "Windows 10",
  count: 3104,
  healthy: 3071,
  ver: "8.4.2"
}, {
  os: "macOS 14",
  count: 1188,
  healthy: 1162,
  ver: "8.4.1"
}, {
  os: "ChromeOS",
  count: 612,
  healthy: 610,
  ver: "n/a (mgmt only)"
}, {
  os: "Server 2022",
  count: 218,
  healthy: 214,
  ver: "8.4.2"
}, {
  os: "Linux",
  count: 83,
  healthy: 76,
  ver: "8.3.9"
}];

// Top risky users
const XDR_TOP_USERS = [{
  user: "jharris@tcs.k12",
  role: "Faculty",
  score: 87,
  signals: ["LSASS access", "off-hours auth", "MFA failures × 4"],
  trend: +18,
  dept: "Bryant HS · Library"
}, {
  user: "svc_sccm",
  role: "Service",
  score: 74,
  signals: ["interactive logon", "lateral SMB"],
  trend: +24,
  dept: "Domain · IT"
}, {
  user: "mtucker@tcs.k12",
  role: "Faculty",
  score: 68,
  signals: ["password spray target", "unusual geo (KR)"],
  trend: +11,
  dept: "Central HS · Counselor"
}, {
  user: "kbrooks@tcs.k12",
  role: "Student",
  score: 54,
  signals: ["bypass attempt × 12", "Tor IP"],
  trend: -3,
  dept: "Northridge HS"
}, {
  user: "rmills@tcs.k12",
  role: "Admin",
  score: 51,
  signals: ["VPN from new device", "policy mod"],
  trend: +6,
  dept: "Central Office"
}, {
  user: "guest-onboarding",
  role: "Guest",
  score: 42,
  signals: ["AnyDesk install", "PowerShell from temp dir"],
  trend: +2,
  dept: "Field"
}];

// Top risky hosts
const XDR_TOP_HOSTS = [{
  host: "bhs-staff-laptop-22",
  os: "Win 11",
  score: 92,
  isolated: true,
  user: "jharris",
  alerts: 14,
  site: "Bryant HS"
}, {
  host: "bhs-staff-laptop-09",
  os: "Win 11",
  score: 81,
  isolated: true,
  user: "svc_sccm",
  alerts: 6,
  site: "Bryant HS"
}, {
  host: "bhs-lib-pc-04",
  os: "Win 10",
  score: 78,
  isolated: false,
  user: "library",
  alerts: 8,
  site: "Bryant HS"
}, {
  host: "chs-cnsl-mac-12",
  os: "macOS 14",
  score: 64,
  isolated: false,
  user: "mtucker",
  alerts: 4,
  site: "Central HS"
}, {
  host: "co-it-jump-01",
  os: "Srv 2022",
  score: 58,
  isolated: true,
  user: "—",
  alerts: 3,
  site: "Central Office"
}, {
  host: "nhs-cart24-cb-008",
  os: "ChromeOS",
  score: 41,
  isolated: false,
  user: "kbrooks",
  alerts: 2,
  site: "Northridge HS"
}];

// Top alerts (last 24h)
const XDR_TOP_ALERTS = [{
  id: "AL-91204",
  sig: "Suspicious LSASS handle access",
  mitre: "T1003.001",
  sev: "critical",
  host: "bhs-staff-laptop-22",
  user: "jharris",
  ago: "1 h ago",
  status: "Investigating"
}, {
  id: "AL-91198",
  sig: "Cobalt-Strike beacon C2 pattern",
  mitre: "T1071.001",
  sev: "critical",
  host: "bhs-staff-laptop-09",
  user: "svc_sccm",
  ago: "1 h ago",
  status: "Investigating"
}, {
  id: "AL-91186",
  sig: "Encoded PowerShell from Office macro",
  mitre: "T1059.001",
  sev: "high",
  host: "bhs-lib-pc-04",
  user: "library",
  ago: "2 h ago",
  status: "Triaged"
}, {
  id: "AL-91174",
  sig: "Burst SMB enumeration · 122 hosts",
  mitre: "T1018",
  sev: "high",
  host: "bhs-staff-laptop-22",
  user: "jharris",
  ago: "2 h ago",
  status: "Linked"
}, {
  id: "AL-91163",
  sig: "Kerberoasting · SPN ticket request",
  mitre: "T1558.003",
  sev: "high",
  host: "co-it-jump-01",
  user: "svc_sccm",
  ago: "3 h ago",
  status: "Linked"
}, {
  id: "AL-91142",
  sig: "OAuth consent grant to unverified app",
  mitre: "T1528",
  sev: "medium",
  host: "chs-cnsl-mac-12",
  user: "mtucker",
  ago: "4 h ago",
  status: "Auto-closed"
}, {
  id: "AL-91129",
  sig: "Impossible travel · TX → KR in 38 m",
  mitre: "T1078.004",
  sev: "medium",
  host: "—",
  user: "mtucker",
  ago: "5 h ago",
  status: "Investigating"
}, {
  id: "AL-91118",
  sig: "AnyDesk install · unmanaged tool",
  mitre: "T1219",
  sev: "medium",
  host: "nhs-cart24-cb-008",
  user: "kbrooks",
  ago: "6 h ago",
  status: "Triaged"
}, {
  id: "AL-91107",
  sig: "Defender real-time protection disabled",
  mitre: "T1562.001",
  sev: "high",
  host: "co-it-jump-01",
  user: "—",
  ago: "6 h ago",
  status: "Auto-closed"
}, {
  id: "AL-91094",
  sig: "BloodHound-style LDAP queries",
  mitre: "T1087.002",
  sev: "medium",
  host: "co-it-jump-01",
  user: "svc_sccm",
  ago: "7 h ago",
  status: "Linked"
}];

// Saved hunts / scheduled queries
const XDR_HUNTS = [{
  name: "LOLBin spawn-chains from Office",
  author: "k.rodriguez",
  schedule: "every 15 m",
  lastRun: "12 m ago",
  hits: 4,
  sev: "high",
  status: "running"
}, {
  name: "Kerberoasting · high-SPN-request rate",
  author: "platform",
  schedule: "every 1 h",
  lastRun: "38 m ago",
  hits: 1,
  sev: "high",
  status: "running"
}, {
  name: "Off-hours admin logons from new device",
  author: "k.rodriguez",
  schedule: "every 1 h",
  lastRun: "06 m ago",
  hits: 3,
  sev: "medium",
  status: "running"
}, {
  name: "DNS to newly-registered domains",
  author: "n.akel",
  schedule: "every 5 m",
  lastRun: "2 m ago",
  hits: 12,
  sev: "medium",
  status: "running"
}, {
  name: "ChromeOS USB exfil patterns",
  author: "n.akel",
  schedule: "every 30 m",
  lastRun: "18 m ago",
  hits: 0,
  sev: "low",
  status: "running"
}, {
  name: "BloodHound LDAP fingerprint",
  author: "platform",
  schedule: "every 15 m",
  lastRun: "07 m ago",
  hits: 2,
  sev: "high",
  status: "running"
}, {
  name: "macOS persistence · LaunchAgents diff",
  author: "k.rodriguez",
  schedule: "daily 03:00",
  lastRun: "5 h ago",
  hits: 0,
  sev: "low",
  status: "scheduled"
}];

// Recent XDR events (mixed: agent, detection, response)
const XDR_EVENTS = [{
  ts: "10:46:09",
  source: "xdr",
  host: "—",
  sev: "ok",
  msg: "Playbook · Reset AD password ",
  obj: "user jharris@tcs.k12 (PWD-RESET-AUTO)"
}, {
  ts: "10:45:21",
  source: "xdr",
  host: "ad-dc01.tcs.local",
  sev: "warning",
  msg: "Kerberos TGT revoked ",
  obj: "principal jharris@TCS.K12"
}, {
  ts: "10:44:02",
  source: "xdr",
  host: "bhs-staff-laptop-09",
  sev: "high",
  msg: "Host isolated · network containment ",
  obj: "INC-2026-0418"
}, {
  ts: "10:43:14",
  source: "xdr",
  host: "bhs-staff-laptop-22",
  sev: "high",
  msg: "Host isolated · network containment ",
  obj: "INC-2026-0418"
}, {
  ts: "10:42:01",
  source: "xdr",
  host: "bhs-staff-laptop-09",
  sev: "high",
  msg: "Lateral movement detected ",
  obj: "T1021.002 · SMB admin shares × 3"
}, {
  ts: "09:06:33",
  source: "xdr",
  host: "bhs-staff-laptop-22",
  sev: "warning",
  msg: "Discovery activity ",
  obj: "T1018 · SMB enumeration × 122 hosts"
}, {
  ts: "08:51:14",
  source: "xdr",
  host: "bhs-staff-laptop-22",
  sev: "disaster",
  msg: "LSASS handle access ",
  obj: "T1003.001 · unsigned process"
}, {
  ts: "08:43:50",
  source: "xdr",
  host: "bhs-lib-pc-04",
  sev: "warning",
  msg: "LOLBin abuse ",
  obj: "T1218.011 · rundll32 url.dll"
}, {
  ts: "08:42:22",
  source: "xdr",
  host: "bhs-lib-pc-04",
  sev: "high",
  msg: "Encoded PowerShell from Office ",
  obj: "T1059.001 · winword.exe → powershell.exe"
}, {
  ts: "08:41:08",
  source: "xdr",
  host: "bhs-lib-pc-04",
  sev: "high",
  msg: "Phishing attachment detonated ",
  obj: "T1566.001 · invoice-april.docm"
}, {
  ts: "08:14:55",
  source: "xdr",
  host: "nhs-cart24-cb-008",
  sev: "info",
  msg: "Unmanaged tool installed ",
  obj: "AnyDesk 7.1.13"
}, {
  ts: "07:22:09",
  source: "zbx",
  host: "ad-dc01.tcs.local",
  sev: "warning",
  msg: "Failed logons > 80 / min ",
  obj: "audit · multiple accounts"
}];

// Agent rollout / coverage 24h trend (for KPI sparkline)
const XDR_AGENTS_24H = [12_705, 12_712, 12_720, 12_734, 12_750, 12_768, 12_781, 12_790, 12_802, 12_815, 12_821, 12_829, 12_834, 12_838, 12_842, 12_843, 12_845, 12_846, 12_846, 12_846, 12_847, 12_847, 12_847, 12_847];

// Alert volume 24h sparkline
const XDR_ALERTS_24H = [42, 38, 35, 30, 24, 21, 26, 38, 64, 88, 102, 114, 121, 118, 109, 96, 87, 82, 79, 74, 88, 92, 78, 66];
window.XDR_TENANT = XDR_TENANT;
window.XDR_KPI = XDR_KPI;
window.XDR_INC_7D = XDR_INC_7D;
window.XDR_ACTIVE_INC = XDR_ACTIVE_INC;
window.XDR_MITRE = XDR_MITRE;
window.XDR_SOURCES = XDR_SOURCES;
window.XDR_AGENTS_OS = XDR_AGENTS_OS;
window.XDR_TOP_USERS = XDR_TOP_USERS;
window.XDR_TOP_HOSTS = XDR_TOP_HOSTS;
window.XDR_TOP_ALERTS = XDR_TOP_ALERTS;
window.XDR_HUNTS = XDR_HUNTS;
window.XDR_EVENTS = XDR_EVENTS;
window.XDR_AGENTS_24H = XDR_AGENTS_24H;
window.XDR_ALERTS_24H = XDR_ALERTS_24H;