# Spec 11 — Standalone-scope revision (mission: standalone ZabbixCustomDashboard)

**Status:** ADOPTED as plan of record (owner-directed, 2026-07-15). Individual
gate decisions D1–D10 below carry recommendations. **All ten are now signed
off** — D3/D6 on 2026-07-15, D4/D5/D7/D10 on 2026-07-28 — so no ⛔ remains; the
legend below is kept for future amendments.
**Supersedes:** the "federated monitoring platform" framing of CLAUDE.md v1.0 /
project plan v0.2. CLAUDE.md v2.0 is rewritten from this spec in the same
commit.
**Companion analysis:** `CODE_OVERVIEW.md` in the `jerahl/ZabbixCustomDashboard`
repo (hierarchical map of the PHP/Python code being replaced).

---

## 1. The revised mission

> **NetMon v1 is the standalone version of ZabbixCustomDashboard (ZCD)**: it
> serves the same operational pages (Global, Switches, Wireless/XIQ, AP Detail,
> PacketFence, Surveillance, VoIP, Events/Problems, Search, Site Map, NetMon
> Status) from its own database, fed by its own read-only collectors and SNMP
> sweeps, with its own alerting — no Zabbix at runtime.

This is a simplification, not an expansion: the target experience is already
defined (the ZCD pages in production), and most of the build is already planned
(spec 10). What changes is what the project is *for* — parity with ZCD without
Zabbix — and the handful of charter conflicts that mission exposes.

## 2. Where the two codebases stand (July 2026)

| | ZabbixCustomDashboard (ZCD) | TCS-NetMon today |
|---|---|---|
| **Nature** | PHP frontend module *inside* Zabbix — 44 controllers, 6 API clients, 19 views, ~49 JSX apps | Standalone Python/FastAPI app — registry DB, native poller, 5 collectors, alert engine, React SPA |
| **Web shell, auth, routing** | Zabbix provides all of it | **Done natively**: SAML SSO + break-glass local login, roles, hash-routed SPA, esbuild (no CDN) |
| **Data collection** | Zabbix templates (SNMP for EXOS/FortiGate/servers, HTTP for Milestone, Script items for XIQ) + cron Python scripts feeding Zabbix items | Native but **state-level only**: XIQ connected/down, Milestone RS/camera recording, 3CX trunk reg, rConfig backup freshness, PF snapshot, fping/snmpget poller |
| **Storage** | Zabbix items (current values) + Zabbix history (time series) | `devices` / `device_state` / `state_events` (no time series by charter) |
| **Problems / alerting** | Zabbix triggers, problems, event ack | Own rules engine, dedupe, maintenance, ack, SMTP — shadow mode |
| **UI depth** | 15 rich pages (port faceplates, FDB⋈NAC identity panes, NOC walls) | 9 thin-but-real pages + the Leaflet site map (which ZCD never had) |
| **Write actions** | PoE cycle (rConfig), AP reboot (XIQ), PF reevaluate/restart port, event ack, camera snapshot proxy | Read-only charter; alert ack only |

Two framings fall out:

- **NetMon has already rebuilt everything Zabbix-the-platform did for ZCD**
  (shell, auth, scheduler, state store, alerting). The frame is done.
- **NetMon has not yet rebuilt what Zabbix-the-collector did for ZCD** — the
  deep per-device data (ports, PoE, FDB, radios, clients, camera attributes,
  storage, call history) that made the ZCD pages rich. That is exactly what
  spec 10 plans (snapshot-cache layer + SNMP inventory sweeps + collector
  detail cycles). **Spec 10 is ~80% of this revision already.**

## 3. What Zabbix supplies ZCD — and NetMon's replacement for each

