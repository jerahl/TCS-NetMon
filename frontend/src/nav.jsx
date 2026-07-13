// Unified NetMon sidebar — ported from the reference global-nav idiom
// (collapsible, sections, live counts) but rewired to NetMon hash routes and
// stripped of the Zabbix-module coupling (no zabbix.php URLs, no CDN).

import React from "react";
import { getJSON } from "./api.js";
import { Icon } from "./primitives.jsx";

const STORAGE_KEY = "netmon.sidebar.collapsed";

// Routes for all planned pages (hash-routed SPA). Pages not yet built link to
// their eventual route so the nav is complete now (DoD: "routes for all
// planned pages").
const NAV = {
  global: "#/",
  xiq: "#/xiq",
  wireless: "#/wireless",
  switches: "#/switches",
  surveillance: "#/surveillance",
  voip: "#/voip",
  nac: "#/nac",
  events: "#/events",
  problems: "#/problems",
  map: "#/map",
};

export function Nav({ active }) {
  const [collapsed, setCollapsed] = React.useState(() => {
    try { return localStorage.getItem(STORAGE_KEY) === "1"; } catch { return false; }
  });
  const [counts, setCounts] = React.useState(null);

  React.useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, collapsed ? "1" : "0"); } catch { /* ignore */ }
  }, [collapsed]);

  React.useEffect(() => {
    let live = true;
    getJSON("/api/status")
      .then((rows) => {
        if (!live) return;
        const c = { total: rows.length, switches: 0, aps: 0 };
        for (const d of rows) {
          if (d.device_type === "switch") c.switches++;
          if (d.device_type === "ap") c.aps++;
        }
        setCounts(c);
      })
      .catch(() => { /* nav counts are best-effort */ });
    return () => { live = false; };
  }, []);

  const item = (key, href, icon, label, count) => (
    <a className={"nav-item" + (active === key ? " active" : "")} href={href} title={label}>
      <Icon name={icon} />
      <span className="nav-label-text">{label}</span>
      {count !== undefined && count !== null && <span className="nav-count">{count}</span>}
    </a>
  );

  return (
    <aside className={"sidebar" + (collapsed ? " collapsed" : "")}>
      <button
        type="button"
        className="sidebar-toggle"
        onClick={() => setCollapsed((c) => !c)}
        aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
      >
        {collapsed ? "»" : "«"}
      </button>

      <div className="brand">
        <div className="brand-mark">NM</div>
        <div className="brand-text">
          <div className="brand-name">TCS NetMon</div>
          <div className="brand-sub">Network operations</div>
        </div>
      </div>

      <div className="nav-section">
        <div className="nav-label">Monitoring</div>
        {item("global", NAV.global, "map", "Global")}
        {item("xiq", NAV.xiq, "ap", "XIQ · Status", counts?.aps)}
        {item("wireless", NAV.wireless, "wifi", "Wireless APs")}
        {item("switches", NAV.switches, "ethernet", "Switches", counts?.switches)}
        {item("surveillance", NAV.surveillance, "camera", "Surveillance")}
        {item("voip", NAV.voip, "phone", "VoIP · 3CX")}
      </div>

      <div className="nav-section">
        <div className="nav-label">Access & events</div>
        {item("nac", NAV.nac, "shield", "NAC")}
        {item("events", NAV.events, "events", "Events")}
        {item("problems", NAV.problems, "alert", "Problems")}
        {item("map", NAV.map, "map", "Site Map")}
      </div>

      <div className="nav-foot">v0.1 · {counts ? counts.total + " devices" : "…"}</div>
    </aside>
  );
}
