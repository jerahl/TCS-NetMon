import React from "react";
import { getJSON } from "../api.js";
import { Card, Stat, Badge, Dot, Loading, ErrorMsg } from "../primitives.jsx";

// Surveillance NOC — cameras + recording servers from /api/status.
export function SurveillancePage() {
  const [rows, setRows] = React.useState(null);
  const [error, setError] = React.useState(null);

  React.useEffect(() => {
    getJSON("/api/status").then(setRows).catch(setError);
  }, []);

  if (error) return <ErrorMsg error={error} />;
  if (!rows) return <Loading what="surveillance" />;

  const cameras = rows.filter((d) => d.device_type === "camera");
  const servers = rows.filter((d) => d.device_type === "recording_server");
  const recording = cameras.filter((c) => c.recording.value === "up").length;

  return (
    <div className="page">
      <h1>Surveillance</h1>
      <div className="stat-row">
        <Stat label="Cameras" value={cameras.length} severity="unknown" />
        <Stat label="Recording" value={recording} severity={recording === cameras.length ? "ok" : "warn"} />
        <Stat label="Rec. servers" value={servers.length} severity="unknown" />
      </div>

      <Card title="Recording servers">
        {servers.length === 0 ? <div className="msg">None in the registry.</div> : (
          <table className="grid">
            <thead><tr><th></th><th>Name</th><th>Site</th><th>Source</th></tr></thead>
            <tbody>
              {servers.map((d) => (
                <tr key={d.id}>
                  <td><Dot severity={d.source_status.severity} /></td>
                  <td><a href={`#/ap/${d.id}`}>{d.name}</a></td>
                  <td>{d.site || "—"}</td>
                  <td><Badge state={d.source_status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card title="Cameras" kicker={`${cameras.length}`}>
        {cameras.length === 0 ? <div className="msg">None in the registry.</div> : (
          <table className="grid">
            <thead><tr><th></th><th>Name</th><th>Site</th><th>Recording</th><th>Ping</th></tr></thead>
            <tbody>
              {cameras.map((d) => (
                <tr key={d.id}>
                  <td><Dot severity={d.recording.severity} /></td>
                  <td><a href={`#/ap/${d.id}`}>{d.name}</a></td>
                  <td>{d.site || "—"}</td>
                  <td><Badge state={d.recording} /></td>
                  <td><Badge state={d.ping} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
