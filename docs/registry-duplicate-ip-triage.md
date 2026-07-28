# Registry duplicate `mgmt_ip` triage

**Date:** 2026-07-28
**Scope:** every `mgmt_ip` shared by more than one **enabled** row in `devices`.
**No rows were modified.** This audit was strictly read-only — no `UPDATE`, `DELETE`, `INSERT`, or
`enabled` flip was issued against `devices` or any other table. Every recommendation below is a
proposal for the owner, not an applied change.

---

## 1. How the pairs were found (re-runnable)

```sql
-- the pair finder
SELECT mgmt_ip, COUNT(*) AS n, GROUP_CONCAT(id ORDER BY id) AS ids
FROM devices
WHERE enabled = 1 AND mgmt_ip IS NOT NULL AND mgmt_ip <> ''
GROUP BY mgmt_ip
HAVING COUNT(*) > 1
ORDER BY mgmt_ip;

-- the per-device evidence pull (substitute the ids above)
SELECT id, name, site, device_type, mgmt_ip, snmp_capable, enabled,
       xiq_device_id, pf_node_mac, milestone_hardware_id, rconfig_device_id, threecx_ref,
       created_at, updated_at
FROM devices WHERE mgmt_ip IN (/* dup ips */) ORDER BY mgmt_ip, id;

SELECT device_id, dimension, value, severity, source, updated_at
FROM device_state WHERE device_id IN (/* ids */) ORDER BY device_id, dimension;

SELECT device_id, COUNT(*) AS n, MIN(occurred_at) AS first_ev, MAX(occurred_at) AS last_ev
FROM state_events WHERE device_id IN (/* ids */) GROUP BY device_id;

-- which row the SNMP sweeps actually populated (the decisive evidence for switches)
SELECT device_id, slot, serial, model, fw_version, mem_pct, temp_c, updated_at
FROM stack_members WHERE device_id IN (/* ids */) ORDER BY device_id, slot;
SELECT device_id, COUNT(*) FROM switch_ports  WHERE device_id IN (/* ids */) GROUP BY device_id;
SELECT device_id, COUNT(*) FROM fdb_entries   WHERE device_id IN (/* ids */) GROUP BY device_id;
SELECT device_id, local_ifindex, remote_sysname, remote_port
FROM neighbors WHERE device_id IN (/* ids */) ORDER BY device_id, local_ifindex;
```

Run via the settings overlay, not the conf file:

```
cd /usr/share/TCS-NetMon
.venv/bin/python -c "
from netmon import config as C, db as D
cfg = C.load_config('/etc/netmon/netmon.conf'); eng = D.make_engine(cfg.db.url)
..."
```

Cross-referenced against `/usr/share/TCS-NetMon/xiq_devices.json` (the `scripts/xiq_export.py`
dump of XIQ `GET /devices`, 1367 objects) for serial / MAC / model / `device_admin_state` /
`connected` / `system_up_time`.

**Result: 17 duplicated IPs, 34 enabled rows, no triples.** All 34 carry `xiq_device_id` and
**only** that key — `pf_node_mac`, `milestone_hardware_id`, `rconfig_device_id`, and `threecx_ref`
are NULL for all 34. Sites: Wireless APs 26, Unassigned 2, Verner 2, Rock Quarry 2,
Northridge High 1, Transportation 1. `enabled = 1` for all 34 (the registry currently has
3626 rows, **zero** disabled, 965 with a usable `mgmt_ip`, 2661 with none).

---

## 2. Why this matters more than a count inflation

The poller selects targets by IP (`netmon/poller/poller.py:94`, `_apply()` at line 126 keys the
verdict dict by `mgmt_ip`), and `snmp_inventory` does the same
(`netmon/poller/snmp_inventory.py:611`). One probe therefore feeds every row sharing the IP.
Confirmed live, and it is **actively producing a false "up"**:

* **All 34 rows show `ping = up / ok` from `poller`, written in the same sweep** (identical
  `device_state.updated_at`, e.g. `2026-07-28 20:15:27`). That includes 13 devices XIQ reports as
  `connected: false` with `system_up_time = 0` and no `ap_details.uptime_s` — i.e. hardware that
  has not checked in since it ran firmware 10.3.x/10.4.x. NetMon is vouching "ICMP up" for
  devices that are almost certainly unplugged, because a *different, live* device answers at that
  address. This is the "never fabricate, blind must not render as healthy" invariant
  (CLAUDE.md §4.5) being violated by data, not by code intent.
