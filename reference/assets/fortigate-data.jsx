// Synthetic FortiGate firewall data for the Zabbix-monitored dashboard.
// Notionally pulled from FortiOS REST API / SNMP (FORTINET-FORTIGATE-MIB) and
// joined against Zabbix host-level state. PacketFence supplies user identity
// for the SSL-VPN sessions where shown.

const FG_DEVICE = {
  host:       "fw-tcs-co-01",
  model:      "FortiGate 600F · cluster",
  serial:     "FG6H0FT121902847",
  fos:        "FortiOS 7.4.4 build 2662",
  uptime:     "67d 04h 12m",
  ha:         "Active-Active · group 12",
  mgmtIp:     "10.1.0.1",
  lastSync:   "8s ago",
  site:       "TCS Central Office · Datacenter Annex",
  serial2:    "FG6H0FT121902851",
};

const FG_TOTALS = {
  // Aggregate session and throughput counters as reported by FortiOS.
  sessions:    { active: 184_213, new_per_s: 4127, peak: 247_602, limit: 8_000_000 },
  throughput:  { total_gbps: 6.84, wan_in_gbps: 3.92, wan_out_gbps: 2.51, lan_gbps: 11.27, peak_gbps: 12.21 },
  cpu:         { now: 38, peak15m: 71, target: 70 },
  mem:         { now: 54, peak15m: 62, target: 80 },
  disk:        { now: 41, target: 75 },
  threats:     { ips_blocks_24h: 9_847, av_blocks_24h: 142, web_blocks_24h: 38_412, app_blocks_24h: 4_281 },
  vpn:         { ipsec_up: 14, ipsec_total: 16, ssl_users: 38, ssl_peak_24h: 96 },
  policies:    { total: 412, active: 387, unused_30d: 41 },
  fortiguard:  { ips: "OK", av: "OK", webfilter: "OK", appctrl: "OK", expiresDays: 412 },
};

// 24 hourly throughput samples (Gbps egress through WAN).
const FG_THROUGHPUT_24H = {
  egress:  [2.1,1.6,1.2,0.9,0.8,0.9,1.4,2.6,3.8,4.4,4.8,5.1,5.4,5.2,5.0,4.9,5.3,5.6,5.2,4.6,3.8,3.1,2.7,2.5],
  ingress: [3.1,2.4,1.8,1.3,1.1,1.3,2.0,3.6,5.2,6.1,6.6,7.0,7.4,7.1,6.9,6.8,7.2,7.6,7.1,6.3,5.2,4.3,3.8,3.5],
};

// 24h hourly sessions (active concurrent, thousands).
const FG_SESSIONS_24H = [
  64,58,52,48,46,48,62,98,128,148,162,171,179,184,182,180,184,188,182,168,148,124,102,84,
];
const FG_NEW_SESSIONS_24H = [
  1_120,940,780,620,560,640,1_180,2_640,3_810,4_120,4_310,4_460,4_580,4_490,4_410,4_320,4_510,4_640,4_380,3_910,3_080,2_310,1_780,1_410,
];

// HA cluster — Active/Active pair with health & sync state.
const FG_HA = {
  group: 12,
  mode: "Active-Active",
  members: [
    {
      host: "fw-tcs-co-01",
      role: "Primary",
      priority: 200,
      serial: "FG6H0FT121902847",
      uptime: "67d 04h",
      cpu: 38, mem: 54,
      sessions: 184_213,
      sync: "in-sync",
      vcluster1: "Primary",
      vcluster2: "Secondary",
      lastFail: "—",
    },
    {
      host: "fw-tcs-co-02",
      role: "Secondary",
      priority: 100,
      serial: "FG6H0FT121902851",
      uptime: "67d 04h",
      cpu: 21, mem: 47,
      sessions: 167_982,
      sync: "in-sync",
      vcluster1: "Secondary",
      vcluster2: "Primary",
      lastFail: "2025-12-04 03:11",
    },
  ],
  hbInterfaces: ["ha1 (port15)", "ha2 (port16)"],
  hbLatencyMs: 0.42,
  syncStatus: "checksum OK · 4,128 objects",
};

