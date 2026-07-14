# Spec 03 — Collector: ExtremeCloud IQ (Phase 3)

**Goal:** the first real source collector, and the one that proves the
`collectors/base.py` contract. Federate XIQ's view of switching + wireless
devices into `device_state` as the `source_status` dimension, and detect when
XIQ itself is unreachable — a **blind** source that must never render as
healthy (CLAUDE.md §6 invariant).

Read-only (GET only; CLAUDE.md §4.1). Ported from the working Zabbix add-on
clients in `reference/lib/XIQFleetClient.php` / `XIQClient.php` — the
authoritative record of what works against live XIQ.

## Scope (what is stored vs. live-read)

NetMon stores *state*, not metrics (§2: no long-term metric time-series). So:

- **Stored (this phase):** per-device `source_status` (`up` / `down` / `blind`)
  in `device_state`, transitions in `state_events`. Optional backfill of
  `devices.mgmt_ip` from XIQ `ip_address` when the registry value is empty.
- **Live-read later (Phase 4 UI, not stored):** firmware, model, PoE, port
  state, client counts, CPU/mem — the `devices` table has no columns for these
  and they are metric-class data the source retains. The UI fetches them on
  demand; the collector does not persist them.

## Data mapping

`GET /devices?views=BASIC` (paged) → per fleet row:

| XIQ field | use |
|---|---|
| `id` | match to `devices.xiq_device_id` |
| `connected` (bool) | → `source_status`: `up` (ok) / `down` (crit) |
| `ip_address` | backfill `devices.mgmt_ip` if empty |
| `hostname`, `product_type`, `software_version`, `mac_address` | validated into the `XiqDevice` model; live-read surface, not stored |

Severity: `up`→`ok`, `down`→`crit`, `blind`→`warn` (blind is *not-ok* and
distinct from down — we don't know, we're not claiming down). `source = xiq`.

## Blind detection (the important part)

The fleet fetch is classified:

- **Success** → write each matched device's `source_status` from `connected`.
- **Auth failure (401 / token revoked), transport error, or 5xx** → the source
  is unreachable: mark **every** registry device with an `xiq_device_id`
  `source_status = blind`, then record the failure in `collector_health` and
  re-raise (loud). Prior `up`/`down` values are replaced by `blind` — never
  left as stale-looking fresh data.
- **Rate limited (429)** → XIQ is reachable but throttling us; this is **not**
  blind. Leave prior state untouched, record a health error, back off. Marking
  blind here would falsely degrade healthy devices.

`RateLimit-Remaining` / `RateLimit-Reset` headers are tracked every call and
surfaced in logs (quota is 7,500/hr per VIQ, shared across integrations —
Phase 0 finding).

## base.py contract (finalized here)

`Collector` (ABC): `run_once() -> int` (records written); `run_guarded()`
wraps it with the portable `collector_health` heartbeat + error boundary
(`netmon.health`, same as the poller); `as_task()` for the supervisor;
`run_standalone(build)` for `python -m netmon.collectors.xiq --once|--loop`.
State writes go through `netmon.state.write_state` (upsert + change→event),
shared with future collectors.

## Seeded alert rule

Migration `002_seed_alert_rules.sql` seeds a built-in **source-blind** rule
(dimension `source_status`, condition `{"op":"eq","value":"blind"}`, severity
`warn`) and a **device-source-down** rule. They sit inert until the Phase 6
engine consumes them. Rollback note deletes them.

## Config

Reads `[xiq]`: `enabled`, `api_token` (**secret**), `base_url`. Registered as a
supervised task in the app lifespan when `enabled`; also standalone. Fast cycle
only in v1 (device status); the slow inventory cycle is deferred because there
is nothing metric-class to persist under §6.

## Definition of Done

- [ ] Switching + wireless `source_status` live in `device_state` from a real
      fleet fetch (verified against fixtures here; live at deploy).
- [ ] XIQ token-revocation (401) test: loud failure + all XIQ devices go
      `blind`, no stale-as-fresh data.
- [ ] Rate-limit (429) test: state left intact, health error recorded.
- [ ] Fixture parse tests green; `base.py` contract exercised.
- [ ] `netmon/collectors/README.md` (endpoints, intervals, rate limits,
      failure modes).

## Next session

- Phase 4 UI port (Global/Switches/AP) consumes `/api/status` +
  `/api/devices`; live-reads XIQ detail (ports/PoE/clients) via new passthrough
  endpoints that reuse `XiqClient`.
- Source-disagreement surfacing: XIQ `source_status=down` while poller
  `ping=up` → a distinct rendered state (tiebreaker) — design with Phase 4.
