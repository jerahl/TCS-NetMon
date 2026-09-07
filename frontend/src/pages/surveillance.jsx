import React from "react";
import { getJSON, qs } from "../api.js";
import {
  Card, Loading, ErrorMsg, SourceBadge, sevColor, PageHeader, Tabs, StatCell, Dot, SevText,
} from "../primitives.jsx";
import { ageOf } from "../format.js";

// Surveillance (Milestone) — Phase 10.4, given ZCD's shell in spec 20 S1.
//
// All of it reads NetMon's DB (Config-API + ESS cadence); no source call
// happens at render. The page borrows ZCD's *composition* — page header with
// meta pills, badged tabs, four-cell KPI strip, card-header grammar, server
// tiles, alarm feed — and fills it with data ZCD's own NOC page never had
// (reachability tiers, ESS Communication state, real school attribution).
//
// What it deliberately does not borrow: any slot ZCD fills with a zero it
// cannot source. Storage *used*, recorder CPU/mem/RAID and Smart Client
// sessions are absent here rather than shown as 0 — see §4 of spec 20 and the
// storage note in OverviewTab.

const REFRESH_MS = 30000;

// The domains whose open alerts are "VMS alarms" for this page's purposes.
const ALARM_SCOPE = "camera,recording_server";

// Whether Milestone actually told us how much space is used. Module-level
// because SurveillancePage and OverviewTab both need it and OverviewTab is a
// sibling component, not a closure — deriving it in the page and reading it in
// the tab is what produced "usedKnown is not defined" at runtime.
const usedIsKnown = (summary) =>
  Boolean(summary && summary.storage_used_known && summary.storage_used_gb !== null
          && summary.storage_used_gb !== undefined);

// Reachability tiers as an operator reads them. The wording matters more than
// the colour: "down" alone cannot distinguish a dead camera from one the
// platform cannot reach, and those need different responses (spec 19 §13).
const STATUS = {
  up:                { label: "Up",              tone: "ok",   hint: "platform and network both reach it" },
  down_confirmed:    { label: "Down",            tone: "err",  hint: "Milestone and ICMP agree it is unreachable" },
  down_source_only:  { label: "Milestone down",  tone: "err",  hint: "Milestone cannot reach it; the network can — a platform-side problem, not a dead camera" },
  down_network_only: { label: "No ICMP",         tone: "warn", hint: "does not answer ping while Milestone reports it fine — most camera models never answer ICMP" },
  unknown:           { label: "Unknown",         tone: "",     hint: "no probe has an opinion" },
};

function StatusPill({ tier, blind }) {
  // Blind outranks the tier: if Milestone cannot see the camera at all, saying
  // anything about agreement between probes would overstate what is known.
  if (blind) {
    return <span className="state-pill warn" title="Milestone has no state for this camera — not the same as down">Blind</span>;
  }
  const s = STATUS[tier] || STATUS.unknown;
  return <span className={"state-pill " + s.tone} title={s.hint}>{s.label}</span>;
}

