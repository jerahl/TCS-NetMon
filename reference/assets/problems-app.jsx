// Problems — graphical, icon-first view of the active problem set.
// Ported from the Claude Design prototype (zabbix-extreme/project/
// problems-app.jsx) and wired to live data published by events-bridge.jsx
// → window.EV_EVENTS. Each problem is a tile of glyphs (severity color,
// host-class icon, status indicator, source mark, age bar, tag micro-icons).
// The trigger string only appears in the hover tooltip and the drawer.

const SEV_ORDER  = { disaster: 5, high: 4, warning: 3, info: 2, ok: 1 };
const SEV_LABEL  = { disaster: "Disaster", high: "High", warning: "Warning", info: "Info", ok: "Resolved" };
const SEV_KEYS   = ["disaster","high","warning","info","ok"];
const SEV_COLOR  = { disaster: "#ff6b67", high: "#ff9a78", warning: "#ffc24b", info: "#6aa7ff", ok: "#5fd9a3" };
const STATUS_LABEL = { open: "Open", ack: "Acknowledged", resolved: "Resolved", suppressed: "Suppressed" };
const SOURCE_LABEL = { zbx: "Zabbix", pf: "PacketFence", ext: "ExtremeCloud" };

// ───────── Glyph library ─────────
const Glyph = ({ name, size = 22 }) => {
  const s = {
    width: size, height: size, viewBox: "0 0 24 24", fill: "none",
    stroke: "currentColor", strokeWidth: 1.6,
    strokeLinecap: "round", strokeLinejoin: "round"
  };
  switch (name) {
    case "ap": return (<svg {...s}><circle cx="12" cy="17" r="1.6" fill="currentColor" stroke="none"/><path d="M8 14a5 5 0 0 1 8 0M5.5 11a8.5 8.5 0 0 1 13 0M3 8a12 12 0 0 1 18 0"/></svg>);
    case "switch": return (<svg {...s}><rect x="3" y="7" width="18" height="10" rx="2"/><path d="M7 17v2M10 17v2M13 17v2M16 17v2M7 5v2M16 5v2"/><circle cx="18" cy="12" r=".8" fill="currentColor" stroke="none"/><circle cx="15" cy="12" r=".8" fill="currentColor" stroke="none"/></svg>);
    case "server": return (<svg {...s}><rect x="3.5" y="4" width="17" height="6" rx="1.5"/><rect x="3.5" y="14" width="17" height="6" rx="1.5"/><circle cx="7" cy="7" r=".9" fill="currentColor" stroke="none"/><circle cx="7" cy="17" r=".9" fill="currentColor" stroke="none"/><path d="M11 7h7M11 17h7"/></svg>);
    case "camera": return (<svg {...s}><rect x="3" y="7" width="14" height="10" rx="2"/><path d="M17 10l4-2v8l-4-2z"/><circle cx="9" cy="12" r="2.4"/></svg>);
    case "identity": return (<svg {...s}><circle cx="12" cy="9" r="3.4"/><path d="M5 20c1-3.6 4-5.4 7-5.4s6 1.8 7 5.4"/><path d="M15 11l2 2 4-4"/></svg>);
    case "shield": return (<svg {...s}><path d="M12 3 4 6v6c0 4.4 3.4 7.7 8 9 4.6-1.3 8-4.6 8-9V6l-8-3Z"/></svg>);
    case "nvr": return (<svg {...s}><rect x="3" y="7" width="18" height="11" rx="1.6"/><circle cx="8" cy="12.5" r="1.6"/><path d="M12 12.5h6"/></svg>);
    case "st-open": return (<svg {...s}><circle cx="12" cy="12" r="4" fill="currentColor" stroke="none"/></svg>);
    case "st-ack": return (<svg {...s}><circle cx="12" cy="12" r="4"/><path d="m9.5 12 1.8 1.8L14.5 10.5"/></svg>);
    case "st-resolved": return (<svg {...s}><circle cx="12" cy="12" r="6"/><path d="m9 12 2.2 2.2L15.5 10"/></svg>);
    case "st-suppressed": return (<svg {...s}><rect x="7.5" y="10.5" width="9" height="6" rx="1.4"/><path d="M9.5 10.5V9a2.5 2.5 0 0 1 5 0v1.5"/></svg>);
    case "outage":   return <svg {...s}><path d="M12 3v6M5 8.5a8 8 0 1 0 14 0"/></svg>;
    case "uplink":   return <svg {...s}><path d="M12 5v14M7 10l5-5 5 5"/></svg>;
    case "port":     return <svg {...s}><rect x="4" y="6" width="16" height="12" rx="1.6"/><path d="M8 18v2M12 18v2M16 18v2"/></svg>;
    case "poe":      return <svg {...s}><path d="M13 3 5 14h6l-1 7 8-11h-6l1-7Z"/></svg>;
    case "optic":    return <svg {...s}><circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2.5" fill="currentColor" stroke="none"/></svg>;
    case "radio":    return <svg {...s}><path d="M5.5 8.5a9 9 0 0 1 13 0M8 11a5.5 5.5 0 0 1 8 0M10.5 13.5a2.5 2.5 0 0 1 3 0"/><circle cx="12" cy="17" r="1.2" fill="currentColor" stroke="none"/></svg>;
    case "auth":     return <svg {...s}><circle cx="10" cy="11" r="3.4"/><path d="m13 11 7 0M17 11v3M20 11v3"/></svg>;
    case "db":       return <svg {...s}><ellipse cx="12" cy="6" rx="7" ry="2.5"/><path d="M5 6v12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5V6M5 12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5"/></svg>;
    case "disk":     return <svg {...s}><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="2.5"/></svg>;
    case "cpu":      return <svg {...s}><rect x="6" y="6" width="12" height="12" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3"/></svg>;
    case "firmware": return <svg {...s}><rect x="6" y="6" width="12" height="12" rx="1.5"/><path d="M3 9h3M3 12h3M3 15h3M18 9h3M18 12h3M18 15h3M9 3v3M12 3v3M15 3v3M9 18v3M12 18v3M15 18v3"/></svg>;
    case "config":   return <svg {...s}><circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 0 0-.1-1.2l2-1.6-2-3.5-2.4.9a7 7 0 0 0-2.1-1.2L14 3h-4l-.4 2.4a7 7 0 0 0-2.1 1.2L5.1 5.7l-2 3.5 2 1.6A7 7 0 0 0 5 12c0 .4 0 .8.1 1.2l-2 1.6 2 3.5 2.4-.9a7 7 0 0 0 2.1 1.2L10 21h4l.4-2.4a7 7 0 0 0 2.1-1.2l2.4.9 2-3.5-2-1.6c.1-.4.1-.8.1-1.2Z"/></svg>;
    case "broadcast":return <svg {...s}><circle cx="12" cy="12" r="2"/><path d="M8.5 8.5a5 5 0 0 0 0 7M15.5 8.5a5 5 0 0 1 0 7M5 5a10 10 0 0 0 0 14M19 5a10 10 0 0 1 0 14"/></svg>;
    case "fan":      return <svg {...s}><circle cx="12" cy="12" r="2"/><path d="M12 10c0-3 1-6 3-6s2 2 1 4-3 2-4 2ZM12 14c0 3-1 6-3 6s-2-2-1-4 3-2 4-2ZM10 12c-3 0-6-1-6-3s2-2 4-1 2 3 2 4ZM14 12c3 0 6 1 6 3s-2 2-4 1-2-3-2-4Z"/></svg>;
    case "temp":     return <svg {...s}><path d="M14 4a2 2 0 0 0-4 0v9a4 4 0 1 0 4 0V4Z"/><circle cx="12" cy="17" r="1.5" fill="currentColor" stroke="none"/></svg>;
    case "vpn":      return <svg {...s}><path d="M3 12c4 0 4-6 9-6s5 6 9 6"/><path d="M3 12c4 0 4 6 9 6s5-6 9-6"/></svg>;
    case "bgp":      return <svg {...s}><circle cx="5" cy="6" r="1.6"/><circle cx="19" cy="12" r="1.6"/><circle cx="5" cy="18" r="1.6"/><path d="m6.5 6 11 5M6.5 18l11-7"/></svg>;
    case "stp":      return <svg {...s}><circle cx="12" cy="5" r="1.6"/><circle cx="5" cy="13" r="1.6"/><circle cx="12" cy="13" r="1.6"/><circle cx="19" cy="13" r="1.6"/><circle cx="8" cy="20" r="1.4"/><circle cx="16" cy="20" r="1.4"/><path d="M12 6.6V11.4M11 12 6 12M13 12l5 0M11.5 14l-3 4.5M12.5 14l3 4.5"/></svg>;
    case "stack":    return <svg {...s}><path d="m12 3-9 4 9 4 9-4-9-4ZM3 12l9 4 9-4M3 17l9 4 9-4"/></svg>;
    case "queue":    return <svg {...s}><rect x="3" y="9" width="3" height="6"/><rect x="8" y="9" width="3" height="6"/><rect x="13" y="9" width="3" height="6"/><rect x="18" y="9" width="3" height="6"/></svg>;
    case "wan":      return <svg {...s}><circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c3 3 3 14 0 17M12 3.5c-3 3-3 14 0 17"/></svg>;
    case "psu":      return <svg {...s}><rect x="3" y="6" width="18" height="12" rx="2"/><path d="m11 9-3 4h4l-2 4 4-5h-4l2-3Z" fill="currentColor" stroke="none"/></svg>;
    case "maint":    return <svg {...s}><path d="m6 14 8-8a4 4 0 0 1 4-4l1 1-3 3 1 1 3-3 1 1a4 4 0 0 1-4 4l-8 8a2 2 0 0 1-3-3Z"/></svg>;
    case "abuse":    return <svg {...s}><circle cx="12" cy="12" r="9"/><path d="M8 8l8 8M16 8l-8 8"/></svg>;
    case "flap":     return <svg {...s}><path d="M3 12h3l2-4 2 8 2-6 2 6 2-8 2 4h3"/></svg>;
    case "lockout":  return <svg {...s}><rect x="6" y="11" width="12" height="8" rx="1.4"/><path d="M9 11V8a3 3 0 0 1 6 0v3"/><path d="m15.5 16.5 4-4M19.5 16.5l-4-4"/></svg>;
    case "policy":   return <svg {...s}><path d="M6 3h10l4 4v14H6V3Z"/><path d="M16 3v4h4M9 12h8M9 16h8M9 8h4"/></svg>;
    case "byod":     return <svg {...s}><rect x="6" y="3" width="12" height="18" rx="2"/><path d="M11 18h2"/></svg>;
    case "onboard":  return <svg {...s}><circle cx="11" cy="9" r="3.4"/><path d="M4 20c1-3.6 4-5.4 7-5.4s6 1.8 7 5.4"/><path d="M19 6v6M16 9h6"/></svg>;
    case "rrm":      return <svg {...s}><circle cx="12" cy="12" r="2"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="8"/></svg>;
    case "mesh":     return <svg {...s}><circle cx="6" cy="6" r="1.6"/><circle cx="18" cy="6" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="6" cy="18" r="1.6"/><circle cx="18" cy="18" r="1.6"/><path d="m7.5 7 3 4M16.5 7l-3 4M7.5 17l3-4M16.5 17l-3-4"/></svg>;
    case "backup":   return <svg {...s}><rect x="4" y="4" width="16" height="6" rx="1.4"/><rect x="4" y="14" width="16" height="6" rx="1.4"/><path d="M8 7h.01M8 17h.01"/></svg>;
    case "interfere":return <svg {...s}><path d="M3 12c2-3 3-3 5 0s3 3 5 0 3-3 5 0M5 18l14-12"/></svg>;
    case "capacity": return <svg {...s}><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M4 14h16M9 14V8M14 14V11M19 14V6"/></svg>;
    case "roam":     return <svg {...s}><circle cx="7" cy="12" r="3"/><circle cx="17" cy="12" r="3"/><path d="M10 12h4M12 5v3M12 16v3"/></svg>;
    case "speed":    return <svg {...s}><path d="M4 16a8 8 0 1 1 16 0"/><path d="m13 11-2 5"/><circle cx="12" cy="16" r="1.2" fill="currentColor" stroke="none"/></svg>;
    case "reboot":   return <svg {...s}><path d="M4 12a8 8 0 1 1 2 5.3"/><path d="M3 17v-4h4"/></svg>;
    case "stream":   return <svg {...s}><rect x="3" y="6" width="18" height="12" rx="1.6"/><path d="M3 9h18M6 6V4M18 6V4"/><path d="m10 10 5 3-5 3z" fill="currentColor" stroke="none"/></svg>;
    case "quality":  return <svg {...s}><path d="m12 3 2.6 6 6.4.6-4.8 4.3 1.4 6.3L12 17l-5.6 3.2 1.4-6.3L3 9.6 9.4 9z"/></svg>;
    case "vlan":     return <svg {...s}><rect x="4" y="6" width="6" height="4" rx="1"/><rect x="14" y="6" width="6" height="4" rx="1"/><rect x="4" y="14" width="6" height="4" rx="1"/><rect x="14" y="14" width="6" height="4" rx="1"/><path d="M10 8h4M10 16h4M7 10v4M17 10v4"/></svg>;
    case "dhcp":     return <svg {...s}><path d="M4 12h6l2-3 2 6 2-3h4"/><circle cx="4" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="20" cy="12" r="1.2" fill="currentColor" stroke="none"/></svg>;
    case "radius":   return <svg {...s}><circle cx="12" cy="12" r="4"/><path d="M12 4v3M12 17v3M4 12h3M17 12h3M6.3 6.3l2.1 2.1M15.6 15.6l2.1 2.1M6.3 17.7l2.1-2.1M15.6 8.4l2.1-2.1"/></svg>;
    case "recording":return <svg {...s}><circle cx="12" cy="12" r="4" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="8"/></svg>;
    case "wifi":     return <svg {...s}><path d="M3 9.5a13 13 0 0 1 18 0M6 13a8.5 8.5 0 0 1 12 0M9 16.5a4 4 0 0 1 6 0"/><circle cx="12" cy="20" r="1.2" fill="currentColor" stroke="none"/></svg>;
    case "ospf":     return <svg {...s}><circle cx="6" cy="6" r="1.6"/><circle cx="18" cy="6" r="1.6"/><circle cx="6" cy="18" r="1.6"/><circle cx="18" cy="18" r="1.6"/><circle cx="12" cy="12" r="1.6"/><path d="m7.5 7 3 3.5M16.5 7l-3 3.5M7.5 17l3-3.5M16.5 17l-3-3.5"/></svg>;
    case "alert":    return <svg {...s}><path d="M12 3 2 21h20L12 3Z"/><path d="M12 10v5M12 17v.2"/></svg>;
    case "tag":      return <svg {...s}><path d="M12 3H5v7l11 11 7-7L12 3Z"/><circle cx="8" cy="7" r="1" fill="currentColor" stroke="none"/></svg>;
    default: return null;
  }
};

