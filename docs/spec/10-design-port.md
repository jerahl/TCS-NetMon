# Spec 10 — "Zabbix Extreme" design port (UI rebuild + snapshot data layer)

**Status:** IN PROGRESS — Phase 10.0 complete (2026-07-14); Phase 10.1 collection foundation complete (SNMP sweeps + switch API + tests, 2026-07-15) with the Switches page UI remaining; Phases 10.2–10.5 pending. Originated as the design-analysis session deliverable (2026-07-14).
**Design source:** `Zabbix_Extreme.zip` (Claude Design handoff: 18 HTML pages + ~50 JSX/CSS modules). Keep the
archive out of the repo (it contains real hostnames/IPs in mock data); extract locally when implementing.
**Goal:** make NetMon's UI match this design, and build the data layer the pages need — **cache current
snapshots of source data in NetMon's DB so pages never poll a source platform at render time**. No metric
history is stored (§2); only "what is true now", refreshed on collector cadences.

---

## 1. The one architectural decision everything hangs on

The design renders data NetMon does not hold: per-port switch state, **FDB/MAC tables joined to PacketFence
identity**, LLDP neighbors, VLANs, stack-member environmentals, per-radio wireless metrics, camera stream
attributes, trunk channel usage, extension registration. Fetching any of this at page-load time would hammer
XIQ/PF/Milestone/3CX APIs (and the switches themselves) every time someone opens a dashboard.

**Decision: introduce a snapshot cache layer.**

- New **inventory tables** (row-shaped, searchable data: ports, FDB, neighbors, nodes, cameras, trunks,
  extensions…) — *replace-on-refresh*, keyed by device, `updated_at` on every row. No history, no
  time-series. These sit beside `device_state` and do not change its contract: `device_state` stays the
  severity state machine that drives events and alerting; inventory tables are descriptive facts.
- One generic **`snapshot_cache`** table (`key` PK, `payload` JSON, `source`, `ok`, `updated_at`) for
  page-level singleton/aggregate blobs (PBX system status, Milestone environment totals, PF cluster health,
  auth-method splits, RADIUS reject tails…). Avoids dozens of micro-tables for widgets that are just a
  handful of numbers.
- Collectors are the **only writers**; the API reads only NetMon's DB. Every API response carries each
  row's `updated_at` so the UI can render staleness honestly (§4.5 fail-loud: a dead collector leaves
  visibly old timestamps and a `source_status=blind` banner, never fresh-looking data).
- **Rates without history:** counters (port octets/errors) need two samples to become a rate. Inventory
  rows store the *previous raw counters + timestamp* in the same row; the collector computes kbps/err-delta
  at write time and overwrites. Current rate is state, not history — no series table needed.
- **Sparklines/24 h charts in the design are dropped in v1** of the port (§2 forbids time-series). Each
  page section below lists what degrades. If the owner later wants them, the recorded option is a bounded
  ring buffer (fixed 24 h, auto-pruned) — an explicit §2 exception to be approved, not assumed.

## 2. Page disposition

| Design page | Verdict | Notes |
|---|---|---|
| Global Dashboard | **Build** | needs `/api/sites` roll-up + `/api/summary` system cards |
| Switches Dashboard (8 tabs) | **Build** (core of this program) | needs the SNMP inventory sweeps (§4) |
| XIQ Wireless Status | **Build** | XIQ detail cycles (§5) |
| Wireless APs / AP Detail | **Build** | replaces today's generic `#/ap/{id}` |
| PacketFence: Connected Devices, User Sessions, Quarantine, Cluster Status, NAC Policies | **Build** (Policies read-only) | persist PF nodes to DB — resolves §9 "merge vs linked view" as **persisted linked tables**, `devices` untouched |
| Surveillance: NOC Overview, Cameras, Recording Servers, Camera/Server Detail, Storage, Alarms | **Build, degraded** | Milestone Config API lacks live fps/bitrate/host metrics; §7 lists what renders |
| VoIP Dashboard | **Build, degraded** | trunks + extensions + system status; live calls/MOS/queues per Phase 0 3CX decision |
| Events Console | **Build** | backed by `state_events` + `alerts` (finally gets an API) |
| Problems (mosaic/constellation) | **Build** | same API as Events; presentation-only extras |
| Evidence Lock | **Defer** | read-only list is possible via Config API; lock create/extend/export are writes (§2). Ship list-only if cheap, else omit |
| Servers Dashboard, UPS Power, FortiGate, Zabbix Server Status | **Out of scope (§2)** | all Zabbix-fed domains Zabbix keeps. Nav shows them as external links to Zabbix, or hides them — owner choice (§10 Q1) |
| Tweaks panel | **Not a product feature** | keep density / show-source-badges / remembered-selection as localStorage prefs |
| CLI capture, PoE CYCLE, Reboot/SSH, quarantine release, firmware schedule, stream restart, session disconnect, evidence-lock ops | **Excluded — write actions (§2/§4.1)** | render nothing, or disabled buttons with "managed in &lt;source&gt;" tooltip + deep link |
| Ack / suppress-1h / assign on events & problems | **Build — NetMon-native** | ack → `alerts.acked_by` (exists); "suppress 1 h" → a 1-hour device-scoped `maintenance_windows` row; assign → new `alerts.assigned_to` column |

