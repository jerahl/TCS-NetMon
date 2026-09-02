# Spec 17 — Site attribution

**Status:** BUILT 2026-08-31 (backfill applied to the live registry)
**Scope:** `devices.site` — how it is populated, why 96% of it was wrong, and the
rules that fill it now.
**Relates to:** spec 15 §0.4 (named this the highest-leverage fix in the
program), spec 16 C1 (promoted it from "highest-leverage" to *prerequisite*),
spec 11 D9 (`--sites-from-db`), migration 015 (`sites.group_key`).

---

## 1. The defect

3,466 of 3,626 registry rows carried a non-location value in `devices.site`:
2,748 `Unassigned` and 718 `Wireless APs`. Switches were fine (157 of 158
correctly sited); APs, cameras and recording servers were not.

The cost was not cosmetic. Per spec 16 C1 the Global site tiles, the Problems
site mosaic, the Events site filter, the Site Map roll-up and both host
navigators are **already written** — `global.jsx:164` renders `s.problems` and
`:159` renders `devices_degraded` today. They displayed nothing because every
site's `problems` was 0, because no alert could be attributed to a site. Several
per-page estimates in spec 15 assumed building things that simply start working
once this data is true.

## 2. Two causes, found by reading the export rather than the pages

### 2.1 A ranking bug in the seed (717 APs)

Zabbix nests **two parallel taxonomies** under one `Site/` prefix:

| Group shape | Count | Meaning |
|---|---|---|
| `Site/Wireless/<school>/<floor>` | 725 hosts | a real location |
| `Site/<name>` | 186 hosts | the flat per-site group |
| `Site/Wireless APs` | 788 hosts | a fleet-wide *device class* |
| `Site/Servers`, `Site/Video/Milestone` | 41 hosts | functional groupings |

**728 hosts belong to more than one.** `build_site_index` took the first group
whose name started with `Site/` and stopped, so for 717 APs the catch-all won
and `devices.site` read `Wireless APs` — a device class standing where a
building belongs. The authoritative location was in the same export the whole
time, one group along.

Fixed by ranking: location (2) > flat site (1) > functional (0), with functional
groups never usable as a site. Membership order is not a statement about which
group is the more truthful answer.

### 2.2 Cameras and recording servers were never in a `Site/` group at all

Milestone federates by hardware id; Zabbix only ever tracked 15 of 2,659 cameras
under `Site/Video/Milestone`. No export can answer where a camera is, so this is
the part that must be **inferred** — `netmon/siteresolve.py`.

## 3. Resolution order

Most-trusted first. Each resolution records its method and evidence.

| Method | n | Basis |
|---|---|---|
| `zbx-location` | 722 | the ranked `Site/Wireless/<school>/<floor>` group |
| `prefix` | 2,373 | device-name prefix, learned from authoritatively-sited devices |
| `subnet` | 174 | /16 learned from authoritatively-sited devices |
| `subnet-2` | 126 | /16 learned with prefix-resolved peers admitted as evidence |
| `normalise` | 9 | unplaceable, but the stale `Wireless APs` label cleared |
| owner | 55 | Alberta Elementary, identified by the owner (§5.1) |
| — | 14 | **left `Unassigned` — never guessed** |

### Why inference here is not guessing

* **Learned, not hardcoded.** Both maps are derived from devices whose site came
  from an authoritative source. `ALB` resolves to `TASPA` — not to an invented
  "Alberta" site — because nine `ALB-*` switches are sited `TASPA` in the
  registry. Reading the string would have produced the wrong answer.
* **Evidence never becomes circular.** The stage-1 subnet map is built *only*
  from Zabbix-group and pre-existing assignments. Stage 2 admits prefix-resolved
  peers, and is fenced for it: 100% purity required (any disagreement rejects the
  /16), a higher sample floor, and it may not overwrite a stage-1 answer.
* **Purity thresholds, with loud rejection.** A /16 needs ≥98% purity over ≥3
  authoritative devices. This is what refuses `172.16` (8% pure across 669
  devices) and `192.168` (19%) — the shared management ranges behind the July
  contested-IP bug — and `10.172` (83%, two genuinely co-located sites).
  Rejections are printed, not silently dropped.
* **Dissent is reported, not averaged away.** Prefix purity is 0.95 rather than
  1.0 so one bad row cannot veto a prefix, but every outvoted row is printed.
  `WMS` is 40/42 for Westlawn Middle; the two dissenters turned out to be
  genuinely mis-sited devices (§5).

