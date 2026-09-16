import React from "react";
import { getJSON, postJSON, qs } from "../api.js";
import {
  Card, Loading, ErrorMsg, SourceBadge, sevColor, PageHeader, Tabs, StatCell, Dot, SevText,
  Sparkline,
} from "../primitives.jsx";
import { ageOf } from "../format.js";
import { CameraOpsTab } from "./camera_ops.jsx";

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

// 10s (spec 20 S7). The page reads NetMon's own DB, so the cost is a handful
// of aggregate queries; what makes 10s worth having is the live ESS
// subscription, which can move a camera's state seconds after it happens
// instead of at the next 120s cycle. With `[milestone] ess_live = false` this
// simply re-reads the same rows more often, which is harmless.
const REFRESH_MS = 10000;

// The domains whose open alerts are "VMS alarms" for this page's purposes.
const ALARM_SCOPE = "camera,recording_server";

// Whether Milestone actually told us how much space is used. Module-level
// because SurveillancePage and OverviewTab both need it and OverviewTab is a
// sibling component, not a closure — deriving it in the page and reading it in
// the tab is what produced "usedKnown is not defined" at runtime.
const usedIsKnown = (summary) =>
  Boolean(summary && summary.storage_used_known && summary.storage_used_gb !== null
          && summary.storage_used_gb !== undefined);

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

// ZCD's tab row, less Cameras: that is its own page at #/cameras, navigated by
// the Milestone group tree, because a fleet of 2,662 needs a persistent
// navigator rather than a table you leave and return to (owner, 2026-09-07).
//
// Sites and Evidence Lock arrive with S6. Evidence Lock is a tab with no data
// behind it and says so — the Config API on 2025 R2 answers `evidenceLocks`
// with 400 "Unknown request" (probed 2026-09-08) — because the nav matching
// ZCD is the point, and a named gap is worth more than a missing tab.
const TAB_IDS = ["overview", "sites", "servers", "storage", "alarms", "evidence",
                 "firmware"];

function StateDot({ value }) {
  const sev = value === "up" ? "ok" : value === "down" ? "crit" : value === "blind" ? "warn" : "unknown";
  return <span className="dot" style={{ background: sevColor(sev) }} title={value || "unknown"} />;
}

