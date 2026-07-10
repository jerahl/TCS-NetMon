// XIQ Wireless Status — global overview rolled up from ExtremeCloud IQ
// (read-through via the EXT source) joined with Zabbix host-level state.
// Layout: KPI strip → sites → SSID/problems → channel/firmware
// → client-mix/roaming → live events.

const { useState, useEffect } = React;

// ───────── Live data bindings ─────────
// Data globals are populated by xiq-bridge.jsx (from window.XIQ_BOOT on first
// paint, then refreshed by fetch to tcs.xiq.data). These `let`s are live
// bindings — child components reference them by name and pick up reassignments
// when the bridge fires "tcs:xiq-data". The App component listens for that
// event and bumps a render counter to force the tree to re-evaluate.
let XIQ_TOTALS       = window.XIQ_TOTALS       || {};
let XIQ_SITES        = window.XIQ_SITES        || [];
let XIQ_SSIDS        = window.XIQ_SSIDS        || [];
let XIQ_TOP_CLIENT_APS = window.XIQ_TOP_CLIENT_APS || [];
let XIQ_CHANNEL_GRID = window.XIQ_CHANNEL_GRID || { sites: [], channels: [], matrix: [] };
let XIQ_CLIENT_MIX   = window.XIQ_CLIENT_MIX   || { standards: [], os: [] };
let XIQ_FIRMWARE     = window.XIQ_FIRMWARE     || { versions: [] };
let XIQ_ROAMING      = window.XIQ_ROAMING      || { buckets: [], rate24h: 0 };
let XIQ_EVENTS       = window.XIQ_EVENTS       || [];
window.addEventListener("tcs:xiq-data", () => {
  XIQ_TOTALS       = window.XIQ_TOTALS       || XIQ_TOTALS;
  XIQ_SITES        = window.XIQ_SITES        || XIQ_SITES;
  XIQ_SSIDS        = window.XIQ_SSIDS        || XIQ_SSIDS;
  XIQ_TOP_CLIENT_APS = window.XIQ_TOP_CLIENT_APS || XIQ_TOP_CLIENT_APS;
  XIQ_CHANNEL_GRID = window.XIQ_CHANNEL_GRID || XIQ_CHANNEL_GRID;
  XIQ_CLIENT_MIX   = window.XIQ_CLIENT_MIX   || XIQ_CLIENT_MIX;
  XIQ_FIRMWARE     = window.XIQ_FIRMWARE     || XIQ_FIRMWARE;
  XIQ_ROAMING      = window.XIQ_ROAMING      || XIQ_ROAMING;
  XIQ_EVENTS       = window.XIQ_EVENTS       || XIQ_EVENTS;
});

// ───────── Severity color palette (reused across cards) ─────────
const xiqSev = {
  ok:       { bg: "rgba(52,211,153,0.10)",  bd: "rgba(52,211,153,0.35)", fg: "var(--ok)"  },
  info:     { bg: "rgba(95,168,211,0.10)",  bd: "rgba(95,168,211,0.35)", fg: "var(--info)" },
  warning:  { bg: "rgba(245,179,0,0.12)",   bd: "rgba(245,179,0,0.40)",  fg: "var(--warn)" },
  high:     { bg: "rgba(242,95,92,0.14)",   bd: "rgba(242,95,92,0.45)",  fg: "var(--err)"  },
  disaster: { bg: "rgba(242,95,92,0.28)",   bd: "var(--err)",            fg: "#ffd0cf"     },
};

// ───────── Loading / empty state for a card ─────────
const CardLoading = ({ label, spinning = true }) => (
  <div style={{
    display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
    gap: 12, padding: "40px 14px", color: "var(--muted)", fontSize: 12
  }}>
    {spinning ? (
      <div className="refresh-ring" style={{ width: 22, height: 22, borderWidth: 2.5 }} />
    ) : (
      <Icon name="alert" size={18} />
    )}
    <div>{label}</div>
  </div>
);

