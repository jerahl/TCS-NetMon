// The one place spec 10 §2's severity mapping lives.
//
// The design speaks Zabbix's 5 levels (disaster/high/warning/info/…); NetMon's
// DB enum is 4 (crit/warn/ok/unknown). We render NetMon's truth with the
// design's vocabulary — crit → "Critical" (the design's disaster/high collapse
// to one level here; a blast-radius "Disaster" escalation is a later concern,
// not a DB change), warn → "Warning", ok → "OK", unknown → "Info". No server
// round-trip: the API always returns the 4-level enum.

export const SEV_LABEL = {
  crit: "Critical",
  warn: "Warning",
  ok: "OK",
  unknown: "Info",
};

// Rank for sorting/worst-of roll-ups (higher = more severe).
export const SEV_RANK = { crit: 3, warn: 2, ok: 1, unknown: 0 };

export function sevLabel(sev) {
  return SEV_LABEL[sev] || SEV_LABEL.unknown;
}

// Provenance labels (spec 10 §2). The API's `source` column carries the raw
// collector/poller name; map the known ones to the design's short badges and
// pass anything else through uppercased so a new source still renders.
const SOURCE_BADGE = {
  poller: "POLLER",
  snmp: "SNMP",
  snmp_inventory: "SNMP",
  xiq: "XIQ",
  packetfence: "PF",
  pf: "PF",
  milestone: "MS",
  ms: "MS",
  threecx: "3CX",
  "3cx": "3CX",
  rconfig: "RCFG",
  rcfg: "RCFG",
  engine: "ENGINE",
};

export function sourceBadge(source) {
  if (!source) return "—";
  return SOURCE_BADGE[String(source).toLowerCase()] || String(source).toUpperCase();
}
