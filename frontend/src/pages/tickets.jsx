import React from "react";
import { Loading } from "../primitives.jsx";
import {
  hd, useHelpdeskStatus, fmtDate, fmtAge, TicketStatus, RecordStatus, TYPE_LABEL,
  TICKET_STATE, Modal, RecordPicker,
} from "../helpdesk.jsx";

// Helpdesk · Tickets (docs/spec/25-helpdesk.md §3).
//
// The Capacity-style three-pane workspace — list · detail · properties —
// built from NetMon's own stylesheet tokens, inside the existing app shell.
// Tickets come from Frontline through NetMon's adapter; nothing here talks to
// the help desk directly, and nothing here writes to it. Edits, replies and
// uploads are "Open in Helpdesk" until those routes are validated (§9).
//
// Filters live in the URL (#/tickets/4821?view=all&q=wifi), so moving between
// tickets, reloading, or sharing a link keeps the list exactly as it was; the
// list's scroll position is remembered per filter set for the session.

const PAGE = 50;
const VIEWS = [["active", "Active"], ["inactive", "Inactive"], ["all", "All"]];
const FILTER_KEYS = ["view", "q", "status", "priority", "site", "assigned", "days", "sort", "dir", "page"];

function cleanQuery(q) {
  const out = {};
  for (const k of FILTER_KEYS) if (q?.[k]) out[k] = q[k];
  return out;
}

function qstr(obj) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) if (v !== undefined && v !== null && v !== "") p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : "";
}

function scrollKey(f) { return `netmon.tickets.scroll:${qstr({ ...f, page: f.page || "" })}`; }

// ── list pane ────────────────────────────────────────────────────────────────

function FilterSelect({ label, value, onChange, items, fallback }) {
  const opts = items && items.length ? items.map((i) => [i.id, i.name])
    : (fallback || []).map((v) => [v, v]);
  return (
    <label className="hd-filter">
      <span>{label}</span>
      <select value={value || ""} onChange={(e) => onChange(e.target.value)}>
        <option value="">All</option>
        {opts.map(([v, n]) => <option key={v} value={v}>{n}</option>)}
      </select>
    </label>
  );
}

export function TicketRow({ t, active, href }) {
  return (
    <a className={"hd-row" + (active ? " active" : "")} href={href}>
      <div className="hd-row-top">
        <span className="mono hd-ticketno">#{t.ticket}</span>
        <TicketStatus status={t.status} active={t.is_active} />
        {t.priority && <span className="hd-prio">{t.priority}</span>}
      </div>
      <div className="hd-row-subject">{t.subject || <span className="dim">no subject</span>}</div>
      <div className="hd-row-meta">
        <span>{t.site || "no site"}</span>
        <span>{t.assigned_to || "unassigned"}</span>
        <span title={`created ${t.created || "?"}`}>{t.updated ? `upd ${fmtAge(t.updated)}` : t.created ? fmtAge(t.created) : ""}</span>
      </div>
    </a>
  );
}