export function SurveillancePage({ query = {} }) {
  const [summary, setSummary] = React.useState(null);
  const [sites, setSites] = React.useState(null);
  const [context, setContext] = React.useState(null);
  const [servers, setServers] = React.useState(null);
  const [clusters, setClusters] = React.useState(null);
  const [alarms, setAlarms] = React.useState(null);
  const [meta, setMeta] = React.useState(null);
  const [error, setError] = React.useState(null);
  // Firmware is an admin tab. The API enforces the same floor on every one of
  // its endpoints; asking here is so a viewer never sees a tab that would only
  // answer 403 — and never sees the word "firmware" beside a fleet they cannot
  // touch.
  const [role, setRole] = React.useState(null);
  // Held in a ref so an alarm action can pull fresh rows the moment it lands,
  // rather than leaving the operator looking at the state they just changed
  // until the 30s tick.
  const loadRef = React.useRef(null);
  // The URL owns the active tab, not component state — so a deep link, the ⌘K
  // palette and the browser's back button all land where they say they will.
  const tab = TAB_IDS.includes(query.tab) ? query.tab : "overview";
  const setTab = (id) => {
    location.hash = "#/surveillance" + (id === "overview" ? "" : `?tab=${encodeURIComponent(id)}`);
  };

  React.useEffect(() => {
    getJSON("/api/meta").then(setMeta).catch(() => { /* header slot omitted */ });
    getJSON("/auth/me").then((me) => setRole(me?.role || "viewer"))
      .catch(() => setRole("viewer"));
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
      // Recorders, configured storage, switches and APs per school — the
      // columns the Sites tab carries beside the camera counts.
      getJSON("/api/surveillance/site-context")
        .then((r) => live && setContext(r)).catch(() => live && setContext([]));
      getJSON("/api/surveillance/servers").then((r) => live && setServers(r)).catch(() => live && setServers([]));
      // Mass state changes, grouped by what the cameras share. Empty is the
      // normal case and renders nothing.
      getJSON("/api/surveillance/common-cause")
        .then((r) => live && setClusters(r)).catch(() => live && setClusters([]));
      getJSON("/api/alerts" + qs({ device_type: ALARM_SCOPE, limit: 200 }))
        .then((r) => live && setAlarms(r)).catch(() => live && setAlarms([]));
    };
    load();
    loadRef.current = load;
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
    { id: "sites", label: "Sites", badge: sites ? String(sites.length) : "" },
    { id: "servers", label: "Recording Servers", badge: fmtN(summary.servers_total),
      kind: rsAllUp ? "" : "err" },
    { id: "storage", label: "Storage" },
    { id: "alarms", label: "Alarms", badge: alarms ? fmtN(alarms.length) : "",
      kind: alarmCrit > 0 ? "err" : alarms && alarms.length ? "warn" : "" },
    { id: "evidence", label: "Evidence Lock" },
    // Last, and only for an admin. It is the one tab here that can change a
    // camera rather than describe one, so it does not sit between two reading
    // tabs where somebody lands on it by accident.
    role === "admin"
      ? { id: "firmware", label: "Firmware", title: "bulk firmware operations — "
          + "admin only, gated, dry-run by default" }
      : null,
  ].filter(Boolean);

  return (
    <div className="page">
      <PageHeader
        title="Surveillance NOC"
        ip={summary.management_server || meta?.milestone_host || null}
        tag={summary.version ? `XProtect ${summary.version}` : null}
        pills={[
          { label: "recorders", value: `${summary.servers_up} / ${summary.servers_total}`,
            severity: rsAllUp ? "ok" : summary.servers_up > 0 ? "warn" : "crit",
            title: rsAllUp ? "every recording server is up" : `${summary.servers_down} not up` },
          { label: "cameras", value: fmtN(summary.cameras_total) },
          // Activated device licences. There is no total to divide by —
          // Professional+ licenses per activated device, so ZCD's used/total
          // bar has no source (spec 20 S2).
          summary.license_activated
            ? { label: "licences", value: `${fmtN(summary.license_activated)} activated`,
                severity: summary.license_not_licensed ? "warn" : undefined,
                title: summary.license_not_licensed
                  ? `${summary.license_not_licensed} device(s) not licensed`
                  : "no unlicensed devices" }
            : null,
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
        {" · "}<a href="#/cameras">camera fleet →</a>
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
                         num(cs.down_source_only) ? `${cs.down_source_only} not recording` : null,
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
          {/* Nothing NetMon can reach measures whether a camera is actually
              writing to disk: ESS recording events are motion-triggered, and
              consumed disk space needs WinRM. This used to read a Milestone
              *config* flag and report 2,651 recording — including 234 behind a
              full recorder. An honest gap beats a confident wrong number. */}
          <StatCell label="Recording now" source="milestone"
                    value={summary.cameras_recording_known
                      ? fmtN(summary.cameras_recording) : null}
                    unit={summary.cameras_recording_known
                      ? `/ ${fmtN(summary.cameras_total)}` : undefined}
                    sub={summary.cameras_recording_known
                      ? "motion-triggered — stopped is normal"
                      : "not measured — see the camera state above"}
                    subTone={summary.cameras_recording_known ? undefined : "warn"} />
        </div>
      </Card>

      <Tabs tabs={tabs} active={tab} onChange={setTab} />

      {tab === "overview" && (
        <OverviewTab summary={summary} storagePct={storagePct} sites={sites}
                     servers={servers} alarms={alarms} meta={meta} clusters={clusters}
                     onPickSite={(s) => {
                       // The camera fleet lives on its own page now, so a
                       // school tile navigates there pre-filtered rather than
                       // switching a tab in place.
                       location.hash = "#/cameras" + (s ? `?q=${encodeURIComponent(s)}` : "");
                     }} />
      )}
      {tab === "sites" && <SitesTab sites={sites} context={context} />}
      {tab === "servers" && <ServersTab rows={servers} />}
      {tab === "storage" && <StorageTab summary={summary} context={context} />}
      {tab === "alarms" && (
        <AlarmsTab rows={alarms} onChanged={() => loadRef.current && loadRef.current()} />
      )}
      {tab === "evidence" && <EvidenceLockTab />}
      {tab === "firmware" && (role === "admin"
        ? <CameraOpsTab pick />
        : <Card title="Firmware" source="netmon">
            <div className="msg">
              Bulk firmware operations are admin-only. Every endpoint behind this
              tab enforces the same floor, so this is a closed door rather than a
              hidden one.
            </div>
          </Card>)}
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
          unreachable / not recording
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
          {scored.reduce((n2, r) => n2 + r.down_source_only, 0)} not recording ·{" "}
          {scored.reduce((n2, r) => n2 + r.down_confirmed, 0)} unreachable across{" "}
          {scored.length} school(s)
        </span>
      </div>
    </Card>
  );
}

// Cameras do not fail simultaneously. When a couple of hundred change state in
// the same second they share something — the recorder, its storage, its uplink
// — and showing that as N camera outages sends an operator to the cameras.
//
// This is the card that would have said, on 2026-09-11, "234 cameras went down
// in the same second, all behind NHS-BCD-DVR — that is one fault, not 234",
// instead of "237 down cameras" while every one of them answered ICMP.
export function CommonCause({ clusters }) {
  if (!clusters || clusters.length === 0) return null;
  return (
    <Card title="Changed together" kicker="one fault, not many" tight>
      <div style={{ fontSize: 11, color: "var(--muted)", lineHeight: 1.5,
                    marginBottom: 8 }}>
        Cameras that changed state within seconds of each other, grouped by what
        they share. Look at the recorder before the cameras.
      </div>
      {clusters.map((c, i) => (
        <div key={i} style={{ display: "flex", gap: 10, alignItems: "baseline",
                              padding: "7px 0", borderTop: "1px solid var(--line)" }}>
          <span style={{ fontFamily: "var(--mono)", fontSize: 16,
                         color: sevColor(c.new_value === "down" ? "crit" : "warn"),
                         minWidth: 46, textAlign: "right" }}>
            {c.cameras}
          </span>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 12, lineHeight: 1.45 }}>{c.reading}</div>
            <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>
              {String(c.at).replace("T", " ").slice(0, 19)}
              {c.site ? ` · ${c.site}` : ""}
              {c.span_s > 0 ? ` · spread over ${c.span_s}s` : " · same second"}
            </div>
          </div>
        </div>
      ))}
    </Card>
  );
}