// Heat color for the channel utilization grid: 0–100 → blue→amber→red.
const heatColor = (v) => {
  if (v <= 0) return null;
  if (v < 25)  return `rgba(95,168,211,${0.18 + v/100})`;
  if (v < 50)  return `rgba(124,92,255,${0.22 + (v-25)/100})`;
  if (v < 75)  return `rgba(245,179,0,${0.30 + (v-50)/120})`;
  return `rgba(242,95,92,${0.40 + (v-75)/120})`;
};

// ───────── Header ─────────
const XIQHeader = ({ now, timeRange, setTimeRange }) => (
  <div className="page-header" style={{ alignItems: "center" }}>
    <div style={{ flex: 1 }}>
      <div className="host-title">
        <h1>XIQ Wireless · Status</h1>
        <SourceBadge src="ext" />
        <span className="role-tag av" style={{ fontSize: 10, padding: "1px 8px" }}>RF · CONTROLLER</span>
      </div>
      <div className="host-meta">
        <span className="pill"><span className="refresh-ring" /> <span className="lbl">XIQ sync</span> <span className="v">{XIQ_TOTALS.controllers.lastSync}</span></span>
        <span className="pill"><span className="lbl">Tenant</span> <span className="v">{XIQ_TOTALS.controllers.instance}</span></span>
        <span className="pill"><span className="lbl">Region</span> <span className="v">{XIQ_TOTALS.controllers.region}</span></span>
        <span className="pill"><span className="dot" style={{ background: "var(--ok)" }} /> All cloud brokers reachable</span>
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

// ───────── KPI strip (6 cells) ─────────
const KPIStrip = () => {
  const t = XIQ_TOTALS;
  const onlinePct = t.aps.total > 0 ? (t.aps.online / t.aps.total) * 100 : 0;
  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div className="xiq-kpi">
        <div className="xiq-kpi-cell">
          <div className="xiq-kpi-h"><span className="xiq-kpi-lbl">Access Points</span><SourceBadge src="ext" /></div>
          <div className="xiq-kpi-v">{t.aps.total.toLocaleString()}</div>
          <div className="xiq-kpi-foot">across {XIQ_SITES.length} site{XIQ_SITES.length === 1 ? "" : "s"}</div>
        </div>
        <div className="xiq-kpi-cell ok">
          <div className="xiq-kpi-h"><span className="xiq-kpi-lbl">Online</span><SourceBadge src="ext" /></div>
          <div className="xiq-kpi-v">{t.aps.online.toLocaleString()}<span className="u">/ {t.aps.total.toLocaleString()}</span></div>
          <div className="xiq-kpi-bar"><div style={{ width: `${onlinePct}%`, background: "var(--ok)" }} /></div>
          <div className="xiq-kpi-foot">{onlinePct.toFixed(1)}% reachable</div>
        </div>
        <div className="xiq-kpi-cell err">
          <div className="xiq-kpi-h"><span className="xiq-kpi-lbl">Offline / Critical</span><SourceBadge src="ext" /></div>
          <div className="xiq-kpi-v">{t.aps.offline + t.aps.critical}</div>
          <div className="xiq-kpi-foot">{t.aps.offline} unreachable · {t.aps.critical} critical · {t.aps.idle} idle</div>
        </div>
        <div className="xiq-kpi-cell ext">
          <div className="xiq-kpi-h"><span className="xiq-kpi-lbl">Connected Clients</span><SourceBadge src="ext" /></div>
          <div className="xiq-kpi-v">{t.clients.total.toLocaleString()}</div>
          <div className="xiq-kpi-foot">{t.clients.dot11ax.toLocaleString()} ax · {t.clients.dot11ac.toLocaleString()} ac · {t.clients.legacy} legacy</div>
        </div>
        <div className="xiq-kpi-cell warn">
          <div className="xiq-kpi-h"><span className="xiq-kpi-lbl">RF Health Score</span><SourceBadge src="ext" /></div>
          <div className="xiq-kpi-v">{t.rfHealth.score}<span className="u">/ 100</span></div>
          <div className="xiq-kpi-bar"><div style={{ width: `${t.rfHealth.score}%`, background: t.rfHealth.score >= t.rfHealth.target ? "var(--ok)" : "var(--warn)" }} /></div>
          <div className="xiq-kpi-foot">target ≥ {t.rfHealth.target} · 2.4 GHz dragging</div>
        </div>
      </div>
    </div>
  );
};