const SrcMark = ({ src }) => {
  const colors = { zbx: "#ff6b67", pf: "#8a7cff", ext: "#56c4ff" };
  return <span className="pt-src" style={{ color: colors[src] || "var(--muted)" }}>{(src || "?").toUpperCase()}</span>;
};

// ───────── Host class & tag classifiers ─────────
// Substring match on the host group name (Zabbix-side) since real install
// groups don't follow the design's "wireless/" prefix convention.
const classifyHost = (e) => {
  const g = (e.group || "").toLowerCase();
  const h = (e.host  || "").toLowerCase();
  if (/wireless|access\s*point|\bap\b|wifi|xiq/.test(g) || /^ap[-_]|xiq_ap/.test(h)) return "ap";
  if (/switch|exos|extreme/.test(g)) return "switch";
  if (/camera/.test(g))     return "camera";
  if (/nvr|milestone|xprotect|video/.test(g)) return "nvr";
  if (/identity|packetfence|pf/.test(g))      return "identity";
  if (/server|linux|windows/.test(g)) return "server";
  return "server";
};

const HOST_ICON = {
  ap: "ap", switch: "switch", server: "server",
  nvr: "nvr", camera: "camera", identity: "identity"
};

// Map a tag (string of "tag" or "tag:value") to a glyph name.
const TAG_GLYPH_TABLE = {
  outage: "outage", core: "stack", uplink: "uplink", wan: "wan",
  port: "port", flap: "flap", poe: "poe", sfp: "optic", optic: "optic",
  radio: "radio", interference: "interfere", capacity: "capacity",
  roam: "roam", mesh: "mesh", rrm: "rrm", coverage: "rrm", ap: "ap",
  camera: "camera", reboot: "reboot", stream: "stream", quality: "quality",
  nvr: "nvr", recording: "recording",
  db: "db", disk: "disk", slowq: "speed", replication: "db", backup: "backup",
  auth: "auth", "802.1x": "auth", radius: "radius", "auth-fail": "lockout", lockout: "lockout",
  portal: "broadcast", abuse: "abuse",
  policy: "policy", dhcp: "dhcp", quar: "shield", byod: "byod", vlan: "vlan",
  onboard: "onboard", new: "onboard",
  config: "config", change: "config", firmware: "firmware", drift: "firmware",
  "maint-win": "maint", auto: "config", maintenance: "maint",
  psu: "psu", power: "psu", env: "temp", temp: "temp",
  temperature: "temp", fan: "fan", dc: "server", pdu: "psu",
  bgp: "bgp", ospf: "ospf", stp: "stp", instability: "flap",
  security: "shield", l2: "broadcast", broadcast: "broadcast", mac: "tag",
  cluster: "stack", ha: "stack", legacy: "byod", deauth: "lockout",
  bp: "config", clients: "byod", controller: "stack", anchor: "stack",
  rekey: "auth", vpn: "vpn", l3: "wan", proxy: "queue", queue: "queue",
  cpu: "cpu", memory: "cpu",
  speed: "speed", link: "uplink", neighbor: "bgp", topology: "stp",
  status: "config", environmental: "temp",
  application: "config", scope: "tag"
};
const tagKey = (t) => (t.split(":")[0] || "").toLowerCase();
const TAG_GLYPH = (t) => TAG_GLYPH_TABLE[tagKey(t)];