* **The SNMP inventory is duplicated wholesale for the 3 switch pairs.** Both rows of each pair
  hold byte-comparable sweep output from a single chassis — identical `stack_members` serials,
  models, `mem_pct`/`temp_c`, identical `switch_ports` counts and per-port state, identical
  `neighbors` (EDP) sets, near-identical `fdb_entries` counts (offset only by the seconds between
  the two sweeps):

  | pair | switch_ports | fdb_entries | switch_vlans | stack_members |
  |---|---|---|---|---|
  | 909 / 911 | 168 / 168 | 164 / 164 | 11 / 11 | 3 / 3 (same serials) |
  | 896 / 970 | 112 / 112 | 410 / 410 | 13 / 13 | 2 / 2 (same serials) |
  | 834 / 1029 | 88 / 88 | 175 / 174 | 11 / 11 | 2 / 2 (same serials) |

  Each duplicate also costs a full extra `snmpbulkwalk` pass per sweep cycle. `snmp_inventory`
  is currently recording `consecutive_failures = 1` with
  `"run cancelled after 60s … completed sweeps kept, rest retry next tick"`, so wasted sweep
  budget is not free.
* **Alert noise:** 16 open (`closed_at IS NULL`) `device_source_down` alerts sit on these rows,
  13 of them on the members this document recommends retiring or re-addressing.

Note the premise correction: for the 14 AP pairs the **site device count is not inflated** — both
APs are genuinely distinct hardware and both legitimately count. The inflation is real only for
the 2 phantom-stack pairs in §4 (a). The IP collision is nonetheless a real defect on all 17,
because of the shared poller verdict.

---

## 3. Classification summary