// ───────── Site → AP rollup grid ─────────
const APSiteGrid = ({ filter, setFilter }) => {
  const sites = filter === "issues"
    ? XIQ_SITES.filter(s => s.online < s.aps || s.sev === "warning" || s.sev === "high" || s.sev === "disaster")
    : filter === "ok"
    ? XIQ_SITES.filter(s => s.online === s.aps && (s.sev === "ok" || s.sev === "info"))
    : XIQ_SITES;
  return (
    <div className="card">
      <div className="card-h">
        <h3>APs by Site</h3>
        <SourceBadge src="ext" />
        <div className="h-spacer" />
        <div className="seg-toggle">
          {[["all", `All ${XIQ_SITES.length}`], ["issues", "Issues"], ["ok", "Healthy"]].map(([k, l]) => (
            <button key={k} className={"seg-btn" + (filter === k ? " active" : "")} onClick={() => setFilter(k)}>{l}</button>
          ))}
        </div>
      </div>
      <div className="card-b">
        {XIQ_SITES.length === 0 ? (
          <CardLoading label={window.XIQ_LOADING ? "Loading AP fleet from Zabbix…" : "No APs found in the Site/Wireless/* groups."} spinning={!!window.XIQ_LOADING} />
        ) : (
          <div className="apsite-grid">
            {sites.map(s => {
              const c = xiqSev[s.sev] || xiqSev.ok;
              const off = s.aps - s.online;
              const utilColor = s.util > 70 ? "var(--err)" : s.util > 55 ? "var(--warn)" : "var(--ok)";
              return (
                <div
                  key={s.id}
                  className={"apsite-tile" + (s.kind === "outage" ? " pulse" : "")}
                  style={{ background: c.bg, borderColor: c.bd }}
                  title={`${s.name} · ${s.online}/${s.aps} online · ${s.clients} clients · util ${s.util}%`}
                >
                  <div className="apsite-h">
                    <span className="apsite-id" style={{ color: c.fg }}>{s.id}</span>
                    <span className="apsite-aps">
                      {off > 0 ? (
                        <><span className="off">{off}↓</span> <span style={{ color: "var(--muted)" }}>/ {s.aps}</span></>
                      ) : (
                        <span style={{ color: c.fg }}>{s.aps}</span>
                      )}
                    </span>
                  </div>
                  <div className="apsite-name">{s.name}</div>
                  <div className="apsite-util-row">
                    <div className="apsite-util-bar"><div style={{ width: `${s.util}%`, background: utilColor }} /></div>
                    <span>{s.util}%</span>
                  </div>
                  <div className="apsite-clients">{s.clients.toLocaleString()} clients</div>
                </div>
              );
            })}
          </div>
        )}
      </div>
      <div className="sites-legend">
        {[["disaster","Disaster"],["high","High"],["warning","Warning"],["info","Info"],["ok","OK"]].map(([k,l]) => (
          <span className="legend-item" key={k}><span className="legend-sw" style={{ background: xiqSev[k].bg, borderColor: xiqSev[k].bd }} />{l}</span>
        ))}
        <span className="h-spacer" />
        <span className="legend-foot">{sites.reduce((n,s)=>n+s.online,0)} / {sites.reduce((n,s)=>n+s.aps,0)} APs online · {sites.reduce((n,s)=>n+s.clients,0).toLocaleString()} clients</span>
      </div>
    </div>
  );
};

