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

---

# Part 2 — the measurements, and what was done (2026-09-08, later session)

Part 1 above is the handoff. This part is the answer to it. Where Part 1
speculated, the numbers below replace the speculation; two of its three
hypotheses turned out to be secondary, and the largest finding was not a
performance problem at all.

## 7. What the fleet actually costs

Method: a read-only harness walked all 45 OID roots of all seven sweeps against
all 157 switches at `concurrency = 8`, timing each `snmpbulkwalk` and writing
**nothing** to the database — so it never raced the supervised task (§5). 7,065
walks, 487.9 s wall, **3,421 CPU-seconds** of walk time (7.0x parallel — the
pool is saturated, so wall time tracks total walk time closely).

| Sweep | Walk time | Share | Walks | Lines | s/walk |
|---|---|---|---|---|---|
| `ports` | 1,282 s | 37.5% | 2,198 | 319,630 | 0.58 |
| `poe` | 1,239 s | 36.2% | 1,570 | 67,521 | 0.79 |
| `entity` | 425 s | 12.4% | 942 | 176,754 | 0.45 |
| `fdb` | 248 s | 7.3% | 314 | 78,955 | 0.79 |
| `edp` | 92 s | 2.7% | 785 | 1,590 | 0.12 |
| `stack` | 79 s | 2.3% | 785 | 1,790 | 0.10 |
| `vlans` | 56 s | 1.6% | 471 | 5,645 | 0.12 |

**`fdb` was not the problem.** Part 1 named it "the obvious suspect" at 49,265
rows; it is 7.3% of the cost. The suspects are `poe` — 36% of all walk time for
2% of the lines — and the long tail of hosts that do not answer.

Distribution is extreme: **median switch 10.4 s, p90 41.6 s, max 311.6 s.** The
eight worst switches account for ~45% of the total.

## 8. 21% of the sweep was spent learning nothing

**718 s — 21% of all walk time — went on walks that returned zero lines**, each
costing exactly 4.0 s (`snmp_timeout_s = 2` x `snmp_retries = 1`, two roots'
worth of retry). Two switches, `Old TCT Automotive` (192.168.88.250) and
`X465-48P` (10.10.252.89), failed **45 of 45** walks and burned **361 s a pass
between them**. Both answer ICMP; neither answers SNMP.

The remaining empties are scattered and non-repeating — `poe_slot_avail` empty
on 15 switches, `poe_slot_capacity` on 14, but not the same 14 — which is the
signature of **response loss under load**, not of missing OIDs.

## 9. The defect that fell out of it

`snmpbulkwalk` exits 1 on timeout **after printing whatever it already
received**. The old `_snmpbulkwalk` ignored the exit code and returned that text
as the answer. So:

- 179 walks returned nothing and were parsed as "this table is empty";
- **16 walks returned rows and *then* timed out** and were parsed as complete.

`_upsert_many` prunes every row it did not see. A single lost UDP response
therefore **deleted a switch's FDB, VLANs, neighbours or stack members** — and a
*partial* walk deleted every port past the truncation point while stamping the
survivors with a fresh `updated_at`. Not stale: confidently wrong, and badged
healthy. `fdb_port` timed out on 11 of 157 switches in one observed pass, so
this was routine, not theoretical.

Observed live during the verification run, unedited:

```
entity OKD-MDF (10.64.0.1) failed: snmpbulkwalk exited 1 after 13.4s
    with 280 line(s): Timeout: No Response from 10.64.0.1
vlans SouthView-RM1203 (192.168.153.252) failed: exited 1 after 6.5s
    with 10 line(s)
```

Both of those row sets would previously have been written as the truth.

`_snmpbulkwalk` now raises `SnmpWalkError` on any non-zero exit. `run_once`'s
existing per-switch boundary catches it, logs the switch, and moves on — last
good rows survive with their original timestamps, which is the §4.5 contract.
The docstring that claimed "a failed sweep raised earlier, so stale rows stay
visible, never blanked" is now true; it was not before.

## 10. What was changed, and what it bought

**10.1 A walk that did not complete is not evidence** (§9). Correctness, not
speed — it makes the sweep slightly *more* likely to skip a switch, and that is
the point.