| Zabbix role in ZCD | Concrete example | NetMon replacement | Status |
|---|---|---|---|
| Web shell / auth / menu / routing | `Module.php`, `manifest.json`, `ActionBase` | FastAPI + SAML + SPA nav | ✅ done |
| Config store (user macros) | `{$XIQ_API_TOKEN}`, `{$PF.*}`, `{$RCONFIG.*}` | `/etc/netmon/netmon.conf` | ✅ done |
| Host registry & site grouping | `host.get`, `Site/*` host groups | `devices` + `sites` tables (seeded once from Zabbix export) | ✅ done (re-seed must not need Zabbix — D9) |
| SNMP collection: EXOS switches | `stacking.member[]`, `net.if.status[]`, `poe.dstatus[]`, FDB — read by `SwitchClient` | **`snmpbulkwalk` inventory sweeps** → `switch_ports`/`fdb_entries`/`lldp_neighbors`/`switch_vlans`/`stack_members` | ✅ spec 10 §4 (D6 approved 2026-07-15) — built as Phase 10.1 |
| SNMP collection: FortiGate | "FortiGate by SNMP" template → `ActionFortigateData` | not planned — deferred | ❓ D1 |
| SNMP collection: APs | `extremeap.*` items → AP Detail page | XIQ `views=FULL` detail/radio/client cycles instead of SNMP | 📋 spec 10 §5 |
| Script/external items: XIQ fleet | `xiq.devices.raw`, `xiq.ap.*[serial]` | XIQ collector detail cycles → `ap_details`/`ap_radios`/`wireless_clients`/`ssids` | 📋 spec 10 §5 |
| External scripts: Milestone | `milestone_*.py` → cron → items → `ActionSurveillanceData` | Milestone collector Config-API persistence + ESS **WebSocket** live path | 📋 spec 10 §5; WS unblocked — D5 approved 2026-07-28. The `reference/zabbix/milestone/*.py` scripts and their cron/`*_read.sh` plumbing are **retired** — the collector replaces them |
| *(beyond ZCD)* Direct camera health | *(ZCD never did this)* — Bosch/HOST-RESOURCES SNMP against the camera itself | **`camera_snmp` sweeps** → `camera_health`/`camera_interfaces`/`camera_filesystems`/`camera_imagers` (CPU, reboot, FS, encoder bitrate, VCA motion) — Milestone can't supply host health | 📋 spec 13, post-parity 11.x (✅ D10 approved 2026-07-28) |
| History (time series) | port history graphs, fleet history, VoIP 24h calls | none — charter forbids series | ✅ D3 (bounded 24h ring buffer) — built as Phase 10.6 |
| Problems / triggers / ack | `ActionProblemsData`, `ActionEventsData`, `ActionEventsUpdate` | `alert_rules`/`alerts`/`state_events` + ack (exists) + assign/suppress (spec 10) | ✅/📋 |
| Zabbix self-health page | `ActionZbxStatusData` | **NetMon Status page** over `collector_health` + supervisor stats | 📋 new (D2) |

## 4. Page-by-page parity map (ZCD → NetMon)

Verdicts: ✅ covered · 📋 planned · ❓ decision · 🗑 retire.

| ZCD page | ZCD backing | NetMon today | Verdict / what closes the gap |
|---|---|---|---|
| Global Dashboard | Zabbix hosts/problems + `xiq.ap.*` + `milestone.cam.status` + 3CX | thin `global.jsx` | 📋 spec 10.5 (`/api/summary`, `/api/sites`, severity strip, system cards) |
| AP Detail (Wireless) | `extremeap.*` SNMP + XIQ live + PF uplink | generic `#/ap/:id` | 📋 spec 10.2 (`ap_details`, `ap_radios`, `wireless_clients` ⋈ `pf_nodes`) |
| XIQ fleet status | `xiq.devices.raw` + Problems | nav stub | 📋 spec 10.2 |
| Switches (8 tabs) | `SwitchClient` over EXOS items + FDB⋈PF + XIQ + rConfig | thin table | 📋 spec 10.1 — **the big build**; built under approved D6 |
| FortiGate | Zabbix FortiGate SNMP template | — | ❓ D1: SNMP sweep later, deep-link meanwhile |
| Servers | Zabbix agent items (page was mock) | — | 🗑 retire from NetMon (D2) — servers remain Zabbix's domain; deep-link |
| Zabbix Status | Zabbix internal items | — | 🗑→📋 replace with **NetMon Status** (D2) |
| VoIP (3CX) | `ThreeCXClient` + Zabbix history for 24h calls | thin trunks page | 📋 spec 10.4; 24h call history rides the approved D3 ring buffer |
| Cortex XDR | mock JSX only | — | 🗑 drop (D8) |
| PacketFence ×5 | **mock** JSX (live PF only via search/device actions) | live `/api/nac` snapshot | 📋 spec 10.3 — NetMon will *exceed* ZCD here |
| Surveillance NOC + Camera/RS detail | `milestone.*` items + PF + snapshot proxy | thin state page | 📋 spec 10.4; live alarms D5 ✅ 2026-07-28; JPEG proxy D7 ✅ (camera addresses first) |
| Events / Problems consoles | Zabbix events/problems + ack | `problems.jsx` + `/api/events` (map feed) | 📋 spec 10.0 (full console; ack exists, assign/suppress added) |
| Search (⌘K) | Zabbix hosts + PF + XIQ | — | 📋 spec 10.5 (`/api/search` over `devices`+`pf_nodes`+`fdb_entries`) |
| Write actions | PoE cycle, AP reboot, PF reevaluate/restart, camera snapshot | ack only | ✅ D4 approved 2026-07-28 — **build in 11.x, post-cutover** |

