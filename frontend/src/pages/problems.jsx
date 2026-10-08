import React from "react";
import { getJSON, postJSON } from "../api.js";
import { Card, Dot, Loading, ErrorMsg, SevText } from "../primitives.jsx";
import { SEV_RANK } from "../severity.js";
import { hd, LinkedTickets, RecordStatus, fmtDate } from "../helpdesk.jsx";

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

// Filter dropdown, matching the Events console (evt-filter styling). Options
// are derived from the loaded open set, so the choices are always self-
// consistent with what's on screen and need no extra round-trip.
function Select({ label, value, onChange, options }) {
  return (
    <label className="evt-filter">
      <span>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">All</option>
        {options.map((o) => (
          <option key={o} value={o}>{o}</option>
        ))}
      </select>
    </label>
  );
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

// A problem's detail drawer (spec 25 §7): what the alert is, and which help
// desk tickets NetMon links to it. Reachable as #/problems/{id}, including for
// a problem that has since closed (it is no longer in the open list, so its
// summary comes from the links endpoint, which resolves any alert id).
function ProblemDrawer({ id, row, onClose }) {
  const [rec, setRec] = React.useState(null);
  React.useEffect(() => {
    let live = true;
    hd("GET", `/api/helpdesk/links?record_type=problem&record_id=${id}`)
      .then((r) => live && setRec(r.record || false)).catch(() => live && setRec(false));
    return () => { live = false; };
  }, [id]);
  return (
    <div className="evt-drawer open" role="dialog" aria-label={`Problem ${id}`}>
      <div className="drawer-h">
        <h3>Problem #{id}</h3>
        <div className="h-spacer" />
        <button type="button" className="btn sm ghost" onClick={onClose} aria-label="Close">✕</button>
      </div>
      <div className="drawer-b">
        {rec === false && !row ? <div className="msg">Problem #{id} does not exist.</div> : (
          <div className="drawer-section">
            <div className="drawer-trigger">{row ? `${row.rule_name} — ${row.device_name || row.device_id}` : rec?.title || "…"}</div>
            <div className="hd-rec-meta">
              {row ? <><Dot severity={row.severity} /> <SevText severity={row.severity} /></> : rec && <RecordStatus status={rec.status} />}
              {(row?.site || rec?.site) && <span>{row?.site || rec?.site}</span>}
              <span>opened {fmtDate(row?.opened_at || rec?.created)}</span>
              {row?.acked_by && <span>acked by {row.acked_by}</span>}
              {row?.assigned_to && <span>owner {row.assigned_to}</span>}
            </div>
          </div>
        )}
        {(row || rec) && <LinkedTickets recordType="problem" recordId={Number(id)} compact />}
      </div>
    </div>
  );
}

export function ProblemsPage({ id }) {
  const [rows, setRows] = React.useState(null);
  const [error, setError] = React.useState(null);
  const [busy, setBusy] = React.useState(null);
  // Default: worst-first, matching the server's newest-open tie-break.
  const [sort, setSort] = React.useState({ key: "severity", dir: "desc" });
  const [filters, setFilters] = React.useState({ site: "", device_type: "" });
  const setFilter = (k) => (v) => setFilters((f) => ({ ...f, [k]: v }));

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

  // Filter options come from the loaded open set — self-consistent with what's
  // on screen, no extra round-trip.
  const siteOpts = [...new Set(rows.map((a) => a.site).filter(Boolean))].sort();
  const typeOpts = [...new Set(rows.map((a) => a.device_type).filter(Boolean))].sort();
  const shown = sortRows(
    rows.filter((a) =>
      (!filters.site || a.site === filters.site) &&
      (!filters.device_type || a.device_type === filters.device_type)),
    sort.key, sort.dir);
  const filtered = shown.length !== rows.length;

  return (
    <div className="page">
      <h1>Problems</h1>
      <div className="subtitle">Open alerts · refreshes every {REFRESH_MS / 1000}s</div>

      <div className="evt-filters">
        <Select label="Location" value={filters.site} onChange={setFilter("site")} options={siteOpts} />
        <Select label="Type" value={filters.device_type} onChange={setFilter("device_type")} options={typeOpts} />
      </div>

      <Card kicker={filtered
        ? `${shown.length} of ${rows.length} open alert(s)`
        : `${rows.length} open alert(s)`}>
        {rows.length === 0 ? (
          <div className="msg">No open alerts.</div>
        ) : shown.length === 0 ? (
          <div className="msg">No open alerts match these filters.</div>
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
              {shown.map((a) => (
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
                    <a className="btn" href={`#/problems/${a.id}`} title="Details and linked help desk tickets">Details</a>
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
      {id && <ProblemDrawer id={id} row={rows.find((a) => String(a.id) === String(id))}
                            onClose={() => { location.hash = "#/problems"; }} />}
    </div>
  );
}
