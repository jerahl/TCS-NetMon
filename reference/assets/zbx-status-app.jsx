// Zabbix Server + Proxy Status — internal-side view of the monitoring platform itself.

const { useState, useEffect } = React;

// ───────── Live data bindings ─────────
// Globals are populated by zbx-status-bridge.jsx (from window.ZBX_BOOT on
// first paint, then refreshed by fetch to tcs.zbx.status.data). These `let`s
// are live bindings — child components reference them by name and pick up
// reassignments when the bridge fires "tcs:zbx-status-data". The root App
// listens for that event and bumps a render counter.
let ZBX_SUMMARY       = window.ZBX_SUMMARY       || {};
let ZBX_NODES         = window.ZBX_NODES         || [];
let ZBX_PROCESSES     = window.ZBX_PROCESSES     || [];
let ZBX_CACHES        = window.ZBX_CACHES        || [];
let ZBX_PROXIES       = window.ZBX_PROXIES       || [];
let ZBX_NVPS_TIMELINE  = window.ZBX_NVPS_TIMELINE  || [];
let ZBX_QUEUE_TIMELINE = window.ZBX_QUEUE_TIMELINE || [];
let ZBX_CACHE_TIMELINE = window.ZBX_CACHE_TIMELINE || [];
let ZBX_EVENTS        = window.ZBX_EVENTS        || [];
window.addEventListener("tcs:zbx-status-data", () => {
  ZBX_SUMMARY        = window.ZBX_SUMMARY        || ZBX_SUMMARY;
  ZBX_NODES          = window.ZBX_NODES          || ZBX_NODES;
  ZBX_PROCESSES      = window.ZBX_PROCESSES      || ZBX_PROCESSES;
  ZBX_CACHES         = window.ZBX_CACHES         || ZBX_CACHES;
  ZBX_PROXIES        = window.ZBX_PROXIES        || ZBX_PROXIES;
  ZBX_NVPS_TIMELINE  = window.ZBX_NVPS_TIMELINE  || ZBX_NVPS_TIMELINE;
  ZBX_QUEUE_TIMELINE = window.ZBX_QUEUE_TIMELINE || ZBX_QUEUE_TIMELINE;
  ZBX_CACHE_TIMELINE = window.ZBX_CACHE_TIMELINE || ZBX_CACHE_TIMELINE;
  ZBX_EVENTS         = window.ZBX_EVENTS         || ZBX_EVENTS;
});

const tail = (arr, fallback = 0) =>
  Array.isArray(arr) && arr.length ? arr[arr.length - 1] : fallback;

const LiveBanner = () => {
  const b = window.ZBX_BANNER;
  if (!b) return null;
  const color = b.kind === "error" ? "var(--err)" : "var(--warn)";
  const bg    = b.kind === "error" ? "rgba(242,95,92,0.10)" : "rgba(245,179,0,0.10)";
  return (
    <div style={{ margin: "0 0 14px", padding: "8px 12px", border: "1px solid " + color, background: bg, color: color, fontSize: 12, borderRadius: 4 }}>
      <strong style={{ marginRight: 8, textTransform: "uppercase", letterSpacing: ".06em", fontSize: 10.5 }}>{b.kind}</strong>
      {b.msg}
    </div>
  );
};

