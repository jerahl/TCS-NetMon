// Geographic site-status map (Phase 9, spec 09) — the NOC wall view.
//
// Visuals recreated from the design handoff (docs/design/netmon-map/), but
// running on real endpoints: /api/sites, /api/links, /api/events. There is no
// simulation loop — the page polls, and when a poll fails it keeps the last
// good data and says so (API UNREACHABLE chip with the data's age).
//
// Leaflet is bundled locally (owner-approved 2026-07-14); only basemap TILES
// are an external runtime fetch — the recorded exception. When tiles fail the
// topology still renders on the plain background (MAP TILES UNREACHABLE chip).

import React from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { getJSON } from "../api.js";

const C = { up: "#1fb75a", degraded: "#e8a415", down: "#e5484d", hot: "#f07c1d", unknown: "#8a8f98" };
const STATUS_LABEL = { up: "UP", degraded: "DEGRADED", down: "DOWN", unknown: "NO DATA" };
const STATUS_ORDER = { down: 0, degraded: 1, unknown: 2, up: 3 };
const TIER_RADIUS = { hub: 10, high: 8, middle: 7, elementary: 6.5, other: 6.5 };
const TIER_LABEL = {
  hub: "Core · Central Office",
  high: "High School",
  middle: "Middle School",
  elementary: "Elementary School",
  other: "Site",
};

// Basemap tile sources — the one permitted external runtime fetch (spec 09
// decision 2, owner-approved 2026-07-14). Point these at a self-hosted tile
// pack to remove even that dependency.
const TILES = {
  dark: ["https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", "&copy; OpenStreetMap &copy; CARTO"],
  light: ["https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", "&copy; OpenStreetMap &copy; CARTO"],
  satellite: [
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    "Tiles &copy; Esri",
  ],
};
const THEMES = ["dark", "light", "satellite"];
const THEME_KEY = "netmon.map.theme";
const POLL_MS = 10000;

const linkColor = (l) =>
  l.status !== "up" ? C[l.status] || C.unknown : l.utilization_pct > 85 ? C.hot : C.up;

const fmtTime = (iso) => {
  const d = new Date(iso);
  return isNaN(d) ? String(iso ?? "") : d.toLocaleTimeString("en-US", { hour12: false });
};