**10.2 Skip switches the poller says are not answering.** `snmp_capable` is a
registry flag meaning "this is meant to answer SNMP"; the poller's `snmp`
dimension is a live reading, and it already knew about both dead hosts. The
sweep now consults it: **361 s a pass, removed.** Deliberately narrow — only a
*fresh* (within 3 SNMP poll intervals), *uncontested* (one device on the
address, per `state.native_trustworthy`), *explicit* `down` skips. Unknown,
missing, and stale verdicts all sweep as before, because failing to monitor a
live switch is far worse than walking a dead one. Reversible via
`[snmp_inventory] skip_snmp_down`. Skipped hosts are logged at WARNING and their
rows age visibly; if every switch is down the run fails loud rather than
reporting a cheerful zero-row success.

**10.3 Fetch a small table in one walk instead of column by column.** Six of
`poe`'s ten roots are columns of one tiny table (extremePethSlotTable) fetched
in six separate round trips returning ~2 lines each.

A/B on 30 clean switches, per-column vs one table walk:

| Group | Cols | Per-column | Table walk | Verdict |
|---|---|---|---|---|
| poe_slot | 6 | 104.0 s | 27.7 s | **+73% — kept** |
| edp | 5 | 5.5 s | 1.1 s | **+80% — kept** |
| stack | 2 | 2.6 s | 2.2 s | +15% — **rejected, see below** |
| poe_port | 3 | 25.5 s | 27.3 s | −7% — rejected |
| vlans | 3 | 3.3 s | 4.3 s | −30% — rejected |
| ifTable | 8 | 42.8 s | 99.1 s | −132% — rejected |
| ifXTable | 5 | 21.7 s | 77.5 s | −257% — rejected |
| entity | 5 | 22.9 s | 86.3 s | −277% — rejected |

The intuition is wrong for five of the eight. Wide tables (entPhysicalTable,
ifTable, ifXTable) carry ~3x the lines we want, and merging them would have made
the two most expensive sweeps dramatically worse.

**`stack` is why speed alone is not enough to justify an entry.** It measured
15% *faster* and was wrong: an equivalence check across 40 live switches found
the merged walk returning **nothing** where the column walk returned a value, on
36 of them. On a non-stacked switch the EXOS agent answers
`extremeStackMemberOperStatus` as a **scalar at the column OID itself** (suffix
`''`, no table index), which a walk of the entry root never reaches. Merging it
would have quietly emptied `stack_members` for most of the fleet. It was dropped
before shipping; `_WALK_TABLES` carries the reason so nobody re-adds it.

**Effect at fleet scale**, 3 alternating old/new reps over 155 switches (medians,
because single runs on a live fleet are noise-dominated — see §11):

| Sweep | Before | After | Change |
|---|---|---|---|
| `poe` | 144.8 s | 113.3 s | **−22%** |
| `edp` | 15.0 s | 5.1 s | **−66%** |

Failures fell with it — `poe` from ~20 switches a pass to ~13 — because six
chances to time out became one, and ~1,000 more rows landed per pass as a
result. The isolated +73%/+80% did not translate fully: at fleet scale the
process pool, not the round trips, is the binding constraint.

**10.4 Make the instrumentation reachable.** §4.1 asked the next agent to "turn
on DEBUG for one full run". That was impossible on the deployed box: uvicorn
configures only its own loggers and leaves the root at WARNING, so **every INFO
line this codebase emits was being discarded** — including the per-sweep
durations §4.1 depends on. `netmon.app.configure_logging()` now gives the
`netmon` tree a level and a handler:

```
systemctl set-environment NETMON_LOG_LEVEL=DEBUG
systemctl set-environment NETMON_DEBUG_LOGGERS=netmon.snmp_inventory
```

(The logger is `netmon.snmp_inventory`, not `netmon.poller.snmp_inventory`.)

## 11. Two notes for whoever measures next

**Single runs on a live fleet are worthless.** The first before/after comparison
of a full `run_once` read 398 s → 516 s, i.e. the change looked 30% *slower*. In
the same pair `entity` doubled — a sweep the change cannot touch. It was ambient
load. Everything in §10.3 is a median of alternating runs; do the same, and be
suspicious of any result that moves a sweep you did not modify.

