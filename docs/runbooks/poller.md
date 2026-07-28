# Runbook — Native poller (fping ICMP + snmpget sysUpTime)

Spec: `docs/spec/02-poller.md`. Code: `netmon/poller/`. Component README:
`netmon/poller/README.md`. Units: `netmon.service` (web) and
`netmon-poller.service` (sweeps).

The poller is the ground truth the source platforms cannot give about
themselves — the tiebreaker when XIQ/PF/Milestone disagree with reality, and the
canary when a source is unreachable. If it is blind, the site roll-up is leaning
on nothing. Everything below was established and verified on the deploy VM
**2026-07-28**.

## How it works (30 seconds)

| Task | Binary | Default interval | Writes |
|---|---|---|---|
| `poller_ping` | one `fping` sweep, all IPs on stdin | 60s | `device_state`/`state_events` dim `ping` |
| `poller_snmp` | `snmpget` sysUpTime.0, bounded concurrency | 300s | dim `snmp` |

Values `up`/`down`; ping-down → `crit`, snmp-down → `warn`; `source = poller`.
Hysteresis damps flaps (`fail_threshold` failures → down, `ok_threshold`
successes → up; the first observation of an `unknown` device settles at once).
Every sweep refreshes `device_state.updated_at`; only a settled-value change
appends a `state_events` row. Each sweep heartbeats into `collector_health`
under its task name.

## 1. The two-unit split — and why you must not "simplify" it

`fping` needs a **raw ICMP socket**. `netmon.service` deliberately holds **no
capabilities at all**:

```ini
NoNewPrivileges=yes
CapabilityBoundingSet=          # empty
```

`NoNewPrivileges=yes` **voids file capabilities**, so fping's `cap_net_raw=ep`
on the binary is inert inside that unit, and the empty bounding set forecloses
it anyway. The sweep can never work there — not "works if you install fping
right", *never*.

`netmon-poller.service` runs `ExecStart=… python -m netmon.poller --loop` with
the same hardening **plus**:

```ini
CapabilityBoundingSet=CAP_NET_RAW
AmbientCapabilities=CAP_NET_RAW
```

**Ambient** capabilities are granted by systemd *before* exec, so they survive
`NoNewPrivileges=yes` — only *file* capabilities are voided by it. That is the
whole reason the split exists, and why the poller unit keeps every other
sandbox directive.

> **Do not "fix" a broken poller by adding capabilities to `netmon.service`.**
> The web process handles authenticated HTTP from the whole district; it stays
> capability-free. Both units are written by `scripts/deploy.sh`
> (`install_systemd` / `install_systemd_poller`) and re-asserted on every
> `install`, `update`, and `secure` — a hand-edit to `netmon.service` will be
> silently reverted on the next deploy, which is the desired outcome.

## 2. `enabled` vs `in_process`

Two different questions, two different knobs in `[poller]`:

| Setting | Question it answers |
|---|---|
| `enabled` | **Does the poller run at all?** Governs `/api/health` honesty and the poller row on the NetMon Status page. |
| `in_process` | **Where do the sweeps run?** `true` (default) = in-app supervised tasks. `false` = `netmon-poller.service` owns them. |

The deploy VM runs `enabled = true`, `in_process = false`. With
`in_process = false` the app's supervisor skips registering `poller_ping` /
`poller_snmp` (`netmon/app.py`) and logs
`poller enabled but in_process=false — sweeps run in netmon-poller.service`.
That skip is load-bearing: two pollers would **double-write `device_state` with
two independent hysteresis trackers**, each fighting the other's settled value.

`enabled` stays `true` in that configuration on purpose — it is what makes
`/api/health` report the poller as on rather than lying about a fleet that is in
fact being swept.

**`in_process` is file-only and deliberately absent from the settings registry**
(spec 12 S2; asserted by `tests/test_config.py::test_poller_in_process_is_not_web_editable`).
Flipping deployment topology from a web form could stop all polling with no unit
standing by to take over. Change it in `/etc/netmon/netmon.conf` and restart.

## 3. The `ping_group_range` trap — read this before you reach for a sysctl

Setting `net.ipv4.ping_group_range` to the `netmon` gid lets fping open a
**datagram** ICMP socket with no capability at all. It looks like the clean,
capability-free fix. **It is not a fix — it fabricates an outage.**