const ago = (ms) => {
  const s = Math.round((Date.now() - ms) / 1000);
  return s < 90 ? `${s}s` : s < 5400 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`;
};

export function MapPage() {
  const [data, setData] = React.useState({ sites: null, links: null, events: null, at: null, error: null });
  const [selected, setSelected] = React.useState(null); // site name
  const [theme, setTheme] = React.useState(() => {
    try { return THEMES.includes(localStorage.getItem(THEME_KEY)) ? localStorage.getItem(THEME_KEY) : "dark"; }
    catch { return "dark"; }
  });
  const [noc, setNoc] = React.useState(false);
  const [tilesDown, setTilesDown] = React.useState(false);
  const [clock, setClock] = React.useState(() => new Date().toLocaleTimeString("en-US", { hour12: false }));

  const rootRef = React.useRef(null);
  const mapEl = React.useRef(null);
  const mapRef = React.useRef(null);
  const tileRef = React.useRef(null);
  const tileThemeRef = React.useRef(null);
  const layersRef = React.useRef({ sites: {}, links: {} });
  const dataRef = React.useRef(data);
  dataRef.current = data;

  // ---- live data: poll the three endpoints; keep last good data on failure.
  React.useEffect(() => {
    let live = true;
    const load = () =>
      Promise.all([getJSON("/api/sites"), getJSON("/api/links"), getJSON("/api/events?limit=40")])
        .then(([sites, links, events]) => {
          if (live) setData({ sites, links, events, at: Date.now(), error: null });
        })
        .catch((error) => {
          if (live) setData((d) => ({ ...d, error }));
        });
    load();
    const t = setInterval(load, POLL_MS);
    return () => { live = false; clearInterval(t); };
  }, []);

  React.useEffect(() => {
    const t = setInterval(() => setClock(new Date().toLocaleTimeString("en-US", { hour12: false })), 1000);
    return () => clearInterval(t);
  }, []);

  // ---- NOC mode = fullscreen on the page element (hides the app sidebar).
  React.useEffect(() => {
    const on = () => {
      setNoc(document.fullscreenElement === rootRef.current);
      setTimeout(() => mapRef.current && mapRef.current.invalidateSize(), 60);
    };
    document.addEventListener("fullscreenchange", on);
    return () => document.removeEventListener("fullscreenchange", on);
  }, []);
  const toggleNoc = () => {
    try {
      if (!noc) rootRef.current?.requestFullscreen();
      else if (document.fullscreenElement) document.exitFullscreen();
    } catch { /* fullscreen unsupported — NOC still hides the panel */ }
    setNoc((n) => !n);
    setTimeout(() => mapRef.current && mapRef.current.invalidateSize(), 60);
  };

  const cycleTheme = () => {
    const next = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
    setTheme(next);
    try { localStorage.setItem(THEME_KEY, next); } catch { /* ignore */ }
  };

  // ---- Leaflet lifecycle: init once sites exist, then sync layers/styles.
  React.useEffect(() => {
    const { sites, links } = data;
    if (!mapEl.current || !sites || sites.length === 0) return;

    if (!mapRef.current) {
      const map = L.map(mapEl.current, { zoomControl: true });
      map.fitBounds(L.latLngBounds(sites.map((s) => [s.lat, s.lon])).pad(0.15));
      map.on("click", () => setSelected(null));
      mapRef.current = map;
    }
    const map = mapRef.current;

    // Basemap (external fetch; degrade gracefully — vectors don't need it).
    if (tileThemeRef.current !== theme) {
      tileThemeRef.current = theme;
      if (tileRef.current) tileRef.current.remove();
      const [url, attribution] = TILES[theme] || TILES.dark;
      const layer = L.tileLayer(url, { maxZoom: 19, attribution });
      // 'load' fires even when every tile errored, so clear the warning only
      // on an actual successful tile ('tileload').
      layer.on("tileerror", () => setTilesDown(true));
      layer.on("tileload", () => setTilesDown(false));
      layer.addTo(map);
      layer.bringToBack();
      tileRef.current = layer;
    }

    const bySite = Object.fromEntries(sites.map((s) => [s.name, s]));
    const lay = layersRef.current;

    // Fiber links: casing + animated dash line, styled by status/utilization.
    const liveLinkIds = new Set();
    for (const l of links || []) {
      const a = bySite[l.site_a], b = bySite[l.site_b];
      if (!a || !b) continue;
      liveLinkIds.add(l.id);
      const path = l.path && l.path.length >= 2 ? l.path : [[a.lat, a.lon], [b.lat, b.lon]];
      let entry = lay.links[l.id];
      if (!entry) {
        const casing = L.polyline(path, { color: "#000", opacity: 0.35, weight: 8, interactive: false }).addTo(map);
        const line = L.polyline(path, { weight: 4, opacity: 0.95, dashArray: "8 7", className: "flowline" }).addTo(map);
        line.on("click", (e) => { L.DomEvent.stop(e); setSelected(l.site_a); });
        line.bindTooltip(
          () => {
            const cur = (dataRef.current.links || []).find((x) => x.id === l.id) || l;
            const stat = cur.status === "up"
              ? (cur.utilization_pct == null ? "util: no data" : `${Math.round(cur.utilization_pct)}% of ${cur.capacity_gbps}G`)
              : STATUS_LABEL[cur.status] || cur.status.toUpperCase();
            return `${cur.site_a} ⟷ ${cur.site_b}<br>${cur.capacity_gbps}G fiber · ${stat}`;
          },
          { sticky: true, className: "link-tip" }
        );
        entry = lay.links[l.id] = { casing, line };
      } else {
        entry.casing.setLatLngs(path);
        entry.line.setLatLngs(path);
      }

      const color = linkColor(l);
      const touched = selected && (l.site_a === selected || l.site_b === selected);
      const dimmed = selected && !touched;
      const w = l.capacity_gbps >= 10 ? 4.5 : 3;
      entry.line.setStyle({
        color,
        weight: touched ? w + 1.5 : w,
        opacity: dimmed ? 0.25 : 0.95,
        dashArray: l.status === "down" ? "3 9" : "8 7",
      });
      entry.casing.setStyle({ weight: (touched ? w + 1.5 : w) + 3.5, opacity: dimmed ? 0.1 : 0.35 });
      const p = entry.line._path;
      if (p) {
        const flowing = l.status === "up" || l.status === "degraded";
        p.classList.toggle("stopped", !flowing);
        p.classList.toggle("fast", flowing && l.utilization_pct > 66);
        p.classList.toggle("slow", flowing && l.utilization_pct != null && l.utilization_pct <= 33);
      }
    }
    for (const id of Object.keys(lay.links)) {
      if (!liveLinkIds.has(Number(id))) {
        lay.links[id].casing.remove();
        lay.links[id].line.remove();
        delete lay.links[id];
      }
    }

    // Site dots, sized by tier, pulsing when down.
    const liveSites = new Set();
    for (const s of sites) {
      liveSites.add(s.name);
      let m = lay.sites[s.name];
      if (!m) {
        m = L.circleMarker([s.lat, s.lon], { radius: TIER_RADIUS[s.tier] || 6.5, weight: 2.5, fillOpacity: 1 }).addTo(map);
        m.on("click", (e) => { L.DomEvent.stop(e); setSelected(s.name); });
        m.bindTooltip(s.name, { permanent: true, direction: "top", offset: [0, -8], className: "site-tip", interactive: false });
        lay.sites[s.name] = m;
      } else {
        m.setLatLng([s.lat, s.lon]);
      }
      const isSel = selected === s.name;
      const neighbor =
        selected &&
        (links || []).some((l) => (l.site_a === selected && l.site_b === s.name) || (l.site_b === selected && l.site_a === s.name));
      const dimmed = selected && !isSel && !neighbor;
      m.setStyle({
        fillColor: C[s.status] || C.unknown,
        color: isSel ? "#9184d9" : "#e9e9ed",
        weight: isSel ? 3.5 : 2.5,
        opacity: dimmed ? 0.45 : 1,
        fillOpacity: dimmed ? 0.45 : 1,
      });
      if (m._path) m._path.classList.toggle("site-down", s.status === "down");
    }
    for (const name of Object.keys(lay.sites)) {
      if (!liveSites.has(name)) {
        lay.sites[name].remove();
        delete lay.sites[name];
      }
    }
  }, [data, selected, theme]);

  // Destroy the map on unmount (route change).
  React.useEffect(
    () => () => {
      if (mapRef.current) { mapRef.current.remove(); mapRef.current = null; }
      layersRef.current = { sites: {}, links: {} };
      tileRef.current = null;
      tileThemeRef.current = null;
    },
    []
  );

  const { sites, links, events, at, error } = data;
  const counts = { up: 0, degraded: 0, down: 0, unknown: 0 };
  for (const s of sites || []) counts[s.status] = (counts[s.status] || 0) + 1;
  const fiberAlarms = (links || []).filter((l) => l.status === "down" || l.status === "degraded").length;
  const sel = (sites || []).find((s) => s.name === selected) || null;
  const selLinks = sel ? (links || []).filter((l) => l.site_a === sel.name || l.site_b === sel.name) : [];
  const siteRows = (sites || [])
    .slice()
    .sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.name.localeCompare(b.name));

  return (
    <div className="map-page" ref={rootRef}>
      <div className="map-head">
        <span className="map-head-dot" style={{ background: error ? C.degraded : C.up }} />
        <span className="map-head-brand">TCS NETMON</span>
        <span className="map-head-sub">DISTRICT FIBER MAP</span>
        <div className="map-head-counts mono">
          <span style={{ color: C.up }}>● {counts.up} UP</span>
          <span style={{ color: C.degraded }}>● {counts.degraded} DEGRADED</span>
          <span style={{ color: C.down }}>● {counts.down} DOWN</span>
          {counts.unknown > 0 && <span style={{ color: C.unknown }}>● {counts.unknown} NO DATA</span>}
          <span className="dim">│ {fiberAlarms} FIBER ALARMS</span>
        </div>
        <span className="map-head-clock mono">{clock}</span>
        <button type="button" className="btn" onClick={cycleTheme} title="Cycle basemap">
          {theme.toUpperCase()}
        </button>
        <button type="button" className="btn" onClick={toggleNoc}>
          {noc ? "EXIT NOC" : "NOC MODE"}
        </button>
      </div>

      <div className="map-body">
        <div className="map-canvas-wrap">
          <div className="map-canvas" ref={mapEl} />

          {!sites && !error && <div className="map-overlay-msg mono">LOADING MAP DATA…</div>}
          {sites && sites.length === 0 && (
            <div className="map-overlay-msg mono">
              NO SITES IN THE MAP REGISTRY — curate topology.example.json and run
              &nbsp;<code>python -m netmon.topology &lt;file&gt;</code>
            </div>
          )}
          {!sites && error && <div className="map-overlay-msg mono">NETMON API UNREACHABLE</div>}

          <div className="map-chips">
            {tilesDown && <div className="map-chip mono">MAP TILES UNREACHABLE — SHOWING TOPOLOGY ONLY</div>}
            {error && at && (
              <div className="map-chip mono">API UNREACHABLE — DATA {ago(at)} OLD</div>
            )}
          </div>

          <div className="map-feed">
            <div className="map-feed-head">
              <span>EVENT FEED</span>
              <span className="map-feed-live mono">
                <span className="map-head-dot" style={{ background: error ? C.degraded : C.up }} />
                {error ? "stale" : "live"}
              </span>
            </div>
            <div className="map-feed-body">
              {(events || []).map((e) => {
                const color = e.severity === "crit" ? C.down : e.severity === "warn" ? C.degraded : e.severity === "ok" ? C.up : C.unknown;
                return (
                  <div className="map-feed-row mono" key={e.id}>
                    <span className="dim">{fmtTime(e.occurred_at)}</span>
                    <span style={{ color }} className="map-feed-sev">{e.severity.toUpperCase()}</span>
                    <span>
                      {e.site ? `${e.site} · ` : ""}{e.device}: {e.dimension} {e.old_value ?? "?"} → {e.new_value ?? "?"}
                    </span>
                  </div>
                );
              })}
              {events && events.length === 0 && (
                <div className="map-feed-empty mono">No events yet — all systems nominal</div>
              )}
            </div>
          </div>

          <div className="map-legend">
            {["up", "degraded", "down", "unknown"].map((k) => (
              <div key={k}><span className="map-legend-dot" style={{ background: C[k] }} />{STATUS_LABEL[k][0] + STATUS_LABEL[k].slice(1).toLowerCase()}</div>
            ))}
            <div className="map-legend-sep" />
            <div><span className="map-legend-line" style={{ height: 5, background: C.up }} />10G trunk</div>
            <div><span className="map-legend-line" style={{ height: 3, background: C.up }} />1G lateral</div>
            <div><span className="map-legend-line" style={{ height: 3, background: C.hot }} />&gt;85% utilized</div>
            <div className="dim mono map-legend-note">dashes flow with traffic</div>
          </div>
        </div>

        {!noc && (
          <div className="map-panel">
            {sel ? (
              <>
                <div className="map-panel-head">
                  <button type="button" className="btn" onClick={() => setSelected(null)}>←</button>
                  <div className="map-panel-title">
                    <div className="map-panel-name">{sel.display_name || sel.name}</div>
                    <div className="dim mono">
                      {sel.name} · {TIER_LABEL[sel.tier] || sel.tier} · {sel.devices_total} device{sel.devices_total === 1 ? "" : "s"}
                      {sel.devices_down > 0 && ` · ${sel.devices_down} down`}
                      {sel.devices_degraded > 0 && ` · ${sel.devices_degraded} impaired`}
                    </div>
                  </div>
                  <span
                    className="map-panel-badge mono"
                    style={{ background: (C[sel.status] || C.unknown) + "26", color: C[sel.status] || C.unknown }}
                  >
                    {STATUS_LABEL[sel.status]}
                  </span>
                </div>
                <div className="map-panel-body">
                  <div className="map-panel-kicker mono">FIBER LINKS ({selLinks.length})</div>
                  {selLinks.map((l) => {
                    const otherName = l.site_a === sel.name ? l.site_b : l.site_a;
                    const other = (sites || []).find((s) => s.name === otherName);
                    const color = linkColor(l);
                    const pct = l.status === "down" ? 0 : l.utilization_pct;
                    return (
                      <div className="map-panel-link" key={l.id} onClick={() => setSelected(otherName)}>
                        <div className="map-panel-link-top">
                          <span className="map-panel-link-sq" style={{ background: color }} />
                          <span className="map-panel-link-name">{other?.display_name || otherName}</span>
                          <span className="dim mono">{l.capacity_gbps}G</span>
                        </div>
                        <div className="map-panel-link-bar-row">
                          <div className="map-panel-link-bar">
                            <div style={{ width: `${Math.round(pct || 0)}%`, background: color }} />
                          </div>
                          <span className="mono" style={{ color }}>
                            {l.status !== "up"
                              ? STATUS_LABEL[l.status]
                              : pct == null
                                ? "no data"
                                : `${Math.round(pct)}% · ${((pct * l.capacity_gbps) / 100).toFixed(1)}G`}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                  {selLinks.length === 0 && <div className="msg">No fiber links registered for this site.</div>}
                </div>
              </>
            ) : (
              <>
                <div className="map-panel-head">
                  <div className="map-panel-title">
                    <div className="map-panel-name">Sites</div>
                    <div className="dim">Click a site for fiber link detail</div>
                  </div>
                </div>
                <div className="map-panel-body map-panel-list">
                  {siteRows.map((s) => (
                    <div className="map-site-row" key={s.name} onClick={() => setSelected(s.name)}>
                      <span className="map-legend-dot" style={{ background: C[s.status] || C.unknown }} />
                      <div className="map-site-row-text">
                        <div className="map-site-row-name">{s.display_name || s.name}</div>
                        <div className="dim mono">
                          {s.name} · {s.devices_total} dev
                          {s.devices_down > 0 && ` · ${s.devices_down} down`}
                          {s.devices_degraded > 0 && ` · ${s.devices_degraded} impaired`}
                        </div>
                      </div>
                      <span className="mono map-site-row-status" style={{ color: C[s.status] || C.unknown }}>
                        {STATUS_LABEL[s.status]}
                      </span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
