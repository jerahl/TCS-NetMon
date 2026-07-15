# TCS NetMon — Claude Code Project Brief

**Version:** 1.0 (derived from project plan v0.2, July 2026)
**Audience:** Claude Code sessions building this project. Read this file fully before writing any code.
**Owner context:** Solo network/systems administrator; development happens in short sessions (6–10 hrs/week total). Every session must leave the repo in a working, committed, documented state.

---

## 1. What this project is

NetMon is a federated monitoring platform that replaces Zabbix for **network, wireless, voice, and surveillance** monitoring at a K-12 school district. Instead of polling ~2,600+ devices directly, it pulls state from the platforms that already poll them, and runs one thin native poller for ground truth:

| Domain | Authoritative source | Collector pulls |
|---|---|---|
| Switching & wireless | ExtremeCloud IQ (REST, bearer token) | Device up/down, port state, PoE, client counts, CPU/mem, firmware |
| NAC / endpoints | PacketFence (REST `/api/v1/…`) | Node inventory, connection state, auth events, quarantine |
| Config management | rConfig (API or read-only DB) | Backup freshness, last config change |
| Voice | 3CX (ODBC to its DB; REST TBD) | Trunk registration, extension status, service health |
| Surveillance | Milestone XProtect (Config API + Events/State WebSocket) | Camera state, recording state, recording-server health |

The **native poller** does two things against registered management IPs: ICMP up/down (`fping` sweep, 60s) and SNMP-responding (`snmpget` sysUpTime, 5 min). It is the tiebreaker when a source disagrees with reality, and the canary when a source platform itself is unreachable.

**Charter amendment (owner-approved 2026-07-15, spec 10 §4/§10 Q2):** the poller's SNMP surface is extended with **read-only `snmpbulkwalk` inventory sweeps** (per-port/FDB/LLDP/VLAN/stack tables) for the switching UI — same net-snmp package, still GET-only/read-only, still **no Python SNMP library**, concurrency-capped and per-sweep disableable (see `netmon/poller/snmp_inventory.py`, spec 10 §4). This is the one sanctioned widening of the "exactly fping + snmpget" rule above; any further poller write/active behaviour still needs explicit owner sign-off.

NetMon also owns **alerting** (rules → dedupe → maintenance windows → SMTP email) because Zabbix's alerting is being retired for these domains.

## 2. Scope boundaries — hard rules

**In scope (v1):** unified device registry, current-state store, state-transition event log, dashboards (React), alert engine with email notifications, collector self-health monitoring.

**Explicitly OUT of scope (do not build, even if it seems easy):**
- Server monitoring (Nutanix, iDRAC, Linux/Windows agents, BIND) — Zabbix keeps this.
- Long-term metric time-series / graphs — source platforms retain their own history. NetMon's only history is the `state_events` transition log. **Narrow exception (owner-approved 2026-07-15, spec 10 §10 Q3):** a single **bounded, fixed-24 h, auto-pruned ring buffer** may back the design's sparklines/mini-charts. It is capped-size and self-pruning (not growing history), lands via a numbered migration with a rollback note, and is the *only* sanctioned deviation — no other metric series, no retention beyond 24 h.
- Write paths to any source platform. **Every integration is read-only.** No config pushes, no acknowledging events in Milestone, no PF node edits. If a task appears to require a write to a source, stop and flag it.
- Notification channels beyond SMTP (no Teams/webhooks/SMS in v1).
- Multi-tenant / multi-district features.

## 3. Stack and dependency policy

- **Python 3.11+** (3.12 preferred; the deploy VM runs Debian 12 / Python 3.11 — decided 2026-07-13), single package `netmon`, FastAPI app served by uvicorn behind nginx.
- **MariaDB** via **SQLAlchemy Core** (no ORM/declarative models — explicit, SQL-shaped queries). Schema via plain numbered migration scripts in `migrations/` applied by a small runner; no Alembic.
- **Allowed third-party dependencies:** `fastapi`, `uvicorn`, `sqlalchemy`, `httpx`, `apscheduler`, `pymysql` (MariaDB DBAPI driver — owner-approved 2026-07-11), `python3-saml` (ClassLink SSO — owner-approved 2026-07-13; links `xmlsec1`/`libxml2` system libs, installed at deploy time). Pinned in a lockfile. **Do not add any other dependency without stopping and asking.** Prefer stdlib. ICMP/SNMP are subprocess calls to `fping` / `snmpget` — do not introduce a Python SNMP library.
  - `ldap3` is **retired** (was: interim AD-bind login). ClassLink sends `role` + `group_ids` in the SAML assertion, so no directory lookup is needed; drop `ldap3` and `netmon/auth/ldap.py` when the SAML SP replaces the interim login.
  - `python3-saml`'s pin lands in `pyproject.toml` when the SAML SP is implemented (the last §3 dependency checkpoint); the deploy script adds the `xmlsec1` system package at the same time.
