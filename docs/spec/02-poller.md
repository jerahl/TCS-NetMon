# Spec 02 — Native poller (Phase 2)

**Goal:** the one thin native poller that gives ground truth the source
platforms can't give about themselves — ICMP up/down and "is SNMP responding"
— for every registered management IP. It is the tiebreaker when a source
disagrees with reality and the canary when a source platform is unreachable.

Read-only, subprocess-based (no Python SNMP stack): ICMP via `fping`, SNMP via
`snmpget` (CLAUDE.md §3). Runs as supervised asyncio tasks **and** standalone.

## Behaviour

- **Ping sweep** (default 60s): one `fping` invocation over all enabled devices
  with a `mgmt_ip` — a single sweep, not one process per device. Targets fed on
  stdin so there is no command-line length limit.
- **SNMP-alive** (default 300s): `snmpget` of `sysUpTime.0`
  (`1.3.6.1.2.1.1.3.0`) for enabled + `snmp_capable` devices, bounded
  concurrency. Success = a value returned; the value itself is not stored.
- **Hysteresis** (thresholds in config): a settled state flips to **down** only
  after `fail_threshold` consecutive failures (default 3) and back to **up**
  after `ok_threshold` consecutive successes (default 2). This damps flapping.
  The **first** observation of a previously-`unknown` device settles
  immediately (no wait) so a fresh registry converges fast.
- **Writes:** every sweep upserts the settled value into `device_state`
  (refreshing `updated_at` so the state reads as fresh — liveness). A change of
  the settled value appends one row to `state_events` (append-only). Transient
  failures inside the hysteresis window are damped and never recorded as events.
- **Heartbeat:** each sweep records `collector_health` (`poller_ping` /
  `poller_snmp`): last_start/last_success/last_error/duration/records/
  consecutive_failures. A crash in one sweep is caught, logged loud, and
  rescheduled; prior `device_state` is left intact (never fabricated).

### Dimensions, values, severity

| dimension | value | severity |
|---|---|---|
| `ping` | `up` / `down` | up→`ok`, down→`crit` (unreachable is critical) |
| `snmp` | `up` / `down` | up→`ok`, down→`warn` (agent issue ≠ device down) |

`source` = `poller` on both `device_state` and `state_events`.

## Execution model

- In-process: two supervised tasks (`poller_ping`, `poller_snmp`) registered in
  the FastAPI lifespan when `[poller] enabled=true`, each wrapped in the
  supervisor's interval + timeout + exception boundary.
- Standalone: `python -m netmon.poller --once|--loop [--ping|--snmp|--both]`
  (same code/models/DB), the documented escape hatch.
- Per-step reversibility: `[poller] enabled=false` disables both tasks; the app
  and other tasks are unaffected.

## Config (`[poller]`)

`enabled`, `ping_interval_s` (60), `snmp_interval_s` (300),
`fail_threshold` (3), `ok_threshold` (2), `fping_path` (`fping`),
`fping_timeout_ms` (500), `fping_retries` (1), `snmpget_path` (`snmpget`),
`snmp_version` (`2c`), `snmp_community` (**secret**, config file only),
`snmp_timeout_s` (2), `snmp_retries` (1), `snmp_concurrency` (20).

## Portability note

`device_state` / `collector_health` writes go through a portable
`SELECT`-then-`UPDATE`/`INSERT` upsert (`db.upsert`) rather than MariaDB's
`ON DUPLICATE KEY UPDATE`, so the same code runs under the SQLite used by the
test suite. `updated_at` is passed as an explicit UTC timestamp (not SQL
`CURRENT_TIMESTAMP`) so behaviour is identical on both engines and testable.

## API

- `GET /api/status` — per-device current state (devices ⟕ device_state for
  `ping`+`snmp`), viewer role. Pydantic `DeviceStatus`.
- `GET /status` — minimal **server-rendered** HTML table of the same data (no
  JS, no CDN — the React UI is Phase 4). Viewer role.

## Definition of Done

- [x] Single-`fping`-sweep design implemented (targets on stdin, no arg limit).
      Full-registry timing verified on the VM at deploy (needs `fping` + real
      registry; not reproducible in the test sandbox).
- [x] Transitions appear in `state_events`; `device_state` stays fresh
      (`updated_at` refreshed each sweep). Verified by test.
- [x] "Kill-a-lab-device" DOWN→UP cycle verified by automated test with an
      injected prober (`tests/test_poller.py`); manual check on a real device
      at deploy.
- [x] `/api/status` + `/status` render live poller state (test + boot smoke).
- [x] `pytest` green (hysteresis, fping parse, write cycle, status API).
- [x] `netmon/poller/README.md` written (endpoints, intervals, failure modes).

## Next session

- Phase 3 (XIQ collector): finalize `collectors/base.py` against the poller's
  proven heartbeat/error-boundary pattern; add source-disagreement surfacing
  (XIQ says down + poller ping says up).
- Consider batching `device_state` writes if per-sweep round-trips become hot
  at full device count.
