// Cortex XDR · TCS Security tenant — endpoint detection & response dashboard.
// Layout: header → KPI strip → featured active incident (kill-chain + actions)
// → incident severity 7d + detection sources → MITRE ATT&CK heatmap →
// endpoint agent OS strip → top risky users / hosts → alerts table → hunts
// → events.

const { useState, useEffect } = React;

// Compact numbers
const xdrCompact = (n) => {
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
  return n.toLocaleString();
};

// Score → class
const scoreClass = (s) => s >= 85 ? "crit" : s >= 65 ? "high" : s >= 45 ? "med" : "low";

// ───────── Header ─────────
const XdrHeader = ({ now, timeRange }) => {
  const t = XDR_TENANT;
  const k = XDR_KPI;
  return (
    <div className="page-header" style={{ alignItems: "center" }}>
      <div style={{ flex: 1 }}>
        <div className="host-title">
          <h1>Cortex XDR <small>· {t.name}</small></h1>
          <SourceBadge src="xdr" />
          <span className="role-tag voip" style={{ fontSize: 10, padding: "1px 8px" }}>SECURITY OPS</span>
          <span className="ip">{t.console}</span>
        </div>
        <div className="host-meta">
          <span className="pill"><span className="refresh-ring" /> <span className="lbl">Tenant sync</span> <span className="v">{t.lastSync}</span></span>
          <span className="pill"><span className="lbl">Tenant ID</span> <span className="v">{t.tenantId}</span></span>
          <span className="pill"><span className="lbl">Region</span> <span className="v">{t.region}</span></span>
          <span className="pill"><span className="lbl">Agents</span> <span className="v">{xdrCompact(t.agentsDeployed)}/{xdrCompact(t.agentsTotal)}</span></span>
          <span className="pill"><span className="lbl">Policy</span> <span className="v">{t.policyVersion}</span></span>
          <span className="pill"><span className="lbl">Content</span> <span className="v">{t.contentPack}</span></span>
          <span className="pill"><span className="dot" style={{ background: "var(--err)" }} /> {k.incidents.open} open incidents</span>
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

// ───────── KPI strip ─────────
const XdrKpiStrip = () => {
  const k = XDR_KPI;
  const inc = k.incidents;
  const totalInc = inc.critical + inc.high + inc.med + inc.low;
  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div className="xdr-kpi">
        <div className="xdr-kpi-cell crit">
          <div className="xdr-kpi-h"><span className="xdr-kpi-lbl">Open Incidents</span><SourceBadge src="xdr" /></div>
          <div className="xdr-kpi-v">{inc.open}<span className="u">· +{inc.new24h} new 24h</span></div>
          <div className="xdr-sev-mini">
            <div style={{ flex: inc.critical, background: "var(--err)" }} title={`${inc.critical} critical`} />
            <div style={{ flex: inc.high,     background: "var(--xdr)" }} title={`${inc.high} high`} />
            <div style={{ flex: inc.med,      background: "var(--warn)" }} title={`${inc.med} medium`} />
            <div style={{ flex: inc.low,      background: "var(--info)" }} title={`${inc.low} low`} />
          </div>
          <div className="xdr-kpi-foot">
            <span style={{ color: "var(--err)" }}>{inc.critical} crit</span>
            <span>· {inc.high} high</span>
            <span>· {inc.med} med</span>
            <span>· {inc.low} low</span>
          </div>
        </div>
        <div className="xdr-kpi-cell pink">
          <div className="xdr-kpi-h"><span className="xdr-kpi-lbl">Alerts · 24h</span><SourceBadge src="xdr" /></div>
          <div className="xdr-kpi-v">{xdrCompact(k.alerts24h.total)}</div>
          <Sparkline data={XDR_ALERTS_24H} color="var(--xdr)" width={180} height={28} fill={true} />
          <div className="xdr-kpi-foot">{k.alerts24h.investigated} triaged · {k.alerts24h.promoted} → incidents</div>
        </div>
        <div className="xdr-kpi-cell ok">
          <div className="xdr-kpi-h"><span className="xdr-kpi-lbl">Endpoints Protected</span><SourceBadge src="xdr" /></div>
          <div className="xdr-kpi-v">{xdrCompact(k.agents.healthy)}<span className="u">/ {xdrCompact(XDR_TENANT.agentsDeployed)}</span></div>
          <div className="xdr-kpi-foot">{k.agents.covered_pct}% coverage · {k.agents.disconnected} disconnected</div>
        </div>
        <div className="xdr-kpi-cell">
          <div className="xdr-kpi-h"><span className="xdr-kpi-lbl">MTTD / MTTR</span><SourceBadge src="xdr" /></div>
          <div className="xdr-kpi-v">{k.mttd.value}<span className="u">m</span> <span style={{ color: "var(--muted)", fontSize: 18 }}>/</span> {k.mttr.value}<span className="u">m</span></div>
          <div className="xdr-kpi-foot">
            <span style={{ color: "var(--ok)" }}>▼ {Math.abs(k.mttd.trend)}m detect</span>
            <span>· <span style={{ color: "var(--ok)" }}>▼ {Math.abs(k.mttr.trend)}m respond</span></span>
          </div>
        </div>
        <div className="xdr-kpi-cell pink">
          <div className="xdr-kpi-h"><span className="xdr-kpi-lbl">MITRE Coverage</span><SourceBadge src="xdr" /></div>
          <div className="xdr-kpi-v">{k.coverage.pct}<span className="u">%</span></div>
          <div className="fg-kpi-bar" style={{ height: 3, background: "var(--bg-2)", borderRadius: 2, overflow: "hidden" }}>
            <div style={{ width: `${k.coverage.pct}%`, background: "var(--xdr)", height: "100%" }} />
          </div>
          <div className="xdr-kpi-foot">{k.coverage.covered} of {k.coverage.total} techniques · {k.coverage.mitreTactics} tactics</div>
        </div>
        <div className="xdr-kpi-cell warn">
          <div className="xdr-kpi-h"><span className="xdr-kpi-lbl">Hosts Isolated</span><span className="pulse-dot" /></div>
          <div className="xdr-kpi-v">{k.isolated.hosts}</div>
          <div className="xdr-kpi-foot">+ {k.isolated.accounts} accounts disabled · auto-iso active</div>
        </div>
      </div>
    </div>
  );
};

// ───────── Featured active incident · kill chain ─────────
const XdrActiveIncident = () => {
  const i = XDR_ACTIVE_INC;
  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div className="inc-banner">
        <div className="inc-banner-l">
          <div className="inc-id-row">
            <span className="inc-id">{i.id}</span>
            <span className={"inc-sev-pill " + i.sev}>{i.sev}</span>
            <span className="inc-status-pill"><span className="dot" style={{ background: "var(--xdr)" }} />{i.status}</span>
            <SourceBadge src="xdr" />
          </div>
          <div className="inc-title">{i.title}</div>
          <div className="inc-meta">
            <span><span className="lbl">Opened</span><span className="v">{i.opened}</span> · {i.age}</span>
            <span><span className="lbl">Assigned</span><span className="v">{i.assignee}</span></span>
            <span><span className="lbl">Hosts</span><span className="v">{i.hosts.join(", ")}</span></span>
            <span><span className="lbl">Users</span><span className="v">{i.users.join(", ")}</span></span>
            <span><span className="lbl">Alerts</span><span className="v">{i.alertsLinked} linked · {i.techniques} techniques</span></span>
          </div>
        </div>
        <div className="inc-banner-r">
          <div className="inc-score">
            <div className="v">{i.score}</div>
            <div className="lbl">Risk score</div>
          </div>
          <button className="btn primary"><Icon name="lock" size={12} />Contain</button>
          <button className="btn"><Icon name="external" size={12} />Open case</button>
        </div>
      </div>

      <div className="kill-chain">
        {i.kill.map((s, idx) => (
          <div className="kill-step" key={idx}>
            <div className="ks-line" />
            <div className={"ks-dot " + s.sev} />
            <div className="ks-ts">{s.ts}</div>
            <div className="ks-tid">{s.tid}</div>
            <div className="ks-tac">{s.tactic}</div>
            <div className="ks-name">{s.name}</div>
            <div className="ks-detail">{s.detail}</div>
            <div className="ks-host">{s.host}</div>
          </div>
        ))}
      </div>

      <div className="inc-actions">
        {i.actions.map((a, idx) => (
          <div className="inc-act-row" key={idx}>
            <div className="ts">{a.ts}</div>
            <div className={"actor " + a.actor}>{a.actor}</div>
            <div className="msg">{a.what}</div>
            <div><Icon name="check" size={12} /></div>
          </div>
        ))}
      </div>
    </div>
  );
};

