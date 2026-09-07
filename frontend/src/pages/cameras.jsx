import React from "react";
import { getJSON, qs } from "../api.js";
import { Card, Loading, ErrorMsg, Dot, SourceBadge, sevColor, PageHeader } from "../primitives.jsx";
import { CameraDetailPage } from "./camera_detail.jsx";
import { CamThumb } from "./camera_snapshot.jsx";

// Cameras — the camera fleet as its own page, navigated by Milestone's own
// group tree (spec 20 S3, owner-directed 2026-09-07).
//
// This was a tab on #/surveillance. It is a page because it is where camera
// work actually happens, and because a 2,662-camera fleet needs a persistent
// navigator beside the detail rather than a table you leave and come back to.
// The layout deliberately mirrors #/wireless: same two-column shell, same
// collapse memory, same rule that a collapsed group still confesses its
// problems (CLAUDE.md §4.5).
//
// The tree axis is XProtect's cameraGroups — 26 groups named by school code —
// not `devices.site`. Those two agree closely on this estate but they are
// different facts: the group is how the surveillance team files a camera, the
// site is how the network resolver placed it. The owner asked for the Milestone
// tree, so the group is the spine and the site name rides along as a subtitle.

const REFRESH_MS = 30000;
const NAV_COLLAPSE_KEY = "netmon.cameras.collapsedGroups";

// Tier → dot severity. Blind is a warning, not a failure: it is the source
// saying it cannot tell (spec 19 §13).
const TIER_SEV = {
  up: "ok",
  down_confirmed: "crit",
  down_source_only: "crit",
  down_network_only: "warn",
};
// The filter vocabulary the removed Cameras tab carried as chips. Kept whole,
// as a select rather than a chip row, because the navigator rail is 380px and
// seven chips wrap into an unreadable block (spec 19 §14).
export const STATUS_FILTERS = [
  ["", "All cameras"],
  ["problems", "Anything not simply up"],
  ["down_confirmed", "Down — both probes agree"],
  ["down_source_only", "Milestone down — network reaches it"],
  ["down_network_only", "No ICMP"],
  ["blind", "Blind — no Milestone verdict"],
  ["up", "Up"],
];

// Does a camera match one filter value? `problems` is the union of every tier
// that is not plainly up, plus blind — the question an operator actually asks.
export function matchesStatus(cam, status) {
  if (!status) return true;
  const blind = cam.source_status === "blind";
  if (status === "blind") return blind;
  if (status === "problems") return blind || (cam.reachability && cam.reachability !== "up");
  if (status === "up") return !blind && cam.reachability === "up";
  return cam.reachability === status;
}

const TIER_LABEL = {
  up: "Up — platform and network both reach it",
  down_confirmed: "Down — Milestone and ICMP agree it is unreachable",
  down_source_only: "Milestone down — the network reaches it, Milestone cannot",
  down_network_only: "No ICMP — never answers ping; most camera models never do",
};

function camSev(cam) {
  if (cam.source_status === "blind") return "warn";
  return TIER_SEV[cam.reachability] || "unknown";
}

function camTitle(cam) {
  if (cam.source_status === "blind") return "Blind — Milestone has no verdict for this camera";
  return TIER_LABEL[cam.reachability] || "Unknown — no probe has an opinion";
}

function loadCollapsed() {
  try {
    const raw = localStorage.getItem(NAV_COLLAPSE_KEY);
    return raw ? new Set(JSON.parse(raw)) : null;
  } catch {
    return null;  // private mode / corrupt value — fall back to defaults
  }
}

function saveCollapsed(set) {
  try {
    localStorage.setItem(NAV_COLLAPSE_KEY, JSON.stringify([...set]));
  } catch {
    /* non-fatal: collapse state is a convenience, not data */
  }
}

