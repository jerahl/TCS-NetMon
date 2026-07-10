// FortiGate Firewall Status — single-device deep dive for the TCS Central Office
// HA pair. Layout: header → KPI strip → throughput 24h → sessions → health
// rings → interfaces → IPsec / SSL-VPN → SD-WAN SLA → UTM → top threats /
// policies → events.

const { useState, useEffect } = React;

// ───────── Live data bindings ─────────
// Data globals are populated by fortigate-bridge.jsx (from window.FG_BOOT on
// first paint, then refreshed by fetch to tcs.fortigate.data). These `let`s
// are live bindings — child components reference them by name and pick up
// reassignments when the bridge fires "tcs:fortigate-data". App listens for
// that event and bumps a render counter to force the tree to re-evaluate.
let FG_DEVICE           = window.FG_DEVICE           || {};
let FG_TOTALS           = window.FG_TOTALS           || {};
let FG_INTERFACES       = window.FG_INTERFACES       || [];
let FG_IPSEC            = window.FG_IPSEC            || [];
let FG_SSLVPN           = window.FG_SSLVPN           || [];
let FG_SDWAN            = window.FG_SDWAN            || { sla: [], latencyHistory: {}, preferredLink: "" };
let FG_UTM              = window.FG_UTM              || [];
let FG_TOP_THREATS      = window.FG_TOP_THREATS      || [];
let FG_TOP_POLICIES     = window.FG_TOP_POLICIES     || [];
let FG_SESSIONS_24H     = window.FG_SESSIONS_24H     || new Array(24).fill(0);
let FG_NEW_SESSIONS_24H = window.FG_NEW_SESSIONS_24H || new Array(24).fill(0);
let FG_THROUGHPUT_24H   = window.FG_THROUGHPUT_24H   || { ingress: new Array(24).fill(0), egress: new Array(24).fill(0) };
let FG_EVENTS           = window.FG_EVENTS           || [];
window.addEventListener("tcs:fortigate-data", () => {
  FG_DEVICE           = window.FG_DEVICE           || FG_DEVICE;
  FG_TOTALS           = window.FG_TOTALS           || FG_TOTALS;
  FG_INTERFACES       = window.FG_INTERFACES       || FG_INTERFACES;
  FG_IPSEC            = window.FG_IPSEC            || FG_IPSEC;
  FG_SSLVPN           = window.FG_SSLVPN           || FG_SSLVPN;
  FG_SDWAN            = window.FG_SDWAN            || FG_SDWAN;
  FG_UTM              = window.FG_UTM              || FG_UTM;
  FG_TOP_THREATS      = window.FG_TOP_THREATS      || FG_TOP_THREATS;
  FG_TOP_POLICIES     = window.FG_TOP_POLICIES     || FG_TOP_POLICIES;
  FG_SESSIONS_24H     = window.FG_SESSIONS_24H     || FG_SESSIONS_24H;
  FG_NEW_SESSIONS_24H = window.FG_NEW_SESSIONS_24H || FG_NEW_SESSIONS_24H;
  FG_THROUGHPUT_24H   = window.FG_THROUGHPUT_24H   || FG_THROUGHPUT_24H;
  FG_EVENTS           = window.FG_EVENTS           || FG_EVENTS;
});

// Reuse XIQ's severity palette for cards.
const fgSev = {
  ok:       { bg: "rgba(52,211,153,0.10)",  bd: "rgba(52,211,153,0.35)", fg: "var(--ok)"   },
  info:     { bg: "rgba(95,168,211,0.10)",  bd: "rgba(95,168,211,0.35)", fg: "var(--info)" },
  warning:  { bg: "rgba(245,179,0,0.12)",   bd: "rgba(245,179,0,0.40)",  fg: "var(--warn)" },
  high:     { bg: "rgba(242,95,92,0.14)",   bd: "rgba(242,95,92,0.45)",  fg: "var(--err)"  },
  disaster: { bg: "rgba(242,95,92,0.28)",   bd: "var(--err)",            fg: "#ffd0cf"     },
};

// Format large numbers compactly: 184_213 → "184k", 1_244_812 → "1.24M".
const compact = (n) => {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
  return n.toLocaleString();
};