On a `SOCK_DGRAM` ICMP socket the kernel rewrites the echo ID, so fping no
longer matches replies to its requests and reports **every target
`unreachable`**. That is worse than no data: it is a confident, fleet-wide false
outage written straight into `device_state` and `state_events`, with alerts
behind it.

Verified 2026-07-28: with `ping_group_range = 996 996` under the service
sandbox, `fping 127.0.0.1` returned `127.0.0.1 is unreachable`. Debian's default
is `1 0` — a deliberately empty range, i.e. disabled.

**Use `CAP_NET_RAW` (ambient). Never the sysctl.**

## 4. Reproducing a sandbox failure honestly

**`runuser -u netmon fping …` proves nothing.** Outside systemd's sandbox the
file capability applies, so it succeeds while the service fails — the bug looks
fixed when it isn't. Reproduce inside an equivalent sandbox with `systemd-run`,
mirroring the unit's exact directives:

```bash
# Does fping work under the WEB unit's sandbox? (Expected answer: no.)
systemd-run --quiet --pipe --wait -p User=netmon -p Group=netmon \
  -p NoNewPrivileges=yes -p CapabilityBoundingSet= \
  -p RestrictAddressFamilies="AF_INET AF_INET6 AF_UNIX" \
  -p SystemCallFilter=@system-service -p PrivateDevices=yes \
  -p ProtectSystem=strict /usr/bin/fping -r 1 -t 500 127.0.0.1
```

Failure signature:

```
fping: can't create socket (must run as root?)
```

Re-run the same command with `-p CapabilityBoundingSet=CAP_NET_RAW
-p AmbientCapabilities=CAP_NET_RAW` added to confirm the poller unit's grant is
what makes the difference. Anything you change in a unit, verify this way.

## 5. `SweepBlindError` — why a silent sweep is now a failure

`netmon/poller/poller.py` raises `SweepBlindError` when a **non-empty** target
list yields **zero verdicts**. Zero verdicts means the probe never ran: a missing
capability, a blocked or absent binary, a misbuilt command line.

The distinction that makes this safe to enforce:

- **Every target down** still produces verdicts (`<ip> is unreachable` per
  target) → the sweep succeeds and writes real `down` state. Not affected.
- **No verdicts at all** → the probe is blind → error into `collector_health`,
  prior `device_state` left visibly stale, never overwritten (CLAUDE.md §4.5).
- **No targets** (empty registry, nothing `snmp_capable`) is legitimate and does
  not raise.

The historical failure it exists to prevent: from **2026-07-16 to 2026-07-28**,
`poller_ping` recorded **SUCCESS with 0 records in ~8 ms**, every 60 seconds,
while never once working — fping was exiting instantly with `can't create
socket` inside `netmon.service`'s sandbox. Eleven days with zero `ping` rows in
`device_state` and a green health row over it. A blind source must never render
as healthy.

## 6. Reading the *effective* config

**The conf file is not the source of truth.** Effective config is
**DB override (`app_settings`) → conf file → code default** (`netmon/settings.py`,
spec 12). On this VM the file reads `[poller] enabled = false` while the DB
overlay has it **true**, and `poller.snmp_community` is **set in the overlay
while commented out in the file**. Read the file alone and you will conclude the
poller is off while it is polling production.

```bash
cd /usr/share/TCS-NetMon && .venv/bin/python -c "
from netmon import config as C, db as D, settings as S
cfg = C.load_config('/etc/netmon/netmon.conf')
eng = D.make_engine(cfg.db.url)
print(S.overlay_config(cfg, eng).poller)"
```

Use `settings.overlay_config` — **not** `apply_overrides`, which skips
`resolve_overrides`/`parse` and hands back raw strings, so a bool comes back as
the string `"false"`, which is **truthy**. That mistake reads as "enabled" for a
disabled component.

`in_process` (§2) has no override path, so for that one field the file *is*
authoritative.

## 7. Operating it

```bash
systemctl status netmon-poller
journalctl -u netmon-poller -f
systemctl restart netmon-poller          # after a [poller] conf change
```

Standalone escape hatch — same code, models, and DB, and it picks up the DB
overlay too:

```bash
python -m netmon.poller --once             # one ping + snmp sweep, exit
python -m netmon.poller --once --ping      # ping only
python -m netmon.poller --once --snmp      # snmp only
python -m netmon.poller --loop             # what the unit runs
```

Run `--once` as `netmon` with `NETMON_CONF` set. Note it will fail the same way
the service does *only if* you reproduce the sandbox (§4) — a root shell has raw
sockets.

