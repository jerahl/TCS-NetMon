import React from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { Nav } from "./nav.jsx";
import { CommandPalette } from "./search.jsx";
import { Icon } from "./primitives.jsx";
import { GlobalPage } from "./pages/global.jsx";
import { SwitchesPage } from "./pages/switches.jsx";
import { ApDetailPage } from "./pages/ap_detail.jsx";
import { NacPage } from "./pages/nac.jsx";
import { SurveillancePage } from "./pages/surveillance.jsx";
import { EventsPage } from "./pages/events.jsx";
import { ProblemsPage } from "./pages/problems.jsx";
import { VoipPage } from "./pages/voip.jsx";
import { MapPage } from "./pages/map.jsx";
import { NetmonStatusPage } from "./pages/netmon_status.jsx";
import { WirelessPage } from "./pages/wireless.jsx";
import { XiqPage } from "./pages/xiq.jsx";
import { SettingsPage } from "./pages/settings.jsx";
import { RegistryPage } from "./pages/registry.jsx";

// Hash router — one index.html serves every route (deep links never 404, no
// server-side per-page routing, no external navigation).
function parseRoute() {
  // Split an optional "?key=val&…" query off the hash so deep-links can carry a
  // filter (e.g. #/nac?q=<mac>, #/switches/5?mac=<mac>). The palette uses this
  // to land pre-filtered on the item that was clicked.
  const raw = location.hash.replace(/^#\/?/, "");
  const qIdx = raw.indexOf("?");
  const pathPart = qIdx >= 0 ? raw.slice(0, qIdx) : raw;
  const query = Object.fromEntries(new URLSearchParams(qIdx >= 0 ? raw.slice(qIdx + 1) : ""));
  const parts = pathPart.split("/").filter(Boolean);
  if (parts[0] === "switches") return { name: "switches", id: parts[1] || null, query };
  if (parts[0] === "nac") return { name: "nac", query };
  if (parts[0] === "surveillance") return { name: "surveillance", query };
  if (parts[0] === "events") return { name: "events", query };
  if (parts[0] === "problems") return { name: "problems", query };
  if (parts[0] === "voip") return { name: "voip", query };
  if (parts[0] === "map") return { name: "map", query };
  if (parts[0] === "netmon-status") return { name: "netmon-status", query };
  if (parts[0] === "xiq") return { name: "xiq", query };
  if (parts[0] === "wireless") return { name: "wireless", id: parts[1] || null, query };
  if (parts[0] === "settings") return { name: "settings", query };
  if (parts[0] === "registry") return { name: "registry", query };
  if (parts[0] === "ap" && parts[1]) return { name: "ap", id: parts[1], query };
  return { name: "global", query };
}

function useRoute() {
  const [route, setRoute] = React.useState(parseRoute());
  React.useEffect(() => {
    const on = () => setRoute(parseRoute());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}

// Breadcrumb text per route — ZCD's topbar reads
// "Tuscaloosa City Schools / Operations / <page>".
const CRUMBS = {
  global: "Global", switches: "Switches", xiq: "XIQ · Status",
  wireless: "Wireless APs", surveillance: "Surveillance", voip: "VoIP · 3CX",
  nac: "NAC", events: "Events", problems: "Problems", map: "Site Map",
  "netmon-status": "NetMon Status", registry: "Registry", settings: "Settings",
  ap: "AP Detail",
};

// ZCD's topbar (spec 14 §2 row 1): breadcrumb, search, refresh. Ported to
// NetMon's own vocabulary — the search opens the existing ⌘K palette rather
// than being a second search box, and there is no "back to Zabbix dashboard"
// chevron because NetMon is not a Zabbix module.
function Topbar({ route }) {
  const label = CRUMBS[route.name] || "Global";
  return (
    <div className="topbar">
      <div className="crumb">
        <span className="seg">Tuscaloosa City Schools</span>
        <span className="sep">/</span>
        <span className="seg">Operations</span>
        <span className="sep">/</span>
        <span className="seg">{label}</span>
      </div>
      <div className="spacer" />
      <button type="button" className="search"
              onClick={() => window.dispatchEvent(new CustomEvent("netmon:open-search"))}
              title="Search devices, endpoints, MACs">
        <Icon name="search" />
        <input type="text" readOnly placeholder="Find host, MAC, user, IP…"
               style={{ pointerEvents: "none" }} />
        <kbd>⌘K</kbd>
      </button>
      {/* A hard reload is the honest refresh: every page polls its own data on
          its own interval, so there is no single cache to invalidate. */}
      <button type="button" className="icon-btn" title="Reload"
              onClick={() => location.reload()}>⟳</button>
    </div>
  );
}

function App() {
  const route = useRoute();
  // The sidebar collapse lives here, not in Nav: ZCD's layout swaps the grid
  // template on `.app` (220px → 56px), so the class has to sit on the ancestor.
  const [collapsed, setCollapsed] = React.useState(() => {
    try { return localStorage.getItem("netmon.sidebar.collapsed") === "1"; }
    catch { return false; }
  });
  React.useEffect(() => {
    try { localStorage.setItem("netmon.sidebar.collapsed", collapsed ? "1" : "0"); }
    catch { /* collapse state is a convenience, not data */ }
  }, [collapsed]);

  let page, active;
  if (route.name === "switches") { page = <SwitchesPage id={route.id} query={route.query} />; active = "switches"; }
  else if (route.name === "nac") { page = <NacPage query={route.query} />; active = "nac"; }
  else if (route.name === "surveillance") { page = <SurveillancePage />; active = "surveillance"; }
  else if (route.name === "events") { page = <EventsPage />; active = "events"; }
  else if (route.name === "problems") { page = <ProblemsPage />; active = "problems"; }
  else if (route.name === "voip") { page = <VoipPage />; active = "voip"; }
  else if (route.name === "map") { page = <MapPage />; active = "map"; }
  else if (route.name === "netmon-status") { page = <NetmonStatusPage />; active = "netmon-status"; }
  else if (route.name === "xiq") { page = <XiqPage />; active = "xiq"; }
  else if (route.name === "wireless") { page = <WirelessPage id={route.id} />; active = "wireless"; }
  else if (route.name === "settings") { page = <SettingsPage />; active = "settings"; }
  else if (route.name === "registry") { page = <RegistryPage />; active = "registry"; }
  else if (route.name === "ap") { page = <ApDetailPage id={route.id} />; active = "wireless"; }
  else { page = <GlobalPage />; active = "global"; }

  // The map is a full-bleed NOC view — no content padding.
  const flush = route.name === "map";
  return (
    <div className={"app" + (collapsed ? " sidebar-collapsed" : "")}>
      <Nav active={active} collapsed={collapsed}
           onToggle={() => setCollapsed((c) => !c)} />
      <div className="main">
        <Topbar route={route} />
        <main className={"content" + (flush ? " content-flush" : "")}>{page}</main>
      </div>
      <CommandPalette />
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);
