import React from "react";
import { getJSON } from "../api.js";
import { Loading, ErrorMsg, Dot, SourceBadge, sevColor } from "../primitives.jsx";
import { ApDetailPage } from "./ap_detail.jsx";

// Wireless APs — the AP navigator (spec 18).
//
// #/xiq and #/wireless both rendered XiqPage, so the app had two nav entries
// for one page and the AP detail at #/ap/:id had no path into it at all: an
// operator could only reach an AP by finding it in the fleet table. This page
// is the missing half — ZCD's AP Navigator — and it deliberately mirrors the
// Switches navigator (same grouping, same collapse memory, same "a collapsed
// group still confesses its problems" rule) rather than inventing a second
// idiom for the same job.
//
// Division of labour with #/xiq: that page is the *fleet dashboard* (KPIs,
// per-site health, SSIDs, firmware); this one is *per-AP drill-down*.

const REFRESH_MS = 30000;
const STATUS_SEV = { up: "ok", down: "crit", blind: "warn" };
const NAV_COLLAPSE_KEY = "netmon.wireless.collapsedSites";

function statusSev(status) {
  return STATUS_SEV[status] || "unknown";
}

function statusTitle(ap) {
  if (ap.status === "up") return "Up (per ExtremeCloud IQ)";
  if (ap.status === "down") return "Down (per ExtremeCloud IQ)";
  if (ap.status === "blind") return "XIQ unreachable — last reading is stale, not a state";
  return "Unknown — no reading yet; not the same as up";
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

function SiteGroup({ site, rows, activeId, collapsed, onToggle }) {
  // A collapsed group must still confess a problem, or hiding a site would
  // hide an outage (CLAUDE.md §4.5).
  const down = rows.filter((a) => a.status === "down").length;
  const unknown = rows.filter((a) => a.status !== "up" && a.status !== "down").length;
  const worst = down ? "crit" : unknown === rows.length ? "unknown" : unknown ? "warn" : "ok";
  const holdsActive = rows.some((a) => a.id === activeId);

  return (
    <div className="host-nav-section">
      <div className={"host-nav-site" + (collapsed ? " collapsed" : "")}
           role="button" tabIndex={0}
           aria-expanded={!collapsed}
           onClick={() => onToggle(site)}
           onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggle(site); } }}
           title={`${rows.length} AP(s)${down ? ` · ${down} down` : ""}`}>
        <span className="caret" aria-hidden="true">▾</span>
        <span className="site-name">{site}</span>
        {down > 0 && <span className="site-prob">{down}</span>}
        <span className="h-count"><Dot severity={worst} /> {rows.length}</span>
      </div>
      <div className={"host-nav-children" + (collapsed ? " hidden" : "")}>
        {rows.map((ap) => (
          <a key={ap.id}
             className={"host-nav-host" + (ap.id === activeId ? " active" : "")}
             href={`#/wireless/${ap.id}`} title={ap.ip || ap.mgmt_ip || ap.name}>
            <span title={statusTitle(ap)}><Dot severity={statusSev(ap.status)} /></span>
            <span className="h-id">{ap.name}</span>
            {ap.clients_total > 0 && <span className="h-count">{ap.clients_total}</span>}
          </a>
        ))}
      </div>
      {collapsed && holdsActive && (
        <div className="host-nav-hint">contains the selected AP</div>
      )}
    </div>
  );
}

