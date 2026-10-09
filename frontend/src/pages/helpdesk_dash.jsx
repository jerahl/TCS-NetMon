import React from "react";
import { Loading } from "../primitives.jsx";
import { hd, useHelpdeskStatus, fmtDate, fmtAge } from "../helpdesk.jsx";
import { LineChart, HBars, ColBars, shortDate } from "../hdcharts.jsx";

// Helpdesk · Dashboard (docs/spec/25-helpdesk.md §12).
//
// The IT Help-Desk Status Digest, live: scorecard, urgent flags, this week,
// backlog breakdowns, month-to-date against the same days of last month, the
// school-year trend and rule-based suggested actions. Every figure is computed
// server-side (netmon/helpdesk_stats.py) from the same two export pulls the
// Tickets board uses; nothing here talks to Frontline directly.

const C_NEW = "var(--accent)";
const C_CLOSED = "var(--ok)";

function pct(v) { return v == null ? "—" : `${v}%`; }
function signed(v, unit = "") { return v == null ? "—" : `${v > 0 ? "+" : ""}${v}${unit}`; }
function weekday(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
}

export function TicketRef({ n }) {
  return <a className="mono hdd-ref" href={`#/tickets/${encodeURIComponent(n)}`}>#{n}</a>;
}

function Tile({ value, label, note, tone }) {
  return (
    <div className={"hdd-tile" + (tone ? ` t-${tone}` : "")}>
      <div className="val">{value}</div>
      <div className="lab">{label}</div>
      {note && <div className="note">{note}</div>}
    </div>
  );
}

function Panel({ title, sub, children, className = "" }) {
  return (
    <section className={"card hdd-panel " + className}>
      <div className="card-h"><h3>{title}</h3></div>
      <div className="card-b">
        {sub && <div className="hdd-cap">{sub}</div>}
        {children}
      </div>
    </section>
  );
}

function Table({ head, rows, num = [] }) {
  return (
    <table className="hdd-table">
      <thead><tr>{head.map((h, i) => <th key={i} className={num.includes(i) ? "n" : ""}>{h}</th>)}</tr></thead>
      <tbody>{rows.map((r, i) => (
        <tr key={i} className={r.cls || ""}>
          {r.cells.map((c, j) => <td key={j} className={num.includes(j) ? "n" : ""}>{c}</td>)}
        </tr>
      ))}</tbody>
    </table>
  );
}

export function HelpdeskDashboard() {
  const status = useHelpdeskStatus();
  const [data, setData] = React.useState(null);
  const [error, setError] = React.useState(null);
  const [loading, setLoading] = React.useState(false);
  const ok = status?.enabled && status?.can_read;

  const load = React.useCallback((refresh = false) => {
    setLoading(true);
    hd("GET", `/api/helpdesk/dashboard${refresh ? "?refresh=true" : ""}`)
      .then((r) => { setData(r); setError(null); })
      .catch(setError)
      .finally(() => setLoading(false));
  }, []);
  React.useEffect(() => { if (ok) load(false); }, [ok, load]);

  if (!status) return <Loading what="help desk" />;
  if (!status.enabled) {
    return <div className="page"><h1>Help desk</h1>
      <div className="msg">The Frontline Help Desk integration is not enabled.</div></div>;
  }
  if (!status.can_read) {
    return <div className="page"><h1>Help desk</h1>
      <div className="msg">Help desk figures need the '{status.min_role || "operator"}' role or higher.</div></div>;
  }
  if (error && !data) {
    return <div className="page"><h1>Help desk status</h1>
      <div className="hd-banner">Help desk unavailable — {error.message}
        <button type="button" className="btn sm" onClick={() => load(true)}>Retry</button></div></div>;
  }
  if (!data) return <Loading what="help desk figures" />;
  return <DashboardView data={data} loading={loading} onRefresh={() => load(true)} />;
}

