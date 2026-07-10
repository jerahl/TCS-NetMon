// Shared mock data for PacketFence Identity pages.
// All values picked to feel "real" for a K-12 district of ~13k endpoints across 26 sites.

window.PF_SUMMARY = {
  total: 12847,
  registered: 11962,
  guest: 712,
  unregistered: 173,
  isolated: 2,
  sites: 26,
  policies: 47,
  profiles: 18,
  authSources: 6,
  pfVersion: "12.3.0",
  lastSync: "12s ago"
};

// 24h device connect counts (per hour, midnight → 23h)
window.PF_CONNECTS_24H = [120, 80, 62, 55, 48, 60, 220, 1840, 2780, 3120, 2410, 2680, 2120, 2540, 2390, 2110, 1430, 980, 640, 410, 290, 220, 170, 140];

// Auth-method donut (sums to 100)
window.PF_AUTH_METHODS = [{
  key: "dot1x-eap-tls",
  label: "802.1X · EAP-TLS",
  value: 64,
  color: "var(--pf)"
}, {
  key: "dot1x-peap",
  label: "802.1X · PEAP-MSCHAPv2",
  value: 21,
  color: "#e8843c"
}, {
  key: "mab",
  label: "MAB (MAC auth)",
  value: 11,
  color: "var(--info)"
}, {
  key: "portal",
  label: "Captive portal",
  value: 3,
  color: "var(--ext)"
}, {
  key: "rejected",
  label: "Rejected",
  value: 1,
  color: "var(--err)"
}];

// Role assignments — VLAN, ACL, bandwidth caps, count
window.PF_ROLES = [{
  id: "faculty",
  name: "Faculty",
  vlan: 110,
  acl: "ACL-FACULTY",
  bw: "—",
  count: 1240,
  tag: "faculty"
}, {
  id: "student",
  name: "Student",
  vlan: 120,
  acl: "ACL-STUDENT",
  bw: "50 Mb",
  count: 8190,
  tag: "student"
}, {
  id: "byod",
  name: "BYOD · Student",
  vlan: 122,
  acl: "ACL-BYOD",
  bw: "10 Mb",
  count: 1408,
  tag: "byod"
}, {
  id: "guest",
  name: "Guest",
  vlan: 199,
  acl: "ACL-GUEST",
  bw: "5 Mb",
  count: 712,
  tag: "guest"
}, {
  id: "av",
  name: "AV / Smart-board",
  vlan: 130,
  acl: "ACL-AV",
  bw: "—",
  count: 386,
  tag: "av"
}, {
  id: "voip",
  name: "VoIP · 3CX",
  vlan: 140,
  acl: "ACL-VOIP",
  bw: "—",
  count: 204,
  tag: "voip"
}, {
  id: "camera",
  name: "Surveillance",
  vlan: 150,
  acl: "ACL-VMS",
  bw: "—",
  count: 1147,
  tag: "av"
}, {
  id: "iot",
  name: "Building IoT",
  vlan: 160,
  acl: "ACL-IOT",
  bw: "2 Mb",
  count: 478,
  tag: "av"
}, {
  id: "isolation",
  name: "Isolation",
  vlan: 666,
  acl: "ACL-QUARANTINE",
  bw: "Captive",
  count: 2,
  tag: "quarantine"
}];

// Authentication sources
window.PF_AUTH_SOURCES = [{
  id: "ad-tcs",
  short: "AD",
  name: "TCS Active Directory",
  type: "AD · LDAPS",
  host: "dc01.tcs.local",
  daily: 24180,
  status: "ok",
  note: "Primary user store"
}, {
  id: "ad-stu",
  short: "AD",
  name: "Student AD (read-only)",
  type: "AD · LDAP",
  host: "dc-stu.tcs.local",
  daily: 18420,
  status: "ok",
  note: "OU=Students"
}, {
  id: "google",
  short: "G",
  name: "Google Workspace (SAML)",
  type: "SAML 2.0",
  host: "accounts.google.com",
  daily: 9214,
  status: "ok",
  note: "BYOD onboarding"
}, {
  id: "guest",
  short: "GP",
  name: "Guest portal · self-reg",
  type: "Internal · Email",
  host: "guest.tcs.k12",
  daily: 187,
  status: "ok",
  note: "24h sponsor approval"
}, {
  id: "radius",
  short: "R",
  name: "Eduroam RADIUS proxy",
  type: "RADIUS",
  host: "radius.eduroam.org",
  daily: 42,
  status: "warn",
  note: "Slow response — 1.4s avg"
}, {
  id: "local",
  short: "L",
  name: "Local accounts",
  type: "PacketFence DB",
  host: "127.0.0.1",
  daily: 6,
  status: "ok",
  note: "Service accounts only"
}];

