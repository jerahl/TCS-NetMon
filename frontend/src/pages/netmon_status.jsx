import React from "react";
import { getJSON } from "../api.js";
import { Card, Loading, ErrorMsg, Stat } from "../primitives.jsx";
import { ageOf } from "../format.js";

// NetMon Status (spec 11 D2) — the standalone replacement for ZCD's Zabbix
// Status page: NetMon's own self-health instead of Zabbix internals. Reads
// /api/netmon-status: collector heartbeats (collector_health), supervised-task
// stats (in-process; reset on restart), DB row counts, engine mode.

const REFRESH_MS = 30000;

const HEALTH_COLOR = { ok: "#1fb75a", error: "#e5484d", unknown: "#8a8f98" };

function uptime(s) {
  if (s === null || s === undefined) return "—";
  if (s < 120) return `${Math.round(s)}s`;
  if (s < 7200) return `${Math.round(s / 60)}m`;
  if (s < 172800) return `${(s / 3600).toFixed(1)}h`;
  return `${(s / 86400).toFixed(1)}d`;
}

function StatusWord({ ok, okText, badText }) {
  return (
    <span style={{ color: ok ? HEALTH_COLOR.ok : HEALTH_COLOR.error, fontWeight: 600 }}>
      {ok ? okText : badText}
    </span>
  );
}

export function NetmonStatusPage() {
  const [status, setStatus] = React.useState(null);
  const [error, setError] = React.useState(null);

  React.useEffect(() => {
    const load = () =>
      getJSON("/api/netmon-status")
        .then((s) => { setStatus(s); setError(null); })
        .catch(setError);
    load();
    const id = setInterval(load, REFRESH_MS);
    return () => clearInterval(id);
  }, []);

  if (error) return <ErrorMsg error={error} />;
  if (!status) return <Loading what="NetMon status" />;

  const db = status.db || {};
  const failingTasks = status.tasks.filter((t) => t.last_error).length;
  const failingCollectors = status.collectors.filter((c) => c.status === "error").length;

  return (
    <div className="page">
      <h1>NetMon Status</h1>
      <div className="subtitle">
        NetMon self-health · v{status.version} · refreshes every {REFRESH_MS / 1000}s
        {" · "}supervised-task stats are the running process's view (reset on restart)
      </div>

      <div className="stat-row">
        <Stat label="Uptime" value={uptime(status.uptime_s)} severity="ok" />
        <Stat label="Database" value={status.db_ok ? "connected" : "DOWN"}
              severity={status.db_ok ? "ok" : "crit"} />
        <Stat label="Supervised tasks"
              value={`${status.tasks.filter((t) => t.running).length}/${status.tasks.length}`}
              severity={failingTasks ? "warn" : "ok"} />
        <Stat label="Collectors failing" value={failingCollectors}
              severity={failingCollectors ? "crit" : "ok"} />
        <Stat label="Alert engine"
              value={!status.engine_enabled ? "off" : status.engine_shadow ? "shadow" : "LIVE"}
              severity={!status.engine_enabled ? "unknown" : status.engine_shadow ? "warn" : "ok"} />
        <Stat label="Sessions" value={db.sessions_active ?? "—"} />
      </div>

      <Card kicker="Collector heartbeats" title="Sources (collector_health)">
        {status.collectors.length === 0 ? (
          <div className="msg">No collector has reported yet.</div>
        ) : (
          <table className="grid">
            <thead>
              <tr>
                <th></th><th>Collector</th><th>Status</th><th>Last success</th>
                <th>Duration</th><th>Records</th><th>Consec. failures</th><th>Last error</th>
              </tr>
            </thead>
            <tbody>
              {status.collectors.map((c) => (
                <tr key={c.name}>
                  <td><span className="dot" style={{ background: HEALTH_COLOR[c.status] || HEALTH_COLOR.unknown }} /></td>
                  <td className="mono">{c.name}</td>
                  <td><StatusWord ok={c.status === "ok"} okText="ok"
                                  badText={c.status} /></td>
                  <td className="mono dim">{c.last_success ? ageOf(c.last_success) + " ago" : "never"}</td>
                  <td className="mono dim">{c.duration_ms != null ? `${c.duration_ms}ms` : "—"}</td>
                  <td className="mono dim">{c.records_written ?? "—"}</td>
                  <td className="mono">{c.consecutive_failures || 0}</td>
                  <td className="mono dim">{c.last_error || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card kicker="Task supervisor" title="Supervised tasks">
        <table className="grid">
          <thead>
            <tr>
              <th>Task</th><th>State</th><th>Interval</th><th>Runs</th>
              <th>Failures</th><th>Last run</th><th>Last error</th>
            </tr>
          </thead>
          <tbody>
            {status.tasks.map((t) => (
              <tr key={t.name}>
                <td className="mono">{t.name}</td>
                <td>
                  {!t.enabled ? <span className="dim">disabled</span>
                    : <StatusWord ok={t.running} okText="running" badText="stopped" />}
                </td>
                <td className="mono dim">{t.interval_s}s</td>
                <td className="mono">{t.runs}</td>
                <td className="mono" style={t.failures ? { color: HEALTH_COLOR.error } : undefined}>
                  {t.failures}
                </td>
                <td className="mono dim">{t.last_run_at ? ageOf(t.last_run_at) + " ago" : "—"}</td>
                <td className="mono dim">{t.last_error || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <Card kicker="Database" title="Row counts">
        <div className="stat-row">
          <Stat label="Devices (enabled/total)" value={`${db.devices_enabled}/${db.devices_total}`} />
          <Stat label="State rows" value={db.state_rows} />
          <Stat label="Events · 24h" value={db.events_24h} />
          <Stat label="Events · total" value={db.events_total} />
          <Stat label="Open alerts" value={db.alerts_open}
                severity={db.alerts_open ? "warn" : "ok"} />
          <Stat label="Shadow notifications" value={db.notifications_shadow} />
        </div>
      </Card>
    </div>
  );
}
