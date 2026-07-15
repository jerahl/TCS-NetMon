import React from "react";
import { getJSON, qs } from "../api.js";
import { Card, Loading, ErrorMsg, Dot, SevText, SourceBadge, sevColor } from "../primitives.jsx";
import { sevLabel } from "../severity.js";

// Events Console (spec 10 §7). The state-transition feed from /api/events with
// the design's filter bar, KPI tiles and 24h severity histogram (from
// /api/events/stats — computed, not a stored series). These are transitions,
// not open problems: ack/assign/suppress are alert-lifecycle actions and live
// on the Problems page. Auto-refreshes on the cache cadence (30s).

const REFRESH_MS = 30000;
const SEVERITIES = ["crit", "warn", "ok", "unknown"];
const DIMENSIONS = ["ping", "snmp", "source_status", "config_backup", "recording", "trunk"];
const DEVICE_TYPES = ["switch", "ap", "camera", "recording_server", "trunk", "pbx", "other"];
const PAGE = 100;

function ageOf(iso) {
  if (!iso) return "—";
  const t = Date.parse(iso.endsWith("Z") || iso.includes("+") ? iso : iso + "Z");
  if (Number.isNaN(t)) return "—";
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 90) return `${Math.round(s)}s`;
  if (s < 5400) return `${Math.round(s / 60)}m`;
  if (s < 129600) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

function hourLabel(iso) {
  const t = Date.parse(iso && (iso.endsWith("Z") || iso.includes("+")) ? iso : iso + "Z");
  if (Number.isNaN(t)) return "";
  return new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// Stacked-bar histogram over the 24h buckets from /api/events/stats.
function Histogram({ buckets }) {
  const max = Math.max(1, ...buckets.map((b) => b.total));
  return (
    <div className="evt-hist" role="img" aria-label="events per hour by severity">
      {buckets.map((b, i) => (
        <div className="evt-hist-col" key={i} title={`${hourLabel(b.hour)} · ${b.total} event(s)`}>
          <div className="evt-hist-bar" style={{ height: `${(b.total / max) * 100}%` }}>
            {SEVERITIES.map((s) =>
              b[s] ? (
                <div
                  key={s}
                  style={{ flex: b[s], background: sevColor(s) }}
                  className="evt-hist-seg"
                />
              ) : null
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function Select({ label, value, onChange, options, render }) {
  return (
    <label className="evt-filter">
      <span>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">All</option>
        {options.map((o) => (
          <option key={o} value={o}>{render ? render(o) : o}</option>
        ))}
      </select>
    </label>
  );
}

export function EventsPage() {
  const [filters, setFilters] = React.useState({
    severity: "", source: "", site: "", device_type: "", dimension: "", q: "",
  });
  const [events, setEvents] = React.useState(null);
  const [stats, setStats] = React.useState(null);
  const [error, setError] = React.useState(null);

  const set = (k) => (v) => setFilters((f) => ({ ...f, [k]: v }));

  const load = React.useCallback(() => {
    const query = qs({ ...filters, limit: PAGE });
    Promise.all([
      getJSON("/api/events" + query),
      getJSON("/api/events/stats" + qs({ ...filters, severity: undefined })),
    ])
      .then(([ev, st]) => { setEvents(ev); setStats(st); setError(null); })
      .catch(setError);
  }, [filters]);

  React.useEffect(() => {
    load();
    const id = setInterval(load, REFRESH_MS);
    return () => clearInterval(id);
  }, [load]);

  if (error) return <ErrorMsg error={error} />;

  // Filter options for source/site are derived from what the feed currently
  // shows — self-consistent, no extra round-trip.
  const sources = events ? [...new Set(events.map((e) => e.source).filter(Boolean))].sort() : [];
  const sites = events ? [...new Set(events.map((e) => e.site).filter(Boolean))].sort() : [];
  const by = stats?.by_severity || {};

  return (
    <div className="page">
      <h1>Events Console</h1>
      <div className="subtitle">
        State transitions from the poller and collectors · last {stats?.window_hours || 24}h ·
        refreshes every {REFRESH_MS / 1000}s (cache cadence)
      </div>

      <div className="stat-row">
        <div className="stat">
          <div className="stat-value">{stats ? stats.total : "…"}</div>
          <div className="stat-label">Events · {stats?.window_hours || 24}h</div>
        </div>
        {SEVERITIES.map((s) => (
          <div className="stat" key={s}>
            <div className="stat-value" style={{ color: sevColor(s) }}>{by[s] ?? "…"}</div>
            <div className="stat-label">{sevLabel(s)}</div>
          </div>
        ))}
      </div>

      <Card kicker="Events per hour">
        {stats ? <Histogram buckets={stats.buckets} /> : <Loading what="histogram" />}
      </Card>

      <div className="evt-filters">
        <Select label="Severity" value={filters.severity} onChange={set("severity")}
                options={SEVERITIES} render={sevLabel} />
        <Select label="Source" value={filters.source} onChange={set("source")} options={sources} />
        <Select label="Site" value={filters.site} onChange={set("site")} options={sites} />
        <Select label="Type" value={filters.device_type} onChange={set("device_type")}
                options={DEVICE_TYPES} />
        <Select label="Dimension" value={filters.dimension} onChange={set("dimension")}
                options={DIMENSIONS} />
        <label className="evt-filter evt-filter-grow">
          <span>Search</span>
          <input type="text" placeholder="device or value…" value={filters.q}
                 onChange={(e) => set("q")(e.target.value)} />
        </label>
      </div>

      <Card kicker={events ? `${events.length} event(s)${events.length === PAGE ? " (latest " + PAGE + ")" : ""}` : ""}>
        {!events ? (
          <Loading what="events" />
        ) : events.length === 0 ? (
          <div className="msg">No events match these filters.</div>
        ) : (
          <table className="grid">
            <thead>
              <tr>
                <th></th><th>Severity</th><th>Time</th><th>Age</th><th>Source</th>
                <th>Device</th><th>Site</th><th>Type</th><th>Change</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.id}>
                  <td><Dot severity={e.severity} /></td>
                  <td><SevText severity={e.severity} /></td>
                  <td className="mono">{e.occurred_at || "—"}</td>
                  <td className="mono dim">{ageOf(e.occurred_at)}</td>
                  <td><SourceBadge source={e.source} /></td>
                  <td>{e.device}</td>
                  <td>{e.site || "—"}</td>
                  <td className="dim">{e.device_type}</td>
                  <td className="mono">
                    <span className="dim">{e.dimension}: </span>
                    {e.old_value || "—"} <span className="dim">→</span> {e.new_value || "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
