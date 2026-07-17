import React from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { Nav } from "./nav.jsx";
import { CommandPalette } from "./search.jsx";
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
  if (parts[0] === "wireless") return { name: "wireless", query };
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

function App() {
  const route = useRoute();
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
  else if (route.name === "wireless") { page = <XiqPage />; active = "wireless"; }
  else if (route.name === "settings") { page = <SettingsPage />; active = "settings"; }
  else if (route.name === "registry") { page = <RegistryPage />; active = "registry"; }
  else if (route.name === "ap") { page = <ApDetailPage id={route.id} />; active = "wireless"; }
  else { page = <GlobalPage />; active = "global"; }

  // The map is a full-bleed NOC view — no content padding.
  const flush = route.name === "map";
  return (
    <div className="app">
      <Nav active={active} />
      <main className={"content" + (flush ? " content-flush" : "")}>{page}</main>
      <CommandPalette />
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);