- **Frontend:** React components ported from `jerahl/ZabbixCustomDashboard` (`tcs_dashboard/assets/*.jsx`), built with **esbuild** to static files served by FastAPI. `leaflet` 1.9.4 (Phase 9 map — owner-approved 2026-07-14) is the one additional frontend dependency, bundled locally by esbuild like React. No Babel-standalone, no unpkg/CDN loads, no framework migration — keep the existing component structure.
- **Auth:** Single sign-on. NetMon is a **SAML 2.0 Service Provider**; **ClassLink** is the identity provider (it federates the district directory). NetMon consumes the signed SAML assertion at its ACS endpoint, maps assertion attributes (ClassLink role/group claims) → roles, and issues its own server-side session cookie. **NetMon never handles a password and does not bind AD directly.** Roles: `viewer`, `operator` (can ack alerts / set maintenance), `admin` (can edit rules/registry). A local dev bypass remains for development without an IdP. *(Plan adjustment 2026-07-13: this replaces the earlier AD-via-`ldap3` bind; the Phase 1 interim `ldap3` login is to be reworked — see `docs/spec/01-foundation.md`.)*

## 4. Engineering conventions (non-negotiable)

These reflect the owner's standing practices. Follow them even when unstated in a task:

1. **Read-only-first.** Collectors never mutate source systems. HTTP methods other than GET (and the Milestone WebSocket subscribe) require explicit owner approval.
2. **Dry-run before live.** Anything that sends email or changes state visible to humans needs a dry-run/shadow flag that is the default until the owner flips it. The alert engine ships in shadow mode (logs would-be notifications, sends nothing).
3. **Per-step reversibility.** Each collector, the poller, and the engine are independently enable/disable-able via config. Migrations get a documented rollback note.
4. **Spec-first.** Each phase starts by writing/updating the relevant `docs/` spec before code. If implementation diverges from spec, update the spec in the same commit.
5. **Fail loud, never stale.** A collector that errors must record the failure in `collector_health` and leave prior state visibly stale (with timestamps), never silently overwrite or fabricate.
6. **Secrets** live in `/etc/netmon/netmon.conf` (root-readable, outside the repo). The repo carries `netmon.conf.example` only. Never write a real credential, token, hostname-with-secret, or key into the repo, logs, or test fixtures.
7. **Docs during, not after.** Every collector gets its own README (endpoints used, poll intervals, rate limits, failure modes). Runbooks in `docs/runbooks/` are updated in the same PR as the behavior they describe.
8. **Tests:** pytest; every collector gets fixture-based parse tests (sanitized sample payloads in `tests/fixtures/`); the alert engine gets rule-evaluation unit tests before it ever runs against live state.

## 5. Repository layout

```
netmon/
├── pyproject.toml
├── netmon.conf.example
├── migrations/                 # 001_init.sql, 002_…, each with -- rollback: note
├── netmon/
│   ├── app.py                  # FastAPI factory, lifespan task supervisor
│   ├── config.py               # config load/validate (stdlib configparser or tomllib)
│   ├── db.py                   # engine, helpers (SQLAlchemy Core)
│   ├── auth/                   # SAML SP (ClassLink IdP), assertion→role mapping, sessions
│   ├── api/                    # routers: devices, state, events, alerts, admin
│   ├── models/                 # Pydantic schemas (API contract + collector validation)
│   ├── poller/                 # fping sweep, snmp-alive, hysteresis state machine
│   ├── collectors/
│   │   ├── base.py             # Collector ABC: run(), heartbeat, error boundary
│   │   ├── xiq.py
│   │   ├── packetfence.py
│   │   ├── milestone.py        # Config API + WebSocket task (watchdog, backoff)
│   │   ├── threecx.py
│   │   └── rconfig.py
│   ├── engine/                 # rule evaluation, dedupe, maintenance, notify (SMTP)
│   └── web/                    # esbuild output (static), served by FastAPI
├── frontend/                   # JSX source ported from ZabbixCustomDashboard + esbuild config
├── docs/
│   ├── spec/                   # per-phase specs
│   └── runbooks/
└── tests/
```