// Connection profiles
window.PF_PROFILES = [{
  id: "p1",
  name: "tcs-secure",
  ssids: "tcs-secure",
  sources: "AD-TCS, AD-Student",
  roles: "faculty / student",
  auths: 8210
}, {
  id: "p2",
  name: "tcs-byod",
  ssids: "tcs-byod",
  sources: "Google Workspace",
  roles: "byod",
  auths: 1408
}, {
  id: "p3",
  name: "tcs-guest",
  ssids: "tcs-guest",
  sources: "Guest portal",
  roles: "guest",
  auths: 712
}, {
  id: "p4",
  name: "wired-default",
  ssids: "—",
  sources: "AD-TCS / MAB",
  roles: "faculty / av / iot",
  auths: 2310
}, {
  id: "p5",
  name: "voip-mab",
  ssids: "—",
  sources: "MAB · OUI",
  roles: "voip",
  auths: 204
}, {
  id: "p6",
  name: "vms-cameras",
  ssids: "—",
  sources: "MAB · OUI · Axis/Hikvision",
  roles: "camera",
  auths: 1147
}, {
  id: "p7",
  name: "iot-thermostat",
  ssids: "—",
  sources: "MAB · OUI · Honeywell",
  roles: "iot",
  auths: 162
}, {
  id: "p8",
  name: "eduroam-outbound",
  ssids: "eduroam",
  sources: "Eduroam proxy",
  roles: "guest",
  auths: 42
}];