**Severity mapping** (design uses Zabbix's 5 levels; NetMon keeps its 4-level enum — mapping lives in one
frontend module): `crit→disaster/high` (crit + `device_type∈{switch core, recording_server, pbx}` or
multi-device blast may render "disaster"; default crit→high), `warn→warning`, `ok→ok`, `unknown→info`.
No DB change.

**Source badges:** design's ZBX/PF/EXT/3CX/XDR become NetMon's real provenance: `POLLER` (fping/snmp),
`SNMP` (inventory sweeps), `XIQ`, `PF`, `MS` (Milestone), `3CX`, `RCFG`. Values come from
`device_state.source` / inventory `source` columns — keep per-widget attribution exactly as designed.

---

## 3. New data model (numbered migrations, each with `-- rollback:` note)

### 004_switch_inventory.sql
| Table | Columns (PK bold) | Fed by | Cadence |
|---|---|---|---|
| `switch_ports` | **device_id, ifindex**, name ("1:18"), member (stack slot), oper_state ENUM(up\|down\|disabled\|absent), speed_mbps, duplex, poe_admin, poe_delivering, poe_class, poe_watts, in_kbps, out_kbps, util_pct, err_in_delta, err_out_delta, disc_in_delta, disc_out_delta, last_change, prev_counters JSON(octets/errs/ts for rate calc), updated_at | SNMP IF-MIB + POWER-ETHERNET-MIB (§4) | 120 s |
| `fdb_entries` | **device_id, vlan_id, mac**, ifindex, first_seen, updated_at; INDEX(mac) | SNMP Q-BRIDGE-MIB dot1qTpFdbTable | 15 min |
| `lldp_neighbors` | **device_id, local_ifindex**, remote_sysname, remote_port, remote_sysdesc, remote_mgmt_ip, updated_at | SNMP LLDP-MIB | 30 min |
| `switch_vlans` | **device_id, vlan_id**, name, untagged_count, tagged_count, port_map JSON, ip_cidr, updated_at | Q-BRIDGE-MIB (+EXOS MIB names) | 1 h |
| `stack_members` | **device_id, slot**, role, serial, fw_version, uptime_s, cpu_pct, mem_pct, temp_c, fans JSON(rpm), psus JSON(watts\|absent), warn_msg, updated_at | Extreme/ENTITY MIBs (§4) | 5 min |

The **FDB→identity join** the Switches "Port Detail" pane needs is then pure SQL:
`fdb_entries` ⋈ `pf_nodes` ON mac — MACs on port, each with PF hostname/owner/role/reg status. Zero
source calls at render. `fdb_entries.updated_at` renders as the design's "FDB age Xm".

### 005_wireless_inventory.sql
| Table | Columns | Fed by | Cadence |
|---|---|---|---|
| `ap_details` | **device_id**, model, serial, mgmt_mac, fw_version, target_fw, network_policy, ip, gateway, dns, ntp, uptime_s, clients_total, cpu_pct, mem_pct, power_mode, lldp_neighbor, lldp_port, updated_at | XIQ `GET /devices?views=FULL` (paged fleet sweep) | 5 min |
| `ap_radios` | **device_id, band** ENUM(2_4\|5\|6), channel, width, tx_power_dbm, util_pct, noise_dbm, clients, updated_at | XIQ radio info (per-device detail or FULL view — confirm field coverage against a captured fixture first) | 10 min |
| `wireless_clients` | **mac**, device_id (AP), ssid, band, rssi_dbm, os, hostname, user, ip, connected_since, updated_at | XIQ clients endpoint, fleet-paged | 5–10 min |
| `ssids` | **name**, auth, vlan, hidden, role_tag, clients (rolled up), updated_at | XIQ network-policy/SSID endpoint + count roll-up from `wireless_clients` | 30 min / 5 min |

Fleet aggregates the XIQ page shows (APs online by state, clients by band/PHY, per-site roll-ups,
firmware compliance ring) are **SQL over these tables**, not extra API calls. Client OS mix can join
`wireless_clients` → `pf_nodes` (Fingerbank) when XIQ's own OS field is thin.