// GB → GB/TB/PB. The estate's configured total is ~1.8 million GB, which reads
// as noise in GB and as an awkward 1,794 in TB; the owner describes it in PB,
// so the formatter goes that far too.
export const fmtGb = (gb) => {
  if (gb === null || gb === undefined) return "—";
  const n = Number(gb);
  if (!Number.isFinite(n)) return "—";
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} PB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} TB`;
  return `${Math.round(n)} GB`;
};

const num = (v) => Number(v) || 0;
const fmtN = (v) => num(v).toLocaleString();

// Tabs that have real content today. ZCD also has Sites and Evidence Lock;
// those arrive in spec 20 S6 with the data behind them (per-site recorder and
// switch/AP roll-ups; the evidence-lock endpoint investigation). An empty tab
// naming a future phase would be worse than no tab.
const TAB_IDS = ["overview", "cameras", "servers", "storage", "alarms"];

function StateDot({ value }) {
  const sev = value === "up" ? "ok" : value === "down" ? "crit" : value === "blind" ? "warn" : "unknown";
  return <span className="dot" style={{ background: sevColor(sev) }} title={value || "unknown"} />;
}

export function SurveillancePage({ query = {} }) {
  const [summary, setSummary] = React.useState(null);
  const [sites, setSites] = React.useState(null);
  const [servers, setServers] = React.useState(null);
  const [alarms, setAlarms] = React.useState(null);
  const [meta, setMeta] = React.useState(null);
  const [error, setError] = React.useState(null);
  // Lifted out of CamerasTab so the by-school grid can drive it: clicking a
  // school on the overview is the same gesture as filtering the camera list.
  const [site, setSite] = React.useState("");

  // The URL owns the active tab, not component state — so a deep link, the ⌘K
  // palette and the browser's back button all land where they say they will.
  const tab = TAB_IDS.includes(query.tab) ? query.tab : "overview";
  const setTab = (id) => {
    location.hash = "#/surveillance" + (id === "overview" ? "" : `?tab=${encodeURIComponent(id)}`);
  };

  React.useEffect(() => {
    getJSON("/api/meta").then(setMeta).catch(() => { /* header slot omitted */ });
  }, []);

  React.useEffect(() => {
    let live = true;
    // Four reads, one cadence. Sites and servers are lifted here rather than
    // fetched per tab because the header, the overview and their own tabs all
    // want them, and a 26-row and 22-row query is cheaper than the
    // re-fetch-on-every-tab-switch it replaces.
    const load = () => {
      getJSON("/api/surveillance/summary")
        .then((s) => { if (live) { setSummary(s); setError(null); } })
        .catch((e) => { if (live) setError(e); });
      getJSON("/api/surveillance/sites").then((r) => live && setSites(r)).catch(() => live && setSites([]));
      getJSON("/api/surveillance/servers").then((r) => live && setServers(r)).catch(() => live && setServers([]));
      getJSON("/api/alerts" + qs({ device_type: ALARM_SCOPE, limit: 200 }))
        .then((r) => live && setAlarms(r)).catch(() => live && setAlarms([]));
    };
    load();
    const id = setInterval(load, REFRESH_MS);
    return () => { live = false; clearInterval(id); };
  }, []);

  if (error) return <ErrorMsg error={error} />;
  if (!summary) return <Loading what="surveillance" />;

  const age = ageOf(summary.updated_at);
  const cs = summary.cameras_by_status || {};
  const usedKnown = usedIsKnown(summary);
  const storagePct = usedKnown && summary.storage_total_gb
    ? Math.round((summary.storage_used_gb / summary.storage_total_gb) * 100) : null;
  const camsDown = num(cs.down_confirmed) + num(cs.down_source_only);
  const rsAllUp = summary.servers_total > 0 && summary.servers_up === summary.servers_total;

  const alarmCrit = (alarms || []).filter((a) => a.severity === "crit").length;
  const alarmWarn = (alarms || []).filter((a) => a.severity === "warn").length;

  const tabs = [
    { id: "overview", label: "Overview" },
    { id: "cameras", label: "Cameras", badge: fmtN(summary.cameras_total),
      kind: camsDown > 0 ? "err" : "", title: camsDown ? `${camsDown} needing attention` : undefined },
    { id: "servers", label: "Recording Servers", badge: fmtN(summary.servers_total),
      kind: rsAllUp ? "" : "err" },
    { id: "storage", label: "Storage" },
    { id: "alarms", label: "Alarms", badge: alarms ? fmtN(alarms.length) : "",
      kind: alarmCrit > 0 ? "err" : alarms && alarms.length ? "warn" : "" },
  ];

  return (
    <div className="page">
      <PageHeader
        title="Surveillance NOC"
        ip={meta?.milestone_host || null}
        pills={[
          { label: "recorders", value: `${summary.servers_up} / ${summary.servers_total}`,
            severity: rsAllUp ? "ok" : summary.servers_up > 0 ? "warn" : "crit",
            title: rsAllUp ? "every recording server is up" : `${summary.servers_down} not up` },
          { label: "cameras", value: fmtN(summary.cameras_total) },
          { label: "schools", value: sites ? String(sites.length) : "…" },
          // "configured", never "used" — the Config API on 2025 R2 has no
          // consumed-space field (spec 19 §8), and a bare TB figure next to a
          // percentage would be read as usage.
          { label: "storage", value: `${fmtGb(summary.storage_total_gb)} configured` },
          age ? { label: "cache", value: `${age} old` } : null,
        ]}
        range="Live · 24h history"
      />

      <div className="subtitle">
        <SourceBadge source="milestone" /> Config API + Events/State ·
        {" "}refreshes every {REFRESH_MS / 1000}s
        {!summary.updated_at && <span style={{ color: sevColor("warn") }}> · no camera data yet</span>}
      </div>

      <UnlinkedBanner overview={summary.overview} />
      <DegradedBanner overview={summary.overview} />

      {/* ZCD's four-cell strip. The six tiers stay available as filter chips on
          the Cameras tab; here the sub-line carries them so the headline number
          answers "how many cameras are working" without hiding which failure
          shape is in play. */}
      <Card tight>
        <div className="stat-grid">
          <StatCell label="Cameras online" source="milestone-ess"
                    value={cs.up ?? "—"} unit={`/ ${fmtN(summary.cameras_total)}`}
                    severity={camsDown > 0 ? "crit" : undefined}
                    sub={camsDown || cs.down_network_only || cs.blind
                      ? [num(cs.down_confirmed) ? `${cs.down_confirmed} down` : null,
                         num(cs.down_source_only) ? `${cs.down_source_only} Milestone-down` : null,
                         num(cs.down_network_only) ? `${cs.down_network_only} no ICMP` : null,
                         num(cs.blind) ? `${cs.blind} blind` : null].filter(Boolean).join(" · ")
                      : "every camera reachable"}
                    subTone={camsDown > 0 ? "err" : cs.down_network_only || cs.blind ? "warn" : "ok"} />
          <StatCell label="Recording servers" source="milestone"
                    value={summary.servers_up} unit={`/ ${summary.servers_total}`}
                    severity={rsAllUp ? undefined : "crit"}
                    sub={summary.servers_total === 0 ? "none linked yet"
                      : rsAllUp ? "all online" : `${summary.servers_down} not up`}
                    subTone={rsAllUp ? "ok" : "err"} />
          <StatCell label="Active alarms" source="netmon"
                    value={alarms ? alarms.length : null}
                    severity={alarmCrit > 0 ? "crit" : undefined}
                    sub={!alarms ? "loading"
                      : alarms.length === 0 ? "no open alerts"
                      : [alarmCrit ? `${alarmCrit} critical` : null,
                         alarmWarn ? `${alarmWarn} warning` : null].filter(Boolean).join(" · ")}
                    subTone={alarmCrit > 0 ? "err" : alarms && alarms.length ? "warn" : "ok"} />
          {/* Recording is motion-triggered on this estate, so "stopped" is the
              resting state — a count shown as information, never as a fault. */}
          <StatCell label="Recording now" source="milestone"
                    value={fmtN(summary.cameras_recording)} unit={`/ ${fmtN(summary.cameras_total)}`}
                    sub="motion-triggered — stopped is normal" />
        </div>
      </Card>

      <Tabs tabs={tabs} active={tab} onChange={setTab} />

      {tab === "overview" && (
        <OverviewTab summary={summary} storagePct={storagePct} sites={sites}
                     servers={servers} alarms={alarms} meta={meta}
                     onPickSite={(s) => { setSite(s || ""); setTab("cameras"); }} />
      )}
      {tab === "cameras" && (
        <CamerasTab counts={summary.cameras_by_status} site={site} onSite={setSite} />
      )}
      {tab === "servers" && <ServersTab rows={servers} />}
      {tab === "storage" && <StorageTab />}
      {tab === "alarms" && <AlarmsTab rows={alarms} />}
    </div>
  );
}

// Cameras by school, the same idiom as the XIQ page's APs-by-site grid. Tinted
// by the worst thing present rather than by a ratio: one dead camera at a small
// site matters as much as one at a large one, and a percentage hides that.
function SitesCard({ rows, onPick }) {
  const [filter, setFilter] = React.useState("all");
  if (!rows) return <Card title="Cameras by school"><Loading what="sites" /></Card>;
  return <SiteTiles rows={rows} filter={filter} onFilter={setFilter} onPick={onPick} />;
}

// Split from the fetch above so the render check can exercise it with fixed
// rows — a component that only renders after a fetch never runs server-side.
export function SiteTiles({ rows, filter, onFilter, onPick }) {
  // Counts are coerced rather than trusted. They arrive from SQL SUM(), which
  // MariaDB returns as Decimal and FastAPI once serialised as a quoted string —
  // and a quoted count fails silently in both directions here: "1" + "0" is
  // "10" on the badge, and "0" is truthy, so every site scored as a failure.
  // db.py fixes that at the source; this keeps the component correct on its own.
  const n = (v) => Number(v) || 0;
  const scored = rows.map((r) => ({
    ...r,
    total: n(r.total), up: n(r.up), recording: n(r.recording), blind: n(r.blind),
    down_confirmed: n(r.down_confirmed),
    down_source_only: n(r.down_source_only),
    down_network_only: n(r.down_network_only),
  })).map((r) => ({
    ...r,
    // Blind ranks with the warnings, not the failures: it is the source saying
    // it cannot tell, which is not evidence of an outage.
    worst: (r.down_confirmed || r.down_source_only) ? "crit"
         : (r.down_network_only || r.blind) ? "warn" : "ok",
  })).sort((a, b) => (b.down_confirmed + b.down_source_only)
                   - (a.down_confirmed + a.down_source_only)
                   || String(a.site).localeCompare(String(b.site)));
  const issues = scored.filter((r) => r.worst !== "ok");
  const shown = filter === "issues" ? issues
    : filter === "ok" ? scored.filter((r) => r.worst === "ok") : scored;

  return (
    <Card title="Cameras by school" source="milestone"
          kicker={`${scored.length} school(s) · ${issues.length} needing attention`}>
      <div className="evt-filters" style={{ marginTop: 0 }}>
        <span className="seg-toggle">
          {[["all", `All ${scored.length}`], ["issues", `Issues ${issues.length}`],
            ["ok", `Healthy ${scored.length - issues.length}`]].map(([k, label]) => (
            <button key={k} type="button"
                    className={"seg-btn" + (filter === k ? " active" : "")}
                    onClick={() => onFilter(k)}>{label}</button>
          ))}
        </span>
      </div>
      <div className="sites-grid">
        {shown.map((r) => {
          // The badge counts what someone would be dispatched for. no-ICMP and
          // blind still tint the tile and show in the tooltip, but they are not
          // failures — most no-ICMP cameras here are models that never answer
          // ping at all (spec 19 §7), and putting that in the headline number
          // would make every school look broken.
          const bad = r.down_confirmed + r.down_source_only;
          return (
            <button key={r.site || "unassigned"} type="button" className="site-tile"
                    onClick={() => onPick(r.site)}
                    style={{ borderColor: sevColor(r.worst) + "66",
                             background: sevColor(r.worst) + "14" }}
                    title={`${r.total} camera(s) · ${r.up} up · ${r.recording} recording` +
                           `${r.down_confirmed ? ` · ${r.down_confirmed} down` : ""}` +
                           `${r.down_source_only ? ` · ${r.down_source_only} Milestone-down` : ""}` +
                           `${r.down_network_only ? ` · ${r.down_network_only} no ICMP` : ""}` +
                           `${r.blind ? ` · ${r.blind} blind` : ""}`}>
              <div className="site-tile-h">
                <span className="site-tile-prob" style={{ color: sevColor(r.worst) }}>
                  {bad || (r.down_network_only + r.blind) || "✓"}
                </span>
              </div>
              <div className="site-tile-name">{r.site || "Unassigned"}</div>
              <div className="site-tile-meta">
                <span>{r.total} cam</span><span>{r.recording} rec</span>
              </div>
            </button>
          );
        })}
        {shown.length === 0 && <div className="msg">No schools in this filter.</div>}
      </div>
      <div className="sites-legend">
        <span className="legend-item">
          <span className="legend-sw" style={{ borderColor: sevColor("crit") + "66",
                                               background: sevColor("crit") + "22" }} />
          down / Milestone-down
        </span>
        <span className="legend-item">
          <span className="legend-sw" style={{ borderColor: sevColor("warn") + "66",
                                               background: sevColor("warn") + "22" }} />
          no ICMP / blind
        </span>
        <span className="legend-item">
          <span className="legend-sw" style={{ borderColor: sevColor("ok") + "66",
                                               background: sevColor("ok") + "22" }} />
          all up
        </span>
        <span className="legend-foot">
          {scored.reduce((n2, r) => n2 + r.down_confirmed + r.down_source_only, 0)} camera(s) down
          across {scored.length} school(s)
        </span>
      </div>
    </Card>
  );
}

export function OverviewTab({ summary, storagePct, sites, servers, alarms, meta, onPickSite }) {
  const usedKnown = usedIsKnown(summary);
  // Retention is per recorder and cumulative from the moment of recording
  // (spec 19 §8) — so the estate figure is a range, not a single number, and
  // averaging it would describe no recorder that exists.
  const rets = (servers || []).map((s) => num(s.retention_days)).filter((d) => d > 0);
  const retLabel = rets.length === 0 ? null
    : Math.min(...rets) === Math.max(...rets) ? `${rets[0]} days`
    : `${Math.min(...rets)}–${Math.max(...rets)} days (per recorder)`;
  const rsAllUp = summary.servers_total > 0 && summary.servers_up === summary.servers_total;

  return (
    <React.Fragment>
      {/* First, because "which school has a problem" is the question this page
          gets opened for. The environment roll-up below is context, not the
          lede. */}
      <SitesCard rows={sites} onPick={onPickSite} />

      <div className="global-cols">
        <div className="global-col">
          <Card title="Milestone XProtect" source="milestone"
                kicker={meta?.milestone_host || "gateway not configured"}>
            <table className="grid kv">
              <tbody>
                <tr><td>Management server</td>
                    <td className="mono">{meta?.milestone_host || <span className="dim">—</span>}</td></tr>
                <tr><td>Recording servers</td>
                    <td><Dot severity={rsAllUp ? "ok" : "crit"} /> {summary.servers_up} of{" "}
                        {summary.servers_total} online</td></tr>
                <tr><td>Cameras</td>
                    <td>{fmtN(summary.cameras_total)} registered ·{" "}
                        {fmtN(summary.cameras_recording)} recording now</td></tr>
                <tr><td>Retention</td>
                    <td>{retLabel || <span className="dim">—</span>}
                      {retLabel && <span className="dim"> · cumulative, incl. archive</span>}</td></tr>
                <tr><td>Storage configured</td><td className="mono">{fmtGb(summary.storage_total_gb)}</td></tr>
                <tr><td>Storage used</td><td>
                  {usedKnown
                    ? <span className="mono">{fmtGb(summary.storage_used_gb)}{storagePct !== null ? ` (${storagePct}%)` : ""}</span>
                    : <span className="dim">not available — the Config API on XProtect 2025 R2
                        exposes configured size only, with no used-space field on the storage
                        object and no storageInformation resource</span>}
                </td></tr>
                {/* ZCD shows device licences, failover/mobile servers and Smart
                    Client sessions here. Nothing NetMon reads today carries
                    them; the rows arrive in spec 20 S2 if the REST resources
                    exist on 2025 R2, and stay absent rather than showing 0. */}
              </tbody>
            </table>
          </Card>
        </div>

        <div className="global-col">
          <Card title="Recording servers" source="milestone"
                kicker={servers ? `${servers.length} recorder(s)` : "loading"}
                link={{ href: "#/surveillance?tab=servers", label: "All recorders" }}>
            {!servers ? <Loading what="recording servers" /> : servers.length === 0 ? (
              <div className="msg">No recording servers cached.</div>
            ) : (
              <div className="stat-grid" style={{ gridTemplateColumns: "repeat(2, 1fr)" }}>
                {servers.slice(0, 6).map((s) => <ServerMini key={s.device_id} s={s} />)}
              </div>
            )}
            {/* ZCD's tiles show CPU / memory / disk from a Windows agent.
                NetMon has no agent on the recorders (WinRM, OpenProject #111),
                so the three slots carry what Milestone does answer for. */}
            <div className="msg" style={{ fontSize: 11, marginTop: 10 }}>
              Host metrics (CPU, memory, disk, RAID) need WinRM access to the
              recorders and are not collected yet.
            </div>
          </Card>
        </div>
      </div>

      <Card title="Active alarm feed" source="netmon"
            kicker="open NetMon alerts on cameras and recorders"
            link={{ href: "#/problems", label: "Problems console" }} tight>
        <AlarmFeed rows={alarms} limit={10} />
      </Card>
    </React.Fragment>
  );
}

// ZCD's `.server-tile`. Three stat slots, filled with what Milestone actually
// answers for rather than the CPU/Mem/Disk ZCD reads off a Windows agent.
export function ServerMini({ s }) {
  const sev = s.status === "up" ? "ok" : s.status === "down" ? "crit" : "warn";
  return (
    <div className="server-tile">
      <div className="head">
        <Dot severity={sev} />
        <div className="id">{s.name}</div>
        {s.role && <span className="role">{String(s.role).replace(/\s*server$/i, "")}</span>}
      </div>
      <div className="stats">
        <div>Cameras<div className="v">{s.chans_total ?? "—"}</div></div>
        <div>Storage<div className="v">{fmtGb(s.storage_total_gb)}</div></div>
        <div>Retention<div className="v">{s.retention_days ? `${s.retention_days}d` : "—"}</div></div>
      </div>
      <div className="meta">
        <span>{s.site || "—"}</span>
        <span>{s.version || ""}</span>
      </div>
    </div>
  );
}

// Where an alarm's object leads. Cameras have a detail page; recorders do not
// (ZCD's was mock), so those land on the recorders tab rather than a dead link.
function alarmHref(a) {
  if (a.device_type === "camera" && a.device_id) return `#/camera/${a.device_id}`;
  return "#/surveillance?tab=servers";
}

