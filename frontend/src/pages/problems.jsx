import React from "react";
import { getJSON, postJSON } from "../api.js";
import { Card, Dot, Loading, ErrorMsg, SevText } from "../primitives.jsx";

// Problems — open alerts from the engine with the three NetMon-native actions
// (spec 10 §2): Ack, Assign, Suppress-1h. These act on the alert lifecycle;
// the raw transition feed lives on the Events Console. Operator role required
// for the actions (the API enforces it; a viewer just sees 403 surfaced).

const REFRESH_MS = 30000;

export function ProblemsPage() {
  const [rows, setRows] = React.useState(null);
  const [error, setError] = React.useState(null);
  const [busy, setBusy] = React.useState(null);

  const load = React.useCallback(() => {
    getJSON("/api/alerts").then((r) => { setRows(r); setError(null); }).catch(setError);
  }, []);

  React.useEffect(() => {
    load();
    const id = setInterval(load, REFRESH_MS);
    return () => clearInterval(id);
  }, [load]);

  async function act(id, fn) {
    setBusy(id);
    try {
      await fn();
      load();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  }

  const ack = (id) => act(id, () => postJSON(`/api/alerts/${id}/ack`));
  const suppress = (id) => act(id, () => postJSON(`/api/alerts/${id}/suppress`));
  const assign = (id) => {
    const who = window.prompt("Assign to (leave blank to clear):", "");
    if (who === null) return; // cancelled
    return act(id, () => postJSON(`/api/alerts/${id}/assign`, { assignee: who }));
  };

  if (error) return <ErrorMsg error={error} />;
  if (!rows) return <Loading what="alerts" />;

  return (
    <div className="page">
      <h1>Problems</h1>
      <div className="subtitle">Open alerts · refreshes every {REFRESH_MS / 1000}s</div>
      <Card kicker={`${rows.length} open alert(s)`}>
        {rows.length === 0 ? (
          <div className="msg">No open alerts.</div>
        ) : (
          <table className="grid">
            <thead>
              <tr>
                <th></th><th>Severity</th><th>Device</th><th>Rule</th><th>Opened</th>
                <th>Owner</th><th>Ack</th><th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => (
                <tr key={a.id}>
                  <td><Dot severity={a.severity} /></td>
                  <td><SevText severity={a.severity} /></td>
                  <td>{a.device_name || a.device_id}</td>
                  <td>{a.rule_name}</td>
                  <td className="mono dim">{a.opened_at}</td>
                  <td>{a.assigned_to || <span className="dim">—</span>}</td>
                  <td>{a.acked_by ? `✓ ${a.acked_by}` : <span className="dim">—</span>}</td>
                  <td className="evt-actions">
                    {!a.acked_by && (
                      <button className="btn" disabled={busy === a.id} onClick={() => ack(a.id)}>Ack</button>
                    )}
                    <button className="btn" disabled={busy === a.id} onClick={() => assign(a.id)}>Assign</button>
                    <button className="btn" disabled={busy === a.id} onClick={() => suppress(a.id)}
                            title="Suppress notifications for 1 hour (maintenance window)">Suppress 1h</button>
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
