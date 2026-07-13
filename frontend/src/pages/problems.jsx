import React from "react";
import { getJSON } from "../api.js";
import { Card, Dot, Loading, ErrorMsg, sevColor } from "../primitives.jsx";

// Problems — open alerts from the engine, with an Ack action (operator+).
export function ProblemsPage() {
  const [rows, setRows] = React.useState(null);
  const [error, setError] = React.useState(null);
  const [busy, setBusy] = React.useState(null);

  const load = React.useCallback(() => {
    getJSON("/api/alerts").then(setRows).catch(setError);
  }, []);
  React.useEffect(load, [load]);

  async function ack(id) {
    setBusy(id);
    try {
      const r = await fetch(`/api/alerts/${id}/ack`, { method: "POST", credentials: "same-origin" });
      if (!r.ok) throw new Error(`ack failed (HTTP ${r.status})`);
      load();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  }

  if (error) return <ErrorMsg error={error} />;
  if (!rows) return <Loading what="alerts" />;

  return (
    <div className="page">
      <h1>Problems</h1>
      <Card kicker={`${rows.length} open alert(s)`}>
        {rows.length === 0 ? (
          <div className="msg">No open alerts.</div>
        ) : (
          <table className="grid">
            <thead>
              <tr><th></th><th>Severity</th><th>Device</th><th>Rule</th><th>Opened</th><th>Ack</th><th></th></tr>
            </thead>
            <tbody>
              {rows.map((a) => (
                <tr key={a.id}>
                  <td><Dot severity={a.severity} /></td>
                  <td style={{ color: sevColor(a.severity), fontWeight: 600 }}>{a.severity}</td>
                  <td>{a.device_name || a.device_id}</td>
                  <td>{a.rule_name}</td>
                  <td className="mono">{a.opened_at}</td>
                  <td>{a.acked_by ? `✓ ${a.acked_by}` : "—"}</td>
                  <td>
                    {!a.acked_by && (
                      <button className="btn" disabled={busy === a.id} onClick={() => ack(a.id)}>
                        {busy === a.id ? "…" : "Ack"}
                      </button>
                    )}
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