### 006_pf_nodes.sql
| Table | Columns | Fed by | Cadence |
|---|---|---|---|
| `pf_nodes` | **mac**, computername, ip, vendor, os (device_class), owner (pid), role, reg_status, vlan, last_switch, last_ifindex, last_ssid, last_ap, conn_method (802.1X/MAB/portal), dhcp_fp, last_seen, last_dhcp, updated_at; INDEX(last_switch), INDEX(reg_status), INDEX(role) | PF `POST /api/v1/nodes/search` + locationlog fields (extend the existing collector's field list) | 5 min |

Replaces today's in-memory `app.state.pf` snapshot (the `/api/nac` route switches to DB; the in-memory
path is deleted). RADIUS reject tail, auth-method split, cluster/queue/Galera health, auth sources,
connection profiles and violation catalog go to `snapshot_cache` keys (`pf.rejects`, `pf.auth_methods`,
`pf.cluster`, `pf.sources`, `pf.profiles`, `pf.violations`) — PF exposes these via `/api/v1/services/*`,
`/api/v1/queues`, `/api/v1/config/*` GETs; confirm exact endpoints against PF 12.3 during implementation
and capture fixtures (Phase 0 rule).

### 007_surveillance_voip_inventory.sql
| Table | Columns | Fed by | Cadence |
|---|---|---|---|
| `cameras` | **device_id**, model, resolution, fps_target, codec, bitrate_mode, recording_mode, state_msg, ip, mac, recording_server_device_id, enabled, updated_at | Milestone Config API `/api/rest/v1/cameras` (+hardware for model/address) | 5 min |
| `recording_servers` | **device_id**, hostname, role ENUM(recording\|management\|failover\|mobile), version, chans_total, chans_recording, storage_used_gb, storage_total_gb, retention_days, updated_at | Config API recordingServers + storage endpoints | 5 min |
| `trunks` | **device_id**, name, provider_host, did, reg_status, ch_total, ch_in_use, updated_at | 3CX `GET /xapi/v1/Trunks` (already fetched — currently discarded) | 2 min |
| `extensions` | **ext**, name, site, registered, dnd, updated_at | 3CX xapi users/extension endpoint (verify v20 surface — §10 Q4) | 5 min |

Milestone environment singleton (license counts, retention, storage totals, client sessions, alarm
counts) → `snapshot_cache['milestone.overview']`; 3CX `SystemStatus` (client method **already exists,
never called**) → `snapshot_cache['threecx.system']`. The camera tile's "Linked Switch Port" is the
FDB payoff: `cameras.mac` → `fdb_entries` → switch + port, pure SQL.

### 008_sites_and_events.sql
- `sites`: **code** PK, name, tier ENUM(high|middle|elem|career|admin|other), lat, lon (nullable — Phase 9
  reuses this table). Seeded from the distinct `devices.site` values + owner's Zabbix `Site/` export.
- `snapshot_cache` (defined here): **key** PK, payload JSON, source, ok TINYINT, updated_at.
- `alerts` gets `assigned_to` VARCHAR NULL (events "Assign…" action).
- `config_backups`: **device_id, taken_at**, size_bytes, hash, note, updated_at — rConfig backup list for
  the Config Backups tab (metadata only; the diff pane does a **user-initiated** read-through to rConfig,
  or links out — §10 Q5. On-click reads are fine; render-loop reads are not).

All migrations carry rollback notes (`DROP TABLE …`; `ALTER TABLE alerts DROP COLUMN assigned_to`).
`device_state`/`state_events` dimension enums are **unchanged** — no new dimensions needed for the port;
new severity-bearing conditions (e.g. stack member down, PoE budget) are Phase 11+ alert-rule work.

---

## 4. New collection: SNMP inventory sweeps (the big engineering item)

**⛔ Owner gate before any code:** CLAUDE.md §1 defines the poller as *exactly* fping + `snmpget`
sysUpTime. This program extends it with **read-only `snmpbulkwalk` subprocess sweeps** (same net-snmp
package, still no Python SNMP library, still GET-only/read-only). That is a charter change to §1 of the
project brief and needs explicit owner sign-off. Everything in §3's 004 tables depends on it.

Design: `netmon/poller/snmp_inventory.py` — supervised task + standalone `--once/--loop` like every
collector; per-sweep enable flags and intervals in `[snmp_inventory]` config; concurrency-capped
(default 8 switches in flight); staggered so a full-fleet sweep finishes inside its interval; per-switch
failure marks that switch's inventory rows stale and records `collector_health` (name `snmp_inventory`),
never deletes rows (fail loud, stay stale).

| Sweep | MIBs (walked tables) | Writes | Default interval | Est. cost/switch |
|---|---|---|---|---|
| ports | IF-MIB ifTable/ifXTable (oper/admin, ifHighSpeed, HC octets, errors, discards), EtherLike duplex, POWER-ETHERNET-MIB pethPsePortTable + pethMainPseTable | `switch_ports`, PoE budget aggregates | 120 s | 3–5 bulkwalks |
| fdb | Q-BRIDGE-MIB dot1qTpFdbTable (+dot1dBasePortIfIndex mapping) | `fdb_entries` | 15 min | 1–2 bulkwalks (large) |
| lldp | LLDP-MIB lldpRemTable | `lldp_neighbors` | 30 min | 1 |
| vlans | Q-BRIDGE dot1qVlanStaticTable / EXOS extremeVlan | `switch_vlans` | 1 h | 1–2 |
| stack/env | EXTREME-SYSTEM/ENTITY-MIB + Extreme sensors (slot role/serial, CPU, mem, temp, fan, PSU) | `stack_members` | 5 min | 2–3 |

