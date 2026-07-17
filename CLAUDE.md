# TCS NetMon — Claude Code Project Brief

**Version:** 2.0 (standalone-scope revision, July 2026 — see `docs/spec/11-standalone-scope.md`; supersedes v1.0 / plan v0.2)
**Audience:** Claude Code sessions building this project. Read this file fully before writing any code.
**Owner context:** Solo network/systems administrator; development happens in short sessions (6–10 hrs/week total). Every session must leave the repo in a working, committed, documented state.

---

## 1. What this project is

**NetMon is the standalone version of ZabbixCustomDashboard** (`jerahl/ZabbixCustomDashboard`, mirrored in `reference/`): the same operational dashboards the district runs today as a Zabbix frontend module — Global, Switches, Wireless/XIQ, AP Detail, PacketFence, Surveillance, VoIP, Events/Problems, Search, Site Map, NetMon Status — served from NetMon's own database, fed by its own read-only collectors and SNMP sweeps, with its own alerting. **No Zabbix at runtime.**

The data strategy is unchanged from v1.0 where a source platform already has the answer — federate it rather than re-poll ~2,600 devices:

| Domain | Authoritative source | Collector pulls |
|---|---|---|
| Switching & wireless | ExtremeCloud IQ (REST, bearer token) | Device up/down, detail/radio/client cycles, firmware |
| NAC / endpoints | PacketFence (REST `/api/v1/…`) | Node inventory, connection state, auth events, quarantine |
| Config management | rConfig (API) | Backup freshness, backup metadata |
| Voice | 3CX (v20 REST) | Trunk registration, extensions, system status |
| Surveillance | Milestone XProtect (Config API + Events/State WebSocket) | Camera/recording state, RS health, storage, alarms |

Two things the sources can *not* provide are NetMon's own collection:

1. **The native poller** — ground truth against registered management IPs: ICMP up/down (`fping` sweep, 60s) and SNMP-responding (`snmpget` sysUpTime, 5 min). Tiebreaker when a source disagrees with reality; canary when a source platform is unreachable.
2. **SNMP inventory sweeps** *(⛔ D6-gated; spec 10 §4, spec 11 §5)* — read-only `snmpbulkwalk` subprocess sweeps of the switch fleet (ports/PoE, FDB, LLDP, VLANs, stack/env). The ZCD switch experience (port faceplates, FDB⋈PF identity pane) came from Zabbix's direct SNMP polling, which no federated source replaces — this is **core scope**, not an enhancement.

NetMon also owns **alerting** (rules → dedupe → maintenance windows → SMTP email) because Zabbix's alerting is being retired for these domains.

## 2. Scope boundaries — hard rules

**In scope (v1):** unified device registry; current-state store + state-transition event log; the **snapshot/inventory cache layer** (spec 10 — row-shaped inventory tables + `snapshot_cache`, replace-on-refresh, collectors are the only writers, pages never poll a source at render time); the full ZCD page-parity set (spec 11 §4); alert engine with email notifications; site map; collector self-health monitoring.

**Explicitly OUT of scope (do not build, even if it seems easy):**
- Server monitoring (Nutanix, iDRAC, Linux/Windows agents, BIND) — Zabbix keeps this. The ZCD Servers page is **retired**, not ported (spec 11 D2); nav deep-links to Zabbix.
- The ZCD Zabbix Status page (replaced by a **NetMon Status** page over `collector_health` + supervisor stats) and the Cortex XDR mock page (dropped — spec 11 D8).
- FortiGate — **deferred** to post-parity phase 11.x (spec 11 D1); nav deep-links to Zabbix meanwhile.
- Long-term metric time-series / graphs — source platforms retain their own history. NetMon's history is the `state_events` transition log, plus (⛔ D3, if signed off) one **bounded 24h ring-buffer** table (`state_samples`, auto-pruned) to power the ZCD-parity charts. Nothing beyond that window, ever.
- Write paths to any source platform. **Every integration is read-only.** Exception path: spec 11 D4 (⛔) proposes porting ZCD's four operator write actions (PoE cycle, AP reboot, PF reevaluate/restart-port) as a post-cutover phase — role-gated, audit-logged, per-action config flags, default off. Until D4 is signed off, render disabled buttons with "managed in <source>" tooltips. If any other task appears to require a write to a source, stop and flag it.
- Notification channels beyond SMTP (no Teams/webhooks/SMS in v1).
- Multi-tenant / multi-district features.

