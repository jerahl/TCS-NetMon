import React from "react";
import { getJSON } from "../api.js";
import { Card, Stat, Badge, Dot, Loading, ErrorMsg } from "../primitives.jsx";

// Voice — 3CX trunks + PBX from /api/status (device_type trunk / pbx).
export function VoipPage() {
  const [rows, setRows] = React.useState(null);
  const [error, setError] = React.useState(null);

  React.useEffect(() => {
    getJSON("/api/status").then(setRows).catch(setError);
  }, []);

  if (error) return <ErrorMsg error={error} />;
  if (!rows) return <Loading what="voice" />;

  const trunks = rows.filter((d) => d.device_type === "trunk");
  const pbxes = rows.filter((d) => d.device_type === "pbx");
  const registered = trunks.filter((t) => t.trunk.value === "up").length;

  return (
    <div className="page">
      <h1>VoIP · 3CX</h1>
      <div className="stat-row">
        <Stat label="Trunks" value={trunks.length} severity="unknown" />
        <Stat label="Registered" value={registered}
              severity={registered === trunks.length ? "ok" : "crit"} />
        <Stat label="PBX" value={pbxes.length} severity="unknown" />
      </div>

      <Card title="Trunks">
        {trunks.length === 0 ? <div className="msg">No trunks in the registry.</div> : (
          <table className="grid">
            <thead><tr><th></th><th>Name</th><th>Site</th><th>Registration</th></tr></thead>
            <tbody>
              {trunks.map((d) => (
                <tr key={d.id}>
                  <td><Dot severity={d.trunk.severity} /></td>
                  <td><a href={`#/ap/${d.id}`}>{d.name}</a></td>
                  <td>{d.site || "—"}</td>
                  <td><Badge state={d.trunk} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {pbxes.length > 0 && (
        <Card title="PBX">
          <table className="grid">
            <thead><tr><th></th><th>Name</th><th>Source</th><th>Ping</th></tr></thead>
            <tbody>
              {pbxes.map((d) => (
                <tr key={d.id}>
                  <td><Dot severity={d.source_status.severity} /></td>
                  <td><a href={`#/ap/${d.id}`}>{d.name}</a></td>
                  <td><Badge state={d.source_status} /></td>
                  <td><Badge state={d.ping} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