export function WirelessPage({ id }) {
  const [fleet, setFleet] = React.useState(null);
  const [error, setError] = React.useState(null);
  const [collapsed, setCollapsed] = React.useState(() => loadCollapsed() || new Set());
  const [seeded, setSeeded] = React.useState(false);
  const [problemsOnly, setProblemsOnly] = React.useState(false);
  const [q, setQ] = React.useState("");

  React.useEffect(() => {
    let live = true;
    const load = () => getJSON("/api/wireless/aps")
      .then((rows) => { if (live) { setFleet(rows); setError(null); } })
      .catch((e) => { if (live) setError(e); });
    load();
    const t = setInterval(load, REFRESH_MS);
    return () => { live = false; clearInterval(t); };
  }, []);

  const activeId = id ? Number(id) : null;

  // First visit with no saved preference: collapse every site except the one
  // holding the selected AP, so a 783-AP fleet opens navigable rather than as
  // one enormous scroll.
  React.useEffect(() => {
    if (seeded || !fleet || loadCollapsed()) return;
    const activeSite = fleet.find((a) => a.id === activeId)?.site || null;
    const all = new Set(fleet.map((a) => a.site || "Unassigned"));
    all.delete(activeSite);
    setCollapsed(all);
    setSeeded(true);
  }, [fleet, activeId, seeded]);

  const toggleSite = React.useCallback((site) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      next.has(site) ? next.delete(site) : next.add(site);
      saveCollapsed(next);
      return next;
    });
  }, []);

  const setAllCollapsed = React.useCallback((siteNames, value) => {
    const next = value ? new Set(siteNames) : new Set();
    saveCollapsed(next);
    setCollapsed(next);
  }, []);

  if (error) return <ErrorMsg error={error} />;
  if (!fleet) return <Loading what="AP fleet" />;

  const needle = q.trim().toLowerCase();
  const shown = fleet.filter((a) =>
    (!problemsOnly || a.status !== "up") &&
    (!needle || `${a.name} ${a.site || ""} ${a.model || ""} ${a.ip || ""}`
      .toLowerCase().includes(needle)));

  const sites = {};
  for (const ap of shown) (sites[ap.site || "Unassigned"] ||= []).push(ap);
  // Float sites holding a down AP to the top — an outage is never a scroll away.
  const siteNames = Object.keys(sites).sort((a, b) => {
    const downA = sites[a].some((x) => x.status === "down") ? 0 : 1;
    const downB = sites[b].some((x) => x.status === "down") ? 0 : 1;
    return downA - downB || a.localeCompare(b);
  });
  const allCollapsed = siteNames.length > 0 && siteNames.every((s) => collapsed.has(s));
  const problems = fleet.filter((a) => a.status !== "up").length;

  return (
    <div className="page">
      <h1>Wireless APs</h1>
      <div className="subtitle">
        ExtremeCloud IQ cycles · <SourceBadge source="xiq" /> · refreshes every {REFRESH_MS / 1000}s
        {" · "}<a href="#/xiq">fleet dashboard →</a>
      </div>

      <div className="switch-layout">
        <div className="card host-nav">
          <div className="host-nav-tools">
            <span>{shown.length} of {fleet.length} APs · {siteNames.length} sites</span>
            <button type="button" className="linkish"
                    onClick={() => setAllCollapsed(siteNames, !allCollapsed)}>
              {allCollapsed ? "Expand all" : "Collapse all"}
            </button>
          </div>
          <div className="host-nav-tools">
            <button type="button"
                    className={"linkish" + (problemsOnly ? " active" : "")}
                    onClick={() => setProblemsOnly((v) => !v)}>
              {problemsOnly ? "◉" : "○"} Problems only ({problems})
            </button>
          </div>
          <div className="host-nav-tools">
            <input type="text" placeholder="filter APs…" value={q}
                   onChange={(e) => setQ(e.target.value)} style={{ width: "100%" }} />
          </div>
          {siteNames.length === 0 ? (
            <div className="host-nav-hint">
              {problemsOnly ? "No APs with problems." : "No APs match."}
            </div>
          ) : siteNames.map((site) => (
            <SiteGroup key={site} site={site} rows={sites[site]} activeId={activeId}
                       collapsed={collapsed.has(site)} onToggle={toggleSite} />
          ))}
        </div>

        <div className="sw-main">
          {activeId ? (
            <ApDetailPage id={activeId} embedded />
          ) : (
            <div className="msg">
              Select an AP from the navigator.
              {problems > 0 && (
                <> {problems} AP(s) are not up —{" "}
                  <button type="button" className="linkish"
                          onClick={() => setProblemsOnly(true)}>show only those</button>.
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
