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
  netmonStatus: "#/netmon-status",
  settings: "#/settings",
};

// Domains Zabbix keeps (spec 11 D1/D2): Servers stays Zabbix's; FortiGate is
// deferred to phase 11.x. Nav keeps the entries visible as deep-links into the
// existing ZCD pages inside Zabbix (spec 10 Q1, resolved 2026-07-15). The base
// URL comes from /api/meta ([web] zabbix_url); unset → entries render disabled.
const ZBX_LINKS = [
  { key: "servers", icon: "server", label: "Servers", action: "tcs.servers.view" },
  { key: "fortigate", icon: "shield", label: "FortiGate", action: "tcs.fortigate.view" },
];

export function Nav({ active }) {
  const [collapsed, setCollapsed] = React.useState(() => {
    try { return localStorage.getItem(STORAGE_KEY) === "1"; } catch { return false; }
  });
  const [counts, setCounts] = React.useState(null);
  const [health, setHealth] = React.useState(null);
  const [meta, setMeta] = React.useState(null);
  const [role, setRole] = React.useState(null);

  React.useEffect(() => {
    // Static shell facts (version, Zabbix deep-link base) — once per load.
    getJSON("/api/meta")
      .then(setMeta)
      .catch(() => { /* deep-links render disabled without it */ });
    // Role only gates nav visibility — the API enforces it server-side.
    getJSON("/auth/me")
      .then((me) => setRole(me?.role || null))
      .catch(() => { /* stay hidden */ });
  }, []);

  React.useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, collapsed ? "1" : "0"); } catch { /* ignore */ }
  }, [collapsed]);

  React.useEffect(() => {
    let live = true;
    const tick = () => {
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
      getJSON("/api/collector-health")
        .then((rows) => { if (live) setHealth(rows); })
        .catch(() => { /* pills are best-effort */ });
    };
    tick();
    const id = setInterval(tick, 30000);
    return () => { live = false; clearInterval(id); };
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

      <div className="nav-section">
        <div className="nav-label">System</div>
        {item("netmon-status", NAV.netmonStatus, "events", "NetMon Status")}
        {ZBX_LINKS.map((l) =>
          meta?.zabbix_url ? (
            <a key={l.key} className="nav-item nav-item-ext"
               href={`${meta.zabbix_url}/zabbix.php?action=${l.action}`}
               target="_blank" rel="noopener noreferrer"
               title={`${l.label} — opens in Zabbix (retained domain)`}>
              <Icon name={l.icon} />
              <span className="nav-label-text">{l.label}</span>
              <span className="nav-ext-mark">↗</span>
            </a>
          ) : (
            <span key={l.key} className="nav-item nav-item-disabled"
                  title={`${l.label} is managed in Zabbix — set [web] zabbix_url to enable the deep-link`}>
              <Icon name={l.icon} />
              <span className="nav-label-text">{l.label}</span>
            </span>
          )
        )}
      </div>

      {role === "admin" && (
        <div className="nav-section">
          <div className="nav-label">Administration</div>
          {item("settings", NAV.settings, "gear", "Settings")}
        </div>
      )}

      {health && health.length > 0 && (
        <div className="nav-section">
          <div className="nav-label">Sources</div>
          {health.map((h) => (
            <div className={"src-pill src-" + h.status} key={h.name}
                 title={pillTitle(h)}>
              <span className="src-pill-dot" style={{ background: HEALTH_COLOR[h.status] || HEALTH_COLOR.unknown }} />
              <span className="nav-label-text src-pill-name">{h.name}</span>
            </div>
          ))}
        </div>
      )}

      <div className="nav-foot">
        {meta ? `v${meta.version}` : "v…"} · {counts ? counts.total + " devices" : "…"}
      </div>
    </aside>
  );
}

const HEALTH_COLOR = { ok: "#1fb75a", error: "#e5484d", unknown: "#8a8f98" };

function pillTitle(h) {
  const parts = [`${h.name}: ${h.status}`];
  if (h.last_success) parts.push(`last ok ${h.last_success}`);
  if (h.consecutive_failures) parts.push(`${h.consecutive_failures} consecutive failure(s)`);
  if (h.last_error) parts.push(`error: ${h.last_error}`);
  return parts.join(" · ");
}