export function AlarmFeed({ rows, limit }) {
  if (!rows) return <Loading what="alarms" />;
  if (rows.length === 0) {
    return (
      <div className="msg" style={{ padding: 14 }}>
        No open alerts on cameras or recording servers.
      </div>
    );
  }
  const shown = limit ? rows.slice(0, limit) : rows;
  return (
    <div>
      {shown.map((a) => (
        <div key={a.id} className={"alarm-row" + (a.acked_by ? " ack" : "")}>
          <div className="ts">{ageOf(a.opened_at) || "?"} ago</div>
          <SevText severity={a.severity} />
          <div><Dot severity={a.severity} /></div>
          <div className="obj"><a href={alarmHref(a)}>{a.device_name || `device ${a.device_id}`}</a></div>
          <div className="msg">{a.rule_name}</div>
          <div className="site">
            {a.site || "—"}
            {a.acked_by && <span className="dim"> · ack {a.acked_by}</span>}
          </div>
        </div>
      ))}
      {limit && rows.length > limit && (
        <div className="msg" style={{ padding: "8px 14px", fontSize: 11 }}>
          {rows.length - limit} more open — see the Alarms tab.
        </div>
      )}
    </div>
  );
}

export function CamerasTab({ counts, site = "", onSite }) {
  const [rows, setRows] = React.useState(null);
  const [q, setQ] = React.useState("");
  const [status, setStatus] = React.useState("");
  React.useEffect(() => {
    setRows(null);
    const id = setTimeout(() =>
      getJSON("/api/surveillance/cameras" + qs({ q, site, status }))
        .then(setRows).catch(() => setRows([])), 250);
    return () => clearTimeout(id);
  }, [q, site, status]);

  const c = counts || {};
  // "down" first and widest, because it is the question being asked. It is the
  // union of the three down tiers, not just down_confirmed — filtering to the
  // strictest tier would hide the cameras Milestone cannot reach.
  const chips = [
    ["", "All", (c.up || 0) + (c.down || 0) + (c.unknown || 0)],
    ["down", "Down (any)", c.down],
    ["down_confirmed", STATUS.down_confirmed.label, c.down_confirmed],
    ["down_source_only", STATUS.down_source_only.label, c.down_source_only],
    ["down_network_only", STATUS.down_network_only.label, c.down_network_only],
    ["blind", "Blind", c.blind],
    ["up", "Up", c.up],
  ];

  return (
    <Card kicker={rows ? `${rows.length} shown${site ? ` at ${site}` : ""}` : "Cameras"}
          source="milestone-ess" tight>
      <div className="cam-filter-bar">
        {site && (
          <div className="cfb-group">
            <span className="cfb-lbl">School</span>
            <button type="button" className="cfb-chip active"
                    title="clear the school filter"
                    onClick={() => onSite && onSite("")}>{site} ✕</button>
          </div>
        )}
        <div className="cfb-group">
          <span className="cfb-lbl">Status</span>
          {chips.map(([val, label, n]) => (
            <button key={val || "all"} type="button"
                    className={"cfb-chip" + (status === val ? " active" : "")}
                    title={site
                      ? "counts are estate-wide; the list below is limited to " + site
                      : (STATUS[val]?.hint || "")}
                    onClick={() => setStatus(val)}>
              {/* The counts come from the estate-wide summary, so they stop
                  describing the list once a school is picked. Dropping them
                  beats showing a number that belongs to a different set. */}
              {label}{!site && n !== undefined ? ` ${n}` : ""}
            </button>
          ))}
        </div>
        <div className="cfb-group" style={{ marginLeft: "auto", flex: 1, maxWidth: 320 }}>
          <span className="cfb-lbl">Search</span>
          <input type="text" placeholder="name, model, IP, MAC…" value={q}
                 onChange={(e) => setQ(e.target.value)} style={{ width: "100%" }} />
        </div>
      </div>
      {!rows ? <Loading what="cameras" /> : rows.length === 0 ? (
        <div className="msg" style={{ padding: 14 }}>
          {status || q
            ? "No cameras match this filter."
            : "No cameras cached — the Milestone collector hasn't populated the camera table."}
        </div>
      ) : (
        <table className="grid nvr-tbl">
          <thead><tr><th>Status</th><th>Camera</th><th>Site</th><th>Model</th>
                     <th>Recording</th><th>Server</th><th>IP</th><th></th></tr></thead>
          <tbody>
            {rows.map((cam) => {
              const blind = cam.source_status === "blind";
              const tier = cam.reachability;
              const rowCls = blind ? "row-warn"
                : tier === "down_confirmed" || tier === "down_source_only" ? "row-err"
                : tier === "down_network_only" ? "row-warn" : "";
              return (
                <tr key={cam.device_id} className={rowCls}>
                  <td><StatusPill tier={tier} blind={blind} /></td>
                  <td><a href={`#/camera/${cam.device_id}`}>{cam.name}</a></td>
                  <td>{cam.site || "—"}</td>
                  <td className="dim">{cam.model || "—"}</td>
                  {/* Recording here is motion-triggered, so "stopped" is the
                      ordinary resting state and is shown as information
                      rather than as a fault. */}
                  <td><span className={"rec-pill" + (cam.recording_state === "up" ? "" : " off")}>
                    {cam.recording_state || "unknown"}</span></td>
                  <td className="dim">{cam.recording_server || "—"}</td>
                  <td className="mono dim">{cam.ip || "—"}</td>
                  <td><a className="btn btn-sm" href={`#/camera/${cam.device_id}`}>Detail</a></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </Card>
  );
}

export function ServersTab({ rows }) {
  if (!rows) return <Loading what="recording servers" />;
  return (
    <Card title="Recording servers" source="milestone"
          kicker={`${rows.length} recording server(s)`}>
      {rows.length === 0 ? <div className="msg">No recording servers cached.</div> : (
        <table className="grid nvr-tbl">
          <thead><tr><th></th><th>Server</th><th>Site</th><th>Role</th><th>Version</th>
                     <th>Cameras</th><th>Recording</th><th>Storage configured</th>
                     <th>Retention</th></tr></thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.device_id} className={s.status === "down" ? "row-err" : ""}>
                <td><StateDot value={s.status} /></td>
                <td>{s.name}<div className="dim mono" style={{ fontSize: 11 }}>{s.hostname || ""}</div></td>
                <td>{s.site || "—"}</td>
                <td className="dim">{s.role || "—"}</td>
                <td className="mono dim">{s.version || "—"}</td>
                <td className="mono">{s.chans_total ?? "—"}</td>
                <td className="mono">{s.chans_recording ?? "—"}</td>
                <td className="mono">{fmtGb(s.storage_total_gb)}</td>
                <td className="mono dim">{s.retention_days ? `${s.retention_days}d` : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {/* Named, not implied: ZCD's equivalent table has CPU / Mem / RAID /
          uptime columns fed by a Windows agent NetMon does not have. */}
      <div className="msg" style={{ fontSize: 11, marginTop: 10 }}>
        CPU, memory, disk and RAID come from the recorders' own OS and need WinRM
        access (OpenProject #111) — not collected, so not shown. Storage is the
        <em> configured</em> size; consumed space is not in the Config API.
      </div>
    </Card>
  );
}

export function AlarmsTab({ rows }) {
  const [sev, setSev] = React.useState("all");
  const [ack, setAck] = React.useState("all");
  if (!rows) return <Loading what="alarms" />;

  const counts = {
    all: rows.length,
    crit: rows.filter((a) => a.severity === "crit").length,
    warn: rows.filter((a) => a.severity === "warn").length,
    unack: rows.filter((a) => !a.acked_by).length,
    ack: rows.filter((a) => a.acked_by).length,
  };
  const shown = rows.filter((a) =>
    (sev === "all" || a.severity === sev)
    && (ack === "all" || (ack === "unack" ? !a.acked_by : !!a.acked_by)));

  return (
    <React.Fragment>
      <div className="card-h-bar">
        <span className="h-title">Open alarms · cameras and recorders</span>
        <SourceBadge source="netmon" />
        <div className="h-spacer" />
        <div className="trig-filter">
          {[["all", "All", counts.all, ""], ["crit", "Critical", counts.crit, "err"],
            ["warn", "Warning", counts.warn, "warn"]].map(([k, label, n, cls]) => (
            <span key={k} className={`tf ${cls} ${sev === k ? "active" : ""}`}
                  onClick={() => setSev(k)}>{label} <b>{n}</b></span>
          ))}
        </div>
        <span style={{ width: 8 }} />
        <div className="trig-filter">
          {[["all", "Any", counts.all, ""], ["unack", "Unacked", counts.unack, "warn"],
            ["ack", "Acked", counts.ack, ""]].map(([k, label, n, cls]) => (
            <span key={k} className={`tf ${cls} ${ack === k ? "active" : ""}`}
                  onClick={() => setAck(k)}>{label} <b>{n}</b></span>
          ))}
        </div>
      </div>

      <Card tight
            kicker={`${shown.length} of ${rows.length} shown`}
            link={{ href: "#/problems", label: "Acknowledge and assign on the Problems console" }}>
        {rows.length === 0 ? (
          <div className="msg" style={{ padding: 14 }}>
            No open alerts on cameras or recording servers.
          </div>
        ) : shown.length === 0 ? (
          <div className="msg" style={{ padding: 14 }}>No alarms match this filter.</div>
        ) : (
          <AlarmFeed rows={shown} />
        )}
      </Card>
    </React.Fragment>
  );
}

export function StorageTab() {
  const [rows, setRows] = React.useState(null);
  React.useEffect(() => { getJSON("/api/surveillance/storage").then(setRows).catch(() => setRows([])); }, []);
  if (!rows) return <Loading what="storage" />;
  return (
    <Card title="Storage volumes" source="milestone" kicker={`${rows.length} recorder(s)`}>
      {rows.length === 0 ? (
        <div className="msg">
          No storage rows cached yet. The collector walks the per-server
          endpoint; if this stays empty while the Milestone collector reads
          green, check NetMon Status for a degraded storage walk.
        </div>
      ) : (
        <table className="grid nvr-tbl">
          <thead><tr><th>Recorder</th><th>Configured</th><th>Used</th><th>Retention</th></tr></thead>
          <tbody>
            {rows.map((s, i) => {
              const known = s.storage_used_gb !== null && s.storage_used_gb !== undefined;
              const pct = known && s.storage_total_gb
                ? Math.round((s.storage_used_gb / s.storage_total_gb) * 100) : null;
              return (
                <tr key={i}>
                  <td>{s.name}<div className="dim mono" style={{ fontSize: 11 }}>{s.hostname || ""}</div></td>
                  <td className="mono">{fmtGb(s.storage_total_gb)}</td>
                  {/* Consumed space is not in the Config API — only configured
                      size is. A 0 here would read as "empty disk" on a NOC
                      wall, so the gap is named instead (§4.5). */}
                  <td className="mono">{known
                    ? `${fmtGb(s.storage_used_gb)}${pct !== null ? ` (${pct}%)` : ""}`
                    : <span className="dim">not exposed</span>}</td>
                  {/* Cumulative from the moment of recording, not live plus
                      archive added together: MAX(retainMinutes), never SUM. */}
                  <td className="mono dim">{s.retention_days ? `${s.retention_days}d cumulative` : "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </Card>
  );
}

// Milestone answered but no entity is linked to a registry device → the page
// would be blank with no explanation. Point the operator at the import.
function UnlinkedBanner({ overview }) {
  const p = overview && overview.payload;
  if (!p) return null;
  const discovered = (p.discovered_cameras || 0) + (p.discovered_servers || 0);
  const linked = (p.linked_cameras || 0) + (p.linked_servers || 0);
  if (discovered === 0 || linked > 0) return null;
  return (
    <div className="msg error" style={{ borderLeft: `3px solid ${sevColor("warn")}`, paddingLeft: 10 }}>
      Milestone is reachable and reports {p.discovered_cameras || 0} camera(s) and{" "}
      {p.discovered_servers || 0} recording server(s), but none are linked to the device registry —
      so nothing can be shown here. Import them in{" "}
      <a href="#/registry">Registry → Import from Milestone</a> (admin).
    </div>
  );
}

// The collector records which enrichments failed on the last cycle. Surfacing
// it is the whole point of collecting it: a 0 GB storage roll-up and an
// endpoint that answers HTTP 400 look identical on the glass otherwise
// (CLAUDE.md §4.5).
function DegradedBanner({ overview }) {
  const degraded = overview?.payload?.degraded;
  if (!Array.isArray(degraded) || degraded.length === 0) return null;
  const NAMES = {
    storage: "storage capacity and retention",
    hardware: "camera hardware model and identity",
    ess: "live camera status (Events/State)",
    identity: "camera firmware, serial and MAC",
  };
  return (
    <div className="msg error" style={{ borderLeft: `3px solid ${sevColor("warn")}`, paddingLeft: 10 }}>
      Last collection cycle degraded: {degraded.map((d) => NAMES[d] || d).join(", ")} could
      not be read. Figures below are the last good values, not current — see{" "}
      <a href="#/netmon-status">NetMon Status</a>.
    </div>
  );
}