**Execution model:** collectors, poller, and engine run as supervised asyncio tasks started by the FastAPI lifespan (each wrapped in timeout + exception boundary + reschedule). Every one of them must ALSO run standalone: `python -m netmon.collectors.xiq --once` and `--loop`. Build both paths from the start in `base.py`.

## 6. Data model (build exactly this in Phase 1; extend only via migration)

- **`devices`** — unified registry. `id`, `name`, `site`, `device_type` (switch|ap|camera|recording_server|trunk|pbx|other), `mgmt_ip`, `snmp_capable`, `enabled`, plus nullable per-source keys: `xiq_device_id`, `pf_node_mac`, `milestone_hardware_id`, `rconfig_device_id`, `threecx_ref`. Unique on (`name`), indexed on each source key.
- **`device_state`** — current state only. `device_id`, `dimension` (ping|snmp|source_status|config_backup|recording|trunk), `value`, `severity` (ok|warn|crit|unknown), `source` (which collector/poller wrote it), `updated_at`. PK (`device_id`,`dimension`).
- **`state_events`** — append-only. `device_id`, `dimension`, `old_value`, `new_value`, `severity`, `source`, `occurred_at`. This is the only history table; never UPDATE or DELETE rows here.
- **`alert_rules`** — `dimension`, `condition` (simple comparators, stored as data), `severity`, `min_duration_s`, `target` (email), `enabled`.
- **`alerts`** — one open row per (`device_id`,`rule_id`); `opened_at`, `last_seen_at`, `closed_at`, `acked_by`, `acked_at`. Re-fires update `last_seen_at`, never duplicate.
- **`notifications`** — what was (or in shadow mode, would have been) sent: `alert_id`, `channel`, `target`, `sent_at`, `shadow` (bool), `payload_summary`.
- **`maintenance_windows`** — device/site/type scoped, `starts_at`/`ends_at`, `created_by`. Suppresses notification, not state recording.
- **`collector_health`** — one row per collector: `name`, `last_start`, `last_success`, `last_error`, `duration_ms`, `records_written`, `consecutive_failures`. Staleness here feeds a built-in `source blind` alert rule.

**Design invariants:** `device_state` answers "what is true now"; `state_events` answers "what changed when"; dashboards read only these two plus `devices`. A source being unreachable is itself a state (`source_status = blind`), and blind must never render as healthy.

## 7. Milestones and phases

Work phase-by-phase. **Do not start a phase until the prior phase's Definition of Done is met and committed.** Each phase begins with its spec in `docs/spec/`.

### Phase 0 — Spec & reconnaissance *(mostly owner-driven; Claude Code assists)*
Verify API access to all five sources; capture sanitized sample payloads into `tests/fixtures/`; document rate limits (especially XIQ) and the 3CX v20 API-vs-ODBC decision; write naming/site reconciliation rules for the device registry.
**DoD:** `docs/spec/00-sources.md` complete; one sanitized fixture per source committed.

### Phase 1 — Foundation
Package scaffold per §5; `001_init.sql` implementing §6 with rollback notes; config loader + validation; FastAPI skeleton with SSO auth (SAML SP / ClassLink), sessions, roles, `/healthz`; task-supervisor scaffold in lifespan; one-shot import script seeding `devices` from XIQ + PacketFence fixtures/exports; migration runner.
**DoD:** app boots, SSO login works (or the dev bypass), `/docs` renders, registry populated, `pytest` green, runbook `docs/runbooks/deploy.md` written. *(Interim `ldap3` login shipped ahead of this plan change; SAML SP is the target — tracked in `docs/spec/01-foundation.md`.)*

### Phase 2 — Native poller
fping sweep + snmp-alive as supervised tasks and standalone modules; hysteresis (3 consecutive failures → DOWN, 2 successes → UP; thresholds in config); writes to `device_state`/`state_events`; raw status API endpoint + minimal status page.
**DoD:** full-registry sweep completes inside its interval; transitions visible in `state_events`; kill-a-lab-device test shows correct DOWN→UP cycle; poller README written.

### Phase 3 — Collector: XIQ
`base.py` contract finalized (heartbeat, error boundary, Pydantic validation, staleness marking); XIQ collector for device status + port state on fast cycle, inventory on slow cycle; rate-limit compliance from Phase 0 findings; `source_status`/blind detection; built-in collector-stale alert rule seeded.
**DoD:** switching + wireless state live in DB; XIQ token revocation test shows loud failure + blind state, no stale-as-fresh data; fixture parse tests green.