// ───────── SSID table ─────────
const SSIDTable = () => (
  <table className="tbl ssid-tbl">
    <thead>
      <tr>
        <th>SSID</th>
        <th style={{ width: 110 }}>Auth</th>
        <th style={{ width: 60, textAlign: "right" }}>VLAN</th>
        <th style={{ width: 80, textAlign: "right" }}>Clients</th>
        <th style={{ width: 160 }}>Assoc success</th>
        <th style={{ width: 80, textAlign: "right" }}>Gbps</th>
        <th style={{ width: 28 }}></th>
      </tr>
    </thead>
    <tbody>
      {XIQ_SSIDS.map(s => {
        const cls = s.success >= 99 ? "ok" : s.success >= 97 ? "warn" : "err";
        const barColor = s.success >= 99 ? "var(--ok)" : s.success >= 97 ? "var(--warn)" : "var(--err)";
        return (
          <tr key={s.id}>
            <td className="fg">
              <span className={"ssid-name" + (s.hidden ? " hidden" : "")}>
                <span className="bcast-dot" />{s.label}
              </span>
            </td>
            <td>{s.auth}</td>
            <td style={{ textAlign: "right" }}>{s.vlan}</td>
            <td style={{ textAlign: "right" }} className="fg">{s.clients.toLocaleString()}</td>
            <td>
              <div className="ssid-bar-cell">
                <div className="ssid-bar"><div style={{ width: `${s.success}%`, background: barColor }} /></div>
                <span className={"ssid-success " + cls}>{s.success.toFixed(1)}%</span>
              </div>
            </td>
            <td style={{ textAlign: "right" }} className="fg">{s.throughput.toFixed(2)}</td>
            <td><span className={"role-tag " + s.role} style={{ fontSize: 9, padding: "0 5px" }}>{s.role}</span></td>
          </tr>
        );
      })}
    </tbody>
  </table>
);

// ───────── Top client APs list (APs with the most connected clients) ─────────
const TopClientAPList = () => {
  if (!XIQ_TOP_CLIENT_APS || XIQ_TOP_CLIENT_APS.length === 0) {
    return (
      <CardLoading
        label={window.XIQ_LOADING ? "Loading fleet client counts…" : "No client data yet — xiq.ap.clients items have not reported."}
        spinning={!!window.XIQ_LOADING}
      />
    );
  }
  return (
    <div className="papl">
      {XIQ_TOP_CLIENT_APS.map((p, i) => {
        const apDetailUrl = p.hostid
          ? `${(window.TCS_NAV && window.TCS_NAV.apDetail) || "zabbix.php?action=tcs.dashboard.view"}&hostid=${encodeURIComponent(p.hostid)}`
          : null;
        const rowProps = apDetailUrl
          ? { onClick: () => { window.location.href = apDetailUrl; }, style: { cursor: "pointer" }, title: `Open ${p.ap} detail` }
          : {};
        const rank = i + 1;
        const loadCls = p.clients > 50 ? "err" : p.clients > 35 ? "warn" : "";
        return (
          <div className="pap-row" key={i} {...rowProps}>
            <div className="pap-main">
              <div className="pap-head">
                <span className="pap-id">#{rank} · {p.ap}</span>
                <span className="site-chip">{p.site}</span>
                <span className="pap-model">{p.model}</span>
              </div>
              {p.building ? (
                <div className="pap-reason" style={{ color: "var(--muted)" }}>{p.building}</div>
              ) : null}
            </div>
            <div className="pap-age">
              <span className={"v " + loadCls} style={{ fontSize: 18, fontWeight: 600 }}>{p.clients}</span>
              <br /><span style={{ color: "var(--muted)" }}>clients</span>
            </div>
            <div><Icon name="chevron" size={12} /></div>
          </div>
        );
      })}
    </div>
  );
};