export function OverviewTab({ summary, storagePct, sites, servers, alarms, meta,
                             clusters, onPickSite }) {
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
      {/* Above everything: if two hundred cameras changed together, that fact
          reframes every number below it. */}
      <CommonCause clusters={clusters} />
      {/* Then, because "which school has a problem" is the question this page
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
                    <td className="mono">{summary.management_server || meta?.milestone_host
                      || <span className="dim">—</span>}</td></tr>
                <tr><td>XProtect</td><td>
                  {summary.license_product || <span className="dim">—</span>}
                  {summary.version && <span className="dim mono"> · {summary.version}</span>}
                </td></tr>
                <tr><td>Device licences</td><td>
                  {summary.license_activated
                    ? <>
                        <span className="mono">{fmtN(summary.license_activated)}</span> activated
                        {summary.license_not_licensed
                          ? <span style={{ color: sevColor("warn") }}>
                              {" · "}{summary.license_not_licensed} not licensed</span>
                          : <span className="dim"> · none unlicensed</span>}
                      </>
                    : <span className="dim">—</span>}
                  {/* No total: Professional+ licenses per activated device, so
                      the used/total ratio ZCD draws as a bar does not exist in
                      either licence response. */}
                </td></tr>
                <tr><td>Recording servers</td>
                    <td><Dot severity={rsAllUp ? "ok" : "crit"} /> {summary.servers_up} of{" "}
                        {summary.servers_total} online</td></tr>
                <tr><td>Cameras</td>
                    <td>{fmtN(summary.cameras_total)} registered ·{" "}
                        {summary.cameras_recording_known
                          ? `${fmtN(summary.cameras_recording)} recording now`
                          : <span className="dim">recording not measured</span>}</td></tr>
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

      <CameraTrend />

      <Card title="Active alarm feed" source="netmon"
            kicker="open NetMon alerts on cameras and recorders"
            link={{ href: "#/problems", label: "Problems console" }} tight>
        <AlarmFeed rows={alarms} limit={10} />
      </Card>
    </React.Fragment>
  );
}

