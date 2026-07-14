# Spec 09 — Geographic site-status map (NOC wall view)

**Status:** planned, not started. This spec captures scope + open decisions for
the milestone; it is fleshed out (and its checklist filled) when the phase
begins. **Do not implement yet.**

**Design source:** `docs/design/netmon-map/` — a Claude Design handoff bundle.
The primary prototype is `project/Netmon Map.dc.html` (Leaflet + a React-ish
`DCLogic` component running on *simulated* data). Recreate its visual output on
NetMon's real endpoints; do not copy the prototype's internal structure or its
simulation loop.

## What it is

A geographic map of the district (Leaflet) as an at-a-glance operational view:

- **Sites as status dots** — one marker per site at its lat/lon, colored
  up / degraded / down, sized by tier (hub / high / middle / elementary),
  pulsing when down.
- **Inter-site fiber links** — polylines between sites, weighted by capacity
  (10G trunk vs 1G lateral), colored by status and by utilization (>85% =
  "hot"), with animated flow dashes whose speed tracks utilization; a down
  link stops flowing.
- **Header strip** — live UP / DEGRADED / DOWN site counts, a fiber-alarm
  count, a clock, and a **NOC mode** toggle (fullscreen wall display).
- **Live event feed** (bottom-left) — recent state transitions.
- **Legend** (bottom-right).
- **Side panel** — a status-sorted site list, or, when a site is selected,
  that site's fiber links with per-link utilization bars.
- **Basemap toggle** — dark / light / satellite tiles.

## How it maps onto NetMon

| Prototype concept | NetMon source |
|---|---|
| Site status (up/deg/down) | Aggregate roll-up of `device_state` across a site's devices (worst-of ping / `source_status`); new `/api/sites` endpoint |
| Event feed | `state_events` (already the only history table) |
| Site lat/lon, tier | New per-site metadata (curated) — extends the site model |
| Fiber links (topology) | **New data** — inter-site link registry (see below) |
| Link utilization (live %) | **New data** — current-state uplink/trunk utilization |
| NOC mode | Frontend-only (fullscreen) |

## Prerequisites (what must land first)

- Phase 1 registry with `site` (done) — but sites need **lat/lon + tier**
  metadata this map introduces.
- Phase 2 poller (ping/snmp) and Phase 3 XIQ collector (`source_status`) so
  site roll-up reflects real state.
- Phase 4 UI pipeline (esbuild, `global-nav.jsx` routing) — this is a new page
  on that pipeline.

## Open decisions (resolve at phase start — do not guess)

1. **Map tiles as a runtime data source.** The prototype pulls CARTO / Esri
   basemaps and Leaflet from CDNs. Under the clarified runtime-resilience goal
   (CLAUDE.md §9, 2026-07-13), pulling map *tiles* from a provider at runtime is
   acceptable **provided the map degrades gracefully when the network is down**
   (the prototype already shows a "MAP TILES UNREACHABLE" state — keep it).
   Leaflet and the app JS/CSS are still bundled locally via esbuild, never from
   a CDN — that is the separate §3 app-bundle rule (reproducibility/security),
   not an offline one. Optional hardening: a self-hosted district-bbox tile
   pack to remove even the tile dependency. Bundling Leaflet is a new frontend
   dep — flag for approval when the phase starts.
2. **Fiber-link topology source.** A link registry (site-A ↔ site-B, capacity,
   path polyline) is new. Options: a curated table/config maintained by the
   owner, or derived from LLDP/CDP neighbor data via SNMP/XIQ. Site
   coordinates and tier are curated regardless.
3. **Link utilization is current-state only.** Show a live gauge (read from
   switch uplink port stats / SNMP), never stored history — stays inside the
   §2 scope boundary (no long-term time-series). Confirm the read path
   (XIQ port stats vs. SNMP ifHCInOctets deltas).
4. **`trunk` dimension collision.** `device_state.dimension = 'trunk'` currently
   means a *voice* (3CX) trunk. Fiber links are a different concept — model
   them separately (new dimension/table), don't overload `trunk`.
5. **Data-model extension** for 1–2 above goes through a numbered migration
   with a rollback note (CLAUDE.md §6 rule).

## Scope guard

This is an operational **current-state view** + a curated topology overlay. It
must not become a metrics/graphing feature — no historical utilization charts,
no per-link time-series storage. If a task here implies storing metric history,
stop and flag it against §2.
