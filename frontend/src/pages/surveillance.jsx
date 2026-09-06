import React from "react";
import { getJSON, qs } from "../api.js";
import { Card, Loading, ErrorMsg, SourceBadge, sevColor } from "../primitives.jsx";
import { ageOf } from "../format.js";

// Surveillance (Milestone) — Phase 10.4. NOC overview + cameras + recording
// servers + storage, all from NetMon's DB (Config-API cadence). Camera detail
// shows the FDB-linked switch port. Live alarms need the ESS WebSocket (D5);
// the Alarms view meanwhile is NetMon alerts scoped to surveillance devices
// (Events/Problems consoles). Camera video is not proxied (D7) — status tiles
// + deep link to Smart Client.

const REFRESH_MS = 30000;

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

const fmtGb = (gb) => gb === null || gb === undefined ? "—"
  : gb >= 1000 ? `${(gb / 1024).toFixed(1)} TB` : `${Math.round(gb)} GB`;

const TABS = [
  { id: "overview", label: "NOC Overview" },
  { id: "cameras", label: "Cameras" },
  { id: "servers", label: "Recording Servers" },
  { id: "storage", label: "Storage" },
];

function StateDot({ value }) {
  const sev = value === "up" ? "ok" : value === "down" ? "crit" : value === "blind" ? "warn" : "unknown";
  return <span className="dot" style={{ background: sevColor(sev) }} title={value || "unknown"} />;
}

export function SurveillancePage() {
  const [tab, setTab] = React.useState("overview");
  const [summary, setSummary] = React.useState(null);
  const [error, setError] = React.useState(null);
  // Lifted out of CamerasTab so the by-school grid can drive it: clicking a
  // school on the overview is the same gesture as filtering the camera list.
  const [site, setSite] = React.useState("");

  React.useEffect(() => {
    let live = true;
    const load = () => getJSON("/api/surveillance/summary")
      .then((s) => { if (live) { setSummary(s); setError(null); } })
      .catch((e) => { if (live) setError(e); });
    load();
    const id = setInterval(load, REFRESH_MS);
    return () => { live = false; clearInterval(id); };
  }, []);

  if (error) return <ErrorMsg error={error} />;
  if (!summary) return <Loading what="surveillance" />;

  const age = ageOf(summary.updated_at);
  // Consumed space is NOT available from the Config API — it needs WinRM
  // against the recorders (OpenProject #111). So a percentage cannot be
  // computed, and computing one from a null `used` would report "0% of
  // 1.8 PB" across the estate. The tile shows configured capacity, which is
  // real, and says plainly why the used figure is missing (§4.5).
  const usedKnown = usedIsKnown(summary);
  const cs = summary.cameras_by_status || {};
  const storagePct = usedKnown && summary.storage_total_gb
    ? Math.round((summary.storage_used_gb / summary.storage_total_gb) * 100) : null;

  return (
    <div className="page">
      <h1>Surveillance · Milestone</h1>
      <div className="subtitle">
        <SourceBadge source="milestone" /> · Config-API cadence · refreshes every {REFRESH_MS / 1000}s
        {age && <span> · cache {age} old</span>}
        {!summary.updated_at && <span style={{ color: sevColor("warn") }}> · no camera data yet</span>}
      </div>

      <UnlinkedBanner overview={summary.overview} />

      {/* ZCD's .stat-grid (surveillance.css). Six cells rather than four,
          because camera health here has three distinct failure shapes and
          collapsing them loses the one that decides the response. */}
      <Card tight>
        <div className="stat-grid cols-6">
          <div className="stat-cell">
            <span className="lbl">Cameras</span>
            <span className="val">{summary.cameras_total}</span>
            <span className="sub">{summary.servers_total} recorders</span>
          </div>
          <div className="stat-cell">
            <span className="lbl">Up</span>
            <span className="val" style={{ color: sevColor("ok") }}>{cs.up ?? "—"}</span>
            <span className="sub">both probes agree</span>
          </div>
          <div className="stat-cell">
            <span className="lbl">Down</span>
            <span className="val" style={cs.down_confirmed ? { color: sevColor("crit") } : undefined}>
              {cs.down_confirmed ?? "—"}</span>
            <span className="sub">Milestone + ICMP</span>
          </div>
          <div className="stat-cell">
            <span className="lbl">Milestone down</span>
            <span className="val" style={cs.down_source_only ? { color: sevColor("crit") } : undefined}>
              {cs.down_source_only ?? "—"}</span>
            <span className="sub">network reaches them</span>
          </div>
          <div className="stat-cell">
            <span className="lbl">Blind</span>
            <span className="val" style={cs.blind ? { color: sevColor("warn") } : undefined}>
              {cs.blind ?? "—"}</span>
            <span className="sub">no Milestone verdict</span>
          </div>
          <div className="stat-cell">
            <span className="lbl">Storage</span>
            <span className="val">{storagePct !== null ? `${storagePct}%` : fmtGb(summary.storage_total_gb)}</span>
            <span className="sub">{usedKnown ? "used" : "configured"}</span>
          </div>
        </div>
      </Card>

      <div className="tabs">
        {TABS.map((t) => (
          <button key={t.id} type="button" className={"tab" + (tab === t.id ? " active" : "")}
                  onClick={() => setTab(t.id)}>{t.label}</button>
        ))}
      </div>

      {tab === "overview" && (
        <OverviewTab summary={summary} storagePct={storagePct}
                     onPickSite={(s) => { setSite(s || ""); setTab("cameras"); }} />
      )}
      {tab === "cameras" && (
        <CamerasTab counts={summary.cameras_by_status} site={site} onSite={setSite} />
      )}
      {tab === "servers" && <ServersTab />}
      {tab === "storage" && <StorageTab />}
    </div>
  );
}

