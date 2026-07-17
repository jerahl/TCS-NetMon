# Runbook — Geographic site-status map (Phase 9)

The NOC wall view at `/ui/#/map` (nav: **Site Map**). Spec: `docs/spec/09-site-map.md`.

## Enabling it on a deployment

1. **Apply the migration** (adds `sites`, `fiber_links`, `fiber_link_state`;
   touches no existing table):

       netmon-migrate            # or: python -m netmon.migrate

2. **Curate the topology** — either format, same validation:

   **KML/KMZ (recommended — draw it in Google My Maps / Google Earth):**
   - **Sites are Point placemarks.** Placemark *name* = the site name, with
     or without the Zabbix-style prefix (`Site/BHS` or `BHS` — the prefix is
     stripped). It **must equal** the device registry's `devices.site` value —
     that is the roll-up join key. Placemark *description* = the display name
     (e.g. `Paul W. Bryant High`); add an optional line `tier: high`
     (`hub|high|middle|elementary|other`, default `other`) to size the dot.
   - **Fiber links are Line placemarks.** Name the placemark `A-B` and/or put
     these lines in its description (description wins):

         a: CO
         b: BHS
         capacity_gbps: 10

     The line you draw **is** the link's path on the map — trace the street
     route. Capacity defaults to 1 Gbps when unstated.
   - Export as KML or KMZ (both import directly). Polygons/folders are
     ignored.

   **JSON:** copy `topology.example.json` somewhere private
   (e.g. `/etc/netmon/topology.json`); same fields — `sites[].name`,
   `display_name`, `tier`, `lat`, `lon`; `links[]` with `a`/`b`,
   `capacity_gbps`, optional `path` polyline (`[[lat,lon],…]`; omitted =
   straight line). The example's coordinates are the design prototype's
   approximations — replace with real ones.

3. **Import** (idempotent; re-run after every edit):

       python -m netmon.topology /etc/netmon/district.kml --dry-run   # inspect first
       python -m netmon.topology /etc/netmon/district.kml

   The importer **warns** about curated site names that match no device —
   fix the name, or **link the map site to the network group** instead (see
   below), rather than ignoring it (mismatched sites roll up as NO DATA). The importer never deletes rows, so deleting a placemark from
   the KML only stops future updates — to retire a site/link, set
   `"enabled": false` via the JSON format (or `UPDATE sites/fiber_links SET
   enabled=0` directly) .

4. Reload the page. No service restart is needed — the API reads the tables
   live.

## Editing the map from the web (admin, edit-gated)

The KML/JSON importer is the bulk path. For touch-ups an admin can edit the
map directly in the browser when `[security] allow_web_edit = true` — the same
gate as the settings engine. On the Site Map page an **EDIT MAP** button
appears (admin only); it toggles an editor that writes to NetMon's own
`sites`/`fiber_links` tables (never a source):

- **Move a site** — drag its marker; the new lat/lon saves on drop
  (`POST /api/registry/sites/{id}/location`). Straight (no-waypoint) links
  attached to it follow the move live.
- **Edit a fiber path** — click a fiber line (or its "Path" button) to edit
  its polyline: drag a solid ○ to move a waypoint, drag a faint **+** midpoint
  to add one, right-click a ○ to remove it. The endpoints stay pinned to their
  sites. **Save path** stores the waypoints; a path with no waypoints is saved
  as a straight, site-tracking line. Capacity is editable in the same panel.
- **Add / delete a link** — "+ Add fiber link" then click the two endpoint
  sites; "Delete link" removes one. Endpoints are stored in sorted-name order,
  so A↔B can't be registered twice.

**Linking a map location to a network site/group.** The roll-up joins a
`sites` row to live devices by `devices.site`. When the map label differs from
the network group string (a Zabbix `Site/<x>` value, a legacy group name, or a
label you prefer), set the site's **Network group** field (Registry → Sites →
Edit, a picklist of the live `devices.site` groups) — the roll-up then joins on
that `group_key` instead of the name, without renaming the marker or moving any
device. Leave it blank to keep the historical join-by-name behaviour. Device
assignment writes the site's effective group key, and renaming a *linked*
site's label no longer re-points devices (an unlinked site's rename still
cascades, as before).

**Label placement.** Each site's name label sits above its dot by default;
set **Map label position** (Registry → Sites → Edit: top/bottom/left/right) to
move it when labels collide.

**Owned vs leased fiber.** A link's **Type** (owned | leased) is set in the
map link editor. Leased circuits (a carrier path, e.g. C-Spire — named in the
**Provider** field) render as a fine dotted line with a tinted casing so the
NOC can tell district plant from a leased path at a glance; owned fiber keeps
the flowing dashes.

**Port attachments (real link state).** By default a link's colour comes from
the coarse endpoint-site roll-up. Patch each end into a **switch port** (map
link editor → Attached ports → pick a switch, then a port) and the link's
up/down, **speed**, and **utilization** are then derived from those
`switch_ports` rows — the actual circuit — instead. A port-backed link is DOWN
if either attached port is down; its tooltip shows the negotiated speed and
live utilization. Detach to fall back to the site-derived status. (Ports must
be switches in the registry; the SNMP inventory sweep populates their state.)

Editing pauses the 10 s poll so a refresh never fights a drag; leaving edit
mode reloads and resumes. All of it is refused (403) when `allow_web_edit` is
false. Bulk/authoritative topology still comes from the KML/JSON importer;
these edits and the importer both live in the same tables (re-importing
overwrites by site name / site pair).

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
