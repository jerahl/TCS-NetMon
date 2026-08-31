import React from "react";
import { getJSON } from "../api.js";
import { Card, Dot, Loading, ErrorMsg, Freshness, sevColor } from "../primitives.jsx";
import { HistoryChart } from "../history.jsx";
import { ageOf } from "../format.js";
import { sevLabel, SEV_RANK } from "../severity.js";

// Global dashboard, on ZCD's global.css vocabulary (spec 14 §2, spec 18
// addendum). Every number still comes from NetMon's own DB — zero
// source-platform calls at render.
//
// Two things this page is deliberately NOT copying from ZCD:
//
//  * **The five-level Disaster/High/Warning/Info ladder.** NetMon's severity
//    enum is four values and that was a decided design (spec 16 C4,
//    `severity.js`), so the strip renders NetMon's ladder in ZCD's cells
//    rather than inventing two levels the DB cannot express.
//  * **SLA %.** ZCD's site tiles read "SLA 100.00%" everywhere and that number
//    is fabricated — ActionGlobalData.php:481 sets it to null unconditionally
//    and the bridge substitutes `target ?? 100` (spec 16 C2). The tile shows
//    device counts instead. The row is omitted, not defaulted.

const REFRESH_MS = 30000;

export function GlobalPage() {
  const [summary, setSummary] = React.useState(null);
  const [sites, setSites] = React.useState(null);
  const [alerts, setAlerts] = React.useState(null);
  const [events, setEvents] = React.useState(null);
  const [error, setError] = React.useState(null);

  React.useEffect(() => {
    let live = true;
    const tick = () => {
      Promise.all([
        getJSON("/api/summary"),
        getJSON("/api/sites"),
        getJSON("/api/alerts"),
        getJSON("/api/events?limit=12"),
      ])
        .then(([s, si, a, e]) => {
          if (!live) return;
          setSummary(s); setSites(si); setAlerts(a); setEvents(e);
        })
        .catch((err) => { if (live) setError(err); });
    };
    tick();
    const id = setInterval(tick, REFRESH_MS);
    return () => { live = false; clearInterval(id); };
  }, []);

  if (error) return <ErrorMsg error={error} />;
  if (!summary) return <Loading what="global overview" />;

  return (
    <div className="page">
      <div className="global-head">
        <h1>Global Dashboard</h1>
        <span className="dim mono">
          updated <Freshness at={summary.generated_at} staleAfter={120} />
        </span>
      </div>

      <SeverityStrip summary={summary} />

      <Card title="System snapshot"
            kicker={`${summary.domains.length} systems · ` +
                    `${summary.domains.filter((d) => d.status !== "ok").length} need attention`}>
        <div className="sys-grid">
          {summary.domains.map((d) => <SystemCard key={d.key} d={d} />)}
        </div>
      </Card>

      <Card title="24-hour trends" kicker="history ring buffer">
        <div className="hchart-row">
          <HistoryChart series="fleet.up" label="Devices up" color={sevColor("ok")} />
          <HistoryChart series="fleet.down" label="Devices down" color={sevColor("crit")} />
          <HistoryChart series="alerts.open" label="Open alerts" color={sevColor("warn")} />
          <HistoryChart series="wireless.clients" label="Wireless clients" color={sevColor("unknown")} />
        </div>
      </Card>

      <SiteHeatmap sites={sites} />

      <div className="global-cols">
        <div className="global-col">
          <Hotspots sites={sites} />
          <Triggers alerts={alerts} />
        </div>
        <div className="global-col">
          <EventStream events={events} />
        </div>
      </div>
    </div>
  );
}

// ───────── Severity strip ─────────
//
// The component spec 14 §3 costed as "a severity model plus a new endpoint".
// It is neither: /api/summary already returns `severity` (a per-device worst-of
// roll-up) and `alerts.acked/unacked`, and this page simply never read them —
// spec 16 C1's headline finding. Six cells, matching ZCD's grid.
function SeverityStrip({ summary }) {
  const sev = summary.severity || {};
  const al = summary.alerts || {};
  const f = summary.fleet || {};

  const cells = [
    { key: "crit", label: sevLabel("crit"), value: sev.crit || 0, sev: "crit",
      note: `${al.crit || 0} open alert${(al.crit || 0) === 1 ? "" : "s"}` },
    { key: "warn", label: sevLabel("warn"), value: sev.warn || 0, sev: "warn",
      note: `${al.warn || 0} open alert${(al.warn || 0) === 1 ? "" : "s"}` },
    { key: "ok", label: sevLabel("ok"), value: sev.ok || 0, sev: "ok",
      note: `of ${f.total || 0}` },
    // "unknown" is a first-class state here, not padding: a device with no
    // reading must never be counted as healthy (§4.5).
    { key: "unknown", label: sevLabel("unknown"), value: sev.unknown || 0, sev: "unknown",
      note: "no reading yet" },
    { key: "acked", label: "Acknowledged", value: al.acked || 0, sev: "unknown",
      note: `${al.unacked || 0} unacked` },
    { key: "down", label: "Devices down", value: f.down || 0,
      sev: f.down ? "crit" : "ok", note: `of ${f.total || 0}` },
  ];

  return (
    <Card tight>
      <div className="sev-strip">
        {cells.map((c) => (
          <div className="sev-cell" key={c.key}>
            <div className="sev-cell-h">
              <Dot severity={c.sev} />
              <span className="sev-cell-lbl" style={{ color: sevColor(c.sev) }}>{c.label}</span>
            </div>
            <div className="sev-cell-v" style={{ color: sevColor(c.sev) }}>{c.value}</div>
            <div className="sev-cell-note">{c.note}</div>
          </div>
        ))}
      </div>
    </Card>
  );
}