**What healthy looks like.** `collector_health` rows `poller_ping` and
`poller_snmp` with `consecutive_failures = 0`, a recent `last_success`, and
`records_written > 0`:

```sql
SELECT name, last_success, duration_ms, records_written, consecutive_failures,
       LEFT(COALESCE(last_error,''), 120) AS err
FROM collector_health WHERE name LIKE 'poller%';
```

```sql
SELECT dimension, value, COUNT(*) FROM device_state
WHERE dimension IN ('ping','snmp') GROUP BY dimension, value;
```

Verified-good numbers, 2026-07-28: **965 ping rows** (931 `up` / 34 `down`) and
**160 snmp rows**. Only **160 of 3626 devices** are `snmp_capable`, which is why
ICMP is the broad signal and SNMP-alive is a narrow secondary one — a small snmp
row count is normal, a small *ping* row count is not.

Ping targets are enabled devices with a non-empty `mgmt_ip`; SNMP targets are
that set further filtered to `snmp_capable = 1`.

Also visible on the **NetMon Status** page (`#/netmon-status`) and `/api/health`, which
reports `poller_enabled` from effective config plus the `collector_health` rows.

## 8. Troubleshooting

| Symptom | Likely cause | Check |
|---|---|---|
| `poller_ping` error `SweepBlindError: … returned 0 verdicts` | fping has no raw socket (sandbox stripped CAP_NET_RAW), or wrong `fping_path` | §4 `systemd-run` repro; `systemctl show netmon-poller -p AmbientCapabilities` |
| `poller_ping` success, 0 records, ~8 ms, no error | Pre-`SweepBlindError` code, or genuinely zero targets | Confirm the deployed tree has `SweepBlindError`; `SELECT COUNT(*) FROM devices WHERE enabled=1 AND mgmt_ip<>''` |
| **Every** device suddenly `down` | `ping_group_range` set → SOCK_DGRAM echo-ID rewrite (§3); or a real upstream/firewall event | `sysctl net.ipv4.ping_group_range` (must be `1 0`); spot-check one target by hand |
| No `ping` rows at all, no health row | `netmon-poller` not running, or `enabled=false` in the **overlay** | `systemctl is-active netmon-poller`; §6 effective-config snippet |
| `ping` rows written twice / hysteresis oscillates | Both the app and the unit are sweeping | `[poller] in_process` must be `false` when `netmon-poller` is enabled (§2) |
| `poller: [poller] snmp_community is unset; skipping SNMP sweep` | Community absent from both file and overlay | §6 snippet (do not paste the community anywhere); Settings page can set it write-only |
| All SNMP `down`, ICMP `up` | Community wrong, or UDP/161 replies blocked | `SNMP_SOURCE_CIDR` firewall rule — see `docs/runbooks/deploy.md`; wrong community and unreachable host look identical |
| `required probe binary not found` | `fping` / `snmpget` missing | `scripts/deploy.sh install` installs `fping` + `snmp` |
| State goes stale with visible timestamps, health row errors | DB unreachable | `/healthz` `db_ok`; prior state is intentionally left, never fabricated |
| Poller row on NetMon Status looks fine but a device's state is old | That device got no verdict this sweep | `_apply` skips unreported targets rather than inventing state; check `device_state.updated_at` |

## 9. Reversibility (CLAUDE.md §4.3)

```bash
sudo systemctl disable --now netmon-poller     # stop sweeping; app unaffected
```

Prior `device_state` stays put and ages visibly by `updated_at` — nothing is
blanked or fabricated. To also make `/api/health` report the poller as off, set
`[poller] enabled = false` (and clear any DB override for `poller.enabled` — see
`docs/runbooks/settings.md`).

To restore in-app sweeps instead of the unit: `[poller] in_process = true`,
disable `netmon-poller`, restart `netmon` — and accept that ICMP will be blind
under the web unit's sandbox (§1), which `SweepBlindError` will now say out
loud.

A config backup taken before the 2026-07-28 poller change is at
**`/etc/netmon/netmon.conf.bak-20260728-poller`**.

## See also

- `docs/runbooks/deploy.md` — unit installation, SNMP firewall rules
- `docs/runbooks/settings.md` — the DB overlay, what is deliberately not
  web-editable
- `netmon/poller/README.md` — task table, config reference, and the
  `snmp_inventory` sweeps that reuse `[poller]` SNMP credentials
