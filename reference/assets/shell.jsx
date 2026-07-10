// Main app shell — sidebar now lives in global-nav.jsx (unified across all pages)
const Sidebar = ({ tab, setTab }) => <GlobalSidebar active="wireless" />;

const Topbar = ({ activeAp }) => {
  const h = window.ZBX_HOST || {};
  const site  = (activeAp && activeAp.site)  || h.site  || "—";
  const floor = (activeAp && activeAp.floor) || h.floor || "—";
  const id    = (activeAp && activeAp.id)    || h.visible_name || h.host || "—";
  return (
  <div className="topbar">
    <div className="icon-btn" title="Back"><Icon name="back" /></div>
    <div className="crumb">
      <span>Wireless APs</span>
      <span className="sep">/</span>
      <span>{site}</span>
      <span className="sep">/</span>
      <span>{floor}</span>
      <span className="sep">/</span>
      <span className="seg">{id}</span>
    </div>
    <div className="spacer" />
    <div className="search">
      <Icon name="search" />
      <input placeholder="Find host, MAC, user, IP…" readOnly />
      <kbd>⌘K</kbd>
    </div>
    <div className="icon-btn" title="Refresh"><Icon name="refresh" /></div>
    <div className="icon-btn" title="More"><Icon name="more" /></div>
  </div>
  );
};

const PageHeader = ({ timeRange, setTimeRange, host }) => (
  <div className="page-header">
    <div className="icon-btn" style={{ marginTop: 4 }}><Icon name="back" /></div>
    <div style={{ flex: 1 }}>
      <div className="host-title">
        <h1>{host.host}</h1>
        <span className="ip">{host.ip}</span>
        <span className="role-tag faculty" style={{ fontSize: 10, padding: "1px 8px" }}>{host.model || "AP_305C"}</span>
      </div>
      <div className="host-meta">
        <span className="pill"><span className="dot" style={{ background: host.apStatus === "down" ? "var(--err)" : host.apStatus === "warn" ? "var(--warn)" : "var(--ok)" }} /> {host.apStatus === "down" ? "Unreachable" : host.apStatus === "warn" ? "Degraded" : "Connected"}</span>
        <span className="pill"><span className="lbl">Active since</span> <span className="v">{fmtUptime(host.uptime)}</span></span>
        <span className="pill"><span className="lbl">Site</span> <span>{host.site || "—"}{host.floor ? ` · ${host.floor}` : ""}</span></span>
        <span className="pill"><span className="lbl">Clients</span> <span className="v">{(host.clients ?? 0).toLocaleString()}</span></span>
        <span className="pill"><span className="lbl">Zabbix Host ID</span> <span className="v">{host.hostid || "—"}</span></span>
        {host.proxy && <span className="pill"><span className="lbl">Polled via</span> <span>{host.proxy}</span></span>}
      </div>
    </div>
    <div className="timerange">
      <Icon name="calendar" />
      <span className="range-val">{timeRange}</span>
      <Icon name="chevron" />
    </div>
  </div>
);

const Tabs = ({ tab, setTab }) => {
  // Re-read globals on every render so the badges follow live refreshes
  // dispatched by data-bridge.jsx.
  const clientCount  = Array.isArray(window.PF_CLIENTS) ? window.PF_CLIENTS.length : 0;
  const wiredCount   = Array.isArray(window.WIRED_PORTS) ? window.WIRED_PORTS.length : 0;
  const ssidCount    = Array.isArray(window.SSIDS) ? window.SSIDS.length : 0;
  const eventCount   = Array.isArray(window.ZBX_EVENTS) ? window.ZBX_EVENTS.filter(e => e && e.value === 1).length : 0;
  const A            = window.ALERTS_DETAIL || {};
  const triggerCount = Array.isArray(A.activeTriggers) ? A.activeTriggers.length : 0;

  const tabs = [
    ["overview", "Overview",      null,                         null],
    ["wireless", "Wireless",      ssidCount    > 0 ? ssidCount    : null, null],
    ["wired",    "Wired",         wiredCount   > 0 ? wiredCount   : null, null],
    ["clients",  "Clients",       clientCount  > 0 ? clientCount  : null, null],
    ["events",   "Events",        eventCount   > 0 ? eventCount   : null, eventCount   > 0 ? "warn" : null],
    ["alerts",   "Alerts",        triggerCount > 0 ? triggerCount : null, triggerCount > 0 ? "err"  : null],
    ["graphs",   "Graphs",        null, null],
    ["latest",   "Latest Data",   null, null],
    ["config",   "Configuration", null, null],
  ];
  return (
    <div className="tabs">
      {tabs.map(([k, l, b, tone]) => (
        <div key={k} className={`tab ${tab === k ? "active" : ""}`} onClick={() => setTab(k)}>
          {l}
          {b !== null && b !== undefined && <span className={`badge${tone ? " "+tone : ""}`}>{b}</span>}
        </div>
      ))}
    </div>
  );
};

