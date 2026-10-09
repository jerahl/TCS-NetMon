import React from "react";
import { Loading } from "../primitives.jsx";
import { hd, fmtDate, fmtAge } from "../helpdesk.jsx";
import { HBars, ColBars, shortDate } from "../hdcharts.jsx";

// Helpdesk · Tickets — the Ticket Triage Board (docs/spec/25-helpdesk.md §12).
//
// The open queue grouped by root cause (Frontline's problem-type hierarchy),
// with what moved in the last seven days, the queue's size over eight weeks,
// and a short "do these first" list. Figures come from /api/helpdesk/board
// (netmon/helpdesk_stats.py). Clicking a ticket opens the existing detail +
// properties panes in a drawer, so linking to Problems / Issues / Changes
// works exactly as in the browse view.

const FILTERS = [["all", "All"], ["overdue", "Past SLA"], ["high", "High"], ["open", "Open"],
                 ["prog", "In progress"], ["hold", "On hold"]];
const SCOPE_KEY = "netmon.helpdesk.board.assigned";

function matches(t, f, q) {
  if (f === "overdue" && !t.overdue) return false;
  if (f === "high" && t.prio_rank > 1) return false;
  if (["open", "prog", "hold"].includes(f) && t.status_kind !== f) return false;
  if (q) {
    const hay = [t.ticket, t.subject, t.requester, t.site, t.room, t.assigned_to, t.category]
      .filter(Boolean).join(" ").toLowerCase();
    if (!hay.includes(q.toLowerCase().replace(/^#/, ""))) return false;
  }
  return true;
}

function odClass(t) {
  if (!t.overdue) return "";
  const o = t.over_days || 0;
  return o < 8 ? " od-1" : o < 30 ? " od-2" : " od-3";
}

function StatusPill({ t }) {
  return <span className={`hdb-pill ${t.status_kind}`}><span className="dot" />{t.status || "—"}</span>;
}

function AgeCell({ t }) {
  if (t.overdue) {
    return <div className={"hdb-age " + ((t.over_days || 0) >= 30 ? "od3" : "od")}>
      {t.over_days ? `${t.over_days}d over` : "<1d over"}</div>;
  }
  return <div className="hdb-age ok">{t.age_days == null ? "—" : `${t.age_days}d old`}</div>;
}

function Rows({ items, open }) {
  if (!items.length) return <div className="hdb-empty">No tickets match this filter.</div>;
  return (
    <div className="hdb-rows">
      <div className="hdb-rowhd"><span>Ticket</span><span>Summary</span><span>Requester</span><span>Status</span>
        <span className="r">Age / SLA</span><span className="r">Priority</span></div>
      {items.map((t) => (
        <div key={t.ticket} className={"hdb-row" + odClass(t)} role="button" tabIndex={0}
             onClick={() => open(t.ticket)}
             onKeyDown={(e) => { if (e.key === "Enter") open(t.ticket); }}>
          <span className="mono hdb-tn">{t.ticket}</span>
          <div className="hdb-sm">{t.subject || "(no summary)"}
            <div className="hdb-meta">{[t.site, t.sub, t.assigned_to || "unassigned"].filter(Boolean).join(" · ")}
              {(t.idle_days || 0) >= 7 && <span className="hdb-tag stall">untouched {t.idle_days}d</span>}</div>
          </div>
          <div className="hdb-rq" title={t.requester || ""}>{t.requester || "—"}</div>
          <div className="hdb-pc"><StatusPill t={t} /></div>
          <AgeCell t={t} />
          <div className={`hdb-prio p${t.prio_rank}`}>{t.priority || "—"}</div>
        </div>
      ))}
    </div>
  );
}

function Group({ g, f, q, open }) {
  const shown = g.items.filter((t) => matches(t, f, q));
  const note = [
    `${g.overdue} past SLA` + (g.oldest_over ? ` (oldest ${g.oldest_over}d over)` : ""),
    g.urgent ? `${g.urgent} High/Critical` : null,
    g.stalled ? `${g.stalled} untouched 7d+` : null,
    `+${g.new_7d} new / −${g.closed_7d} closed this week`,
  ].filter(Boolean).join(" · ");
  const count = (
    <div className="hdb-ccount">{shown.length}
      {shown.length !== g.items.length && <small>of {g.items.length}</small>}</div>
  );
  return (
    <details className={"hdb-cluster" + (g.hot ? " hot" : "") + (g.subgroups.length ? " parent" : "")}
             open={shown.length > 0}>
      <summary><div className="hdb-chev" /><div className="hdb-cname">{g.name}</div>{count}
        <div className="hdb-cfix">{note}</div></summary>
      {g.subgroups.length ? (
        <div className="hdb-subgroups">
          {g.subgroups.map((s) => {
            const all = g.items.filter((t) => (t.sub || "General") === s.name);
            const items = all.filter((t) => matches(t, f, q));
            const over = all.filter((t) => t.overdue).length;
            return (
              <details key={s.name} className="hdb-sub" open={items.length > 0}>
                <summary><div className="hdb-chev" /><div className="hdb-cname">{s.name}</div>
                  <div className="hdb-ccount">{items.length}{items.length !== all.length && <small>of {all.length}</small>}</div>
                  <div className="hdb-cfix">{over ? `${over} past SLA` : "none past SLA"}</div></summary>
                <Rows items={items} open={open} />
              </details>
            );
          })}
        </div>
      ) : <Rows items={shown} open={open} />}
    </details>
  );
}

export function TriageBoard({ query, setQuery, openTicket }) {
  const f = query.f || "all";
  const q = query.q || "";
  let saved = "";
  try { saved = localStorage.getItem(SCOPE_KEY) || ""; } catch { /* private mode */ }
  const assigned = query.a !== undefined ? query.a : saved;
  const [data, setData] = React.useState(null);
  const [error, setError] = React.useState(null);
  const [loading, setLoading] = React.useState(false);
  const [qText, setQText] = React.useState(q);

  const load = React.useCallback((refresh = false) => {
    setLoading(true);
    const qs = new URLSearchParams();
    if (assigned) qs.set("assigned", assigned);
    if (refresh) qs.set("refresh", "true");
    hd("GET", `/api/helpdesk/board${qs.toString() ? `?${qs}` : ""}`)
      .then((r) => { setData(r); setError(null); })
      .catch(setError)
      .finally(() => setLoading(false));
  }, [assigned]);
  React.useEffect(() => { load(false); }, [load]);
  React.useEffect(() => {
    const id = setTimeout(() => { if (qText !== q) setQuery({ q: qText || undefined }); }, 250);
    return () => clearTimeout(id);
  }, [qText]); // eslint-disable-line react-hooks/exhaustive-deps

  const setScope = (v) => {
    try { localStorage.setItem(SCOPE_KEY, v); } catch { /* private mode */ }
    setQuery({ a: v });
  };

  if (error && !data) {
    return <div className="hd-banner">Help desk unavailable — {error.message}
      {" "}<button type="button" className="btn sm" onClick={() => load(true)}>Retry</button></div>;
  }
  if (!data) return <Loading what="the ticket queue" />;
  return <BoardView data={data} f={f} q={q} qText={qText} setQText={setQText} assigned={assigned}
                    setScope={setScope} setQuery={setQuery} openTicket={openTicket}
                    loading={loading} onRefresh={() => load(true)} />;
}

/** The board itself, from one /api/helpdesk/board response. */
export function BoardView({ data, f = "all", q = "", qText = "", setQText = () => {}, assigned = "",
                            setScope = () => {}, setQuery = () => {}, openTicket = () => {},
                            loading = false, onRefresh = () => {} }) {

  const t = data.totals, dl = data.delta;
  const scopeName = !assigned ? "everyone"
    : (data.assignees.find((a) => a.value === assigned)?.name || assigned);
  const netWord = dl.net === 0 ? "held steady" : dl.net > 0 ? `grew by ${dl.net}` : `shrank by ${-dl.net}`;
  const slowed = dl.rate_7d < dl.rate_prev_7d;
  const visible = data.groups.reduce((n, g) => n + g.items.filter((x) => matches(x, f, q)).length, 0);

  return (
    <div className="page hdb">
      <header className="hdb-head">
        <div>
          <div className="hdd-eyebrow">Help desk · assigned to {scopeName}</div>
          <h1>{t.active} open, {t.overdue} past SLA.</h1>
          <p className="hdb-lede">In the last seven days the queue {netWord}: {dl.closed_7d} closed, {dl.new_7d} arrived.
            {" "}Closing {dl.rate_7d}/day against {dl.rate_prev_7d}/day the week before.
            {t.urgent_overdue > 0 && <> <b>{t.urgent_overdue} High/Critical ticket{t.urgent_overdue === 1 ? " is" : "s are"} past target.</b></>}
          </p>
        </div>
        <div className="hdd-stamp">
          <label className="hdb-scope">Assigned to{" "}
            <select value={assigned} onChange={(e) => setScope(e.target.value)}>
              <option value="">Everyone ({data.assignees.reduce((n, a) => n + a.count, 0)})</option>
              {data.assignees.map((a) => <option key={a.value} value={a.value}>{a.name} ({a.count})</option>)}
            </select></label>
          <div>Fetched <b>{fmtAge(data.fetched_at)}</b></div>
          <div className="hdb-head-actions">
            <button type="button" className="btn sm" disabled={loading} onClick={onRefresh}>
              {loading ? "Refreshing…" : "Refresh"}</button>
            <a className="btn sm" href="#/tickets?mode=browse">Browse all</a>
            <a className="btn sm" href="#/helpdesk">Dashboard</a>
          </div>
        </div>
      </header>

      {data.stale && <div className="hd-banner">Help desk unreachable — showing the queue from
        {" "}{fmtDate(data.fetched_at)}. {data.error?.message}</div>}

      <section className="hdb-delta">
        <div className="down"><div className="dv">−{dl.closed_7d}</div><div className="dl">Closed in 7 days</div>
          <div className="dn">by resolution date</div></div>
        <div className="up"><div className="dv">+{dl.new_7d}</div><div className="dl">New in 7 days</div>
          <div className="dn">submitted since {shortDate(new Date(Date.parse(data.now) - 7 * 864e5).toISOString())}</div></div>
        <div className={slowed ? "stall" : "down"}><div className="dv">{dl.rate_7d}</div><div className="dl">Tickets closed per day</div>
          <div className="dn">was {dl.rate_prev_7d}/day the week before</div></div>
        <div className="wide"><p>The queue stood at {dl.queue_7d_ago} seven days ago and is {t.active} now
          {dl.net_pct != null && <> ({dl.net_pct > 0 ? "+" : ""}{dl.net_pct}%)</>}. {t.stalled} open ticket{t.stalled === 1 ? " has" : "s have"} not
          been updated in {data.stall_days}+ days.</p></div>
      </section>

      <section className="hdd-tiles">
        <div className="hdd-tile"><div className="val">{t.active}</div><div className="lab">Active tickets — {scopeName}</div>
          <div className="note">{t.open} open · {t.prog} in progress · {t.hold} on hold{t.other ? ` · ${t.other} other` : ""}</div></div>
        <div className={"hdd-tile" + (dl.net > 0 ? " t-warn" : " t-ok")}>
          <div className="val">{dl.net_pct == null ? "—" : `${dl.net_pct > 0 ? "+" : ""}${dl.net_pct}%`}</div>
          <div className="lab">Queue size vs. 7 days ago</div><div className="note">{dl.queue_7d_ago} → {t.active}</div></div>
        <div className={"hdd-tile" + (t.urgent_overdue ? " t-crit" : "")}><div className="val">{t.urgent}</div>
          <div className="lab">High / Critical tickets</div><div className="note">{t.urgent_overdue} past SLA</div></div>
        <div className={"hdd-tile" + (t.overdue ? " t-crit" : " t-ok")}><div className="val">{t.overdue}</div>
          <div className="lab">Past their SLA target date</div>
          <div className="note">{t.max_over != null ? `longest ${t.max_over}d over` : "none overdue"}</div></div>
        <div className={"hdd-tile" + (t.stalled ? " t-warn" : "")}><div className="val">{t.stalled}</div>
          <div className="lab">Untouched {data.stall_days}+ days</div><div className="note">no update in Frontline</div></div>
      </section>

      {data.do_first.length > 0 && (
        <section className="card hdb-today">
          <div className="card-h"><h3>Do these first</h3></div>
          <div className="hdb-acts">
            {data.do_first.map((a, i) => (
              <div className="hdb-act" key={i}>
                <div className="rank">{String(i + 1).padStart(2, "0")}</div>
                <div className="what">{a.title}</div>
                <div className="n mono">{a.refs.length ? a.refs.map((r) => (
                  <a key={r} href="#" onClick={(e) => { e.preventDefault(); openTicket(r); }}>#{r}</a>
                )) : null}</div>
                <div className="why">{a.detail}</div>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="hdd-grid2">
        <div className="card hdd-panel"><div className="card-h"><h3>Queue size, last {data.trend.length} weeks</h3></div>
          <div className="card-b"><div className="hdd-cap">Open tickets at each weekly point, rebuilt from submission and
            resolution dates.</div>
            <ColBars rows={data.trend.map((p, i) => ({ label: shortDate(p.at), value: p.size,
                                                       dim: i !== data.trend.length - 1 }))} /></div></div>
        <div className="card hdd-panel"><div className="card-h"><h3>Where the queue lives</h3></div>
          <div className="card-b"><div className="hdd-cap">Open tickets by problem type; groups with High/Critical
            tickets past SLA are highlighted.</div>
            <HBars rows={data.mix.map((m) => ({ label: m.name, value: m.count, hi: m.hot }))}
                   empty="The queue is empty." /></div></div>
      </section>

      <section className="card hdb-board">
        <div className="card-h hdb-board-h"><h3>The queue by root cause</h3><div className="h-spacer" />
          <div className="seg-toggle" role="group" aria-label="Filter tickets">
            {FILTERS.map(([k, label]) => (
              <button key={k} type="button" className={"seg-btn" + (f === k ? " active" : "")}
                      aria-pressed={f === k} onClick={() => setQuery({ f: k === "all" ? undefined : k })}>{label}</button>
            ))}
          </div>
          <input type="search" placeholder="Search tickets…" aria-label="Search tickets" value={qText}
                 onChange={(e) => setQText(e.target.value)} />
        </div>
        <div className="card-b hdb-clusters">
          {visible === 0 && <div className="hdb-empty">No tickets match this filter.</div>}
          {data.groups.map((g) => <Group key={g.name} g={g} f={f} q={q} open={openTicket} />)}
        </div>
      </section>

      <footer className="hdd-foot">
        <div><b>Past SLA</b> = open with a Frontline SLA target date before now; the left edge of a row deepens at
          8 and 30 days over. <b>Untouched</b> = no update in Frontline for {data.stall_days}+ days.</div>
        <div>Groups are the top level of Frontline's problem type; a group with several sub-types is split.
          Closed counts come from resolution dates of tickets created in the last {data.window_days} days.</div>
      </footer>
    </div>
  );
}