// ───────── Header ─────────
const FGHeader = ({ now, timeRange, setTimeRange }) => {
  const d = FG_DEVICE;
  return (
    <div className="page-header" style={{ alignItems: "center" }}>
      <div style={{ flex: 1 }}>
        <div className="host-title">
          <h1>FortiGate · {d.host}</h1>
          <SourceBadge src="zbx" />
          <span className="role-tag voip" style={{ fontSize: 10, padding: "1px 8px" }}>EDGE · UTM</span>
          <span className="ip">{d.mgmtIp}</span>
        </div>
        <div className="host-meta">
          <span className="pill"><span className="refresh-ring" /> <span className="lbl">SNMP poll</span> <span className="v">{d.lastSync}</span></span>
          <span className="pill"><span className="lbl">Model</span> <span className="v">{d.model}</span></span>
          <span className="pill"><span className="lbl">FortiOS</span> <span className="v">{d.fos}</span></span>
          <span className="pill"><span className="lbl">HA</span> <span className="v">{d.ha}</span></span>
          <span className="pill"><span className="lbl">Uptime</span> <span className="v">{d.uptime}</span></span>
          <span className="pill"><span className="dot" style={{ background: "var(--ok)" }} /> Cluster healthy</span>
          <span className="pill"><span className="lbl">Refresh</span> <span className="v">{now}</span></span>
        </div>
      </div>
      <div className="timerange">
        <Icon name="calendar" />
        <span className="range-val">{timeRange}</span>
        <Icon name="chevron" />
      </div>
    </div>
  );
};

// ───────── KPI strip (6 cells) ─────────
const FGKPIStrip = () => {
  const t = FG_TOTALS;
  const sessLimit = t.sessions.limit || 0;
  const sessPct   = sessLimit > 0 ? (t.sessions.active / sessLimit) * 100 : 0;
  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div className="fg-kpi">
        <div className="fg-kpi-cell">
          <div className="fg-kpi-h"><span className="fg-kpi-lbl">Active Sessions</span><SourceBadge src="zbx" /></div>
          <div className="fg-kpi-v">{compact(t.sessions.active)}</div>
          <div className="fg-kpi-bar"><div style={{ width: `${Math.min(100, sessPct)}%`, background: "var(--ok)" }} /></div>
          <div className="fg-kpi-foot">{sessLimit > 0 ? `${sessPct.toFixed(2)}% of ${(sessLimit/1e6).toFixed(0)}M cap` : "cap unknown"} · peak {compact(t.sessions.peak)}</div>
        </div>
        <div className="fg-kpi-cell">
          <div className="fg-kpi-h"><span className="fg-kpi-lbl">New / sec</span><SourceBadge src="zbx" /></div>
          <div className="fg-kpi-v">{t.sessions.new_per_s.toLocaleString()}</div>
          <div className="fg-kpi-foot">conntrack rate · 24h avg 2,840 / s</div>
        </div>
        <div className="fg-kpi-cell ext">
          <div className="fg-kpi-h"><span className="fg-kpi-lbl">Throughput</span><SourceBadge src="zbx" /></div>
          <div className="fg-kpi-v">{t.throughput.total_gbps.toFixed(2)}<span className="u">Gbps</span></div>
          <div className="fg-kpi-foot">↓ {t.throughput.wan_in_gbps.toFixed(2)} · ↑ {t.throughput.wan_out_gbps.toFixed(2)} · peak {t.throughput.peak_gbps.toFixed(1)}</div>
        </div>
        <div className="fg-kpi-cell warn">
          <div className="fg-kpi-h"><span className="fg-kpi-lbl">CPU · 15m peak</span><SourceBadge src="zbx" /></div>
          <div className="fg-kpi-v">{t.cpu.peak15m}<span className="u">%</span></div>
          <div className="fg-kpi-bar"><div style={{ width: `${t.cpu.peak15m}%`, background: t.cpu.peak15m > t.cpu.target ? "var(--warn)" : "var(--ok)" }} /></div>
          <div className="fg-kpi-foot">now {t.cpu.now}% · alert ≥ {t.cpu.target}%</div>
        </div>
        <div className="fg-kpi-cell err">
          <div className="fg-kpi-h"><span className="fg-kpi-lbl">Threats Blocked · 24h</span><SourceBadge src="zbx" /></div>
          <div className="fg-kpi-v">{compact(t.threats.ips_blocks_24h + t.threats.av_blocks_24h + t.threats.web_blocks_24h + t.threats.app_blocks_24h)}</div>
          <div className="fg-kpi-foot">IPS {compact(t.threats.ips_blocks_24h)} · WF {compact(t.threats.web_blocks_24h)} · AV {t.threats.av_blocks_24h}</div>
        </div>
        <div className="fg-kpi-cell ok">
          <div className="fg-kpi-h"><span className="fg-kpi-lbl">VPN Status</span><SourceBadge src="zbx" /><SourceBadge src="pf" /></div>
          <div className="fg-kpi-v">{t.vpn.ipsec_up}<span className="u">/ {t.vpn.ipsec_total} IPsec</span></div>
          <div className="fg-kpi-foot">{t.vpn.ssl_users} SSL-VPN users · peak 24h {t.vpn.ssl_peak_24h}</div>
        </div>
      </div>
    </div>
  );
};