// ───────── Helpers ─────────
const nowSecs = () => Math.floor(Date.now() / 1000);
const ageMinutes = (e) => Math.max(0, Math.floor((nowSecs() - (e.clock || nowSecs())) / 60));
const ageFraction = (e) => Math.min(1, ageMinutes(e) / (6 * 60));
const counts = (arr, fn) => {
  const o = {};
  arr.forEach(x => { const k = fn(x); o[k] = (o[k] || 0) + 1; });
  return o;
};

// rawSev from backend ("ok" means resolved). For grouping/coloring use rawSev
// when present, fall back to sev.
const sevOf = (e) => (e.rawSev || e.sev || "info");

// ───────── Severity totem strip ─────────
const SeverityTotem = ({ problems, active, setActive }) => {
  const bySev = counts(problems, p => sevOf(p));
  const byHr  = Array(6).fill(0).map(() => ({ disaster: 0, high: 0, warning: 0, info: 0, ok: 0 }));
  problems.forEach(p => {
    const idx = Math.min(5, Math.floor(ageMinutes(p) / 60));
    const s   = sevOf(p);
    byHr[idx][s] = (byHr[idx][s] || 0) + 1;
  });

  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div className="prb-totem">
        {SEV_KEYS.map(sev => {
          const n = bySev[sev] || 0;
          const max = Math.max(1, ...byHr.map(h => h[sev]));
          return (
            <div
              key={sev}
              className={"prb-totem-cell sev-" + (sev === "warning" ? "warn" : sev) + "-c" + (active === sev ? " active" : "")}
              onClick={() => setActive(active === sev ? null : sev)}
            >
              <div className="prb-totem-row">
                <div className="prb-totem-glyph">
                  <Glyph
                    name={sev === "disaster" || sev === "high" ? "alert" :
                          sev === "warning"  ? "config" :
                          sev === "info"     ? "broadcast" : "st-resolved"}
                    size={16}
                  />
                </div>
                <span className="prb-totem-val">{n}</span>
              </div>
              <div className="prb-totem-spark">
                {byHr.map((h, i) => (
                  <span key={i} style={{ height: `${(h[sev] / max) * 100}%` }} />
                ))}
              </div>
              <div className="prb-totem-foot">
                <span><b>{SEV_LABEL[sev]}</b></span>
                <span style={{ marginLeft: "auto" }}>6h</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

// ───────── Site × Category matrix ─────────
const HOST_CLASSES = [
  { id: "ap",       icon: "ap",       label: "Wireless APs" },
  { id: "switch",   icon: "switch",   label: "Switches" },
  { id: "server",   icon: "server",   label: "Servers" },
  { id: "nvr",      icon: "nvr",      label: "NVR" },
  { id: "camera",   icon: "camera",   label: "Cameras" },
  { id: "identity", icon: "identity", label: "Identity" }
];

const SiteMatrix = ({ problems }) => {
  const sitesSet = new Set(problems.map(p => p.site).filter(s => s && s !== "—"));
  const sites = Array.from(sitesSet).sort();
  const cellMap = {};
  problems.forEach(p => {
    if (!p.site || p.site === "—") return;
    const k = `${p.site}|${classifyHost(p)}`;
    const cur = cellMap[k];
    const ps = sevOf(p);
    if (!cur) cellMap[k] = { count: 1, worstSev: ps };
    else {
      cur.count++;
      if (SEV_ORDER[ps] > SEV_ORDER[cur.worstSev]) cur.worstSev = ps;
    }
  });

  const gridTpl = `28px repeat(${HOST_CLASSES.length}, 1fr)`;
  return (
    <div className="prb-matrix-card">
      <div className="ch">
        <h3>Sites × Categories</h3>
        <span className="h-meta">{sites.length} sites · {HOST_CLASSES.length} classes</span>
      </div>
      <div className="matrix-grid" style={{ gridTemplateColumns: gridTpl }}>
        <div className="mg-corner" />
        {HOST_CLASSES.map(c => (
          <div key={c.id} className="mg-col-head" title={c.label}>
            <Glyph name={c.icon} size={16} />
          </div>
        ))}
        {sites.map(site => (
          <React.Fragment key={site}>
            <div className="mg-row-head">{site}</div>
            {HOST_CLASSES.map(c => {
              const cell = cellMap[`${site}|${c.id}`];
              if (!cell) return <div key={c.id} className="mg-cell empty" />;
              return (
                <div key={c.id} className="mg-cell">
                  <span className={"mg-dot sev-" + (cell.worstSev === "warning" ? "warn" : cell.worstSev)}>
                    {cell.count > 1 ? cell.count : ""}
                  </span>
                  <span className="mg-tip">{site} · {c.label} · {cell.count} · worst: {SEV_LABEL[cell.worstSev]}</span>
                </div>
              );
            })}
          </React.Fragment>
        ))}
        {sites.length === 0 && (
          <div style={{ gridColumn: "1 / -1", padding: 24, textAlign: "center", color: "var(--muted)", fontSize: 12 }}>
            No site groups assigned. Tag hosts with a "Site/&lt;name&gt;" host group to populate this matrix.
          </div>
        )}
      </div>
      <div className="prb-legend">
        <span className="lg-row"><span className="lg-sw" style={{ background: SEV_COLOR.disaster }} /> Disaster</span>
        <span className="lg-row"><span className="lg-sw" style={{ background: SEV_COLOR.high }} /> High</span>
        <span className="lg-row"><span className="lg-sw" style={{ background: SEV_COLOR.warning }} /> Warning</span>
        <span className="lg-row"><span className="lg-sw" style={{ background: SEV_COLOR.info }} /> Info</span>
        <span className="lg-row" style={{ marginLeft: "auto" }}>Number on dot = problem count · color = worst severity</span>
      </div>
    </div>
  );
};

// ───────── Constellation (site × age) ─────────
const Constellation = ({ problems }) => {
  const sites = Array.from(new Set(problems.map(p => p.site).filter(s => s && s !== "—"))).sort();
  const maxAge = 6 * 60;
  const sitePos = (site) => {
    const i = sites.indexOf(site);
    if (i < 0) return 50;
    return ((i + 0.5) / Math.max(1, sites.length)) * 100;
  };
  const agePos = (e) => Math.min(0.96, ageMinutes(e) / maxAge) * 100;
  const yTicks = ["just now", "1h", "2h", "3h", "4h+"];

  return (
    <div className="prb-matrix-card">
      <div className="ch">
        <h3>Constellation — site × age</h3>
        <span className="h-meta">{problems.length} active</span>
      </div>
      <div style={{ position: "relative", paddingLeft: 32, paddingBottom: 20 }}>
        <div className="prb-constel">
          <div className="prb-constel-y">
            {yTicks.map((t, i) => <span key={i}>{t}</span>)}
          </div>
          <div className="prb-constel-axis">
            {sites.filter((_, i) => i % Math.max(1, Math.ceil(sites.length / 10)) === 0).map(s => (
              <span key={s}>{s}</span>
            ))}
          </div>
          {problems.map(p => {
            const s   = sevOf(p);
            const sev = s === "warning" ? "warn" : s;
            const left = (p.site && p.site !== "—") ? sitePos(p.site) : 50;
            const top  = agePos(p);
            const size = s === "disaster" ? 18 : s === "high" ? 15 : s === "warning" ? 12 : 10;
            return (
              <span
                key={p.id}
                className={"constel-dot sev-" + sev + " status-" + p.status}
                style={{ left: `${left}%`, top: `${top}%`, width: size, height: size }}
              >
                <span className="constel-tip">
                  <b style={{ color: SEV_COLOR[s] }}>{SEV_LABEL[s]}</b> · {p.site || "—"}<br />
                  {p.host}<br />
                  {p.trigger}
                </span>
              </span>
            );
          })}
        </div>
      </div>
    </div>
  );
};

// ───────── Problem tile (icon-only) ─────────
const ProblemTile = ({ p, onClick }) => {
  const s = sevOf(p);
  const sevCls    = "sev-" + s;
  const statusCls = "status-" + p.status;
  const sevColor  = SEV_COLOR[s];
  const hostClass = classifyHost(p);
  const ageFrac   = ageFraction(p);

  const tagGlyphs = [];
  for (const t of (p.tags || [])) {
    const g = TAG_GLYPH(t);
    if (g && !tagGlyphs.find(x => x.g === g)) {
      tagGlyphs.push({ t, g });
      if (tagGlyphs.length === 3) break;
    }
  }

  const statusIcon = p.status === "open" ? "st-open" :
                     p.status === "ack"  ? "st-ack" :
                     p.status === "suppressed" ? "st-suppressed" : "st-resolved";

  return (
    <div className={"ptile " + sevCls + " " + statusCls} onClick={() => onClick(p)}>
      <div className="ptile-top">
        <span className="pt-icon-sm"><Glyph name={HOST_ICON[hostClass]} size={16} /></span>
        <SrcMark src={p.source} />
        {p.count > 1 && <span className="pt-count-inline">×{p.count}</span>}
        <span style={{ flex: 1 }} />
        <span className={"pt-status " + p.status}>
          <Glyph name={statusIcon} size={11} />
        </span>
      </div>
      <div className="ptile-body">
        <div className="pt-trigger" title={p.trigger}>{p.trigger}</div>
        <div className="pt-host" title={p.host}>{p.host}</div>
      </div>
      {tagGlyphs.length > 0 && (
        <div className="ptile-tags-row">
          {tagGlyphs.map((tg, i) => (
            <span className="ptag" key={i} title={tg.t}>
              <Glyph name={tg.g} size={11} />
            </span>
          ))}
        </div>
      )}
      <div className="ptile-bot">
        <span className="pt-site">{p.site || "—"}</span>
        <span className="pt-age-text" title={"Age " + p.age}>{p.age}</span>
        <span className="pt-age-wrap" title={"Age " + p.age}>
          <span className="pt-age-bar" style={{ width: `${ageFrac * 100}%` }} />
        </span>
        {p.owner ? (
          p.owner === "system"
            ? <span className="pt-owner-dot system" title="System">·</span>
            : <span className="pt-owner-dot" title={p.owner}>{p.owner[0].toUpperCase()}</span>
        ) : null}
      </div>

      <div className="ptile-tip">
        <div className="tip-h">
          <Glyph name={HOST_ICON[hostClass]} size={14} />
          <span className="tip-host">{p.host}</span>
        </div>
        <div className="tip-trigger">{p.trigger}</div>
        <div className="tip-meta">
          <span style={{ color: sevColor }}>{SEV_LABEL[s]}</span>
          <span>{STATUS_LABEL[p.status]}</span>
          {p.site && <span>{p.site}</span>}
          <span>age {p.age}</span>
          {p.owner && <span>@{p.owner}</span>}
        </div>
      </div>
    </div>
  );
};

// ───────── Toolbar ─────────
const Toolbar = ({ view, setView, sevFilter, toggleSev, search, setSearch, problems, groupBy, setGroupBy }) => {
  const bySev = counts(problems, p => sevOf(p));
  return (
    <div className="prb-toolbar">
      <div className="seg-pick">
        <button className={view === "mosaic" ? "active" : ""} onClick={() => setView("mosaic")}>
          <Glyph name="capacity" size={12} /> Mosaic
        </button>
        <button className={view === "constel" ? "active" : ""} onClick={() => setView("constel")}>
          <Glyph name="rrm" size={12} /> Constellation
        </button>
        <button className={view === "matrix" ? "active" : ""} onClick={() => setView("matrix")}>
          <Glyph name="vlan" size={12} /> Matrix only
        </button>
      </div>

      <div className="sev-filter-row">
        {SEV_KEYS.map(sev => (
          <span
            key={sev}
            className={"sev-pill " + (sev === "warning" ? "warning" : sev) + (sevFilter.length && !sevFilter.includes(sev) ? " muted" : "")}
            onClick={() => toggleSev(sev)}
          >
            <span className="sev-pill-dot" />
            <span className="sev-pill-n">{bySev[sev] || 0}</span>
          </span>
        ))}
      </div>

      <div className="prb-search-mini">
        <Icon name="search" size={12} />
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="host / tag / site…"
        />
      </div>

      <div style={{ flex: 1 }} />

      <div className="seg-pick">
        <button className={groupBy === "severity" ? "active" : ""} onClick={() => setGroupBy("severity")}>Severity</button>
        <button className={groupBy === "site"     ? "active" : ""} onClick={() => setGroupBy("site")}>Site</button>
        <button className={groupBy === "category" ? "active" : ""} onClick={() => setGroupBy("category")}>Category</button>
        <button className={groupBy === "source"   ? "active" : ""} onClick={() => setGroupBy("source")}>Source</button>
        <button className={groupBy === "none"     ? "active" : ""} onClick={() => setGroupBy("none")}>Flat</button>
      </div>
    </div>
  );
};

// ───────── Mosaic ─────────
const Mosaic = ({ problems, groupBy, onPick }) => {
  if (problems.length === 0) {
    return (
      <div className="prb-empty">
        <Glyph name="st-resolved" size={48} />
        <div>No active problems match the current filters.</div>
      </div>
    );
  }

  const keyer = groupBy === "severity" ? p => sevOf(p) :
                groupBy === "site"     ? p => p.site || "—" :
                groupBy === "category" ? p => classifyHost(p) :
                groupBy === "source"   ? p => p.source || "—" : null;

  const groupLabel = (g) => {
    if (groupBy === "severity") return SEV_LABEL[g] || g;
    if (groupBy === "category") return HOST_CLASSES.find(c => c.id === g)?.label || g;
    if (groupBy === "source")   return SOURCE_LABEL[g] || g;
    return g;
  };

  const sortPs = (a, b) => {
    const sa = sevOf(a), sb = sevOf(b);
    if (SEV_ORDER[sb] !== SEV_ORDER[sa]) return SEV_ORDER[sb] - SEV_ORDER[sa];
    return ageMinutes(a) - ageMinutes(b);
  };

  let groups;
  if (keyer) {
    const map = {};
    problems.forEach(p => { const k = keyer(p); (map[k] = map[k] || []).push(p); });
    groups = Object.entries(map);
    if (groupBy === "severity") {
      groups.sort((a, b) => SEV_ORDER[b[0]] - SEV_ORDER[a[0]]);
    } else {
      groups.sort((a, b) => b[1].length - a[1].length);
    }
  } else {
    groups = [["all", [...problems].sort(sortPs)]];
  }

  return (
    <div className="prb-mosaic-wrap">
      <div className="prb-mosaic-h">
        <h3>Active problems</h3>
        <span className="h-meta">{problems.length} tiles · grouped by {groupBy}</span>
      </div>

      {groups.map(([gKey, gPs]) => {
        const sevMix = counts(gPs, p => sevOf(p));
        const total = gPs.length;
        return (
          <div className="prb-group" key={gKey}>
            {groupBy !== "none" && (
              <div className="prb-group-h">
                <span className="gh-key">{groupLabel(gKey)}</span>
                <span className="gh-n">{gPs.length}</span>
                <span className="gh-bar">
                  {SEV_KEYS.map(s => {
                    const n = sevMix[s];
                    if (!n) return null;
                    return <span key={s} style={{ background: SEV_COLOR[s], flex: n / total }} />;
                  })}
                </span>
              </div>
            )}
            <div className="prb-mosaic">
              {gPs.sort(sortPs).map(p => <ProblemTile key={p.id} p={p} onClick={onPick} />)}
            </div>
          </div>
        );
      })}
    </div>
  );
};

// ───────── Drawer (reuses styling from events.css) ─────────
const Drawer = ({ event, onClose }) => {
  if (!event) return null;
  const s = sevOf(event);
  const hostClass = classifyHost(event);
  const timeline = [
    { t: event.ts, msg: `Event opened by ${(event.source || "zbx").toUpperCase()}`, who: "system" },
    ...(event.count > 1 ? [{ t: event.ts, msg: `Recurrence ×${event.count}`, who: "system" }] : []),
    ...(event.status === "ack" ? [{ t: event.ts, msg: `Acknowledged`, who: event.owner || "operator" }] : []),
    ...(event.status === "suppressed" ? [{ t: event.ts, msg: `Suppressed for maintenance window`, who: event.owner || "system" }] : [])
  ];
  return (
    <div className="evt-drawer open">
      <div className="drawer-h">
        <span style={{ color: SEV_COLOR[s], display: "inline-flex" }}><Glyph name={HOST_ICON[hostClass]} size={20} /></span>
        <h3>{event.id}</h3>
        <span className={"ev-status " + event.status}>{STATUS_LABEL[event.status]}</span>
        <div className="h-spacer" />
        <span className="icon-btn" onClick={onClose}><Icon name="close" /></span>
      </div>
      <div className="drawer-b">
        <div className="drawer-section">
          <div className="drawer-trigger" style={{ borderLeft: `3px solid ${SEV_COLOR[s]}`, paddingLeft: 10 }}>
            {event.trigger}
          </div>
          {event.tags && event.tags.length > 0 && (
            <span className="ev-tags">
              {event.tags.map((t, i) => <span key={i} className="ev-tag">{t}</span>)}
            </span>
          )}
        </div>
        <div className="drawer-section">
          <h4>Identification</h4>
          <div className="drawer-meta-grid">
            <span className="k">Severity</span>   <span className="v" style={{ color: SEV_COLOR[s] }}>{SEV_LABEL[s]}</span>
            <span className="k">Source</span>     <span className="v"><SourceBadge src={event.source} /> {SOURCE_LABEL[event.source]}</span>
            <span className="k">Host</span>       <span className="v">{event.host}</span>
            <span className="k">Site</span>       <span className="v">{event.site || "—"}</span>
            <span className="k">Class</span>      <span className="v">{event.group}</span>
            <span className="k">Owner</span>      <span className="v">{event.owner || <span style={{color:"var(--muted)"}}>unassigned</span>}</span>
            <span className="k">Count</span>      <span className="v">×{event.count}</span>
          </div>
        </div>
        <div className="drawer-section">
          <h4>Timing</h4>
          <div className="drawer-meta-grid">
            <span className="k">Opened</span>   <span className="v">{event.tsFull || event.ts}</span>
            <span className="k">Age</span>      <span className="v">{event.age}</span>
            <span className="k">Duration</span> <span className="v">{event.duration}</span>
          </div>
        </div>
        <div className="drawer-section">
          <h4>Audit trail</h4>
          <div className="drawer-timeline">
            {timeline.map((t, i) => (
              <div className="t-row" key={i}>
                <span className="t-time">{t.t}</span>
                <span>{t.msg}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="drawer-actions">
        {event.status === "open" && <button className="btn primary"><Icon name="check" size={12} /> Acknowledge</button>}
        {event.status === "ack"  && <button className="btn"><Icon name="check" size={12} /> Resolve</button>}
        <button className="btn"><Icon name="lock" size={12} /> Suppress 1h</button>
        <div className="h-spacer" style={{ flex: 1 }} />
        <button className="btn ghost"><Icon name="external" size={12} /> Open host</button>
      </div>
    </div>
  );
};

// ───────── App ─────────
const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  view: "mosaic",
  size: "balanced",
  groupBy: "severity",
  showResolved: false,
  showSuppressed: false,
  showMatrix: true,
  showConstellation: true,
  density: "balanced"
}/*EDITMODE-END*/;

const useEventsTick = () => {
  const [tick, setTick] = React.useState(0);
  React.useEffect(() => {
    const onData = () => setTick(n => n + 1);
    window.addEventListener("tcs:events-data", onData);
    return () => window.removeEventListener("tcs:events-data", onData);
  }, []);
  return tick;
};

const ProblemsApp = () => {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
  const tick = useEventsTick();
  const [sevFilter, setSevFilter] = React.useState([]);
  const [search, setSearch] = React.useState(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      return params.get("site") || params.get("search") || "";
    } catch (e) { return ""; }
  });
  const [focused, setFocused] = React.useState(null);
  const [activeSev, setActiveSev] = React.useState(null);
  const [refreshing, setRefreshing] = React.useState(false);

  React.useEffect(() => {
    const onData = () => setRefreshing(false);
    window.addEventListener("tcs:events-data", onData);
    return () => window.removeEventListener("tcs:events-data", onData);
  }, []);

  const toggleSev = (sev) => {
    setSevFilter(f => f.includes(sev) ? f.filter(x => x !== sev) : [...f, sev]);
  };

  const doRefresh = () => {
    setRefreshing(true);
    if (typeof window.tcsEventsRefresh === "function") window.tcsEventsRefresh();
  };

  const allEvents = window.EV_EVENTS || [];

  const problems = React.useMemo(() => {
    let list = allEvents;
    if (!t.showResolved)   list = list.filter(e => e.status !== "resolved");
    if (!t.showSuppressed) list = list.filter(e => e.status !== "suppressed");
    if (activeSev)         list = list.filter(e => sevOf(e) === activeSev);
    if (sevFilter.length)  list = list.filter(e => sevFilter.includes(sevOf(e)));
    if (search) {
      const q = search.toLowerCase();
      list = list.filter(e =>
        e.host.toLowerCase().includes(q) ||
        (e.site || "").toLowerCase().includes(q) ||
        e.trigger.toLowerCase().includes(q) ||
        (e.tags || []).some(x => x.toLowerCase().includes(q))
      );
    }
    return list;
  }, [allEvents, t.showResolved, t.showSuppressed, activeSev, sevFilter, search, tick]);

  const totalOpen = allEvents.filter(e => e.status === "open").length;
  const totalAck  = allEvents.filter(e => e.status === "ack").length;
  const worstSev  = (() => {
    for (const k of SEV_KEYS) {
      if (problems.some(e => sevOf(e) === k && e.status !== "resolved")) return k;
    }
    return "ok";
  })();

  return (
    <div className="app" data-density={t.density} data-size={t.size} data-screen-label="Problems">
      <GlobalSidebar active="problems" />
      <div className="main">
        <GlobalTopbar crumb={["Operations", "Problems"]} onRefresh={doRefresh} refreshing={refreshing} />

        <div className="prb-header">
          <div style={{ flex: 1 }}>
            <div className="host-title">
              <h1>Problems</h1>
              <span className="role-tag faculty" style={{ fontSize: 10, padding: "1px 8px" }}>VISUAL</span>
              <span className="live-pill"><span className="live-dot" /> Live · 30s</span>
            </div>
            <div className="prb-header-meta">
              <span className="pill"><span className="lbl">Sources</span> <SourceBadge src="zbx" /></span>
              <span className="pill"><span className="lbl">Active</span> <span className="v">{problems.length}</span></span>
              <span className="pill"><span className="lbl">Open</span> <span className="v" style={{ color: "var(--err)" }}>{totalOpen}</span></span>
              <span className="pill"><span className="lbl">Acknowledged</span> <span className="v">{totalAck}</span></span>
              <span className="pill"><span className="lbl">Worst</span> <span className="v" style={{ color: SEV_COLOR[worstSev] }}>{SEV_LABEL[worstSev]}</span></span>
            </div>
          </div>
        </div>

        <div className="body">
          <SeverityTotem
            problems={allEvents.filter(e => t.showResolved ? true : e.status !== "resolved").filter(e => t.showSuppressed ? true : e.status !== "suppressed")}
            active={activeSev}
            setActive={setActiveSev}
          />

          {(t.showMatrix || t.showConstellation) && t.view !== "matrix-only" && (
            <div className="prb-matrix-wrap" style={!t.showMatrix || !t.showConstellation ? { gridTemplateColumns: "1fr" } : null}>
              {t.showMatrix && <SiteMatrix problems={problems} />}
              {t.showConstellation && <Constellation problems={problems} />}
            </div>
          )}

          <Toolbar
            view={t.view}
            setView={v => setTweak("view", v)}
            sevFilter={sevFilter}
            toggleSev={toggleSev}
            search={search}
            setSearch={setSearch}
            problems={problems}
            groupBy={t.groupBy}
            setGroupBy={v => setTweak("groupBy", v)}
          />

          {t.view === "mosaic" && <Mosaic problems={problems} groupBy={t.groupBy} onPick={setFocused} />}
          {t.view === "constel" && (
            <div className="prb-mosaic-wrap">
              <Constellation problems={problems} />
            </div>
          )}
          {t.view === "matrix" && (
            <div className="prb-mosaic-wrap">
              <SiteMatrix problems={problems} />
            </div>
          )}
        </div>
      </div>

      {focused && <Drawer event={focused} onClose={() => setFocused(null)} />}

      <TweaksPanel title="Tweaks">
        <TweakSection title="Layout">
          <TweakRadio label="Main view" value={t.view} options={[
            { value: "mosaic",  label: "Mosaic" },
            { value: "constel", label: "Swarm" },
            { value: "matrix",  label: "Matrix" }
          ]} onChange={v => setTweak("view", v)} />
          <TweakRadio label="Tile size" value={t.size} options={[
            { value: "dense",    label: "Dense" },
            { value: "balanced", label: "Balanced" },
            { value: "large",    label: "Large" }
          ]} onChange={v => setTweak("size", v)} />
          <TweakSelect label="Group tiles by" value={t.groupBy} options={[
            { value: "severity", label: "Severity" },
            { value: "site",     label: "Site" },
            { value: "category", label: "Category" },
            { value: "source",   label: "Source" },
            { value: "none",     label: "Flat (no grouping)" }
          ]} onChange={v => setTweak("groupBy", v)} />
        </TweakSection>
        <TweakSection title="Visible widgets">
          <TweakToggle label="Site × category matrix" value={t.showMatrix}         onChange={v => setTweak("showMatrix", v)} />
          <TweakToggle label="Constellation swarm"    value={t.showConstellation}  onChange={v => setTweak("showConstellation", v)} />
        </TweakSection>
        <TweakSection title="Include">
          <TweakToggle label="Resolved"   value={t.showResolved}   onChange={v => setTweak("showResolved", v)} />
          <TweakToggle label="Suppressed" value={t.showSuppressed} onChange={v => setTweak("showSuppressed", v)} />
        </TweakSection>
      </TweaksPanel>
    </div>
  );
};

ReactDOM.createRoot(document.getElementById("root")).render(<ProblemsApp />);
