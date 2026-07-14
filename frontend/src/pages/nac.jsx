import React from "react";
import { getJSON } from "../api.js";
import { Card, Stat, Loading, ErrorMsg } from "../primitives.jsx";

// NAC — PacketFence linked view (cached snapshot from /api/nac).
export function NacPage() {
  const [data, setData] = React.useState(null);
  const [error, setError] = React.useState(null);

  React.useEffect(() => {
    getJSON("/api/nac").then(setData).catch(setError);
  }, []);

  if (error) return <ErrorMsg error={error} />;
  if (!data) return <Loading what="NAC" />;
  if (!data.enabled) {
    return (
      <div className="page">
        <h1>NAC</h1>
        <div className="msg">PacketFence collector is not enabled.</div>
      </div>
    );
  }

  const stale = !data.ok;
  return (
    <div className="page">
      <h1>NAC · PacketFence</h1>
      <div className="subtitle">
        {data.fetched_at ? `Snapshot ${new Date(data.fetched_at).toLocaleString()}` : "no data yet"}
        {stale && <span style={{ color: "#e8a415" }}> · stale (source unreachable)</span>}
      </div>

      <div className="stat-row">
        <Stat label="Registered" value={data.registered ?? 0} severity="ok" />
        <Stat label="Unregistered" value={data.unregistered ?? 0} severity={data.unregistered ? "warn" : "ok"} />
        <Stat label="Auth failures" value={(data.auth_failures || []).length} severity={(data.auth_failures || []).length ? "warn" : "ok"} />
      </div>

      <Card title="Recent 802.1X rejects">
        {(data.auth_failures || []).length === 0 ? (
          <div className="msg">No recent rejects.</div>
        ) : (
          <table className="grid">
            <thead><tr><th>Time</th><th>MAC</th><th>User</th><th>NAS</th><th>Reason</th></tr></thead>
            <tbody>
              {data.auth_failures.map((f, i) => (
                <tr key={i}>
                  <td className="mono">{f.created_at || "—"}</td>
                  <td className="mono">{f.mac || "—"}</td>
                  <td>{f.user_name || "—"}</td>
                  <td className="mono">{f.nas_ip_address || "—"}</td>
                  <td>{f.reason || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card title="Nodes" kicker={`${(data.nodes || []).length}${data.truncated ? "+ (truncated)" : ""}`}>
        <table className="grid">
          <thead><tr><th>MAC</th><th>Host</th><th>IP</th><th>Status</th><th>Role</th></tr></thead>
          <tbody>
            {(data.nodes || []).slice(0, 200).map((n, i) => (
              <tr key={i}>
                <td className="mono">{n.mac || "—"}</td>
                <td>{n.computername || "—"}</td>
                <td className="mono">{n["ip4log.ip"] || "—"}</td>
                <td style={{ color: String(n.status).toLowerCase() === "reg" ? "#1fb75a" : "#e8a415" }}>
                  {n.status || "—"}
                </td>
                <td>{n.category_id || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
