import React from "react";
import { getJSON, postJSON } from "../api.js";
import { Card, Dot, Loading, ErrorMsg, SevText } from "../primitives.jsx";
import { SEV_RANK } from "../severity.js";

// Problems — open alerts from the engine with the three NetMon-native actions
// (spec 10 §2): Ack, Assign, Suppress-1h. These act on the alert lifecycle;
// the raw transition feed lives on the Events Console. Operator role required
// for the actions (the API enforces it; a viewer just sees 403 surfaced).

const REFRESH_MS = 30000;

// Sortable columns. Each key extracts the comparable value from an alert row;
// severity sorts by its rank (crit → ok), the rest lexically. Location and
// device type are the operator asks — group a fault to its site / its kind.
const SORTS = {
  severity: (a) => SEV_RANK[a.severity] ?? -1,
  site: (a) => (a.site || "").toLowerCase(),
  device_type: (a) => (a.device_type || "").toLowerCase(),
  device_name: (a) => (a.device_name || String(a.device_id) || "").toLowerCase(),
  rule_name: (a) => (a.rule_name || "").toLowerCase(),
  opened_at: (a) => a.opened_at || "",
};

function sortRows(rows, key, dir) {
  const get = SORTS[key];
  if (!get) return rows;
  const mul = dir === "asc" ? 1 : -1;
  // Stable tie-break: newest-opened first, so equal locations/types keep a
  // sensible, deterministic order.
  return [...rows].sort((a, b) => {
    const va = get(a), vb = get(b);
    if (va < vb) return -1 * mul;
    if (va > vb) return 1 * mul;
    return (b.opened_at || "").localeCompare(a.opened_at || "");
  });
}

function SortHeader({ label, col, sort, setSort }) {
  const active = sort.key === col;
  const arrow = active ? (sort.dir === "asc" ? " ▲" : " ▼") : "";
  const toggle = () =>
    setSort(active ? { key: col, dir: sort.dir === "asc" ? "desc" : "asc" }
                   : { key: col, dir: col === "severity" || col === "opened_at" ? "desc" : "asc" });
  return (
    <th className="sortable" aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
        onClick={toggle} title={`Sort by ${label.toLowerCase()}`}>
      {label}{arrow}
    </th>
  );
}

export function ProblemsPage() {
  const [rows, setRows] = React.useState(null);
  const [error, setError] = React.useState(null);
  const [busy, setBusy] = React.useState(null);
  // Default: worst-first, matching the server's newest-open tie-break.
  const [sort, setSort] = React.useState({ key: "severity", dir: "desc" });

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
                <th></th>
                <SortHeader label="Severity" col="severity" sort={sort} setSort={setSort} />
                <SortHeader label="Device" col="device_name" sort={sort} setSort={setSort} />
                <SortHeader label="Location" col="site" sort={sort} setSort={setSort} />
                <SortHeader label="Type" col="device_type" sort={sort} setSort={setSort} />
                <SortHeader label="Rule" col="rule_name" sort={sort} setSort={setSort} />
                <SortHeader label="Opened" col="opened_at" sort={sort} setSort={setSort} />
                <th>Owner</th><th>Ack</th><th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {sortRows(rows, sort.key, sort.dir).map((a) => (
                <tr key={a.id}>
                  <td><Dot severity={a.severity} /></td>
                  <td><SevText severity={a.severity} /></td>
                  <td>{a.device_name || a.device_id}</td>
                  <td>{a.site || <span className="dim">—</span>}</td>
                  <td className="dim">{a.device_type || "—"}</td>
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
