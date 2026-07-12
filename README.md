# TCS NetMon — Federated Monitoring Platform

**Project plan v0.2 — July 2026 (single-language stack revision)**
**Scope:** Replace Zabbix for network, wireless, voice, and surveillance monitoring at Tuscaloosa City Schools. Servers explicitly out of scope for v1 (Zabbix remains for Nutanix, iDRAC, Linux/Windows, BIND).
**Changed from v0.1:** PHP/MariaDB web app + Python collectors replaced by a single Python + FastAPI codebase serving both the API and the collectors.

---

## 1. Concept

Every platform in scope already polls its own devices and tracks its own state. NetMon inverts the Zabbix model: **federate those sources as the bulk data layer** and keep one thin native poller for the ground truth the sources can't provide about themselves — ICMP up/down and "is SNMP responding" — plus reachability checks on the source platforms (XIQ unreachable must read as "source blind," never as "all APs fine").

| Domain | Authoritative source | What it already knows |
|---|---|---|
| Switching & wireless | ExtremeCloud IQ (Platform One) | Device up/down, port state, PoE, clients, CPU/mem, firmware, location |
| NAC / endpoints | PacketFence | Node inventory, connection state, auth events, violations/quarantine |
| Config management | rConfig | Backup status, last-change, diff history, device reachability |
| Voice | 3CX | Trunk registration, extension status, active calls, service health |
| Surveillance | Milestone XProtect | Camera state, recording state, recording-server health, VMS events |

NetMon must own in v1: unified data model, dashboards, and **alerting/notifications**. It does not own: long-term metric history (sources retain their own) or server monitoring.

## 2. Stack

**One Python package. FastAPI serves the JSON API and the built React UI; the collectors, native poller, and alert engine live in the same package and share its models, config, and DB layer.**

