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

      <div className="stat-row">
        <div className="stat"><div className="stat-value">{summary.cameras_total}</div><div className="stat-label">Cameras</div></div>
        <div className="stat"><div className="stat-value" style={{ color: sevColor("ok") }}>{summary.cameras_recording}</div>
          <div className="stat-label">Recording</div></div>
        <div className="stat"><div className="stat-value" style={summary.cameras_not_recording ? { color: sevColor("crit") } : undefined}>
          {summary.cameras_not_recording}</div><div className="stat-label">Not recording</div></div>
        {summary.cameras_blind > 0 && (
          <div className="stat"><div className="stat-value" style={{ color: sevColor("warn") }}>{summary.cameras_blind}</div>
            <div className="stat-label">Blind</div></div>)}
        <div className="stat"><div className="stat-value">{summary.servers_up}/{summary.servers_total}</div>
          <div className="stat-label">Recording servers up</div></div>
        <div className="stat"><div className="stat-value" style={storagePct >= 90 ? { color: sevColor("crit") } : storagePct >= 75 ? { color: sevColor("warn") } : undefined}>
          {storagePct !== null ? `${storagePct}%` : fmtGb(summary.storage_total_gb)}</div>
          <div className="stat-label">Storage used</div></div>
      </div>

      <div className="tabs">
        {TABS.map((t) => (
          <button key={t.id} type="button" className={"tab" + (tab === t.id ? " active" : "")}
                  onClick={() => setTab(t.id)}>{t.label}</button>
        ))}
      </div>

      {tab === "overview" && <OverviewTab summary={summary} storagePct={storagePct} />}
      {tab === "cameras" && <CamerasTab />}
      {tab === "servers" && <ServersTab />}
      {tab === "storage" && <StorageTab />}
    </div>
  );
}

export function OverviewTab({ summary, storagePct }) {
  const usedKnown = usedIsKnown(summary);
  return (
    <React.Fragment>
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

function CamerasTab() {
  const [rows, setRows] = React.useState(null);
  const [q, setQ] = React.useState("");
  const [detail, setDetail] = React.useState(null);
  React.useEffect(() => {
    const id = setTimeout(() =>
      getJSON("/api/surveillance/cameras" + qs({ q })).then(setRows).catch(() => setRows([])), 250);
    return () => clearTimeout(id);
  }, [q]);
  return (
    <React.Fragment>
      <Card kicker={rows ? `${rows.length} camera(s)` : "Cameras"}>
        <label className="evt-filter evt-filter-grow" style={{ marginBottom: 8 }}>
          <span>Search</span>
          <input type="text" placeholder="name, model, IP, MAC…" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
        {!rows ? <Loading what="cameras" /> : rows.length === 0 ? (
          <div className="msg">No cameras cached — the Milestone collector hasn't populated the camera table.</div>
        ) : (
          <table className="grid">
            <thead><tr><th></th><th>Camera</th><th>Site</th><th>Model</th><th>Resolution</th>
                       <th>FPS</th><th>Server</th><th>IP</th><th></th></tr></thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.device_id}>
                  <td><StateDot value={c.recording_state} /></td>
                  <td>{c.name}</td>
                  <td>{c.site || "—"}</td>
                  <td className="dim">{c.model || "—"}</td>
                  <td className="mono dim">{c.resolution || "—"}</td>
                  <td className="mono dim">{c.fps_target ?? "—"}</td>
                  <td className="dim">{c.recording_server || "—"}</td>
                  <td className="mono dim">{c.ip || "—"}</td>
                  <td><button type="button" className="btn" onClick={() =>
                    getJSON(`/api/surveillance/cameras/${c.device_id}`).then(setDetail)}>Detail</button></td>
                </tr>
              ))}
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