export function ListPane({ filters, setFilters, activeId, status }) {
  const [data, setData] = React.useState(null);
  const [error, setError] = React.useState(null);
  const [loading, setLoading] = React.useState(false);
  const [lookups, setLookups] = React.useState(null);
  const [qDraft, setQDraft] = React.useState(filters.q || "");
  const scroller = React.useRef(null);
  const restored = React.useRef(null);
  const page = Number(filters.page || 0);

  React.useEffect(() => {
    hd("GET", "/api/helpdesk/lookups").then(setLookups).catch(() => setLookups({}));
  }, []);

  const load = React.useCallback((refresh = false) => {
    setLoading(true);
    const params = { view: filters.view || "active", q: filters.q, status: filters.status,
                     priority: filters.priority, site: filters.site, assigned: filters.assigned,
                     days: filters.days, sort: filters.sort, dir: filters.dir,
                     offset: page * PAGE, limit: PAGE, refresh: refresh ? "true" : "" };
    hd("GET", `/api/helpdesk/tickets${qstr(params)}`)
      .then((r) => { setData(r); setError(null); })
      .catch(setError)
      .finally(() => setLoading(false));
  }, [filters.view, filters.q, filters.status, filters.priority, filters.site, filters.assigned,
      filters.days, filters.sort, filters.dir, page]);

  React.useEffect(() => { load(false); }, [load]);
  React.useEffect(() => { setQDraft(filters.q || ""); }, [filters.q]);

  // Debounced search → URL.
  React.useEffect(() => {
    if ((qDraft || "") === (filters.q || "")) return undefined;
    const t = setTimeout(() => setFilters({ q: qDraft, page: "" }), 300);
    return () => clearTimeout(t);
  }, [qDraft]);   // eslint-disable-line react-hooks/exhaustive-deps

  // Remember and restore the list position for this filter set.
  const key = scrollKey(filters);
  React.useEffect(() => {
    if (!data || !scroller.current || restored.current === key) return;
    restored.current = key;
    try {
      const y = Number(sessionStorage.getItem(key) || 0);
      if (y) scroller.current.scrollTop = y;
    } catch { /* session storage is a convenience */ }
  }, [data, key]);
  const onScroll = (e) => {
    try { sessionStorage.setItem(key, String(e.currentTarget.scrollTop)); } catch { /* ignore */ }
  };

  const items = data?.items || [];
  const distinct = (k) => [...new Set(items.map((t) => t[k]).filter(Boolean))].sort();
  const view = filters.view || "active";
  const from = data ? Math.min(data.total, page * PAGE + 1) : 0;
  const to = data ? Math.min(data.total, page * PAGE + items.length) : 0;

  return (
    <section className="hd-list card">
      <div className="card-h">
        <h3>Tickets</h3>
        <span className="src-badge" title="Source: Frontline Help Desk">HD</span>
        <div className="h-spacer" />
        <button type="button" className="btn sm" disabled={loading} onClick={() => load(true)}
                title="Fetch the list again from the help desk">{loading ? "…" : "⟳"}</button>
      </div>
      <div className="hd-list-tools">
        <div className="seg-toggle">
          {VIEWS.map(([v, l]) => (
            <button key={v} type="button" className={"seg-btn" + (view === v ? " active" : "")}
                    onClick={() => setFilters({ view: v === "active" ? "" : v, page: "" })}>{l}</button>
          ))}
        </div>
        <input type="search" placeholder="Search #, subject, site…" value={qDraft}
               onChange={(e) => setQDraft(e.target.value)} />
        <div className="hd-filters">
          <FilterSelect label="Status" value={filters.status} items={lookups?.statuses?.items}
                        fallback={distinct("status")} onChange={(v) => setFilters({ status: v, page: "" })} />
          <FilterSelect label="Priority" value={filters.priority} items={lookups?.priorities?.items}
                        fallback={distinct("priority")} onChange={(v) => setFilters({ priority: v, page: "" })} />
          <FilterSelect label="Site" value={filters.site} items={lookups?.sites?.items}
                        fallback={distinct("site")} onChange={(v) => setFilters({ site: v, page: "" })} />
          <FilterSelect label="Assigned" value={filters.assigned} items={lookups?.technicians?.items}
                        fallback={distinct("assigned_to")} onChange={(v) => setFilters({ assigned: v, page: "" })} />
          {view !== "active" && (
            <label className="hd-filter">
              <span>Created</span>
              <select value={filters.days || ""} onChange={(e) => setFilters({ days: e.target.value, page: "" })}>
                <option value="">last {status?.window_days || 90} days</option>
                {[7, 30, 90, 180, 365].filter((d) => d <= (status?.max_window_days || 365))
                  .map((d) => <option key={d} value={d}>last {d} days</option>)}
              </select>
            </label>
          )}
          <label className="hd-filter">
            <span>Sort</span>
            <select value={`${filters.sort || "created"}:${filters.dir || "desc"}`}
                    onChange={(e) => { const [s, d] = e.target.value.split(":");
                                       setFilters({ sort: s === "created" ? "" : s, dir: d === "desc" ? "" : d, page: "" }); }}>
              <option value="created:desc">Newest</option>
              <option value="created:asc">Oldest</option>
              <option value="updated:desc">Recently updated</option>
              <option value="ticket:desc">Ticket # ↓</option>
            </select>
          </label>
        </div>
      </div>
      <div className="hd-fresh">
        {data && (
          <span title={data.fetched_at}>
            {data.stale ? <b className="warn">stale · </b> : null}
            fetched {fmtAge(data.fetched_at)}
            {data.window_days ? ` · created in last ${data.window_days}d` : ""}
          </span>
        )}
        {loading && <span> · refreshing…</span>}
      </div>
      {data?.stale && <div className="hd-warn">Help desk unavailable — showing the last list. {data.error?.message}</div>}
      {error && <div className="hd-err">{error.message}</div>}
      <div className="hd-list-scroll" ref={scroller} onScroll={onScroll}>
        {!data && !error && <Loading what="tickets" />}
        {data && items.length === 0 && <div className="msg">No tickets match.</div>}
        {items.map((t) => (
          <TicketRow key={t.ticket} t={t} active={t.ticket === activeId}
                     href={`#/tickets/${encodeURIComponent(t.ticket)}${qstr(filters)}`} />
        ))}
      </div>
      {data && data.total > 0 && (
        <div className="hd-pager">
          <span className="mono">{from}–{to} of {data.total}</span>
          <div className="h-spacer" />
          <button type="button" className="btn sm" disabled={page === 0}
                  onClick={() => setFilters({ page: page > 1 ? String(page - 1) : "" })}>‹ Prev</button>
          <button type="button" className="btn sm" disabled={to >= data.total}
                  onClick={() => setFilters({ page: String(page + 1) })}>Next ›</button>
        </div>
      )}
    </section>
  );
}

