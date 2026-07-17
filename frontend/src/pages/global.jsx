import React from "react";
import { getJSON } from "../api.js";
import { Card, Stat, Dot, Badge, Loading, ErrorMsg, deviceHref } from "../primitives.jsx";

// Global overview: fleet counts rolled up from /api/status + a problem list.
export function GlobalPage() {
  const [rows, setRows] = React.useState(null);
  const [error, setError] = React.useState(null);

  React.useEffect(() => {
    getJSON("/api/status").then(setRows).catch(setError);
  }, []);

  if (error) return <ErrorMsg error={error} />;
  if (!rows) return <Loading what="fleet status" />;

  const up = rows.filter((d) => d.ping.value === "up").length;
  const down = rows.filter((d) => d.ping.value === "down").length;
  const unknown = rows.length - up - down;
  const blind = rows.filter((d) => d.source_status.value === "blind").length;

  // Anything not fully healthy → surface in the problem list.
  const problems = rows.filter(
    (d) => d.ping.value === "down" || d.source_status.value === "blind" || d.snmp.value === "down"
  );

  return (
    <div className="page">
      <h1>Global</h1>
      <div className="stat-row">
        <Stat label="Devices" value={rows.length} severity="unknown" />
        <Stat label="Up" value={up} severity="ok" />
        <Stat label="Down" value={down} severity="crit" />
        <Stat label="Unknown" value={unknown} severity="warn" />
        <Stat label="Source blind" value={blind} severity={blind ? "warn" : "ok"} />
      </div>

      <Card title="Problems" kicker={`${problems.length} device(s) not fully healthy`}>
        {problems.length === 0 ? (
          <div className="msg">All monitored devices are healthy.</div>
        ) : (
          <table className="grid">
            <thead>
              <tr><th></th><th>Name</th><th>Site</th><th>Type</th><th>Ping</th><th>SNMP</th><th>Source</th></tr>
            </thead>
            <tbody>
              {problems.map((d) => (
                <tr key={d.id}>
                  <td><Dot severity={worst(d)} /></td>
                  <td><a href={deviceHref(d)}>{d.name}</a></td>
                  <td>{d.site || "—"}</td>
                  <td>{d.device_type}</td>
                  <td><Badge state={d.ping} /></td>
                  <td><Badge state={d.snmp} /></td>
                  <td><Badge state={d.source_status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

function worst(d) {
  const order = { crit: 3, warn: 2, unknown: 1, ok: 0 };
  return [d.ping, d.snmp, d.source_status]
    .map((s) => s.severity)
    .sort((a, b) => (order[b] || 0) - (order[a] || 0))[0];
}