// ───────── Channel utilization heat grid ─────────
const ChannelGrid = () => {
  const g = XIQ_CHANNEL_GRID;
  const cols = `60px repeat(${g.channels.length}, 1fr)`;
  return (
    <div className="card">
      <div className="card-h">
        <h3>5 GHz · Channel Utilization Heatmap</h3>
        <SourceBadge src="ext" />
        <div className="h-spacer" />
        <span className="h-meta">top 8 sites · CCA mean / 5m</span>
      </div>
      <div className="chgrid">
        <div className="chgrid-row" style={{ gridTemplateColumns: cols }}>
          <div className="chgrid-rowlabel" />
          {g.channels.map(ch => <div className="chgrid-h" key={ch}>{ch}</div>)}
        </div>
        {g.sites.map((siteId, ri) => (
          <div className="chgrid-row" key={siteId} style={{ gridTemplateColumns: cols }}>
            <div className="chgrid-rowlabel">{siteId}</div>
            {g.matrix[ri].map((v, ci) => {
              const bg = heatColor(v);
              return (
                <div
                  key={ci}
                  className={"chgrid-cell" + (v === 0 ? " empty" : "")}
                  style={{ background: bg || undefined }}
                  title={`${siteId} · ch ${g.channels[ci]} — ${v === 0 ? "no data / offline" : v + "% CCA"}`}
                >
                  {v > 0 ? v : "—"}
                </div>
              );
            })}
          </div>
        ))}
      </div>
      <div className="chgrid-legend">
        <span>Low</span>
        <div className="chgrid-legend-scale">
          <div style={{ background: heatColor(10) }} />
          <div style={{ background: heatColor(30) }} />
          <div style={{ background: heatColor(50) }} />
          <div style={{ background: heatColor(70) }} />
          <div style={{ background: heatColor(90) }} />
        </div>
        <span>High</span>
      </div>
    </div>
  );
};

// ───────── Firmware compliance ─────────
const FirmwareCompliance = () => {
  const fw = XIQ_FIRMWARE;
  const total = fw.versions.reduce((n, v) => n + v.count, 0);
  const compliant = fw.versions.find(v => v.status === "target")?.count || 0;
  const pct = total > 0 ? (compliant / total) * 100 : 0;
  return (
    <div className="card">
      <div className="card-h">
        <h3>Firmware Compliance</h3>
        <SourceBadge src="ext" />
        <div className="h-spacer" />
        <span className="h-tag">target {XIQ_TOTALS.firmware.target}</span>
      </div>
      <div className="fw-grid">
        <Ring value={pct} size={140} color="var(--ok)"
              label={`${pct.toFixed(1)}%`} sub="on target" />
        <div className="fw-list">
          {fw.versions.map(v => {
            const pct = total > 0 ? (v.count / total) * 100 : 0;
            const color = v.status === "target" ? "var(--ok)" : v.status === "behind" ? "var(--warn)" : "var(--ext)";
            return (
              <div className={"fw-row " + v.status} key={v.v}>
                <span className="v">{v.v}</span>
                <div className="bar"><div style={{ width: `${pct}%`, background: color }} /></div>
                <span className="count">{v.count}</span>
                <span className="pill" />
              </div>
            );
          })}
        </div>
      </div>
      <div className="sites-legend" style={{ paddingTop: 8, paddingBottom: 8 }}>
        <span className="legend-item"><span className="legend-sw" style={{ background: "var(--ok)", borderColor: "var(--ok)" }} />Target</span>
        <span className="legend-item"><span className="legend-sw" style={{ background: "var(--warn)", borderColor: "var(--warn)" }} />Behind</span>
        <span className="legend-item"><span className="legend-sw" style={{ background: "var(--ext)", borderColor: "var(--ext)" }} />Ahead (canary)</span>
        <span className="h-spacer" style={{ flex: 1 }} />
        <span className="legend-foot">41 APs scheduled May 18 02:00–04:00</span>
      </div>
    </div>
  );
};