// ── detail pane ──────────────────────────────────────────────────────────────

function ActivityList({ path, render, empty }) {
  const [data, setData] = React.useState(null);
  const [error, setError] = React.useState(null);
  React.useEffect(() => {
    let live = true;
    setData(null); setError(null);
    hd("GET", path).then((r) => live && setData(r)).catch((e) => live && setError(e));
    return () => { live = false; };
  }, [path]);
  if (error) {
    // Two different 403s: the help desk refusing NetMon's integration account
    // (kind "inaccessible" — on this instance, comments and field history),
    // and NetMon's own role gate. They need different fixes, so say which.
    if (error.kind === "inaccessible") {
      return <div className="hd-warn">The help desk does not let NetMon's integration account read this
        (Frontline answered 403). Use Open in Helpdesk, or grant the API account access in Frontline.</div>;
    }
    return <div className={error.status === 403 ? "hd-warn" : "hd-err"}>{error.message}</div>;
  }
  if (!data) return <Loading what="activity" />;
  if (!data.items.length) return <div className="msg">{empty}</div>;
  return render(data);
}

function Unsupported({ url, what }) {
  return url ? (
    <a className="btn sm" href={url} target="_blank" rel="noopener noreferrer"
       title={`${what} happens in Frontline Help Desk — NetMon reads tickets but does not change them`}>
      {what} in Helpdesk ↗</a>
  ) : null;
}

/** One fetch of the selected ticket, shared by the detail and properties
 *  panes — selecting a ticket costs the help desk one call, not two. */
function useTicket(id) {
  const [data, setData] = React.useState(null);
  const [error, setError] = React.useState(null);
  const [loading, setLoading] = React.useState(false);
  const load = React.useCallback((refresh = false) => {
    if (!id) return;
    setLoading(true);
    hd("GET", `/api/helpdesk/tickets/${encodeURIComponent(id)}${refresh ? "?refresh=true" : ""}`)
      .then((r) => { setData(r); setError(null); })
      .catch(setError)
      .finally(() => setLoading(false));
  }, [id]);
  React.useEffect(() => { setData(null); setError(null); load(false); }, [load]);
  return { data, error, loading, load };
}