| class | count | pairs |
|---|---|---|
| **(a) STALE DUPLICATE** — one row should be disabled | **4** | 192.168.72.1, 192.168.100.253, 172.16.109.20, 172.16.120.6 |
| **(b) DISTINCT DEVICES, WRONG IP** — both real, one IP stale | **13** | 10.172.0.6 + the 12 remaining AP pairs |
| **(c) UNCLEAR** — needs owner knowledge | **0** | — (residual questions are in §6; none of them change a pair's class) |

---

## 4. The pairs

`admin` = XIQ `device_admin_state`, `conn` = XIQ `connected`, `up_time` = XIQ `system_up_time`
(0 = never reported). `src_st` = `device_state.source_status`. Every row: `enabled = 1`,
`ping = up/ok` from `poller`, only `xiq_device_id` populated.

### (a) STALE DUPLICATE — 4 pairs

| ip | id | name | site | type | snmp_cap | xiq_device_id | XIQ model / serial | admin / conn | src_st | verdict |
|---|---|---|---|---|---|---|---|---|---|---|
| 192.168.72.1 | **896** | RQS-CORE-MDF | Rock Quarry | switch | 1 | 70849781125462 | X465-48P / 16496~2036F-20544 | MANAGED / true | up | **keep** |
| 192.168.72.1 | **970** | RQE-MDF-CORE | Rock Quarry | switch | 1 | 70849782284354 | NOT_PRE_DEFINED_STACK / sn-16496~2036F-20610 | MANAGED / false | down | **disable** |
| 192.168.100.253 | **834** | VES-GYM | Verner | switch | 1 | 70849782266114 | NOT_PRE_DEFINED_STACK / sn-16496~2036F-20147 | UNMANAGED / false | unknown | **keep** |
| 192.168.100.253 | **1029** | 192.168.100.253 | Verner | switch | 1 | 70849782563591 | X465-24W / 2018F-20096 | UNMANAGED / false | unknown | **disable** |
| 172.16.109.20 | **758** | OAK-LIB | Wireless APs | ap | 0 | 70849780749203 | AP_650 / 06502010140082 | MANAGED / true (up_time 2026-07-03) | up | **keep** |
| 172.16.109.20 | **113** | oak-DEAD | Wireless APs | ap | 0 | 70849780745203 | AP_305C / 03052009251571 (fw 10.4.6.0) | MANAGED / false (up_time 0) | down | **disable** |
| 172.16.120.6 | **848** | CO-TechRoom | Wireless APs | ap | 0 | 70849780749743 | AP_650 / 06502011200510 | MANAGED / true (up_time 2025-09-26) | up | **keep** |
| 172.16.120.6 | **555** | DEAD_AP | Wireless APs | ap | 0 | 70849780747933 | AP_305C / 03052010120342 (fw 10.4.6.0) | MANAGED / false (up_time 0) | down | **disable** |

### (b) DISTINCT DEVICES, WRONG IP — 13 pairs

The `mgmt_ip` on the **wrong-IP** row is XIQ's last-known address for a device that has been
offline since the 10.3/10.4 firmware era; the address has since been re-leased to the live
device on the same row-pair. Fix is to re-address (or clear) the stale row's `mgmt_ip`, not to
delete the device.

| ip | id | name | site | type | snmp_cap | xiq_device_id | XIQ model / serial | fw | admin / conn / up_time | src_st | verdict |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 10.172.0.6 | **909** | NHS-IDF-A203 | Northridge High | switch | 1 | 70849782543006 | 5420M-48W-4YE-EXOS / 16496~JA122336G-00199 | 33.5.1.6 | MANAGED / true / 2025-10-31 | up | IP correct |
| 10.172.0.6 | **911** | Transportation Office | Transportation | switch | 1 | 70849782127010 | X450-G2-48p-10G4 / 16496~1922G-01370 | 32.4.1.10 | MANAGED / false / 2024-01-09 | down | **IP wrong** |
| 172.16.100.27 | **121** | CHS-127 | Wireless APs | ap | 0 | 70849780745257 | AP_305C / 03052009251596 | 10.8.6.1 | MANAGED / true / 2026-07-13 | up | IP correct |
| 172.16.100.27 | **642** | CHS-116 | Wireless APs | ap | 0 | 70849780748479 | AP_305C / 03052010121411 | 10.3.2.0 | MANAGED / false / 0 | down | **IP wrong** |
| 172.16.101.20 | **563** | EMS-608 | Wireless APs | ap | 0 | 70849780747987 | AP_305C / 03052010120356 | 10.7.5.2 | MANAGED / true / 2026-07-09 | up | IP correct |
| 172.16.101.20 | **430** | EMS-121 | Wireless APs | ap | 0 | 70849780747159 | AP_305C / 03052010120010 | 10.3.1.0 | MANAGED / false / 0 | down | **IP wrong** |
| 172.16.102.18 | **483** | RQS-526 | Wireless APs | ap | 0 | 70849780747483 | AP_305C / 03052010120123 | 10.7.5.2 | MANAGED / true / 2026-06-17 | up | IP correct |
| 172.16.102.18 | **727** | RQS-301 | Wireless APs | ap | 0 | 70849780749007 | AP_305C / 03052010123964 | 10.3.1.0 | MANAGED / false / 0 | down | **IP wrong** |
| 172.16.103.10 | **178** | WMS-515 | Wireless APs | ap | 0 | 70849780745599 | AP_305C / 03052009251676 | 10.7.5.2 | MANAGED / true / 2026-03-02 | up | IP correct |
| 172.16.103.10 | **645** | WMS-141 | Wireless APs | ap | 0 | 70849780748497 | AP_305C / 03052010121425 | 10.4.6.0 | MANAGED / false / 0 | down | **IP wrong** |
| 172.16.104.32 | **283** | OKH-E25 | Wireless APs | ap | 0 | 70849780746241 | AP_305C / 03052009252096 | 10.7.5.2 | MANAGED / true / 2026-06-21 | up | IP correct |
| 172.16.104.32 | **279** | OKH-AP06 | Wireless APs | ap | 0 | 70849780746217 | AP_305C / 03052009252085 | 10.3.2.0 | MANAGED / false / 0 | down | **IP wrong** |
| 172.16.104.34 | **336** | OKH-AP13 | Wireless APs | ap | 0 | 70849780746577 | AP_305C / 03052009252571 | 10.7.5.2 | MANAGED / true / 2026-06-21 | up | IP correct |
| 172.16.104.34 | **284** | OKH-AP05 | Wireless APs | ap | 0 | 70849780746247 | AP_305C / 03052009252101 | 10.3.2.0 | MANAGED / false / 0 | down | **IP wrong** |
| 172.16.107.20 | **780** | AH-60a500 | Wireless APs | ap | 0 | 70849780749335 | AP_650 / 06502010140493 | 10.7.5.2 | MANAGED / true / 2026-06-01 | up | IP correct |
| 172.16.107.20 | **831** | SVE-LIBRARY | Wireless APs | ap | 0 | 70849780749641 | AP_650 / 06502010170381 | 10.4.5.0 | MANAGED / false / 0 | down | **IP wrong** |
| 172.16.108.65 | **141** | NHS-144 | Wireless APs | ap | 0 | 70849780745377 | AP_305C / 03052009251632 | 10.7.5.2 | MANAGED / true / 2026-04-24 | up | IP correct |
| 172.16.108.65 | **812** | NHS-CAFE#2 | Unassigned | ap | 0 | 70849780749527 | AP_650 / 06502010170275 | 10.4.5.0 | MANAGED / false / 0 | down | **IP wrong** |
| 172.16.110.38 | **19** | MLK-CAFE | Wireless APs | ap | 0 | 70849780737636 | AP_410C / 04102002210047 | 10.7.5.2 | MANAGED / true / 2025-12-01 | up | IP correct |
| 172.16.110.38 | **16** | MLK-MUSIC | Wireless APs | ap | 0 | 70849780736524 | AP_305C / 03051911130510 | 10.4.6.0 | MANAGED / false / 0 | down | **IP wrong** |
| 172.16.112.24 | **119** | ARC-108-new | Wireless APs | ap | 0 | 70849780745245 | AP_305C / 03052009251592 | 10.7.5.2 | MANAGED / true / 2026-05-26 | up | IP correct |
| 172.16.112.24 | **776** | AH-6060c0 | Wireless APs | ap | 0 | 70849780749311 | AP_650 / 06502010140220 | 10.3.4.0 | MANAGED / false / 0 | down | **IP wrong** |
| 172.16.116.26 | **23** | WFE-LIB-A | Wireless APs | ap | 0 | 70849780744423 | AP_650 / 06502011161017 | 10.7.5.2 | MANAGED / true / 2026-06-17 | up | IP correct |
| 172.16.116.26 | **844** | wf-gym-2 | Wireless APs | ap | 0 | 70849780749719 | AP_650 / 06502010170684 | 10.4.5.0 | MANAGED / false / 0 | down | **IP wrong** |
| 172.16.97.25 | **903** | BHS-204-Office | Wireless APs | ap | 0 | 70849781384158 | AP_305C / 03052301281319 | 10.8.7.0 | MANAGED / true / 2026-07-08 | up | IP correct |
| 172.16.97.25 | **832** | BHS-NEW-GYM#2 | Unassigned | ap | 0 | 70849780749647 | AP_650 / 06502010170388 | 10.7.5.2 | MANAGED / false / 0 | down | **IP wrong** |

---

## 5. Per-pair notes (non-obvious cases)

### 192.168.72.1 — ids 896 / 970 — (a), disable **970**

Same physical two-unit stack, twice. Three XIQ objects claim this IP:

| xiq id | hostname | product | MAC | serial | conn |
|---|---|---|---|---|---|
| 70849781125455 | RQS-CORE-MDF | X465-48P | 209EF7C9814E | 16496~2036F-20610 | true — *not in registry* |
| 70849781125462 | RQS-CORE-MDF | X465-48P | 209EF7C979CC | 16496~2036F-20544 | true — registry id 896 |
| 70849782284354 | RQE-MDF-CORE | NOT_PRE_DEFINED_STACK | 229EF7C979CC | sn-16496~2036F-20610 | false — registry id 970 |

Evidence that 970 is a phantom of the same chassis, not a second switch:
1. `229EF7C979CC` is `209EF7C979CC` with the locally-administered bit set (`0x20 | 0x02 = 0x22`)
   — the Extreme stack virtual MAC derived from unit 20544, which is 896's own hardware.
2. Its serial is the `sn-`-prefixed pseudo-serial XIQ mints for a stack container, and the
   suffix `2036F-20610` is the *other* unit of the stack.
3. SNMP settles it: sweeps of 896 and 970 returned the same two `stack_members`
   (`2036F-20610` X465-48P slot 1, `2036F-20544` X465-48P slot 2, both fw 32.5.1.5, matching
   `mem_pct`/`temp_c` to 0.1/1°C), the same 112 ports with matching per-port counters, the same
   410 FDB entries, and the same nine EDP neighbours (`TCS-CORE 1:7`, `TCS-CORE 1:19`,
   `RQE_MDF 2:51`, `RQE-Outside 1:51`, `RQE_516`, `RQE_Teach_Lounge_Music`, `RQE_Counseling`,
   `RQE-Office`).
4. 970's `source_status` flaps `up↔down` on its own (5 transitions since 2026-07-22, latest
   `up→down` at 2026-07-27 18:12:16) purely because XIQ never marks a stack container connected —
   it has two open `device_source_down` alerts, one still open. That flap is noise about an
   object, not an outage.