// Devices for Connected Devices table (~24 rows, mix of types)
window.PF_DEVICES = [{
  mac: "a8:5e:45:09:c2:14",
  host: "BHS-FAC-0184",
  owner: "j.calloway@tcs",
  role: "faculty",
  vlan: 110,
  ssid: "tcs-secure",
  loc: "BHS-AP-3F-East",
  site: "BHS",
  os: "Win 11",
  vendor: "Dell",
  lastSeen: "12s ago",
  status: "registered",
  src: "pf"
}, {
  mac: "b4:8c:9d:f1:22:e0",
  host: "CHS-STU-CHRB-2210",
  owner: "alice.t (student)",
  role: "student",
  vlan: 120,
  ssid: "tcs-secure",
  loc: "CHS-SW-Lib-2/14",
  site: "CHS",
  os: "ChromeOS",
  vendor: "Acer",
  lastSeen: "1m ago",
  status: "registered",
  src: "pf"
}, {
  mac: "d8:80:39:c4:0a:7b",
  host: "iPad-29A",
  owner: "k.harris (byod)",
  role: "byod",
  vlan: 122,
  ssid: "tcs-byod",
  loc: "BHS-AP-2F-South",
  site: "BHS",
  os: "iPadOS 17",
  vendor: "Apple",
  lastSeen: "3m ago",
  status: "registered",
  src: "pf"
}, {
  mac: "00:09:0f:aa:11:42",
  host: "Promethean-3122",
  owner: "AV-pool",
  role: "av",
  vlan: 130,
  ssid: "—",
  loc: "NHS-SW-3F-12/03",
  site: "NHS",
  os: "Android TV",
  vendor: "Promethean",
  lastSeen: "8s ago",
  status: "registered",
  src: "pf"
}, {
  mac: "00:1c:73:11:88:0a",
  host: "3CX-X441",
  owner: "Front office",
  role: "voip",
  vlan: 140,
  ssid: "—",
  loc: "CHS-SW-Office-1/22",
  site: "CHS",
  os: "Yealink fw",
  vendor: "Yealink",
  lastSeen: "4s ago",
  status: "registered",
  src: "pf"
}, {
  mac: "ac:cc:8e:55:9c:31",
  host: "AXIS-Q3527",
  owner: "VMS-east-corr",
  role: "camera",
  vlan: 150,
  ssid: "—",
  loc: "BHS-SW-1F-08/06",
  site: "BHS",
  os: "AXIS OS",
  vendor: "Axis",
  lastSeen: "1s ago",
  status: "registered",
  src: "pf"
}, {
  mac: "f0:b4:79:b2:33:88",
  host: "iPhone-Guest-A12",
  owner: "self-reg (parent)",
  role: "guest",
  vlan: 199,
  ssid: "tcs-guest",
  loc: "BHS-AP-Main-Gym",
  site: "BHS",
  os: "iOS 17.4",
  vendor: "Apple",
  lastSeen: "5m ago",
  status: "guest",
  src: "pf"
}, {
  mac: "00:e0:4c:68:21:0d",
  host: "TUSC-IOT-HVAC-08",
  owner: "Facilities",
  role: "iot",
  vlan: 160,
  ssid: "—",
  loc: "BHS-SW-Bsmt-MEC-1/04",
  site: "BHS",
  os: "Honeywell",
  vendor: "Honeywell",
  lastSeen: "44s ago",
  status: "registered",
  src: "pf"
}, {
  mac: "9c:b6:54:af:78:e1",
  host: "—",
  owner: "(not registered)",
  role: "unknown",
  vlan: 199,
  ssid: "tcs-guest",
  loc: "NHS-AP-Cafe-South",
  site: "NHS",
  os: "—",
  vendor: "Samsung",
  lastSeen: "2m ago",
  status: "unregistered",
  src: "pf"
}, {
  mac: "ec:b1:d7:6a:5f:09",
  host: "DLE-SW-2F-04",
  owner: "Network",
  role: "av",
  vlan: 1,
  ssid: "—",
  loc: "DLE-MDF",
  site: "DLE",
  os: "EXOS 32",
  vendor: "Extreme",
  lastSeen: "6s ago",
  status: "registered",
  src: "ext"
}, {
  mac: "3c:5a:b4:c1:00:fa",
  host: "CHS-PRINT-LIB1",
  owner: "Library",
  role: "iot",
  vlan: 160,
  ssid: "—",
  loc: "CHS-SW-Lib-2/22",
  site: "CHS",
  os: "PrinterOS",
  vendor: "HP",
  lastSeen: "1m ago",
  status: "registered",
  src: "pf"
}, {
  mac: "d4:6e:0e:33:b8:7c",
  host: "Win10-LegacyLab-04",
  owner: "—",
  role: "quarantine",
  vlan: 666,
  ssid: "tcs-secure",
  loc: "NHS-SW-Lab-A/11",
  site: "NHS",
  os: "Win 10 1909",
  vendor: "Lenovo",
  lastSeen: "21m ago",
  status: "isolated",
  src: "pf"
}, {
  mac: "5c:5f:67:81:21:b4",
  host: "MacBook-Air-9384",
  owner: "m.weber@tcs",
  role: "faculty",
  vlan: 110,
  ssid: "tcs-secure",
  loc: "BHS-AP-Lib-3F",
  site: "BHS",
  os: "macOS 14.4",
  vendor: "Apple",
  lastSeen: "30s ago",
  status: "registered",
  src: "pf"
}, {
  mac: "e4:e7:49:a0:00:1c",
  host: "ChromebookCart-12",
  owner: "Cart-12 (student)",
  role: "byod",
  vlan: 122,
  ssid: "tcs-byod",
  loc: "CHS-AP-2F-West",
  site: "CHS",
  os: "ChromeOS",
  vendor: "Acer",
  lastSeen: "9s ago",
  status: "registered",
  src: "pf"
}, {
  mac: "00:11:32:18:e1:34",
  host: "Synology-PB-NAS",
  owner: "Tech-Dept",
  role: "iot",
  vlan: 160,
  ssid: "—",
  loc: "TCS-OPS-SW-1/01",
  site: "OPS",
  os: "DSM 7.2",
  vendor: "Synology",
  lastSeen: "2s ago",
  status: "registered",
  src: "pf"
}, {
  mac: "84:b8:02:55:31:e1",
  host: "—",
  owner: "(awaiting reg)",
  role: "unknown",
  vlan: 199,
  ssid: "tcs-byod",
  loc: "BHS-AP-Hall-2F",
  site: "BHS",
  os: "Android",
  vendor: "Samsung",
  lastSeen: "30s ago",
  status: "pending",
  src: "pf"
}, {
  mac: "fc:fb:fb:11:90:0a",
  host: "WIN-EOL-2008",
  owner: "—",
  role: "quarantine",
  vlan: 666,
  ssid: "—",
  loc: "NHS-SW-3F-08/14",
  site: "NHS",
  os: "Win Server 2008",
  vendor: "HP",
  lastSeen: "1h ago",
  status: "isolated",
  src: "pf"
}, {
  mac: "b8:27:eb:5a:91:c4",
  host: "RPi-Signage-04",
  owner: "Athletics",
  role: "av",
  vlan: 130,
  ssid: "—",
  loc: "BHS-SW-Gym/04",
  site: "BHS",
  os: "Raspbian",
  vendor: "RaspberryPi",
  lastSeen: "15s ago",
  status: "registered",
  src: "pf"
}, {
  mac: "00:1d:c1:9a:7f:11",
  host: "Ricoh-MFP-7203",
  owner: "Bldg-Mgmt",
  role: "iot",
  vlan: 160,
  ssid: "—",
  loc: "CHS-SW-Office-1/03",
  site: "CHS",
  os: "RicohOS",
  vendor: "Ricoh",
  lastSeen: "2m ago",
  status: "registered",
  src: "pf"
}, {
  mac: "70:5a:0f:32:c2:e8",
  host: "Surface-Sub-201",
  owner: "subteacher-pool",
  role: "faculty",
  vlan: 110,
  ssid: "tcs-secure",
  loc: "NHS-AP-1F-MainOffice",
  site: "NHS",
  os: "Win 11",
  vendor: "Microsoft",
  lastSeen: "40s ago",
  status: "registered",
  src: "pf"
}];

