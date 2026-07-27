# Spec 09 — Geographic site-status map (NOC wall view)

**Status:** in progress (phase started 2026-07-14). Phases 3–4 are landed, so
the map is pulled forward per the plan's dependency note.

**Design source:** `docs/design/netmon-map/` — a Claude Design handoff bundle.
The primary prototype is `project/Netmon Map.dc.html` (Leaflet + a React-ish
`DCLogic` component running on *simulated* data). We recreate its visual output
on NetMon's real endpoints; the prototype's internal structure and its
simulation loop are **not** ported.

## What it is

A geographic map of the district (Leaflet) as an at-a-glance operational view:

- **Sites as status dots** — one marker per site at its lat/lon, colored
  up / degraded / down / unknown, sized by tier (hub / high / middle /
  elementary), pulsing when down.
- **Inter-site fiber links** — polylines between sites, weighted by capacity
  (10G trunk vs 1G lateral), colored by status and by utilization (>85% =
  "hot"), with animated flow dashes whose speed tracks utilization; a down
  link stops flowing.
- **Header strip** — live UP / DEGRADED / DOWN site counts, a fiber-alarm
  count, a clock, and a **NOC mode** toggle (fullscreen wall display).
- **Live event feed** (bottom-left) — recent `state_events` transitions.
- **Legend** (bottom-right).
- **Side panel** — a status-sorted site list, or, when a site is selected,
  that site's fiber links with per-link utilization bars.
- **Basemap toggle** — dark / light / satellite tiles.

## Decisions (resolved at phase start, owner-confirmed 2026-07-14)

1. **Leaflet is bundled locally.** `leaflet@1.9.4` (pinned, BSD-2, zero
   transitive deps) added to `frontend/package.json` — **owner-approved
   2026-07-14** (the §3/§8 new-dependency checkpoint). esbuild bundles the JS
   and CSS (control-icon PNGs inlined as data URIs); nothing is CDN-loaded.
   The prototype's CDN loader chain is not ported.
2. **Basemap tiles are an external runtime fetch, with graceful degradation**
   — **owner-approved 2026-07-14**; this is the recorded exception the DoD
   allows. Tile sources: CARTO dark/light, Esri World Imagery (satellite).
   When tiles fail (district offline, provider down) the map keeps rendering
   sites/links/panel on a plain background and shows a persistent
   `MAP TILES UNREACHABLE` notice — the prototype's stall state, kept per the
   2026-07-13 runtime-resilience clarification. Optional hardening (self-hosted
   district-bbox tile pack) remains open; the tile URL constants live in one
   place (`frontend/src/pages/map.jsx`) to make that swap trivial.
3. **Fiber-link topology is curated, in the DB.** New tables `sites` and
   `fiber_links` (migration `004_site_map.sql`), populated by a one-shot
   importer (`python -m netmon.topology <file>`) from an owner-maintained
   file — JSON (`topology.example.json` is the template) or **KML/KMZ**
   drawn in Google My Maps / Google Earth (added 2026-07-14 at owner
   request; Point placemarks = sites with `Site/`-prefixed or plain names +
   display-name/`tier:` descriptions, LineString placemarks = links with
   `a:`/`b:`/`capacity_gbps:` description lines whose drawn geometry is the
   path — conventions in `docs/runbooks/site-map.md`). Not derived from
   LLDP/CDP. `sites.name` **must equal** `devices.site` (the Zabbix
   `Site/<name>` value) — that string is the join key for the roll-up.
4. **Link utilization ingest is deferred** (owner decision 2026-07-14). The
   XIQ-port-stats vs SNMP-ifHCInOctets read path stays an open question (§9);
   guessing it is not allowed. The schema (`fiber_link_state.utilization_pct`,
   nullable) and the UI (utilization bar renders "no data" when null) are
   ready, so the follow-up is only a writer. Until then links carry no
   utilization and the flow animation runs at its base speed.
5. **No `trunk` collision.** Fiber links are modeled in their own tables, not
   as a `device_state` dimension; the voice `trunk` dimension is untouched.

## Data model (migration `004_site_map.sql`)

- **`sites`** — curated per-site metadata. `id`, `name` (unique, = `devices.site`),
  `display_name`, `tier` (`hub|high|middle|elementary|other`), `lat`, `lon`,
  `enabled`.
- **`fiber_links`** — curated topology. `id`, `site_a_id`, `site_b_id` (FKs to
  `sites`, pair stored in sorted-by-name order, unique), `capacity_gbps`,
  `path` (JSON `[[lat,lon],…]` street-route polyline; NULL = straight line),
  `enabled`.
- **`fiber_link_state`** — current state only (mirrors the `device_state`
  idiom): `link_id` (PK/FK), `status` (`up|degraded|down|unknown`, default
  `unknown`), `utilization_pct` (nullable), `source`, `updated_at`. Written by
  the future utilization/link collector; **no history** — the §2 scope guard
  stands (no per-link time-series).

Rollback note lives in the migration file. No existing table is altered.

## Site roll-up semantics (`/api/sites`)

Per curated site, over its **enabled** devices (`devices.site = sites.name`).
Revised 2026-07-17 (owner directive) and 2026-07-27 (source_status folded in;
`snmp` accepted as a tiebreaker):