// Cameras by school, the same idiom as the XIQ page's APs-by-site grid. Tinted
// by the worst thing present rather than by a ratio: one dead camera at a small
// site matters as much as one at a large one, and a percentage hides that.
function CameraSiteGrid({ onPick }) {
  const [rows, setRows] = React.useState(null);
  const [filter, setFilter] = React.useState("all");
  React.useEffect(() => {
    // Rolled up server-side. The XIQ grid groups a list the page already has,
    // but there are 2,651 cameras here — shipping them all to the browser to
    // count them by site would be the slowest part of the page.
    getJSON("/api/surveillance/sites").then(setRows).catch(() => setRows([]));
  }, []);
  if (!rows) return <Card kicker="Cameras by school"><Loading what="sites" /></Card>;
  return <SiteTiles rows={rows} filter={filter} onFilter={setFilter} onPick={onPick} />;
}

// Split from the fetch above so the render check can exercise it with fixed
// rows — a component that only renders after a fetch never runs server-side.
export function SiteTiles({ rows, filter, onFilter, onPick }) {
  const scored = rows.map((r) => ({
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
    <Card kicker={`${scored.length} school(s) · ${issues.length} needing attention`}>
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
          {scored.reduce((n, r) => n + r.down_confirmed + r.down_source_only, 0)} camera(s) down
          across {scored.length} school(s)
        </span>
      </div>
    </Card>
  );
}

export function OverviewTab({ summary, storagePct, onPickSite }) {
  const usedKnown = usedIsKnown(summary);
  const cs = summary.cameras_by_status || {};
  return (
    <React.Fragment>
      {/* First, because "which school has a problem" is the question this page
          gets opened for. The environment roll-up below is context, not the
          lede. */}
      <CameraSiteGrid onPick={onPickSite} />
      <Card kicker="XProtect environment">
        <table className="grid kv">
          <tbody>
            <tr><td>Recording servers</td><td>{summary.servers_up} up / {summary.servers_total} total</td></tr>
            <tr><td>Cameras</td><td>{summary.cameras_recording} recording / {summary.cameras_total} total</td></tr>
            <tr><td>Storage configured</td><td className="mono">{fmtGb(summary.storage_total_gb)}</td></tr>
            <tr><td>Storage used</td><td>
              {usedKnown
                ? <span className="mono">{fmtGb(summary.storage_used_gb)}{storagePct !== null ? ` (${storagePct}%)` : ""}</span>
                : <span className="dim">not available — the Config API on XProtect 2025 R2
                    exposes configured size only, with no used-space field on the storage
                    object and no storageInformation resource</span>}
            </td></tr>
          </tbody>
        </table>
      </Card>
      <Card kicker="Alarms">
        <div className="msg">
          Live VMS alarms need the Milestone Events/State WebSocket (owner gate
          D5). Meanwhile surveillance-device alarms show on the Events and
          Problems consoles. Camera video is deep-linked to Smart Client, not
          proxied (D7).
        </div>
      </Card>
    </React.Fragment>
  );
}

export function CamerasTab({ counts, site = "", onSite }) {
  const [rows, setRows] = React.useState(null);
  const [q, setQ] = React.useState("");
  const [status, setStatus] = React.useState("");
  const [detail, setDetail] = React.useState(null);
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
    <React.Fragment>
      <Card kicker={rows ? `${rows.length} shown${site ? ` at ${site}` : ""}` : "Cameras"} tight>
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
      {detail && <CameraDetail cam={detail} onClose={() => setDetail(null)} />}
    </React.Fragment>
  );
}

function CameraDetail({ cam, onClose }) {
  const sp = cam.switch_port;
  return (
    <Card title={cam.name} kicker={`camera detail · cache ${ageOf(cam.updated_at) || "?"} old`}>
      <button type="button" className="btn" style={{ float: "right" }} onClick={onClose}>Close</button>
      <table className="grid kv">
        <tbody>
          <tr><td>Recording</td><td><StateDot value={cam.recording_state} /> {cam.recording_state || "unknown"}</td></tr>
          <tr><td>Model</td><td>{cam.model || "—"}</td></tr>
          <tr><td>Resolution</td><td className="mono">{cam.resolution || "—"}</td></tr>
          <tr><td>FPS target</td><td className="mono">{cam.fps_target ?? "—"}</td></tr>
          <tr><td>Codec</td><td className="mono">{cam.codec || "—"}</td></tr>
          <tr><td>IP</td><td className="mono">{cam.ip || "—"}</td></tr>
          <tr><td>MAC</td><td className="mono">{cam.mac || "—"}</td></tr>
          <tr><td>Recording server</td><td>{cam.recording_server || "—"}</td></tr>
          <tr><td>Linked switch port</td><td>
            {sp ? <span><b>{sp.switch}</b> · <span className="mono">{sp.port || "?"}</span>
                    <span className="dim"> (via FDB, {ageOf(sp.updated_at) || "?"} old)</span></span>
                : <span className="dim">not seen in any switch FDB table</span>}
          </td></tr>
        </tbody>
      </table>
    </Card>
  );
}

function ServersTab() {
  const [rows, setRows] = React.useState(null);
  React.useEffect(() => { getJSON("/api/surveillance/servers").then(setRows).catch(() => setRows([])); }, []);
  if (!rows) return <Loading what="recording servers" />;
  return (
    <Card kicker={`${rows.length} recording server(s)`}>
      {rows.length === 0 ? <div className="msg">No recording servers cached.</div> : (
        <table className="grid">
          <thead><tr><th></th><th>Server</th><th>Site</th><th>Role</th><th>Version</th>
                     <th>Channels</th><th>Storage</th><th>Retention</th></tr></thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.device_id}>
                <td><StateDot value={s.status} /></td>
                <td>{s.name}<div className="dim mono" style={{ fontSize: 11 }}>{s.hostname || ""}</div></td>
                <td>{s.site || "—"}</td>
                <td className="dim">{s.role || "—"}</td>
                <td className="mono dim">{s.version || "—"}</td>
                <td className="mono">{s.chans_recording ?? "—"}/{s.chans_total ?? "—"}</td>
                <td className="mono">{s.storage_total_gb
                  ? (s.storage_used_gb !== null && s.storage_used_gb !== undefined
                      ? `${Math.round(s.storage_used_gb)}/${Math.round(s.storage_total_gb)} GB`
                      : fmtGb(s.storage_total_gb))
                  : "—"}</td>
                <td className="mono dim">{s.retention_days ? `${s.retention_days}d` : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

export function StorageTab() {
  const [rows, setRows] = React.useState(null);
  React.useEffect(() => { getJSON("/api/surveillance/storage").then(setRows).catch(() => setRows([])); }, []);
  if (!rows) return <Loading what="storage" />;
  return (
    <Card kicker={`${rows.length} recorder(s)`}>
      {rows.length === 0 ? (
        <div className="msg">
          No storage rows cached yet. The collector walks the per-server
          endpoint; if this stays empty while the Milestone collector reads
          green, check NetMon Status for a degraded storage walk.
        </div>
      ) : (
        <table className="grid">
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
