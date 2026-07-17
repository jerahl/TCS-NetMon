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

// Detail-aware write (surfaces the API's gating/validation message, e.g.
// "web editing is disabled") used only by the admin map editor.
async function editReq(method, path, body) {
  const resp = await fetch(path, {
    method, credentials: "same-origin",
    headers: { Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (resp.status === 401) { window.location.assign("/login"); throw new Error("redirecting to sign in"); }
  if (!resp.ok) throw new Error((await resp.json().catch(() => ({}))).detail || `HTTP ${resp.status}`);
  return resp.status === 204 ? null : resp.json();
}

// Small round drag-handle icons (divIcon = CSS only, no marker image assets).
const handleIcon = (kind) => L.divIcon({ className: `edit-handle eh-${kind}`, iconSize: [14, 14] });

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

const fmtSpeed = (mbps) => (!mbps ? "" : mbps >= 1000 ? `${mbps / 1000}G` : `${mbps}M`);

// Site-label placement → Leaflet tooltip direction + offset (default top).
function labelTip(pos) {
  switch ((pos || "top").toLowerCase()) {
    case "bottom": return { direction: "bottom", offset: [0, 8] };
    case "left": return { direction: "left", offset: [-8, 0] };
    case "right": return { direction: "right", offset: [8, 0] };
    default: return { direction: "top", offset: [0, -8] };
  }
}

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

  // ---- admin map editor (drag sites, edit fiber paths) ----
  const [canEdit, setCanEdit] = React.useState(false);   // admin && [security] allow_web_edit
  const [edit, setEdit] = React.useState(false);         // edit mode on
  const [editLink, setEditLink] = React.useState(null);  // link id whose path is being edited
  const [linkAdd, setLinkAdd] = React.useState(false);   // picking two sites for a new link
  const [pendingA, setPendingA] = React.useState(null);  // first site picked for a new link
  const [editMsg, setEditMsg] = React.useState(null);
  const [linkForm, setLinkForm] = React.useState(null);  // {kind,provider,aDev,aIf,bDev,bIf} for the edited link
  const [fleet, setFleet] = React.useState([]);          // switches for the port pickers
  const [portsByDev, setPortsByDev] = React.useState({});// deviceId → [{ifindex,name,oper_state}]
  const [edpByDev, setEdpByDev] = React.useState({});    // deviceId → Set(ifindex) with an EDP neighbor

  const rootRef = React.useRef(null);
  const mapEl = React.useRef(null);
  const mapRef = React.useRef(null);
  const tileRef = React.useRef(null);
  const tileThemeRef = React.useRef(null);
  const layersRef = React.useRef({ sites: {}, links: {} });
  const editRef = React.useRef({ siteHandles: {}, vertexHandles: [], midHandles: [], workPath: null, workPathLinkId: null });
  const dataRef = React.useRef(data);
  dataRef.current = data;
  // Refs so Leaflet click/drag callbacks (bound once) see current edit state.
  const editModeRef = React.useRef(false); editModeRef.current = edit;
  const editLinkRef = React.useRef(null); editLinkRef.current = editLink;
  const linkAddRef = React.useRef(false); linkAddRef.current = linkAdd;
  const pendingARef = React.useRef(null); pendingARef.current = pendingA;
  const pickRef = React.useRef(() => {});   // latest pickSiteForLink for bound-once handlers
  const capInputRef = React.useRef(null);

  // Static fact: is web editing enabled AND am I an admin? Gates the EDIT button.
  React.useEffect(() => {
    Promise.all([getJSON("/api/meta").catch(() => ({})), getJSON("/auth/me").catch(() => ({}))])
      .then(([meta, me]) => setCanEdit(!!meta?.can_edit && me?.role === "admin"));
  }, []);

  // ---- live data: poll the three endpoints; keep last good data on failure.
  // Paused while editing so a poll never fights a drag or reverts an in-flight
  // path edit; on exit it reloads once (picking up saved edits) and resumes.
  React.useEffect(() => {
    if (edit) return;
    let live = true;
    const load = () =>
      Promise.all([getJSON("/api/sites"), getJSON("/api/links"), getJSON("/api/events?limit=40&exclude_device_type=ap")])
        .then(([sites, links, events]) => {
          if (live) setData({ sites, links, events, at: Date.now(), error: null });
        })
        .catch((error) => {
          if (live) setData((d) => ({ ...d, error }));
        });
    load();
    const t = setInterval(load, POLL_MS);
    return () => { live = false; clearInterval(t); };
  }, [edit]);

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
        line.on("click", (e) => {
          L.DomEvent.stop(e);
          if (editModeRef.current && !linkAddRef.current) { setSelected(null); setEditLink(l.id); }
          else setSelected(l.site_a);
        });
        line.bindTooltip(
          () => {
            const cur = (dataRef.current.links || []).find((x) => x.id === l.id) || l;
            const rate = cur.speed_mbps ? fmtSpeed(cur.speed_mbps) : `${cur.capacity_gbps}G`;
            const stat = cur.status === "up"
              ? (cur.utilization_pct == null ? "util: no data" : `${Math.round(cur.utilization_pct)}% of ${rate}`)
              : STATUS_LABEL[cur.status] || cur.status.toUpperCase();
            const own = cur.link_kind === "leased"
              ? `leased${cur.provider ? ` · ${cur.provider}` : ""}` : "district fiber";
            const ports = cur.port_backed ? "" : "<br><span style='opacity:.7'>no ports attached — status from sites</span>";
            return `${cur.site_a} ⟷ ${cur.site_b}<br>${rate} ${own} · ${stat}${ports}`;
          },
          { sticky: true, className: "link-tip" }
        );
        entry = lay.links[l.id] = { casing, line };
      } else if (!(editModeRef.current && editLinkRef.current === l.id)) {
        // While a link's path is being edited the edit effect owns its
        // geometry — don't let a re-render snap it back to the saved path.
        entry.casing.setLatLngs(path);
        entry.line.setLatLngs(path);
      }

      const color = linkColor(l);
      const leased = l.link_kind === "leased";
      const touched = selected && (l.site_a === selected || l.site_b === selected);
      const dimmed = selected && !touched;
      const w = l.capacity_gbps >= 10 ? 4.5 : 3;
      entry.line.setStyle({
        color,
        weight: touched ? w + 1.5 : w,
        opacity: dimmed ? 0.25 : 0.95,
        // Leased circuits render as a fine dotted line so they read as "not our
        // plant" at a glance; owned fiber keeps the flowing dashes.
        dashArray: leased ? "1 7" : l.status === "down" ? "3 9" : "8 7",
      });
      // Leased links get a lighter, tinted casing (not the solid black of owned).
      entry.casing.setStyle({
        color: leased ? "#b36bd4" : "#000",
        weight: (touched ? w + 1.5 : w) + 3.5,
        opacity: dimmed ? 0.1 : leased ? 0.5 : 0.35,
      });
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
        m.on("click", (e) => {
          L.DomEvent.stop(e);
          if (linkAddRef.current) { pickRef.current(s.name); return; }
          setSelected(s.name);
        });
        const lt = labelTip(s.label_pos);
        m.bindTooltip(s.name, { permanent: true, className: "site-tip", interactive: false, ...lt });
        m._labelPos = s.label_pos || "top";
        lay.sites[s.name] = m;
      } else {
        m.setLatLng([s.lat, s.lon]);
        // Re-place the label if its configured position changed.
        if ((s.label_pos || "top") !== m._labelPos) {
          m.unbindTooltip();
          const lt = labelTip(s.label_pos);
          m.bindTooltip(s.name, { permanent: true, className: "site-tip", interactive: false, ...lt });
          m._labelPos = s.label_pos || "top";
        }
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

  // ---- editor helpers (stable enough: only setState setters + refs) ----
  const refetch = React.useCallback(async () => {
    try {
      const [sites, links, events] = await Promise.all([
        getJSON("/api/sites"), getJSON("/api/links"), getJSON("/api/events?limit=40&exclude_device_type=ap")]);
      setData({ sites, links, events, at: Date.now(), error: null });
    } catch { /* keep last good data */ }
  }, []);

  // Registry site ids (name→id) for the location endpoint — /api/sites omits id.
  React.useEffect(() => {
    if (!edit) return;
    getJSON("/api/registry/sites")
      .then((rows) => { editRef.current.siteIds = Object.fromEntries(rows.map((r) => [r.name, r.id])); })
      .catch(() => { /* saves will error with a clear message */ });
  }, [edit]);

  const moveSiteLive = (name, latlng) => {
    const lay = layersRef.current;
    lay.sites[name]?.setLatLng(latlng);
    const { sites, links } = dataRef.current;
    const bySite = Object.fromEntries((sites || []).map((s) => [s.name, s]));
    for (const l of links || []) {
      if (l.site_a !== name && l.site_b !== name) continue;
      if (l.path && l.path.length >= 2) continue;   // curated path doesn't track a move
      const other = l.site_a === name ? l.site_b : l.site_a;
      const os = bySite[other];
      const entry = lay.links[l.id];
      if (!os || !entry) continue;
      const here = [latlng.lat, latlng.lng], there = [os.lat, os.lon];
      const pth = l.site_a === name ? [here, there] : [there, here];
      entry.line.setLatLngs(pth); entry.casing.setLatLngs(pth);
    }
  };

  const saveSiteLocation = async (name, latlng) => {
    const id = editRef.current.siteIds?.[name];
    const lat = +latlng.lat.toFixed(6), lon = +latlng.lng.toFixed(6);
    if (!id) { setEditMsg({ ok: false, text: `No registry id for ${name} — reopen edit mode.` }); return; }
    try {
      await editReq("POST", `/api/registry/sites/${id}/location`, { lat, lon });
      setData((d) => ({ ...d, sites: (d.sites || []).map((s) => (s.name === name ? { ...s, lat, lon } : s)) }));
      setEditMsg({ ok: true, text: `Moved ${name}.` });
    } catch (e) { setEditMsg({ ok: false, text: String(e.message || e) }); refetch(); }
  };

  const createLink = async (a, b) => {
    try {
      await editReq("POST", "/api/registry/links", { site_a: a, site_b: b });
      setEditMsg({ ok: true, text: `Linked ${a} ⟷ ${b}.` });
    } catch (e) { setEditMsg({ ok: false, text: String(e.message || e) }); }
    setLinkAdd(false); setPendingA(null); refetch();
  };

  const pickSiteForLink = (name) => {
    const a = pendingARef.current;
    if (!a) { setPendingA(name); setEditMsg({ ok: true, text: `Now click the other endpoint for a link from ${name}.` }); }
    else if (a === name) { setEditMsg({ ok: false, text: "Pick a different second site." }); }
    else createLink(a, name);
  };
  pickRef.current = pickSiteForLink;

  const renderPathHandles = (l, a, b) => {
    const map = mapRef.current, lay = layersRef.current, er = editRef.current;
    if (!map || !er.workPath) return;
    const wp = er.workPath;
    wp[0] = [a.lat, a.lon]; wp[wp.length - 1] = [b.lat, b.lon];   // ends pinned to sites
    const entry = lay.links[l.id];
    if (entry) { entry.line.setLatLngs(wp); entry.casing.setLatLngs(wp); }
    er.vertexHandles.forEach((h) => h.remove()); er.vertexHandles = [];
    er.midHandles.forEach((h) => h.remove()); er.midHandles = [];
    // draggable middle vertices (right-click removes)
    for (let i = 1; i < wp.length - 1; i++) {
      const idx = i;
      const h = L.marker(wp[idx], { draggable: true, icon: handleIcon("vtx"), zIndexOffset: 1300, keyboard: false }).addTo(map);
      h.on("drag", (ev) => { wp[idx] = [ev.latlng.lat, ev.latlng.lng]; if (entry) { entry.line.setLatLngs(wp); entry.casing.setLatLngs(wp); } });
      h.on("dragend", () => renderPathHandles(l, a, b));
      h.on("contextmenu", (ev) => { L.DomEvent.stop(ev); if (wp.length > 2) { wp.splice(idx, 1); renderPathHandles(l, a, b); } });
      er.vertexHandles.push(h);
    }
    // faded midpoint handles: drag one to insert a new waypoint there
    for (let i = 0; i < wp.length - 1; i++) {
      const insertAt = i + 1;
      const mid = [(wp[i][0] + wp[i + 1][0]) / 2, (wp[i][1] + wp[i + 1][1]) / 2];
      const h = L.marker(mid, { draggable: true, icon: handleIcon("mid"), zIndexOffset: 1250, opacity: 0.85, keyboard: false }).addTo(map);
      h.on("dragstart", (ev) => { const ll = ev.target.getLatLng(); wp.splice(insertAt, 0, [ll.lat, ll.lng]); });
      h.on("drag", (ev) => { wp[insertAt] = [ev.latlng.lat, ev.latlng.lng]; if (entry) { entry.line.setLatLngs(wp); entry.casing.setLatLngs(wp); } });
      h.on("dragend", () => renderPathHandles(l, a, b));
      er.midHandles.push(h);
    }
  };

  const saveLinkPath = async () => {
    const er = editRef.current, id = editLinkRef.current, wp = er.workPath;
    if (id == null || !wp) return;
    try {
      await editReq("PUT", `/api/registry/links/${id}`,
        wp.length <= 2 ? { clear_path: true } : { path: wp });
      setEditMsg({ ok: true, text: "Saved fiber path." });
      setEditLink(null); refetch();
    } catch (e) { setEditMsg({ ok: false, text: String(e.message || e) }); }
  };

  const removeLink = async (id) => {
    try {
      await editReq("DELETE", `/api/registry/links/${id}`);
      setEditMsg({ ok: true, text: "Fiber link deleted." });
      setEditLink(null); refetch();
    } catch (e) { setEditMsg({ ok: false, text: String(e.message || e) }); }
  };

  // Load ports for a switch on demand (port pickers), cached per device. Also
  // load its EDP neighbors so the fiber-link port picker can offer ONLY the
  // ports that have an EDP neighbor — the inter-switch trunk uplinks a fiber
  // link actually patches into (owner directive 2026-07-17).
  const loadPorts = React.useCallback((devId) => {
    if (!devId) return;
    setPortsByDev((m) => (m[devId] ? m : { ...m, [devId]: [] }));   // mark loading
    getJSON(`/api/switches/${devId}/ports`)
      .then((ps) => setPortsByDev((m) => ({ ...m, [devId]: ps })))
      .catch(() => { /* leave empty; free-typing still works via ifindex */ });
    getJSON(`/api/switches/${devId}/neighbors`)
      .then((ns) => setEdpByDev((m) => ({
        ...m,
        [devId]: new Set(
          (ns || [])
            .filter((n) => String(n.protocol || "").toLowerCase() === "edp")
            .map((n) => n.local_ifindex)
        ),
      })))
      .catch(() => { /* no neighbor data → picker shows all ports as fallback */ });
  }, []);

  // When a link is opened for editing, prime the details/ports form from the
  // registry row (which carries kind/provider/port refs the map API omits) and
  // fetch the switch fleet for the pickers.
  React.useEffect(() => {
    if (!edit || editLink == null) { setLinkForm(null); return; }
    let live = true;
    Promise.all([
      getJSON("/api/registry/links").catch(() => []),
      fleet.length ? Promise.resolve(fleet) : getJSON("/api/switches").catch(() => []),
    ]).then(([rlinks, sw]) => {
      if (!live) return;
      if (!fleet.length) setFleet(sw);
      const l = (rlinks || []).find((x) => x.id === editLink);
      if (!l) return;
      setLinkForm({
        kind: l.link_kind || "owned", provider: l.provider || "",
        aDev: l.a_device_id ?? "", aIf: l.a_ifindex ?? "",
        bDev: l.b_device_id ?? "", bIf: l.b_ifindex ?? "",
      });
      if (l.a_device_id) loadPorts(l.a_device_id);
      if (l.b_device_id) loadPorts(l.b_device_id);
    });
    return () => { live = false; };
  }, [edit, editLink]);  // eslint-disable-line react-hooks/exhaustive-deps

  const saveLinkDetails = async () => {
    const f = linkForm; if (!f) return;
    try {
      await editReq("PUT", `/api/registry/links/${editLinkRef.current}`, {
        capacity_gbps: parseFloat(capInputRef.current.value),
        link_kind: f.kind,
        provider: f.kind === "leased" ? (f.provider || null) : null,
      });
      setEditMsg({ ok: true, text: "Saved link details." }); refetch();
    } catch (e) { setEditMsg({ ok: false, text: String(e.message || e) }); }
  };

  const saveLinkPorts = async () => {
    const f = linkForm; if (!f) return;
    const num = (v) => (v === "" || v == null ? null : Number(v));
    try {
      await editReq("PUT", `/api/registry/links/${editLinkRef.current}`, {
        set_ports: true,
        a_device_id: num(f.aDev), a_ifindex: num(f.aIf),
        b_device_id: num(f.bDev), b_ifindex: num(f.bIf),
      });
      setEditMsg({ ok: true, text: "Saved link ports — status now follows them." }); refetch();
    } catch (e) { setEditMsg({ ok: false, text: String(e.message || e) }); }
  };

  const detachLinkPorts = async () => {
    try {
      await editReq("PUT", `/api/registry/links/${editLinkRef.current}`, { clear_ports: true });
      setLinkForm((f) => ({ ...f, aDev: "", aIf: "", bDev: "", bIf: "" }));
      setEditMsg({ ok: true, text: "Detached ports." }); refetch();
    } catch (e) { setEditMsg({ ok: false, text: String(e.message || e) }); }
  };

  // ---- edit-handle layer: site drag handles, or a link's path vertices ----
  React.useEffect(() => {
    const map = mapRef.current, er = editRef.current;
    const clear = () => {
      Object.values(er.siteHandles).forEach((h) => h.remove()); er.siteHandles = {};
      er.vertexHandles.forEach((h) => h.remove()); er.vertexHandles = [];
      er.midHandles.forEach((h) => h.remove()); er.midHandles = [];
    };
    clear();
    if (!map || !edit) { er.workPath = null; er.workPathLinkId = null; return; }
    const { sites, links } = dataRef.current;
    const bySite = Object.fromEntries((sites || []).map((s) => [s.name, s]));

    if (editLink == null) {
      for (const s of sites || []) {
        if (linkAdd) {
          // Add-link mode: the handle is a click target, NOT draggable — it
          // overlays the site dot, so it must own the pick click (otherwise a
          // click hits this handle and never reaches the site).
          const kind = pendingA === s.name ? "pick-sel" : "pick";
          const h = L.marker([s.lat, s.lon], { icon: handleIcon(kind), zIndexOffset: 1200, keyboard: false }).addTo(map);
          h.on("click", (ev) => { L.DomEvent.stop(ev); pickRef.current(s.name); });
          er.siteHandles[s.name] = h;
        } else {
          const h = L.marker([s.lat, s.lon], { draggable: true, icon: handleIcon("site"), zIndexOffset: 1200, keyboard: false }).addTo(map);
          h.on("drag", (ev) => moveSiteLive(s.name, ev.latlng));
          h.on("dragend", (ev) => saveSiteLocation(s.name, ev.target.getLatLng()));
          er.siteHandles[s.name] = h;
        }
      }
    } else {
      const l = (links || []).find((x) => x.id === editLink);
      const a = l && bySite[l.site_a], b = l && bySite[l.site_b];
      if (l && a && b) {
        if (er.workPathLinkId !== editLink) {
          er.workPath = (l.path && l.path.length >= 2)
            ? l.path.map((p) => [+p[0], +p[1]]) : [[a.lat, a.lon], [b.lat, b.lon]];
          er.workPathLinkId = editLink;
        }
        renderPathHandles(l, a, b);
      }
    }
    return clear;
  }, [edit, editLink, linkAdd, pendingA, data]);   // eslint-disable-line react-hooks/exhaustive-deps

  const exitEdit = () => { setEdit(false); setEditLink(null); setLinkAdd(false); setPendingA(null); setEditMsg(null); };

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
        {canEdit && (
          <button type="button" className="btn"
                  style={edit ? { borderColor: "#e8a415", color: "#e8a415" } : undefined}
                  onClick={() => (edit ? exitEdit() : setEdit(true))}>
            {edit ? "DONE EDITING" : "EDIT MAP"}
          </button>
        )}
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

        {!noc && edit && (
          <div className="map-panel">
            <div className="map-panel-head">
              <div className="map-panel-title">
                <div className="map-panel-name">Edit map</div>
                <div className="dim">Drag a site to move it · click a fiber line to edit its path</div>
              </div>
              <span className="map-panel-badge mono" style={{ background: "#e8a41526", color: "#e8a415" }}>EDITING</span>
            </div>
            <div className="map-panel-body">
              {editMsg && <div className={"msg" + (editMsg.ok ? "" : " error")}>{editMsg.text}</div>}
              {(() => {
                const elink = (links || []).find((l) => l.id === editLink);
                if (elink) {
                  return (
                    <div className="edit-linkbox">
                      <div className="map-panel-kicker mono">FIBER PATH · {elink.site_a} ⟷ {elink.site_b}</div>
                      <div className="dim" style={{ fontSize: 11, margin: "4px 0 8px" }}>
                        Drag ○ to move a waypoint · drag a faint + to add one · right-click ○ to remove.
                        Endpoints follow their sites.
                      </div>
                      <div className="edit-row" style={{ marginTop: 10 }}>
                        <button type="button" className="btn" onClick={saveLinkPath}>Save path</button>
                        <button type="button" className="btn" onClick={() => { setEditLink(null); refetch(); }}>Cancel</button>
                      </div>

                      <div className="map-panel-kicker mono" style={{ marginTop: 14 }}>LINK DETAILS</div>
                      <div className="edit-row" style={{ marginTop: 6 }}>
                        <label className="dim">Capacity (G)</label>
                        <input key={editLink} ref={capInputRef} className="enum-in" style={{ width: 64 }}
                               type="number" min="0.1" step="0.5" defaultValue={elink.capacity_gbps} />
                        <label className="dim">Type</label>
                        <select className="enum-in" style={{ width: 90 }} value={linkForm?.kind || "owned"}
                                onChange={(e) => setLinkForm((f) => ({ ...f, kind: e.target.value }))}>
                          <option value="owned">owned</option>
                          <option value="leased">leased</option>
                        </select>
                      </div>
                      {linkForm?.kind === "leased" && (
                        <div className="edit-row" style={{ marginTop: 6 }}>
                          <label className="dim">Provider</label>
                          <input className="enum-in" style={{ flex: 1 }} placeholder="e.g. C-Spire"
                                 value={linkForm?.provider || ""}
                                 onChange={(e) => setLinkForm((f) => ({ ...f, provider: e.target.value }))} />
                        </div>
                      )}
                      <div className="edit-row" style={{ marginTop: 6 }}>
                        <button type="button" className="btn" onClick={saveLinkDetails}>Save details</button>
                      </div>

                      <div className="map-panel-kicker mono" style={{ marginTop: 14 }}>ATTACHED PORTS</div>
                      <div className="dim" style={{ fontSize: 11, margin: "2px 0 6px" }}>
                        Patch each end into a switch's EDP uplink port to drive the link's up/down, speed, and utilization from the real circuit. Only EDP-discovered ports are listed.
                      </div>
                      {["a", "b"].map((end) => {
                        const dk = `${end}Dev`, ik = `${end}If`;
                        const devVal = linkForm?.[dk] ?? "";
                        const curIf = linkForm?.[ik] ?? "";
                        const edp = edpByDev[devVal];   // Set(ifindex), or undefined while loading
                        // Only EDP ports; keep the currently-saved port visible even if it
                        // isn't (a legacy attach), so the selection still renders.
                        const ports = (portsByDev[devVal] || []).filter(
                          (p) => !edp || edp.has(p.ifindex) || String(p.ifindex) === String(curIf)
                        );
                        return (
                          <div className="edit-row" key={end} style={{ marginTop: 4 }}>
                            <label className="dim" style={{ width: 42 }}>{end === "a" ? elink.site_a : elink.site_b}</label>
                            <select className="enum-in" style={{ flex: 1 }} value={devVal}
                                    onChange={(e) => { const v = e.target.value;
                                      setLinkForm((f) => ({ ...f, [dk]: v, [ik]: "" })); if (v) loadPorts(v); }}>
                              <option value="">— switch —</option>
                              {fleet.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                            </select>
                            <select className="enum-in" style={{ width: 110 }} value={curIf}
                                    disabled={!devVal}
                                    onChange={(e) => setLinkForm((f) => ({ ...f, [ik]: e.target.value }))}>
                              <option value="">— port —</option>
                              {ports.map((p) => (
                                <option key={p.ifindex} value={p.ifindex}>
                                  {(p.name || p.ifindex) + (p.oper_state ? ` (${p.oper_state})` : "")}
                                </option>
                              ))}
                            </select>
                            {devVal && edp && ports.length === 0 && (
                              <span className="dim" style={{ fontSize: 11 }}>no EDP ports</span>
                            )}
                          </div>
                        );
                      })}
                      <div className="edit-row" style={{ marginTop: 6 }}>
                        <button type="button" className="btn" onClick={saveLinkPorts}>Save ports</button>
                        <button type="button" className="btn" onClick={detachLinkPorts}>Detach</button>
                      </div>

                      <div className="edit-row" style={{ marginTop: 12 }}>
                        <button type="button" className="btn" onClick={() => removeLink(elink.id)}
                                style={{ borderColor: "#e5484d", color: "#e5484d" }}>Delete link</button>
                      </div>
                    </div>
                  );
                }
                return (
                  <div className="edit-linkbox">
                    <div className="edit-row">
                      <button type="button" className="btn"
                              style={linkAdd ? { borderColor: "#e8a415", color: "#e8a415" } : undefined}
                              onClick={() => { setLinkAdd((v) => !v); setPendingA(null); setEditMsg(linkAdd ? null : { ok: true, text: "Click the first site, then the second." }); }}>
                        {linkAdd ? "Cancel add-link" : "+ Add fiber link"}
                      </button>
                      {linkAdd && pendingA && <span className="dim mono">from {pendingA}…</span>}
                    </div>
                    <div className="map-panel-kicker mono" style={{ marginTop: 12 }}>FIBER LINKS ({(links || []).length})</div>
                    {(links || []).map((l) => (
                      <div className="map-site-row" key={l.id}>
                        <span className="map-legend-dot" style={{ background: linkColor(l) }} />
                        <div className="map-site-row-text">
                          <div className="map-site-row-name">{l.site_a} ⟷ {l.site_b}</div>
                          <div className="dim mono">{l.capacity_gbps}G · {l.path ? `${l.path.length}-pt path` : "straight"}</div>
                        </div>
                        <button type="button" className="btn" onClick={() => { setSelected(null); setEditLink(l.id); }}>Path</button>
                      </div>
                    ))}
                    {(links || []).length === 0 && <div className="msg">No fiber links yet — add one.</div>}
                  </div>
                );
              })()}
            </div>
          </div>
        )}

        {!noc && !edit && (
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
                      {sel.devices_degraded > 0 && ` · ${sel.devices_degraded} switch${sel.devices_degraded === 1 ? "" : "es"} down`}
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
                          {s.devices_degraded > 0 && ` · ${s.devices_degraded} switch${s.devices_degraded === 1 ? "" : "es"} down`}
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