No page requires new invention beyond spec 10 except FortiGate (D1), the
NetMon Status page, and the D-decisions. The site map stays — a NetMon-only
addition.

## 5. Charter changes this mission forces

1. **"Federated-only" softens.** The original bet was "never re-poll devices;
   the sources already know." True for XIQ/PF/Milestone/3CX/rConfig — but the
   ZCD switch experience (port faceplates, FDB, VLANs, PoE) came from Zabbix's
   *direct SNMP polling*, which no source platform replaces. Spec 10 §4's
   `snmpbulkwalk` sweeps are therefore **core scope, not an enhancement**
   (D6 approved 2026-07-15; built as Phase 10.1).
2. **Zabbix as a data source disappears entirely** — including at seed time
   (D9) and in nav, except deliberate deep-links for retained-in-Zabbix
   domains (servers).
3. **The read-only rule needs an explicit carve-out list or re-affirmation**
   (D4 — **approved 2026-07-28** for 11.x, post-cutover): ZCD shipped four
   operator write actions a "standalone ZCD"
   arguably includes.

## 6. Decisions D1–D10 (recommendations recorded 2026-07-15; D10 added 2026-07-17)

⛔ = requires explicit owner sign-off before the gated code lands (per §4
conventions / the standing new-dependency & charter checkpoints).

| # | Decision | Recommendation | Sign-off |
|---|---|---|---|
| D1 | FortiGate page: build an SNMP sweep collector + page, or keep in Zabbix? | Defer to post-parity (11.x); deep-link meanwhile. The 10.1 sweep pattern makes it cheap later | adopted — **deferred to 11.x**; the interim Zabbix deep-link shipped in Phase 10.0 (2026-07-16) |
| D2 | Servers + Zabbix Status pages | Retire both. Servers stay Zabbix; "Zabbix Status" becomes **NetMon Status** (`collector_health`, poller sweeps, engine shadow log, DB/session stats) | adopted |
| D3 | Bounded history ring buffer (spec 10 Q3): fixed-window 24h `state_samples` table, auto-pruned, to power port-traffic charts / fleet timelines / VoIP calls / sparklines | **Approve, bounded** — full visual parity is impossible without it; hard 24h pruning honors the no-long-term-series rule's intent. If declined, chart slots render "—" | ✅ **approved 2026-07-15** (§10 Q3); **built as Phase 10.6, 2026-07-17** — migration `019` + `netmon.history` sampler, retention hard-capped at 24h |
| D4 | Operator write actions (PoE cycle via rConfig, XIQ AP reboot, PF reevaluate-access / restart-switchport) behind operator/admin role + audit log + per-action config flag (default off) | Approve as post-cutover phase (11.x), default-disabled; until then disabled buttons with "managed in <source>" tooltips | ✅ **approved 2026-07-28** — design signed off (operator/admin role + audit log + per-action flag, default off); **build in 11.x, post-cutover**. Read-only-first holds through Phase 8; disabled buttons with "managed in <source>" tooltips until then |
| D5 | `websockets` dependency for the Milestone Events/State live path (`collectors/ws.py` is built + tested, unwired) | **Approve** — standing spec-05/spec-10 blocker for live camera state + VMS alarms | ✅ **approved 2026-07-28** — `websockets` pinned and `collectors/ws.py` wired to a live **read-only subscribe**; unblocks live camera state + the stubbed Alarms pane |
| D6 | `snmpbulkwalk` charter amendment (spec 10 Q2) | **Approve — now core scope** (§5.1). Still subprocess, still read-only | ✅ **approved 2026-07-15** (§10 Q2); **built as Phase 10.1, 2026-07-15/16** — migrations `006`/`009` + `netmon/poller/snmp_inventory.py`, still subprocess `snmpbulkwalk`, read-only, per-sweep disableable |
| D7 | Camera JPEG snapshot proxy (ZCD `tcs.camera.snapshot`): credentialed GET to `https://<camera>/snap.jpg` streamed through NetMon; `[surveillance] cam_user/cam_pass` config | Approve — read-only GET, low effort, high UI value | ✅ **approved 2026-07-28, prerequisite first** — all 2,659 cameras carry **no `mgmt_ip`** (Milestone federates by hardware id), so populate camera addresses before the proxy. Proxy MUST resolve only registered camera addresses — a caller-supplied URL would be an SSRF hole |
| D8 | XDR page | Drop — it was never wired in ZCD; revisit only if a Cortex API integration becomes real | adopted |
| D9 | Registry seeding without Zabbix (today `sites` assignment needs a Zabbix `Site/` export) | Make `sites` + the topology file the durable source of truth; `netmon-seed` gains `--sites-from-db`; schedule in 10.0 | adopted |
| D10 | **Direct camera monitoring** (spec 13): read-only SNMP (`snmpget`/`snmpbulkwalk`, no new dependency — same net-snmp path as D6) against the cameras Milestone already gives us, for host health Milestone can't supply — CPU, kernel-uptime reboot, filesystem, interface up/down + bandwidth, encoder bitrate, VCA motion. Bosch profile first (owner's Zabbix template, `reference/zabbix/milestone/template_milestone_camera_bosch.yaml`), vendor-extensible; alerts shadow-first; `[camera_snmp]` default-off | Approve as **post-parity 11.x**, gated + default-disabled — beyond ZCD parity and a direct-re-poll charter point, so plan now / build after cutover-critical work. Depends on the (approved) D6 SNMP amendment | ✅ **approved 2026-07-28** — build in **11.x**, `[camera_snmp]` default-off, alerts shadow-first. Two prerequisites recorded 2026-07-28: cameras have **no `mgmt_ip`/`snmp_capable`** today, and ~2,659 SNMP targets is ~17× the switch fleet, so it needs a load assessment and the contested-address guard (`netmon.state.native_trustworthy`) |