// One group node and its cameras. Exported for the render check.
export function GroupNode({ group, rows, activeId, collapsed, onToggle, depth = 0 }) {
  const n = (v) => Number(v) || 0;
  // Counted from the group's own roll-up, not from `rows` — `rows` is the
  // filtered view, and a search must not make a school look healthy.
  const bad = n(group.down_confirmed) + n(group.down_source_only);
  const soft = n(group.down_network_only) + n(group.blind);
  const worst = bad ? "crit" : soft ? "warn" : n(group.total) ? "ok" : "unknown";
  const holdsActive = rows.some((c) => String(c.device_id) === String(activeId));
  // Milestone counts children NetMon may not have imported. A gap is a real
  // finding — cameras in the VMS that the registry has never seen.
  const missing = n(group.milestone_camera_count) - n(group.total);

  return (
    <div className="host-nav-section" style={depth ? { marginLeft: depth * 10 } : undefined}>
      <div className={"host-nav-site" + (collapsed ? " collapsed" : "")}
           role="button" tabIndex={0}
           aria-expanded={!collapsed}
           onClick={() => onToggle(group.id)}
           onKeyDown={(e) => {
             if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggle(group.id); }
           }}
           title={`${group.name}${group.site_display_name ? ` — ${group.site_display_name}` : ""}` +
                  ` · ${n(group.total)} camera(s)` +
                  `${bad ? ` · ${bad} needing attention` : ""}` +
                  `${soft ? ` · ${soft} no ICMP or blind` : ""}` +
                  `${missing > 0 ? ` · ${missing} in Milestone not imported` : ""}`}>
        <span className="caret" aria-hidden="true">▾</span>
        <span className="site-name">
          {group.name}
          {group.site_display_name && (
            <span className="dim" style={{ fontWeight: 400, marginLeft: 6, fontSize: 10 }}>
              {group.site_display_name}
            </span>
          )}
        </span>
        {bad > 0 && <span className="site-prob">{bad}</span>}
        <span className="h-count"><Dot severity={worst} /> {rows.length}</span>
      </div>
      <div className={"host-nav-children" + (collapsed ? " hidden" : "")}>
        {rows.map((cam) => (
          <a key={cam.device_id}
             className={"host-nav-host" + (String(cam.device_id) === String(activeId) ? " active" : "")}
             href={`#/cameras/${cam.device_id}`}
             title={`${cam.name}${cam.ip ? ` · ${cam.ip}` : ""}${cam.model ? ` · ${cam.model}` : ""}`}>
            <span title={camTitle(cam)}><Dot severity={camSev(cam)} /></span>
            <span className="h-id">{cam.name}</span>
            {cam.recording_state === "up" && (
              <span className="h-count" title="recording now">●</span>
            )}
          </a>
        ))}
        {rows.length === 0 && (
          <div className="host-nav-hint">
            {n(group.total) === 0
              ? (missing > 0
                  ? `${missing} camera(s) in Milestone, none imported`
                  : "no cameras in this group")
              : "none match the filter"}
          </div>
        )}
      </div>
      {collapsed && holdsActive && (
        <div className="host-nav-hint">contains the selected camera</div>
      )}
    </div>
  );
}

