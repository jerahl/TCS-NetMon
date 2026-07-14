# Runbook — Geographic site-status map (Phase 9)

The NOC wall view at `/ui/#/map` (nav: **Site Map**). Spec: `docs/spec/09-site-map.md`.

## Enabling it on a deployment

1. **Apply the migration** (adds `sites`, `fiber_links`, `fiber_link_state`;
   touches no existing table):

       netmon-migrate            # or: python -m netmon.migrate

2. **Curate the topology.** Copy `topology.example.json` somewhere private
   (e.g. `/etc/netmon/topology.json`) and edit:
   - `sites[].name` **must equal** the device registry's `devices.site` value
     (the Zabbix `Site/<name>` group name, e.g. `BHS`) — it is the roll-up
     join key. `display_name`, `tier` (`hub|high|middle|elementary|other`),
     `lat`, `lon` are yours to curate.
   - `links[]` use `a`/`b` site names, `capacity_gbps`, and an optional
     `path` polyline (`[[lat,lon],…]`) tracing the street route; omit `path`
     for a straight line.
   - The example's coordinates are the design prototype's approximations —
     replace with real ones.

3. **Import** (idempotent; re-run after every edit):

       python -m netmon.topology /etc/netmon/topology.json --dry-run   # inspect first
       python -m netmon.topology /etc/netmon/topology.json

   The importer **warns** about curated site names that match no device —
   fix the name rather than ignoring it (mismatched sites roll up as
   NO DATA). To retire a site/link, set `"enabled": false` in the JSON and
   re-import; the importer never deletes rows.

4. Reload the page. No service restart is needed — the API reads the tables
   live.

## How status is computed (what the colors mean)

- **Site** — rolled up from `device_state` over the site's enabled devices:
  **DOWN** = every ping-monitored device is down; **DEGRADED** = any device
  down or with a warn/crit state (snmp dead, source blind, camera not
  recording…); **NO DATA** = no state recorded (never shown as up);
  **UP** otherwise.
- **Fiber link** — worst of (a) endpoint-derived status (either end site
  down ⇒ link down; both ends NO DATA ⇒ NO DATA; else up) and (b)
  `fiber_link_state.status` when a collector writes one.
- **Utilization** — `fiber_link_state.utilization_pct`. **No collector
  writes it yet** (read path undecided — spec 09 "Next session"), so bars
  show *no data*. That is honest, not broken.

## Failure modes

| Symptom | Meaning | Action |
|---|---|---|
| `NO SITES IN THE MAP REGISTRY` overlay | `sites` table empty | Run the importer (steps 2–3) |
| `MAP TILES UNREACHABLE` chip, gray background | Basemap tile provider unreachable (district offline, provider down, egress blocked) | None required — topology/status still live (tiles are the one approved external fetch; see below) |
| `API UNREACHABLE — DATA <age> OLD` chip, feed shows *stale* | Browser can't reach the NetMon API | Check nginx/uvicorn; the page keeps the last good data and shows its age |
| A site shows NO DATA but has devices | `sites.name` ≠ `devices.site` spelling | Fix the JSON, re-import (the importer's warning lists these) |

## Basemap tiles (the external-fetch exception)

Leaflet and all app JS/CSS are bundled locally (no CDN). Only the basemap
**tiles** are fetched at runtime — CARTO (dark/light) and Esri (satellite) —
owner-approved 2026-07-13/14 with the graceful-degradation requirement above.
To go fully offline later, host a district-bbox tile pack and change the
`TILES` constants at the top of `frontend/src/pages/map.jsx`, then rebuild
(`npm --prefix frontend run build`).

## Rollback

Migration 004's rollback note: drop `fiber_link_state`, `fiber_links`,
`sites` (in that order) and delete `schema_migrations` row `004`. The curated
topology is re-importable from your JSON at any time. The map page itself
degrades to the "no sites" overlay if the tables are absent — the rest of the
UI is unaffected.
