# Spec 11 — Standalone-scope revision (mission: standalone ZabbixCustomDashboard)

**Status:** ADOPTED as plan of record (owner-directed, 2026-07-15). Individual
gate decisions D1–D9 below carry recommendations; the ⛔-marked ones still
require explicit owner sign-off at implementation time, per §4 conventions.
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
| SNMP collection: EXOS switches | `stacking.member[]`, `net.if.status[]`, `poe.dstatus[]`, FDB — read by `SwitchClient` | **`snmpbulkwalk` inventory sweeps** → `switch_ports`/`fdb_entries`/`lldp_neighbors`/`switch_vlans`/`stack_members` | 📋 spec 10 §4 (⛔ D6) |
| SNMP collection: FortiGate | "FortiGate by SNMP" template → `ActionFortigateData` | not planned — deferred | ❓ D1 |
| SNMP collection: APs | `extremeap.*` items → AP Detail page | XIQ `views=FULL` detail/radio/client cycles instead of SNMP | 📋 spec 10 §5 |
| Script/external items: XIQ fleet | `xiq.devices.raw`, `xiq.ap.*[serial]` | XIQ collector detail cycles → `ap_details`/`ap_radios`/`wireless_clients`/`ssids` | 📋 spec 10 §5 |
| External scripts: Milestone | `milestone_*.py` → cron → items → `ActionSurveillanceData` | Milestone collector Config-API persistence + ESS **WebSocket** live path | 📋 spec 10 §5; WS blocked on ⛔ D5. The `reference/zabbix/milestone/*.py` scripts and their cron/`*_read.sh` plumbing are **retired** — the collector replaces them |
| History (time series) | port history graphs, fleet history, VoIP 24h calls | none — charter forbids series | ⛔ D3 (bounded ring buffer) |
| Problems / triggers / ack | `ActionProblemsData`, `ActionEventsData`, `ActionEventsUpdate` | `alert_rules`/`alerts`/`state_events` + ack (exists) + assign/suppress (spec 10) | ✅/📋 |
| Zabbix self-health page | `ActionZbxStatusData` | **NetMon Status page** over `collector_health` + supervisor stats | 📋 new (D2) |

## 4. Page-by-page parity map (ZCD → NetMon)

Verdicts: ✅ covered · 📋 planned · ❓ decision · 🗑 retire.

| ZCD page | ZCD backing | NetMon today | Verdict / what closes the gap |
|---|---|---|---|
| Global Dashboard | Zabbix hosts/problems + `xiq.ap.*` + `milestone.cam.status` + 3CX | thin `global.jsx` | 📋 spec 10.5 (`/api/summary`, `/api/sites`, severity strip, system cards) |
| AP Detail (Wireless) | `extremeap.*` SNMP + XIQ live + PF uplink | generic `#/ap/:id` | 📋 spec 10.2 (`ap_details`, `ap_radios`, `wireless_clients` ⋈ `pf_nodes`) |
| XIQ fleet status | `xiq.devices.raw` + Problems | nav stub | 📋 spec 10.2 |
| Switches (8 tabs) | `SwitchClient` over EXOS items + FDB⋈PF + XIQ + rConfig | thin table | 📋 spec 10.1 — **the big build**; gated on ⛔ D6 |
| FortiGate | Zabbix FortiGate SNMP template | — | ❓ D1: SNMP sweep later, deep-link meanwhile |
| Servers | Zabbix agent items (page was mock) | — | 🗑 retire from NetMon (D2) — servers remain Zabbix's domain; deep-link |
| Zabbix Status | Zabbix internal items | — | 🗑→📋 replace with **NetMon Status** (D2) |
| VoIP (3CX) | `ThreeCXClient` + Zabbix history for 24h calls | thin trunks page | 📋 spec 10.4; 24h call history needs ⛔ D3, else dropped |
| Cortex XDR | mock JSX only | — | 🗑 drop (D8) |
| PacketFence ×5 | **mock** JSX (live PF only via search/device actions) | live `/api/nac` snapshot | 📋 spec 10.3 — NetMon will *exceed* ZCD here |
| Surveillance NOC + Camera/RS detail | `milestone.*` items + PF + snapshot proxy | thin state page | 📋 spec 10.4; live alarms need ⛔ D5; JPEG proxy is D7 |
| Events / Problems consoles | Zabbix events/problems + ack | `problems.jsx` + `/api/events` (map feed) | 📋 spec 10.0 (full console; ack exists, assign/suppress added) |
| Search (⌘K) | Zabbix hosts + PF + XIQ | — | 📋 spec 10.5 (`/api/search` over `devices`+`pf_nodes`+`fdb_entries`) |
| Write actions | PoE cycle, AP reboot, PF reevaluate/restart, camera snapshot | ack only | ⛔ D4 |

No page requires new invention beyond spec 10 except FortiGate (D1), the
NetMon Status page, and the D-decisions. The site map stays — a NetMon-only
addition.

## 5. Charter changes this mission forces

1. **"Federated-only" softens.** The original bet was "never re-poll devices;
   the sources already know." True for XIQ/PF/Milestone/3CX/rConfig — but the
   ZCD switch experience (port faceplates, FDB, VLANs, PoE) came from Zabbix's
   *direct SNMP polling*, which no source platform replaces. Spec 10 §4's
   `snmpbulkwalk` sweeps are therefore **core scope, not an enhancement**
   (still ⛔ D6-gated before code).
2. **Zabbix as a data source disappears entirely** — including at seed time
   (D9) and in nav, except deliberate deep-links for retained-in-Zabbix
   domains (servers).