// ───────── Throughput 24h chart (SVG dual-area) ─────────
const FGThroughputChart = () => {
  const { ingress, egress } = FG_THROUGHPUT_24H;
  const max = (Math.max(...ingress, ...egress) || 1) * 1.15;
  const W = 100, H = 100; // viewBox %
  const stepX = W / (ingress.length - 1);
  const toPath = (data, fillBottom = true) => {
    const pts = data.map((v, i) => [i * stepX, H - (v / max) * H]);
    const line = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p[0].toFixed(2)},${p[1].toFixed(2)}`).join(" ");
    return fillBottom ? `${line} L${W},${H} L0,${H} Z` : line;
  };
  const gridLines = [0.25, 0.5, 0.75];
  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div className="card-h">
        <h3>WAN Throughput · 24h</h3>
        <SourceBadge src="zbx" />
        <div className="h-spacer" />
        <span className="h-meta">peak {FG_TOTALS.throughput.peak_gbps.toFixed(1)} Gbps · sampled 5m</span>
      </div>
      <div className="tput2-row">
        <div className="tput2-chart">
          <svg className="tput2-svg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
            <g className="tput2-grid">
              {gridLines.map((g, i) => <line key={i} x1="0" x2={W} y1={H*g} y2={H*g} />)}
            </g>
            {/* Ingress (filled, info color) */}
            <path d={toPath(ingress, true)} fill="rgba(95,168,211,0.18)" />
            <path d={toPath(ingress, false)} stroke="var(--info)" strokeWidth="0.6" fill="none" vectorEffect="non-scaling-stroke" />
            {/* Egress (filled, ext color) */}
            <path d={toPath(egress, true)} fill="rgba(124,92,255,0.20)" />
            <path d={toPath(egress, false)} stroke="var(--ext)" strokeWidth="0.6" fill="none" vectorEffect="non-scaling-stroke" />
          </svg>
        </div>
        <div className="tput2-side">
          <div className="tput2-stat">
            <div className="tput2-stat-lbl"><span className="dot" style={{ background: "var(--info)" }} /> Ingress (RX)</div>
            <div className="tput2-stat-v">{FG_TOTALS.throughput.wan_in_gbps.toFixed(2)}<span className="u">Gbps</span></div>
          </div>
          <div className="tput2-stat">
            <div className="tput2-stat-lbl"><span className="dot" style={{ background: "var(--ext)" }} /> Egress (TX)</div>
            <div className="tput2-stat-v">{FG_TOTALS.throughput.wan_out_gbps.toFixed(2)}<span className="u">Gbps</span></div>
          </div>
          <div className="tput2-stat">
            <div className="tput2-stat-lbl">LAN total</div>
            <div className="tput2-stat-v">{FG_TOTALS.throughput.lan_gbps.toFixed(2)}<span className="u">Gbps</span></div>
          </div>
        </div>
      </div>
    </div>
  );
};

// ───────── Session sparks (3 stacked rows: active, new/s, inspected) ─────────
const FGSessions = () => (
  <div className="card">
    <div className="card-h">
      <h3>Session Activity · 24h</h3>
      <SourceBadge src="zbx" />
      <div className="h-spacer" />
      <span className="h-meta">conntrack · 5m bins</span>
    </div>
    <div className="sess-grid">
      <div className="sess-row">
        <div className="sess-lbl">Concurrent</div>
        <Sparkline data={FG_SESSIONS_24H} color="var(--ok)" width={400} height={38} fill={true} />
        <div>
          <div className="sess-val">{compact(FG_TOTALS.sessions.active)}</div>
          <div className="sess-sub">peak {compact(FG_TOTALS.sessions.peak)}</div>
        </div>
      </div>
      <div className="sess-row">
        <div className="sess-lbl">New / sec</div>
        <Sparkline data={FG_NEW_SESSIONS_24H} color="var(--ext)" width={400} height={38} fill={true} />
        <div>
          <div className="sess-val">{FG_TOTALS.sessions.new_per_s.toLocaleString()}<span className="u">/s</span></div>
          <div className="sess-sub">peak 4,640 / s</div>
        </div>
      </div>
      <div className="sess-row">
        <div className="sess-lbl">UTM inspected</div>
        <Sparkline data={FG_NEW_SESSIONS_24H.map(v => v * 0.84)} color="var(--zbx)" width={400} height={38} fill={true} />
        <div>
          <div className="sess-val">3,467<span className="u">/s</span></div>
          <div className="sess-sub">SSL: 62% deep-inspect</div>
        </div>
      </div>
    </div>
  </div>
);

// ───────── Health rings strip (CPU, Mem, Disk, Sessions) ─────────
const FGHealthStrip = () => {
  const t = FG_TOTALS;
  const sessLimit = t.sessions.limit || 0;
  const sessUtilPct = sessLimit > 0 ? (t.sessions.active / sessLimit) * 100 : 0;
  const items = [
    { v: t.cpu.now,  lbl: "CPU",      sub: `peak 15m ${t.cpu.peak15m}%`,  threshold: t.cpu.target, color: t.cpu.now > t.cpu.target ? "var(--err)" : t.cpu.now > 50 ? "var(--warn)" : "var(--ok)" },
    { v: t.mem.now,  lbl: "Memory",   sub: `peak 15m ${t.mem.peak15m}%`,  threshold: t.mem.target, color: t.mem.now > t.mem.target ? "var(--err)" : "var(--info)" },
    { v: t.disk.now, lbl: "Disk · /var/log", sub: "log rotation OK",      threshold: t.disk.target, color: t.disk.now > t.disk.target ? "var(--warn)" : "var(--ok)" },
    { v: sessUtilPct, lbl: "Session cap", sub: sessLimit > 0 ? `${compact(t.sessions.active)} / ${(sessLimit/1e6).toFixed(0)}M` : compact(t.sessions.active), color: "var(--ext)" },
  ];
  return (
    <div className="card">
      <div className="card-h">
        <h3>Device Health</h3>
        <SourceBadge src="zbx" />
        <div className="h-spacer" />
        <span className="h-meta">primary node · 60s window</span>
      </div>
      <div className="fg-health-strip">
        {items.map((it, i) => (
          <div className="fg-health-cell" key={i}>
            <Ring value={it.v} size={64} color={it.color} label={`${it.v.toFixed(it.v < 10 ? 1 : 0)}%`} />
            <div className="fg-health-meta">
              <div className="lbl">{it.lbl}</div>
              <div className="sub">{it.sub}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

// ───────── Interfaces table ─────────
const FGInterfaces = () => (
  <div className="card">
    <div className="card-h">
      <h3>Interfaces · Physical & Virtual</h3>
      <SourceBadge src="zbx" />
      <div className="h-spacer" />
      <span className="h-meta">{FG_INTERFACES.filter(i=>i.up).length} of {FG_INTERFACES.length} up</span>
    </div>
    <div className="card-b tight" style={{ maxHeight: 380, overflow: "auto" }}>
      <table className="tbl if-tbl">
        <thead>
          <tr>
            <th>Interface</th>
            <th>Role</th>
            <th style={{ width: 60 }}>Speed</th>
            <th style={{ width: 64, textAlign: "right" }}>VLANs</th>
            <th style={{ width: 70, textAlign: "right" }}>RX Mbps</th>
            <th style={{ width: 70, textAlign: "right" }}>TX Mbps</th>
            <th style={{ width: 140 }}>Util</th>
            <th style={{ width: 64 }}>State</th>
          </tr>
        </thead>
        <tbody>
          {FG_INTERFACES.map(i => {
            const rxPct = Math.min(60, (i.rx_mbps / (parseInt(i.speed)*1000)) * 100);
            const txPct = Math.min(60, (i.tx_mbps / (parseInt(i.speed)*1000)) * 100);
            return (
              <tr key={i.id}>
                <td className="fg">{i.id}</td>
                <td>{i.role}</td>
                <td>{i.speed}</td>
                <td style={{ textAlign: "right" }}>{i.vlans || "—"}</td>
                <td style={{ textAlign: "right" }} className="fg">{i.rx_mbps.toLocaleString()}</td>
                <td style={{ textAlign: "right" }} className="fg">{i.tx_mbps.toLocaleString()}</td>
                <td>
                  <div className="if-traffic-bar">
                    <div className="rx" style={{ width: `${rxPct}%` }} />
                    <div className="tx" style={{ width: `${txPct}%` }} />
                  </div>
                </td>
                <td>
                  <span className={"if-state " + (i.up ? "up" : "down")}>
                    <span className="dot" />
                    {i.up ? "UP" : "DOWN"}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  </div>
);

// ───────── IPsec tunnel list ─────────
const FGIPsec = () => (
  <div className="card">
    <div className="card-h">
      <h3>IPsec Site-to-Site Tunnels</h3>
      <SourceBadge src="zbx" />
      <div className="h-spacer" />
      <span className="h-meta">{FG_IPSEC.filter(t=>t.state==="up").length} / {FG_IPSEC.length} up</span>
    </div>
    <div className="ipsec-head">
      <span>Tunnel · Peer</span>
      <span style={{ textAlign: "right" }}>RX MB</span>
      <span style={{ textAlign: "right" }}>TX MB</span>
      <span style={{ textAlign: "right" }}>Latency</span>
      <span />
    </div>
    {FG_IPSEC.map(t => {
      const latCls = t.latency > 20 ? "warn" : t.state === "down" ? "err" : "ok";
      return (
        <div className="ipsec-row" key={t.id}>
          <div className="ipsec-id">
            <span>{t.id}</span>
            <span className="peer">peer {t.peer} · {t.phase2} ph2 · since {t.since}</span>
          </div>
          <div className="v">{t.state === "down" ? "—" : t.rxMb.toLocaleString()}</div>
          <div className="v">{t.state === "down" ? "—" : t.txMb.toLocaleString()}</div>
          <div className={"lat " + latCls}>{t.state === "down" ? "DOWN" : `${t.latency.toFixed(1)} ms`}</div>
          <div><span className={"ipsec-state-dot " + t.state} /></div>
        </div>
      );
    })}
  </div>
);

// ───────── SSL-VPN sessions ─────────
const FGSSLVPN = () => (
  <div className="card">
    <div className="card-h">
      <h3>SSL-VPN · Connected Users</h3>
      <SourceBadge src="zbx" />
      <SourceBadge src="pf" />
      <div className="h-spacer" />
      <span className="h-meta">{FG_SSLVPN.length} active · peak 24h {FG_TOTALS.vpn.ssl_peak_24h}</span>
    </div>
    <div className="sslvpn-head">
      <span>User</span>
      <span>Role</span>
      <span>Src → Dst</span>
      <span style={{ textAlign: "right" }}>Dur</span>
      <span style={{ textAlign: "right" }}>RX MB</span>
      <span style={{ textAlign: "center" }}>MFA</span>
    </div>
    {FG_SSLVPN.map(u => (
      <div className="sslvpn-row" key={u.user}>
        <div className="sslvpn-user">{u.user}</div>
        <div><span className={"role-tag " + (u.role === "vendor" ? "guest" : u.role === "admin" ? "av" : "faculty")} style={{ fontSize: 9.5, padding: "0 6px" }}>{u.role}</span></div>
        <div className="ip">{u.src} → {u.dst}</div>
        <div className="dur">{u.dur}</div>
        <div className="mb">{u.rxMb}</div>
        <div style={{ textAlign: "center" }}><span className={"mfa-pill " + (u.mfa ? "yes" : "no")}>{u.mfa ? "MFA" : "NO"}</span></div>
      </div>
    ))}
  </div>
);

// ───────── SD-WAN SLA ─────────
const FGSDWan = () => {
  const w = FG_SDWAN;
  return (
    <div className="card">
      <div className="card-h">
        <h3>SD-WAN · SLA per Link</h3>
        <SourceBadge src="zbx" />
        <div className="h-spacer" />
        <span className="h-meta">{w.rules} rules · preferred {w.preferredLink}</span>
      </div>
      {w.sla.map(l => {
        const isPreferred = l.link.startsWith(w.preferredLink);
        const latColor = l.latency > 30 ? "var(--err)" : l.latency > 15 ? "var(--warn)" : "var(--ok)";
        const lossCls = l.loss > 0.5 ? "err" : l.loss > 0.1 ? "warn" : "";
        const key = l.link.split(" ")[0]; // wan1 / wan2 / wan3
        return (
          <div className={"sdwan-row" + (isPreferred ? " preferred" : "")} key={l.link}>
            <div className="sdwan-h">
              <span className="sdwan-link-name">{l.link}</span>
              <span className="sdwan-weight">weight {l.weight}</span>
            </div>
            <div className="sdwan-metrics">
              <div className="sdwan-metric">
                <div className="lbl">Latency</div>
                <div className="v" style={{ color: latColor }}>{l.latency.toFixed(1)} <span style={{ fontSize: 10, color: "var(--muted)" }}>ms</span></div>
              </div>
              <div className="sdwan-metric">
                <div className="lbl">Jitter</div>
                <div className="v">{l.jitter.toFixed(1)} <span style={{ fontSize: 10, color: "var(--muted)" }}>ms</span></div>
              </div>
              <div className="sdwan-metric">
                <div className="lbl">Loss</div>
                <div className={"v " + lossCls}>{l.loss.toFixed(2)} <span style={{ fontSize: 10, color: "var(--muted)" }}>%</span></div>
              </div>
              <Sparkline data={w.latencyHistory[key]} color={latColor} width={100} height={32} fill={true} />
            </div>
          </div>
        );
      })}
    </div>
  );
};

// ───────── UTM module activity (3×2 grid) ─────────
const FGUtmGrid = () => (
  <div className="card">
    <div className="card-h">
      <h3>UTM · Threat Protection · 24h</h3>
      <SourceBadge src="zbx" />
      <div className="h-spacer" />
      <span className="h-meta">FortiGuard subscriptions active</span>
    </div>
    <div className="utm-grid">
      {FG_UTM.map(u => (
        <div className="utm-cell" key={u.id}>
          <div className="utm-h">
            <span className="utm-dot" style={{ background: u.color }} />
            <span className="utm-lbl">{u.label}</span>
          </div>
          <div className="utm-v" style={{ color: u.color }}>{u.blocks.toLocaleString()}</div>
          <div className="utm-foot">
            <span>{u.unique} unique</span>
            {u.severity_hi > 0 && <span style={{ color: "var(--err)" }}>· {u.severity_hi} high</span>}
          </div>
        </div>
      ))}
    </div>
    <div className="fg-fguard">
      <div className="fguard-cell"><span className="dot" /><span className="lbl">IPS DB</span> <span className="v">v25.1924</span></div>
      <div className="fguard-cell"><span className="dot" /><span className="lbl">AV DB</span>  <span className="v">v92.0488</span></div>
      <div className="fguard-cell"><span className="dot" /><span className="lbl">WF DB</span>  <span className="v">v8.084</span></div>
      <div className="fguard-cell"><span className="dot" /><span className="lbl">App ctrl</span> <span className="v">v25.092</span></div>
      <div className="fguard-cell"><span className="dot" /><span className="lbl">FortiGuard</span> <span className="v">{FG_TOTALS.fortiguard.expiresDays}d left</span></div>
    </div>
  </div>
);

// ───────── Top threats list ─────────
const FGTopThreats = () => (
  <div className="card">
    <div className="card-h">
      <h3>Top Threat Signatures · 24h</h3>
      <SourceBadge src="zbx" />
      <div className="h-spacer" />
      <a className="h-link">Open in FortiAnalyzer <Icon name="external" size={11} /></a>
    </div>
    {FG_TOP_THREATS.map((t, i) => (
      <div className="thr-row" key={i}>
        <div className="thr-main">
          <span className="thr-sig">{t.sig}</span>
          <span className="thr-meta">
            <span className="thr-cat">{t.cat}</span>
            <Sev level={t.sev} />
            <span>src {t.src}</span>
          </span>
        </div>
        <div className="thr-cnt">{t.count.toLocaleString()}</div>
        <div><span className="thr-cc">{t.dstCC}</span></div>
        <div>{t.sev === "disaster" || t.sev === "high"
          ? <span className="dot pulse-dot" style={{ background: "var(--err)" }} />
          : <Icon name="chevron" size={12} />}</div>
      </div>
    ))}
  </div>
);

// ───────── Top policies ─────────
const FGTopPolicies = () => {
  const max = FG_TOP_POLICIES.length ? Math.max(...FG_TOP_POLICIES.map(p => p.hits24h)) : 1;
  return (
    <div className="card">
      <div className="card-h">
        <h3>Top Policies by Hit Count · 24h</h3>
        <SourceBadge src="zbx" />
        <div className="h-spacer" />
        <span className="h-meta">{FG_TOTALS.policies.total} total · {FG_TOTALS.policies.unused_30d} unused 30d</span>
      </div>
      <div className="card-b tight" style={{ maxHeight: 380, overflow: "auto" }}>
        <table className="tbl pol-tbl">
          <thead>
            <tr>
              <th style={{ width: 36 }}>ID</th>
              <th>Policy</th>
              <th style={{ width: 110 }}>From → To</th>
              <th style={{ width: 60 }}>Action</th>
              <th style={{ width: 130, textAlign: "right" }}>Hits / 24h</th>
            </tr>
          </thead>
          <tbody>
            {FG_TOP_POLICIES.map(p => {
              const pct = (p.hits24h / max) * 100;
              return (
                <tr key={p.id}>
                  <td><span className="pol-id">{p.id}</span></td>
                  <td className="fg" style={{ whiteSpace: "nowrap" }}>{p.name}</td>
                  <td style={{ fontSize: 10.5, color: "var(--muted)" }}>
                    {p.from}<br />→ {p.to}
                  </td>
                  <td><span className={"pol-action " + p.action}>{p.action}</span></td>
                  <td style={{ textAlign: "right" }}>
                    <div className="pol-hits">{compact(p.hits24h)}</div>
                    <div className="pol-hits-bar"><div style={{ width: `${pct}%` }} /></div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
};

// ───────── Events stream ─────────
const FGEvents = () => (
  <div className="events">
    {FG_EVENTS.map((e, i) => (
      <div className="event" key={i}>
        <div className="ts">{e.ts}</div>
        <div className={"src " + e.source}>{e.source.toUpperCase()}</div>
        <div className="mono" style={{ fontSize: 11, color: "var(--fg-2)" }}>{e.host}</div>
        <div className="msg">
          <span style={{
            color: e.sev === "ok" ? "var(--ok)"
                : e.sev === "high" || e.sev === "disaster" ? "var(--err)"
                : e.sev === "warning" ? "var(--warn)"
                : "var(--info)",
            fontWeight: 500
          }}>{e.msg}</span>
          <span style={{ color: "var(--fg)" }}>{e.obj}</span>
        </div>
      </div>
    ))}
  </div>
);

// ───────── App shell ─────────
const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "density": "balanced",
  "showSourceBadges": true,
  "showSDWAN": true,
  "view": "operations"
}/*EDITMODE-END*/;

// Banner shown when the bridge surfaces an error/warning (e.g. no FortiGate
// host templated yet). Mirrors XIQBanner.
const FGBanner = () => {
  const b = window.FG_BANNER;
  if (!b) return null;
  const fg = b.kind === "error" ? "var(--err)" : "var(--warn)";
  const bd = b.kind === "error" ? "rgba(242,95,92,0.45)" : "rgba(245,179,0,0.45)";
  const bg = b.kind === "error" ? "rgba(242,95,92,0.10)" : "rgba(245,179,0,0.10)";
  return (
    <div style={{
      margin: "0 14px 12px", padding: "10px 14px", borderRadius: 8,
      border: `1px solid ${bd}`, background: bg, color: fg, fontSize: 12.5
    }}>
      <strong style={{ marginRight: 8, textTransform: "uppercase", letterSpacing: ".06em", fontSize: 10.5 }}>{b.kind}</strong>
      {b.msg}
    </div>
  );
};

const App = () => {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
  const [timeRange, setTimeRange] = useState("Last 1h");
  const [now, setNow] = useState("just now");
  const [, setTick] = useState(0);

  useEffect(() => {
    document.documentElement.classList.toggle("hide-src-badges", !t.showSourceBadges);
  }, [t.showSourceBadges]);

  // Re-render whenever fortigate-bridge.jsx swaps in a fresh
  // tcs.fortigate.data payload.
  useEffect(() => {
    const onData = () => {
      setNow(new Date().toLocaleTimeString());
      setTick(n => n + 1);
    };
    window.addEventListener("tcs:fortigate-data", onData);
    return () => window.removeEventListener("tcs:fortigate-data", onData);
  }, []);

  return (
    <div className="app" data-density={t.density} data-screen-label="FortiGate Firewall">
      <GlobalSidebar active="firewall" />
      <div className="main">
        <GlobalTopbar
          crumb={["Tuscaloosa City Schools", "Edge / Security", "FortiGate · fw-tcs-co-01"]}
          search="Find policy, address object, signature, user…"
        />
        <FGHeader now={now} timeRange={timeRange} setTimeRange={setTimeRange} />
        <FGBanner />
        <div className="body">
          <FGKPIStrip />
          <FGThroughputChart />

          <div className="row" data-fg-row style={{ gridTemplateColumns: "1fr", marginBottom: 14 }}>
            <FGSessions />
          </div>

          <div className="row" data-fg-row style={{ gridTemplateColumns: "1fr", marginBottom: 14 }}>
            <FGHealthStrip />
          </div>

          <div className="row" data-fg-row style={{ gridTemplateColumns: "1fr", marginBottom: 14 }}>
            <FGInterfaces />
          </div>

          <div className="row" data-fg-row style={{ gridTemplateColumns: "1.3fr 1fr", marginBottom: 14 }}>
            <FGIPsec />
            <FGSSLVPN />
          </div>

          {t.showSDWAN && (
            <div className="row" data-fg-row style={{ gridTemplateColumns: "1fr 1fr", marginBottom: 14 }}>
              <FGSDWan />
              <FGUtmGrid />
            </div>
          )}

          <div className="row" data-fg-row style={{ gridTemplateColumns: "1fr 1.2fr", marginBottom: 14 }}>
            <FGTopThreats />
            <FGTopPolicies />
          </div>

          <div className="card">
            <div className="card-h">
              <h3>FortiGate · Recent Events</h3>
              <SourceBadge src="zbx" />
              <SourceBadge src="pf" />
              <div className="h-spacer" />
              <a className="h-link">Open in event console <Icon name="external" size={11} /></a>
            </div>
            <div className="card-b tight">
              <FGEvents />
            </div>
          </div>
        </div>
      </div>

      <TweaksPanel title="Tweaks">
        <TweakSection label="Layout">
          <TweakRadio label="Density" value={t.density} options={[
            { value: "spacious", label: "Spacious" },
            { value: "balanced", label: "Balanced" },
            { value: "dense",    label: "Dense"    }
          ]} onChange={v => setTweak("density", v)} />
          <TweakToggle label="Show source badges (ZBX/PF)" value={t.showSourceBadges} onChange={v => setTweak("showSourceBadges", v)} />
        </TweakSection>
        <TweakSection label="Sections">
          <TweakToggle label="SD-WAN + UTM" value={t.showSDWAN} onChange={v => setTweak("showSDWAN", v)} />
        </TweakSection>
        <TweakSection label="Quick actions">
          <TweakButton onClick={() => { setNow(new Date().toLocaleTimeString()); if (window.tcsFortigateRefresh) window.tcsFortigateRefresh(); }} label="Refresh now" />
        </TweakSection>
      </TweaksPanel>
    </div>
  );
};

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
