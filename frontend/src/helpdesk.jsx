import React from "react";
import { Card } from "./primitives.jsx";

// Shared Helpdesk UI (docs/spec/25-helpdesk.md): the fetch helper, the status
// hook, and the "Linked Helpdesk Tickets" section that Problem, Issue and
// Change detail views embed. The Tickets workspace (pages/tickets.jsx) uses
// the same pieces from the other side.
//
// Ownership is the thing to keep visible: a ticket's status is Frontline's, a
// record's status is NetMon's, and a link is NetMon's fact about the two.
// Nothing here ever changes one side because the other changed.

// ── fetch ────────────────────────────────────────────────────────────────────

/** Same-origin JSON call that keeps the API's structured error: `.status`,
 *  `.kind` (unavailable | not_found | inaccessible | …) and `.message`. */
export async function hd(method, path, body) {
  let resp;
  try {
    resp = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: { Accept: "application/json",
                 ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    const e = new Error("network error contacting NetMon");
    e.kind = "network";
    throw e;
  }
  if (resp.status === 401) {
    window.location.assign("/login");
    throw new Error("redirecting to sign in");
  }
  let data = null;
  try { data = await resp.json(); } catch { /* empty body */ }
  if (!resp.ok) {
    const d = data?.detail;
    const message = typeof d === "string" ? d
      : d?.message || (Array.isArray(d) ? d.map((x) => x.msg).join("; ") : `HTTP ${resp.status}`);
    const e = new Error(message);
    e.status = resp.status;
    e.kind = d?.kind || null;
    e.data = d;
    throw e;
  }
  return data;
}

// ── status (one fetch per page load) ─────────────────────────────────────────

let _status = null;
let _statusP = null;

export function useHelpdeskStatus() {
  const [s, setS] = React.useState(_status);
  React.useEffect(() => {
    if (_status) return undefined;
    let live = true;
    if (!_statusP) _statusP = hd("GET", "/api/helpdesk/status").catch(() => ({ enabled: false }));
    _statusP.then((r) => { _status = r; if (live) setS(r); });
    return () => { live = false; };
  }, []);
  return s;
}

// ── formatting ───────────────────────────────────────────────────────────────

function parseTs(ts) {
  if (!ts) return NaN;
  const s = String(ts);
  return Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s.replace(" ", "T")}Z`);
}

export function fmtDate(ts) {
  const t = parseTs(ts);
  if (!Number.isFinite(t)) return ts ? String(ts) : "—";
  return new Date(t).toLocaleString([], { year: "numeric", month: "short", day: "numeric",
                                          hour: "2-digit", minute: "2-digit" });
}

export function fmtAge(ts) {
  const t = parseTs(ts);
  if (!Number.isFinite(t)) return "never";
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** Why a ticket can't be shown — four states the operator must not confuse. */
export const TICKET_STATE = {
  ok: null,
  unknown: "Not yet checked against the help desk",
  inaccessible: "The help desk refused access to this ticket — it may still exist",
  not_found: "The help desk has no such ticket (deleted, or outside the integration's visibility)",
};

/** A ticket status chip. Frontline's words, Frontline's colours: neutral. */
export function TicketStatus({ status, active }) {
  if (!status) return <span className="hd-chip dim">status ?</span>;
  return (
    <span className={"hd-chip" + (active === false ? " closed" : "")}
          title="Help desk status (Frontline) — independent of NetMon status">{status}</span>
  );
}

/** A NetMon record status chip, styled distinctly from ticket chips. */
export function RecordStatus({ status }) {
  return <span className="hd-chip nm" title="NetMon status — independent of the ticket">
    NM · {status || "?"}</span>;
}

export const TYPE_LABEL = { problem: "Problem", issue: "Issue", change: "Change" };

// ── modal ────────────────────────────────────────────────────────────────────

export function Modal({ title, onClose, children, wide }) {
  React.useEffect(() => {
    const on = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [onClose]);
  return (
    <div className="hd-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={"hd-modal" + (wide ? " wide" : "")} role="dialog" aria-modal="true" aria-label={title}>
        <div className="drawer-h">
          <h3>{title}</h3>
          <div className="h-spacer" />
          <button type="button" className="btn sm ghost" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="drawer-b">{children}</div>
      </div>
    </div>
  );
}

// ── pick a NetMon record (from a ticket) ─────────────────────────────────────

export function RecordPicker({ recordType, ticket, onLinked, onClose }) {
  const [q, setQ] = React.useState("");
  const [rows, setRows] = React.useState(null);
  const [error, setError] = React.useState(null);
  const [note, setNote] = React.useState("");
  const [busy, setBusy] = React.useState(null);

  React.useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      hd("GET", `/api/helpdesk/candidates?type=${recordType}&q=${encodeURIComponent(q)}`)
        .then((r) => { if (live) { setRows(r); setError(null); } })
        .catch((e) => live && setError(e));
    }, 200);
    return () => { live = false; clearTimeout(t); };
  }, [q, recordType]);

  const link = (rec) => {
    setBusy(rec.id);
    hd("POST", "/api/helpdesk/links",
       { ticket, record_type: recordType, record_id: rec.id, note: note || null })
      .then((l) => onLinked(l))
      .catch((e) => { setError(e); setBusy(null); });
  };

  return (
    <Modal title={`Link ${TYPE_LABEL[recordType].toLowerCase()} to ticket #${ticket}`} onClose={onClose} wide>
      <div className="hd-form-row">
        <input autoFocus type="search" placeholder={`Search ${TYPE_LABEL[recordType].toLowerCase()}s by #, title, site…`}
               value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="hd-form-row">
        <input type="text" maxLength={500} placeholder="Optional note on the link (why they are related)"
               value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
      {error && <div className="hd-err">{error.message}</div>}
      {!rows ? <div className="msg">Searching…</div> : rows.length === 0 ? (
        <div className="msg">No {TYPE_LABEL[recordType].toLowerCase()}s match.</div>
      ) : (
        <table className="tbl hd-pick">
          <thead><tr><th>#</th><th>Title</th><th>Status</th><th>Location</th><th>Updated</th><th /></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="mono">{r.id}</td>
                <td className="fg">{r.title}</td>
                <td><RecordStatus status={r.status} /></td>
                <td>{r.site || "—"}</td>
                <td className="mono">{fmtDate(r.updated)}</td>
                <td><button type="button" className="btn sm primary" disabled={busy !== null}
                            onClick={() => link(r)}>{busy === r.id ? "Linking…" : "Link"}</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Modal>
  );
}

// ── pick a ticket (from a NetMon record) ─────────────────────────────────────

export function TicketPicker({ onPick, onClose, exclude = [] }) {
  const [q, setQ] = React.useState("");
  const [view, setView] = React.useState("active");
  const [data, setData] = React.useState(null);
  const [error, setError] = React.useState(null);

  React.useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      hd("GET", `/api/helpdesk/tickets?view=${view}&limit=25&q=${encodeURIComponent(q)}`)
        .then((r) => { if (live) { setData(r); setError(null); } })
        .catch((e) => live && setError(e));
    }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [q, view]);

  return (
    <Modal title="Find a help desk ticket" onClose={onClose} wide>
      <div className="hd-form-row">
        <div className="seg-toggle">
          {["active", "inactive", "all"].map((v) => (
            <button key={v} type="button" className={"seg-btn" + (view === v ? " active" : "")}
                    onClick={() => setView(v)}>{v[0].toUpperCase() + v.slice(1)}</button>
          ))}
        </div>
        <input autoFocus type="search" placeholder="Ticket #, subject, site…" value={q}
               onChange={(e) => setQ(e.target.value)} style={{ flex: 1 }} />
      </div>
      {error && <div className="hd-err">{error.message}</div>}
      {data?.stale && <div className="hd-warn">Showing the last list fetched {fmtAge(data.fetched_at)} — {data.error?.message}</div>}
      {!data ? <div className="msg">Searching…</div> : data.items.length === 0 ? (
        <div className="msg">No tickets match{data.window_days ? ` in the last ${data.window_days} days` : ""}.</div>
      ) : (
        <table className="tbl hd-pick">
          <thead><tr><th>#</th><th>Subject</th><th>Status</th><th>Site</th><th>Created</th><th /></tr></thead>
          <tbody>
            {data.items.map((t) => (
              <tr key={t.ticket}>
                <td className="mono">{t.ticket}</td>
                <td className="fg">{t.subject || "—"}</td>
                <td><TicketStatus status={t.status} active={t.is_active} /></td>
                <td>{t.site || "—"}</td>
                <td className="mono">{fmtDate(t.created)}</td>
                <td>{exclude.includes(t.ticket)
                  ? <span className="dim">linked</span>
                  : <button type="button" className="btn sm primary" onClick={() => onPick(t.ticket)}>Link</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Modal>
  );
}

// ── "Linked Helpdesk Tickets" on a Problem / Issue / Change ──────────────────

export function LinkedTickets({ recordType, recordId, compact = false }) {
  const st = useHelpdeskStatus();
  const [data, setData] = React.useState(null);
  const [error, setError] = React.useState(null);
  const [num, setNum] = React.useState("");
  const [note, setNote] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState(null);
  const [picking, setPicking] = React.useState(false);
  const [showLog, setShowLog] = React.useState(false);

  const load = React.useCallback(() => {
    hd("GET", `/api/helpdesk/links?record_type=${recordType}&record_id=${recordId}`)
      .then((r) => { setData(r); setError(null); })
      .catch(setError);
  }, [recordType, recordId]);
  React.useEffect(() => { load(); }, [load]);

  if (st && !st.enabled && data && data.links.length === 0) return null;  // nothing to say

  const canLink = Boolean(st?.enabled && st?.can_link);
  const link = (ticket) => {
    setBusy(true); setMsg(null);
    hd("POST", "/api/helpdesk/links",
       { ticket, record_type: recordType, record_id: recordId, note: note || null })
      .then(() => { setNum(""); setNote(""); setPicking(false); load(); })
      .catch((e) => setMsg({ tone: "err", text: e.message }))
      .finally(() => setBusy(false));
  };
  const unlink = (l) => {
    if (!window.confirm(`Unlink ticket #${l.ticket_ref}? The ticket and this ${recordType} are not changed.`)) return;
    hd("DELETE", `/api/helpdesk/links/${l.id}`).then(load).catch((e) => setMsg({ tone: "err", text: e.message }));
  };
  const refresh = (l) => {
    hd("POST", `/api/helpdesk/links/${l.id}/refresh`)
      .then((r) => {
        if (r.error) setMsg({ tone: "warn", text: `#${l.ticket_ref}: ${r.error.message}` });
        load();
      })
      .catch((e) => setMsg({ tone: "err", text: e.message }));
  };

  const links = data?.links || [];
  return (
    <Card title="Linked Helpdesk Tickets" kicker={data ? `${links.length} linked` : null}>
      {error && <div className="hd-err">{error.message}</div>}
      {!data ? <div className="msg">Loading…</div> : links.length === 0 ? (
        <div className="msg">No help desk tickets linked.</div>
      ) : (
        <ul className="hd-linklist">
          {links.map((l) => {
            const t = l.ticket_summary || {};
            const why = TICKET_STATE[t.state];
            return (
              <li key={l.id} className={"hd-link" + (why ? " unresolved" : "")}>
                <div className="hd-link-main">
                  <a className="mono hd-ticketno" href={`#/tickets/${encodeURIComponent(l.ticket_ref)}`}
                     title="Open in NetMon">#{l.ticket_ref}</a>
                  <span className="hd-link-subject">{t.subject || (st?.can_read ? "" : "ticket details need a higher role")}</span>
                  {t.status && <TicketStatus status={t.status} active={t.is_active} />}
                </div>
                <div className="hd-link-meta">
                  {t.site && <span>{t.site}</span>}
                  {t.priority && <span>{t.priority}</span>}
                  {t.fetched_at && <span title={`last answered ${t.fetched_at}`}>seen {fmtAge(t.fetched_at)}</span>}
                  <span title={l.created_at}>linked by {l.created_by}</span>
                  {l.note && <span className="hd-note">“{l.note}”</span>}
                </div>
                {why && <div className="hd-warn">{why}</div>}
                <div className="hd-link-actions">
                  <a className="btn sm" href={`#/tickets/${encodeURIComponent(l.ticket_ref)}`}>Open</a>
                  {t.url && <a className="btn sm" href={t.url} target="_blank" rel="noopener noreferrer">Open in Helpdesk ↗</a>}
                  {st?.enabled && st?.can_read && <button type="button" className="btn sm" onClick={() => refresh(l)}>Refresh</button>}
                  {canLink && <button type="button" className="btn sm btn-warn" onClick={() => unlink(l)}>Unlink</button>}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {msg && <div className={msg.tone === "err" ? "hd-err" : "hd-warn"}>{msg.text}</div>}
      {canLink && (
        <div className="hd-addlink">
          <input type="text" inputMode="numeric" placeholder="Ticket #" value={num}
                 onChange={(e) => setNum(e.target.value)} style={{ width: 110 }}
                 onKeyDown={(e) => { if (e.key === "Enter" && num.trim()) link(num.trim()); }} />
          {!compact && <input type="text" placeholder="Note (optional)" maxLength={500} value={note}
                              onChange={(e) => setNote(e.target.value)} style={{ flex: 1 }} />}
          <button type="button" className="btn sm primary" disabled={busy || !num.trim()}
                  onClick={() => link(num.trim())}>{busy ? "Linking…" : "Link ticket"}</button>
          <button type="button" className="btn sm" onClick={() => setPicking(true)}>Search tickets…</button>
        </div>
      )}
      {st && !st.enabled && links.length > 0 && (
        <div className="dim hd-small">The help desk integration is off — links are shown from NetMon's records only.</div>
      )}
      {data?.events?.length > 0 && (
        <div className="hd-small">
          <button type="button" className="linkish" onClick={() => setShowLog((v) => !v)}>
            {showLog ? "Hide" : "Show"} link history ({data.events.length})
          </button>
          {showLog && (
            <ul className="hd-events">
              {data.events.map((e) => (
                <li key={e.id}><span className="mono">{fmtDate(e.occurred_at)}</span> · {e.actor} {e.action}ed
                  {" "}#{e.ticket_ref}{e.note ? ` — ${e.note}` : ""}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      {picking && <TicketPicker onClose={() => setPicking(false)} onPick={link}
                                exclude={links.map((l) => l.ticket_ref)} />}
    </Card>
  );
}
