import React from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { Nav } from "./nav.jsx";
import { GlobalPage } from "./pages/global.jsx";
import { SwitchesPage } from "./pages/switches.jsx";
import { ApDetailPage } from "./pages/ap_detail.jsx";
import { NacPage } from "./pages/nac.jsx";
import { SurveillancePage } from "./pages/surveillance.jsx";

// Hash router — one index.html serves every route (deep links never 404, no
// server-side per-page routing, no external navigation).
function parseRoute() {
  const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  if (parts[0] === "switches") return { name: "switches" };
  if (parts[0] === "nac") return { name: "nac" };
  if (parts[0] === "surveillance") return { name: "surveillance" };
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
  else if (route.name === "ap") { page = <ApDetailPage id={route.id} />; active = "wireless"; }
  else { page = <GlobalPage />; active = "global"; }

  return (
    <div className="app">
      <Nav active={active} />
      <main className="content">{page}</main>
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);
