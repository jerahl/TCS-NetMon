import React from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { Nav } from "./nav.jsx";
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
import { PlannedPage } from "./pages/planned.jsx";
import { SettingsPage } from "./pages/settings.jsx";

// Hash router — one index.html serves every route (deep links never 404, no
// server-side per-page routing, no external navigation).
function parseRoute() {
  const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  if (parts[0] === "switches") return { name: "switches" };
  if (parts[0] === "nac") return { name: "nac" };
  if (parts[0] === "surveillance") return { name: "surveillance" };
  if (parts[0] === "events") return { name: "events" };
  if (parts[0] === "problems") return { name: "problems" };
  if (parts[0] === "voip") return { name: "voip" };
  if (parts[0] === "map") return { name: "map" };
  if (parts[0] === "netmon-status") return { name: "netmon-status" };
  if (parts[0] === "xiq") return { name: "xiq" };
  if (parts[0] === "wireless") return { name: "wireless" };
  if (parts[0] === "settings") return { name: "settings" };
  if (parts[0] === "ap" && parts[1]) return { name: "ap", id: parts[1] };
  return { name: "global" };
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
  if (route.name === "switches") { page = <SwitchesPage />; active = "switches"; }
  else if (route.name === "nac") { page = <NacPage />; active = "nac"; }
  else if (route.name === "surveillance") { page = <SurveillancePage />; active = "surveillance"; }
  else if (route.name === "events") { page = <EventsPage />; active = "events"; }
  else if (route.name === "problems") { page = <ProblemsPage />; active = "problems"; }
  else if (route.name === "voip") { page = <VoipPage />; active = "voip"; }
  else if (route.name === "map") { page = <MapPage />; active = "map"; }
  else if (route.name === "netmon-status") { page = <NetmonStatusPage />; active = "netmon-status"; }
  else if (route.name === "xiq") {
    page = <PlannedPage title="XIQ · Wireless Status" phase="10.2"
                        note="Fleet status/detail lives in ExtremeCloud IQ until then." />;
    active = "xiq";
  }
  else if (route.name === "wireless") {
    page = <PlannedPage title="Wireless APs" phase="10.2"
                        note="Per-AP detail is reachable now via device links (#/ap/…)." />;
    active = "wireless";
  }
  else if (route.name === "settings") { page = <SettingsPage />; active = "settings"; }
  else if (route.name === "ap") { page = <ApDetailPage id={route.id} />; active = "wireless"; }
  else { page = <GlobalPage />; active = "global"; }

  // The map is a full-bleed NOC view — no content padding.
  const flush = route.name === "map";
  return (
    <div className="app">
      <Nav active={active} />
      <main className={"content" + (flush ? " content-flush" : "")}>{page}</main>
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);