Load sanity: ~312 switches × (ports every 2 min + env every 5 min) ≈ ~3–4 bulkwalks/switch/2min,
concurrency 8, spread evenly → a few walks/second district-wide; negligible for EXOS and for NetMon.
FDB is the heavy one (thousands of rows/switch) — 15 min cadence matches the design's "FDB age ~30m"
copy and keeps write volume sane (upsert + prune rows not seen this sweep).

**Not buildable from these sources (render "—" / omit):** per-port 1-hour per-minute online heatmap,
60-point rate sparklines, SFP DOM light levels (possible later via EXOS MIB — needs fixture), "top
talkers" ranking is buildable (sort `switch_ports` by util), EAPS ring detail (EXTREME-EAPS-MIB exists —
defer to a later enhancement, tab ships hidden), Macros·CLI tab (dropped — Zabbix/write concepts).

## 5. Collector changes (existing modules)

| Collector | Change | API budget check |
|---|---|---|
| **xiq** | Keep 180 s status sweep. Add: 5 min detail sweep (`views=FULL`, ~12 pages @ 100/page for 1,184 APs), 5–10 min clients sweep (~9 k clients ≈ 90 pages), 30 min SSID/policy fetch. Total ≈ **1,300–1,600 calls/h** — validate against Phase 0 rate-limit findings (`docs/spec/00-sources.md`) before enabling; make every cycle independently intervalled + disableable | XIQ documented limit ~7,500/h — fits with ~4× headroom; keep the existing `RateLimit-Remaining` warnings |
| **packetfence** | Persist to `pf_nodes` (replace in-memory snapshot); extend field list (locationlog, vendor, conn method); add `snapshot_cache` fetchers for cluster/services/queues/sources/profiles/violations (GET-only) | nodes/search paged 1,000 → ~13 calls/5 min; trivial |
| **milestone** | Keep status writes. Add camera/server attribute persistence (same responses, currently discarded) + storage + `milestone.overview` snapshot. Alarm feed: Config API has no alarm list — alarms come from the Events/State **WebSocket** (blocked on `websockets` dependency approval, spec 05); until then the Alarms tab shows NetMon `alerts` filtered to surveillance devices | no new call volume (same endpoints, more fields kept) |
| **threecx** | Persist trunk rows; call the existing-but-unused `system_status()` into `snapshot_cache`; add extensions fetch (endpoint per §10 Q4) | +2–3 calls/2–5 min; trivial |
| **rconfig** | Keep freshness dimension. Add backup-metadata list → `config_backups` (10 min) | ~20 paged calls/10 min |
| **poller** | Unchanged (plus the new sibling module per §4) | — |

Every new fetch gets a sanitized fixture in `tests/fixtures/` + parse test before it runs live (§4.8).

## 6. API additions (all read-only, viewer-role, DB-only)

| Route | Serves | Backing |
|---|---|---|
| `GET /api/status` **(fix)** | add `recording`, `trunk`, `config_backup` joins — today's Surveillance/VoIP pages dereference fields the API never returns (latent TypeError) | `device_state` |
| `GET /api/summary` | Global page system cards: per-domain status + 3 KPIs + headline | SQL roll-ups + `snapshot_cache` |
| `GET /api/sites` | site tiles: code, name, tier, device count, problem count, worst severity (SLA% dropped — needs history) | `sites` + `device_state` + `alerts` |
| `GET /api/events` | Events/Problems: filters sev/status/source/site/type/q, paging, hourly 24 h severity buckets (computable from `state_events` timestamps — a query, not a stored series) | `state_events` ⋈ `devices` |
| `GET /api/alerts` (extend), `POST /api/alerts/{id}/assign`, `POST /api/alerts/{id}/suppress` | ack exists; assign sets `assigned_to`; suppress creates 1 h maintenance window (operator role) | `alerts`, `maintenance_windows` |
| `GET /api/collector-health` | sidebar source-health pills + staleness banners | `collector_health` |
| `GET /api/switches/{id}` + `/ports`, `/ports/{ifindex}` (incl. FDB⋈PF device list), `/fdb`, `/lldp`, `/vlans`, `/stack`, `/poe`, `/backups` | all 8 switch tabs | 004/008 tables |
| `GET /api/wireless/summary`, `/aps`, `/aps/{id}` (details+radios+clients), `/ssids`, `/clients` | XIQ + AP Detail pages | 005 tables |
| `GET /api/nac` (rework), `/nac/nodes`, `/nac/sessions`, `/nac/policies`, `/nac/quarantine`, `/nac/cluster` | five PF pages | `pf_nodes` + `snapshot_cache` |
| `GET /api/surveillance/summary`, `/cameras`, `/cameras/{id}`, `/servers`, `/servers/{id}`, `/storage` | NVR pages | 007 tables + snapshots |
| `GET /api/voip/summary`, `/trunks`, `/extensions` | VoIP page | 007 tables + snapshots |
| `GET /api/search?q=` | ⌘K palette: devices by name/IP + `pf_nodes` by MAC/user/hostname + `fdb_entries` by MAC | indexed lookups |