## 3. Stack and dependency policy

- **Python 3.11+** (3.12 preferred; the deploy VM runs Debian 12 / Python 3.11), single package `netmon`, FastAPI app served by uvicorn behind nginx.
- **MariaDB** via **SQLAlchemy Core** (no ORM/declarative models — explicit, SQL-shaped queries). Schema via plain numbered migration scripts in `migrations/` applied by a small runner; no Alembic.
- **Allowed third-party dependencies:** `fastapi`, `uvicorn`, `sqlalchemy`, `httpx`, `pymysql` (MariaDB DBAPI driver — owner-approved 2026-07-11), `python3-saml` (ClassLink SSO — owner-approved 2026-07-13; links `xmlsec1`/`libxml2` system libs, installed at deploy time). Pinned in a lockfile. **Do not add any other dependency without stopping and asking.** Prefer stdlib. ICMP/SNMP are subprocess calls to `fping` / `snmpget` / (⛔ D6) `snmpbulkwalk` — do not introduce a Python SNMP library.
  - `websockets` (Milestone Events/State live path) is **recommended-pending sign-off** (⛔ spec 11 D5). `collectors/ws.py` is built and tested against a fake transport; do not wire a live socket until the dependency is approved and pinned.
  - `ldap3` is retired (SAML claims carry roles; no directory bind).
- **Frontend:** React components ported from `jerahl/ZabbixCustomDashboard` — including the spec-10 "Zabbix Extreme" design port — built with **esbuild** to static files served by FastAPI. `leaflet` 1.9.4 (site map — owner-approved 2026-07-14) is bundled locally like React. No Babel-standalone, no unpkg/CDN loads, no framework migration.
- **Auth:** Single sign-on. NetMon is a **SAML 2.0 Service Provider**; **ClassLink** is the IdP. Assertion `role`/`group_ids` claims map to roles (`viewer` < `operator` < `admin`); NetMon issues its own server-side session cookie and never handles a password. Break-glass local account (PBKDF2, stdlib) and a dev bypass (refused when `secure_cookies=true`) remain.

## 4. Engineering conventions (non-negotiable)

These reflect the owner's standing practices. Follow them even when unstated in a task:

1. **Read-only-first.** Collectors never mutate source systems. HTTP methods other than GET (and the Milestone WebSocket subscribe) require explicit owner approval. (The D4 write-action carve-out, once signed off, is the only exception — role-gated, audit-logged, default off.)
2. **Dry-run before live.** Anything that sends email or changes state visible to humans needs a dry-run/shadow flag that is the default until the owner flips it. The alert engine ships in shadow mode.
3. **Per-step reversibility.** Each collector, sweep, the poller, and the engine are independently enable/disable-able via config. Migrations get a documented rollback note.
4. **Spec-first.** Each phase starts by writing/updating the relevant `docs/` spec before code. If implementation diverges from spec, update the spec in the same commit.
5. **Fail loud, never stale.** A collector that errors must record the failure in `collector_health` and leave prior state visibly stale (with timestamps), never silently overwrite or fabricate. Every API list response carries row `updated_at` so the UI badges staleness honestly; a blind source must never render as healthy.
6. **Secrets** live in `/etc/netmon/netmon.conf` (root-readable, outside the repo). The repo carries `netmon.conf.example` only. Never write a real credential, token, hostname-with-secret, or key into the repo, logs, or test fixtures.
7. **Docs during, not after.** Every collector gets its own README (endpoints used, poll intervals, rate limits, failure modes). Runbooks in `docs/runbooks/` are updated in the same PR as the behavior they describe.
8. **Tests:** pytest; every collector/sweep gets fixture-based parse tests (sanitized sample payloads in `tests/fixtures/`); the alert engine gets rule-evaluation unit tests before it ever runs against live state.

## 5. Repository layout

