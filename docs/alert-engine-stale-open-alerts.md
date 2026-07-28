# Diagnosis: 55 open alerts with the alert engine enabled

**Date:** 2026-07-28
**Investigator:** Claude Code session (task #5)
**Scope:** read-only diagnosis. No row in `alerts`, `notifications`, `device_state`, or anything
else was created, updated, or deleted. No file under `netmon/engine/` was edited.

---

## 1. One-sentence root cause

The engine is closing alerts correctly and shadow mode is **not** implicated — all 55 open alerts
belong to the single rule `device_source_down`, whose condition genuinely still holds because the
rule reads the raw `device_state.source_status` dimension in isolation and therefore never applies
the native-probe tiebreaker (`netmon/state.py` `device_down`) that the UI and site roll-up use, so
switches that answer `snmpget` render **up** on the map while a `crit` alert stays open, and
long-decommissioned XIQ-registered kit accumulates permanent `crit` alerts with no ageing path.

---

## 2. The prior theory is refuted

The carried-over theory was *"`[engine] enabled = false` means open alerts are never closed."*
Both halves are wrong as of today.

**Verified — the engine is enabled and running.** Effective config via
`settings.overlay_config` (DB `app_settings` overlay over `/etc/netmon/netmon.conf`):

```
EngineConfig(enabled=True, interval_s=30, shadow=True, smtp_host='', smtp_port=25,
             smtp_from='', default_target='')
```

`collector_health` row `engine`: `last_success = 2026-07-28 20:13:10`, `last_error = NULL`,
`consecutive_failures = 0`. It ran seconds before this query.

**Verified — closing is NOT gated on `shadow`.** `_close_resolved` is called unconditionally at
the end of every rule's pass and contains no shadow check:

- `netmon/engine/engine.py:135` — `self._close_resolved(rule["id"], matched, now)`
- `netmon/engine/engine.py:138-146` — the body: plain
  `UPDATE alerts SET closed_at = :now WHERE id = :id` for every open alert whose `device_id` is not
  in this cycle's `matched` set.

`shadow` is read in exactly one place, and only to decide whether to send SMTP:

- `netmon/engine/notify.py:33` — `shadow = cfg.shadow or suppressed`
- `netmon/engine/notify.py:42-45` — `if shadow: log...; return` (skips `_send_email` only)

**Corroborated in data.** 47 of the 102 lifetime alert rows are closed, `first_close =
2026-07-27 15:00:08`, `last_close = 2026-07-28 18:48:28` — all while `shadow = true`. Device 2
(`MLK-A215`, a flapping AP) has opened and closed **29 separate times**, most recently
opened 18:45:28 / closed 18:48:28 on 2026-07-28. Closing demonstrably works in shadow mode.

`notifications`: 102 rows, `shadow = 1` on all 102, zero with `shadow = 0`. No real email has been
sent.

---

## 3. What the 55 actually are

**Verified.** All 55 open alerts are rule `id = 2`, `device_source_down`
(`dimension = source_status`, `condition = {"op":"eq","value":"down"}`, `severity = crit`,
`min_duration_s = 180`, `enabled = 1`). No other rule has any open alert.

```sql
SELECT a.rule_id, r.name, r.enabled, r.dimension, COUNT(*) n,
       MIN(a.opened_at) oldest, MAX(a.last_seen_at) newest_seen
FROM alerts a LEFT JOIN alert_rules r ON r.id = a.rule_id
WHERE a.closed_at IS NULL
GROUP BY a.rule_id, r.name, r.enabled, r.dimension;
-- → rule 2 device_source_down, enabled=1, source_status, n=55,
--   oldest=2026-07-27 14:51:04, newest_seen=2026-07-28 20:11:39
```

`newest_seen` is the current minute. `engine.py:115-120` bumps `last_seen_at` only for devices that
matched **this** cycle, so the engine is actively re-affirming all 55 — they are not orphans, the
condition still evaluates true.

And it does: every one of the 55 devices has `device_state.source_status = 'down'` written by the
`xiq` collector within the last three minutes (`updated_at` 2026-07-28 20:09:04–20:09:05, refreshed
again at 20:12:20 in a later cycle). The engine is behaving exactly as specified. **The defect is
upstream of the engine, in what the rule is allowed to see.**

**No duplicates.** 55 open rows, 55 distinct `device_id`, zero `(device_id, rule_id)` groups with
count > 1 — the `open_key` generated unique index (`migrations/001_init.sql:114-115`) makes a
duplicate open row impossible at the DB level.

```sql
SELECT device_id, rule_id, COUNT(*) c FROM alerts WHERE closed_at IS NULL
GROUP BY device_id, rule_id HAVING c > 1;   -- → 0 rows
SELECT COUNT(DISTINCT device_id) FROM alerts WHERE closed_at IS NULL;  -- → 55
```

---

## 4. Stale vs. legitimate

The query (applies `netmon.state.device_down` — the exact predicate the UI uses — to each open
alert's device):

```python
from netmon.state import device_down, REACHABILITY_FLAGS_SQL
rows = fetch_all(f"""
SELECT a.id alert_id, d.id did, d.name, d.site, d.device_type,
{REACHABILITY_FLAGS_SQL}
FROM alerts a JOIN devices d ON d.id = a.device_id
LEFT JOIN device_state s ON s.device_id = d.id
WHERE a.closed_at IS NULL
GROUP BY a.id, d.id, d.name, d.site, d.device_type
""")
stale = [r for r in rows if not device_down(r)]   # UI renders these UP
legit = [r for r in rows if device_down(r)]       # UI renders these DOWN
```

| Bucket | Count | Meaning |
|---|---|---|
| **Contradicted / false** | **4** | `source_status = down` but the device answers `snmpget`. `device_down()` returns False → the map, site roll-up and Switches navigator all render these **up** while a `crit` alert stays open. |
| **Consistent with the UI** | **51** | 48 AP + 2 switch + 1 other. `device_down()` returns True → the UI agrees they are down. |
| **Currently-actionable outage** | **0** | see the ageing table below. |

The 4 contradicted (all MDF/core switches, all `snmp = up @ 2026-07-28 20:11:09`):

| alert | device | name | site |
|---|---|---|---|
| 63 | 911 | Transportation Office | Transportation |
| 68 | 1031 | OKD-MDF | Oakdale |
| 74 | 970 | RQE-MDF-CORE | Rock Quarry |
| 75 | 1217 | EMS-MDF | Eastwood Middle |

**Ageing of the 51 "consistent" ones — none is a live incident.** Time since the last transition
*into* `source_status = down`:

| Age bucket | Count |
|---|---|
| > 7 days | 52 |
| 1–7 days | 3 |
| < 24 hours | **0** |

52 of the 55 devices have **never** recorded a `source_status = up` event and have been continuously
`down` since 2026-07-17 09:04. Names in that set include `DEAD_AP`, `oak-DEAD`,
`CO-Children's_Theatre-DEAD`, `CO-TestSwitch`, `XIQSE`.

**Verified against the XIQ payload** (`xiq_devices.json`, 1367 entries): these devices really do
report `device_admin_state = MANAGED, connected = false`. The MANAGED gate
(`netmon/collectors/xiq.py:76-79`) is working — it correctly maps the 86 `NEW` / 22 `UNMANAGED` /
2 `BOOTSTRAP` entries to `unknown` (16 such rows exist in `device_state`). The 55 are the residual
`MANAGED, connected=false` population, which the gate by design cannot filter.

**Honest reading of the split:** by the letter of the task's definition it is **4 stale / 51
legitimate**. By operational meaning it is **0 actionable / 55 noise** — 4 outright false and 51
real-but-dead: decommissioned or long-failed kit XIQ still lists as managed. Only the 4 are a
*correctness* bug; the 51 are a *policy* gap (no ageing/decommission path for a `crit` that has been
true for eleven days).

---

## 5. Secondary contributor: the ping sweep has been blind for 1448 cycles

**Verified.** `device_state` contains **zero `ping` rows**, fleet-wide:

| dimension | value | rows | newest `updated_at` |
|---|---|---|---|
| `source_status` | up | 894 | 2026-07-28 20:12:20 |
| `source_status` | down | **55** | 2026-07-28 20:12:20 |
| `source_status` | unknown | 16 | 2026-07-28 20:12:19 |
| `recording` | up | 2659 | 2026-07-28 20:12:15 |
| `snmp` | up | 157 | 2026-07-28 20:11:09 |
| `snmp` | down | 3 | 2026-07-28 20:11:09 |
| `ping` | — | **0** | — |

`collector_health` row `poller_ping`: `last_success = 2026-07-27 20:05:11`,
`consecutive_failures = 1448`,
`last_error = SweepBlindError('ping sweep returned 0 verdicts for 965 target(s) — the probe did not
run (check the binary and, for fping, CAP_NET_RAW)')`.

This is the known `CAP_NET_RAW` sandbox issue and is being handled elsewhere, but it is load-bearing
here: `ping` is the *primary* tiebreaker in `device_down`, and it is entirely absent. Only 160 of
3626 enabled devices are `snmp_capable`, so `snmp` covers 4% of the fleet. **51 of the 55 open
alerts have no native evidence of any kind** — `source_status` is their only signal, which means for
them the tiebreaker would not help even if the rule consulted it. Fixing the alert rule fixes 4;
fixing fping is what would make the other 51 answerable at all.

---

## 6. Yes — the site-card `problems` count reads these rows

**Verified.** `netmon/api/sites.py:201-208` (`_SITE_PROBLEMS_SQL`) selects
`FROM alerts a JOIN devices d … JOIN alert_rules r … WHERE a.closed_at IS NULL`, grouped by
`d.site`; `_site_problems` (`:213-227`) reduces it to `(count, worst_severity)`; `_site_rollups`
consumes it at `:245` and emits it as `SiteRollup.problems` / `worst_severity` at `:258-259`.

Crucially, `problems` comes from that alert query while `status` comes from `rollup_site` over
`_DEVICE_FLAGS_SQL` (`:47-56`), which **does** apply `device_down`. The two disagree by
construction. Running `_site_rollups` live reproduces the reported symptom exactly:

| site marker | status | devices_total | devices_down | problems | worst |
|---|---|---|---|---|---|
| EMS | **up** | 8 | 0 | **1** | crit |
| OAK | **up** | 2 | 0 | **1** | crit |
| RQE | **up** | 8 | 0 | **1** | crit |
| BUS | degraded | 3 | 0 | 1 | crit |

Those are precisely 3 of the 4 contradicted switches (EMS-MDF, OKD-MDF, RQE-MDF-CORE). The 4th
(Transportation Office) lands on marker `BUS`, which is `degraded` for an unrelated reason
(`trunk_alarm`, since `devices_down = 0` and `switch_down = 0`).

**Side finding (verified).** The remaining 51 open alerts sit on `devices.site` values `Unassigned`
(14) and `Wireless APs` (37), neither of which matches any enabled `sites.name`/`group_key`, so
`problems_by_site.get(join_key, …)` at `:245` never finds them. They are invisible on the site map
but do appear on the Problems page — a reconciliation gap between the two consoles.

---

## 7. Proposed fix

### 7a. Correctness: give the alert engine the same tiebreaker the UI has (fixes the 4)

The `snmp`-as-tiebreaker logic added in commit `73f30b6` landed in the *read* path
(`netmon/state.py:38-59`) and in `netmon/api/sites.py`, but the engine was never updated — it still
evaluates one dimension at a time (`engine.py:107` `self._states(rule["dimension"])`).

Change `AlertEngine._states` (or add a corroboration step in `run_once` between `engine.py:108` and
`:114`) so that when `rule["dimension"] == "source_status"` and the condition matched `down`, the
device's reachability flags are fetched with the shared `REACHABILITY_FLAGS_SQL` and the match is
dropped if `netmon.state.device_down(flags)` is False. Reusing `state.device_down` — rather than
re-deriving the rule — is the point; that duplication is what caused the drift in the first place
(see the comment at `netmon/state.py:10-13`).

Once the match is dropped, the device falls out of `matched` and the existing `_close_resolved`
(`engine.py:138-146`) closes the 4 alerts on the next cycle with **no manual intervention and no
mass-close**. That is the reason I did not touch any row.

**Migration needed: no.** Pure code change, `netmon/engine/engine.py` only. `alert_rules` already
carries everything needed and I would not add a column — hardcoding "source_status down requires
native corroboration" matches the invariant already documented in `state.py` and `sites.py`.

*Optional, deferred:* if the owner wants this per-rule rather than dimension-wide, that **would**
need a migration (`ALTER TABLE alert_rules ADD COLUMN require_native_corroboration TINYINT(1) NOT
NULL DEFAULT 1`). I recommend against it for now — one behaviour, one place.

### 7b. Policy: an ageing / decommission path (addresses the 51)

Not a code bug, so I am proposing rather than prescribing. Options, cheapest first:

1. **Decommission the dead kit at source** — the `-DEAD` / `DEAD_AP` / `CO-TestSwitch` entries are
   still onboarded in XIQ. Removing them there, or setting `devices.enabled = 0` in NetMon, removes
   them from `_states` and the engine closes their alerts by itself. Zero code.
2. **Downgrade the AP case.** `device_source_down` fires `crit` for every device type. A single
   disconnected AP is not a `crit` by the site-roll-up's own stated semantics
   (`sites.py:84-92`: "a down camera/AP/phone does NOT degrade the site"). Splitting the rule by
   `device_type` would need either a schema addition or a second seeded rule — flag for the owner.
3. **Cap alert age.** Auto-close or auto-suppress an alert whose condition has held unchanged for
   > N days, so eleven-day-old `crit`s stop crowding the Problems console.

### 7c. Site-map reconciliation (the `Unassigned` / `Wireless APs` gap)

37 + 14 open alerts belong to `devices.site` groups with no map marker. Either add `group_key`
mappings so they roll up somewhere, or surface an explicit "unmapped problems" count on the Global
page so the two consoles agree. Needs an owner decision on which; no migration for the `group_key`
route (`sites.group_key` already exists).

### 7d. Latent bug found while reading — worth fixing in the same PR

`_close_resolved` is only reachable from inside the enabled-rules loop
(`engine.py:105` `for rule in self._rules():` → `:135`), and `_rules()` filters
`WHERE enabled = 1` (`:48-53`). **Disabling a rule therefore orphans its open alerts permanently** —
they can never be closed again, and they keep inflating every site card's `problems` count via
§6's query. This is almost certainly the observation that generated the original (now refuted)
"engine disabled means alerts never close" theory: it is true for a disabled *rule*, just not for a
disabled *engine*.

Fix: after the rule loop, close any open alert whose `rule_id` is not in the enabled set (or whose
rule no longer exists). No migration.

### 7e. Churn note (pre-cutover risk, no fix proposed)

Device 2 opened/closed 29 times in ~30 hours under `min_duration_s = 180`, producing 76
notifications on 2026-07-27 and 26 on 2026-07-28. All shadow, so harmless today. At cutover
(`shadow = false`) that single flapping AP would have sent 29 emails in a day. `_held_since`
(`engine.py:62-69`) takes `MAX(occurred_at)` for the device+dimension, which resets the duration
gate on every flap, so the 180s gate does not damp a device oscillating on a slower period than
that. Worth a flap-damping pass before the owner flips `shadow`, but out of scope here.

---

## 8. Verified vs. inferred

**Verified (read directly from code or queried from the live DB):**
- Effective `[engine]` config is `enabled=True, shadow=True`; engine `last_success` 20:13:10 today.
- `_close_resolved` has no shadow gate (`engine.py:138-146`); `shadow` is used only to skip SMTP
  (`notify.py:33,42-45`).
- 47 alerts have been closed under `shadow=true`; device 2 cycled 29 times.
- All 102 `notifications` rows are `shadow=1`; no email sent.
- All 55 open alerts are rule 2 `device_source_down`; 55 distinct devices; zero duplicates.
- All 55 devices currently hold `source_status = 'down'` from the `xiq` collector, refreshed minutes
  ago; `last_seen_at` is current, so the engine is actively re-matching them.
- 4 of 55 have `snmp = up`, so `state.device_down` returns False for them.
- `device_state` has zero `ping` rows; `poller_ping` has 1448 consecutive `SweepBlindError`s.
- 52 of 55 have never recorded a `source_status = up` event and have been down since 2026-07-17;
  none went down within 24h.
- `xiq_devices.json` confirms `MANAGED, connected=false` for the sampled devices, and that the
  MANAGED gate correctly diverts the `NEW`/`UNMANAGED`/`BOOTSTRAP` population to `unknown`.
- `sites.py` `problems` reads `alerts WHERE closed_at IS NULL`; running `_site_rollups` live yields
  EMS/OAK/RQE at `status=up` with `problems=1 crit`.
- 51 open alerts sit on `devices.site` groups that match no enabled site marker.
- `_close_resolved` is unreachable for disabled rules (control-flow read of `engine.py:105-146`).

**Inferred (reasoned, not proven):**
- That the `-DEAD` / `DEAD_AP` / `CO-TestSwitch` / `XIQSE` devices are genuinely decommissioned
  rather than genuinely broken — inferred from naming plus 11 days of unbroken `down` with no `up`
  ever recorded. Not confirmed with the owner.
- That the 4 MDF switches are cloud-disconnected-but-healthy rather than partially failed. `snmpget`
  answering is strong evidence of liveness, but with `ping` absent there is no second opinion; a
  switch could answer SNMP on the management VLAN while its XIQ uplink is genuinely broken, which
  would be a real (if different) problem worth surfacing rather than suppressing.
- That fixing §7a alone would close exactly 4 alerts. It follows from the code path, but I did not
  execute the engine to observe it, since doing so would have written to `alerts`.
- That §7e would have produced 29 emails at cutover — extrapolated from the shadow row count, not
  measured.

**Not investigated:** why `xiq_devices.json` contains several entries sharing one hostname
(4–5 rows each for `OKD-MDF` and `EMS-MDF`, one of them `UNMANAGED`) and how the collector maps
them onto a single `devices` row. Possibly stack members. If the mapping is by hostname rather than
`xiq_device_id`, a single `UNMANAGED` sibling could be perturbing the verdict — worth a follow-up,
outside this task's scope.

**Credential note:** reading effective config prints `[poller] snmp_community` in clear text. It is
deliberately not reproduced anywhere in this document.