### Phase 4 — UI port
Extract JSX assets from ZabbixCustomDashboard into `frontend/`; esbuild pipeline; port Global, Switches, and AP Detail pages onto NetMon endpoints; unified nav (`global-nav.jsx`) with routes for all planned pages; remove Zabbix-module coupling and CDN loads.
**DoD:** three pages render live data via the FastAPI endpoints; build is one command; no external network fetches at runtime.

### Phase 5 — Collectors: PacketFence, Milestone
PF collector (nodes + reports, heavy caching, minutes-scale intervals); Milestone Config API collector + Events/State WebSocket task with reconnect/backoff and watchdog; wire Surveillance NOC + camera/recording-server pages; validate Milestone task in standalone mode as the documented fallback.
**DoD:** NAC and Surveillance pages live; WebSocket survives a forced disconnect test; both collector READMEs written.

### Phase 6 — Alert engine (shadow mode)
Rule evaluation loop over `device_state`; dedupe per (device, rule); `min_duration_s` gate; maintenance windows; ack API + UI; SMTP notifier behind `shadow=true` default; seed rules: device down, source blind, config backup stale >7d, camera not recording, trunk unregistered, collector stale; shadow-vs-Zabbix comparison report script.
**DoD:** engine runs continuously in shadow; `notifications` table fills with shadow rows; rule unit tests green; comparison report produces a weekly diff the owner can read.

### Phase 7 — Collectors: 3CX, rConfig
3CX per the Phase 0 decision (ODBC read-only default); rConfig backup-freshness enrichment; voice status surfaced in UI.
**DoD:** both live, both documented, both fixtures tested.

### Phase 8 — Parallel run & cutover *(owner-gated)*
≥4 weeks of shadow comparison; close gaps found; owner flips `shadow=false`; Zabbix network/wireless/voice/camera hosts disabled (with exported configs as rollback); Zabbix remains for servers.
**DoD:** owner sign-off backed by the comparison diffs — Claude Code does not perform the cutover actions.

### Phase 9 — Geographic site-status map (NOC wall view) *(enhancement)*
Begins with `docs/spec/09-site-map.md`; design source is the Claude Design handoff in `docs/design/netmon-map/` (`project/Netmon Map.dc.html`). A Leaflet map of the district: sites as up/degraded/down status dots (rolled up from `device_state` per site), animated inter-site fiber links weighted by capacity and colored by live utilization, a live event feed from `state_events`, a status-sorted side panel, and a fullscreen NOC mode. Recreate the prototype's visual output on real NetMon endpoints (new `/api/sites` roll-up); do not port its simulation loop. Introduces new data the core model lacks — per-site lat/lon + tier, and an inter-site fiber-link registry with current-state utilization — via a numbered migration. **Depends on Phases 3–4** (real state + UI/esbuild pipeline), so it can be pulled forward once those land; otherwise scheduled after cutover stabilizes. Open decisions live in the spec: map tiles/Leaflet as an external fetch vs. self-hosted offline pack (must satisfy the §3 "no CDN loads" / Phase 4 "no external fetches at runtime" rules), link-topology source, and avoiding the `trunk` (voice) dimension collision. **Scope guard:** current-state view + curated topology only — no historical utilization time-series (§2).
**DoD:** map page renders live site + link state via FastAPI endpoints; site/link roll-up + topology come from the DB (no simulated data); NOC mode works; tile/Leaflet delivery satisfies the no-external-fetch rule (or the owner's explicit exception is recorded); migration has a rollback note; spec checklist complete.

## 8. Session protocol for Claude Code

- Start each session by reading `docs/spec/` for the current phase and `git log --oneline -15`.
- Work in small commits with imperative messages; never leave main broken.
- If a task requires: a new dependency, a non-GET call to a source, sending real email, schema change outside a migration, or anything touching credentials — **stop and ask the owner**.
- End each session by updating the phase spec's checklist and noting open threads in `docs/spec/NN-…md` under "Next session".

## 9. Open questions (tracked; do not guess answers)

3CX v20 REST surface vs ODBC; XIQ rate limits at production device counts; rConfig edition/API availability; whether PF node data merges into `devices` or stays a linked view; SMTP relay to use; VM sizing/placement.

**Runtime-resilience goal (clarified 2026-07-13):** "offline-tolerant" means NetMon keeps working when the *network or a source is down* — degrade gracefully, mark sources `blind`, never fabricate or serve stale-as-fresh. It does **not** mean a zero-internet install: pulling packages and system libs (e.g. `xmlsec1`) at deploy time is fine, so a local package mirror is **optional**, not required. (Distinct from the §3 frontend rule that the *app bundle* ships no CDN loads — that is a reproducibility/security rule, not an offline one.)
