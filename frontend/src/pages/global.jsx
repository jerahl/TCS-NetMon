import React from "react";
import { getJSON } from "../api.js";
import { Card, Dot, Loading, ErrorMsg, Freshness, sevColor } from "../primitives.jsx";
import { HistoryChart } from "../history.jsx";
import { ageOf } from "../format.js";
import { sevLabel, SEV_RANK } from "../severity.js";

// Global dashboard (spec 10 §6 / phase 10.5): the district-wide NOC view, all
// rolled up from NetMon's own DB — zero source-platform calls at render.
//   • severity strip + open-alert tiles           (/api/summary)
//   • per-domain system cards, staleness-badged    (/api/summary)
//   • site heatmap                                 (/api/sites)
//   • active triggers                              (/api/alerts)
//   • recent event stream                          (/api/events)
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
    const id = setInterval(tick, 30000);
    return () => { live = false; clearInterval(id); };
  }, []);

  if (error) return <ErrorMsg error={error} />;
  if (!summary) return <Loading what="global overview" />;

  const f = summary.fleet;
  const al = summary.alerts;

  return (
    <div className="page">
      <div className="global-head">
        <h1>Global</h1>
        <span className="dim mono">
          updated <Freshness at={summary.generated_at} staleAfter={120} />
        </span>
      </div>

      {/* Severity strip — fleet reachability + open-alert pressure. */}
      <div className="stat-row">
        <Metric label="Devices" value={f.total} severity="unknown" />
        <Metric label="Up" value={f.up} severity="ok" />
        <Metric label="Down" value={f.down} severity={f.down ? "crit" : "ok"} />
        <Metric label="Unknown" value={f.unknown} severity={f.unknown ? "warn" : "ok"} />
        <Metric label="Source blind" value={f.blind} severity={f.blind ? "warn" : "ok"} />
        <Metric label="Open alerts" value={al.open} severity={al.crit ? "crit" : al.warn ? "warn" : "ok"}
                sub={`${al.crit} crit · ${al.warn} warn`} />
      </div>

      {/* System cards — one per monitored domain, honest about source health. */}
      <div className="sys-grid">
        {summary.domains.map((d) => <SystemCard key={d.key} d={d} />)}
      </div>

      {/* 24h trends from the bounded ring buffer (empty until [history] runs). */}
      <Card title="24-hour trends" kicker="history ring buffer">
        <div className="hchart-row">
          <HistoryChart series="fleet.up" label="Devices up" color={sevColor("ok")} />
          <HistoryChart series="fleet.down" label="Devices down" color={sevColor("crit")} />
          <HistoryChart series="alerts.open" label="Open alerts" color={sevColor("warn")} />
          <HistoryChart series="wireless.clients" label="Wireless clients" color={sevColor("unknown")} />
        </div>
      </Card>

      <div className="global-cols">
        <div className="global-col">
          <SiteHeatmap sites={sites} />
          <Triggers alerts={alerts} />
        </div>
        <div className="global-col">
          <EventStream events={events} />
        </div>
      </div>
    </div>
  );
}

function Metric({ label, value, severity, sub }) {
  return (
    <div className="stat">
      <div className="stat-value" style={{ color: sevColor(severity) }}>{value}</div>
      <div className="stat-label">{label}</div>
      {sub && <div className="stat-sub mono dim">{sub}</div>}
    </div>
  );
}

function SystemCard({ d }) {
  const sev = d.status || "unknown";
  return (
    <a className="sys-card" href={d.href || "#/"} style={{ borderColor: sevColor(sev) + "55" }}>
      <div className="sys-card-top">
        <Dot severity={sev} />
        <span className="sys-card-label">{d.label}</span>
        <span className="sys-card-sev" style={{ color: sevColor(sev) }}>{sevLabel(sev)}</span>
      </div>
      <div className="sys-card-headline">{d.headline || "—"}</div>
      <div className="kpi-row">
        {d.kpis.map((k, i) => (
          <div className="kpi" key={i}>
            <div className="kpi-value" style={{ color: sevColor(k.severity) }}>{k.value}</div>
            <div className="kpi-label">{k.label}</div>
          </div>
        ))}
      </div>
      <div className="sys-card-foot mono">
        {d.blind
          ? <span style={{ color: sevColor("warn") }}>⚠ {d.source} blind</span>
          : <span className="dim">{d.source || "—"}</span>}
        <span className="dim"> · <Freshness at={d.updated_at} ok={!d.blind} /></span>
      </div>
    </a>
  );
}

const STATUS_COLOR = { up: "ok", degraded: "warn", down: "crit", unknown: "unknown" };

function SiteHeatmap({ sites }) {
  if (!sites) return <Card title="Sites"><Loading what="sites" /></Card>;
  const sorted = [...sites].sort((a, b) => {
    const r = (SEV_RANK[STATUS_COLOR[b.status]] || 0) - (SEV_RANK[STATUS_COLOR[a.status]] || 0);
    return r !== 0 ? r : (b.problems || 0) - (a.problems || 0);
  });
  return (
    <Card title="Sites" kicker={`${sites.length} site(s)`}>
      {sorted.length === 0 ? (
        <div className="msg">No sites configured — seed or import a topology.</div>
      ) : (
        <div className="site-grid">
          {sorted.map((s) => {
            const sev = STATUS_COLOR[s.status] || "unknown";
            return (
              <a className="site-tile" key={s.name} href="#/map"
                 style={{ borderLeftColor: sevColor(sev) }}
                 title={`${s.display_name || s.name} · ${s.status}`}>
                <div className="site-tile-name">{s.display_name || s.name}</div>
                <div className="site-tile-meta mono dim">
                  {s.devices_total} dev{s.devices_down ? ` · ${s.devices_down} down` : ""}
                </div>
                {s.problems > 0 && (
                  <div className="site-tile-prob" style={{ color: sevColor(s.worst_severity) }}>
                    {s.problems} open
                  </div>
                )}
              </a>
            );
          })}
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
    <Card title="Active triggers" kicker={`${open.length} open`}>
      {open.length === 0 ? (
        <div className="msg">No open alerts.</div>
      ) : (
        <table className="grid">
          <thead>
            <tr><th></th><th>Device</th><th>Rule</th><th>Since</th><th>Ack</th></tr>
          </thead>
          <tbody>
            {open.slice(0, 12).map((a) => (
              <tr key={a.id}>
                <td><Dot severity={a.severity} /></td>
                <td>{a.device_name || `#${a.device_id}`}</td>
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
    <Card title="Recent events" kicker="state transitions">
      {events.length === 0 ? (
        <div className="msg">No recent state changes.</div>
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