/** The dashboard itself, from one /api/helpdesk/dashboard response. */
export function DashboardView({ data, loading = false, onRefresh = () => {} }) {

  const t = data.totals, w = data.week, m = data.mtd, p = data.prior;
  const urgentN = t.urgent_overdue;
  const prioOver = data.overdue_by_priority.map((r) => `${r.name} ${r.count}`).join(", ");
  const sitesOver = data.overdue_by_site.map((r) => `${r.name} (${r.count})`).join(", ");
  const weeks = data.weeks;
  const now = new Date(data.now);

  return (
    <div className="page hdd">
      <header className="hdd-head">
        <div>
          <div className="hdd-eyebrow">Helpdesk · Frontline</div>
          <h1>IT help-desk status</h1>
          <div className="hdd-sub">
            {now.toLocaleDateString([], { weekday: "long", year: "numeric", month: "long", day: "numeric" })}
            {" · "}{t.open} open of {t.in_window.toLocaleString()} tickets since {shortDate(data.school_year_start)}
          </div>
        </div>
        <div className="hdd-stamp">
          Fetched <b>{fmtAge(data.fetched_at)}</b><br />
          {data.window_truncated && <span className="hd-warn-text">History capped at {data.window_days} days<br /></span>}
          <button type="button" className="btn sm" disabled={loading} onClick={onRefresh}>
            {loading ? "Refreshing…" : "Refresh"}</button>
        </div>
      </header>

      {data.stale && <div className="hd-banner">Help desk unreachable — showing figures from
        {" "}{fmtDate(data.fetched_at)}. {data.error?.message}</div>}

      <Panel title="Executive summary">
        <p className="hdd-lede">{data.summary.join(" ")}</p>
      </Panel>

      <section className="card hdd-urgent">
        <div className="card-h"><h3>Urgent flags — overdue High / Critical tickets</h3>
          <div className="h-spacer" /><span className="hdd-count">{urgentN}</span></div>
        <div className="card-b">
          <p><b>{t.overdue} of {t.open} open tickets ({pct(t.overdue_pct)}) are past SLA.</b>
            {" "}{urgentN} are High or Critical. Overdue by priority: {prioOver || "none"}.
            {sitesOver && <> Top overdue sites: {sitesOver}.</>}</p>
          {data.urgent.length ? (
            <Table head={["Ticket", "Summary", "Site", "Priority", "Problem type", "Days overdue", "Assigned to"]}
                   num={[5]}
                   rows={data.urgent.map((u) => ({ cells: [
                     <TicketRef n={u.ticket} />, u.subject || "—", u.site || "—",
                     <span className={`hdb-prio p${u.prio_rank}`}>{u.priority}</span>,
                     u.category || "—", u.over_days, u.assigned_to || "Unassigned"] }))} />
          ) : <div className="msg">No High or Critical ticket is past its SLA target.</div>}
        </div>
      </section>

      <div className="hdd-tiles">
        <Tile value={t.open} label="Open tickets" note={`${data.by_status.map((s) => `${s.count} ${s.name}`).slice(0, 3).join(" · ")}`} />
        <Tile value={t.overdue} label="Overdue (open)" note={`${pct(t.overdue_pct)} of open backlog`} tone="crit" />
        <Tile value={w.new} label="New this week" note={`since ${weekday(w.by_day[0].date)}`} tone="info" />
        <Tile value={w.resolved} label="Resolved this week" note={`${w.closed_of_intake} of this week's intake closed (${pct(w.closed_pct)})`} tone="ok" />
        <Tile value={m.new} label="MTD new" note={`${signed(m.new_change_pct, "%")} vs same days last month`} tone="info" />
        <Tile value={m.closed} label="MTD closed" note={`${pct(m.closed_pct)} of MTD intake`} tone="ok" />
      </div>

      <div className="hdd-grid2">
        <Panel title={`This week (${weekday(w.by_day[0].date)} – ${weekday(w.by_day[w.by_day.length - 1].date)})`}
               sub={`${w.new} new · ${w.closed_of_intake} already closed · ${w.still_open} still open · ${w.resolved} resolved in all`}>
          <ColBars rows={w.by_day.map((d) => ({ label: weekday(d.date).split(",")[0] + (d.partial ? "*" : ""),
                                                value: d.count, dim: d.partial }))} />
          <div className="hdd-cap">* today, partial. Open backlog by status: {data.by_status.map((s) => `${s.name} ${s.count}`).join(", ")}.</div>
        </Panel>
        <Panel title="Open by priority">
          <Table head={["Priority", "Open", "% of open", "Overdue"]} num={[1, 2, 3]}
                 rows={data.by_priority.map((r) => ({ cells: [r.name, r.open, pct(r.pct), r.overdue] }))} />
          <h4 className="hdd-h4">Open by problem type (top 10)</h4>
          <Table head={["Problem type", "Open", "%"]} num={[1, 2]}
                 rows={data.by_category.map((r) => ({ cells: [r.name, r.count, pct(r.pct)] }))} />
        </Panel>
      </div>

      <Panel title={`School-year trend — weeks beginning ${shortDate(data.school_year_start)}`}
             sub="New tickets by week submitted, against those of them now closed and all tickets resolved that week. The last week is partial.">
        <LineChart labels={weeks.map((x) => shortDate(x.start) + (x.partial ? "*" : ""))}
                   series={[{ name: "New submitted", color: C_NEW, values: weeks.map((x) => x.new) },
                            { name: "Of those, closed", color: C_CLOSED, values: weeks.map((x) => x.closed) },
                            { name: "Resolved that week", color: "var(--warn)", values: weeks.map((x) => x.resolved) }]} />
      </Panel>

      <div className="hdd-grid2">
        <Panel title={`Top problem types — MTD new (${shortDate(m.start)} – today)`}>
          <HBars rows={data.mtd_types.map((r) => ({ label: r.name, value: r.count }))}
                 empty="No tickets yet this month." />
        </Panel>
        <Panel title="Open backlog by site (top 15)"
               sub={data.top4_sites.count ? `The top four sites hold ${data.top4_sites.count} (${pct(data.top4_sites.pct)}) of the open backlog.` : null}>
          <HBars rows={data.by_site.map((r, i) => ({ label: r.name, value: r.count, hi: i < 4 }))} />
        </Panel>
      </div>

      <Panel title={`Month-to-date — ${shortDate(m.start)}–today vs ${shortDate(p.start)}–${shortDate(p.end)}`}
             sub="Percent columns are share of that period's new tickets (the closed row is the closure rate). Last month's closure rate is higher partly because its tickets have had longer to close.">
        <Table head={["Measure", "This month", "%", "Last month", "%", "Change"]} num={[1, 2, 3, 4, 5]}
               rows={[
                 { cells: [<b>New tickets</b>, m.new, "", p.new, "", signed(m.new_change_pct, "%")] },
                 { cells: ["Closed", m.closed, pct(m.closed_pct), p.closed, pct(p.closed_pct), signed(m.closed_change_pct, "%")] },
                 { cells: ["Still open", m.still_open, "", p.still_open, "", signed(m.still_open - p.still_open)] },
                 { cells: ["High / Critical", m.urgent, "", p.urgent, "", signed(m.urgent - p.urgent)] },
               ]} />
        <Table head={["Problem type (MTD top 12)", "MTD", "% of MTD", "Last month", "Change"]} num={[1, 2, 3, 4]}
               rows={data.mtd_types.map((r) => ({ cells: [r.name, r.count, pct(r.pct), r.prior, signed(r.change)] }))} />
      </Panel>

      <Panel title="Weekly intake and closure">
        <Table head={["Week", "New", "Closed", "Closed %", "Still open", "Resolved that week"]} num={[1, 2, 3, 4, 5]}
               rows={[...weeks.map((x) => ({ cells: [shortDate(x.start) + (x.partial ? " *" : ""), x.new, x.closed,
                                                     pct(x.closed_pct), x.still_open, x.resolved] })),
                      { cls: "tot", cells: ["School year to date", data.ytd.new, data.ytd.closed,
                                            pct(data.ytd.closed_pct), data.ytd.still_open, ""] }]} />
      </Panel>

      <Panel title="Suggested actions">
        {data.actions.length ? (
          <ol className="hdd-actions">
            {data.actions.map((a, i) => (
              <li key={i}><b>{a.title}.</b> {a.detail}
                {a.refs.length > 0 && <span className="hdd-refs">{a.refs.map((r) => <TicketRef key={r} n={r} />)}</span>}
              </li>
            ))}
          </ol>
        ) : <div className="msg">Nothing stands out — no rule fired.</div>}
      </Panel>

      <footer className="hdd-foot">
        <div><b>Open</b> = in Frontline's active queue for the integration account. <b>Overdue</b> = open with an
          SLA target date before now. <b>Closed</b> (per week / month) = tickets submitted in that period that are no
          longer active; <b>Resolved</b> = tickets whose resolution date falls in that period.</div>
        <div>History covers tickets created in the last {data.window_days} days. Resolutions of tickets created before
          that are not counted, so the earliest weeks under-count "resolved". School year anchored at
          {" "}{shortDate(data.school_year_start)} ([helpdesk] school_year_start).</div>
      </footer>
    </div>
  );
}