// One Events/State verdict. The state NAME is shown, not a severity word,
// because the name is the VMS's own vocabulary and an operator reading
// "Retention time Warning" in Smart Client should see the same phrase here.
// The tone is derived from the tail, and Undefined is dim rather than green —
// "the VMS has no opinion" is not health.
export function EssState({ value, at }) {
  if (!value) return <span className="dim">—</span>;
  const tail = String(value).split(" ").pop().toLowerCase();
  const tone = tail === "critical" || tail === "error" ? "crit"
    : tail === "warning" ? "warn"
    : tail === "normal" || tail === "started" || tail === "available" ? "ok"
    : "";
  const age = ageOf(at);
  return (
    <span className={"state-pill " + (tone === "crit" ? "err" : tone === "warn" ? "warn"
                                      : tone === "ok" ? "ok" : "")}
          title={`${value}${age ? ` · state set ${age} ago` : ""}`}>
      {/* The group prefix is the column header, so the cell shows the verdict. */}
      {String(value).replace(/^(Communication|CPU Usage|Retention time|Service Available)\s*/, "")
        || value}
    </span>
  );
}

// ZCD's "Live Ingress · 24h" slot. Ingress Gbps, storage write and recorder CPU
// are agent-domain numbers NetMon does not collect; what it does sample is the
// estate's reachability shape, one series per tier (D3's ring buffer, 24h).
// Each tier is its own line because they do not move together: a switch outage
// moves down_confirmed, a recorder losing its cameras moves down_source_only.
export function CameraTrend() {
  const [series, setSeries] = React.useState(null);
  React.useEffect(() => {
    let live = true;
    getJSON("/api/history?series=" + encodeURIComponent(
      "surveillance.cameras_up,surveillance.down_confirmed,"
      + "surveillance.down_source_only,surveillance.down_network_only,surveillance.blind"))
      .then((r) => live && setSeries(r.series || {}))
      .catch(() => live && setSeries({}));
    return () => { live = false; };
  }, []);
  if (!series) return <Card title="Cameras · 24h"><Loading what="history" /></Card>;

  const LINES = [
    ["surveillance.cameras_up", "Up", "ok"],
    ["surveillance.down_confirmed", "Unreachable", "crit"],
    ["surveillance.down_source_only", "Not recording", "crit"],
    ["surveillance.down_network_only", "No ICMP", "warn"],
    ["surveillance.blind", "Blind", "warn"],
  ];
  const have = LINES.filter(([k]) => (series[k] || []).length >= 2);
  if (have.length === 0) {
    return (
      <Card title="Cameras · 24h" source="netmon">
        <div className="msg">
          Not enough history yet. The sampler writes one point per series every
          few minutes into a 24-hour ring buffer, so a chart appears once two
          points exist — after a restart that takes a few minutes.
        </div>
      </Card>
    );
  }
  return (
    <Card title="Cameras · 24h" source="netmon"
          kicker="reachability by tier — one line each, they do not move together">
      <div className="trend-rows">
        {have.map(([key, label, tone]) => {
          const pts = series[key];
          const last = pts[pts.length - 1]?.value;
          return (
            <div className="trend-row" key={key}>
              <div className="trend-label">
                <Dot severity={tone} /> {label}
              </div>
              <Sparkline points={pts} color={sevColor(tone)} width={520} height={34} />
              <div className="trend-val mono">{last == null ? "—" : fmtN(last)}</div>
            </div>
          );
        })}
      </div>
    </Card>
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

export function AlarmFeed({ rows, limit, actions }) {
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
        <div key={a.id}
             className={"alarm-row" + (a.acked_by ? " ack" : "") + (actions ? " has-act" : "")}>
          <div className="ts">{ageOf(a.opened_at) || "?"} ago</div>
          <SevText severity={a.severity} />
          <div><Dot severity={a.severity} /></div>
          <div className="obj"><a href={alarmHref(a)}>{a.device_name || `device ${a.device_id}`}</a></div>
          <div className="msg">{a.rule_name}</div>
          <div className="site">
            {a.site || "—"}
            {a.acked_by && <span className="dim"> · ack {a.acked_by}</span>}
          </div>
          {actions && <div className="act">{actions(a)}</div>}
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

// ── Sites (S6) ────────────────────────────────────────────────────────────
//
// ZCD's Sites table, minus its Network and VLAN columns — those are the
// switching domain and live on #/switches, and duplicating them here would
// invite two answers to one question. What replaces them is the pair of facts a
// surveillance operator actually wants beside a school: which recorder serves
// it, and how much network it has (a school with 65 APs and one camera down is
// a different conversation from one with four).
//
// Two sources stitched by site name: /sites counts cameras by failure shape,
// /site-context carries recorders, configured storage and the registry's
// switch/AP counts. A school in one and not the other still gets a row.

// Configured capacity as a bar, scaled to the largest school rather than to a
// percentage — there is no consumed-space figure to make a percentage out of
// (spec 19 §8), and a bar that looks like utilisation would be read as
// utilisation. The "used —" beside it says so in words as well.
function CapacityBar({ gb, max }) {
  const n = Number(gb) || 0;
  const pct = max > 0 ? Math.max(2, Math.round((n / max) * 100)) : 0;
  if (!n) return <span className="dim">—</span>;
  return (
    <span className="cap-cell" title={`${fmtGb(n)} configured · relative to the largest school`}>
      <span className="util-bar cfg"><i style={{ width: `${pct}%` }} /></span>
      <span className="mono">{fmtGb(n)}</span>
      <span className="dim"> used —</span>
    </span>
  );
}

export function SitesTab({ sites, context }) {
  if (!sites) return <Loading what="sites" />;
  const ctx = new Map((context || []).map((c) => [c.site, c]));
  const rows = [...sites].sort((a, b) => String(a.site || "").localeCompare(String(b.site || "")));
  const maxGb = Math.max(0, ...(context || []).map((c) => Number(c.storage_total_gb) || 0));

  return (
    <Card title="Schools" source="milestone"
          kicker={`${rows.length} school(s) with cameras`}>
      {rows.length === 0 ? (
        <div className="msg">No cameras are attributed to a site yet.</div>
      ) : (
        <table className="link-tbl">
          <thead>
            <tr>
              <th style={{ width: 24 }}></th>
              <th>School</th><th>Recording server</th><th>Cameras</th><th>Health</th>
              <th>Storage configured</th><th>Retention</th><th style={{ width: 20 }}></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const c = ctx.get(r.site) || {};
              const down = num(r.down_confirmed) + num(r.down_source_only);
              const soft = num(r.down_network_only) + num(r.blind);
              const sev = down ? "crit" : soft ? "warn" : num(r.total) ? "ok" : "unknown";
              return (
                <tr key={r.site || "__none"} className={down ? "row-err" : ""}>
                  <td><Dot severity={sev} /></td>
                  <td>
                    {r.site || <span className="dim">no site</span>}
                    <div className="dim" style={{ fontSize: 10.5 }}>
                      {num(c.switches)} switch{num(c.switches) === 1 ? "" : "es"}
                      {" · "}{num(c.aps)} AP{num(c.aps) === 1 ? "" : "s"}
                    </div>
                  </td>
                  <td className="mono" style={{ fontSize: 11 }}>
                    {/* The recorder's own name, not a count: at a school with
                        one recorder the count is noise and the name answers
                        "who records this". */}
                    {c.recorder_names
                      ? String(c.recorder_names).split(", ").map((h) => h.split(".")[0]).join(", ")
                      : <span className="dim">none linked</span>}
                  </td>
                  <td className="mono">{fmtN(r.up)} / {fmtN(r.total)}</td>
                  <td>
                    {down === 0 && soft === 0 ? (
                      <span className="state-pill ok">all clear</span>
                    ) : (
                      <span className={"state-pill " + (down ? "err" : "warn")}>
                        {[num(r.down_confirmed) ? `${r.down_confirmed} down` : null,
                          num(r.down_source_only) ? `${r.down_source_only} not recording` : null,
                          num(r.down_network_only) ? `${r.down_network_only} no ICMP` : null,
                          num(r.blind) ? `${r.blind} blind` : null].filter(Boolean).join(" · ")}
                      </span>
                    )}
                  </td>
                  <td><CapacityBar gb={c.storage_total_gb} max={maxGb} /></td>
                  <td className="mono dim">
                    {c.retention_days ? `${c.retention_days}d` : "—"}
                  </td>
                  <td>
                    <a className="chev" title={`cameras at ${r.site || "this site"}`}
                       href={"#/cameras" + (r.site ? `?q=${encodeURIComponent(r.site)}` : "")}>›</a>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <div className="msg" style={{ fontSize: 11, marginTop: 10 }}>
        Camera counts are the reachability tiers, kept apart on purpose: a
        school with cameras Milestone cannot reach has a different problem from
        one with cameras that are genuinely dead. Switch and AP counts come from
        the registry — what is installed, true even while XIQ is blind. Storage
        is the <em>configured</em> size; consumed space is not in the Config API.
        Network and VLAN columns are deliberately absent — that is the switching
        domain, and it has its own page.
      </div>
    </Card>
  );
}

export function ServersTab({ rows }) {
  if (!rows) return <Loading what="recording servers" />;
  // Bars scaled to the biggest recorder, for the same reason as the Sites tab:
  // configured capacity has no percentage to be a fraction of, so the bar
  // compares recorders to each other and says "configured" in words.
  const maxGb = Math.max(0, ...rows.map((r) => Number(r.storage_total_gb) || 0));
  return (
    <Card title="Recording servers" source="milestone"
          kicker={`${rows.length} recording server(s)`}>
      {rows.length === 0 ? <div className="msg">No recording servers cached.</div> : (
        <table className="grid nvr-tbl">
          <thead><tr><th></th><th>Server</th><th>Site</th><th>Cameras</th><th>Recording</th>
                     <th>Service</th><th>CPU</th><th>Retention state</th>
                     <th>Storage configured</th><th>Retention</th><th>Version</th></tr></thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.device_id} className={s.status === "down" ? "row-err" : ""}>
                <td><StateDot value={s.status} /></td>
                <td>{s.name}<div className="dim mono" style={{ fontSize: 11 }}>{s.hostname || ""}</div></td>
                <td>{s.site || "—"}</td>
                <td className="mono">{s.chans_total ?? "—"}</td>
                <td className="mono">{s.chans_recording ?? "—"}</td>
                <td><EssState value={s.service_state} at={s.states_at} /></td>
                <td><EssState value={s.cpu_state} at={s.states_at} /></td>
                <td><EssState value={s.retention_state} at={s.states_at} /></td>
                <td className="cap-cell">
                  <span className="util-bar cfg" title={`${fmtGb(s.storage_total_gb)} configured`}>
                    <i style={{ width: `${maxGb > 0 && s.storage_total_gb
                      ? Math.max(2, Math.round((s.storage_total_gb / maxGb) * 100)) : 0}%` }} />
                  </span>
                  <span className="mono">{fmtGb(s.storage_total_gb)}</span>
                  <span className="dim"> used —</span>
                </td>
                <td className="mono dim">{s.retention_days ? `${s.retention_days}d` : "—"}</td>
                <td className="mono dim">{s.version || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {/* Named, not implied: ZCD's equivalent table has CPU / Mem / RAID /
          uptime columns fed by a Windows agent NetMon does not have. */}
      <div className="msg" style={{ fontSize: 11, marginTop: 10 }}>
        Service, CPU and retention are the verdicts Milestone's Events/State
        interface publishes — a state, not a measurement. Hover for how old each
        set is: on this estate half the recorders carry a
        <em> Service Available Critical</em> state months old, which reads far
        more like a state group that was never cleared than like an outage, so
        none of these three raise alerts. Numeric CPU, memory, disk and RAID need
        WinRM access to the recorders (OpenProject #111). Storage is the
        <em> configured</em> size; consumed space is not in the Config API.
      </div>
    </Card>
  );
}

export function AlarmsTab({ rows, onChanged, role: roleProp }) {
  const [sev, setSev] = React.useState("all");
  const [ackFilter, setAckFilter] = React.useState("all");
  const [busy, setBusy] = React.useState(null);
  const [err, setErr] = React.useState(null);
  // Who is looking. The API enforces the operator role on every one of these
  // three; asking here as well is so a viewer sees an explanation instead of
  // three buttons that answer 403. `roleProp` lets the render check drive it.
  const [role, setRole] = React.useState(roleProp || null);
  React.useEffect(() => {
    if (roleProp) return undefined;
    let live = true;
    getJSON("/auth/me").then((me) => live && setRole(me?.role || "viewer"))
      .catch(() => live && setRole("viewer"));
    return () => { live = false; };
  }, [roleProp]);
  const canAct = role === "operator" || role === "admin";

  // ZCD's row actions were inert. These are the Problems console's handlers,
  // reused rather than reimplemented, so the two consoles cannot drift into
  // disagreeing about what "acknowledge" does.
  async function act(id, fn) {
    setBusy(id);
    setErr(null);
    try {
      await fn();
      onChanged?.();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(null);
    }
  }
  const doAck = (a) => act(a.id, () => postJSON(`/api/alerts/${a.id}/ack`));
  const doSuppress = (a) => act(a.id, () => postJSON(`/api/alerts/${a.id}/suppress`));
  const doAssign = (a) => {
    const who = window.prompt(`Assign "${a.rule_name}" on ${a.device_name || a.device_id} to:`,
                              a.assigned_to || "");
    if (who === null) return undefined;
    return act(a.id, () => postJSON(`/api/alerts/${a.id}/assign`, { assignee: who }));
  };

  const rowActions = canAct ? (a) => (
    <React.Fragment>
      {!a.acked_by && (
        <button type="button" className="btn sm" disabled={busy === a.id}
                onClick={() => doAck(a)} title="acknowledge this alert">Ack</button>
      )}
      <button type="button" className="btn sm" disabled={busy === a.id}
              onClick={() => doAssign(a)}
              title={a.assigned_to ? `assigned to ${a.assigned_to}` : "assign to someone"}>
        Assign
      </button>
      <button type="button" className="btn sm" disabled={busy === a.id}
              onClick={() => doSuppress(a)}
              title="suppress notifications for this device for one hour — the alert stays visible and keeps updating">
        Suppress 1h
      </button>
    </React.Fragment>
  ) : null;

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
    && (ackFilter === "all" || (ackFilter === "unack" ? !a.acked_by : !!a.acked_by)));

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
            <span key={k} className={`tf ${cls} ${ackFilter === k ? "active" : ""}`}
                  onClick={() => setAckFilter(k)}>{label} <b>{n}</b></span>
          ))}
        </div>
      </div>

      <Card tight
            kicker={`${shown.length} of ${rows.length} shown`}
            link={{ href: "#/problems", label: "Every alert, all domains → Problems" }}>
        {err && <ErrorMsg error={err} />}
        {rows.length === 0 ? (
          <div className="msg" style={{ padding: 14 }}>
            No open alerts on cameras or recording servers.
          </div>
        ) : shown.length === 0 ? (
          <div className="msg" style={{ padding: 14 }}>No alarms match this filter.</div>
        ) : (
          <AlarmFeed rows={shown} actions={rowActions} />
        )}
        <div className="msg" style={{ fontSize: 11, padding: "10px 14px 0" }}>
          {canAct ? (
            <React.Fragment>
              Acknowledge and assign write to the alert. <b>Suppress 1h</b>
              {" "}opens a one-hour maintenance window on that device: it stops
              the engine emailing about it and does not stop the state being
              recorded, so the alert stays visible here and keeps updating.
            </React.Fragment>
          ) : (
            <React.Fragment>
              Acknowledging, assigning and suppressing need the operator role;
              this session is read-only, so those actions are not shown rather
              than shown and refused.
            </React.Fragment>
          )}
        </div>
      </Card>
    </React.Fragment>
  );
}

// ZCD's storage ring, drawn only when there is a fraction to draw. A ring is a
// claim about *proportion*, so it must never be rendered from configured size
// alone — an 84%-looking arc over a number nobody measured is the single most
// misleading thing this page could show (CLAUDE.md §4.5).
export function StorageRing({ pct, label, sub, tone = "ok", size = 96 }) {
  const r = (size - 12) / 2;
  const circ = 2 * Math.PI * r;
  const frac = Math.max(0, Math.min(100, Number(pct) || 0)) / 100;
  return (
    <div className="ring" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--bg-3)" strokeWidth="8" />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={sevColor(tone)}
                strokeWidth="8" strokeLinecap="round"
                strokeDasharray={`${circ * frac} ${circ}`}
                transform={`rotate(-90 ${size / 2} ${size / 2})`} />
      </svg>
      <div className="ring-label">
        <div className="ring-val">{label}</div>
        {sub && <div className="ring-sub">{sub}</div>}
      </div>
    </div>
  );
}

export function StorageTab({ summary, context }) {
  const [rows, setRows] = React.useState(null);
  React.useEffect(() => { getJSON("/api/surveillance/storage").then(setRows).catch(() => setRows([])); }, []);
  if (!rows) return <Loading what="storage" />;
  return <StorageView rows={rows} summary={summary} context={context} />;
}

// The render half, split from the fetch so the render check can drive it with
// fixed data — the same reason CamerasView is split, and the reason the
// no-fraction branch below can be exercised at build time rather than only on
// an estate that happens to lack a used figure.
export function StorageView({ rows, summary, context }) {
  const usedKnown = summary ? usedIsKnown(summary) : false;
  const totalGb = summary ? Number(summary.storage_total_gb) || 0 : 0;
  const pct = usedKnown && totalGb
    ? Math.round((Number(summary.storage_used_gb) / totalGb) * 100) : null;
  const sites = [...(context || [])]
    .filter((c) => Number(c.storage_total_gb) > 0)
    .sort((a, b) => Number(b.storage_total_gb) - Number(a.storage_total_gb));
  const maxGb = Math.max(0, ...sites.map((c) => Number(c.storage_total_gb) || 0));

  return (
    <React.Fragment>
      <Card title="Fleet storage" source="milestone"
            kicker={`${rows.length} recorder(s) · ${sites.length} school(s)`}>
        <div className="fleet-storage">
          {/* The ring slot. Filled with an arc only when a fraction exists;
              otherwise it carries the configured total and the reason there is
              no fraction, which is the honest version of the same slot. */}
          {pct !== null ? (
            <StorageRing pct={pct} label={`${pct}%`} sub="used"
                         tone={pct >= 90 ? "crit" : pct >= 75 ? "warn" : "ok"} />
          ) : (
            <div className="fleet-nofrac">
              <div className="v mono">{fmtGb(totalGb)}</div>
              <div className="k">configured</div>
            </div>
          )}
          <div className="fleet-note">
            {pct !== null ? (
              <React.Fragment>
                {fmtGb(summary.storage_used_gb)} of {fmtGb(totalGb)} used across
                every recorder.
              </React.Fragment>
            ) : (
              <React.Fragment>
                <b>Consumed space is not exposed.</b> The Config API on XProtect
                2025 R2 publishes each storage's <em>configured</em> size and its
                retention, and no field for what is on disk — so there is no
                percentage to draw, and a ring here would be an invention. The
                figure above is what the recorders are configured to hold.
                Reading actual disk use needs WinRM access to the recorders
                (OpenProject #111).
              </React.Fragment>
            )}
            <div className="dim" style={{ marginTop: 6 }}>
              Over-commit — configured capacity exceeding the physical disk —
              cannot be checked for the same reason. It stays a named gap.
            </div>
          </div>
        </div>
      </Card>

      {sites.length > 0 && (
        <Card title="Per-school capacity" source="milestone"
              kicker="configured, largest first" tight>
          <table className="link-tbl">
            <thead><tr><th>School</th><th>Recorder</th><th>Configured</th><th>Retention</th></tr></thead>
            <tbody>
              {sites.map((c) => (
                <tr key={c.site || "__none"}>
                  <td>{c.site || <span className="dim">no site</span>}</td>
                  <td className="mono" style={{ fontSize: 11 }}>
                    {c.recorder_names
                      ? String(c.recorder_names).split(", ").map((h) => h.split(".")[0]).join(", ")
                      : <span className="dim">—</span>}
                  </td>
                  <td><CapacityBar gb={c.storage_total_gb} max={maxGb} /></td>
                  <td className="mono dim">{c.retention_days ? `${c.retention_days}d` : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

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
    </React.Fragment>
  );
}

// ── Evidence Lock (S6) ────────────────────────────────────────────────────
//
// A tab with no data behind it, which exists so the nav matches ZCD's and says
// what is missing. Probed against the live gateway on 2026-09-08:
// `GET /api/rest/v1/evidenceLocks` answers **400 "Bad request: Unknown
// request"**, and the singular spelling 404s — the Config API on 2025 R2 does
// not publish evidence locks at all. They live in the Management/Event server
// interface the MIP SDK speaks, which is a different protocol from the REST
// API every other Milestone reader here uses.
//
// ZCD's own Evidence Lock tab was a mock: static rows, and Extend/Export
// buttons that did nothing. An empty tab with the reason is worth more than a
// convincing table of invented locks.
export function EvidenceLockTab() {
  return (
    <Card title="Evidence Lock" source="milestone"
          kicker="not exposed by the Config API">
      <div className="msg">
        <b>XProtect does not publish evidence locks over the REST Config API.</b>
        {" "}Asked directly on 2026-09-08, the gateway answers
        {" "}<span className="mono">GET /api/rest/v1/evidenceLocks</span> with
        {" "}<span className="mono">400 · "Bad request: Unknown request"</span>,
        and the singular spelling with a 404. Every other reader on this page —
        cameras, recorders, storage, groups, licences — comes from that same
        API, so there is nothing to fall back to.
        <div style={{ marginTop: 8 }}>
          Locks are managed through the Management/Event server interface, which
          the MIP SDK speaks and NetMon does not. Until that is built, evidence
          locks live in Smart Client: <em>Search → Evidence lock list</em>.
        </div>
        <div className="dim" style={{ marginTop: 8 }}>
          The tab is here rather than hidden because ZCD's nav has it and
          because a named gap outlasts a missing one. ZCD's own version was a
          mock — static rows with inert Extend and Export buttons — so nothing
          working is being lost.
        </div>
      </div>
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