// ───────── System snapshot ─────────
function SystemCard({ d }) {
  const sev = d.status || "unknown";
  return (
    <a className="sys-card" href={d.href || "#/"}>
      <div className="sys-h">
        <div className="sys-icon" style={{ borderColor: sevColor(sev) + "66", color: sevColor(sev) }}>
          <Dot severity={sev} />
        </div>
        <div className="sys-h-meta">
          <div className="sys-h-title">{d.label}</div>
          <div className="sys-h-sub">{d.source || "—"}</div>
        </div>
        <span className="sys-status"
              style={{ borderColor: sevColor(sev) + "66", color: sevColor(sev) }}>
          <span className="dot" style={{ background: sevColor(sev) }} />
          {sevLabel(sev)}
        </span>
      </div>

      <div className="sys-kpis">
        {d.kpis.slice(0, 3).map((k, i) => (
          <div className="sys-kpi" key={i}>
            <div className="sys-kpi-lbl">{k.label}</div>
            <div className="sys-kpi-v" style={{ color: sevColor(k.severity) }}>{k.value}</div>
          </div>
        ))}
      </div>

      <div className="sys-foot">
        <div className="sys-foot-msg">
          {d.blind
            ? <span style={{ color: sevColor("warn") }}>⚠ {d.source} blind — last reading is stale</span>
            : (d.headline || "—")}
        </div>
        <div className="sys-foot-link">
          <Freshness at={d.updated_at} ok={!d.blind} /> · OPEN ↗
        </div>
      </div>
    </a>
  );
}

// ───────── Sites heatmap ─────────
const STATUS_SEV = { up: "ok", degraded: "warn", down: "crit", unknown: "unknown" };

function SiteHeatmap({ sites }) {
  const [filter, setFilter] = React.useState("all");
  if (!sites) return <Card title="Sites — health map"><Loading what="sites" /></Card>;

  const sorted = [...sites].sort((a, b) => {
    const r = (SEV_RANK[STATUS_SEV[b.status]] || 0) - (SEV_RANK[STATUS_SEV[a.status]] || 0);
    return r !== 0 ? r : (b.problems || 0) - (a.problems || 0);
  });
  const issues = sorted.filter((s) => s.status !== "up");
  const shown = filter === "issues" ? issues
    : filter === "ok" ? sorted.filter((s) => s.status === "up") : sorted;
  const totalProblems = sorted.reduce((n, s) => n + (s.problems || 0), 0);
  const totalDevices = sorted.reduce((n, s) => n + (s.devices_total || 0), 0);

  return (
    <Card title="Sites — health map" tight
          kicker={
            <span className="seg-toggle">
              {[["all", `All ${sorted.length}`], ["issues", `Issues ${issues.length}`],
                ["ok", `OK ${sorted.length - issues.length}`]].map(([k, label]) => (
                <button key={k} type="button"
                        className={"seg-btn" + (filter === k ? " active" : "")}
                        onClick={() => setFilter(k)}>{label}</button>
              ))}
            </span>
          }>
      {sorted.length === 0 ? (
        <div className="msg" style={{ padding: 14 }}>
          No sites configured — seed or import a topology.
        </div>
      ) : (
        <>
          <div className="sites-grid" style={{ padding: 14 }}>
            {shown.map((s) => {
              const sev = STATUS_SEV[s.status] || "unknown";
              return (
                <a className={"site-tile" + (s.status === "down" ? " pulse" : "")}
                   key={s.name} href="#/map"
                   style={{ borderColor: sevColor(sev) + "66",
                            background: sevColor(sev) + "14" }}
                   title={`${s.display_name || s.name} · ${s.status}` +
                          (s.devices_degraded ? ` · ${s.devices_degraded} switch(es) down` : "")}>
                  <div className="site-tile-h">
                    {s.problems > 0 ? (
                      <span className="site-tile-prob" style={{ color: sevColor(s.worst_severity) }}>
                        {s.problems}
                      </span>
                    ) : (
                      <span className="site-tile-prob" style={{ color: sevColor("ok") }}>✓</span>
                    )}
                  </div>
                  <div className="site-tile-name">{s.display_name || s.name}</div>
                  {/* ZCD prints "SLA 100.00%" here. It is hardcoded in the
                      reference (spec 16 C2), so the slot carries the switch-down
                      count — a fact — or nothing. */}
                  <div className="site-tile-meta">
                    <span>{s.devices_total} dev</span>
                    {s.devices_degraded > 0 && <span>{s.devices_degraded} sw down</span>}
                  </div>
                </a>
              );
            })}
          </div>
          <div className="sites-legend">
            {["crit", "warn", "ok", "unknown"].map((k) => (
              <span className="legend-item" key={k}>
                <span className="legend-sw" style={{ borderColor: sevColor(k) + "66",
                                                     background: sevColor(k) + "22" }} />
                {sevLabel(k)}
              </span>
            ))}
            <span className="legend-foot">
              {totalProblems} problem(s) · {totalDevices} device(s) shown
            </span>
          </div>
        </>
      )}
    </Card>
  );
}