// Physical + virtual interfaces.
const FG_INTERFACES = [
  { id: "wan1",          role: "WAN · Spectrum",   speed: "10G",  up: true,  vlans: 4,  rx_mbps: 3920, tx_mbps: 2510, util: 49, errors: 0,    state: "ok"   },
  { id: "wan2",          role: "WAN · AT&T fiber", speed: "10G",  up: true,  vlans: 2,  rx_mbps: 1480, tx_mbps:  860, util: 18, errors: 0,    state: "ok"   },
  { id: "wan3",          role: "WAN · LTE backup", speed: "1G",   up: true,  vlans: 1,  rx_mbps:    2, tx_mbps:    1, util:  0, errors: 0,    state: "ok"   },
  { id: "lan-agg (x8)",  role: "LAN trunk",        speed: "80G",  up: true,  vlans: 24, rx_mbps: 7820, tx_mbps:11270, util: 23, errors: 0,    state: "ok"   },
  { id: "dmz1",          role: "DMZ / public",     speed: "10G",  up: true,  vlans: 3,  rx_mbps:  340, tx_mbps:  520, util:  8, errors: 0,    state: "ok"   },
  { id: "dmz2",          role: "DMZ / iot",        speed: "1G",   up: true,  vlans: 6,  rx_mbps:   42, tx_mbps:   18, util:  5, errors: 0,    state: "ok"   },
  { id: "voip",          role: "VoIP segment",     speed: "10G",  up: true,  vlans: 2,  rx_mbps:  118, tx_mbps:  112, util:  2, errors: 0,    state: "ok"   },
  { id: "guest",         role: "Guest captive",    speed: "10G",  up: true,  vlans: 1,  rx_mbps:  310, tx_mbps:  186, util:  4, errors: 12,   state: "info" },
  { id: "ha1 / ha2",     role: "HA heartbeat",     speed: "10G",  up: true,  vlans: 0,  rx_mbps:    8, tx_mbps:    8, util:  0, errors: 0,    state: "ok"   },
  { id: "mgmt",          role: "OOB management",   speed: "1G",   up: true,  vlans: 0,  rx_mbps:    1, tx_mbps:    2, util:  0, errors: 0,    state: "ok"   },
  { id: "lab",           role: "Lab segment",      speed: "1G",   up: false, vlans: 1,  rx_mbps:    0, tx_mbps:    0, util:  0, errors: 0,    state: "warn" },
];

// IPsec site-to-site tunnels.
const FG_IPSEC = [
  { id: "TCS-CO ⇄ Bryant HS",         peer: "104.x.x.42",   phase2: 4, rxMb:  812, txMb:  642, latency: 2.4, state: "up", since: "67d" },
  { id: "TCS-CO ⇄ Central HS",        peer: "104.x.x.58",   phase2: 4, rxMb:  698, txMb:  514, latency: 2.8, state: "up", since: "67d" },
  { id: "TCS-CO ⇄ Northridge HS",     peer: "104.x.x.71",   phase2: 4, rxMb:  604, txMb:  468, latency: 3.1, state: "up", since: "67d" },
  { id: "TCS-CO ⇄ Westlawn Middle",   peer: "104.x.x.88",   phase2: 4, rxMb:  331, txMb:  244, latency: 3.4, state: "up", since: "67d" },
  { id: "TCS-CO ⇄ Magnet Middle",     peer: "104.x.x.94",   phase2: 4, rxMb:  286, txMb:  198, latency: 3.6, state: "up", since: "67d" },
  { id: "TCS-CO ⇄ TCT Career",        peer: "104.x.x.112",  phase2: 4, rxMb:  244, txMb:  171, latency: 3.8, state: "up", since: "67d" },
  { id: "TCS-CO ⇄ Bus Ops",           peer: "104.x.x.131",  phase2: 2, rxMb:   38, txMb:   24, latency: 4.6, state: "up", since: "67d" },
  { id: "TCS-CO ⇄ Central ES",        peer: "104.x.x.147",  phase2: 2, rxMb:    0, txMb:    0, latency: 0,   state: "down", since: "00:04:11" },
  { id: "TCS-CO ⇄ Datadog Cloud",     peer: "siteX.aws",    phase2: 1, rxMb:  124, txMb:   88, latency: 18,  state: "up", since: "30d" },
  { id: "TCS-CO ⇄ BackupVault AWS",   peer: "vault.aws",    phase2: 1, rxMb:  442, txMb:   72, latency: 22,  state: "up", since: "30d" },
];