Keep 896 (real physical member, MANAGED + connected, honest `source_status`); disable 970.
Do not be misled by the `RQE-` prefix — see the owner question in §6.

### 192.168.100.253 — ids 834 / 1029 — (a), disable **1029**

Also one stack, twice, but split the other way. SNMP at this address reports a two-slot stack:
slot 1 `2036F-20147` (X465-48P), slot 2 `2018F-20096` (X465-24W), both fw 32.5.1.5. Row 834 is
XIQ's **stack container** object for slot-1 hardware (`sn-16496~2036F-20147`); row 1029 is XIQ's
object for **slot-2 hardware** (`2018F-20096`) — a member already fully described inside 834's
`stack_members`. The third XIQ object on this IP (`70849782563585`, X465-48P `2036F-20147`, the
slot-1 physical) is not in the registry at all.

Tie-break rule applied: both XIQ objects are `UNMANAGED` and `connected: false`, so neither has a
meaningful `source_status` (both correctly read `unknown` — the XIQ MANAGED gate is working), and
`connected` cannot decide it. Keep the row with the human-meaningful name (**834 VES-GYM**);
disable **1029**, whose `name` is literally its own IP address because XIQ has no hostname for
that object. Disabling 1029 loses no inventory: slot 2 remains visible as a stack member of 834.