## 7. Revised phase plan

Phases 0–9 stand as delivered (0–4, 6, 9 landed; 5/7 collectors landed at
state-level; 8 = cutover remains owner-gated). Forward plan = spec 10's phases
with amendments:

| Phase | Contents | Delta vs. spec 10 |
|---|---|---|
| **10.0 Foundations** | Fix `/api/status` missing dimensions; `/api/events` filters + `/api/collector-health`; `snapshot_cache` + `assigned_to` migration; port design shell/nav/primitives; Events + Problems consoles; **NetMon Status page (D2)**; **seed `--sites-from-db` (D9)**; nav disposition for Servers/ZbxStatus/XDR/FortiGate (D1/D2/D8) | + NetMon Status, + D9, + nav disposition |
| **10.1 Switching** | ✅ D6 (approved 2026-07-15) → `snmp_inventory` sweeps (ports/FDB/LLDP/VLAN/stack) + tables; switch API; the 8-tab Switches page incl. FDB⋈PF port-detail pane | unchanged (core of the program) |
| **10.2 Wireless** | XIQ detail/clients/SSID cycles (rate budget ≈1.3–1.6k calls/h, ~4× headroom); wireless API; XIQ page + AP Detail | unchanged |
| **10.3 Identity (PF)** | `pf_nodes` persistence (replaces in-memory snapshot), snapshot fetchers, five PF pages | unchanged |
| **10.4 Surveillance + VoIP** | Cameras/RS/storage persistence + `milestone.overview`; **ESS WebSocket wiring (✅ D5)**; **camera snapshot proxy (✅ D7)**; trunks/extensions persistence + wire the existing dead `system_status()` | + D5, + D7 explicit |
| **10.5 Global + Search + polish** | `/api/summary`, `/api/sites` cards, `/api/search` + ⌘K, Global page, staleness badging everywhere | unchanged |
| **10.6 History ring buffer (✅ D3)** | `state_samples` (24h, pruned) + writers (port rates, fleet counts, VoIP calls) + chart slots across pages | new; can interleave after 10.1 |
| **11.x Post-parity** | FortiGate collector + page (D1); operator write actions with audit log (✅ D4); **direct camera SNMP monitoring (✅ D10 — spec 13)**; EAPS/SFP-DOM switch extras | new bucket |
| **8 (unchanged)** | Parallel run & cutover — shadow-vs-Zabbix diff, owner flips `shadow=false`, Zabbix hosts for these domains disabled | after 10.4 |