const StatusHeader = () => {
  const s = ZBX_SUMMARY || {};
  const px = s.proxies || { total: 0, offline: 0, drift: 0 };
  const hosts    = (s.hosts    || {});
  const items    = (s.items    || {});
  const triggers = (s.triggers || {});
  const offline  = px.offline || 0;
  const drift    = px.drift   || 0;
  const dotColor = offline > 0 ? "var(--err)" : drift > 0 ? "var(--warn)" : "var(--ok)";
  const summaryMsg =
    offline > 0 ? `Cluster healthy · ${offline} proxy ${offline === 1 ? "unreachable" : "unreachable"}` :
    drift   > 0 ? `Cluster healthy · ${drift} proxy ${drift === 1 ? "version drift" : "with version drift"}` :
    px.total > 0 ? `Cluster healthy · ${px.total} ${px.total === 1 ? "proxy" : "proxies"} online` :
    "Cluster healthy";
  return (
    <div className="page-header" style={{ alignItems: "center" }}>
      <div style={{ flex: 1 }}>
        <div className="host-title">
          <h1>Zabbix · Server &amp; Proxy Status</h1>
          <span className="role-tag" style={{ fontSize: 10, padding: "1px 8px", background: "rgba(217,41,41,0.10)", color: "var(--zbx)", border: "1px solid rgba(217,41,41,0.4)" }}>
            MONITORING · CORE
          </span>
          <span className="role-tag faculty" style={{ fontSize: 10, padding: "1px 8px" }}>
            {ZBX_NODES.length > 1 ? "HA CLUSTER" : "STANDALONE"}
          </span>
        </div>
        <div className="host-meta">
          <span className="pill"><span className="dot" style={{ background: dotColor }} /> {summaryMsg}</span>
          <span className="pill"><span className="lbl">Version</span> <span className="v">{s.version || "—"}</span></span>
          <span className="pill"><span className="lbl">Active node</span> <span className="v">{s.primary || "—"}</span></span>
          <span className="pill"><span className="lbl">Up</span> <span className="v">{s.upHuman || "—"}</span></span>
          <span className="pill"><span className="lbl">Hosts</span> <span className="v">{(hosts.monitored || 0).toLocaleString()}</span></span>
          <span className="pill"><span className="lbl">Items</span> <span className="v">{(items.enabled || 0).toLocaleString()}</span></span>
          <span className="pill"><span className="lbl">Triggers</span> <span className="v">{(triggers.enabled || 0).toLocaleString()} ({triggers.problem || 0} problem)</span></span>
        </div>
      </div>
      <div className="timerange">
        <Icon name="calendar" />
        <span className="range-val">Last 1h</span>
        <Icon name="chevron" />
      </div>
    </div>
  );
};

// ───────── KPI strip ─────────
const PerfKPIs = () => {
  const s = ZBX_SUMMARY || {};
  const hosts    = s.hosts    || {};
  const items    = s.items    || {};
  const triggers = s.triggers || {};
  const queue    = s.queue    || {};
  const proxies  = s.proxies  || { total: 0, online: 0, offline: 0, drift: 0 };
  const reqPerf  = s.reqPerf  || 0;
  const actPerf  = s.actPerf  || 0;
  const reqRatio = reqPerf > 0 ? Math.round((actPerf / reqPerf) * 100) : 0;
  const cells = [
    { lbl: "NVPS · actual",     v: actPerf.toLocaleString(), unit: "/s", note: `req ${reqPerf.toLocaleString()}/s · ${reqRatio}% of req`, cls: "" },
    { lbl: "Hosts monitored",   v: (hosts.monitored || 0).toLocaleString(), note: `${hosts.disabled || 0} disabled · ${hosts.templates || 0} templates`, cls: "" },
    { lbl: "Items enabled",     v: ((items.enabled || 0) / 1000).toFixed(1) + "k", note: `${items.notSupported || 0} not supported`, cls: "" },
    { lbl: "Queue · total",     v: String(queue.total || 0), note: `${queue.ten_min || 0} > 10m · ${queue.half_hr || 0} > 30m`, cls: (queue.total || 0) > 100 ? "warn" : "" },
    { lbl: "Problems",          v: String(triggers.problem || 0), note: `${triggers.suppressed || 0} suppressed · ${(triggers.ok || 0).toLocaleString()} OK`, cls: (triggers.problem || 0) > 0 ? "warn" : "" },
    { lbl: "Proxies online",    v: `${proxies.online || 0} / ${proxies.total || 0}`, note: `${proxies.offline || 0} unreachable · ${proxies.drift || 0} ver. drift`, cls: (proxies.offline || 0) > 0 ? "warn" : "" },
  ];
  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div className="pf-kpis">
        {cells.map(c => (
          <div className="pf-kpi" key={c.lbl}>
            <div className="pf-kpi-h">
              <span className="pf-kpi-lbl">{c.lbl}</span>
              <SourceBadge src="zbx" />
            </div>
            <div className={"pf-kpi-v " + c.cls}>
              {c.v}{c.unit && <span style={{ fontSize: 12, color: "var(--muted)", marginLeft: 4, fontWeight: 500 }}>{c.unit}</span>}
            </div>
            <div className="pf-kpi-note">{c.note}</div>
          </div>
        ))}
      </div>
    </div>
  );
};