### Accuracy

Hold-out test over the 827 authoritatively-sited devices, learning from half and
predicting the other half: **403 correct, 2 wrong, 8 no-answer — 99.51% when it
answers.** Both "errors" were the resolver disagreeing with the two mis-sited
`WMS-*` rows, i.e. it was right and the registry was wrong.

## 4. Result

24 sites carrying 55–344 devices each; **14 rows remain `Unassigned`** and no
row reads `Wireless APs`. Open alerts now attribute to real sites (Bryant High 268,
Northridge High 263, Central High 226, …) where every one previously read
`Unassigned` or `Wireless APs`.

## 5. Open items for the owner

**14 unplaceable devices** (was 69 — see §5.1) — each needs one sentence, and
the tool will place them the moment a rule can:

| Devices | Evidence available |
|---|---|
| 8 APs on 172.16 (`AH-*`, `BPCC-*`, `OLDTCT-*`) | shared range; names are not site codes |
| 1 recording server (`TRAN-BCD-MS`) | `TRAN` looks like Transportation but no device proves it |
| `XIQSE`, `192.168.240.14`, `X465-48P`, `Maint-Cam-23` | appliance/model-named one-offs |

### 5.1 Alberta Elementary — resolved 2026-08-31

The 55 `FLEXIDOME`/`BOSCH` cameras on **10.84.18.x** were the largest unplaced
block and had no evidence at all: no switch, AP or recording server anywhere on
10.84. The owner identified it as **Alberta Elementary**.

It is genuinely a *new* site, not an existing one under another spelling. Every
site owns exactly one camera /16, and TASPA — the other Alberta-named campus,
whose 203 devices are all `ALB-*` — sits entirely on 10.21. So `ALB → TASPA`
(§3) and `10.84 → Alberta Elementary` are two different places, and merging them
would have been wrong.

`sites` row 24 created (`tier=elementary`, joining by `name`, `group_key` NULL).
**Its lat/lon are a deliberate placeholder** — TASPA's coordinates, chosen with
the owner so the pin is visibly approximate in the right neighbourhood rather
than plausibly wrong somewhere else. ⚠️ **The marker must be dragged to its real
position in Site Map → EDIT MAP.** Until then the site card and roll-up are
correct and only the map position is not.

Nothing was hardcoded to achieve this. Once the 55 cameras carry a real site
they become authoritative evidence themselves, so the resolver now *learns*
`10.84 → Alberta Elementary` from the registry: any future camera on that range
places automatically.

Alberta Elementary has 55 cameras and **no switches or APs** in the registry,
which is worth a look on its own — either its network gear is absent from XIQ,
or it is genuinely camera-only.

**3 registry-vs-Zabbix conflicts**, reported but deliberately not changed — the
never-overwrite rule protects manual Registry assignments:

| Device | Registry | Zabbix |
|---|---|---|
| `WMS-Faculty/Work_Room` | Verner | Westlawn Middle |
| `WMS-160/Band` | Verner | Westlawn Middle |
| `15th-McF` | 15th | Central Office |

## 6. Reversibility

Pre-change values for all 3,626 rows: `/var/lib/netmon/backups/devices-site-before-siteresolve.json`
(outside the repo — it contains device names). Restore is `UPDATE devices SET
site = :site WHERE id = :id` per row. No schema change, no migration.

The write path is `python -m netmon.siteresolve --sites <zabbix-export>`, which
is **dry-run by default** and only writes `devices.site`. It never overwrites a
site that is already a real location, so a manual assignment in the Registry UI
always wins.

## 7. Next session

- ⚠️ **Drag the Alberta Elementary marker to its real position** (§5.1) — its
  pin is a placeholder by agreement, and a wrong pin on a NOC map is exactly the
  kind of confidently-wrong artifact this spec exists to avoid.
- Answer the 14 above, re-run `--apply`; expect them to place with no code change.
- Resolve the 3 conflicts by hand in `#/registry`.
- **Wire the resolver into the import paths** so a newly-discovered camera or AP
  is sited on arrival instead of landing `Unassigned` forever. `seed.assign_sites`
  and `registry.py`'s XIQ/Milestone imports are the two call sites.
- Site attribution was spec 16's stated prerequisite for the G3 data-truth gate;
  with it done, `summary.severity` and `/api/sites.problems` have true inputs and
  spec 16's G4 (severity strip, ~0.5–1 wk) is unblocked.