export function CamerasPage({ id, query = {} }) {
  const [groups, setGroups] = React.useState(null);
  const [cams, setCams] = React.useState(null);
  const [error, setError] = React.useState(null);
  const [collapsed, setCollapsed] = React.useState(() => loadCollapsed() || new Set());
  const [seeded, setSeeded] = React.useState(false);
  const [status, setStatus] = React.useState(query.status || "");
  const [q, setQ] = React.useState(query.q || "");

  React.useEffect(() => {
    let live = true;
    const load = () => {
      getJSON("/api/surveillance/camera-groups")
        .then((r) => { if (live) { setGroups(r); setError(null); } })
        .catch((e) => { if (live) setError(e); });
      // The whole fleet in one read, as ZCD's navigator did: grouping and
      // filtering happen here, so switching groups costs nothing. 2,662 rows
      // of eight columns is ~0.4 MB and is already what the old tab fetched.
      getJSON("/api/surveillance/cameras" + qs({}))
        .then((r) => { if (live) setCams(r); })
        .catch(() => { if (live) setCams([]); });
    };
    load();
    const t = setInterval(load, REFRESH_MS);
    return () => { live = false; clearInterval(t); };
  }, []);

  const activeId = id || null;

  // First visit with no saved preference: collapse everything except the group
  // holding the selected camera, so 26 groups open navigable rather than as one
  // 2,662-row scroll.
  React.useEffect(() => {
    if (seeded || !groups || !cams || loadCollapsed()) return;
    const active = cams.find((c) => String(c.device_id) === String(activeId));
    const activeGroups = new Set((active?.group_ids || []));
    const all = new Set(groups.map((g) => g.id).filter((gid) => !activeGroups.has(gid)));
    setCollapsed(all);
    setSeeded(true);
  }, [groups, cams, activeId, seeded]);

  const toggle = React.useCallback((gid) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      next.has(gid) ? next.delete(gid) : next.add(gid);
      saveCollapsed(next);
      return next;
    });
  }, []);

  const setAllCollapsed = React.useCallback((ids, value) => {
    const next = value ? new Set(ids) : new Set();
    saveCollapsed(next);
    setCollapsed(next);
  }, []);

  if (error) return <ErrorMsg error={error} />;
  if (!groups || !cams) return <Loading what="camera fleet" />;

  return (
    <CamerasView groups={groups} cams={cams} activeId={activeId} query={query}
                 collapsed={collapsed} onToggle={toggle} onAllCollapsed={setAllCollapsed}
                 status={status} onStatus={setStatus}
                 q={q} onQ={setQ} />
  );
}

// The render half, split from the fetching half so the render check can drive
// it with fixed data — a component that only renders after a fetch is never
// exercised at build time, which is how "usedKnown is not defined" shipped.
export function CamerasView({ groups, cams, activeId, collapsed, onToggle, onAllCollapsed,
                              status = "", onStatus, q, onQ, query = {} }) {
  const n = (v) => Number(v) || 0;
  const needle = (q || "").trim().toLowerCase();
  const isProblem = (c) => c.source_status === "blind"
    || (c.reachability && c.reachability !== "up");

  const shown = cams.filter((c) =>
    matchesStatus(c, status)
    && (!needle || `${c.name} ${c.site || ""} ${c.model || ""} ${c.ip || ""} ${c.mac || ""}`
        .toLowerCase().includes(needle)));

  // Bucket by group membership. A camera in two groups appears under both —
  // that is what Smart Client does, and hiding the second membership would
  // misrepresent where the camera is filed.
  const byGroup = new Map(groups.map((g) => [g.id, []]));
  const ungrouped = [];
  for (const c of shown) {
    const ids = (c.group_ids || []).filter((gid) => byGroup.has(gid));
    if (ids.length === 0) ungrouped.push(c);
    else for (const gid of ids) byGroup.get(gid).push(c);
  }
  for (const rows of byGroup.values()) {
    rows.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  }

  // Groups with something wrong float to the top — an outage is never a scroll
  // away. Within each band, Milestone's own path order.
  const ordered = [...groups].sort((a, b) => {
    const badA = n(a.down_confirmed) + n(a.down_source_only) ? 0 : 1;
    const badB = n(b.down_confirmed) + n(b.down_source_only) ? 0 : 1;
    return badA - badB
      || String(a.path || a.name).localeCompare(String(b.path || b.name));
  });

  const allIds = groups.map((g) => g.id);
  const allCollapsed = allIds.length > 0 && allIds.every((gid) => collapsed.has(gid));
  const problems = cams.filter(isProblem).length;
  const bad = groups.reduce((t, g) => t + n(g.down_confirmed) + n(g.down_source_only), 0);
  const stale = groups.length > 0 ? groups[0].updated_at : null;

  return (
    <div className="page">
      <PageHeader
        title="Cameras"
        pills={[
          { label: "cameras", value: cams.length.toLocaleString() },
          { label: "groups", value: String(groups.length) },
          bad ? { label: "needing attention", value: String(bad), severity: "crit" }
              : { label: "reachable", value: "all", severity: "ok" },
        ]}
        range="Live"
      />
      <div className="subtitle">
        Milestone camera groups · <SourceBadge source="milestone" />{" "}
        tree from XProtect, status from <SourceBadge source="milestone-ess" /> and{" "}
        <SourceBadge source="poller" />
        {" · "}<a href="#/surveillance">surveillance overview →</a>
      </div>

      <div className="switch-layout">
        <div className="card host-nav">
          <div className="host-nav-tools">
            <span>{shown.length.toLocaleString()} of {cams.length.toLocaleString()} cameras ·{" "}
              {groups.length} groups</span>
            <button type="button" className="linkish"
                    onClick={() => onAllCollapsed(allIds, !allCollapsed)}>
              {allCollapsed ? "Expand all" : "Collapse all"}
            </button>
          </div>
          <div className="host-nav-tools">
            <select className="cfb-select" style={{ width: "100%" }} value={status}
                    onChange={(e) => onStatus(e.target.value)}
                    title="filter by what the probes say about each camera">
              {STATUS_FILTERS.map(([v, label]) => (
                <option key={v || "all"} value={v}>
                  {label}{v === "problems" ? ` (${problems})` : ""}
                </option>
              ))}
            </select>
          </div>
          <div className="host-nav-tools">
            <input type="text" placeholder="filter cameras…" value={q}
                   onChange={(e) => onQ(e.target.value)} style={{ width: "100%" }} />
          </div>
          {groups.length === 0 ? (
            <div className="host-nav-hint">
              No camera groups cached. The Milestone collector walks
              /cameraGroups; if this stays empty check NetMon Status for a
              degraded groups walk.
            </div>
          ) : (
            <React.Fragment>
              {ordered.map((g) => (
                <GroupNode key={g.id} group={g} rows={byGroup.get(g.id) || []}
                           activeId={activeId} collapsed={collapsed.has(g.id)}
                           onToggle={onToggle} />
              ))}
              {ungrouped.length > 0 && (
                <GroupNode
                  group={{ id: "__ungrouped", name: "Not in any group",
                           total: ungrouped.length, milestone_camera_count: ungrouped.length }}
                  rows={ungrouped} activeId={activeId}
                  collapsed={collapsed.has("__ungrouped")} onToggle={onToggle} />
              )}
            </React.Fragment>
          )}
        </div>

        <div className="sw-main">
          {activeId ? (
            <CameraDetailPage id={activeId} embedded query={query} />
          ) : (
            <ThumbnailWall rows={shown} total={cams.length} problems={problems}
                           onProblems={() => onStatus("problems")} />
          )}
        </div>
      </div>
    </div>
  );
}


