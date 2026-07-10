// Servers dashboard widgets

const { useState: useStateSV } = React;

// ───────── Server Host Navigator ─────────
const ServerNavigator = ({ activeId, onSelect, query, setQuery }) => {
  const [sites, setSites] = useStateSV(window.SERVER_SITES);
  const toggle = (idx) => setSites(sites.map((s, i) => i === idx ? { ...s, expanded: !s.expanded } : s));
  const q = (query || "").trim().toLowerCase();
  const total = sites.reduce((n, s) => n + s.servers.length, 0);
  const totalProb = sites.reduce((n, s) => n + s.problems, 0);

  return (
    <div className="card ap-nav-card">
      <div className="card-h">
        <h3>Server Navigator</h3>
        <SourceBadge src="zbx" />
        <div className="h-spacer" />
        <span className="h-meta">{total} hosts</span>
      </div>
      <div className="ap-nav-search">
        <Icon name="search" size={12} />
        <input
          placeholder="Filter by host, ip, role…"
          value={query || ""}
          onChange={e => setQuery(e.target.value)}
          spellCheck={false}
        />
        {query ? <span className="ap-nav-clear" onClick={() => setQuery("")}>×</span> : null}
      </div>
      <div className="ap-nav-summary">
        <span><b style={{ color: "var(--ok)" }}>{total - totalProb}</b> healthy</span>
        <span className="dot-sep">·</span>
        <span><b style={{ color: "var(--warn)" }}>{totalProb}</b> with triggers</span>
        <span className="dot-sep">·</span>
        <span><b>{sites.length}</b> sites</span>
      </div>
      <div className="ap-nav">
        {sites.map((site, i) => {
          const matched = q
            ? site.servers.filter(sv =>
                sv.id.toLowerCase().includes(q) ||
                sv.ip.toLowerCase().includes(q) ||
                sv.role.toLowerCase().includes(q) ||
                site.name.toLowerCase().includes(q))
            : site.servers;
          if (q && matched.length === 0) return null;
          const expanded = q ? true : site.expanded;
          return (
            <div className="ap-nav-section" key={site.id}>
              <div
                className={"ap-nav-site" + (expanded ? "" : " collapsed")}
                onClick={() => !q && toggle(i)}
              >
                <svg className="caret" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="m4 6 4 4 4-4" /></svg>
                <span className="site-name">{site.name}</span>
                <span className="site-count">{matched.length}</span>
                {site.problems > 0 && <span className="site-prob">{site.problems}</span>}
              </div>
              <div className={"ap-nav-children" + (expanded ? "" : " hidden")}>
                {matched.map(sv => {
                  const dotColor = sv.status === "ok" ? "var(--ok)" : sv.status === "warn" ? "var(--warn)" : "var(--err)";
                  return (
                    <div
                      key={sv.id}
                      className={"ap-nav-host" + (sv.id === activeId ? " active" : "")}
                      onClick={() => onSelect(sv)}
                      title={`${sv.id} · ${sv.ip} · ${sv.role}`}
                    >
                      <span className="ap-led" style={{ background: dotColor, boxShadow: sv.status === "ok" ? `0 0 4px ${dotColor}` : "none" }} />
                      <div className="ap-meta-col">
                        <div className="ap-id">{sv.id}</div>
                        <div className="ap-sub">{sv.role} · {sv.kind === "phys" ? "phys" : "vm"}</div>
                      </div>
                      <div className="ap-cli">
                        <div className="n">{sv.cpu}<span style={{ fontSize: 9, color: "var(--muted)" }}>%</span></div>
                        <div className="u">cpu</div>
                      </div>
                      {sv.problems > 0 && <span className="ap-prob">{sv.problems}</span>}
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

// ───────── KPI strip for selected host ─────────
const ServerKPIs = ({ host }) => {
  const H = window.ACTIVE_SERVER_HISTORY;
  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div className="swstat-strip">
        <div className="swstat-cell">
          <div className="lbl">CPU · 1m</div>
          <div className={"val " + (host.cpu > 60 ? "warn" : "ok")}>{host.cpu}<span style={{ fontSize: 11, color: "var(--muted)", fontWeight: 500 }}>%</span></div>
          <Sparkline data={H.cpu1m} color="var(--info)" width={120} height={20} threshold={80} />
        </div>
        <div className="swstat-cell">
          <div className="lbl">Memory</div>
          <div className={"val " + (host.mem > 80 ? "warn" : "ok")}>{host.mem}<span style={{ fontSize: 11, color: "var(--muted)", fontWeight: 500 }}>% / {host.ram}G</span></div>
          <Sparkline data={H.memUsed} color="var(--zbx)" width={120} height={20} threshold={85} />
        </div>
        <div className="swstat-cell">
          <div className="lbl">Disk I/O · MB/s</div>
          <div className="val">{Math.round((H.diskRead.at(-1) + H.diskWrite.at(-1)))}<span style={{ fontSize: 11, color: "var(--muted)", fontWeight: 500 }}> MB/s</span></div>
          <Sparkline data={H.diskRead} color="var(--warn)" width={120} height={20} />
        </div>
        <div className="swstat-cell">
          <div className="lbl">Net In / Out</div>
          <div className="val">{host.netMbps}<span style={{ fontSize: 11, color: "var(--muted)", fontWeight: 500 }}> Mbps</span></div>
          <Sparkline data={H.netIn} color="var(--ok)" width={120} height={20} />
        </div>
        <div className="swstat-cell">
          <div className="lbl">Load avg · 1m</div>
          <div className="val">{H.load1m.at(-1).toFixed(2)}</div>
          <Sparkline data={H.load1m} color="var(--pf)" width={120} height={20} />
        </div>
        <div className="swstat-cell">
          <div className="lbl">Uptime</div>
          <div className="val ok">{host.uptimeDays}<span style={{ fontSize: 11, color: "var(--muted)", fontWeight: 500 }}>d</span></div>
          <div style={{ fontSize: 10, color: "var(--ok)", fontFamily: "var(--mono)" }}>● agent2 v6.4.7</div>
        </div>
      </div>
    </div>
  );
};

// ───────── Server hero / sidecar (left of body) ─────────
const ServerSidecar = ({ host }) => (
  <div className="card device-card">
    <div className="device-hero">
      <div className="status-line">
        <StatusDot state={host.status} />
        <span style={{ color: host.status === "ok" ? "var(--ok)" : host.status === "warn" ? "var(--warn)" : "var(--err)" }}>
          {host.status === "ok" ? "Online" : host.status === "warn" ? "Degraded" : "Critical"}
        </span>
        <span className="muted" style={{ marginLeft: 6 }}>· {host.uptimeDays}d up</span>
      </div>
      <div className="device-img">
        {/* 1U server illustration */}
        <svg width="120" height="48" viewBox="0 0 120 48">
          <rect x="2" y="6" width="116" height="36" rx="2" fill="#1c2230" stroke="#2c3650" strokeWidth="1" />
          {/* drive bays */}
          {[0,1,2,3,4,5,6,7].map(i => (
            <rect key={i} x={6 + i * 13} y="10" width="11" height="28" rx="0.5" fill="#0f1320" stroke="#2c3650" strokeWidth="0.6" />
          ))}
          {/* lights */}
          <circle cx="112" cy="14" r="1.4" fill="var(--ok)" />
          <circle cx="112" cy="20" r="1.4" fill="var(--ok)" />
          <circle cx="112" cy="26" r="1.4" fill="#2c3650" />
          <circle cx="112" cy="32" r="1.4" fill={host.status === "ok" ? "#2c3650" : "var(--warn)"} />
          {/* rack ear screws */}
          <circle cx="6" cy="10" r="1" fill="#2c3650" />
          <circle cx="6" cy="38" r="1" fill="#2c3650" />
        </svg>
      </div>
      <div className="device-name">{host.id}</div>
      <div className="uptime">{host.fqdn}</div>
    </div>

    <div className="location-block">
      <div className="label">Hardware</div>
      <div className="v">
        {host.model}<br />
        <span style={{ fontFamily: "var(--mono)", fontSize: 11 }}>{host.cores} cores · {host.ram} GB RAM · {host.diskTb} TB disk</span>
      </div>
    </div>
    <div className="location-block">
      <div className="label">OS / Role</div>
      <div className="v">
        {host.os}<br />
        <span style={{ color: "var(--accent)", fontSize: 11 }}>{host.role}</span>
      </div>
    </div>
    <div className="location-block">
      <div className="label">Network</div>
      <div className="v" style={{ fontFamily: "var(--mono)", fontSize: 11 }}>
        {host.ip}<br />
        iDRAC · 10.24.99.{host.id.endsWith("01") ? "20" : "21"}<br />
        VLAN 24 · Gateway 10.24.0.1
      </div>
    </div>

    <div className="device-actions">
      <button className="btn primary"><Icon name="external" size={12} /> RDP</button>
      <button className="btn"><Icon name="external" size={12} /> SSH</button>
      <button className="btn ghost"><Icon name="more" size={12} /></button>
    </div>

    <div className="location-block">
      <div className="label">Zabbix Templates</div>
      <div className="v" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span style={{ fontFamily: "var(--mono)", fontSize: 11 }}>• Windows by Zabbix agent 2</span>
        <span style={{ fontFamily: "var(--mono)", fontSize: 11 }}>• MS SQL by ODBC</span>
        <span style={{ fontFamily: "var(--mono)", fontSize: 11 }}>• Dell iDRAC9 by SNMP</span>
        <span style={{ fontFamily: "var(--mono)", fontSize: 11 }}>• ICMP Ping</span>
      </div>
    </div>
  </div>
);

// ───────── Filesystems ─────────
const FilesystemsCard = () => {
  const fs = window.ACTIVE_SERVER_FS;
  return (
    <div className="card">
      <div className="card-h">
        <h3>Filesystems</h3>
        <SourceBadge src="zbx" />
        <div className="h-spacer" />
        <span className="h-meta">vfs.fs.size · 60s poll</span>
      </div>
      <table className="link-tbl">
        <thead>
          <tr>
            <th style={{ width: 180 }}>Mount</th>
            <th style={{ width: 60 }}>FS</th>
            <th style={{ width: 90, textAlign: "right" }}>Size</th>
            <th style={{ width: 90, textAlign: "right" }}>Free</th>
            <th>Used</th>
            <th style={{ width: 70, textAlign: "right" }}>Latency</th>
          </tr>
        </thead>
        <tbody>
          {fs.map(f => (
            <tr key={f.mount}>
              <td className="fg" style={{ color: "var(--accent)", fontFamily: "var(--mono)" }}>{f.mount}</td>
              <td>{f.fs}</td>
              <td style={{ textAlign: "right" }}>{f.sizeGb >= 1024 ? `${(f.sizeGb / 1024).toFixed(1)} TB` : `${f.sizeGb} GB`}</td>
              <td style={{ textAlign: "right" }}>{f.freeGb >= 1024 ? `${(f.freeGb / 1024).toFixed(1)} TB` : `${f.freeGb} GB`}</td>
              <td>
                <span className="util-bar"><i className={f.usedPct > 85 ? "err" : f.usedPct > 70 ? "warn" : ""} style={{ width: `${Math.max(2, f.usedPct)}%` }} /></span>
                <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: f.usedPct > 85 ? "var(--err)" : f.usedPct > 70 ? "var(--warn)" : "var(--fg)" }}>{f.usedPct}%</span>
              </td>
              <td style={{ textAlign: "right", color: f.latMs > 2 ? "var(--warn)" : "var(--muted)" }}>{f.latMs} ms</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

// ───────── Services / processes table ─────────
const ServicesCard = () => {
  const items = window.ACTIVE_SERVER_SERVICES;
  return (
    <div className="card">
      <div className="card-h">
        <h3>Services</h3>
        <SourceBadge src="zbx" />
        <div className="h-spacer" />
        <span className="h-meta">{items.filter(i => i.state === "running").length} running · {items.filter(i => i.state !== "running").length} stopped</span>
      </div>
      <table className="link-tbl">
        <thead>
          <tr>
            <th style={{ width: 12 }}></th>
            <th>Service</th>
            <th style={{ width: 70 }}>State</th>
            <th style={{ width: 60 }}>Start</th>
            <th style={{ width: 60, textAlign: "right" }}>PID</th>
            <th style={{ width: 70, textAlign: "right" }}>CPU%</th>
            <th style={{ width: 80, textAlign: "right" }}>Mem MB</th>
            <th style={{ width: 130 }}>Since</th>
          </tr>
        </thead>
        <tbody>
          {items.map(s => (
            <tr key={s.name}>
              <td><StatusDot state={s.state === "running" ? "ok" : "err"} /></td>
              <td className="fg" style={{ color: "var(--fg)", fontFamily: "var(--mono)", fontSize: 11.5 }}>{s.name}<div style={{ fontSize: 9.5, color: "var(--muted)" }}>{s.check}</div></td>
              <td style={{ color: s.state === "running" ? "var(--ok)" : "var(--err)", fontFamily: "var(--mono)", fontSize: 11 }}>{s.state}</td>
              <td style={{ color: s.auto ? "var(--fg)" : "var(--muted)" }}>{s.auto ? "auto" : "manual"}</td>
              <td style={{ textAlign: "right", fontFamily: "var(--mono)" }}>{s.pid ?? "—"}</td>
              <td style={{ textAlign: "right", fontFamily: "var(--mono)" }}>{s.cpu.toFixed(1)}</td>
              <td style={{ textAlign: "right", fontFamily: "var(--mono)" }}>{s.mem.toFixed(1)}</td>
              <td style={{ fontSize: 10.5, color: "var(--muted)" }}>{s.since}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

// ───────── Sessions / processes ─────────
const TopProcsCard = () => {
  const items = window.ACTIVE_SERVER_PROCS;
  return (
    <div className="card">
      <div className="card-h">
        <h3>Top processes by CPU</h3>
        <SourceBadge src="zbx" />
        <div className="h-spacer" />
        <span className="h-meta">proc.cpu.util · 30s</span>
      </div>
      <table className="link-tbl">
        <thead>
          <tr>
            <th>Process</th>
            <th style={{ width: 160 }}>User</th>
            <th style={{ width: 90, textAlign: "right" }}>CPU%</th>
            <th>RAM (MB)</th>
            <th style={{ width: 70, textAlign: "right" }}>Threads</th>
            <th style={{ width: 70, textAlign: "right" }}>PID</th>
          </tr>
        </thead>
        <tbody>
          {items.map(p => (
            <tr key={p.pid}>
              <td className="fg" style={{ color: "var(--accent)", fontFamily: "var(--mono)" }}>{p.name}</td>
              <td style={{ fontFamily: "var(--mono)", fontSize: 11 }}>{p.user}</td>
              <td style={{ textAlign: "right", fontFamily: "var(--mono)", color: p.cpu > 15 ? "var(--warn)" : "var(--fg)" }}>{p.cpu.toFixed(1)}</td>
              <td>
                <span className="util-bar"><i style={{ width: `${Math.min(100, p.mem / 2)}%` }} /></span>
                <span style={{ fontFamily: "var(--mono)", fontSize: 11 }}>{p.mem.toFixed(1)}</span>
              </td>
              <td style={{ textAlign: "right", fontFamily: "var(--mono)" }}>{p.threads}</td>
              <td style={{ textAlign: "right", fontFamily: "var(--mono)", color: "var(--muted)" }}>{p.pid}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

// ───────── Network interfaces ─────────
const InterfacesCard = () => {
  const items = window.ACTIVE_SERVER_IFACES;
  return (
    <div className="card">
      <div className="card-h">
        <h3>Network interfaces</h3>
        <SourceBadge src="zbx" />
        <div className="h-spacer" />
        <span className="h-meta">net.if.in/out · 30s</span>
      </div>
      <table className="link-tbl">
        <thead>
          <tr>
            <th style={{ width: 12 }}></th>
            <th style={{ width: 90 }}>Name</th>
            <th style={{ width: 80 }}>Speed</th>
            <th>IP</th>
            <th>MAC</th>
            <th style={{ width: 100, textAlign: "right" }}>RX Mbps</th>
            <th style={{ width: 100, textAlign: "right" }}>TX Mbps</th>
            <th style={{ width: 60, textAlign: "right" }}>Err</th>
          </tr>
        </thead>
        <tbody>
          {items.map(n => (
            <tr key={n.name}>
              <td><StatusDot state={n.status === "up" ? "ok" : "err"} /></td>
              <td className="fg" style={{ color: "var(--accent)", fontFamily: "var(--mono)" }}>{n.name}</td>
              <td style={{ fontFamily: "var(--mono)" }}>{n.speed >= 1000 ? `${n.speed / 1000}G` : `${n.speed}M`}</td>
              <td style={{ fontFamily: "var(--mono)", fontSize: 11 }}>{n.ip}</td>
              <td style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--muted)" }}>{n.mac}</td>
              <td style={{ textAlign: "right", fontFamily: "var(--mono)" }}>{n.inMbps}</td>
              <td style={{ textAlign: "right", fontFamily: "var(--mono)" }}>{n.outMbps}</td>
              <td style={{ textAlign: "right", color: n.errs > 0 ? "var(--warn)" : "var(--muted)", fontFamily: "var(--mono)" }}>{n.errs}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

// ───────── Sessions card ─────────
const SessionsCard = () => {
  const items = window.ACTIVE_SERVER_SESSIONS;
  return (
    <div className="card">
      <div className="card-h">
        <h3>Active sessions</h3>
        <SourceBadge src="zbx" />
        <div className="h-spacer" />
        <span className="h-meta">{items.length} sessions</span>
      </div>
      <table className="link-tbl">
        <thead>
          <tr>
            <th>User</th>
            <th style={{ width: 130 }}>Source</th>
            <th style={{ width: 70 }}>Type</th>
            <th>Database</th>
            <th style={{ width: 130 }}>Started</th>
            <th style={{ width: 90 }}>State</th>
            <th>Wait</th>
          </tr>
        </thead>
        <tbody>
          {items.map((s, i) => (
            <tr key={i}>
              <td className="fg" style={{ color: "var(--fg)", fontFamily: "var(--mono)", fontSize: 11.5 }}>{s.user}</td>
              <td style={{ fontFamily: "var(--mono)", fontSize: 11 }}>{s.src}</td>
              <td><span className={"role-tag " + (s.type === "TDS" ? "av" : s.type === "RDP" ? "faculty" : "byod")} style={{ fontSize: 10 }}>{s.type}</span></td>
              <td style={{ fontFamily: "var(--mono)", fontSize: 11 }}>{s.db}</td>
              <td style={{ fontSize: 10.5, color: "var(--muted)" }}>{s.start}</td>
              <td style={{ color: s.state === "RUNNING" || s.state === "ACTIVE" ? "var(--ok)" : "var(--muted)", fontFamily: "var(--mono)", fontSize: 11 }}>{s.state}</td>
              <td style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: s.waits === "—" ? "var(--muted)" : "var(--warn)" }}>{s.waits}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

// ───────── Server problems ─────────
const ServerProblems = () => {
  const items = window.SERVER_PROBLEMS;
  return (
    <div className="card">
      <div className="card-h">
        <h3>Problems</h3>
        <SourceBadge src="zbx" />
        <div className="h-spacer" />
        <Icon name="filter" size={12} />
        <Icon name="more" size={14} />
      </div>
      <div style={{ padding: "8px 14px 6px", fontSize: 11, color: "var(--muted)", letterSpacing: 0.4, textTransform: "uppercase", borderBottom: "1px solid var(--line)" }}>
        Triggers · last 24h
      </div>
      <div>
        {items.map((p, i) => (
          <div key={i} className={"problem-row " + (p.ack ? "ack" : "")}>
            <div className="top">
              <Sev level={p.sev} />
              <span className="host">{p.host}</span>
              <span className="age">{p.age}</span>
            </div>
            <div className="trig">{p.trig}</div>
            <div className="ts">{p.ts}{p.ack && " · ack"}</div>
          </div>
        ))}
      </div>
    </div>
  );
};

// ───────── Fleet overview cards (small status tiles) ─────────
const FleetOverview = ({ activeId, onSelect }) => {
  const all = window.SERVER_SITES.flatMap(s => s.servers.map(sv => ({ ...sv, site: s.name })));
  const ok = all.filter(s => s.status === "ok").length;
  const warn = all.filter(s => s.status === "warn").length;
  const err = all.filter(s => s.status === "err").length;
  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div className="card-h">
        <h3>Fleet</h3>
        <SourceBadge src="zbx" />
        <div className="h-spacer" />
        <span className="h-meta">
          <span style={{ color: "var(--ok)" }}>● {ok} online</span>
          <span style={{ marginLeft: 8, color: "var(--warn)" }}>● {warn} degraded</span>
          <span style={{ marginLeft: 8, color: "var(--err)" }}>● {err} critical</span>
        </span>
      </div>
      <div className="srv-grid">
        {all.map(sv => {
          const dot = sv.status === "ok" ? "var(--ok)" : sv.status === "warn" ? "var(--warn)" : "var(--err)";
          return (
            <div
              key={sv.id}
              className={"srv-tile" + (sv.id === activeId ? " active" : "")}
              onClick={() => onSelect(sv)}
            >
              <div className="srv-tile-h">
                <span className="dot" style={{ background: dot, boxShadow: sv.status === "ok" ? `0 0 4px ${dot}` : "none" }} />
                <span className="srv-id">{sv.id}</span>
                <span className={"srv-kind " + sv.kind}>{sv.kind === "phys" ? "PHYS" : "VM"}</span>
              </div>
              <div className="srv-role">{sv.role}</div>
              <div className="srv-bars">
                <div className="srv-bar"><span className="lbl">CPU</span><span className="track"><i style={{ width: `${sv.cpu}%`, background: sv.cpu > 75 ? "var(--warn)" : "var(--info)" }} /></span><span className="num">{sv.cpu}%</span></div>
                <div className="srv-bar"><span className="lbl">MEM</span><span className="track"><i style={{ width: `${sv.mem}%`, background: sv.mem > 80 ? "var(--warn)" : "var(--zbx)" }} /></span><span className="num">{sv.mem}%</span></div>
                <div className="srv-bar"><span className="lbl">DSK</span><span className="track"><i style={{ width: `${sv.diskPct}%`, background: sv.diskPct > 80 ? "var(--warn)" : "var(--ok)" }} /></span><span className="num">{sv.diskPct}%</span></div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

window.ServerNavigator = ServerNavigator;
window.ServerKPIs = ServerKPIs;
window.ServerSidecar = ServerSidecar;
window.FilesystemsCard = FilesystemsCard;
window.ServicesCard = ServicesCard;
window.TopProcsCard = TopProcsCard;
window.InterfacesCard = InterfacesCard;
window.SessionsCard = SessionsCard;
window.ServerProblems = ServerProblems;
window.FleetOverview = FleetOverview;