Ordering: 10.0 → 10.1 first — 10.1 unblocks the FDB joins that 10.2 (client
identity) and 10.4 (camera→switch-port) reuse, and it is the highest-risk item.

**Cutover criterion (restated for the mission):** NetMon reaches parity when an
operator can do everything they did in ZCD *for the in-scope domains* without
opening Zabbix — same pages, same drill-downs, honest staleness — and the
shadow-alert diff has run clean for the agreed window.

## 8. Housekeeping this revision implies

- [x] CLAUDE.md rewritten to v2.0 (mission, scope, phases) — this commit.
- [x] README.md carries a plan-v0.3 pointer note — this commit.
- [x] Spec 10 header cross-references this spec — this commit.
- [x] Drop the unused `apscheduler` pin from `pyproject.toml` — done 2026-07-16.
- [x] Fold known debt into 10.0 — done 2026-07-16: portable
      `seed.upsert_devices()` (SELECT-then-UPDATE/INSERT; runs on SQLite and
      MariaDB, idempotent re-seed, never re-enables or blanks source keys),
      DB-backed session store (migration `007`; SHA-256 token digest at rest,
      restart/multi-worker safe, loud in-process fallback when `007` is
      unapplied), `#/xiq` and `#/wireless` now render an honest "Planned —
      phase 10.2" page instead of falling through to Global (`#/events` was
      fixed by the Events Console).
- `reference/` stays — the authoritative record of request shapes and gotchas
  (spec 00) until each collector's detail cycles land; prune after 10.4.

## Next session

- **False "switches down" fixed end-to-end (2026-07-27).** Verner reported
  "3 switches down" with all three switches alive; fleet-wide 13 switches read
  down while 11 answered SNMP. Two independent causes, both fixed and live
  (service restarted; site cards now flag **0** false switch-down, 21 sites up /
  2 degraded — BUS and SKY, both genuinely trunk-alarmed):
  1. `8767766` — the XIQ status cycle mapped `connected` straight to up/down,
     but XIQ reports `connected: false` for every device it is not managing
     (`UNMANAGED`/`NEW`/`BOOTSTRAP`). `source_state()` now gates on
     `device_admin_state`; non-MANAGED → `unknown`, never crit (spec 03).
  2. `9dc609d` — `rollup_site()`'s poller tiebreaker read only `ping_up`, and
     with `[poller] enabled = false` there are **zero `ping` rows** in
     `device_state`. `snmp_up` is now selected and accepted as native evidence,
     positive-only (`snmp = down` proves nothing) (spec 09).
  Open threads from it: **should `[poller] enabled` be flipped on?** (the whole
  tiebreaker design assumes the fping sweep runs; needs `snmp_community` review
  + ICMP blast-radius check); a **MANAGED-but-cloud-disconnected** switch is now
  silent on the cards though it's a real condition (4 MDF switches were in it);
  Verner still shows `problems=3` from **stale `alerts` rows** the engine can't
  close while `[engine] enabled = false`; and `devices` holds a **duplicate
  registry entry** for `192.168.100.253` (id 834 `VES-GYM` + id 1029, distinct
  XIQ records, different serials — a replaced switch whose old XIQ record
  survives), inflating Verner's device count.
- **Git state (2026-07-27): `main` is ahead of `origin/main` by 6 and unpushed.**
  `gh` 2.96.0 was installed from GitHub's apt repo this session (owner chose the
  device-flow login over a stored PAT), but `gh auth login` is interactive and
  had not been run, so nothing outward-facing happened. Queued once
  authenticated: push `main`; PR `claude/site-cards-switch-down-ogiuzk` closes
  itself as merged (its 4 commits are already in `main` at identical SHAs);
  **close PR `claude/settings-admin-interface-a1ro3x` unmerged** — its
  `269e4c6` snmp_inventory-timeout fix is superseded by `run_timeout_s` on main
  and references the removed `cfg.lldp_interval_s` (now `edp_interval_s`), so it
  would break `SnmpInventory` construction; then delete the 11 fully-merged
  remote branches (audit: 11 merged, 1 already-contained, 1 superseded — no
  branch holds unique work).
