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

---

# SNMP inventory sweeps (`snmp_inventory.py`)

The Phase 10.1 switching data layer. A **read-only `snmpbulkwalk`** sibling of
the poller — the §1 charter amendment (owner-approved 2026-07-15): same net-snmp
package, still GET-only, still no Python SNMP library. Spec: `docs/spec/10-design-port.md`
§4 + Appendix A (OID map, sourced from the owner's "Extreme EXOS by SNMP" Zabbix
template). Writes the `006` inventory tables read by the Switches dashboard —
**not** `device_state` (these are descriptive facts, not the severity machine).

| Sweep | Walks | Default interval | Writes |
|---|---|---|---|
| ports | IF-MIB ifTable/ifXTable + EtherLike duplex | 120s | `switch_ports` (oper/admin/speed/duplex + rates) |
| fdb | BRIDGE-MIB dot1dTpFdb ⋈ dot1dBasePortIfIndex | 900s | `fdb_entries` (MAC→ifIndex) |
| lldp | LLDP-MIB lldpRemTable | 1800s | `lldp_neighbors` |
| vlans | Extreme extremeVlanIfTable | 3600s | `switch_vlans` |
| stack | Extreme stacking + CPU/mem/temp sensors | 300s | `stack_members` |

One supervised task (registered at the fastest interval) gates each sweep
internally by its own elapsed interval. Targets: enabled `device_type='switch'`
rows with `snmp_capable=1` and a `mgmt_ip`, swept with bounded concurrency
(default 8). **Rates without history** (§1): the previous raw counters + ts live
in `switch_ports.prev_counters`; the collector computes kbps/util/err-deltas at
write time and overwrites. Counter resets → NULL (no fabricated spikes).
Replace-on-refresh: rows seen this sweep are upserted, rows not seen are pruned;
a *failed* sweep raises before pruning, so its rows stay visibly stale (§4.5),
never blanked.

## Running

```bash
python -m netmon.poller.snmp_inventory --once     # every enabled sweep once
python -m netmon.poller.snmp_inventory --loop      # forever on the base interval
```

In-process: enabled by `[snmp_inventory] enabled=true`; registered under the
supervisor as `snmp_inventory` (`collector_health` name). Per-switch failure is
isolated (logged, that switch left stale); only an all-switches-fail sweep records
a collector-level error.

## Config (`[snmp_inventory]`)

`enabled`, `snmpbulkwalk_path`, `concurrency`, and per-sweep `sweep_<name>` +
`<name>_interval_s`. SNMP credentials/version are **reused from `[poller]`**. See
`netmon.conf.example`.

## Not yet collected (columns present, left NULL)

PoE (`pethPsePort*` + Extreme measured-power — index→ifIndex mapping needs a real
PoE fixture); per-slot serial/fw (ENTITY-MIB), fans/PSUs; Q-BRIDGE per-VLAN FDB.
See spec §10.1 "Deferred".

## API

`GET /api/switches`, `/{id}`, `/{id}/ports`, `/{id}/ports/{ifindex}` (port + FDB
MACs), `/{id}/fdb`, `/{id}/lldp`, `/{id}/vlans` — read-only, viewer role, DB-only.