// Live user-sessions table (subset of devices + auth metadata)
window.PF_SESSIONS = [{
  user: "j.calloway",
  role: "faculty",
  mac: "a8:5e:45:09:c2:14",
  method: "EAP-TLS",
  nas: "BHS-AP-3F-East",
  ssid: "tcs-secure",
  started: "08:14:02",
  dur: 6420,
  vlan: 110,
  status: "active"
}, {
  user: "alice.t",
  role: "student",
  mac: "b4:8c:9d:f1:22:e0",
  method: "EAP-TLS",
  nas: "CHS-SW-Lib-2:14",
  ssid: "tcs-secure",
  started: "07:58:11",
  dur: 7380,
  vlan: 120,
  status: "active"
}, {
  user: "k.harris",
  role: "byod",
  mac: "d8:80:39:c4:0a:7b",
  method: "PEAP-MSCHAPv2",
  nas: "BHS-AP-2F-South",
  ssid: "tcs-byod",
  started: "09:02:44",
  dur: 4220,
  vlan: 122,
  status: "active"
}, {
  user: "av-pool",
  role: "av",
  mac: "00:09:0f:aa:11:42",
  method: "MAB (OUI)",
  nas: "NHS-SW-3F-12:03",
  ssid: "—",
  started: "06:30:01",
  dur: 11820,
  vlan: 130,
  status: "active"
}, {
  user: "3cx-x441",
  role: "voip",
  mac: "00:1c:73:11:88:0a",
  method: "MAB",
  nas: "CHS-SW-Office-1:22",
  ssid: "—",
  started: "06:14:09",
  dur: 12350,
  vlan: 140,
  status: "active"
}, {
  user: "vms-axis",
  role: "camera",
  mac: "ac:cc:8e:55:9c:31",
  method: "MAB",
  nas: "BHS-SW-1F-08:06",
  ssid: "—",
  started: "Mar-31",
  dur: 99999,
  vlan: 150,
  status: "active"
}, {
  user: "guest:parent_a",
  role: "guest",
  mac: "f0:b4:79:b2:33:88",
  method: "Portal · email",
  nas: "BHS-AP-Main-Gym",
  ssid: "tcs-guest",
  started: "10:42:18",
  dur: 1080,
  vlan: 199,
  status: "active"
}, {
  user: "tcs-iot-hvac",
  role: "iot",
  mac: "00:e0:4c:68:21:0d",
  method: "MAB",
  nas: "BHS-SW-Bsmt:04",
  ssid: "—",
  started: "Apr-02",
  dur: 99999,
  vlan: 160,
  status: "active"
}, {
  user: "—",
  role: "unknown",
  mac: "9c:b6:54:af:78:e1",
  method: "Portal · pending",
  nas: "NHS-AP-Cafe-South",
  ssid: "tcs-guest",
  started: "10:48:55",
  dur: 740,
  vlan: 199,
  status: "registering"
}, {
  user: "m.weber",
  role: "faculty",
  mac: "5c:5f:67:81:21:b4",
  method: "EAP-TLS",
  nas: "BHS-AP-Lib-3F",
  ssid: "tcs-secure",
  started: "08:02:14",
  dur: 6840,
  vlan: 110,
  status: "active"
}, {
  user: "cart-12",
  role: "byod",
  mac: "e4:e7:49:a0:00:1c",
  method: "EAP-TLS",
  nas: "CHS-AP-2F-West",
  ssid: "tcs-byod",
  started: "07:55:30",
  dur: 7480,
  vlan: 122,
  status: "active"
}, {
  user: "subteacher.51",
  role: "faculty",
  mac: "70:5a:0f:32:c2:e8",
  method: "PEAP-MSCHAPv2",
  nas: "NHS-AP-1F-MainOffice",
  ssid: "tcs-secure",
  started: "08:30:00",
  dur: 6020,
  vlan: 110,
  status: "active"
}, {
  user: "win10-legacy04",
  role: "quarantine",
  mac: "d4:6e:0e:33:b8:7c",
  method: "MAB · isolated",
  nas: "NHS-SW-Lab-A:11",
  ssid: "tcs-secure",
  started: "10:38:21",
  dur: 980,
  vlan: 666,
  status: "isolated"
}];