- **Phases 10.1–10.6 are built (2026-07-16/17).** The full ZCD page-parity set
  now renders from NetMon's DB: Switches (10.1), Wireless/XIQ + AP Detail
  (10.2), the five PacketFence pages (10.3), Surveillance + VoIP (10.4), the
  Global dashboard + ⌘K search + staleness polish (10.5), and the **bounded 24 h
  history ring buffer + sparklines (10.6 — D3, approved)**. What remains before
  cutover: **live-source payload validation** for 10.2/10.3/10.4 (shapes
  inferred from `reference/`) and the two gated extras (**D5** WebSocket alarms,
  **D7** JPEG proxy). D3 is now resolved (built); the §6 table has been
  reconciled. Details in spec 10's progress log.
- **Direct camera monitoring added to the plan (2026-07-17, owner-requested).**
  New **spec 13** + gate **D10**: read-only SNMP against the Milestone-known
  cameras for host health Milestone can't federate (CPU, kernel-uptime reboot,
  filesystem, interface up/down + bandwidth, encoder bitrate, VCA motion).
  Bosch profile first, from the owner's Zabbix template (now committed at
  `reference/zabbix/milestone/template_milestone_camera_bosch.yaml`), with a
  vendor-extensible profile registry. Scheduled **post-parity (11.x)**, gated,
  `[camera_snmp]` default-off, alerts shadow-first; depends on the approved D6
  SNMP amendment (no new dependency). Nothing coded until D10 sign-off.
- **Phase 10.0 is complete (2026-07-16)** including this spec's amendments:
  NetMon Status page + `/api/netmon-status` (D2), `netmon-seed
  --sites-from-db` (D9), nav disposition (Servers/FortiGate as Zabbix
  deep-links via `[web] zabbix_url` + `/api/meta`, XDR dropped, NetMon Status
  in a System section — D1/D2/D8), and the §8 housekeeping/debt items.
  Details in spec 10's progress log (2026-07-16 entry).
- **All gates are signed off as of 2026-07-28 — D4, D5, D7 and D10 decided
  this session** (D3/D6 were resolved 2026-07-15 and shipped as 10.6/10.1).
  There is no longer any ⛔-blocked work in the plan:
  - **D5 — approved, wire it.** Pin `websockets` and connect `collectors/ws.py`
    to a live **read-only** subscribe. The code and `tests/test_ws.py` already
    exist against a fake transport, so the dependency was the whole blocker.
    Unblocks live camera state and the stubbed Surveillance Alarms pane.
  - **D7 — approved, but a prerequisite lands first.** All **2,659 cameras
    carry no `mgmt_ip`** (Milestone federates by hardware id), so there is no
    address to fetch `/snap.jpg` from. Populate camera addresses from Milestone,
    *then* build the proxy — and resolve **only registered camera addresses**,
    never a caller-supplied URL, or the proxy is an SSRF hole.
  - **D4 — approved for 11.x, post-cutover.** Design is signed: operator/admin
    role, audit log, per-action config flag, default off. Read-only-first still
    holds through Phase 8; disabled buttons with "managed in <source>" tooltips
    until then. Deliberately not built before cutover — every error this
    session was recoverable *because* nothing writes to a source.
  - **D10 — approved for 11.x.** `[camera_snmp]` default-off, alerts
    shadow-first, Bosch profile first. Two prerequisites recorded 2026-07-28:
    cameras have no `mgmt_ip`/`snmp_capable` (shared with D7), and ~2,659 SNMP
    targets is ~17× the 160-switch fleet, so it needs a load assessment and
    must adopt `state.native_trustworthy` — camera sweeps would be keyed by the
    same address mechanism that produced this session's contested-IP bug.