// SSL-VPN connected users (joined w/ PacketFence identity).
const FG_SSLVPN = [
  { user: "jharris",  role: "faculty", src: "98.176.x.x",   dst: "10.20.30.18",  dur: "02:14",  rxMb: 184, txMb:  62, mfa: true  },
  { user: "rmoore",   role: "admin",   src: "73.182.x.x",   dst: "10.20.30.41",  dur: "01:42",  rxMb: 312, txMb:  88, mfa: true  },
  { user: "tnguyen",  role: "staff",   src: "76.218.x.x",   dst: "10.20.30.62",  dur: "03:08",  rxMb:  88, txMb:  34, mfa: true  },
  { user: "kpatel",   role: "vendor",  src: "207.40.x.x",   dst: "10.30.10.4",   dur: "00:28",  rxMb:  14, txMb:   6, mfa: true  },
  { user: "mlewis",   role: "faculty", src: "98.175.x.x",   dst: "10.20.30.122", dur: "04:18",  rxMb: 412, txMb: 184, mfa: true  },
  { user: "asmith",   role: "staff",   src: "65.34.x.x",    dst: "10.20.30.91",  dur: "00:11",  rxMb:   6, txMb:   2, mfa: false },
];

// SD-WAN performance: SLA per upstream link.
const FG_SDWAN = {
  rules:     12,
  preferredLink: "wan1",
  sla: [
    { link: "wan1 · Spectrum",    latency: 8.2,  jitter: 0.6, loss: 0.0,  bw_up: 1000, bw_down: 1000, status: "ok",    weight: 100 },
    { link: "wan2 · AT&T fiber",  latency: 12.4, jitter: 1.1, loss: 0.0,  bw_up:  500, bw_down:  500, status: "ok",    weight:  60 },
    { link: "wan3 · LTE backup",  latency: 48.8, jitter: 6.8, loss: 0.8,  bw_up:   80, bw_down:  160, status: "warn",  weight:   5 },
  ],
  // 24h hourly latency for each link
  latencyHistory: {
    wan1: [7.9,7.8,7.9,8.0,8.1,8.0,8.2,8.4,8.6,8.3,8.2,8.1,8.4,8.6,8.4,8.2,8.1,8.0,8.1,8.2,8.3,8.2,8.1,8.2],
    wan2: [11.9,11.8,12.0,12.2,12.3,12.1,12.4,12.6,12.8,12.6,12.4,12.3,12.5,12.7,12.6,12.4,12.3,12.2,12.4,12.5,12.5,12.4,12.3,12.4],
    wan3: [44.0,42.0,40.0,38.0,40.0,42.0,46.0,52.0,58.0,54.0,50.0,48.0,52.0,56.0,54.0,50.0,48.0,46.0,48.0,52.0,54.0,52.0,50.0,48.8],
  },
};

// Threat / UTM module activity in last 24h.
const FG_UTM = [
  { id: "ips",  label: "IPS / IDS",          blocks: 9847,  unique: 412, severity_hi: 38, color: "var(--err)"  },
  { id: "av",   label: "Antivirus",          blocks:  142,  unique:  44, severity_hi: 12, color: "var(--warn)" },
  { id: "wf",   label: "Web filter",         blocks: 38412, unique:1284, severity_hi:  0, color: "var(--info)" },
  { id: "ac",   label: "Application ctrl",   blocks:  4281, unique: 142, severity_hi:  4, color: "var(--ext)"  },
  { id: "dns",  label: "DNS filter",         blocks:  2148, unique:  88, severity_hi:  1, color: "var(--cx)"   },
  { id: "bot",  label: "Botnet C&C",         blocks:    18, unique:   6, severity_hi:  6, color: "var(--zbx)"  },
];

// Top blocked source/dest pairs and top signatures.
const FG_TOP_THREATS = [
  { sig: "ET POLICY · Cleartext credentials in HTTP",  cat: "Policy",       count: 1284, src: "10.20.41.118",   dstCC: "US", sev: "warning" },
  { sig: "ET EXPLOIT · Log4Shell JNDI lookup attempt", cat: "Exploit",      count:  812, src: "various WAN",    dstCC: "US", sev: "high"    },
  { sig: "ET SCAN · Masscan TCP scan",                 cat: "Recon",        count:  604, src: "92.118.x.x",     dstCC: "RU", sev: "warning" },
  { sig: "ET MALWARE · Mirai variant traffic",         cat: "Malware",      count:  248, src: "10.50.12.4",     dstCC: "—",  sev: "high"    },
  { sig: "ET HUNTING · SSL self-signed cert · suspicious", cat: "Hunting", count:  184, src: "various WAN",    dstCC: "CN", sev: "info"    },
  { sig: "Botnet C&C · feed bf:c2.fortiguard",         cat: "Bot C&C",      count:   18, src: "10.30.22.41",    dstCC: "RO", sev: "disaster"},
];