// Violation/quarantine catalog
window.PF_VIOLATIONS = [{
  id: 1100001,
  name: "EOL operating system",
  sev: "err",
  count: 1,
  body: "Endpoint reports Windows 10 1909 — past end-of-support. Captive remediation page presented.",
  trigger: "OS fingerprint via DHCP fingerbank",
  remediation: "Reimage / upgrade to 22H2"
}, {
  id: 1100002,
  name: "EOL server",
  sev: "err",
  count: 1,
  body: "Server 2008R2 detected on student VLAN. Isolated automatically pending decommissioning ticket.",
  trigger: "OS fingerprint",
  remediation: "Decommission · TKT-9302"
}, {
  id: 2200001,
  name: "Cortex XDR agent missing",
  sev: "warn",
  count: 14,
  body: "Domain-joined Windows host without Cortex XDR endpoint agent. Self-remediation: install via SCCM bundle.",
  trigger: "Cortex XDR API correlation",
  remediation: "Install agent · auto-retry 24h"
}, {
  id: 2200004,
  name: "MAC spoof attempt",
  sev: "err",
  count: 0,
  body: "Same MAC observed simultaneously on two NAS devices. Auto-isolation rule applied — no incidents in last 7d.",
  trigger: "RADIUS Acct cross-NAS",
  remediation: "Investigate · manual unblock"
}, {
  id: 2200008,
  name: "Rogue DHCP server",
  sev: "warn",
  count: 2,
  body: "Unauthorized DHCP OFFER seen on student VLAN. Switch port disabled via SNMP set.",
  trigger: "Fingerbank DHCP fingerprint anomaly",
  remediation: "Open switchport · revalidate"
}, {
  id: 3300011,
  name: "BYOD certificate expiring",
  sev: "warn",
  count: 28,
  body: "Onboarding cert expires < 7d. User notified by email + portal banner.",
  trigger: "Internal CA OCSP poll",
  remediation: "Re-enroll via portal"
}, {
  id: 5500001,
  name: "Excessive failed 802.1X auth",
  sev: "warn",
  count: 4,
  body: "10+ Access-Reject events for same MAC in 60s. Rate-limited at NAS.",
  trigger: "RADIUS Reject rate",
  remediation: "Investigate supplicant config"
}, {
  id: 5500003,
  name: "Captive portal abandoned",
  sev: "info",
  count: 47,
  body: "User authenticated via portal but never accepted AUP — VLAN remains registration.",
  trigger: "Portal abandon timer 600s",
  remediation: "Auto-clear at 24h"
}];