- a device is **down** when its native `ping` value is `down`, **or** its
  federated `source_status` value is `down` and no native probe contradicts it
  (a `ping = up` **or `snmp = up`** reading wins — the native poller is the
  tiebreaker, spec 00 / CLAUDE.md §1). Folding in `source_status` is what lets
  an XIQ-managed switch — which carries its up/down only in `source_status`,
  never a native ping — count as down. `source_status = blind` is a **warn**
  (source unreachable), never a device-down;
- **`snmp` is positive evidence only.** Answering `snmpget sysUpTime` proves a
  device is alive, so it overrides a source's down verdict; *not* answering
  proves nothing (blocked UDP/161, wrong community — the poller records it
  `warn`, not `crit`), so `snmp = down` never makes a device down on its own.
  This matters because `[poller] enabled = false` on the deploy VM means there
  are **no `ping` rows at all** — `snmp` is the only native evidence in the DB,
  and without it four MDF switches read as down on 2026-07-27 while answering
  SNMP. `ping = down` stays authoritative over `snmp = up`: that contradiction
  (ICMP-silent, SNMP-answering) is one to surface, not to silently resolve;
- site **down** — the site has reachability-monitored devices (a definitive
  `ping`/`source_status` up or down reading, or `snmp = up`) and **all** of them
  are down;
- site **degraded** — not fully down, but a **switch** is down (by either
  dimension, above) OR a trunk fiber link into the site is alarmed. A down
  camera/AP/phone does NOT degrade the site, and neither does a mere warning
  (port errors, a blind source, a stale backup) — only a switch actually being
  down or the uplink being impaired. `devices_degraded` carries the switch-down
  count so the Global site cards / map can surface "N switch(es) down";
- site **unknown** — no device has any state row (or the site has no devices);
  blind-never-renders-healthy applies: unknown is displayed distinctly, never
  as up;
- site **up** — otherwise.

## Link status derivation (`/api/links`)

Honest current-state without link telemetry: a fiber link's effective status is
`worst(stored, derived)` where *stored* is `fiber_link_state.status` (ignored
while `unknown`) and *derived* is:

- `down` if either endpoint site is down (its far side is unreachable),
- `unknown` if **both** endpoint sites are unknown,
- else `up` — justified because in this hub-and-spoke fiber plant a reachable
  endpoint site means its uplink path is passing traffic.

A degraded *site* does not degrade the link (a dead AP inside a school says
nothing about the fiber). When the utilization writer lands it must also mark
its own staleness (fail loud, never stale) — tracked under "Next session".

## API (all viewer-gated, read-only)

- `GET /api/sites` → `[{name, display_name, tier, lat, lon, status,
  devices_total, devices_down, devices_degraded}]`
- `GET /api/links` → `[{id, site_a, site_b, capacity_gbps, path, status,
  utilization_pct, utilization_at, utilization_source}]`
- `GET /api/events?limit=N` → recent `state_events` newest-first, joined to
  device name/site: `[{id, device, site, dimension, old_value, new_value,
  severity, source, occurred_at}]`. (Also serves the planned `#/events` page.)

## Frontend

`frontend/src/pages/map.jsx` on the existing esbuild/hash-route pipeline
(route `#/map`, already in the nav). Polls the three endpoints every 10 s —
no simulation. Keeps the last good data and shows an `API UNREACHABLE` chip
(with data age) when a poll fails, rather than blanking or fabricating. NOC
mode requests fullscreen on the page element (hides the app sidebar
automatically). Basemap choice persists in `localStorage`.

## Checklist

- [x] Spec updated with decisions before code (§4 spec-first)
- [x] Migration `004_site_map.sql` + rollback note
- [x] `sites` / `fiber_links` / `fiber_link_state` SQLite DDL for tests
- [x] Topology importer `python -m netmon.topology` (+ `--dry-run`), entry point
- [x] `topology.example.json` template (prototype geography, owner to curate)
- [x] `/api/sites` roll-up + `/api/links` + `/api/events`
- [x] Leaflet 1.9.4 bundled via esbuild (no CDN), PNGs inlined
- [x] Map page: dots, weighted/animated links, header counts, clock, legend,
      side panel, event feed, basemap toggle, NOC fullscreen
- [x] Tile-failure + API-failure degradation states
- [x] Tests: roll-up unit, link derivation, API, importer, migration checks
- [x] Runbook `docs/runbooks/site-map.md`
- [ ] Owner curates real coordinates/topology + imports on the deploy VM

## Next session

- **Utilization writer** — owner to pick the read path (XIQ port stats vs
  SNMP `ifHCInOctets` deltas via the existing `snmpget` subprocess pattern;
  the SNMP route needs per-link uplink ifIndex curation). Writer must set
  `fiber_link_state.source`/`updated_at` and the API/UI must surface
  staleness once real data flows.
- Optional hardening: self-hosted tile pack (swap the tile URL constants).
- Consider surfacing curated-but-stateless sites (no devices matched) in an
  admin view so name mismatches with `devices.site` are caught early (the
  importer already warns).