**Measure equivalence, not just duration.** The `stack` merge would have shipped
on its timing alone. A speed change that alters what the sweep returns is worse
than the slowness it fixes.

## 12. Still open

- **`ports` (37.5%) is untouched.** It is 14 column walks over ifTable/ifXTable
  and merging them is *much* worse (§10.3). If it needs to come down, the levers
  are dropping columns nobody reads or splitting the pass, not batching.
- **Response loss under load** (§8) is unexplained: hundreds of seconds a pass
  go on scattered, non-repeating timeouts. Whether the constraint is the box,
  the network, or the agents is unknown — raising `concurrency` before that is
  understood is as likely to hurt as help. Part 1 §4.2's advice to raise it last
  still stands, and now has a reason.
- **The two dead hosts are a real question, not just cost.** `Old TCT
  Automotive` and `X465-48P` answer ICMP and not SNMP. Wrong community,
  SNMP disabled, or an ACL — worth ten minutes with the switches, and until then
  their inventory is honestly stale rather than silently deleted.
- **Part 1 §4.2's first suggestion — grouping due sweeps per switch — was not
  done.** The measurement removed its urgency (a grouped-by-switch pass measured
  487.9 s against the per-sweep shape's comparable figure, within noise) and it
  conflicts with the "bank completed sweeps on cancellation" property that Part 1
  rightly insisted on keeping. Left alone deliberately.

## 13. Verified on the deploy VM (2026-09-08, after restart)

First run after `systemctl restart netmon netmon-poller` — the worst case, every
sweep due at once, while every other collector was also restarting:

```
sweep ports  done: 19054 row(s),  3/155 failed, 292.4s
sweep stack  done:   367 row(s),  0/155 failed,   3.8s
sweep poe    done: 14346 row(s), 14/155 failed, 166.1s
sweep fdb    done: 82450 row(s),  5/155 failed,  71.1s
sweep edp    done:   311 row(s),  2/155 failed,  17.1s
sweep vlans  done:  1886 row(s),  0/155 failed,  12.2s
sweep entity done: 19194 row(s),  4/155 failed, 136.5s
run complete: 137608 row(s) in 699.3s     consecutive_failures = 0
```

The skip fired on exactly the two intended hosts and said so:

```
WARNING skipping 2 switch(es) not answering SNMP; their inventory rows will age
without refresh: Old TCT Automotive (192.168.88.250, snmp down since …),
X465-48P (10.10.252.89, snmp down since …)
```

**The correctness fix, observed doing its job.** Switches that failed a walk kept
their previous rows and their previous timestamps, while switches that succeeded
refreshed:

| Switch | fdb rows | `updated_at` | This pass |
|---|---|---|---|
| ARC-IDF-217 | 251 | 14:15:15 | fdb walk returned 0 lines → **kept** (old code: 0) |
| Southview RM2108 | 366 | 14:14:44 | fdb truncated at 170 lines → **kept** (old code: 366→170) |
| CES-LIBRARY | 140 | 14:15:15 | fdb truncated at 90 lines → **kept** |
| ARC-MDF | 417 | 14:24:41 | succeeded → refreshed |
| CES-IDF-A | 200 | 14:24:36 | succeeded → refreshed |

**Damage that predates the fix does not self-heal.** `CES-MDF` still has **0**
FDB entries and `OKD-MDF` **10** — both core MDF switches with 180 and 240
ports. Those tables were emptied by the old behaviour and can only refill when a
walk succeeds, which for these two it repeatedly does not. That is now an honest
"stale since 14:14" rather than a confident empty table, but the underlying
question stands: **CES-MDF (10.28.0.1) and OKD-MDF (10.64.0.1) have a real SNMP
responsiveness problem** and fail walks across nearly every sweep. Worth a look
at the switches themselves — this is the FDB the Switches page's FDB⋈PF identity
pane reads, so it is currently blank for two of the district's core switches.

**`ports` at 292.4 s against a 120 s interval** is the largest thing left. It
overruns its own cadence, so the supervisor simply reschedules it back to back
under load. §12's first bullet is now the top item, not a footnote.