// ───────── Top problem hotspots ─────────
// ZCD's panel, which NetMon had no equivalent for. It was unbuildable until
// site attribution landed (spec 17) — every site's `problems` was 0 because
// alerts carried "Unassigned"/"Wireless APs" instead of a location.
function Hotspots({ sites }) {
  if (!sites) return <Card title="Top problem hotspots"><Loading what="sites" /></Card>;
  const ranked = [...sites]
    .filter((s) => (s.problems || 0) > 0)
    .sort((a, b) => (b.problems || 0) - (a.problems || 0))
    .slice(0, 6);
  const max = ranked.length ? ranked[0].problems : 0;

  return (
    <Card title="Top problem hotspots" kicker="by site" tight>
      {ranked.length === 0 ? (
        <div className="msg" style={{ padding: 14 }}>No site has an open problem.</div>
      ) : (
        <div className="hotspots">
          {ranked.map((s, i) => (
            <a className="hotspot-row" key={s.name} href="#/problems">
              <span className="hotspot-id">{i + 1}</span>
              <span className="hotspot-name">{s.display_name || s.name}</span>
              <span className="hotspot-prob" style={{ color: sevColor(s.worst_severity) }}>
                {s.problems}
              </span>
              <span className="hotspot-bar">
                <span style={{ width: `${max ? (s.problems / max) * 100 : 0}%`,
                               background: sevColor(s.worst_severity) }} />
              </span>
              <span className="hotspot-meta">{s.devices_total} hosts</span>
            </a>
          ))}
        </div>
      )}
    </Card>
  );
}

function Triggers({ alerts }) {
  if (!alerts) return <Card title="Active triggers"><Loading what="alerts" /></Card>;
  const open = alerts.filter((a) => !a.closed_at);
  open.sort((a, b) => (SEV_RANK[b.severity] || 0) - (SEV_RANK[a.severity] || 0));
  return (
    <Card title="Active triggers" kicker={`${open.length} open`} tight>
      {open.length === 0 ? (
        <div className="msg" style={{ padding: 14 }}>No open alerts.</div>
      ) : (
        <table className="grid trig-tbl">
          <thead>
            <tr><th></th><th>Device</th><th>Site</th><th>Rule</th><th>Age</th><th>Ack</th></tr>
          </thead>
          <tbody>
            {open.slice(0, 12).map((a) => (
              <tr key={a.id}>
                <td><Dot severity={a.severity} /></td>
                <td>{a.device_name || `#${a.device_id}`}</td>
                <td className="dim">{a.site || "—"}</td>
                <td>{a.rule_name}</td>
                <td className="mono dim">{ageOf(a.opened_at) || "—"}</td>
                <td className="mono dim">{a.acked_by || (a.assigned_to ? `→${a.assigned_to}` : "—")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

function EventStream({ events }) {
  if (!events) return <Card title="Recent events"><Loading what="events" /></Card>;
  return (
    <Card title="Recent events" kicker="state transitions" tight>
      {events.length === 0 ? (
        <div className="msg" style={{ padding: 14 }}>No recent state changes.</div>
      ) : (
        <table className="grid">
          <thead>
            <tr><th></th><th>Device</th><th>Change</th><th>Age</th></tr>
          </thead>
          <tbody>
            {events.map((e) => (
              <tr key={e.id}>
                <td><Dot severity={e.severity} /></td>
                <td>{e.device}<div className="mono dim">{e.dimension}</div></td>
                <td className="mono">{e.old_value || "—"} → {e.new_value || "—"}</td>
                <td className="mono dim">{ageOf(e.occurred_at) || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}