```
netmon/
├── pyproject.toml
├── netmon.conf.example
├── topology.example.json       # site-map topology template (spec 09)
├── migrations/                 # 001_init.sql … each with -- rollback: note
├── netmon/
│   ├── app.py                  # FastAPI factory, lifespan task supervisor, /ui mount
│   ├── config.py               # INI config load/validate (fails loud)
│   ├── db.py                   # SQLAlchemy Core engine, portable upsert helpers
│   ├── state.py / health.py    # write_state (state+events), collector_health writers
│   ├── seed.py / migrate.py / topology.py   # one-shot CLIs (netmon-seed/-migrate/-topology)
│   ├── supervisor.py           # asyncio task supervisor (interval+timeout+boundary)
│   ├── auth/                   # SAML SP (ClassLink), local break-glass, sessions
│   ├── api/                    # routers: devices, status, sites/links/events, nac, alerts, auth, health
│   ├── models/                 # Pydantic schemas (API contract + collector validation)
│   ├── poller/                 # fping sweep, snmp-alive, hysteresis; (D6) snmp_inventory sweeps
│   ├── collectors/             # base contract + xiq/packetfence/milestone/threecx/rconfig (+ws)
│   ├── engine/                 # rule evaluation, dedupe, maintenance, notify (SMTP, shadow)
│   └── web/                    # committed esbuild output (static), served by FastAPI
├── frontend/                   # React/JSX source + esbuild config (npm run build)
├── reference/                  # the ZCD add-on being replaced (authoritative API gotchas)
├── scripts/                    # one-shot exports (xiq/pf/zabbix), shadow_report, deploy.sh
├── docs/
│   ├── spec/                   # per-phase specs; 11-standalone-scope.md is the plan of record
│   ├── design/                 # design handoff bundles
│   └── runbooks/
└── tests/
```

**Execution model:** collectors, sweeps, poller, and engine run as supervised asyncio tasks started by the FastAPI lifespan (each wrapped in timeout + exception boundary + reschedule). Every one of them must ALSO run standalone: `python -m netmon.collectors.xiq --once|--loop`. The contract lives in `collectors/base.py`.

## 6. Data model (extend only via numbered migration)

**Core (001, built):**
- **`devices`** — unified registry. `id`, `name`, `site`, `device_type` (switch|ap|camera|recording_server|trunk|pbx|other), `mgmt_ip`, `snmp_capable`, `enabled`, plus nullable per-source keys: `xiq_device_id`, `pf_node_mac`, `milestone_hardware_id`, `rconfig_device_id`, `threecx_ref`.
- **`device_state`** — current state only. (`device_id`,`dimension`) PK; dimension ∈ ping|snmp|source_status|config_backup|recording|trunk; `value`, `severity` (ok|warn|crit|unknown), `source`, `updated_at`.
- **`state_events`** — append-only transition log. Never UPDATE or DELETE rows here.
- **`alert_rules`**, **`alerts`** (one open row per device+rule), **`notifications`**, **`maintenance_windows`**, **`collector_health`**.

**Site map (004, built):** `sites` (name = `devices.site` join key, lat/lon, tier), `fiber_links`, `fiber_link_state` (current state only).

**Snapshot/inventory cache (spec 10 §3, planned):** `switch_ports`, `fdb_entries`, `lldp_neighbors`, `switch_vlans`, `stack_members`; `ap_details`, `ap_radios`, `wireless_clients`, `ssids`; `pf_nodes`; `cameras`, `recording_servers`, `trunks`, `extensions`; `config_backups`; generic `snapshot_cache` (key→JSON payload). Replace-on-refresh, `updated_at` on every row, no history. Counters store previous raw values in-row so rates are computed at write time — current rate is state, not history.

**Bounded history (⛔ D3, if approved):** one `state_samples` ring-buffer table, hard 24h retention, auto-pruned — nothing else stores series.

**Design invariants:** `device_state` answers "what is true now"; `state_events` answers "what changed when"; inventory tables are descriptive facts; dashboards read only NetMon's DB — **zero source-platform calls at page render**. A source being unreachable is itself a state (`source_status = blind`), and blind must never render as healthy.

## 7. Milestones and phases