- **Web registry management added 2026-07-16** (owner-requested, out of phase
  order): admin `#/registry` page + `/api/registry/*` — add/edit/delete
  `sites` (rename cascades to the `devices.site` join key; delete refuses to
  orphan assigned devices) and **import switches/APs from XIQ** (read-only
  fleet fetch reusing the seed's reconcile/upsert; dry-run preview; existing
  site assignments preserved per D9). Admin-role + `[security] allow_web_edit`
  gated, same as the settings engine. **Extended 2026-07-16**: the registry
  page also **reassigns devices between sites** — `GET /api/registry/devices`
  (filterable) + `POST /api/registry/devices/assign` (batch move/unassign,
  target site must exist, writes only `devices.site`); UI is a filter-by-
  site/type table with checkbox multi-select + a "Move to…" control. Same
  admin + `allow_web_edit` gate. **Extended 2026-07-17**: the registry page
  also **edits SNMP status-label maps** — `GET/PUT/DELETE
  /api/registry/enums/<name>` over `netmon/enums.py` defaults; overrides live
  in `snapshot_cache` (`enum.<name>`), merged over the default at sweep start
  and picked up live on the next sweep (no restart). First map exposed:
  `stack_status` (extremeStackMemberOperStatus 0=unknown/1=up/2=down/
  3=mismatch), after the field-confirmed enum was corrected twice. **Extended
  again 2026-07-17**: an in-browser **site-map editor** (Site Map → EDIT MAP,
  admin + `allow_web_edit`) — drag site markers to reposition
  (`POST /api/registry/sites/{id}/location`), and create/edit/delete fiber
  links incl. their waypoint polyline (`GET/POST/PUT/DELETE
  /api/registry/links`; endpoints sorted-name; path validated as [lat,lon]
  points or null=straight). Writes only `sites`/`fiber_links`; the KML/JSON
  importer remains the bulk path (same tables). `/api/meta` now carries
  `can_edit` so the UI shows edit affordances only when the gate is on.
  **Link a map location to a network group 2026-07-17**: migration 015 adds
  `sites.group_key` — when set, the map roll-up, device-count, delete guard,
  and device-assign all join on it instead of `sites.name`, so a marker can
  represent a network site/group whose name differs, without renaming the
  marker or moving devices (NULL = historical join-by-name; a linked site's
  rename no longer cascades). `GET /api/registry/groups` lists the live
  `devices.site` groups for the Registry site editor's picklist.
  **Map link/label richness 2026-07-17**: migration 016 adds
  `sites.label_pos` (label placement top/bottom/left/right),
  `fiber_links.link_kind`+`provider` (owned vs leased carrier fiber, e.g.
  C-Spire — rendered distinctly), and `fiber_links.{a,b}_device_id/ifindex`
  (each link end patched into a switch port). When ports are attached the map
  link's up/down + `speed_mbps` + utilization derive from those `switch_ports`
  rows (authoritative, source `snmp_inventory`) instead of the endpoint-site
  roll-up; `/api/links` gains `link_kind`/`provider`/`speed_mbps`/`port_backed`
  and `/api/sites` gains `label_pos`. Registry link CRUD + the map link editor
  set kind/provider and the per-end switch+port pickers. Also this session:
  **topology switched LLDP→EDP** (EXTREME-EDP-MIB, migration 014, table
  `lldp_neighbors`→`neighbors`).
- **SSHEASY integration landed 2026-07-16.** SSHEASY (`jerahl/ssheasy`) is a
  browser SSH client (xterm.js + WASM) embeddable in an iframe. NetMon adds an
  operator/admin-gated **"SSH" button** on device detail pages (switch + AP)
  that opens `<[web] ssheasy_url>/terminal?host=<mgmt_ip>&port=22&embed=1`
  in a modal iframe (with an open-in-new-tab escape hatch). **No credentials
  are ever handled by NetMon** — ssheasy prompts for the username/password in
  the terminal, so read-only-first (§4.1) holds: this is a launch link, not a
  proxy. Config is `[web] ssheasy_url` (empty → affordance hidden), surfaced
  via `/api/meta`; role gating is client-side off `/auth/me` (no server
  endpoint to guard). No new Python/JS dependency.
- **Phase 10.1 Switches page UI landed 2026-07-16** (8 tabs, faceplate,
  port-detail FDB pane — spec 10 progress log). Remaining 10.1 slices: the
  deferred sweeps (PoE, ENTITY serial/fw, fans/PSUs) once a PoE fixture is
  captured; validation against a real stack at fleet scale.
- Next code session: **Phase 10.2 Wireless** — XIQ detail/clients/SSID cycles
  (verify the ≈1.3–1.6k calls/h budget), 005 wireless tables, wireless API,
  XIQ page + AP Detail.
- Capture SNMP fixture walks from one lab EXOS stack (ports/FDB/LLDP/stack)
  into `tests/fixtures/`.
- 2026-07-15 (owner-requested, out of phase order): settings engine shipped —
  web-editable config overlay with write-only secrets, audit trail, and
  in-place apply. See `docs/spec/12-settings-engine.md` +
  `docs/runbooks/settings.md`; owner enables via `[security]` in netmon.conf.
  (Merged into this branch 2026-07-16; its migration renumbered `007`→`008`
  because `007_sessions.sql` landed first.)