### 10.172.0.6 — ids 909 / 911 — (b), **911's IP is wrong**

Eight XIQ objects claim `10.172.0.6`; six of them are named `NHS-IDF-A203` (two retired
X450-G2-48p units, one stack container, three current 5420M units) and only two reached the
registry — the rest were presumably swallowed by `uq_devices_name`. SNMP proves which chassis
actually answers: a **three-unit 5420M-48W-4YE stack**, serials `JA122337G-00656` /
`JA122336G-00150` / `JA122336G-00199`, fw 33.5.1.6, uplinked by EDP to `NMS-MDF 1:57`. Slot 3's
serial is exactly id 909's XIQ serial, so `10.172.0.6` belongs to the Northridge switch.

Id 911 "Transportation Office" is a different device entirely — an X450-G2-48p-10G4 on fw
32.4.1.10, `connected: false`, last `system_up_time` **2024-01-09** — at a different site. Its
`mgmt_ip` is stale, and the consequence is a visible lie: NetMon shows Transportation Office with
`ping = up` and `snmp = up` (both borrowed from the Northridge stack) while XIQ says `down` with
an open `device_source_down` alert, and it has inherited a full 168-port / 164-FDB / 3-slot copy of
Northridge's inventory attributed to Transportation.

### 172.16.109.20 (113 `oak-DEAD`) and 172.16.120.6 (555 `DEAD_AP`) — (a)

Classified (a) rather than (b) purely because the operator's own naming records the disposition:
these were renamed to mark them dead, and a live AP now holds each address (`OAK-LIB` /
`CO-TechRoom`). Both have `system_up_time = 0`, NULL `ap_details.uptime_s`, and fw 10.4.6.0.
Safe to disable outright rather than re-address.

### The 12 remaining AP pairs — (b), uniform pattern

Every one is the same shape, which is what makes them safe to read in bulk: the **online** member
has `connected: true`, a recent `system_up_time`, current firmware (10.7.5.2 / 10.8.x) and a
populated `ap_details.uptime_s`; the **offline** member has `connected: false`,
`system_up_time = 0`, NULL `ap_details.uptime_s`, and firmware three-to-five minor versions behind
(10.3.1.0 – 10.4.6.0). `ap_details.ip` for *both* members equals the shared address, i.e. the
stale IP is XIQ's own last-known value, not a NetMon transcription error. An online AP's reported
address is necessarily current, so the offline member is the wrong one in every pair.