**Delivered:** Phases 0–4, 6, 9 (foundation, poller, XIQ status collector, first UI port, alert engine in shadow, site map); Phases 5/7 collectors at state-level (PF snapshot, Milestone Config-API poll, 3CX trunks, rConfig freshness); **Phase 10.0 complete** (2026-07-16, incl. the spec-11 amendments: NetMon Status page, seed `--sites-from-db`, nav disposition, DB-backed sessions); **Phase 10.1 feature-complete** (SNMP sweeps incl. PoE+entity, switch API, 8-tab Switches page — 2026-07-15/16); **Phase 10.2 built** (wireless tables, XIQ detail/clients/SSID cycles, wireless API, XIQ + AP Detail pages — 2026-07-16, live-fleet payload validation pending). Phase 8 (cutover) remains owner-gated at the end.

**Forward plan (spec 11 §7 — work phase-by-phase; do not start a phase until the prior phase's DoD is met and committed):**

| Phase | Deliverable | Gate |
|---|---|---|
| **10.0 Foundations** | `/api/status` dimension fix; `/api/events` filters + `/api/collector-health`; `snapshot_cache` + `alerts.assigned_to` migration; design shell/nav/primitives port; Events + Problems consoles; **NetMon Status page**; seed `--sites-from-db`; nav disposition (Servers/ZbxStatus/XDR/FortiGate) | — |
| **10.1 Switching** | `snmp_inventory` sweeps + 004-tables; switch API; 8-tab Switches page incl. FDB⋈PF port-detail pane | ⛔ D6 |
| **10.2 Wireless** | XIQ detail/clients/SSID cycles (rate budget verified); wireless API; XIQ page + AP Detail | — |
| **10.3 Identity** | `pf_nodes` persistence (in-memory snapshot deleted); NAC API rework; five PF pages | — |
| **10.4 Surveillance + VoIP** | camera/RS/storage persistence + `milestone.overview`; ESS WebSocket wiring; camera JPEG proxy; trunks/extensions + SystemStatus | ⛔ D5 |
| **10.5 Global + Search** | `/api/summary`, `/api/sites` cards, `/api/search` + ⌘K palette; Global page; staleness badging pass | — |
| **10.6 History buffer** | `state_samples` (24h ring, pruned) + writers + chart slots | ⛔ D3 |
| **11.x Post-parity** | FortiGate collector + page (D1); operator write actions with audit log (⛔ D4); EAPS/SFP-DOM extras | ⛔ D4 |
| **8 — Parallel run & cutover** *(owner-gated)* | ≥4 weeks shadow comparison; owner flips `shadow=false`; Zabbix network/wireless/voice/camera hosts disabled (configs exported as rollback); Zabbix remains for servers | owner |

**Cutover criterion:** an operator can do everything they did in ZabbixCustomDashboard *for the in-scope domains* without opening Zabbix — same pages, same drill-downs, honest staleness — and the shadow-alert diff has run clean for the agreed window.

## 8. Session protocol for Claude Code

- Start each session by reading `docs/spec/` for the current phase (spec 11 is the plan of record) and `git log --oneline -15`.
- Work in small commits with imperative messages; never leave main broken.
- If a task requires: a new dependency, a non-GET call to a source, sending real email, schema change outside a migration, or anything touching credentials — **stop and ask the owner**.
- End each session by updating the phase spec's checklist and noting open threads in `docs/spec/NN-…md` under "Next session".

## 9. Open questions (tracked; do not guess answers)

**⛔ Gates awaiting owner sign-off (spec 11 §6, recommendations recorded):** D3 (bounded 24h ring buffer), D4 (operator write actions, post-cutover), D5 (`websockets` dependency), D6 (`snmpbulkwalk` sweeps — gates 10.1).

**Carried over:** XIQ rate limits at production device counts (validate the ≈1.3–1.6k calls/h budget); 3CX v20 surface for extensions/active calls/queues (fixtures first); rConfig config-diff pane (on-click read-through vs. link-out — spec 10 Q5); `wireless_clients` scale/PII acceptance (~9–12k rows with usernames/MACs — spec 10 Q8); SMTP relay; SP cert rotation.

**Runtime-resilience goal (unchanged):** "offline-tolerant" means NetMon keeps working when the *network or a source is down* — degrade gracefully, mark sources `blind`, never fabricate or serve stale-as-fresh. It does **not** mean a zero-internet install; deploy-time package pulls are fine. (Distinct from the §3 frontend rule that the *app bundle* ships no CDN loads.)