// ───────── 7-day incident severity stacked ─────────
const XdrIncidents7d = () => {
  const data = XDR_INC_7D;
  const max = Math.max(...data.map(d => d.crit + d.high + d.med + d.low)) * 1.08;
  const total = {
    crit: data.reduce((a, d) => a + d.crit, 0),
    high: data.reduce((a, d) => a + d.high, 0),
    med:  data.reduce((a, d) => a + d.med,  0),
    low:  data.reduce((a, d) => a + d.low,  0),
  };
  const pxFor = (v) => (v / max) * 180;
  return (
    <div className="card">
      <div className="card-h">
        <h3>Incidents · Last 7 Days</h3>
        <SourceBadge src="xdr" />
        <div className="h-spacer" />
        <span className="h-meta">by severity · stacked</span>
      </div>
      <div className="inc7-row">
        <div className="inc7-chart">
          <div className="inc7-grid">
            {data.map((d, i) => (
              <div className="inc7-col" key={i}>
                <div className="inc7-stack">
                  {d.low  > 0 && <div className="low"  style={{ height: pxFor(d.low) }} />}
                  {d.med  > 0 && <div className="med"  style={{ height: pxFor(d.med) }} />}
                  {d.high > 0 && <div className="high" style={{ height: pxFor(d.high) }} />}
                  {d.crit > 0 && <div className="crit" style={{ height: pxFor(d.crit) }} />}
                </div>
                <div className="inc7-day">{d.d}</div>
              </div>
            ))}
          </div>
        </div>
        <div className="inc7-side">
          <div className="inc7-legend"><span className="sw" style={{ background: "var(--err)" }} /> Critical <span className="v">{total.crit}</span></div>
          <div className="inc7-legend"><span className="sw" style={{ background: "var(--xdr)" }} /> High     <span className="v">{total.high}</span></div>
          <div className="inc7-legend"><span className="sw" style={{ background: "var(--warn)" }}/> Medium   <span className="v">{total.med}</span></div>
          <div className="inc7-legend"><span className="sw" style={{ background: "var(--info)" }}/> Low      <span className="v">{total.low}</span></div>
          <div style={{ borderTop: "1px solid var(--line)", paddingTop: 10, marginTop: 4 }}>
            <div className="inc7-legend"><span style={{ color: "var(--muted)" }}>7d total</span><span className="v">{total.crit + total.high + total.med + total.low}</span></div>
          </div>
        </div>
      </div>
    </div>
  );
};