export function DetailPane({ id, status, det, onBack, onProps }) {
  const { data, error, loading, load } = det;
  const [tab, setTab] = React.useState("description");

  const t = data?.ticket;
  const canDetail = status?.can_read_detail;
  const back = <button type="button" className="btn sm hd-back" onClick={onBack}>‹ Tickets</button>;

  if (error) {
    const why = error.kind === "not_found" ? TICKET_STATE.not_found
      : error.kind === "inaccessible" ? TICKET_STATE.inaccessible
      : `Help desk unavailable — ${error.message}`;
    return (
      <section className="hd-detail card">
        <div className="card-h">{back}<h3>Ticket #{id}</h3><div className="h-spacer" />
          <button type="button" className="btn sm" onClick={() => load(true)}>Retry</button>
          <button type="button" className="btn sm hd-props-btn" onClick={onProps}>Properties</button></div>
        <div className="card-b"><div className={error.kind === "unavailable" ? "hd-err" : "hd-warn"}>{why}</div>
          <div className="dim hd-small">Links to NetMon records still load from NetMon — see Properties.</div></div>
      </section>
    );
  }
  if (!t) return <section className="hd-detail card"><div className="card-b"><Loading what={`ticket #${id}`} /></div></section>;

  const tabs = [["description", "Description"], ["comments", "Comments"], ["history", "History"],
                ["attachments", "Attachments"]];
  const base = `/api/helpdesk/tickets/${encodeURIComponent(t.ticket)}`;
  return (
    <section className="hd-detail card">
      <div className="card-h hd-detail-h">
        {back}
        <span className="mono hd-ticketno">#{t.ticket}</span>
        <TicketStatus status={t.status} active={t.is_active} />
        {t.priority && <span className="hd-prio">{t.priority}</span>}
        <div className="h-spacer" />
        <span className="h-meta" title={data.fetched_at}>
          {loading ? "refreshing…" : `fetched ${fmtAge(data.fetched_at)}`}{data.source === "list" ? " · from list" : ""}
        </span>
        <button type="button" className="btn sm" disabled={loading} onClick={() => load(true)}>Refresh</button>
        {data.url && <a className="btn sm" href={data.url} target="_blank" rel="noopener noreferrer">Open in Helpdesk ↗</a>}
        <button type="button" className="btn sm hd-props-btn" onClick={onProps}>Properties</button>
      </div>
      <div className="hd-subject">{t.subject || <span className="dim">no subject</span>}</div>
      <div className="hd-subline">
        {t.site || "no site"}{t.room ? ` · ${t.room}` : ""} · created {fmtDate(t.created)}
        {t.updated ? ` · updated ${fmtAge(t.updated)}` : ""}
      </div>
      <div className="tabs hd-tabs" role="tablist">
        {tabs.map(([k, l]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k}
                  className={"tab" + (tab === k ? " active" : "")} onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>
      <div className="card-b hd-detail-body">
        {tab === "description" && (
          data.source === "list"
            ? <div className="hd-warn">The detail route did not answer on this help desk build; showing list fields only.</div>
            : <div className="hd-body">{t.description || <span className="dim">No description.</span>}</div>
        )}
        {tab !== "description" && !canDetail && (
          <div className="hd-warn">Comments, history and attachments may hold private notes and are limited
            to the {`'${status?.detail_role || "admin"}'`} role. {data.url ? "Open the ticket in the help desk instead." : ""}</div>
        )}
        {tab === "comments" && canDetail && (
          <ActivityList path={`${base}/comments`} empty="No comments." render={(d) => (
            <>
              {!d.visibility_known && (
                <div className="hd-warn">The help desk did not say which comments are private. Treat every
                  comment here as internal; do not paste them to requesters.</div>
              )}
              <ul className="hd-thread">
                {d.items.map((c, i) => (
                  <li key={c.id || i}>
                    <div className="hd-thread-h">
                      <b>{c.author || "unknown"}</b>
                      {c.private === true && <span className="hd-chip">private</span>}
                      <span className="dim mono">{fmtDate(c.created)}</span>
                    </div>
                    <div className="hd-body">{c.body || <span className="dim">(empty)</span>}</div>
                  </li>
                ))}
              </ul>
            </>
          )} />
        )}
        {tab === "history" && canDetail && (
          <ActivityList path={`${base}/history`} empty="No field history." render={(d) => (
            <table className="tbl">
              <thead><tr><th>When</th><th>Field</th><th>From</th><th>To</th><th>By</th></tr></thead>
              <tbody>{d.items.map((h, i) => (
                <tr key={i}><td className="mono">{fmtDate(h.at)}</td><td>{h.field || "—"}</td>
                  <td className="dim">{h.old || "—"}</td><td className="fg">{h.new || "—"}</td><td>{h.by || "—"}</td></tr>
              ))}</tbody>
            </table>
          )} />
        )}
        {tab === "attachments" && canDetail && (
          <ActivityList path={`${base}/attachments`} empty="No attachments." render={(d) => (
            <>
              <table className="tbl">
                <thead><tr><th>File</th><th>Size</th><th>Added</th></tr></thead>
                <tbody>{d.items.map((a, i) => (
                  <tr key={a.id || i}><td className="fg">{a.filename || "—"}</td>
                    <td className="mono">{a.size != null ? `${Math.ceil(a.size / 1024)} KB` : "—"}</td>
                    <td className="mono">{fmtDate(a.created)}</td></tr>
                ))}</tbody>
              </table>
              <div className="dim hd-small">Downloads open in the help desk — NetMon does not proxy attachment files.</div>
            </>
          )} />
        )}
        <div className="hd-unsupported">
          <span className="dim">Reply, edit, status and upload happen in Frontline Help Desk.</span>
          <Unsupported url={data.url} what="Reply" />
          <Unsupported url={data.url} what="Edit" />
        </div>
      </div>
    </section>
  );
}

// ── properties pane ──────────────────────────────────────────────────────────

export function CreateFromTicket({ type, ticket, onClose, onLinked }) {
  const prefix = `HD #${ticket.ticket}`;
  const ctx = [`Help desk ticket #${ticket.ticket}${ticket.subject ? ` — ${ticket.subject}` : ""}`,
               ticket.site && `Site: ${ticket.site}${ticket.room ? ` · ${ticket.room}` : ""}`,
               ticket.category && `Category: ${ticket.category}`].filter(Boolean).join("\n");
  const [form, setForm] = React.useState(type === "issue"
    ? { title: `${prefix}: ${ticket.subject || ""}`.slice(0, 200), body: ctx, severity: "warn",
        category: "other", site: ticket.site || "" }
    : { title: `${prefix}: ${ticket.subject || ""}`.slice(0, 200), what: "", why: ctx, expected: "",
        site: ticket.site || "", risk: "low" });
  const [busy, setBusy] = React.useState(false);
  const [created, setCreated] = React.useState(null);    // record id once it exists
  const [error, setError] = React.useState(null);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const linkIt = (id) => hd("POST", "/api/helpdesk/links",
    { ticket: ticket.ticket, record_type: type, record_id: id, note: "created from ticket" })
    .then((l) => onLinked(l))
    .catch((e) => setError({ link: true, message: e.message }));

  const submit = () => {
    setBusy(true); setError(null);
    const body = { ...form, site: form.site || null };
    hd("POST", type === "issue" ? "/api/issues" : "/api/changes", body)
      .then((r) => { setCreated(r.id); return linkIt(r.id); })
      .catch((e) => setError({ message: e.message }))
      .finally(() => setBusy(false));
  };
  const retry = () => { setBusy(true); setError(null); linkIt(created).finally(() => setBusy(false)); };

  return (
    <Modal title={`Create ${TYPE_LABEL[type].toLowerCase()} from ticket #${ticket.ticket}`} onClose={onClose} wide>
      <div className="dim hd-small">Prefilled from the ticket's number, subject, site and category only — the
        description, requester, comments and attachments are not copied. Review before saving.</div>
      <div className="hd-form">
        <label>Title<input value={form.title} maxLength={200} onChange={set("title")} disabled={!!created} /></label>
        {type === "issue" ? (
          <>
            <label>Description<textarea rows={5} value={form.body} onChange={set("body")} disabled={!!created} /></label>
            <label>Severity<select value={form.severity} onChange={set("severity")} disabled={!!created}>
              <option value="crit">crit</option><option value="warn">warn</option><option value="info">info</option></select></label>
          </>
        ) : (
          <>
            <label>What will change<textarea rows={3} value={form.what} onChange={set("what")} disabled={!!created} /></label>
            <label>Why<textarea rows={3} value={form.why} onChange={set("why")} disabled={!!created} /></label>
            <label>Expected outcome<textarea rows={2} value={form.expected} onChange={set("expected")} disabled={!!created} /></label>
          </>
        )}
        <label>Site<input value={form.site} onChange={set("site")} disabled={!!created} /></label>
      </div>
      {error && <div className="hd-err">{error.link
        ? <>Created {type} #{created}, but linking it failed: {error.message}</> : error.message}</div>}
      <div className="hd-form-actions">
        {created ? (
          <>
            <a className="btn sm" href={`#/${type}s/${created}`}>Open {type} #{created}</a>
            {error?.link && <button type="button" className="btn sm primary" disabled={busy} onClick={retry}>
              Retry link</button>}
          </>
        ) : (
          <button type="button" className="btn sm primary" disabled={busy || form.title.trim().length < 3
            || (type === "change" && (!form.what.trim() || !form.why.trim() || !form.expected.trim()))}
                  onClick={submit}>{busy ? "Saving…" : `Create ${type} and link`}</button>
        )}
        <button type="button" className="btn sm" onClick={onClose}>{created ? "Close" : "Cancel"}</button>
      </div>
    </Modal>
  );
}

export function RecordGroup({ type, links, canLink, onLink, onCreate, onUnlink }) {
  return (
    <div className="hd-group">
      <div className="hd-group-h">
        <h4>Linked {TYPE_LABEL[type]}s</h4>
        <span className="dim">{links.length}</span>
      </div>
      {links.length === 0 ? <div className="dim hd-small">None.</div> : (
        <ul className="hd-reclist">
          {links.map((l) => (
            <li key={l.id}>
              {l.record ? (
                <>
                  <a href={l.record.href}><span className="mono">#{l.record.id}</span> {l.record.title}</a>
                  <div className="hd-rec-meta"><RecordStatus status={l.record.status} />
                    {l.record.site && <span>{l.record.site}</span>}
                    <span title={l.created_at}>by {l.created_by}</span></div>
                  {l.note && <div className="hd-note">“{l.note}”</div>}
                </>
              ) : (
                <div className="hd-warn">{TYPE_LABEL[type]} #{l.record_id} no longer exists in NetMon — the link is kept for the record.</div>
              )}
              {canLink && <button type="button" className="linkish" onClick={() => onUnlink(l)}>unlink</button>}
            </li>
          ))}
        </ul>
      )}
      {canLink && (
        <div className="hd-group-actions">
          <button type="button" className="btn sm" onClick={onLink}>Link existing</button>
          {onCreate && <button type="button" className="btn sm" onClick={onCreate}>Create {type}</button>}
        </div>
      )}
      {canLink && type === "problem" && (
        <div className="dim hd-small">Problems are raised by NetMon's alert engine, not by hand — link an existing one.</div>
      )}
    </div>
  );
}

export function PropsPane({ id, status, ticket, open, onClose }) {
  const [links, setLinks] = React.useState(null);
  const [error, setError] = React.useState(null);
  const [picker, setPicker] = React.useState(null);
  const [creating, setCreating] = React.useState(null);

  const load = React.useCallback(() => {
    hd("GET", `/api/helpdesk/links?ticket=${encodeURIComponent(id)}`)
      .then((r) => { setLinks(r.links); setError(null); })
      .catch(setError);
  }, [id]);
  React.useEffect(() => { setLinks(null); load(); }, [load]);

  const canLink = Boolean(status?.can_link);
  const unlink = (l) => {
    if (!window.confirm(`Unlink ${l.record_type} #${l.record_id} from ticket #${id}? Neither record is changed.`)) return;
    hd("DELETE", `/api/helpdesk/links/${l.id}`).then(load).catch(setError);
  };
  const by = (type) => (links || []).filter((l) => l.record_type === type);
  const kv = ticket ? [
    ["Status", ticket.status], ["Priority", ticket.priority], ["Site", ticket.site], ["Room", ticket.room],
    ["Category", ticket.category], ["Assigned", ticket.assigned_to || "unassigned"],
    ["Created", fmtDate(ticket.created)], ["Updated", ticket.updated && fmtDate(ticket.updated)],
    ["Due (SLA)", ticket.due && fmtDate(ticket.due)], ["Closed", ticket.closed && fmtDate(ticket.closed)],
  ].filter(([, v]) => v) : [];

  return (
    <aside className={"hd-props card" + (open ? " open" : "")}>
      <div className="card-h"><h3>Properties</h3><div className="h-spacer" />
        <button type="button" className="btn sm ghost hd-props-close" onClick={onClose} aria-label="Close">✕</button></div>
      <div className="card-b">
        {ticket && (
          <div className="kv hd-kv">
            {kv.map(([k, v]) => (
              <React.Fragment key={k}><div className="k">{k}</div><div className="v">{v}</div><div className="b" /></React.Fragment>
            ))}
          </div>
        )}
        <div className="hd-related-h">Related NetMon records
          <span className="dim hd-small"> · statuses are independent of the ticket</span></div>
        {error && <div className="hd-err">{error.message}</div>}
        {!links ? <Loading what="links" /> : (
          <>
            <RecordGroup type="problem" links={by("problem")} canLink={canLink}
                         onLink={() => setPicker("problem")} onUnlink={unlink} />
            <RecordGroup type="issue" links={by("issue")} canLink={canLink}
                         onLink={() => setPicker("issue")} onUnlink={unlink}
                         onCreate={ticket ? () => setCreating("issue") : null} />
            <RecordGroup type="change" links={by("change")} canLink={canLink}
                         onLink={() => setPicker("change")} onUnlink={unlink}
                         onCreate={ticket ? () => setCreating("change") : null} />
          </>
        )}
      </div>
      {picker && <RecordPicker recordType={picker} ticket={id} onClose={() => setPicker(null)}
                               onLinked={() => { setPicker(null); load(); }} />}
      {creating && ticket && <CreateFromTicket type={creating} ticket={ticket}
                                               onClose={() => { setCreating(null); load(); }}
                                               onLinked={() => { setCreating(null); load(); }} />}
    </aside>
  );
}

// ── page ─────────────────────────────────────────────────────────────────────

export function TicketsPage({ id, query }) {
  const status = useHelpdeskStatus();
  const [propsOpen, setPropsOpen] = React.useState(false);
  const filters = cleanQuery(query);
  const activeId = id ? decodeURIComponent(id) : null;
  const det = useTicket(status?.enabled && status?.can_read ? activeId : null);

  const setFilters = React.useCallback((patch) => {
    const next = { ...cleanQuery(query), ...patch };
    const path = activeId ? `#/tickets/${encodeURIComponent(activeId)}` : "#/tickets";
    location.replace(path + qstr(cleanQuery(next)));
  }, [query, activeId]);

  if (!status) return <Loading what="help desk" />;
  if (!status.enabled) {
    return (
      <div className="page">
        <h1>Tickets</h1>
        <div className="msg">The Frontline Help Desk integration is not enabled. Problems, Issues and Changes
          work as usual; existing ticket links still show on them. An administrator enables it under
          <span className="mono"> [helpdesk]</span> in netmon.conf with credentials in /etc/netmon/netmon.env.</div>
      </div>
    );
  }
  if (!status.can_read) {
    return <div className="page"><h1>Tickets</h1>
      <div className="msg">Help desk tickets need the '{status.min_role || "operator"}' role or higher.</div></div>;
  }

  const h = status.health || {};
  return (
    <div className="hd-page">
      {(!h.configured || !h.available) && (
        <div className="hd-banner">
          {!h.configured ? "Help desk credentials are not set (HD_API_KEY / HD_API_PASSPHRASE) — tickets cannot load."
            : `Help desk unavailable${h.backoff_s ? ` — retrying in ${h.backoff_s}s` : ""}. ${h.last_error || ""}`}
          {h.last_ok && <span className="dim"> Last successful contact {fmtAge(h.last_ok)}.</span>}
          {" "}Problems, Issues, Changes and existing links are unaffected.
        </div>
      )}
      <div className={"hd-ws" + (activeId ? " has-selection" : "")}>
        <ListPane filters={filters} setFilters={setFilters} activeId={activeId} status={status} />
        {activeId ? (
          <>
            <DetailPane id={activeId} status={status} det={det}
                        onBack={() => { location.hash = `#/tickets${qstr(filters)}`; }}
                        onProps={() => setPropsOpen(true)} />
            <PropsPane id={activeId} status={status} ticket={det.data?.ticket || null}
                       open={propsOpen} onClose={() => setPropsOpen(false)} />
            {propsOpen && <div className="hd-scrim" onClick={() => setPropsOpen(false)} />}
          </>
        ) : (
          <section className="hd-detail card hd-empty">
            <div className="msg">Select a ticket to see its detail, activity and related NetMon records.</div>
          </section>
        )}
      </div>
    </div>
  );
}
