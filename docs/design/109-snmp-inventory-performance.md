# Handoff — `snmp_inventory` performance

**Written:** 2026-09-08, at the end of the spec-20 camera session.
**For:** the next agent picking up the SNMP inventory sweep.
**Branch:** `claude/camera-ops` (PR #26, 33 commits). Everything below is
committed and pushed; the deploy VM is running it.
**Read first:** `docs/spec/20-zcd-look-parity.md` §"S2 follow-up" — the same
class of problem, already fixed for the Milestone collector, and the reason this
document exists.

---

## 1. Why you are here

`snmp_inventory` is the largest consumer on the box by a wide margin. Measured
2026-09-08 from `collector_health`:

| Collector | Duration | Records/run |
|---|---|---|
| **`snmp_inventory`** | **418 s** | **82,212** |
| `milestone` | 94 s | 10,560 |
| `packetfence` | 55 s | — |
| `poller_ping` | 47 s | — |
| `xiq` | 21 s | — |

Nothing is currently failing because of it. It matters because it is what makes
every *other* collector slow: the Milestone collector was timing out at its
120 s supervisor boundary while doing only ~20 s of its own work, purely from
contention with this sweep. That was fixed by giving Milestone headroom
(`max(300, interval × 2.5)`) rather than by making this faster — so the debt is
still here, and the next collector to grow will hit the same wall.

An earlier reading in spec 15 §3.1 recorded "60 task failures and a 587 s sweep
duration", so long runs are chronic, not new.

---

## 2. Two corrections before you start

**2.1 The write path is already batched. Do not redo it.**

The S2 commit message and PR #26 comment suggested this sweep was "the obvious
candidate for the same batching treatment `write_states` just applied". **That
was wrong** and is corrected here. `SnmpInventory._upsert_many`
(`netmon/poller/snmp_inventory.py:837`) already does exactly the batched
replace-on-refresh pattern: one existing-keys SELECT, one executemany UPDATE,
one executemany INSERT, one prune, per device per table. Its docstring even
records that the per-row version "dominated the ports pass at fleet scale".

So the 418 s is **not** database round trips. It is SNMP walk time.

**2.2 The `2 consecutive_failures` and "run cancelled after 418s" you will see
are not a fault.**

`run_timeout_s = 900`, and the run was cancelled at 418 s — so it was
*shutdown*, not the budget. Those were the service restarts I did during the
camera work. `last_success` 12:29:51 against `last_start` 12:39:27 is the same
artefact. Confirm the counter clears on its own before chasing it.

---

## 3. How the sweep is actually structured

`netmon/poller/snmp_inventory.py`, 1,058 lines. Seven independent sweeps, each
with its own enable flag and cadence (from `SnmpInventoryConfig`):

| Sweep | Interval | Writes |
|---|---|---|
| `ports` | 120 s | `switch_ports` (19,898 rows) |
| `stack` | 300 s | `stack_members` (371) |
| `poe` | 300 s | partial UPDATE onto `switch_ports` |
| `fdb` | 900 s | `fdb_entries` (49,265) |
| `edp` | 1800 s | `neighbors` (326) |
| `vlans` | 3600 s | `switch_vlans` (1,910) |
| `entity` | 3600 s | partial UPDATE onto `switch_ports`/`stack_members` |

157 switches, all `snmp_capable`. `concurrency = 8`.

**The cost structure, which is where the opportunity is:**

```
run_once:
  for sweep in due:                       # SEQUENTIAL fleet passes
      asyncio.gather over 157 switches    # concurrency 8 within the pass
          _sweep_switch(sw, [one_sweep])
              _walk_keys(host, keys)
                  _snmpbulkwalk(host, roots)
                      for root in roots:  # SEQUENTIAL subprocesses
                          create_subprocess_exec(snmpbulkwalk …)
```

Three serialisation points stack up:

1. **Sweeps run as separate fleet passes.** When five sweeps are due on the
   same tick (which happens whenever the 3600 s ones come round), that is five
   full traversals of 157 switches, one after another.
2. **OID roots inside one walk are sequential** — `for root in roots` at
   `_snmpbulkwalk`, one `snmpbulkwalk` subprocess per root, awaited in turn.
   These are independent processes with no reason to serialise.
3. **Total in-flight work is capped at 8** regardless of how many sweeps are
   due, because each pass builds its own semaphore.

**The capability to fix #1 already exists and is unused.** `_sweep_switch(sw,
due)` takes a *list* of sweeps, and `_walk_keys` takes a list of keys and turns
them into a list of roots. `run_once` calls it with a single-element list per
fleet pass. Grouping by switch — one pass over the fleet, each switch handling
all its due sweeps — would collapse five traversals into one and let one
switch's roots be walked together.

---

## 4. Where to start, in order

**4.1 Measure before changing anything.** The per-walk timing already exists at
DEBUG:

```python
log.debug("walk %s %s: rc=%s, %d line(s), %.2fs…")   # _snmpbulkwalk
log.debug("%s %s (%s): %d row(s) in %.1fs")          # per switch per sweep
log.info("sweep %s done: %d row(s), %d/%d switch(es) failed, %.1fs")
```

Turn on DEBUG for `netmon.poller.snmp_inventory` for one full run and get the
distribution: which sweep, which OID root, which switches. The hypotheses in §3
are structural readings of the code, not measurements — **`fdb` at 49,265 rows
is the obvious suspect but has not been isolated.** A handful of slow switches
dominating the tail would call for a different fix (per-host timeout, or
excluding a known-bad device) than a uniformly slow fleet.

**4.2 Then, in rough order of expected return per risk:**

- **Group due sweeps per switch** (§3 #1). Structural, uses an interface that
  already exists, no new concurrency. Preserves the "bank completed sweeps"
  property only if you keep marking `_last_run` per sweep — read the comment at
  `run_once` about a cancelled run keeping finished sweeps' timestamps, and do
  not lose it: it is what stops a slow fleet looping on timeout.
- **Parallelise roots within `_snmpbulkwalk`** (§3 #2). Small, contained, and
  independent of the above. Bound it — a per-switch `gather` over 4–6 roots is
  reasonable; unbounded means 157 × N processes.
- **Raise `concurrency`** only after the two above, and cautiously: it is a
  config value (`[snmp_inventory] concurrency`, currently 8) so it needs no
  deploy, but the box is already the constraint. Measure the effect on the
  *other* collectors' durations, not just this one.

**4.3 What not to do**

- Do not batch the writes (§2.1).
- Do not touch `_write_poe` / `_write_entity`'s deliberate omissions — no
  INSERT, no prune, no `updated_at` bump. Their docstrings explain why: a
  PoE pass refreshing timestamps would let a stalled `ports` sweep hide behind
  them, which is the §4.5 fail-loud rule.
- Do not introduce a Python SNMP library. D6 approved subprocess `snmpbulkwalk`
  specifically; CLAUDE.md §3 forbids the dependency.

---

## 5. Environment gotchas that will cost you an hour each

- **The config file lies about `enabled`.** `[snmp_inventory] enabled = false`
  in `/etc/netmon/netmon.conf`, but the effective config is a **DB overlay over
  the file** (`netmon.settings.overlay_config`), and the overlay has it on. Any
  script that calls `load_config()` alone sees `enabled=False` and will mislead
  you. Always apply the overlay:

  ```python
  cfg = settings_engine.overlay_config(load_config("/etc/netmon/netmon.conf"), engine)
  ```

- **`python -m netmon.poller.snmp_inventory --once` writes to the live
  database** and races the supervised task in the running service. During this
  session two Milestone writers produced symmetric state flapping that looked
  like a device fault. If you need a clean measurement, either stop the service
  or accept that `device_state` sources will alternate.

- **The poller is its own systemd unit.** `systemctl restart netmon` does **not**
  reload `netmon/poller/*` for the poller unit — restart `netmon-poller.service`
  too. (`snmp_inventory` itself runs inside the `netmon` service's supervisor,
  but it lives in the `poller` package, which is the confusing part.)

- **Service startup takes ~5–20 s to bind** port 8080 after `systemctl restart
  netmon`; a curl immediately after will connection-refuse. Poll until healthy.

- **Work lands via PR, not direct pushes.** The owner reviews PR #26 on
  `jerahl/TCS-NetMon` and runs merges himself. Commit freely; ask before pushing
  unless he has said to sync.

---

## 6. What this session did (context for the code you will read)

Spec 20 (`docs/spec/20-zcd-look-parity.md`) is the plan of record: make NetMon
look like the retired Zabbix module, cameras first. Delivered S0–S5:

- **S1** — self-hosted Inter + JetBrains Mono; `PageHeader`/`Tabs`/`StatCell`/
  `Card{source,link}` primitives; Surveillance page rebuilt on them.
- **S3** — `#/cameras` as its own page with a tree navigator over Milestone's
  own camera groups (migration 026).
- **S5** — camera detail in ZCD's four-tab layout.
- **S2** — environment facts, recorder Events/State verdicts, camera
  `channel`/TLS fields (migrations 027, 028). **Four pre-existing defects fell
  out of it**, including that the camera→recorder link had been NULL for all
  2,651 cameras since Phase 10.4.
- **S4** — the camera snapshot proxy, complete and **default-off**, awaiting
  only a read-only camera account in `[camera_snapshot]`.

The relevant precedent for your work is the **S2 follow-up**: the Milestone
cycle was timing out, and the causes were per-device `write_state` calls
(10,000+ round trips → `state.write_states()`, 68 s → 20.5 s), an over-eager
blind path (three slow responses blinded 940 cameras ~11×/day), and a supervisor
boundary tied to the interval. `netmon/state.py:write_states` is the batching
pattern, if you find a genuinely unbatched write path somewhere else.

**Open owner decisions**, none blocking this work: the read-only camera account
for S4; the `channel_param` for 178 multi-imager cameras; whether
"Service Available Critical" on 11 of 22 recorders (timestamps months old) is
real; and D11's proving ground for bulk camera firmware.