// ───────── Detection sources ─────────
const XdrDetectionSources = () => (
  <div className="card">
    <div className="card-h">
      <h3>Detection Sources · 24h</h3>
      <SourceBadge src="xdr" />
      <div className="h-spacer" />
      <span className="h-meta">{XDR_SOURCES.reduce((a,s) => a+s.count, 0).toLocaleString()} signals</span>
    </div>
    {XDR_SOURCES.map(s => (
      <div className="src-row" key={s.id}>
        <div className="lbl"><span className="dot" style={{ background: s.color }} />{s.label}</div>
        <div className="bar"><div style={{ width: s.pct + "%", background: s.color }} /></div>
        <div className="v">{s.count.toLocaleString()}<span className="pct">{s.pct}%</span></div>
      </div>
    ))}
  </div>
);

// ───────── MITRE ATT&CK heatmap ─────────
const XdrMitre = () => {
  const heat = (n) => n === 0 ? "h0" : n < 5 ? "h1" : n < 15 ? "h2" : n < 30 ? "h3" : n < 60 ? "h4" : "h5";
  return (
    <div className="card">
      <div className="card-h">
        <h3>MITRE ATT&amp;CK · Coverage &amp; Detections · 7d</h3>
        <SourceBadge src="xdr" />
        <div className="h-spacer" />
        <span className="h-meta">{XDR_KPI.coverage.covered}/{XDR_KPI.coverage.total} techniques covered · {XDR_KPI.coverage.pct}%</span>
      </div>
      <div className="mitre">
        {XDR_MITRE.map(col => (
          <div className="mitre-col" key={col.tactic}>
            <div className="mitre-col-h">{col.tactic}</div>
            {col.techs.map(t => (
              <div className={"mitre-cell " + heat(t.hits)} key={t.id} title={`${t.id} · ${t.n} — ${t.hits} hits · ${t.cov} coverage`}>
                <div className="tid">{t.id}</div>
                <div className="nm">{t.n}</div>
                {t.hits > 0 && <div className="hc">{t.hits}</div>}
                <div className={"cov " + t.cov} />
              </div>
            ))}
          </div>
        ))}
      </div>
      <div className="mitre-foot">
        <span>Hits 7d</span>
        <span className="heat-leg">
          <div className="mitre-cell h0" style={{ padding: 0 }} />
          <div className="mitre-cell h1" style={{ padding: 0 }} />
          <div className="mitre-cell h2" style={{ padding: 0 }} />
          <div className="mitre-cell h3" style={{ padding: 0 }} />
          <div className="mitre-cell h4" style={{ padding: 0 }} />
          <div className="mitre-cell h5" style={{ padding: 0 }} />
        </span>
        <span style={{ color: "var(--muted)" }}>0 → 60+</span>
        <span style={{ marginLeft: "auto" }}>Coverage:</span>
        <span className="cov-leg"><span className="dot" style={{ background: "var(--ok)" }} /> Full</span>
        <span className="cov-leg"><span className="dot" style={{ background: "var(--warn)" }} /> Partial</span>
        <span className="cov-leg"><span className="dot" style={{ background: "var(--muted-2)" }} /> None</span>
      </div>
    </div>
  );
};