Two naming hints worth noting but not relied on: `NHS-CAFE#2` and `BHS-NEW-GYM#2` (site
`Unassigned`) and `ARC-108-new` suggest replacement events already happened; `AH-60a500` /
`AH-6060c0` are XIQ default hostnames (MAC-derived), i.e. never configured.

---

## 6. Owner questions

None of these change a pair's classification; they decide the *disposition* of the loser row.

1. **Are the 15 offline devices decommissioned or merely unplugged?** They are ids 911, 642, 430,
   727, 645, 279, 284, 831, 812, 16, 776, 844, 832 (class b) plus 113, 555 (class a). If
   decommissioned, disable them; if they are expected to come back, clear `mgmt_ip` instead so the
   poller stops answering for them, and let XIQ repopulate the address when they reconnect.
   Anything last seen at `system_up_time = 0` has never reported an uptime to XIQ at all.
2. **192.168.72.1 naming:** is `RQE-MDF-CORE` merely XIQ's label on the Rock Quarry stack
   container, or does a *real* Rock Quarry Elementary MDF core exist as separate hardware? EDP
   from this chassis shows a distinct neighbour named `RQE_MDF` on port 2:51 — so a real RQE MDF
   switch exists downstream and may be **entirely absent from the registry**. Disabling 970 is
   correct either way, but that neighbour deserves its own check.
3. **192.168.100.253:** confirm `VES-GYM` (834) is the right name for the whole Verner stack, and
   that retiring the slot-2 row (1029) is acceptable. Also — both XIQ objects here are
   `UNMANAGED`; is that intentional, or should the Verner stack be MANAGED in XIQ?
4. **10.172.0.6:** what is the Transportation Office switch's real management address (if it is
   still in service)? And should the five orphaned `NHS-IDF-A203` XIQ objects (retired X450-G2
   units + stack container) be cleaned up in XIQ so future seeds stop colliding?

---

## 7. Recommended remediation, in order

1. **Disable the 4 class-(a) losers** — ids **970**, **1029**, **113**, **555**. These are the
   safely disable-able ones: two are phantom XIQ objects for chassis already monitored under
   another row, two are operator-marked-dead APs. No inventory or state is lost.
2. **Clear or correct `mgmt_ip` on the 13 class-(b) stale rows** (911, 642, 430, 727, 645, 279,
   284, 831, 812, 16, 776, 844, 832) after answering question 1. Clearing `mgmt_ip` alone stops
   the false `ping = up` immediately (the poller only selects rows with a non-empty `mgmt_ip`) and
   preserves the device row, its XIQ key, and its honest XIQ-sourced `source_status`.
3. **Fix the class of bug, not just today's 17 rows.** Row-level cleanup is not durable — the
   XIQ export already contains **125 addresses shared by 2+ XIQ objects (467 objects)**, and only
   17 collisions surfaced in the registry because 2661 rows have no `mgmt_ip` and
   `uq_devices_name` silently dropped same-named duplicates. The next seed can reintroduce them.
   Two candidate guards, both cheap:
   - `netmon-seed`: refuse to assign an `mgmt_ip` already held by another enabled device (or
     prefer the XIQ object with `connected: true` / the most recent `system_up_time`), and skip
     `product_type = NOT_PRE_DEFINED_STACK` objects whose `sn-`-prefixed serial matches a stack
     member already seeded. Only 3 such container rows exist today (834, 970, and **1041
     `WMS-705`** at 192.168.104.247 — which does *not* currently collide, but is the same phantom
     shape and worth checking).
   - Poller/sweep: when an IP maps to more than one enabled device, write the verdict to none of
     them and record the ambiguity in `collector_health` — "fail loud, never stale" (CLAUDE.md
     §4.5) argues for refusing to guess rather than crediting a verdict to N rows.
4. **Add a standing check** (NetMon Status page or a seed `--check` mode) for: duplicate
   `mgmt_ip` among enabled devices, and enabled devices whose XIQ object reports
   `system_up_time = 0`.