// PacketFence cluster nodes (3-node Galera cluster)
window.PF_NODES = [{
  id: "pf01",
  name: "pf-01",
  role: "primary",
  host: "pf-01.tcs.local · 10.10.4.21",
  uptime: "47d 8h",
  cpu: 22,
  mem: 61,
  disk: 38,
  radSec: 218,
  dbConn: 142,
  radTime: 4.1,
  queue: 18,
  services: [{
    n: "radiusd",
    s: "ok"
  }, {
    n: "httpd.portal",
    s: "ok"
  }, {
    n: "httpd.aaa",
    s: "ok"
  }, {
    n: "haproxy-portal",
    s: "ok"
  }, {
    n: "packetfence-mariadb",
    s: "ok"
  }, {
    n: "redis-queue",
    s: "ok"
  }, {
    n: "pfqueue",
    s: "ok"
  }, {
    n: "pfacct",
    s: "ok"
  }, {
    n: "fingerbank-collector",
    s: "ok"
  }]
}, {
  id: "pf02",
  name: "pf-02",
  role: "secondary",
  host: "pf-02.tcs.local · 10.10.4.22",
  uptime: "47d 8h",
  cpu: 14,
  mem: 54,
  disk: 38,
  radSec: 184,
  dbConn: 88,
  radTime: 3.8,
  queue: 6,
  services: [{
    n: "radiusd",
    s: "ok"
  }, {
    n: "httpd.portal",
    s: "ok"
  }, {
    n: "httpd.aaa",
    s: "ok"
  }, {
    n: "haproxy-portal",
    s: "ok"
  }, {
    n: "packetfence-mariadb",
    s: "ok"
  }, {
    n: "redis-queue",
    s: "ok"
  }, {
    n: "pfqueue",
    s: "ok"
  }, {
    n: "pfacct",
    s: "ok"
  }, {
    n: "fingerbank-collector",
    s: "ok"
  }]
}, {
  id: "pf03",
  name: "pf-03",
  role: "secondary",
  host: "pf-03.tcs.local · 10.10.4.23",
  uptime: "3h 24m",
  cpu: 9,
  mem: 71,
  disk: 38,
  radSec: 12,
  dbConn: 28,
  radTime: 12.4,
  queue: 240,
  services: [{
    n: "radiusd",
    s: "ok"
  }, {
    n: "httpd.portal",
    s: "ok"
  }, {
    n: "httpd.aaa",
    s: "ok"
  }, {
    n: "haproxy-portal",
    s: "ok"
  }, {
    n: "packetfence-mariadb",
    s: "warn"
  }, {
    n: "redis-queue",
    s: "ok"
  }, {
    n: "pfqueue",
    s: "warn"
  }, {
    n: "pfacct",
    s: "ok"
  }, {
    n: "fingerbank-collector",
    s: "ok"
  }]
}];