// ───────── Agent OS strip ─────────
const XdrAgentOs = () => (
  <div className="card">
    <div className="card-h">
      <h3>Agent Inventory · By OS</h3>
      <SourceBadge src="xdr" />
      <div className="h-spacer" />
      <span className="h-meta">{xdrCompact(XDR_TENANT.agentsDeployed)} agents · policy {XDR_TENANT.policyVersion}</span>
    </div>
    <div className="card-b tight">
      <table className="tbl agent-os-tbl">
        <thead>
          <tr>
            <th>OS</th>
            <th style={{ width: 80, textAlign: "right" }}>Agents</th>
            <th style={{ width: 80, textAlign: "right" }}>Healthy</th>
            <th style={{ width: 160 }}>Health %</th>
            <th style={{ width: 130 }}>Agent ver.</th>
          </tr>
        </thead>
        <tbody>
          {XDR_AGENTS_OS.map(o => {
            const pct = (o.healthy / o.count) * 100;
            return (
              <tr key={o.os}>
                <td className="fg">{o.os}</td>
                <td style={{ textAlign: "right" }}>{o.count.toLocaleString()}</td>
                <td style={{ textAlign: "right", color: "var(--ok)" }}>{o.healthy.toLocaleString()}</td>
                <td>
                  <span className="agent-bar"><div style={{ width: pct + "%", background: pct > 98 ? "var(--ok)" : pct > 95 ? "var(--warn)" : "var(--err)" }} /></span>
                  <span style={{ fontFamily: "var(--mono)", fontSize: 11 }}>{pct.toFixed(1)}%</span>
                </td>
                <td>{o.ver}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  </div>
);

// ───────── Top risky users / hosts ─────────
const XdrRiskyUsers = () => (
  <div className="card">
    <div className="card-h">
      <h3>Top Risky Users</h3>
      <SourceBadge src="xdr" />
      <SourceBadge src="pf" />
      <div className="h-spacer" />
      <span className="h-meta">behavioral score · last 7d</span>
    </div>
    {XDR_TOP_USERS.map(u => {
      const cls = scoreClass(u.score);
      return (
        <div className="risk-row" key={u.user}>
          <div className="l">
            <div className="name">
              {u.user}
              <span className={"role-tag " + (u.role === "Faculty" ? "faculty" : u.role === "Student" ? "student" : u.role === "Service" ? "unknown" : u.role === "Admin" ? "av" : "guest")} style={{ fontSize: 9.5, padding: "0 6px" }}>{u.role}</span>
            </div>
            <div className="sub">{u.dept}</div>
            <div className="signals">
              {u.signals.map((s, i) => <span className="sig-chip" key={i}>{s}</span>)}
            </div>
          </div>
          <div>
            <div className={"score " + cls}>{u.score}</div>
            <div className="meter"><div className={cls} style={{ width: u.score + "%" }} /></div>
          </div>
          <div className={"trend " + (u.trend > 0 ? "up" : "down")}>
            {u.trend > 0 ? "▲" : "▼"} {Math.abs(u.trend)}<br />
            <span style={{ color: "var(--muted)", fontSize: 10 }}>vs 7d</span>
          </div>
        </div>
      );
    })}
  </div>
);

const XdrRiskyHosts = () => (
  <div className="card">
    <div className="card-h">
      <h3>Top Risky Hosts</h3>
      <SourceBadge src="xdr" />
      <div className="h-spacer" />
      <span className="h-meta">{XDR_KPI.isolated.hosts} isolated</span>
    </div>
    {XDR_TOP_HOSTS.map(h => {
      const cls = scoreClass(h.score);
      return (
        <div className="risk-row" key={h.host}>
          <div className="l">
            <div className="name" style={{ fontFamily: "var(--mono)", fontSize: 12 }}>
              {h.host}
              {h.isolated && <span className="iso"><Icon name="lock" size={9} /> ISOLATED</span>}
            </div>
            <div className="sub">{h.os} · {h.site} · user {h.user}</div>
            <div className="signals">
              <span className="sig-chip">{h.alerts} alerts · 24h</span>
            </div>
          </div>
          <div>
            <div className={"score " + cls}>{h.score}</div>
            <div className="meter"><div className={cls} style={{ width: h.score + "%" }} /></div>
          </div>
          <div className="trend" style={{ color: "var(--muted)", fontFamily: "var(--mono)", fontSize: 11 }}>
            <Icon name="chevron" size={12} />
          </div>
        </div>
      );
    })}
  </div>
);

// ───────── Top alerts table ─────────
const XdrAlerts = () => (
  <div className="card">
    <div className="card-h">
      <h3>Top Alerts · 24h</h3>
      <SourceBadge src="xdr" />
      <div className="h-spacer" />
      <a className="h-link">Open alert queue <Icon name="external" size={11} /></a>
    </div>
    <div className="card-b tight">
      <table className="tbl alerts-tbl">
        <thead>
          <tr>
            <th style={{ width: 78 }}>Alert</th>
            <th>Signature</th>
            <th style={{ width: 88 }}>MITRE</th>
            <th style={{ width: 60 }}>Sev</th>
            <th style={{ width: 160 }}>Host</th>
            <th style={{ width: 110 }}>User</th>
            <th style={{ width: 90 }}>Age</th>
            <th style={{ width: 130 }}>Status</th>
          </tr>
        </thead>
        <tbody>
          {XDR_TOP_ALERTS.map(a => (
            <tr key={a.id}>
              <td><span className="al-id">{a.id}</span></td>
              <td className="fg">{a.sig}</td>
              <td><span className="al-mitre">{a.mitre}</span></td>
              <td><Sev level={a.sev === "critical" ? "disaster" : a.sev} /></td>
              <td>{a.host}</td>
              <td>{a.user}</td>
              <td>{a.ago}</td>
              <td><span className={"al-status " + a.status}>{a.status}</span></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  </div>
);

// ───────── Hunts ─────────
const XdrHunts = () => (
  <div className="card">
    <div className="card-h">
      <h3>Active Hunts &amp; Scheduled Queries</h3>
      <SourceBadge src="xdr" />
      <div className="h-spacer" />
      <span className="h-meta">{XDR_HUNTS.filter(h => h.status === "running").length} running · {XDR_HUNTS.length} total</span>
    </div>
    {XDR_HUNTS.map((h, i) => (
      <div className="hunt-row" key={i}>
        <div className="hn-name">
          <span className={"hunt-status-dot " + h.status} />
          {h.name}
        </div>
        <div className="hn-author">by {h.author}</div>
        <div className="hn-sched">{h.schedule}</div>
        <div className="hn-last">{h.lastRun}</div>
        <div className={"hn-hits " + (h.hits > 0 ? "hits" : "zero")}>{h.hits} hits</div>
      </div>
    ))}
  </div>
);

// ───────── Events ─────────
const XdrEvents = () => (
  <div className="events">
    {XDR_EVENTS.map((e, i) => (
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
  "showKillChain": true,
  "showMitre": true,
  "showHunts": true
}/*EDITMODE-END*/;

const App = () => {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
  const [timeRange, setTimeRange] = useState("Last 24h");
  const [now, setNow] = useState("just now");

  useEffect(() => {
    document.documentElement.classList.toggle("hide-src-badges", !t.showSourceBadges);
  }, [t.showSourceBadges]);

  return (
    <div className="app xdr-page" data-density={t.density} data-screen-label="Cortex XDR">
      <GlobalSidebar active="xdr" />
      <div className="main">
        <GlobalTopbar
          crumb={["Tuscaloosa City Schools", "Security Ops", "Cortex XDR · tcs-secops"]}
          search="Find incident, host, user, hash, MITRE ID…"
        />
        <XdrHeader now={now} timeRange={timeRange} />
        <div className="body">
          <DemoBanner name="Cortex XDR Dashboard" />
          <XdrKpiStrip />

          {t.showKillChain && <XdrActiveIncident />}

          <div className="row" style={{ gridTemplateColumns: "1.4fr 1fr", marginBottom: 14 }}>
            <XdrIncidents7d />
            <XdrDetectionSources />
          </div>

          {t.showMitre && (
            <div className="row" style={{ gridTemplateColumns: "1fr", marginBottom: 14 }}>
              <XdrMitre />
            </div>
          )}

          <div className="row" style={{ gridTemplateColumns: "1fr", marginBottom: 14 }}>
            <XdrAgentOs />
          </div>

          <div className="row" style={{ gridTemplateColumns: "1fr 1fr", marginBottom: 14 }}>
            <XdrRiskyUsers />
            <XdrRiskyHosts />
          </div>

          <div className="row" style={{ gridTemplateColumns: "1fr", marginBottom: 14 }}>
            <XdrAlerts />
          </div>

          {t.showHunts && (
            <div className="row" style={{ gridTemplateColumns: "1fr", marginBottom: 14 }}>
              <XdrHunts />
            </div>
          )}

          <div className="card">
            <div className="card-h">
              <h3>Cortex XDR · Recent Events</h3>
              <SourceBadge src="xdr" />
              <SourceBadge src="zbx" />
              <div className="h-spacer" />
              <a className="h-link">Open in event console <Icon name="external" size={11} /></a>
            </div>
            <div className="card-b tight">
              <XdrEvents />
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
          <TweakToggle label="Show source badges" value={t.showSourceBadges} onChange={v => setTweak("showSourceBadges", v)} />
        </TweakSection>
        <TweakSection label="Sections">
          <TweakToggle label="Active incident · kill chain" value={t.showKillChain} onChange={v => setTweak("showKillChain", v)} />
          <TweakToggle label="MITRE ATT&CK heatmap"        value={t.showMitre}     onChange={v => setTweak("showMitre",     v)} />
          <TweakToggle label="Active hunts"                value={t.showHunts}     onChange={v => setTweak("showHunts",     v)} />
        </TweakSection>
        <TweakSection label="Quick actions">
          <TweakButton onClick={() => setNow(new Date().toLocaleTimeString())} label="Refresh tenant sync" />
          <TweakButton onClick={() => alert("Would open INC-2026-0418 in the case manager.")} label="Open active incident" />
        </TweakSection>
      </TweaksPanel>
    </div>
  );
};

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