// ───────── HA cluster nodes ─────────
const HANodeCard = ({ n }) => {
  const cpuCls = n.cpu > 80 ? "err" : n.cpu > 60 ? "warn" : "ok";
  const memCls = n.mem > 80 ? "err" : n.mem > 60 ? "warn" : "ok";
  const roleColor = n.role === "active" ? "var(--ok)" : n.role === "standby" ? "var(--info)" : "var(--err)";
  const roleBg = n.role === "active" ? "rgba(52,211,153,0.10)" : n.role === "standby" ? "rgba(95,168,211,0.10)" : "rgba(242,95,92,0.10)";
  return (
    <div className="pf-node">
      <div className="pf-node-h">
        <div className="pf-node-name">{n.id}</div>
        <span style={{ fontFamily: "var(--mono)", fontSize: 9.5, fontWeight: 700, letterSpacing: 0.6, padding: "1px 6px", border: "1px solid " + roleColor, borderRadius: 3, color: roleColor, background: roleBg }}>
          {n.role.toUpperCase()}
        </span>
        <div className="h-spacer" style={{ flex: 1 }} />
        <span className="mono" style={{ fontSize: 10.5, color: "var(--muted)" }}>v{n.version}</span>
        <SourceBadge src="zbx" />
      </div>
      <div className="pf-node-meta">{n.host} · {n.ip} · up {n.uptime}</div>
      <div className="pf-node-grid">
        <div className="pf-node-cell"><div className="lbl">CPU</div><div className={"val " + cpuCls}>{n.cpu}<span className="u">%</span></div></div>
        <div className="pf-node-cell"><div className="lbl">Memory</div><div className={"val " + memCls}>{n.mem}<span className="u">%</span></div></div>
        <div className="pf-node-cell"><div className="lbl">Disk /var/lib</div><div className="val">{n.disk}<span className="u">%</span></div></div>
        <div className="pf-node-cell"><div className="lbl">NVPS</div><div className="val">{n.nvps ? n.nvps.toLocaleString() : "—"}{n.nvps ? <span className="u">/s</span> : null}</div></div>
        <div className="pf-node-cell"><div className="lbl">DB conn</div><div className="val">{n.dbConn}</div></div>
        <div className="pf-node-cell"><div className="lbl">Last seen</div><div className="val">{n.lastSeen}</div></div>
      </div>
      <div className="pf-node-svc">
        {n.services.map(s => {
          const isStandby = s.s === "standby";
          const cls = isStandby ? "" : (s.s !== "ok" ? s.s : "");
          const dotBg = s.s === "ok" ? "var(--ok)" : s.s === "warn" ? "var(--warn)" : isStandby ? "var(--info)" : "var(--err)";
          return (
            <span key={s.n} className={"pf-svc " + cls} style={isStandby ? { color: "var(--info)", borderColor: "rgba(95,168,211,0.4)", background: "rgba(95,168,211,0.08)" } : null}>
              <span className="dot" style={{ background: dotBg }} />
              {s.n}
            </span>
          );
        })}
      </div>
    </div>
  );
};