// Format an uptime in seconds (from Zabbix system.uptime) as "Nd HHh MMm".
const fmtUptime = (s) => {
  s = Number(s) || 0;
  if (s <= 0) return "—";
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${String(h).padStart(2,"0")}h ${String(m).padStart(2,"0")}m`;
  if (h > 0) return `${h}h ${String(m).padStart(2,"0")}m`;
  return `${m}m`;
};

// Three-source AP availability: XIQ cloud connected, SNMP reachable,
// ICMP ping responsive. The backend rolls these into host.apStatus, but
// fall back to local composition so a stale boot payload still renders.
const composeApState = (host) => {
  const xiq  = host.xiqConnected;
  const snmp = typeof host.snmpAvailable === "number" ? host.snmpAvailable : host.available;
  const ping = host.pingUp;
  let up = 0, down = 0, known = 0;
  const tally = (isUp, isDown) => { known += isUp || isDown ? 1 : 0; up += isUp; down += isDown; };
  tally(ping === 1, ping === 0);
  tally(snmp === 1, snmp === 2);
  tally(xiq  === 1, xiq  === 0);
  if (!known)     return "idle";
  if (down === 0) return "ok";
  if (up   === 0) return "down";
  return "warn";
};

const ApStatusPills = ({ xiqConnected, snmpAvailable, pingUp }) => {
  const cell = (label, val, downVal, title) => {
    const isUp   = val === 1;
    const isDown = val === downVal;
    const color  = isUp ? "var(--ok)" : isDown ? "var(--err)" : "var(--muted)";
    const text   = isUp ? "UP" : isDown ? "DOWN" : "—";
    return (
      <span className="ap-src-pill" title={title}>
        <span className="ap-src-lbl">{label}</span>
        <span className="ap-src-dot" style={{ background: color }} />
        <span className="ap-src-v" style={{ color }}>{text}</span>
      </span>
    );
  };
  return (
    <div className="ap-src-row">
      {cell("XIQ",  xiqConnected,  0, "XIQ cloud connectivity")}
      {cell("SNMP", snmpAvailable, 2, "Zabbix main-interface SNMP availability")}
      {cell("PING", pingUp,        0, "ICMP ping (Zabbix icmpping item)")}
    </div>
  );
};

const DeviceSidecar = ({ host }) => {
  // Prefer the backend-composed apStatus; fall back to local composition
  // so older boot payloads (without xiqConnected / pingUp) still render.
  const state = host.apStatus === "down" || host.apStatus === "warn"
              || host.apStatus === "ok"  || host.apStatus === "idle"
                ? host.apStatus
                : composeApState(host);
  const stateLabel = state === "ok"   ? "Connected"
                   : state === "warn" ? "Degraded"
                   : state === "down" ? "Unreachable"
                   : "Unknown";
  const stateColor = state === "ok"   ? "var(--ok)"
                   : state === "warn" ? "var(--warn)"
                   : state === "down" ? "var(--err)"
                   : "var(--muted)";

  const groups    = Array.isArray(host.groups)    ? host.groups    : [];
  const siteLine  = [host.site, host.floor].filter(Boolean).join(" · ");
  const uplink    = host.pfUplink || null;

  return (
    <div className="card device-card-h">
      <div className="dev-h-img">
        <svg width="56" height="56" viewBox="0 0 60 60">
          <ellipse cx="30" cy="46" rx="22" ry="4" fill="rgba(0,0,0,0.3)" />
          <rect x="6" y="22" width="48" height="20" rx="10" fill="#e8ecf4" />
          <rect x="6" y="22" width="48" height="6" rx="10" fill="#f4f7fc" />
          <circle cx="30" cy="32" r="3" fill="#181f2c" />
          <circle cx="30" cy="32" r="1" fill={stateColor} />
        </svg>
      </div>

      <div className="dev-h-id">
        <div className="device-name">{host.host || "—"}</div>
        <div className="status-line">
          <StatusDot state={state} />
          <span style={{ color: stateColor }}>{stateLabel}</span>
          <span className="muted" style={{ marginLeft: 6 }}>· uptime {fmtUptime(host.uptime)}</span>
          {host.configMismatch === 1 && (
            <span
              className="ap-config-chip"
              title="xiq.ap.configmismatch reports the running config does not match the assigned XIQ network policy"
            >
              <Icon name="alert" size={10} /> CONFIG DRIFT
            </span>
          )}
        </div>
        <ApStatusPills
          xiqConnected={host.xiqConnected}
          snmpAvailable={typeof host.snmpAvailable === "number" ? host.snmpAvailable : host.available}
          pingUp={host.pingUp}
        />
        <div className="dev-h-sub mono">
          {host.ip || "—"}{host.model ? ` · ${host.model}` : ""}
        </div>
      </div>

      <div className="dev-h-block">
        <div className="label">Location</div>
        <div className="v">
          {siteLine || "—"}
          {groups.length > 0 && (
            <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>
              {groups.slice(0, 2).join(" · ")}
            </div>
          )}
        </div>
      </div>

      <div className="dev-h-block">
        <div className="label">Clients</div>
        <div
          className="v"
          style={{
            fontFamily: "var(--mono)", fontSize: 18, fontWeight: 600,
            color: host.loadLevel === "high" ? "var(--err)"
                 : host.loadLevel === "warn" ? "var(--warn)"
                 : "var(--fg)",
            display: "flex", alignItems: "center", gap: 6
          }}
          title={
            host.loadLevel === "high" ? "HIGH client load · over 50 clients"
            : host.loadLevel === "warn" ? "Elevated client load · over 35 clients"
            : null
          }
        >
          {(host.clients ?? 0).toLocaleString()}
          {host.loadLevel === "high" && (
            <span className="role-tag guest" style={{ fontSize: 9, padding: "0 6px" }}>HIGH</span>
          )}
          {host.loadLevel === "warn" && (
            <span className="role-tag av"    style={{ fontSize: 9, padding: "0 6px" }}>WARN</span>
          )}
        </div>
      </div>

      <div className="dev-h-block dev-h-templates">
        <div className="label">Uplink <SourceBadge src="pf" /></div>
        <div className="v">
          {uplink ? (
            <>
              <span className="tpl-chip mono" title={uplink.switchIp ? `Switch IP: ${uplink.switchIp}` : "Switch (per PacketFence locationlog)"}>
                {uplink.switch || uplink.switchIp || "switch?"}
              </span>
              <span className="tpl-chip mono" title={uplink.ifDesc ? `ifDesc: ${uplink.ifDesc}` : "Port"}>
                {uplink.port || uplink.ifDesc || "port?"}
              </span>
            </>
          ) : (
            <span className="muted">not in PacketFence</span>
          )}
        </div>
      </div>

      <div className="dev-h-actions">
        <ApPfActionRow mac={host.mac || (uplink && uplink.mac) || ""} uplink={uplink} />
      </div>
    </div>
  );
};

// Per-AP PF write-actions + a "Cycle PoE" button that bounces the AP's
// upstream switch port. Mirrors ClientPfActionRow in tabs.jsx (View in
// PacketFence + Reevaluate access) with one extra action specific to
// wired APs. The upstream switch is the host PF's locationlog points
// at — its hostid is resolved server-side in collectPfApUplink.
const ApPfActionRow = ({ mac, uplink }) => {
  const [busy, setBusy] = React.useState(null);
  const [msg,  setMsg]  = React.useState({ kind: "", text: "" });

  // PF stores MACs lowercase colon-separated; force it here so callers
  // don't have to remember.
  const pfMac = String(mac || "").toLowerCase();
  const hasPf = !!pfMac;
  const adminBase = (window.PF_ADMIN_BASE || "").replace(/\/+$/, "");
  const viewHref = adminBase && pfMac
    ? `${adminBase}/admin/#/node/${encodeURIComponent(pfMac)}`
    : null;

  // ifIndex → "<member>:<port>". PF locationlog.port holds the SNMP
  // ifIndex (e.g. 5036 → member 5, port 36) — same encoding the
  // switches page's rConfig snippet expects.
  const portIdx = uplink && /^\d+$/.test(String(uplink.port || "").trim())
    ? parseInt(uplink.port, 10) : 0;
  const member  = portIdx > 0 ? Math.floor(portIdx / 1000) : 0;
  const portNum = portIdx > 0 ? portIdx % 1000 : 0;
  const switchHostid = (uplink && uplink.switchHostid) || "";
  const canCycle = !!(switchHostid && member && portNum);

  const runPf = React.useCallback(async (op, label) => {
    if (!pfMac || busy) return;
    if (typeof window.tcsPfDeviceAction !== "function") {
      setMsg({ kind: "err", text: "endpoint missing" });
      return;
    }
    setBusy(op);
    setMsg({ kind: "", text: `${label}…` });
    const r = await window.tcsPfDeviceAction(pfMac, op);
    setBusy(null);
    setMsg(r && r.ok
      ? { kind: "", text: r.message || "ok" }
      : { kind: "err", text: (r && (r.error || r.message)) || "failed" });
    setTimeout(() => setMsg({ kind: "", text: "" }), 6000);
  }, [pfMac, busy]);

  const runReboot = React.useCallback(async () => {
    if (busy) return;
    if (typeof window.tcsXiqRebootAp !== "function") {
      setMsg({ kind: "err", text: "endpoint missing" });
      return;
    }
    if (!window.confirm("Reboot this AP via XIQ? Clients will disassociate while it restarts.")) return;
    setBusy("xiq_reboot");
    setMsg({ kind: "", text: "rebooting…" });
    const r = await window.tcsXiqRebootAp();
    setBusy(null);
    setMsg(r && r.ok
      ? { kind: "", text: r.message || "reboot requested" }
      : { kind: "err", text: (r && (r.error || r.message)) || "failed" });
    setTimeout(() => setMsg({ kind: "", text: "" }), 8000);
  }, [busy]);

  const runCycle = React.useCallback(async () => {
    if (busy) return;
    if (typeof window.tcsCyclePoeOnSwitch !== "function") {
      setMsg({ kind: "err", text: "endpoint missing" });
      return;
    }
    if (!canCycle) {
      setMsg({ kind: "err", text: "no upstream port" });
      setTimeout(() => setMsg({ kind: "", text: "" }), 4000);
      return;
    }
    setBusy("cycle_poe");
    setMsg({ kind: "", text: "cycling…" });
    const r = await window.tcsCyclePoeOnSwitch(switchHostid, member, portNum);
    setBusy(null);
    setMsg(r && r.ok
      ? { kind: "", text: r.message || "queued" }
      : { kind: "err", text: (r && (r.error || r.message)) || "failed" });
    setTimeout(() => setMsg({ kind: "", text: "" }), 6000);
  }, [busy, canCycle, switchHostid, member, portNum]);

  return (
    <div className="ap-pf-actions">
      <div className="ap-pf-btns">
        {viewHref ? (
          <a className="pf-btn" href={viewHref} target="_blank" rel="noopener noreferrer">
            <Icon name="external" size={11}/> View in PacketFence
          </a>
        ) : (
          <span className="pf-btn" style={{ opacity: 0.4, cursor: "not-allowed" }} title="PF admin URL not configured">
            View in PacketFence
          </span>
        )}
        <button
          type="button"
          className="pf-btn"
          onClick={() => runPf("reevaluate_access", "reevaluating")}
          disabled={!!busy || !hasPf}
          title={hasPf
            ? "Re-run PF role / access evaluation for this AP (issues a CoA)"
            : "AP MAC not known — set the {$XIQ_MAC} macro"}
        >
          <Icon name="refresh" size={11}/> {busy === "reevaluate_access" ? "REEVALUATING…" : "Reevaluate access"}
        </button>
        <button
          type="button"
          className="pf-btn warn"
          onClick={runReboot}
          disabled={!!busy}
          title="Reboot this AP via XIQ (POST /devices/:reboot)"
        >
          <Icon name="refresh" size={11}/> {busy === "xiq_reboot" ? "REBOOTING…" : "Reboot AP"}
        </button>
        <button
          type="button"
          className="pf-btn warn"
          onClick={runCycle}
          disabled={!!busy || !canCycle}
          title={canCycle
            ? `Cycle PoE on ${uplink.switch || uplink.switchIp || "switch"} port ${member}:${portNum} via rConfig`
            : "Upstream switch/port not known — needs a PF locationlog entry on a Zabbix-monitored switch"}
        >
          <Icon name="refresh" size={11}/> {busy === "cycle_poe"
            ? "CYCLING…"
            : `Cycle PoE${canCycle ? ` ${member}:${portNum}` : ""}`}
        </button>
      </div>
      {msg.text && (
        <div className={"ap-pf-status" + (msg.kind === "err" ? " err" : "")}>
          {msg.text}
        </div>
      )}
    </div>
  );
};