// ZCD's camera wall, in the pane the detail will occupy once a camera is
// picked: browse the stills, click through to one. Capped at ZCD's 48 — beyond
// that it is 48 simultaneous proxied fetches into the camera VLAN, and nobody
// reads a wall of 2,662 tiles anyway.
const WALL_CAP = 48;

export function ThumbnailWall({ rows, total, problems, onProblems }) {
  const shown = rows.slice(0, WALL_CAP);
  return (
    <Card title="Camera wall" source="milestone"
          kicker={rows.length > WALL_CAP
            ? `first ${WALL_CAP} of ${rows.length.toLocaleString()} — narrow the filter to see others`
            : `${rows.length.toLocaleString()} camera(s)`}
          tight>
      {rows.length === 0 ? (
        <div className="msg" style={{ padding: 14 }}>
          No cameras match the current filter.
          {problems > 0 && (
            <> {problems.toLocaleString()} of {total.toLocaleString()} are not simply up —{" "}
              <button type="button" className="linkish" onClick={onProblems}>
                show only those</button>.
            </>
          )}
        </div>
      ) : (
        <React.Fragment>
          <div className="cam-grid">
            {shown.map((c) => <CamThumb key={c.device_id} cam={c} />)}
          </div>
          <div className="msg" style={{ fontSize: 11, padding: "10px 14px 0" }}>
            Stills are fetched through NetMon so the camera login never reaches
            the browser. A tile that cannot show one says why rather than going
            blank — pick a camera for its full detail.
          </div>
        </React.Fragment>
      )}
    </Card>
  );
}