// ───────── Internal processes ─────────
const ProcessGroup = ({ title, items }) => {
  const forkSum = items.reduce((a, b) => a + (b.forks || 0), 0);
  return (
  <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 14px", background: "rgba(255,255,255,0.015)", borderBottom: "1px solid var(--line)", fontSize: 10.5, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 0.6, fontWeight: 600 }}>
      <span>{title}</span>
      <div style={{ flex: 1 }} />
      <span className="mono" style={{ fontSize: 10, color: "var(--muted)", textTransform: "none", letterSpacing: 0 }}>
        {items.length} processes{forkSum > 0 ? ` · ${forkSum} forks` : ""}
      </span>
    </div>
    {items.map(p => {
      const cls = p.busy > 80 ? "err" : p.busy > 60 ? "warn" : "ok";
      const barCls = cls === "ok" ? "" : cls;
      return (
        <div className="pf-queue-row" key={p.n} style={{ gridTemplateColumns: "180px 1fr 110px" }}>
          <div className="pf-queue-name">
            {p.n}
            {p.alert && <span style={{ marginLeft: 6, fontSize: 9, color: "var(--err)" }}>●</span>}
          </div>
          <div>
            <div className="pf-queue-bar">
              <div className={barCls} style={{ width: `${Math.max(2, p.busy)}%`, background: cls === "ok" ? "var(--ok)" : cls === "warn" ? "var(--warn)" : "var(--err)" }} />
            </div>
            {p.alert && <div style={{ fontSize: 10, color: "var(--warn)", marginTop: 3 }}>↳ sustained &gt; 80% for 5m</div>}
          </div>
          <div className="pf-queue-val">
            <span className={"mono"} style={{ color: cls === "ok" ? "var(--fg-2)" : cls === "warn" ? "var(--warn)" : "var(--err)", fontWeight: 600 }}>
              {p.busy}%
            </span>
            <div style={{ fontSize: 10, color: "var(--muted)", marginTop: 2 }}>
              {p.forks > 0 ? `${p.forks} fork${p.forks > 1 ? "s" : ""}` : "— forks"}
            </div>
          </div>
        </div>
      );
    })}
  </div>
  );
};

const ProcessPanel = () => {
  const groups = ["Pollers", "Data flow", "Triggers", "Discovery", "Housekeeping"];
  return (
    <div className="card">
      <div className="card-h">
        <h3>Internal Processes · % busy</h3>
        <SourceBadge src="zbx" />
        <div className="h-spacer" />
        <span className="h-meta">5-min avg · zabbix-server only</span>
      </div>
      <div className="card-b tight">
        {groups.map(g => (
          <ProcessGroup key={g} title={g} items={ZBX_PROCESSES.filter(p => p.group === g)} />
        ))}
      </div>
    </div>
  );
};

// ───────── Cache usage rings ─────────
const CachePanel = () => (
  <div className="card">
    <div className="card-h">
      <h3>Cache Usage</h3>
      <SourceBadge src="zbx" />
      <div className="h-spacer" />
      <span className="h-meta">% used</span>
    </div>
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 1, background: "var(--line)" }}>
      {ZBX_CACHES.map(c => {
        const color = c.used > 80 ? "var(--err)" : c.used > 60 ? "var(--warn)" : "var(--ok)";
        return (
          <div key={c.n} style={{ background: "var(--bg-1)", padding: 14, display: "flex", gap: 12, alignItems: "center" }}>
            <Ring value={c.used} max={100} size={64} color={color}
              label={<span className="mono" style={{ fontSize: 14, fontWeight: 600 }}>{c.used}%</span>}
              sub={null}
            />
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: 12, color: "var(--fg)", fontWeight: 500 }}>{c.n}</div>
              <div style={{ fontSize: 10.5, color: "var(--muted)", fontFamily: "var(--mono)", marginTop: 3 }}>{c.note} = {c.size}</div>
              {c.warn && <div style={{ fontSize: 10, color: "var(--warn)", marginTop: 3 }}>↳ approaching limit</div>}
            </div>
          </div>
        );
      })}
    </div>
  </div>
);