- **Runtime:** Python 3.12, `uvicorn` behind nginx (or systemd socket activation), on a dedicated VM.
- **Framework:** FastAPI — async-native (right shape for collectors that are 95% waiting on remote APIs), Pydantic models double as the API contract and the collector-output validation layer, and `/docs` gives a free, always-current API reference — a bus-factor asset in itself.
- **Database:** MariaDB (existing TCS infra, backups, and habits) via SQLAlchemy Core — explicit SQL-shaped queries, no ORM magic. Schema managed by plain, numbered migration scripts.
- **Dependency policy:** the stdlib-preferred rule bends here because a web framework is the project. The concession is bounded: `fastapi`, `uvicorn`, `sqlalchemy`, `httpx`, `ldap3`, `apscheduler` — pinned in a lockfile, reviewed before every bump, nothing added without a written reason in the repo. ICMP/SNMP via subprocess to `fping`/`snmpget` rather than a Python SNMP stack.
- **Auth:** AD via `ldap3`, group-mapped roles, session cookies. Read-only v1 — no write paths to any source platform.
- **Frontend:** the React assets from ZabbixCustomDashboard (`global-nav.jsx`, switches port-grid, surveillance NOC, tweaks panel) extracted from the Zabbix module shell, converted to a real esbuild pipeline (dropping Babel-standalone/unpkg per the repo's own README), output served as static files by FastAPI.

### How collectors run in a single-language stack

One codebase, two execution modes — this preserves per-collector reversibility inside a unified deployment:

1. **In-process (default).** The FastAPI lifespan starts one supervised asyncio task per enabled collector. Each runs on its own interval, wrapped in a timeout and exception boundary; a hung XIQ call cancels and reschedules, it cannot stall the event loop or the UI. Enable/disable per collector is a config flag + reload — no code change, instantly reversible.
2. **Standalone (escape hatch).** Every collector is also runnable as `python -m netmon.collectors.xiq --once` (or looped under its own systemd unit). Same code, same models, same DB. If a collector ever proves too heavy or unstable to cohabit — the Milestone WebSocket daemon is the likely candidate — it moves out to its own unit without a rewrite.

**The case against this stack:** the v0.1 hybrid kept the web layer in PHP/MariaDB patterns already proven in TCS production; here the web/auth/session layer is new construction in a framework used less at TCS, and a crash-loop in the shared process takes dashboards *and* collection down together (mitigated by the standalone mode and systemd restart policy, not eliminated). What's bought in exchange: one language, one repo, one deploy artifact, shared Pydantic models end-to-end, and a codebase far easier to hand to a successor or to Claude Code sessions.

## 3. Architecture

```
┌─ Source platforms ─────────────────────────────────────────┐
│  XIQ API   PacketFence API   rConfig   3CX   Milestone API │
└──────┬──────────┬──────────────┬────────┬─────────┬────────┘
       ▼          ▼              ▼        ▼         ▼
┌─ netmon (one Python package, FastAPI app) ─────────────────┐
│  collectors/ xiq · pf · rconfig · threecx · milestone      │
│              (supervised asyncio tasks; each also runnable │
│               standalone via python -m / systemd)          │
│  poller/     fping sweep · snmp-alive GET · hysteresis     │
│  engine/     alert rules → dedupe → maintenance → notify   │
│  api/        JSON endpoints (Pydantic-typed)               │
│  web/        static React build (esbuild)                  │
│  auth/       AD via ldap3, role mapping                    │
└──────────────────────────┬─────────────────────────────────┘
                           ▼
                 MariaDB: devices · device_state ·
                 state_events · alert_rules · alerts ·
                 notifications · maintenance_windows ·
                 collector_health
```

### Data model (unchanged from v0.1)

- `devices` — unified registry; one row per monitored thing with per-source foreign keys (`xiq_device_id`, `pf_node_mac`, `milestone_hardware_id`, `rconfig_device_id`). The reconciliation table is the heart of the app.
- `device_state` — current state only, one row per device per dimension (`ping`, `snmp`, `source_status`, `config_backup`, `recording`, `trunk`); small and hot.
- `state_events` — append-only transition log; this *is* v1 history. Availability timelines and event lists come from here, not metric time-series.
- `alert_rules`, `alerts`, `notifications`, `maintenance_windows` — §5.
- `collector_health` — heartbeat per collector (last run, duration, records, error). A stale collector raises its own alert; a blind source must never look healthy.

### Native poller

`fping` sweep of all registered management IPs every 60s (async subprocess, one sweep — not per-device processes); SNMP `sysUpTime` GET every 5 min for SNMP-capable devices. Hysteresis before a transition records (3 consecutive failures → DOWN). The poller is also the tiebreaker: XIQ says down + ping says up = "source disagreement," a distinct surfaced state.

## 4. Source integrations

Shared collector contract, expressed once as a base class: read-only; credentials from a root-only config outside the app tree; `httpx.AsyncClient` with timeouts and backoff; Pydantic-validated payloads; upserts to `devices`/`device_state`; transitions to `state_events`; heartbeat to `collector_health`. Implementation order by dashboard value:

**XIQ (Platform One)** — first, biggest surface. Bearer-token REST; device list/status and port state on a 2–5 min cycle, inventory/detail slower, respecting rate limits measured in Phase 0. Replaces the `apdetail`/`xiq_ap_status` data paths.

**PacketFence** — `/api/v1/nodes` and reports endpoints (patterns already in the repo README). PF queries are slow — cache hard, poll in minutes, never in a request path.

**Milestone XProtect** — the two-API design already worked out: Gateway Config API for inventory, Events/State WebSocket for live state. The one genuinely long-lived connection in the system; it gets reconnect/backoff and a watchdog, and is the first candidate for the standalone execution mode if it misbehaves in-process. Finally wires the mock Surveillance NOC pages.

**3CX** — thinnest official API surface. Reuse the ODBC-based approach from the Zabbix template work (trunk/extension/call state from the 3CX DB) unless Phase 0 shows v20's REST API covers it.

**rConfig** — last; enrichment (backup freshness, last change), API if the edition exposes one, else read-only DB queries.

## 5. Alert engine (the hard part)

- **Rules are rows, not code:** state dimension + condition + severity + minimum-duration + notification target. Seed small: device down, source blind, config backup stale >7d, camera not recording, trunk unregistered, collector stale.
- **Dedup and flap damping:** one open alert per (device, rule); re-fires update it. Hysteresis at the poller plus a duration gate at the engine.
- **Maintenance windows and ack from day one** — without them, notification fatigue kills trust in week two.
- **SMTP only for v1.** Channels are a later abstraction, not an up-front framework.
- **Shadow mode before cutover:** the engine logs would-be notifications for 2–4 weeks alongside live Zabbix; weekly diff of misses in both directions. Cutover requires evidence, not confidence.

The engine runs as one more supervised task on a short interval, evaluating rules against `device_state` — same execution model as the collectors, same escape hatch.

## 6. Phases

Sized for 6–10 hrs/week; each phase ends demonstrably working and independently reversible.

| Phase | Deliverable | Est. |
|---|---|---|
| **0 — Spec & recon** | Finalized spec; API access verified for all five sources (tokens, rate limits, 3CX v20 surface); device counts per source; naming/site reconciliation rules | 2–3 wks |
| **1 — Foundation** | Repo/package layout, migration scripts, config+secrets layout, FastAPI skeleton with AD auth and `/docs`, task-supervisor scaffold, `devices` seeded from one-shot XIQ + PF import | 3 wks |
| **2 — Native poller** | fping/SNMP poller live against full registry; `device_state`/`state_events` populating; first raw status endpoint + page | 2 wks |
| **3 — Collector: XIQ** | Switching + wireless federated; source-blind detection; collector-health pattern established; base-class contract proven | 3 wks |
| **4 — UI port** | React assets extracted, esbuild pipeline, Global + Switches + AP pages on NetMon endpoints served by FastAPI | 3–4 wks |
| **5 — Collectors: PF, Milestone** | NAC + Surveillance NOC on live data; Milestone WebSocket task with watchdog (standalone-mode fallback tested) | 4 wks |
| **6 — Alert engine, shadow mode** | Rules, dedup, maintenance, ack, SMTP; shadow log running parallel to Zabbix | 3 wks |
| **7 — Collectors: 3CX, rConfig** | Voice status + config-backup enrichment | 2–3 wks |
| **8 — Parallel run & cutover** | 4-week shadow comparison, gap fixes, then disable Zabbix network/wireless/voice/camera hosts (configs exported for rollback); Zabbix slims to servers only | 4+ wks |
| **9 — Site-status map** *(enhancement)* | Geographic NOC wall view (Leaflet): sites as up/degraded/down dots rolled up from `device_state`, animated inter-site fiber links by live utilization, event feed, fullscreen NOC mode. New per-site lat/lon + fiber-link registry (via migration); current-state only. Design in `docs/design/netmon-map/`, spec in `docs/spec/09-site-map.md`. Depends on Phases 3–4; can be pulled forward | 2–3 wks |

Roughly 6–8 calendar months. Phase 1 gains ~a week versus v0.1 (new web/auth construction); Phases 3–7 each shave a little (one language, shared base class, shared models). Net schedule is a wash — the single-stack payoff is maintenance and hand-off, not delivery speed.

## 7. Risks — stated plainly

- **Rebuilding Zabbix's most battle-tested part (alerting) solo.** Mitigation: shadow mode with hard evidence gates and a ruthlessly small v1 rule set. If shadow mode shows persistent misses, the honest fallback is NetMon-as-dashboard with Zabbix retained for alerting — the architecture permits that retreat.
- **Shared-process coupling.** A crash loop takes UI and collection down together. Mitigations: per-task exception boundaries and timeouts, systemd restart policy, and the standalone execution mode as a pressure valve — but this is the price of the single stack and it's named as such.
- **New-construction web layer.** Auth, sessions, and deployment hardening in FastAPI are net-new at TCS, unlike the PHP patterns they replace. Front-load them in Phase 1 and keep them boring (session cookies, nginx TLS, no cleverness).
- **Federated means dependent.** XIQ cloud down = wireless blind. The native ping layer and source-blind alerting reduce, not remove, this; accepted trade for not re-polling 2,600+ devices.
- **API churn.** XIQ and Milestone evolve; Pydantic validation makes payload drift fail loud into `collector_health` rather than silently serving stale state.
- **Two monitoring systems run indefinitely** until a v2 covers servers — Zabbix upgrades and housekeeping remain a real, shrunken cost.
- **Bus factor.** Spec-first docs, README per collector, runbooks written during — not after — each phase; `/docs` keeps the API self-describing.

## 8. Open items to settle in Phase 0

3CX v20 API surface vs. ODBC access; XIQ API rate limits at TCS device counts; rConfig edition/API availability; whether PF node data belongs in NetMon's registry or stays a linked page; SMTP relay for notifications; VM sizing/placement for the FastAPI host; Python version and package-mirror strategy for an offline-tolerant deploy.