Every list response includes row `updated_at` + the owning collector's `collector_health` freshness so
the UI can badge staleness uniformly.

## 7. Frontend port

Mechanics: copy the design's component structure into `frontend/src/` (shell, `global-nav`, `primitives`
— SourceBadge/Sparkline/Ring/StatusDot/Sev — `tabs`, per-page apps + CSS), on the existing esbuild
pipeline. **Strip Babel-standalone/unpkg CDN loads** (§3), replace `window.*` mock globals with fetch
hooks per §6 endpoints, keep the hash router, add auto-refresh timers per page (30 s default; port
faceplate 15 s — the design's 2 s/8 s copy is renegotiated to cache cadence). Replace mock-data files
with a thin `api.js`; keep each page's JSX layout as-is so the visual output matches.

Per-page fidelity notes (what degrades and why):

- **Global:** severity strip (from `alerts`+`device_state`), site heatmap (`/api/sites`, no SLA%),
  system cards (`/api/summary`, sparkline slot empty or hidden), hotspots, active triggers
  (`/api/alerts`), event stream (`/api/events`). Firewall/Servers/ZBX/UPS cards: per §10 Q1.
- **Switches:** navigator (devices type=switch grouped by site), KPI strip (current values, no sparks),
  **port faceplate** (`switch_ports` per member incl. SFP rows), **port detail row** = port telemetry +
  FDB⋈PF device cards (the design's marquee feature — fully served from cache), uplinks/top-talkers
  (`switch_ports` sorted), topology tab from `lldp_neighbors` (curated core/downstream layout deferred),
  stack health (no 24 h temp heatmap), VLAN tab (no EAPS card v1), PoE budget tab (rings from
  pethMainPse + per-member + top consumers via FDB⋈PF names), triggers tab (`alert_rules`+`alerts`
  scoped to host), config backups (list; diff per §10 Q5). Macros·CLI tab: dropped.
- **XIQ Wireless:** KPI strip, site grid, band health (current values, no 24-pt sparks), SSID table,
  problem APs (derived: down/blind/high-util/firmware-drift), firmware ring, client mix (PHY from XIQ,
  OS via PF join), events (wireless-filtered `/api/events`). Channel heatmap: buildable from
  `ap_radios` (site × channel mean util) — keep. Roaming health: no source → drop.
- **AP Detail:** header/pills/sidecar (registry + `ap_details`), health rings (CPU/mem/PoE — current),
  system/network info KV, wireless tab (`ap_radios`, SSID table), wired tab (LLDP + uplink), clients tab
  (`wireless_clients`⋈`pf_nodes` incl. auth/posture), events/alerts tabs (device-scoped). Live-telemetry
  spark strip: dropped. Floor-plan image: out (no source), static device image fine.
- **PacketFence pages:** Connected Devices (`pf_nodes` + status-chip counts + role filter + CSV export),
  User Sessions (`pf_nodes` active + auth-method split + reject tail; "LIVE·5s" becomes "cache·5 min"
  honestly labeled), Quarantine (isolated nodes + violation catalog snapshot; **no release buttons**),
  NAC Policies (read-only render of sources/profiles/roles snapshots), Cluster Status (cluster/services/
  queues snapshots; timelines dropped).
- **Surveillance:** overview KPIs + XProtect card + storage card + sites + server minis + camera tables,
  camera detail (attributes, recording KV, network KV incl. **linked switch port via FDB**, device-scoped
  events; stream-health rings only if ONVIF/RTSP probing is added later — v1 renders state from
  Milestone + poller ping), server detail (Milestone-known fields; host CPU/mem/RAID are Zabbix's domain
  → omitted), alarms tab (NetMon alerts until the WebSocket lands), storage tab (volumes per server).
  Camera wall thumbnails: no image source read-only — render status tiles, not video (deep link to
  Smart Client). Evidence lock: per disposition table.
- **VoIP:** KPI strip (from `threecx.system` snapshot + `trunks` + `extensions`), trunk table (reg state,
  channel bars from ch_in_use/total), services panel (SystemStatus fields), extension grid (reg/unreg
  states; 5-state presence only if the v20 API exposes it), problems (voip-filtered alerts). Active-call
  table, MOS/quality series, queues, top extensions: only if the Phase 0 3CX decision (ODBC) provides
  them cheaply — otherwise dropped v1.
- **Events Console:** full filter bar (sev/status/source/site/type/text), KPI tiles, 24 h histogram
  (computed), table with sort/pagination/bulk ack/suppress/assign, detail drawer with audit trail
  (opened/acked/suppressed from `alerts` + `state_events`). Saved views: localStorage. MTTA/MTTR:
  computed from `alerts` (`acked_at−opened_at`, `closed_at−opened_at`). Tags: derived (dimension +
  device_type + severity), not stored.
- **Problems:** same API; mosaic/constellation/matrix are pure presentation. Host-class glyph from
  `device_type`; age buckets from `opened_at`.

## 8. Delivery phases (each: spec-checklist update → migration → collector → API → page → fixtures/tests → runbook)

| Phase | Contents | DoD |
|---|---|---|
| **10.0 Foundations** | fix `/api/status` dimensions bug; `/api/events` + `/api/collector-health`; `sites` + `snapshot_cache` + `assigned_to` migration (008 lands first — implemented as **`005`** since Phase 9's site map already took `004` and created `sites`, so `005` adds only `snapshot_cache`/`config_backups`/`assigned_to`); port design shell/nav/primitives; Events Console + Problems pages; nav source-health pills | old pages still work; events console live on real `state_events`; pytest green |
| **10.1 Switching** | §4 owner gate → snmp_inventory module + 004 tables; switch API; Switches page tabs (ports, port-detail FDB⋈PF, stack, VLAN, PoE, topology, triggers, backups-list) | port faceplate + FDB identity pane live against a real stack; sweep fits interval at fleet scale; README + runbook |
| **10.2 Wireless** | 005 tables; XIQ detail/clients/SSID cycles (rate-budget verified); wireless API; XIQ page + AP Detail | pages live; XIQ call rate measured &lt; budget; token-revocation test still shows blind, stale rows visible |
| **10.3 Identity** | 006 `pf_nodes` persistence (+snapshot fetchers); NAC API rework; five PF pages | `/api/nac` served from DB; in-memory snapshot deleted; PF pages live |
| **10.4 Surveillance + VoIP** | 007 tables; milestone/threecx collector extensions (SystemStatus wired); pages | camera detail shows FDB-linked switch port; trunk/extension state live |
| **10.5 Global + polish** | `/api/summary`, `/api/sites`, `/api/search` + ⌘K palette; Global page; staleness badging pass; density/badge prefs | Global renders all in-scope cards from DB only; zero runtime external fetches; shadow-mode alerting unaffected |

Ordering rationale: 10.0 is pure debt + shared chrome; 10.1 is the highest-value/highest-risk (owner
gate) and unblocks the FDB joins that 10.2/10.4 pages reuse.

## 9. Polling budget summary (why this doesn't "use up resources")

| Source | Today | After | Page loads |
|---|---|---|---|
| Switches (SNMP) | sysUpTime get / 5 min | +3–5 bulkwalks / 2 min + slow sweeps (§4), concurrency-capped | **0 calls** |
| XIQ | ~12 calls / 3 min | ≈1,300–1,600 calls/h total (≤ ~25% of documented limit) | **0** |
| PacketFence | 3 calls / 5 min | ~15–20 calls / 5 min | **0** |
| Milestone | 2 calls / 2 min | 4–6 calls / 5 min | **0** |
| 3CX | 1 call / 2 min | 3–4 calls / 2–5 min | **0** |
| rConfig | ~20 calls / 10 min | +backup-metadata pages / 10 min; diff fetch only on click | **≈0** |

## 10. Open questions (owner decisions — do not guess)

1. ✅ **RESOLVED 2026-07-15 — Out-of-scope nav entries** (Servers/UPS/FortiGate/ZBX): *"plan them for
   the future of NetMon."* → **Keep the entries visible** (not hidden); interim behaviour is a
   **deep-link into the existing Zabbix UI** so they're usable today, with a **roadmap item** to bring
   those domains natively into NetMon later via a **read-only Zabbix API source** (a new collector +
   `snapshot_cache` keys — a future phase, explicitly a §2-spirit exception to be specced then). Shapes
   the Phase 10.5 Global/nav work, not 10.1. *(Interim deep-link vs. a "planned" placeholder is a minor
   presentation call I'll default to deep-link; flag if you'd rather show a disabled "coming to NetMon"
   tile.)*
2. ✅ **RESOLVED 2026-07-15 — §1 charter amendment APPROVED:** read-only `snmpbulkwalk` sweeps are
   sanctioned (CLAUDE.md §1 amended). **Unblocks Phase 10.1.** Still GET-only, no Python SNMP lib,
   concurrency-capped, per-sweep disableable.
3. ✅ **RESOLVED 2026-07-15 — Sparklines: bounded 24 h ring buffer APPROVED** as an explicit §2
   exception (CLAUDE.md §2 amended). Fixed-size, auto-pruned, ≤24 h, via a numbered migration with a
   rollback note — the *only* sanctioned metric-series deviation. Scheduled as its own increment (see
   Next session); the 10.0 pages keep empty sparkline slots until it lands.
4. **3CX v20 surface** for extensions/active calls/queues — resolve with the standing Phase 0
   ODBC-vs-REST decision; fixtures first.
5. **Config diff pane:** on-click read-through to rConfig API vs. link-out to rConfig UI.
6. **Milestone `websockets` dependency** approval (unblocks live VMS alarms; carried over from spec 05).
7. **Evidence Lock read-only list**: worth shipping, or omit the page?
8. **`wireless_clients` scale/PII**: ~9–12 k rows refreshed every 5–10 min, containing usernames/MACs —
   acceptable in NetMon's DB? (Same data PF already holds; NetMon adds a second copy.)

## Progress log

**2026-07-14 — Phase 10.0 backend landed** (ungated: all read-only/DB-only, no
new deps, no charter change). Frontend port of 10.0 is the remaining half.

Done this session:
- **Migration `005_design_port_foundations.sql`** — `snapshot_cache` (page-level
  singleton blobs, `key` PK/JSON/`ok`/`updated_at`), `config_backups` (rConfig
  metadata; feeds the existing `config_backup` dimension), `alerts.assigned_to`.
  Rollback note included. (`sites` was already created by `004` — not re-added.)
  Guard test added so a `;` inside an inline SQL comment can never fracture a
  migration statement again (`test_every_statement_starts_with_a_sql_keyword`).
- **`/api/status` fix** — now returns `config_backup`/`recording`/`trunk`
  alongside ping/snmp/source_status; the Surveillance/VoIP/config pages'
  latent client-side TypeError is closed. `DeviceStatus` schema extended.
- **`/api/events` rework** — moved out of `netmon.api.sites` into
  `netmon.api.events` (same path; map feed unbroken). Optional filters
  (`severity/source/site/device_type/dimension/q/since/until` + `limit/offset`);
  `MapEvent` gained `device_id`/`device_type` (additive). New
  **`/api/events/stats`** = 24 h severity histogram + KPI totals, bucketed in
  Python for MariaDB/SQLite portability (a query, not a stored series — §1/§6).
- **`/api/collector-health`** — viewer-role source-health pills; derives
  `ok`/`error`/`unknown` honestly (a once-successful-but-now-failing collector
  reads `error`; a never-succeeded one reads `unknown`, never `ok` — §4.5).
- **Alert actions** — `/api/alerts` now returns `assigned_to`; added
  `POST /api/alerts/{id}/assign` (set/clear) and `POST /api/alerts/{id}/suppress`
  (1 h device-scoped `maintenance_windows` row — suppresses notification, not
  state recording, per §6). Both operator-role.
- Tests: +status all-dimensions, +`test_events_api`, +`test_collector_health_api`,
  +alert assign/suppress, +migration `005` assertions. Full suite green.

**2026-07-14 — Phase 10.0 frontend landed** (still ungated). Phase 10.0 is now
**complete** (backend + frontend); old pages still work.
- **Events Console** (`frontend/src/pages/events.jsx`, route `#/events`) — filter
  bar (severity/source/site/type/dimension/text), KPI tiles + 24 h severity
  histogram (from `/api/events/stats`), transition-feed table with provenance
  badges. Auto-refreshes 30 s (cache cadence). Site/source filter options are
  derived from the loaded feed — no extra round-trip.
- **Problems** page reworked to wire all three NetMon-native actions —
  Ack / Assign / Suppress-1h — on `/api/alerts/*`, with an `assigned_to` column.
- **Nav source-health pills** from `/api/collector-health` (green/red/grey per
  collector, hover for last-success + error). Refresh 30 s.
- Shared modules added: `severity.js` (the single home of the 5-level design →
  4-level NetMon mapping + provenance-badge table — §2), `primitives.jsx`
  gains `SevText`/`SourceBadge`, `api.js` gains `postJSON`/`qs`.
- **Reconciliation:** the design's Events Console conflates transitions and
  open problems. NetMon keeps them honest — `/api/events` is the immutable
  `state_events` feed (no ack there); the actionable alert lifecycle lives on
  Problems. The design's "Status" filter (open/acked) is therefore a Problems
  concern, not an events filter.
- Verified end-to-end with a headless-Chromium (Playwright) run against the
  built bundle on a seeded DB: both pages render live data, source badges and
  pills populate, histogram/filters/rows correct, no runtime console errors, no
  runtime external fetches (the one remaining external URL in the bundle is the
  Phase 9 map's ArcGIS tile layer — a separate spec-09/§10 open question, not
  introduced here).

**2026-07-15 — Phase 10.1 collection foundation landed** (Q2 charter amendment
in force). Owner supplied the real `zbx_export_templates_8.yaml` ("Extreme EXOS
by SNMP") — the OID map now comes from production Zabbix, captured in Appendix A.

- **Migration `006_switch_inventory.sql`** — `switch_ports`, `fdb_entries`,
  `lldp_neighbors`, `switch_vlans`, `stack_members` (rollback note; SQLite DDL
  mirrored in conftest). Reconciliation vs §3: the EXOS template walks the plain
  **`dot1dTpFdb`** (BRIDGE-MIB), not Q-BRIDGE, so `fdb_entries` PK is
  `(device_id, mac)` and `vlan_id` is **nullable** (per-VLAN FDB is a later
  Q-BRIDGE walk). The `mac` join key for the FDB⋈PF payoff is unaffected.
- **`netmon/poller/snmp_inventory.py`** — read-only `snmpbulkwalk` sweep as a
  poller sibling: supervised task + standalone `--once/--loop`; `[snmp_inventory]`
  config (per-sweep enable + interval, concurrency 8); one supervised task gated
  internally per-sweep by elapsed time; `collector_health` name `snmp_inventory`;
  per-switch failure isolated + rows left stale (never blanked), all-switches-fail
  surfaces loud; **pure `-On` parsers** unit-tested against a sanitized fixture.
  Rates computed at write time from `prev_counters` (no series — §1); counter
  resets yield NULL, not spikes.
- **Switch API** (`netmon/api/switches.py`): `/api/switches` (+ port roll-up),
  `/{id}` (+stack), `/{id}/ports`, `/{id}/ports/{ifindex}` (port + FDB MAC list),
  `/{id}/fdb`, `/{id}/lldp`, `/{id}/vlans`. Read-only, viewer role, DB-only.
- Fixture `tests/fixtures/snmp_exos_stack.txt` + `test_snmp_inventory` (parsers,
  rate calc, run_once, prune, health) + `test_switches_api` + migration `006`
  test. Full suite green; verified end-to-end (sweep → API) on a seeded DB.
- **Deferred to the next 10.1 slice** (schema columns already present, left
  NULL, honest): PoE (`pethPsePort*`/Extreme index → ifIndex mapping needs a
  real PoE fixture); per-slot serial/fw (ENTITY-MIB), fans/PSUs JSON; the
  **Switches page UI** (8 tabs) — the API is ready for it.

## Appendix A — EXOS SNMP OID map (Phase 10.1)

Source: owner's "Extreme EXOS by SNMP" Zabbix 7.4 template. Numeric roots the
`snmp_inventory` sweeps walk (`OID` dict in `snmp_inventory.py`):

| Sweep | Columns → OID root |
|---|---|
| ports | ifOperStatus `1.3.6.1.2.1.2.2.1.8`, ifAdminStatus `…2.2.1.7`, ifType `…2.2.1.3`, ifInErrors `…2.2.1.14`, ifOutErrors `…2.2.1.20`, ifInDiscards `…2.2.1.13`, ifOutDiscards `…2.2.1.19`, ifName `1.3.6.1.2.1.31.1.1.1.1`, ifHighSpeed `…31.1.1.1.15`, ifHCInOctets `…31.1.1.1.6`, ifHCOutOctets `…31.1.1.1.10`, dot3Duplex `1.3.6.1.2.1.10.7.2.1.19` |
| fdb | dot1dTpFdbPort `1.3.6.1.2.1.17.4.3.1.2` (MAC in suffix) ⋈ dot1dBasePortIfIndex `1.3.6.1.2.1.17.1.4.1.2` |
| lldp | lldpRem sysName `1.0.8802.1.1.2.1.4.1.1.9`, portId `…7`, portDesc `…8`, sysDesc `…10`, chassisId `…5` (index `timemark.localPort.remIdx`) |
| vlans | extremeVlan VID `1.3.6.1.4.1.1916.1.2.1.2.1.10`, name `…1.2.1.2.1.2`, admin `…1.2.1.2.1.12` |
| stack | member status `1.3.6.1.4.1.1916.1.33.2.1.3`, temp `…33.2.1.21`, CPU-5m `…32.1.4.1.9`, memTotal `…32.2.2.1.2`, memAvail `…32.2.2.1.3` |
| (not yet) | PoE `1.3.6.1.2.1.105.1.1.1.{6 detect,10 class}` + Extreme measured `1.3.6.1.4.1.1916.1.27.2.1.1.6`; ENTITY serial/model/fw `1.3.6.1.2.1.47.1.1.1.1.{11,2,9}`; fans `…1916.1.1.1.9.1.*`, PSUs `…1916.1.1.1.27.1.*` |

## Next session

- **Finish Phase 10.1**: build the **Switches page UI** (navigator, port faceplate,
  port-detail FDB pane, stack/VLAN/LLDP/topology tabs) on the switch API above;
  add the deferred sweeps (PoE, ENTITY serial/fw, fans/PSUs) once a PoE fixture is
  captured; add the Q-BRIDGE per-VLAN FDB walk if VLAN-scoped FDB is wanted.
- **Phase 10.3 unlocks the FDB⋈PF join**: once `pf_nodes` exists, extend
  `/api/switches/{id}/ports/{ifindex}` to enrich each MAC with PF identity
  (LEFT JOIN `pf_nodes` ON mac) — the design's marquee port-detail feature.
- **Sparkline ring buffer (Q3, approved)** — a bounded fixed-24 h auto-pruned
  table + collector writes; wire the empty sparkline slots the 10.0 pages leave.
- **Q1 nav (approved: plan for NetMon's future)** — in 10.5, keep Servers/UPS/
  FortiGate/ZBX nav entries as Zabbix deep-links now; roadmap a future read-only
  Zabbix source to render them natively.