3. **The read-only rule needs an explicit carve-out list or re-affirmation**
   (⛔ D4): ZCD shipped four operator write actions a "standalone ZCD"
   arguably includes.

## 6. Decisions D1–D9 (recommendations recorded 2026-07-15)

⛔ = requires explicit owner sign-off before the gated code lands (per §4
conventions / the standing new-dependency & charter checkpoints).

| # | Decision | Recommendation | Sign-off |
|---|---|---|---|
| D1 | FortiGate page: build an SNMP sweep collector + page, or keep in Zabbix? | Defer to post-parity (11.x); deep-link meanwhile. The 10.1 sweep pattern makes it cheap later | open |
| D2 | Servers + Zabbix Status pages | Retire both. Servers stay Zabbix; "Zabbix Status" becomes **NetMon Status** (`collector_health`, poller sweeps, engine shadow log, DB/session stats) | adopted |
| D3 | Bounded history ring buffer (spec 10 Q3): fixed-window 24h `state_samples` table, auto-pruned, to power port-traffic charts / fleet timelines / VoIP calls / sparklines | **Approve, bounded** — full visual parity is impossible without it; hard 24h pruning honors the no-long-term-series rule's intent. If declined, chart slots render "—" | ⛔ open |
| D4 | Operator write actions (PoE cycle via rConfig, XIQ AP reboot, PF reevaluate-access / restart-switchport) behind operator/admin role + audit log + per-action config flag (default off) | Approve as post-cutover phase (11.x), default-disabled; until then disabled buttons with "managed in <source>" tooltips | ⛔ open |
| D5 | `websockets` dependency for the Milestone Events/State live path (`collectors/ws.py` is built + tested, unwired) | **Approve** — standing spec-05/spec-10 blocker for live camera state + VMS alarms | ⛔ open |
| D6 | `snmpbulkwalk` charter amendment (spec 10 Q2) | **Approve — now core scope** (§5.1). Still subprocess, still read-only | ⛔ open |
| D7 | Camera JPEG snapshot proxy (ZCD `tcs.camera.snapshot`): credentialed GET to `https://<camera>/snap.jpg` streamed through NetMon; `[surveillance] cam_user/cam_pass` config | Approve — read-only GET, low effort, high UI value | open |
| D8 | XDR page | Drop — it was never wired in ZCD; revisit only if a Cortex API integration becomes real | adopted |
| D9 | Registry seeding without Zabbix (today `sites` assignment needs a Zabbix `Site/` export) | Make `sites` + the topology file the durable source of truth; `netmon-seed` gains `--sites-from-db`; schedule in 10.0 | adopted |

## 7. Revised phase plan

Phases 0–9 stand as delivered (0–4, 6, 9 landed; 5/7 collectors landed at
state-level; 8 = cutover remains owner-gated). Forward plan = spec 10's phases
with amendments:

| Phase | Contents | Delta vs. spec 10 |
|---|---|---|
| **10.0 Foundations** | Fix `/api/status` missing dimensions; `/api/events` filters + `/api/collector-health`; `snapshot_cache` + `assigned_to` migration; port design shell/nav/primitives; Events + Problems consoles; **NetMon Status page (D2)**; **seed `--sites-from-db` (D9)**; nav disposition for Servers/ZbxStatus/XDR/FortiGate (D1/D2/D8) | + NetMon Status, + D9, + nav disposition |
| **10.1 Switching** | ⛔ D6 gate → `snmp_inventory` sweeps (ports/FDB/LLDP/VLAN/stack) + tables; switch API; the 8-tab Switches page incl. FDB⋈PF port-detail pane | unchanged (core of the program) |
| **10.2 Wireless** | XIQ detail/clients/SSID cycles (rate budget ≈1.3–1.6k calls/h, ~4× headroom); wireless API; XIQ page + AP Detail | unchanged |
| **10.3 Identity (PF)** | `pf_nodes` persistence (replaces in-memory snapshot), snapshot fetchers, five PF pages | unchanged |
| **10.4 Surveillance + VoIP** | Cameras/RS/storage persistence + `milestone.overview`; **ESS WebSocket wiring (⛔ D5)**; **camera snapshot proxy (D7)**; trunks/extensions persistence + wire the existing dead `system_status()` | + D5, + D7 explicit |
| **10.5 Global + Search + polish** | `/api/summary`, `/api/sites` cards, `/api/search` + ⌘K, Global page, staleness badging everywhere | unchanged |
| **10.6 History ring buffer (⛔ D3)** | `state_samples` (24h, pruned) + writers (port rates, fleet counts, VoIP calls) + chart slots across pages | new; can interleave after 10.1 |
| **11.x Post-parity** | FortiGate collector + page (D1); operator write actions with audit log (⛔ D4); EAPS/SFP-DOM switch extras | new bucket |
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

- **Phase 10.0 is complete (2026-07-16)** including this spec's amendments:
  NetMon Status page + `/api/netmon-status` (D2), `netmon-seed
  --sites-from-db` (D9), nav disposition (Servers/FortiGate as Zabbix
  deep-links via `[web] zabbix_url` + `/api/meta`, XDR dropped, NetMon Status
  in a System section — D1/D2/D8), and the §8 housekeeping/debt items.
  Details in spec 10's progress log (2026-07-16 entry).
- Owner: sign off (or veto) the ⛔ gates — D3, D4, D5, D6 — they gate 10.1,
  10.4, 10.6, and 11.x scope. (Note: spec 10 Q2/Q3 record owner approval of
  the D6 sweeps and D3 ring buffer on 2026-07-15, and the 10.1 sweep code is
  already on main under that amendment — reconcile this table's "open" marks
  with those resolutions when signing.)
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