// Top firewall policy hits.
const FG_TOP_POLICIES = [
  { id:  12, name: "LAN → WAN · standard egress",         from: "any · LAN",     to: "wan1/wan2",  service: "443/80/53",   action: "allow",  hits24h: 184_212_488, log: "all" },
  { id:  17, name: "Student VLAN → WAN · webfilter",      from: "vlan20 · stu",  to: "wan1",       service: "ANY",         action: "allow",  hits24h:  88_412_104, log: "policy" },
  { id:  22, name: "Staff VLAN → WAN · trusted",          from: "vlan10 · stf",  to: "wan1",       service: "ANY",         action: "allow",  hits24h:  42_188_201, log: "policy" },
  { id:  31, name: "Guest captive → WAN · throttled",     from: "vlan60 · gst",  to: "wan2",       service: "443/80/53",   action: "allow",  hits24h:  14_220_812, log: "all"   },
  { id:  41, name: "IoT → DNS resolver only",             from: "vlan80 · iot",  to: "10.1.0.53",  service: "DNS",         action: "allow",  hits24h:   4_122_840, log: "policy"},
  { id:  88, name: "Inbound · public DMZ HTTPS",          from: "wan1",          to: "dmz1",       service: "HTTPS",       action: "allow",  hits24h:     842_104, log: "all"   },
  { id: 101, name: "Geo-block · CN/RU/KP inbound",        from: "wan1/wan2",     to: "any",        service: "ANY",         action: "deny",   hits24h:   1_244_812, log: "deny"  },
  { id: 144, name: "Block · botnet feed (FortiGuard)",    from: "any",           to: "any",        service: "ANY",         action: "deny",   hits24h:      18_212, log: "deny"  },
];

// Recent firewall events stream (mix of HA, IPsec, IPS, admin).
const FG_EVENTS = [
  { ts: "16:42:18", source: "zbx", host: "fw-tcs-co-01", sev: "high",    msg: "IPsec tunnel down · ",        obj: "TCS-CO ⇄ Central ES (00:04:11 ago)" },
  { ts: "16:41:02", source: "zbx", host: "fw-tcs-co-01", sev: "info",    msg: "Active sessions ",            obj: "184,213 (+2.1k in 60s)" },
  { ts: "16:38:44", source: "zbx", host: "fw-tcs-co-01", sev: "high",    msg: "IPS · Log4Shell JNDI lookup attempt blocked × 12 · ", obj: "src: various WAN" },
  { ts: "16:36:11", source: "pf",  host: "fw-tcs-co-01", sev: "info",    msg: "SSL-VPN authenticated · ",    obj: "user=jharris (faculty) via MFA" },
  { ts: "16:34:08", source: "zbx", host: "fw-tcs-co-01", sev: "disaster",msg: "Botnet C&C destination blocked · ", obj: "10.30.22.41 → c2.host.ro (policy 144)" },
  { ts: "16:31:52", source: "zbx", host: "fw-tcs-co-01", sev: "warning", msg: "CPU sustained > 70% (15m peak) · ",  obj: "now 38% / peak 71%" },
  { ts: "16:30:04", source: "zbx", host: "fw-tcs-co-01", sev: "info",    msg: "HA heartbeat sync OK · ",     obj: "checksum match · 4128 objects" },
  { ts: "16:28:33", source: "pf",  host: "fw-tcs-co-01", sev: "info",    msg: "SSL-VPN session closed · ",   obj: "user=asmith · no MFA · flagged" },
  { ts: "16:26:18", source: "zbx", host: "fw-tcs-co-02", sev: "ok",      msg: "Secondary node healthy · ",   obj: "sessions=167,982 / cpu=21%" },
  { ts: "16:24:01", source: "zbx", host: "fw-tcs-co-01", sev: "warning", msg: "SD-WAN · wan3 LTE loss 0.8% / latency 48.8 ms · ", obj: "weight reduced to 5" },
];

window.FG_DEVICE = FG_DEVICE;
window.FG_TOTALS = FG_TOTALS;
window.FG_THROUGHPUT_24H = FG_THROUGHPUT_24H;
window.FG_SESSIONS_24H = FG_SESSIONS_24H;
window.FG_NEW_SESSIONS_24H = FG_NEW_SESSIONS_24H;
window.FG_HA = FG_HA;
window.FG_INTERFACES = FG_INTERFACES;
window.FG_IPSEC = FG_IPSEC;
window.FG_SSLVPN = FG_SSLVPN;
window.FG_SDWAN = FG_SDWAN;
window.FG_UTM = FG_UTM;
window.FG_TOP_THREATS = FG_TOP_THREATS;
window.FG_TOP_POLICIES = FG_TOP_POLICIES;
window.FG_EVENTS = FG_EVENTS;