// ───────── AP Host Navigator (left rail) ─────────
const APNavigator = ({ activeId, onSelect, query, setQuery }) => {
  // activeId may be a Zabbix hostid (preferred, set by the parent from
  // ZBX_HOST.hostid) or, for synthetic rows, an AP id string. Match
  // both so legacy callers keep working.
  const isActive = (ap) => {
    if (!activeId) return false;
    const s = String(activeId);
    if (ap.hostid && String(ap.hostid) === s) return true;
    return ap.id === activeId;
  };
  // "Problems" here means anything an operator would treat as not-OK:
  // a Zabbix trigger fired against the host, or the AP is down per
  // XIQ / SNMP / ICMP. Matches what the LED dot and the per-site
  // counters already signal in red.
  const hasProblem = (ap) => (ap.problems || 0) > 0 || ap.status === "down";
  // Start with every site collapsed except the one containing the active
  // AP. Search expands all matched sections regardless (handled below).
  const [sites, setSites] = React.useState(() =>
    (window.AP_SITES || []).map(s => ({
      ...s,
      expanded: Array.isArray(s.aps) && s.aps.some(isActive)
    }))
  );
  const [problemsOnly, setProblemsOnly] = React.useState(false);
  const toggle = (idx) => {
    setSites(sites.map((s, i) => i === idx ? { ...s, expanded: !s.expanded } : s));
  };
  const q = (query || "").trim().toLowerCase();
  const totalAps = window.AP_SITES.reduce((n, s) => n + s.aps.length, 0);
  const totalClients = window.AP_SITES.reduce((n, s) => n + s.aps.reduce((m, a) => m + a.clients, 0), 0);
  const totalProb = window.AP_SITES.reduce((n, s) => n + s.problems, 0);
  const totalIssues = window.AP_SITES.reduce((n, s) => n + s.aps.filter(hasProblem).length, 0);

  return (
    <div className="card ap-nav-card">
      <div className="card-h">
        <h3>AP Navigator</h3>
        <SourceBadge src="zbx" />
        <div className="h-spacer" />
        <span className="h-meta">{totalAps} APs</span>
      </div>
      <div className="ap-nav-search">
        <Icon name="search" size={12} />
        <input
          placeholder="Filter by id, ip, site…"
          value={query || ""}
          onChange={(e) => setQuery(e.target.value)}
          spellCheck={false}
        />
        {query ? <span className="ap-nav-clear" onClick={() => setQuery("")}>×</span> : null}
      </div>
      <div className="ap-nav-filter">
        <div className="seg-toggle">
          <button
            className={"seg-btn" + (!problemsOnly ? " active" : "")}
            onClick={() => setProblemsOnly(false)}
          >All {totalAps}</button>
          <button
            className={"seg-btn" + (problemsOnly ? " active" : "")}
            onClick={() => setProblemsOnly(true)}
            title="APs with active Zabbix triggers or unreachable (XIQ / SNMP / ping)"
          >Problems {totalIssues}</button>
        </div>
      </div>
      <div className="ap-nav-summary">
        <span><b>{totalClients.toLocaleString()}</b> clients</span>
        <span className="dot-sep">·</span>
        <span><b style={{color:"var(--ok)"}}>{totalAps - totalProb}</b> healthy</span>
        <span className="dot-sep">·</span>
        <span><b style={{color:"var(--warn)"}}>{totalProb}</b> with triggers</span>
      </div>
      <div className="ap-nav">
        {sites.map((site, i) => {
          let matchedAps = q
            ? site.aps.filter(a =>
                a.id.toLowerCase().includes(q) ||
                a.ip.toLowerCase().includes(q) ||
                a.floor.toLowerCase().includes(q) ||
                site.name.toLowerCase().includes(q))
            : site.aps;
          if (problemsOnly) matchedAps = matchedAps.filter(hasProblem);
          if ((q || problemsOnly) && matchedAps.length === 0) return null;
          // Auto-expand sites whose APs survived the filter so the
          // operator doesn't have to click into each one.
          const expanded = q || problemsOnly ? true : site.expanded;
          return (
            <div className="ap-nav-section" key={site.id}>
              <div
                className={"ap-nav-site" + (expanded ? "" : " collapsed")}
                onClick={() => !q && toggle(i)}
              >
                <svg className="caret" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                  <path d="m4 6 4 4 4-4" />
                </svg>
                <span className="site-name">{site.name}</span>
                <span className="site-count">{matchedAps.length}</span>
                {site.problems > 0 && <span className="site-prob">{site.problems}</span>}
                {(() => {
                  const downCount = site.aps.filter(a => a.status === "down").length;
                  if (downCount === 0) return null;
                  return (
                    <span className="site-down" title={`${downCount} AP${downCount === 1 ? "" : "s"} down (XIQ / SNMP / ping)`}>
                      {downCount}↓
                    </span>
                  );
                })()}
                {(() => {
                  const driftCount = site.aps.filter(a => a.configMismatch === 1).length;
                  if (driftCount === 0) return null;
                  return (
                    <span className="site-drift" title={`${driftCount} AP${driftCount === 1 ? "" : "s"} with XIQ config drift`}>
                      {driftCount}≠
                    </span>
                  );
                })()}
              </div>
              <div className={"ap-nav-children" + (expanded ? "" : " hidden")}>
                {matchedAps.map(ap => {
                  const dotColor = ap.status === "ok"   ? "var(--ok)"
                                 : ap.status === "warn" ? "var(--warn)"
                                 : "var(--err)";
                  const loadColor = ap.loadLevel === "high" ? "var(--err)"
                                  : ap.loadLevel === "warn" ? "var(--warn)"
                                  : "var(--fg)";
                  const loadTitle = ap.loadLevel === "high" ? "Client load HIGH (> 50 clients)"
                                  : ap.loadLevel === "warn" ? "Client load WARN (> 35 clients)"
                                  : `${ap.clients} clients`;
                  return (
                    <div
                      key={ap.id}
                      className={"ap-nav-host" + (isActive(ap) ? " active" : "")}
                      onClick={() => onSelect(ap)}
                      title={`${ap.id} · ${ap.ip} · ${ap.model} · ${loadTitle}`}
                    >
                      <span className="ap-led" style={{ background: dotColor, boxShadow: ap.status === "ok" ? `0 0 4px ${dotColor}` : "none" }} />
                      <div className="ap-meta-col">
                        <div className="ap-id">{ap.id}</div>
                        <div className="ap-sub">{ap.floor} · {ap.model}</div>
                      </div>
                      <div className="ap-cli" title={loadTitle}>
                        <div className="n" style={{ color: loadColor, fontWeight: ap.loadLevel === "ok" ? 500 : 700 }}>{ap.clients}</div>
                        <div className="u">cli</div>
                      </div>
                      {ap.configMismatch === 1 && (
                        <span className="ap-drift" title="XIQ reports running config does not match assigned policy">≠</span>
                      )}
                      {ap.problems > 0 && <span className="ap-prob">{ap.problems}</span>}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

// ───────── Tweaks ─────────
const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "density": "balanced",
  "accent": "#d92929",
  "showSourceBadges": true,
  "showFloorplan": true,
  "showSidecar": true,
  "showApNav": true,
  "selectedAp": "BHS-56-Hallway",
  "fontMono": "JetBrains Mono"
}/*EDITMODE-END*/;

const Tweaks = ({ t, setTweak }) => (
  <TweaksPanel title="Tweaks">
    <TweakSection title="Layout">
      <TweakRadio label="Density" value={t.density} options={[
        { value: "spacious", label: "Spacious" },
        { value: "balanced", label: "Balanced" },
        { value: "dense", label: "Dense" }
      ]} onChange={v => setTweak("density", v)} />
      <TweakToggle label="Show AP host navigator (left rail)" value={t.showApNav} onChange={v => setTweak("showApNav", v)} />
      <TweakToggle label="Show device sidecar (image, floor plan)" value={t.showSidecar} onChange={v => setTweak("showSidecar", v)} />
      <TweakToggle label="Show floor plan map" value={t.showFloorplan} onChange={v => setTweak("showFloorplan", v)} />
    </TweakSection>
    <TweakSection title="Visual">
      <TweakColor label="Primary accent" value={t.accent} options={["#d92929","#5b8cff","#34d399","#7c5cff","#f5b300"]} onChange={v => setTweak("accent", v)} />
      <TweakSelect label="Mono font" value={t.fontMono} options={[
        { value: "JetBrains Mono", label: "JetBrains Mono" },
        { value: "IBM Plex Mono",  label: "IBM Plex Mono" },
        { value: "ui-monospace",   label: "System mono" }
      ]} onChange={v => setTweak("fontMono", v)} />
      <TweakToggle label="Show data-source badges (ZBX/PF/EXT)" value={t.showSourceBadges} onChange={v => setTweak("showSourceBadges", v)} />
    </TweakSection>
    <TweakSection title="Quick actions">
      <TweakButton onClick={() => alert("This would re-poll Zabbix items via API.")}>Force Zabbix re-poll</TweakButton>
      <TweakButton onClick={() => alert("This would request a fresh PacketFence client snapshot.")}>Refresh PacketFence cache</TweakButton>
    </TweakSection>
  </TweaksPanel>
);

// ───────── Debug panel — surface bridge state when no data is loading ─────────
const DebugPanel = () => {
  const [, force] = React.useState(0);
  const [open, setOpen] = React.useState(false);
  React.useEffect(() => {
    const bump = () => force(n => n + 1);
    window.addEventListener("tcs:debug", bump);
    window.addEventListener("tcs:data",  bump);
    return () => {
      window.removeEventListener("tcs:debug", bump);
      window.removeEventListener("tcs:data",  bump);
    };
  }, []);

  const d = window.TCS_DEBUG || {};
  const host  = window.ZBX_HOST   || {};
  const items = window.ZBX_ITEMS  || {};
  const alerts = window.ALERTS_SUMMARY || {};

  const collections = {
    SYSTEM_INFO:  Array.isArray(window.SYSTEM_INFO)  ? window.SYSTEM_INFO.length  : 0,
    NETWORK_INFO: Array.isArray(window.NETWORK_INFO) ? window.NETWORK_INFO.length : 0,
    ZBX_EVENTS:   Array.isArray(window.ZBX_EVENTS)   ? window.ZBX_EVENTS.length   : 0,
    WIRED_PORTS:  Array.isArray(window.WIRED_PORTS)  ? window.WIRED_PORTS.length  : 0,
    PF_CLIENTS:   Array.isArray(window.PF_CLIENTS)   ? window.PF_CLIENTS.length   : 0,
    PF_AUTH_FAILS:Array.isArray(window.PF_AUTH_FAILS)? window.PF_AUTH_FAILS.length: 0,
    AP_SITES:     Array.isArray(window.AP_SITES)     ? window.AP_SITES.length     : 0
  };

  const itemRows = Object.entries(items).map(([k, v]) => ({
    name: k,
    missing: v && v.missing,
    value: v && v.value,
    unit: v && v.unit,
    key: v && v.key,
    histLen: v && Array.isArray(v.history) ? v.history.length : 0
  }));

  const liveOk = d.lastFetchOk === true;
  const liveErr = d.lastFetchOk === false;

  return (
    <div className="card debug-panel" style={{ marginTop: 14, border: "1px dashed var(--line-2)" }}>
      <div className="card-h" style={{ cursor: "pointer" }} onClick={() => setOpen(o => !o)}>
        <h3>Debug · Data Bridge</h3>
        <span style={{
          marginLeft: 8, fontSize: 10, padding: "2px 8px", borderRadius: 999,
          background: liveOk ? "rgba(52,211,153,0.15)" : liveErr ? "rgba(242,95,92,0.18)" : "rgba(245,179,0,0.18)",
          color: liveOk ? "var(--ok)" : liveErr ? "var(--err)" : "var(--warn)",
          border: `1px solid ${liveOk ? "rgba(52,211,153,0.4)" : liveErr ? "rgba(242,95,92,0.4)" : "rgba(245,179,0,0.4)"}`
        }}>
          {liveOk ? "live refresh OK" : liveErr ? "live refresh ERROR" : "no refresh yet"}
        </span>
        <div className="h-spacer" />
        <button
          className="btn sm"
          onClick={(e) => { e.stopPropagation(); if (window.tcsDashboardRefresh) window.tcsDashboardRefresh(); }}
        >Refresh now</button>
        <span className="h-meta" style={{ marginLeft: 10 }}>{open ? "▼" : "▶"}</span>
      </div>
      {!open ? null : (
        <div className="card-b" style={{ display: "grid", gap: 14, fontSize: 11, fontFamily: "var(--mono)" }}>
          <DebugSection title="Bridge state">
            <DebugKV k="boot applied"     v={String(!!d.bootApplied)} />
            <DebugKV k="data URL"         v={d.url || "—"} />
            <DebugKV k="last fetch"       v={d.lastFetchAt || "never"} />
            <DebugKV k="last fetch ok"    v={d.lastFetchOk === null ? "—" : String(d.lastFetchOk)} tone={liveErr ? "err" : liveOk ? "ok" : null} />
            <DebugKV k="fetch count"      v={String(d.fetchCount ?? 0)} />
            <DebugKV k="last error"       v={d.lastError || "—"} tone={d.lastError ? "err" : null} />
          </DebugSection>

          <DebugSection title="ZBX_HOST">
            <DebugKV k="hostid"        v={host.hostid || "(empty — backend returned no host)"} tone={!host.hostid ? "err" : null} />
            <DebugKV k="host"          v={host.host || "—"} />
            <DebugKV k="visible_name"  v={host.visible_name || "—"} />
            <DebugKV k="ip"            v={host.ip || "—"} />
            <DebugKV k="available"     v={host.available === 1 ? "1 (up)" : host.available === 2 ? "2 (down)" : String(host.available ?? "—")} />
            <DebugKV k="uptime (sec)"  v={String(host.uptime ?? "—")} />
            <DebugKV k="templates"     v={(host.templates || []).join(", ") || "—"} />
            <DebugKV k="groups"        v={(host.groups || []).join(", ") || "—"} />
            <DebugKV k="proxy"         v={host.proxy || "(direct)"} />
          </DebugSection>

          <DebugSection title={`ZBX_ITEMS (${itemRows.length} keys)`}>
            <table className="tbl" style={{ width: "100%", fontSize: 11 }}>
              <thead>
                <tr>
                  <th>logical</th><th>missing</th><th>value</th><th>unit</th><th>hist</th><th>matched key</th>
                </tr>
              </thead>
              <tbody>
                {itemRows.map(r => (
                  <tr key={r.name}>
                    <td className="fg">{r.name}</td>
                    <td style={{ color: r.missing ? "var(--err)" : "var(--ok)" }}>{String(!!r.missing)}</td>
                    <td>{r.value === null || r.value === undefined ? "—" : String(r.value)}</td>
                    <td>{r.unit || "—"}</td>
                    <td>{r.histLen}</td>
                    <td style={{ color: "var(--muted)" }}>{r.key || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </DebugSection>

          <DebugSection title="ALERTS_SUMMARY">
            {Object.entries(alerts).map(([k, v]) => (
              <DebugKV key={k} k={k} v={String(v)} />
            ))}
          </DebugSection>

          <DebugSection title="Clients pipeline (XIQ → PF enrich)">
            {(() => {
              const cd = window.TCS_CLIENTS_DEBUG || {};
              const entries = Object.entries(cd);
              if (entries.length === 0) {
                return <div style={{ color: "var(--muted)" }}>(no diagnostic — collector didn't run; load with ?hostid=N)</div>;
              }
              return entries.map(([k, v]) => (
                <DebugKV key={k} k={k} v={String(v)} tone={(k === "stage" || k === "pfStage") ? "warn" : null} />
              ));
            })()}
          </DebugSection>

          <DebugSection title="PF AP uplink lookup">
            <PfApUplinkDebug />
          </DebugSection>

          <DebugSection title="Collection sizes">
            {Object.entries(collections).map(([k, v]) => (
              <DebugKV key={k} k={k} v={String(v)} tone={v === 0 ? "warn" : null} />
            ))}
          </DebugSection>

          <DebugSection title="Raw ZBX_BOOT (server-inlined)">
            <details>
              <summary style={{ cursor: "pointer", color: "var(--muted)" }}>
                Click to expand
              </summary>
              <pre style={{
                marginTop: 8, padding: 10, background: "var(--bg-2)",
                border: "1px solid var(--line)", borderRadius: 4,
                fontSize: 10.5, lineHeight: 1.4, maxHeight: 320,
                overflow: "auto", whiteSpace: "pre-wrap", wordBreak: "break-word"
              }}>
                {(() => { try { return JSON.stringify(d.bootRaw, null, 2); } catch { return "(unserializable)"; }})()}
              </pre>
            </details>
          </DebugSection>
        </div>
      )}
    </div>
  );
};

// PF AP uplink lookup diagnostic — surfaces the exact MAC queried, the
// PF API call, every locationlog row returned, the per-row score, and
// the row the uplink picker chose. Used to triage cases where the
// device card's Uplink tile points at a clearly wrong switch/port.
const PfApUplinkDebug = () => {
  const d = window.TCS_PF_AP_UPLINK_DEBUG || {};
  if (!d || Object.keys(d).length === 0) {
    return <div style={{ color: "var(--muted)" }}>(no diagnostic — collector didn't run; load with ?hostid=N)</div>;
  }
  const rows = Array.isArray(d.rows) ? d.rows : [];
  const result = d.result || null;
  return (
    <div>
      <DebugKV k="input MAC"        v={d.inputMac      || "—"} />
      <DebugKV k="normalized MAC"   v={d.normalizedMac || "—"} tone={!d.normalizedMac ? "err" : null} />
      <DebugKV k="PF base URL"      v={d.pfUrl         || "—"} />
      <DebugKV k="macros configured" v={d.macrosOk === null ? "—" : String(d.macrosOk)} tone={d.macrosOk === false ? "err" : null} />
      <DebugKV k="API call"         v={d.apiCall       || "—"} />
      <DebugKV k="rows returned"    v={String(d.rowCount ?? 0)} tone={(d.rowCount ?? 0) === 0 ? "warn" : null} />
      <DebugKV k="picked index"     v={d.pickedIndex === null || d.pickedIndex === undefined ? "—" : String(d.pickedIndex)} />
      <DebugKV k="fallback path"    v={d.fallback || "—"} tone={d.fallback ? "warn" : null} />
      <DebugKV k="error"            v={d.error    || "—"} tone={d.error ? "err" : null} />

      {result && (
        <div style={{ marginTop: 10 }}>
          <div style={{ fontFamily: "var(--sans)", fontSize: 10, textTransform: "uppercase",
                        letterSpacing: 0.6, color: "var(--muted)", marginBottom: 4 }}>
            Picked uplink (shown on card)
          </div>
          <DebugKV k="mac"            v={result.mac          || "—"} />
          <DebugKV k="switch"         v={result.switch       || "—"} />
          <DebugKV k="switch IP"      v={result.switchIp     || "—"} />
          <DebugKV k="switch hostid"  v={result.switchHostid || "—"} tone={!result.switchHostid ? "warn" : null} />
          <DebugKV k="port (ifIndex)" v={result.port         || "—"} />
          <DebugKV k="ifDesc"         v={result.ifDesc       || "—"} />
        </div>
      )}

      {rows.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <div style={{ fontFamily: "var(--sans)", fontSize: 10, textTransform: "uppercase",
                        letterSpacing: 0.6, color: "var(--muted)", marginBottom: 4 }}>
            Raw locationlog rows ({rows.length}, newest first)
          </div>
          <div style={{ overflowX: "auto" }}>
            <table className="tbl" style={{ width: "100%", fontSize: 10.5 }}>
              <thead>
                <tr>
                  <th>#</th><th>score</th><th>type</th><th>switch</th><th>switch_ip</th>
                  <th>port</th><th>ifDesc</th><th>start</th><th>end</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => {
                  const picked = !!r._picked;
                  const cellStyle = picked ? { background: "rgba(91,140,255,0.10)", fontWeight: 600 } : null;
                  return (
                    <tr key={i} style={cellStyle}>
                      <td>{picked ? `★ ${i}` : i}</td>
                      <td>{r._score === undefined ? "—" : r._score}</td>
                      <td>{r.connection_type || "—"}</td>
                      <td>{r.switch    || "—"}</td>
                      <td>{r.switch_ip || "—"}</td>
                      <td>{r.port      || "—"}</td>
                      <td style={{ color: "var(--muted)" }}>{r.ifDesc || "—"}</td>
                      <td style={{ color: "var(--muted)" }}>{r.start_time || "—"}</td>
                      <td style={{ color: "var(--muted)" }}>{r.end_time || "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div style={{ fontSize: 10, color: "var(--muted)", marginTop: 6 }}>
            Scoring: +4 still-open session · +3 wired connection_type · +2 row has switch hostname · +1 row has port · −3 Wireless connection_type
          </div>
        </div>
      )}
    </div>
  );
};

const DebugSection = ({ title, children }) => (
  <div>
    <div style={{
      fontFamily: "var(--sans)", fontSize: 10, textTransform: "uppercase",
      letterSpacing: 0.6, color: "var(--muted)", marginBottom: 6,
      paddingBottom: 4, borderBottom: "1px solid var(--line)"
    }}>{title}</div>
    <div>{children}</div>
  </div>
);

const DebugKV = ({ k, v, tone }) => {
  const color = tone === "err" ? "var(--err)" : tone === "warn" ? "var(--warn)" : tone === "ok" ? "var(--ok)" : "var(--fg-2)";
  return (
    <div style={{ display: "grid", gridTemplateColumns: "180px 1fr", gap: 8, padding: "2px 0" }}>
      <div style={{ color: "var(--muted)" }}>{k}</div>
      <div style={{ color, wordBreak: "break-all" }}>{v}</div>
    </div>
  );
};

window.Sidebar = Sidebar;
window.Topbar = Topbar;
window.PageHeader = PageHeader;
window.Tabs = Tabs;
window.DeviceSidecar = DeviceSidecar;
window.APNavigator = APNavigator;
window.Tweaks = Tweaks;
window.DebugPanel = DebugPanel;
window.TWEAK_DEFAULTS = TWEAK_DEFAULTS;