// ───────── Client mix (PHY + OS) ─────────
const ClientMix = () => {
  const m = XIQ_CLIENT_MIX;
  const osColors = ["var(--ext)", "var(--zbx)", "var(--info)", "var(--ok)", "var(--cx)", "var(--muted)"];
  return (
    <div className="card">
      <div className="card-h">
        <h3>Client Mix</h3>
        <SourceBadge src="ext" />
        <SourceBadge src="pf" />
        <div className="h-spacer" />
        <span className="h-meta">{XIQ_TOTALS.clients.total.toLocaleString()} associated</span>
      </div>
      <div className="mix-grid">
        <div className="mix-block">
          <div className="mix-block-h">By PHY / standard</div>
          <div className="mix-stack">
            {m.standards.map(s => (
              <div key={s.id} title={`${s.label}: ${s.count.toLocaleString()} (${s.pct}%)`} style={{ width: `${s.pct}%`, background: s.color }} />
            ))}
          </div>
          <div className="mix-legend">
            {m.standards.map(s => (
              <div className="mix-legend-row" key={s.id}>
                <span className="sw" style={{ background: s.color }} />
                <span className="l">{s.label}</span>
                <span className="c">{s.count.toLocaleString()}</span>
                <span className="p">{s.pct.toFixed(1)}%</span>
              </div>
            ))}
          </div>
        </div>
        <div className="mix-block">
          <div className="mix-block-h">By operating system</div>
          <div className="mix-stack">
            {m.os.map((s, i) => (
              <div key={s.id} title={`${s.label}: ${s.count.toLocaleString()} (${s.pct}%)`} style={{ width: `${s.pct}%`, background: osColors[i] }} />
            ))}
          </div>
          <div className="mix-legend">
            {m.os.map((s, i) => (
              <div className="mix-legend-row" key={s.id}>
                <span className="sw" style={{ background: osColors[i] }} />
                <span className="l">{s.label}</span>
                <span className="c">{s.count.toLocaleString()}</span>
                <span className="p">{s.pct.toFixed(1)}%</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

// ───────── Roaming health ─────────
const RoamingHealth = () => {
  const r = XIQ_ROAMING;
  const total = r.buckets.reduce((a, b) => a + b.count, 0);
  return (
    <div className="card">
      <div className="card-h">
        <h3>Roaming Health</h3>
        <SourceBadge src="ext" />
        <div className="h-spacer" />
        <span className="h-meta">last 1h · 9,264 events</span>
      </div>
      <div className="roam-grid">
        <div className="roam-head">
          <div>
            <div className="roam-head .h" style={{ fontFamily: "var(--mono)", fontSize: 22, fontWeight: 600, color: "var(--ok)" }}>
              {(100 - r.rate24h).toFixed(2)}%
            </div>
            <div className="lbl">roam success · 24h</div>
          </div>
          <div style={{ marginLeft: "auto", textAlign: "right" }}>
            <div style={{ fontFamily: "var(--mono)", fontSize: 16, fontWeight: 600, color: "var(--err)" }}>
              {r.rate24h.toFixed(2)}%
            </div>
            <div style={{ fontSize: 11, color: "var(--muted)" }}>failure rate</div>
          </div>
        </div>
        <div className="roam-stack">
          {r.buckets.map((b, i) => (
            <div key={i} title={`${b.range}: ${b.count.toLocaleString()}`}
                 style={{ width: `${total > 0 ? (b.count/total)*100 : 0}%`, background: b.color, opacity: 0.85 }} />
          ))}
        </div>
        <div className="roam-legend">
          {r.buckets.map((b, i) => (
            <div className="roam-legend-row" key={i}>
              <span className="sw" style={{ background: b.color }} />
              <span>{b.range}</span>
              <span className="c">{b.count.toLocaleString()}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

// ───────── Events stream (reuses .events / .event styles) ─────────
const XIQEvents = () => (
  <div className="events">
    {XIQ_EVENTS.map((e, i) => (
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
          }}>{e.msg}</span>{" "}
          <span style={{ color: "var(--fg)" }}>{e.obj}</span>
        </div>
      </div>
    ))}
  </div>
);

// ───────── Banner (error / rate-limit warning) ─────────
const XIQBanner = () => {
  const b = window.XIQ_BANNER;
  if (!b || !b.msg) return null;
  const bg = b.kind === "error" ? "rgba(242,95,92,0.14)" : "rgba(245,179,0,0.14)";
  const fg = b.kind === "error" ? "var(--err)" : "var(--warn)";
  const bd = b.kind === "error" ? "rgba(242,95,92,0.40)" : "rgba(245,179,0,0.40)";
  return (
    <div style={{
      margin: "10px 14px 0", padding: "10px 14px", borderRadius: 4,
      background: bg, border: `1px solid ${bd}`, color: fg,
      fontSize: 12, lineHeight: 1.45, display: "flex", alignItems: "center", gap: 10
    }}>
      <Icon name={b.kind === "error" ? "alert" : "alert"} size={14} />
      <span>{b.msg}</span>
    </div>
  );
};

// ───────── App shell ─────────
const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "density": "balanced",
  "showSourceBadges": true,
  "siteFilter": "all",
  "expanded": "all"
}/*EDITMODE-END*/;

const App = () => {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
  const [timeRange, setTimeRange] = useState("Last 1h");
  const [now, setNow] = useState("just now");
  const [, setTick] = useState(0);

  useEffect(() => {
    document.documentElement.classList.toggle("hide-src-badges", !t.showSourceBadges);
  }, [t.showSourceBadges]);

  // Re-render whenever xiq-bridge.jsx swaps in a fresh tcs.xiq.data payload.
  useEffect(() => {
    const onData = () => setTick(n => n + 1);
    window.addEventListener("tcs:xiq-data", onData);
    return () => window.removeEventListener("tcs:xiq-data", onData);
  }, []);

  return (
    <div className="app" data-density={t.density} data-screen-label="XIQ Wireless Status">
      <GlobalSidebar active="xiq" />
      <div className="main">
        <GlobalTopbar
          crumb={["Tuscaloosa City Schools", "Wireless", "XIQ · Status"]}
          search="Find AP, SSID, BSSID, client MAC…"
        />
        <XIQHeader now={now} timeRange={timeRange} setTimeRange={setTimeRange} />
        <XIQBanner />
        <div className="body">
          <KPIStrip />

          <div style={{ marginBottom: 14 }}>
            <APSiteGrid filter={t.siteFilter} setFilter={v => setTweak("siteFilter", v)} />
          </div>

          <div className="row" data-xiq-row style={{ gridTemplateColumns: "1.4fr 1fr", marginBottom: 14 }}>
            <div className="card">
              <div className="card-h">
                <h3>Broadcast SSIDs</h3>
                <SourceBadge src="ext" />
                <SourceBadge src="pf" />
                <div className="h-spacer" />
                <a className="h-link">WLAN config <Icon name="external" size={11} /></a>
              </div>
              <div className="card-b tight">
                <SSIDTable />
              </div>
            </div>
            <div className="card">
              <div className="card-h">
                <h3>Top Client APs</h3>
                <SourceBadge src="zbx" />
                <div className="h-spacer" />
                <span className="h-meta">most connected clients</span>
              </div>
              <div className="card-b tight">
                <TopClientAPList />
              </div>
            </div>
          </div>

          <div className="row" data-xiq-row style={{ gridTemplateColumns: "1.6fr 1fr", marginBottom: 14 }}>
            <ChannelGrid />
            <FirmwareCompliance />
          </div>

          <div className="row" data-xiq-row style={{ gridTemplateColumns: "1.4fr 1fr", marginBottom: 14 }}>
            <ClientMix />
            <RoamingHealth />
          </div>

          <div className="card">
            <div className="card-h">
              <h3>XIQ · Recent Events</h3>
              <SourceBadge src="ext" />
              <SourceBadge src="pf" />
              <div className="h-spacer" />
              <a className="h-link">Open in event console <Icon name="external" size={11} /></a>
            </div>
            <div className="card-b tight">
              <XIQEvents />
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
          <TweakToggle label="Show source badges (EXT/ZBX/PF)" value={t.showSourceBadges} onChange={v => setTweak("showSourceBadges", v)} />
        </TweakSection>
        <TweakSection label="Filters">
          <TweakRadio label="Sites view" value={t.siteFilter} options={[
            { value: "all",    label: "All"     },
            { value: "issues", label: "Issues"  },
            { value: "ok",     label: "Healthy" },
          ]} onChange={v => setTweak("siteFilter", v)} />
        </TweakSection>
        <TweakSection label="Quick actions">
          <TweakButton label="Refresh now" onClick={() => { setNow(new Date().toLocaleTimeString()); if (window.tcsXiqRefresh) window.tcsXiqRefresh(); }} />
          <TweakButton label="Schedule firmware" secondary onClick={() => console.info("[tcs] firmware schedule action not wired yet — see tcs.xiq.action TODO")} />
        </TweakSection>
      </TweaksPanel>
    </div>
  );
};

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
