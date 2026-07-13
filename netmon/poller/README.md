# Native poller

Ground-truth reachability for every registered management IP: ICMP up/down and
"is SNMP responding". Read-only, subprocess-based (`fping` / `snmpget`) — no
Python SNMP/ICMP library (CLAUDE.md §3). Spec: `docs/spec/02-poller.md`.

## What it does

| Task | Binary | Default interval | Writes |
|---|---|---|---|
| `poller_ping` | `fping` (one sweep, all IPs on stdin) | 60s | `device_state`/`state_events` dim `ping` |
| `poller_snmp` | `snmpget` sysUpTime.0, bounded concurrency | 300s | dim `snmp` |

Values `up`/`down`; severity ping-down→`crit`, snmp-down→`warn`. `source =
poller`. Hysteresis damps flaps: `fail_threshold` consecutive failures → down,
`ok_threshold` successes → up (first observation of an `unknown` device settles
immediately). Every sweep refreshes `device_state.updated_at` (liveness); only a
settled-value change appends a `state_events` row.

## Running

In-process (default): enabled by `[poller] enabled=true`; the FastAPI lifespan
registers both tasks under the supervisor (interval + timeout + exception
boundary). A failing sweep is caught, recorded to `collector_health`
(`poller_ping`/`poller_snmp`), logged loud, and rescheduled — prior state is
left intact, never fabricated.

Standalone (escape hatch):

```bash
python -m netmon.poller --once              # one ping + snmp sweep, exit
python -m netmon.poller --loop --ping        # ping only, forever on its interval
python -m netmon.poller --once --snmp        # one snmp sweep
```

## Config (`[poller]`)

`enabled`, `ping_interval_s`, `snmp_interval_s`, `fail_threshold`,
`ok_threshold`, `fping_path`, `fping_timeout_ms`, `fping_retries`,
`snmpget_path`, `snmp_version`, `snmp_community` (**secret**), `snmp_timeout_s`,
`snmp_retries`, `snmp_concurrency`. See `netmon.conf.example`.

## Prerequisites

`fping` and `snmpget` on PATH (`scripts/deploy.sh` installs `fping` +
`snmp`/`net-snmp-utils`). A missing binary: standalone prints a clean error and
exits non-zero; in-process it is recorded to `collector_health` and the app
keeps serving.

## Failure modes

- **Probe binary missing** → loud error / health row; app unaffected.
- **SNMP community unset** → SNMP sweep skips with a warning (no false downs).
- **A target not reported by fping** → left at prior state that sweep (not
  fabricated).
- **DB unreachable** → sweep errors into `collector_health`; state goes stale
  with visible timestamps (never stale-as-fresh).

## Status surfaces

- `GET /api/status` — JSON per-device ping/snmp state (viewer role).
- `GET /status` — minimal server-rendered HTML table (viewer role; the React UI
  is Phase 4).