// Per-minute RADIUS requests / sec (last 60min sparkline)
window.PF_RADIUS_TIMELINE = Array.from({
  length: 60
}, (_, i) => {
  const base = 380 + Math.round(Math.sin(i / 7) * 60 + Math.sin(i / 3) * 18);
  return Math.max(80, base + (i > 52 ? -40 : 0));
});
window.PF_DB_TIMELINE = Array.from({
  length: 60
}, (_, i) => 220 + Math.round(Math.sin(i / 5) * 30) + (i > 48 ? 50 : 0));
window.PF_QUEUE_TIMELINE = Array.from({
  length: 60
}, (_, i) => Math.max(0, 12 + Math.round(Math.sin(i / 9) * 8) + (i > 50 ? 180 : 0)));

// pfqueue depths
window.PF_QUEUES = [{
  name: "pfqueue.general",
  depth: 18,
  cap: 1000,
  rate: "240/s"
}, {
  name: "pfqueue.priority",
  depth: 4,
  cap: 500,
  rate: "82/s"
}, {
  name: "pfqueue.statsd",
  depth: 0,
  cap: 200,
  rate: "—"
}, {
  name: "pfacct.radius",
  depth: 240,
  cap: 1000,
  rate: "640/s",
  note: "pf-03 lag"
}, {
  name: "pfacct.dhcp",
  depth: 12,
  cap: 1000,
  rate: "120/s"
}, {
  name: "fingerbank.lookup",
  depth: 2,
  cap: 200,
  rate: "44/s"
}, {
  name: "violation.mailer",
  depth: 0,
  cap: 100,
  rate: "—"
}, {
  name: "syslog.export",
  depth: 6,
  cap: 500,
  rate: "190/s"
}];

// Recent service events
window.PF_SERVICE_EVENTS = [{
  ts: "10:51:14",
  src: "pf",
  host: "pf-03",
  sev: "warn",
  msg: "Galera node desync detected · ",
  obj: "wsrep_local_state = JOINER"
}, {
  ts: "10:50:02",
  src: "pf",
  host: "pf-03",
  sev: "warn",
  msg: "pfqueue depth above warning · ",
  obj: "pfacct.radius = 240"
}, {
  ts: "10:42:18",
  src: "pf",
  host: "pf-01",
  sev: "ok",
  msg: "Guest registration · ",
  obj: "f0:b4:79:b2:33:88 → tcs-guest"
}, {
  ts: "10:38:21",
  src: "pf",
  host: "pf-01",
  sev: "high",
  msg: "Auto-isolation · EOL OS · ",
  obj: "d4:6e:0e:33:b8:7c → vlan 666"
}, {
  ts: "10:30:00",
  src: "pf",
  host: "cluster",
  sev: "ok",
  msg: "Configuration synced · ",
  obj: "pfsetvlan rebuild · 26 sites"
}, {
  ts: "10:22:47",
  src: "pf",
  host: "pf-02",
  sev: "ok",
  msg: "EAP-TLS · ",
  obj: "j.calloway · cert OK · CN=BHS-FAC-0184"
}, {
  ts: "10:21:09",
  src: "zbx",
  host: "pf-03",
  sev: "warn",
  msg: "Zabbix: net.if.in[eth0] 92% · ",
  obj: "1.05 Gbps avg"
}, {
  ts: "10:20:11",
  src: "pf",
  host: "pf-01",
  sev: "warn",
  msg: "RADIUS Reject (5x in 60s) · ",
  obj: "ec:0c:9a:11:42:8a"
}, {
  ts: "10:18:33",
  src: "pf",
  host: "pf-02",
  sev: "ok",
  msg: "Service restart · ",
  obj: "fingerbank-collector · scheduled"
}, {
  ts: "10:14:02",
  src: "pf",
  host: "pf-01",
  sev: "ok",
  msg: "Cluster heartbeat · ",
  obj: "3/3 nodes · vrrp master = pf-01"
}];