// ───────── Perf timelines ─────────
const PerfTimelines = () => {
  const reqPerf = (ZBX_SUMMARY && ZBX_SUMMARY.reqPerf) || 0;
  const items = [
    { label: "NVPS (new values/sec)", data: ZBX_NVPS_TIMELINE,  color: "var(--zbx)",  last: tail(ZBX_NVPS_TIMELINE).toLocaleString() + "/s", warn: reqPerf },
    { label: "Queue depth",           data: ZBX_QUEUE_TIMELINE, color: "var(--warn)", last: tail(ZBX_QUEUE_TIMELINE) + " items", warn: 200 },
    { label: "Value cache · % used",  data: ZBX_CACHE_TIMELINE, color: "var(--info)", last: tail(ZBX_CACHE_TIMELINE) + "%", warn: 80 },
  ];
  return (
    <div className="card">
      <div className="card-h">
        <h3>Server performance · last 60 min</h3>
        <SourceBadge src="zbx" />
        <div className="h-spacer" />
        <span className="h-meta">1-min samples · internal items</span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)" }}>
        {items.map((it, i) => (
          <div key={it.label} style={{ padding: 14, borderRight: i < items.length - 1 ? "1px solid var(--line)" : 0, display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 10.5, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 0.5, flex: 1 }}>{it.label}</span>
              <span className="mono" style={{ fontSize: 14, fontWeight: 600, color: "var(--fg)" }}>{it.last}</span>
            </div>
            <Sparkline data={it.data} color={it.color} width={400} height={56} fill={true} threshold={it.warn} />
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 9.5, color: "var(--muted)", fontFamily: "var(--mono)" }}>
              <span>-60m</span><span>-30m</span><span>now</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

// ───────── Proxies table ─────────
const ProxiesTable = () => {
  const [sortKey, setSortKey] = React.useState("status");
  const [filter, setFilter] = React.useState("");
  const cmp = (a, b) => {
    const order = { down: 0, warn: 1, ok: 2 };
    if (sortKey === "status") return order[a.status] - order[b.status];
    if (sortKey === "nvps")   return b.nvps - a.nvps;
    if (sortKey === "hosts")  return b.hosts - a.hosts;
    if (sortKey === "queue")  return b.queue - a.queue;
    if (sortKey === "name")   return a.id.localeCompare(b.id);
    return 0;
  };
  const rows = ZBX_PROXIES
    .filter(p => !filter || (p.id + p.host + p.site).toLowerCase().includes(filter.toLowerCase()))
    .slice().sort(cmp);

  const sortBtn = (k, l) => (
    <span
      onClick={() => setSortKey(k)}
      style={{ cursor: "pointer", color: sortKey === k ? "var(--fg)" : "var(--muted)", fontWeight: sortKey === k ? 600 : 400 }}
    >{l}{sortKey === k ? " ▾" : ""}</span>
  );
  return (
    <div className="card">
      <div className="card-h">
        <h3>Zabbix Proxies · {ZBX_PROXIES.length} total</h3>
        <SourceBadge src="zbx" />
        <div className="h-spacer" />
        <div style={{ display: "flex", alignItems: "center", gap: 6, background: "var(--bg-2)", border: "1px solid var(--line)", borderRadius: 4, padding: "3px 8px" }}>
          <Icon name="search" size={11} />
          <input
            placeholder="filter…"
            value={filter}
            onChange={e => setFilter(e.target.value)}
            style={{ border: 0, outline: 0, background: "transparent", color: "var(--fg)", font: "inherit", fontSize: 11, width: 110 }}
          />
        </div>
        <a className="h-link">All proxies <Icon name="external" size={11} /></a>
      </div>
      <div className="zbx-proxy-table">
        <div className="zbx-proxy-row zbx-proxy-head">
          <div></div>
          <div>{sortBtn("name", "Proxy")}</div>
          <div>Site</div>
          <div>Mode</div>
          <div>Version</div>
          <div style={{ textAlign: "right" }}>{sortBtn("hosts", "Hosts")}</div>
          <div style={{ textAlign: "right" }}>Items</div>
          <div style={{ textAlign: "right" }}>{sortBtn("nvps", "NVPS")}</div>
          <div style={{ textAlign: "right" }}>{sortBtn("queue", "Queue")}</div>
          <div>CPU · Mem</div>
          <div>Last seen</div>
          <div></div>
        </div>
        {rows.map(p => {
          const sColor = p.status === "ok" ? "var(--ok)" : p.status === "warn" ? "var(--warn)" : "var(--err)";
          const isDown = p.status === "down";
          return (
            <div className={"zbx-proxy-row" + (isDown ? " zbx-proxy-down" : "")} key={p.id}>
              <div><span className="dot" style={{ background: sColor, boxShadow: p.status === "ok" ? `0 0 4px ${sColor}` : "none", width: 8, height: 8, borderRadius: "50%" }} /></div>
              <div className="zbx-proxy-name">
                <div className="mono" style={{ fontSize: 12, color: "var(--fg)" }}>{p.id}</div>
                <div style={{ fontSize: 10, color: "var(--muted)", fontFamily: "var(--mono)" }}>{p.ip}</div>
              </div>
              <div>
                <div style={{ fontSize: 12, color: "var(--fg-2)" }}>{p.host}</div>
                <div style={{ fontSize: 10, color: "var(--muted)" }}>{p.site}</div>
              </div>
              <div>
                <span style={{
                  fontFamily: "var(--mono)", fontSize: 9.5, fontWeight: 700, letterSpacing: 0.5,
                  padding: "1px 5px", border: "1px solid",
                  borderColor: p.mode === "active" ? "rgba(217,41,41,0.4)" : "var(--line-2)",
                  borderRadius: 3,
                  color: p.mode === "active" ? "var(--zbx)" : "var(--fg-2)",
                  background: p.mode === "active" ? "rgba(217,41,41,0.08)" : "var(--bg-2)",
                }}>{p.mode.toUpperCase()}</span>
                <div style={{ fontSize: 9.5, color: "var(--muted)", marginTop: 3, fontFamily: "var(--mono)" }}>{p.encrypted}</div>
              </div>
              <div className="mono" style={{ fontSize: 11.5, color: p.version === (ZBX_SUMMARY && ZBX_SUMMARY.version) ? "var(--fg-2)" : "var(--warn)" }}>
                v{p.version}
                {p.version !== (ZBX_SUMMARY && ZBX_SUMMARY.version) && <div style={{ fontSize: 9.5, color: "var(--warn)" }}>drift</div>}
              </div>
              <div className="mono" style={{ textAlign: "right", fontSize: 12 }}>{p.hosts}</div>
              <div className="mono" style={{ textAlign: "right", fontSize: 12, color: "var(--fg-2)" }}>{p.items.toLocaleString()}</div>
              <div className="mono" style={{ textAlign: "right", fontSize: 12, color: isDown ? "var(--err)" : "var(--fg)" }}>
                {p.nvps.toLocaleString()}
                <span style={{ fontSize: 9.5, color: "var(--muted)" }}>/s</span>
              </div>
              <div className="mono" style={{ textAlign: "right", fontSize: 12, color: p.queue > 100 ? "var(--err)" : p.queue > 10 ? "var(--warn)" : "var(--fg-2)" }}>
                {p.queue}
              </div>
              <div>
                <div className="zbx-mini-bar"><div style={{ width: p.cpu + "%", background: p.cpu > 60 ? "var(--warn)" : "var(--ok)" }} /></div>
                <div className="zbx-mini-bar" style={{ marginTop: 3 }}><div style={{ width: p.mem + "%", background: p.mem > 60 ? "var(--warn)" : "var(--info)" }} /></div>
              </div>
              <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: isDown ? "var(--err)" : "var(--fg-2)" }}>{p.lastSeen}</div>
              <div style={{ display: "flex", gap: 4, justifyContent: "flex-end" }}>
                <span className="icon-btn" title="Refresh"><Icon name="refresh" size={12} /></span>
                <span className="icon-btn" title="More"><Icon name="more" size={12} /></span>
              </div>
            </div>
          );
        })}
      </div>
      {rows.some(p => p.notes) && (
        <div style={{ padding: "10px 14px", borderTop: "1px solid var(--line)", background: "rgba(245,179,0,0.04)" }}>
          {rows.filter(p => p.notes).map(p => (
            <div key={p.id} style={{ fontSize: 11, color: "var(--fg-2)", fontFamily: "var(--mono)", display: "flex", gap: 8 }}>
              <span style={{ color: p.status === "down" ? "var(--err)" : "var(--warn)", minWidth: 130 }}>{p.id}</span>
              <span style={{ color: "var(--muted)" }}>↳</span>
              <span>{p.notes}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

// ───────── Service events stream ─────────
const ServiceEvents = () => (
  <div className="card">
    <div className="card-h">
      <h3>Recent Server &amp; Proxy Events</h3>
      <SourceBadge src="zbx" />
      <div className="h-spacer" />
      <a className="h-link">Open full log <Icon name="external" size={11} /></a>
    </div>
    <div className="events">
      {ZBX_EVENTS.map((e, i) => (
        <div className="event" key={i} style={{ gridTemplateColumns: "80px 60px 160px 1fr" }}>
          <div className="ts">{e.ts}</div>
          <div className={"src " + e.src}>{e.src.toUpperCase()}</div>
          <div className="mono" style={{ fontSize: 11, color: "var(--fg-2)" }}>{e.host}</div>
          <div className="msg">
            <span style={{ color: e.sev === "ok" ? "var(--ok)" : e.sev === "high" ? "var(--err)" : e.sev === "warn" ? "var(--warn)" : "var(--info)", fontWeight: 500 }}>
              {e.msg}
            </span>
            <span style={{ color: "var(--fg)" }}>{e.obj}</span>
          </div>
        </div>
      ))}
    </div>
  </div>
);

// ───────── App ─────────
const TWEAK_DEFAULTS = {
  density: "balanced",
  showSourceBadges: true,
};

const ZbxStatusApp = () => {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
  const [, setTick] = useState(0);

  useEffect(() => {
    document.documentElement.classList.toggle("hide-src-badges", !t.showSourceBadges);
  }, [t.showSourceBadges]);

  // Re-render whenever zbx-status-bridge.jsx swaps in a fresh
  // tcs.zbx.status.data payload.
  useEffect(() => {
    const onData = () => setTick(n => n + 1);
    window.addEventListener("tcs:zbx-status-data", onData);
    return () => window.removeEventListener("tcs:zbx-status-data", onData);
  }, []);

  const refresh = () => {
    if (typeof window.tcsZbxStatusRefresh === "function") window.tcsZbxStatusRefresh();
  };

  return (
    <div className="app" data-density={t.density} data-screen-label="Zabbix Server Status">
      <GlobalSidebar active="zbx-status" />
      <div className="main">
        <GlobalTopbar
          crumb={["Tuscaloosa City Schools", "Monitoring", "Zabbix · Server & Proxy Status"]}
          onRefresh={refresh}
        />
        <StatusHeader />
        <div className="body">
          <LiveBanner />
          <PerfKPIs />

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 14 }}>
            {ZBX_NODES.map(n => <HANodeCard key={n.id} n={n} />)}
          </div>

          <div className="row" style={{ gridTemplateColumns: "1.3fr 1fr", marginBottom: 14 }}>
            <ProcessPanel />
            <CachePanel />
          </div>

          <div style={{ marginBottom: 14 }}>
            <PerfTimelines />
          </div>

          <div style={{ marginBottom: 14 }}>
            <ProxiesTable />
          </div>

          <ServiceEvents />
        </div>
      </div>

      <TweaksPanel title="Tweaks">
        <TweakSection title="Layout">
          <TweakRadio label="Density" value={t.density} options={[
            { value: "spacious", label: "Spacious" },
            { value: "balanced", label: "Balanced" },
            { value: "dense",    label: "Dense"    }
          ]} onChange={v => setTweak("density", v)} />
          <TweakToggle label="Show data-source badges" value={t.showSourceBadges} onChange={v => setTweak("showSourceBadges", v)} />
        </TweakSection>
        <TweakSection title="Refresh">
          <TweakButton onClick={refresh}>Refresh now</TweakButton>
        </TweakSection>
      </TweaksPanel>
    </div>
  );
};

ReactDOM.createRoot(document.getElementById("root")).render(<ZbxStatusApp />);
