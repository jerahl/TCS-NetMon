# Spec 13 — Direct camera monitoring (SNMP against Milestone-known cameras)

**Status:** PLANNED — post-parity phase **11.x**, ⛔ **D10-gated** (owner sign-off
required before any code; spec 11 §6). Depends on the D6 SNMP charter amendment
(already approved/built for switches, Phase 10.1).
**Owner-requested:** 2026-07-17 ("direct camera monitoring for cameras pulled
from Milestone").
**Plan of record:** spec 11 (this is a new 11.x bucket item there).
**Reference artifact:** `reference/zabbix/milestone/template_milestone_camera_bosch.yaml`
— the owner's Zabbix 7.4 "Milestone Camera vendor - Bosch" template. It is the
authoritative OID map / gotcha record for this phase (the M0 Bosch pilot
findings, encoder/motion blob layout, and bucket A/B/C compatibility live in its
item descriptions). Cited throughout below as *the Bosch template*.

---

## 1. Why this exists (and why it is not ZCD parity)

The federated Milestone collector (spec 05, Phase 10.4) answers *"is the VMS
recording this camera?"* — recording state, plus the Config-API attributes
(model, resolution, fps target, codec, ip, mac, recording-server link) persisted
to the `cameras` table. That is everything Milestone knows.

What Milestone does **not** know — and therefore NetMon cannot federate — is the
camera *host's own health*:

- CPU load and process count (a half-booted camera that still answers Milestone);
- **kernel** uptime / reboot detection (Milestone shows "recording" straight
  through a camera reboot);
- filesystem fill on `/data` and `/var/log`;
- the wired interface's oper status, link speed, and live in/out bandwidth;
- per-imager **encoder bitrate** (a stalled/black-scene encoder still records);
- VCA **motion-active** state and the alarm-detail bitmap;
- hardware/firmware identity and the VMS endpoint the camera *believes* it is
  registered with (drift detection).

ZCD never collected any of this — it read Milestone HTTP items only. So this is
a **capability beyond ZCD parity**, and it re-polls devices directly rather than
federating. That is the same reasoning that made the switch `snmpbulkwalk` sweeps
core scope in spec 11 §5.1: *"the source can't provide it, so NetMon collects it
directly."* Because it is (a) beyond parity and (b) a charter point (direct
re-poll of ~thousands of camera endpoints, new SNMPv3 secrets), it is planned
here but **gated (D10)** and scheduled **post-cutover (11.x)**, exactly like the
other charter-touching post-parity items (D4 write actions, D5 WebSocket).

**Read-only holds.** Every OID is an SNMP GET / bulkwalk against the camera's own
net-snmp agent — no writes, no new Python dependency (subprocess `snmpget` /
`snmpbulkwalk`, the same net-snmp package and pattern as `poller/snmp_inventory.py`).
CLAUDE.md §4.1 is satisfied without a carve-out.

## 2. Scope — which cameras, and what we read

**Target set — corrected 2026-07-28. The sweep unit is the HARDWARE HOST, not
the camera.** Host health (CPU, kernel uptime, filesystems, wired interface) is
a property of the physical device; several cameras can be *channels* on one.
Polling per camera would issue eleven identical walks against an eleven-imager
encoder and count it eleven times in the budget. Per-imager reads
(`camera_imagers`: encoder bitrate, VCA motion) *are* per channel — that is
what `camera.channel` is for.

Measured on the live VMS (`docs/milestone-camera-addressing.md`): **2,489
hardware records for 2,662 cameras — 2,480 sweepable targets, not ~2,659.**
2,418 cameras are the sole camera on their host; **241 cameras share 62
encoder addresses** (51 four-channel, one eleven-channel).

**Addressing is available but does not live where this spec assumed.** The
address is on the **parent hardware** (`GET /hardware` → `address`,
URL-shaped `http://10.x.x.x/`), joined via `camera.relations.parent`;
`/cameras` carries no `address`, `ip`, `mac` **or `hardwareId`** at all. The
milestone collector now writes `cameras.ip` from that join (2026-07-28) — so
"cameras pulled from Milestone" is still the discovery mechanism, but through
hardware.

⚠️ **`devices.mgmt_ip` for cameras is an OPEN OWNER DECISION and this spec must
not assume it.** Writing one shared encoder address onto N camera rows makes
them *contested* under `netmon.state.native_trustworthy`, so the poller refuses
any verdict for them and they read `unknown` forever — correct behaviour,
useless outcome. Three candidate representations are recorded in
`docs/milestone-camera-addressing.md` (populate only the 2,418 sole-claimant
cameras; add a separate `hardware_ip` column so SNMP/JPEG have a target while
the poller's IP-keyed guard is untouched; or register the 62 encoders as their
own device rows). **Until that is decided, this phase has no target column** —
resolve it before any `camera_snmp` code lands. A camera whose host has no
address, or with `snmp_capable = 0`, is skipped (rendered "SNMP not enabled").

**In scope (v1 = Bosch):** the Bosch template's item set —

| Group | Reads | Source table (§4) |
|---|---|---|
| Health | CPU avg% (calc from per-core), process count, **kernel uptime** | `camera_health` |
| Identity | vendor / model / platform code / fw short code / board fingerprint / VMS endpoint / `has_full_mib` bucket gate | `camera_health` |
| Interfaces | per-`eth*` oper status, link speed, in/out bps | `camera_interfaces` |
| Filesystems | `/data`, `/var/log` total/used/used% | `camera_filesystems` |
| Imagers | per-imager encoder bitrate/width/height/codec, VCA motion-active, alarm-detail bitmap | `camera_imagers` |

**Out of scope / render "—":** anything the camera SNMP agent does not expose
on a given model (bucket B/C — see §3); video/JPEG frames (that is the separate
D7 snapshot proxy); ONVIF/RTSP stream probing (a possible later mechanism, not
this phase).

## 3. Vendor-profile model (Bosch first, extensible)

Cameras are multi-vendor; the OID map is per-vendor. The design is a **vendor
profile registry** keyed by a match predicate, so other vendors (Axis, Hanwha,
…) are added later as new profiles without touching the sweep engine:

- A profile declares: a **match** (regex over `cameras.model` / SNMP `sysObjectID`),
  the **scalar OID set**, the **discovery walks** (interfaces, filesystems,
  imagers), the **per-string preprocessing** rules, and the **buckets** (see
  below). Bosch's match, per the template, is case-insensitive
  `^(?:bosch\s+)?(?:flexidome|dinion|autodome)`.
- Profiles live in `netmon/poller/camera_profiles/` (one module per vendor) with
  the OID tables as plain dicts, mirroring how `snmp_inventory.py` keeps its OID
  dict inline. **v1 ships exactly one profile: `bosch`.** A camera that matches
  no profile is skipped and reported (not an error) so the fleet can be rolled
  out vendor-by-vendor.

**Bucket A/B/C compatibility (Bosch).** Per the template's
`bosch.dev.has_full_mib` gate and its `M0_Bosch_Fleet_Compatibility` notes: not
every Bosch generation exposes the private branch. The profile computes a
`has_full_mib` flag (vendor+model strings both present); imager/encoder/motion
items and their alert rules are **suppressed** when it is 0 (older CPP4 5000 HD /
DINION 6000 HD, etc.), so those cameras still get health/identity/interface/FS
telemetry without the private-MIB items erroring. This is stored as a column on
`camera_health` and consulted by the alert rules (§6).

## 4. Data model — migration `020_camera_health.sql`

Companion tables keyed by `device_id`, **owned by the new `camera_snmp` collector
only** (the milestone collector keeps owning the `cameras` row — separate writers,
per §4.5 fail-loud). Replace-on-refresh, `updated_at` on every row, no history.
The Bosch string values get the **G29 strip** at write time (see §5). Rollback
note: `DROP TABLE` the four tables + `DELETE FROM schema_migrations WHERE
version='020'`.

| Table | Key | Columns (v1) | Notes |
|---|---|---|---|
| `camera_health` | `device_id` PK | vendor, model, platform_code, fw_short, board_fingerprint, vms_endpoint, cpu_pct, process_count, uptime_s, has_full_mib TINYINT, snmp_ok TINYINT, updated_at | one row per polled camera; `snmp_ok=0` + stale `updated_at` when the agent is unreachable (blind, never fabricated) |
| `camera_interfaces` | (`device_id`,`ifname`) | oper_status, speed_bps, in_bps, out_bps, updated_at | discovered by **name** (`^eth\d+$`), never by ifIndex — **G32** |
| `camera_filesystems` | (`device_id`,`fs_name`) | total_units, used_units, used_pct, updated_at | discovered by **name** (`^(/data\|/var/log)$`) — **G32** |
| `camera_imagers` | (`device_id`,`imager_idx`) | encoder_bitrate_kbps, width, height, codec, motion_active TINYINT, alarm_bitmap, updated_at | per-imager (1 row single-imager FLEXIDOME, 4 rows on 7000i multi); rows only when `has_full_mib=1` |

Rate fields (`in_bps`/`out_bps`) are computed **at write time** from the previous
raw counter stored in-row (the spec-10 §3 "counters store previous raw values
in-row so rates are state, not history" pattern) — this uses the **32-bit**
`ifInOctets`/`ifOutOctets` columns, not HC counters, per **G30**. No time series;
the 24h `state_samples` ring (Phase 10.6) is where any camera sparkline series
would live if one is later wanted, subject to its own budget.

## 5. Sweep module — `netmon/poller/camera_snmp.py`

Mirrors `poller/snmp_inventory.py` (Phase 10.1) exactly in shape:

- one supervised asyncio task **and** standalone
  `python -m netmon.poller.camera_snmp --once|--loop`;
- **concurrency-capped** (default 16 cameras in flight — cameras far outnumber
  switches; tune to the fleet), staggered so a full sweep finishes inside its
  interval;
- **per-camera failure is isolated** — its `camera_*` rows are left stale (never
  deleted), `camera_health.snmp_ok` set 0, and the collector records loud into
  `collector_health` (name `camera_snmp`). A camera that does not answer SNMP is
  a *state* (blind), not a fabrication (§4.5);
- **parsers are pure functions of `snmpget`/`snmpbulkwalk -On` text**, unit-tested
  against captured fixtures with no binaries installed (§4.8).

**Two cadences, both configurable, matching the template's macros:**

| Cadence | Reads | Default | Notes |
|---|---|---|---|
| health/inventory | scalars + interface/fs/imager discovery + encoder | `poll_interval = 5m` (`{$MS.CAM.BOSCH.POLL.INTERVAL}`) | discovery walks (if/fs/imager) can run at a slower sub-interval (1h in the template) — gated inside the task by elapsed time, like `snmp_inventory` |
| motion/alarm | `motion_active` + alarm bitmap | `motion_poll = 1m` (`{$MS.CAM.BOSCH.MOTION.POLL}`), **default OFF** | 1-minute polling across the full camera fleet is the load risk — see §8; ships disabled, enabled per-site/opt-in |

**Bosch gotchas — carried verbatim from the template into the parser/profile
(these are the hard-won pilot findings; do not re-discover them):**

- **G28** — reboot detection uses `hrSystemUptime.0` (`1.3.6.1.2.1.25.1.1.0`,
  kernel uptime), **not** `sysUpTime.0` (which resets on any snmpd config change
  and would fire false reboot alarms).
- **G29** — Bosch net-snmpd appends trailing binary garbage to OCTET STRINGs.
  Every string scalar and every LLD name (`{#IFNAME}`, `{#FSNAME}`, imager name)
  is stripped with `^([\x20-\x7E]+).*` → first non-printable byte, at write time.
- **G30** — ifXTable HC counters are zero/absent; use 32-bit
  `ifInOctets`/`ifOutOctets` with change-per-second.
- **G32** — firmware updates renumber `ifIndex` and `hrStorageIndex`; discover
  every table row by **name**, never by hardcoded integer index.
- **CPU** — no UCD `laTable` on recent firmware (kernel 5.15 track); CPU% is the
  average of the per-core `hrProcessorLoad` rows (`1.3.6.1.2.1.25.3.3.1.2`),
  matching the template's `bosch.cam.cpu.avg.pct` calculated item.
- **Encoder / motion blobs** — the per-imager encoder slot-1 blob
  (`1.3.6.1.4.1.3967.1.2.2.1.1.{idx}`) is decoded bytes 4–7 = bitrate uint32 BE,
  20–23 width, 24–27 height, 28 codec, 40 enabled; the alarm-detail bitmap
  (`…1.3.3.1.1.{idx}`) byte 0 high bit = active. Decode layouts are in the Bosch
  template descriptions (M0_Bosch_Findings §3e).

**Config `[camera_snmp]` (netmon.conf; `netmon.conf.example` gets the block):**
`enabled` (default **false**), SNMP `version`/`community` (v1/v2c) or
`v3_user`/`v3_auth_proto`/`v3_auth_pass`/`v3_priv_proto`/`v3_priv_pass` (secrets,
never in-repo — §4.6), `poll_interval`, `discovery_interval`, `motion_enabled`
(default false) + `motion_poll`, `concurrency`, `timeout_s`, `retries`. Reuses
the `[poller]` SNMP binary paths. Per-sweep enable + per-step reversibility (§4.3).

**⚠ Operator prerequisite (document in the runbook):** SNMP must be enabled on
each camera (Configuration → Service → SNMP). Recent Bosch firmware ships
SNMPv1/v2c **disabled** by default; either enable it or provision a dedicated v3
read-only user — the default `service` account has no SNMP access.

## 6. Alerts — port the template triggers as NetMon `alert_rules` (shadow first)

Per §4.2 (dry-run/shadow default) and §4.8 (rule-eval unit tests before live),
the Bosch template's triggers become NetMon `alert_rules` seeded by a migration,
evaluated by the existing engine in **shadow mode** until the owner flips it:

| Rule | Condition (from the template) | Severity | Bucket gate |
|---|---|---|---|
| Camera rebooted | kernel `uptime_s < 10m` | info | — |
| CPU sustained | `cpu_pct > 90%` for 15m | warn | — |
| Process count low | `process_count < 80` and `uptime_s > 10m` | average | — |
| Interface down | interface `oper_status = down (2)` | warn | — |
| Encoder stalled | encoder `bitrate_kbps < 100` avg 15m | info | `has_full_mib = 1` only |

Bucket-gated rules must not fire on bucket-B/C cameras (they would just be noise);
the engine consults `camera_health.has_full_mib`, mirroring the template's
`and last(bosch.dev.has_full_mib)=1` guard. Whether any of these feed the shared
`device_state`/`state_events` model (vs. living purely as `alert_rules` over the
`camera_*` tables) is **Q1 below** — spec 10 §3 kept the `device_state` dimension
enum fixed, so the default assumption is *no new dimension*; reboots/interface-down
surface as alerts, not as a new state dimension, unless the owner wants otherwise.

## 7. API + UI

- **API:** extend the existing surveillance router — `GET /api/surveillance/cameras/{id}`
  gains a `health` block (identity, cpu/uptime/process, interfaces[], filesystems[],
  imagers[]) joined from the `camera_*` tables, each carrying `updated_at` +
  `camera_snmp` `collector_health` freshness so the UI badges staleness (§6 of
  spec 10). Optionally `GET /api/surveillance/cameras` gains a `snmp_ok` column
  for a fleet health roll-up. All read-only, DB-only, viewer role.
- **UI (camera detail page, spec 10 §7 surveillance note):** add a **Health**
  section — CPU / kernel-uptime rings, per-`eth` interface KV (status + speed +
  in/out bps), filesystem bars for `/data` `/var/log`, and a per-imager card
  (encoder bitrate, resolution/codec, VCA motion indicator). This is precisely
  the "stream-health rings only if … probing is added later" slot spec 10 left
  open. **Degrade honestly:** a camera with `snmp_ok = 0` renders "SNMP not
  enabled / not reachable" with the last-good timestamp — never a fabricated 0.

## 8. Load / budget sanity (validate before enabling — Phase 0 rule)

- Fleet is far larger than the switch fleet: **2,480 hardware targets vs 160
  switches — ~15×** (count corrected 2026-07-28; the earlier ~2,659 figure
  counted cameras rather than hosts, over-stating the load by ~7% and, worse,
  implying eleven walks against one eleven-imager encoder). Health poll at 5m
  with concurrency 16 is comfortable (a handful of `snmpget`+small walks per
  **host**). The **1-minute motion poll is the risk** — hence default-off and
  per-site opt-in; measure a real sweep (`--once` timing) at fleet scale before
  enabling broadly, exactly as 10.1 required for the switch sweeps.
- **Deduplicate by host before sweeping.** A naive per-camera loop would poll
  the 62 shared encoder addresses 241 times instead of 62 — and the sweep must
  refuse to attribute a host-level reading to a camera row in a way that
  fabricates per-camera state, the same trap `native_trustworthy` guards for
  ping/snmp.
- FS/interface/imager **discovery** walks are the expensive part → slow
  sub-interval (default 1h), gated by elapsed time inside the task.
- Capture sanitized `snmpbulkwalk`/`snmpget` fixtures from one lab Bosch camera
  (5100i single-imager + a 7000i multi-imager if available) into `tests/fixtures/`
  before any live enablement.

## 9. Definition of Done (when the phase is built)

- [ ] ⛔ D10 signed off by owner.
- [ ] `020_camera_health.sql` + rollback note; runner applies it.
- [ ] `netmon/poller/camera_snmp.py` + `camera_profiles/bosch.py`; supervised +
      `--once/--loop`; per-camera fail-loud into `collector_health`.
- [ ] Pure parsers unit-tested against captured Bosch fixtures (G28–G32 covered).
- [ ] Alert rules seeded + rule-eval unit tests; engine stays in **shadow**.
- [ ] `[camera_snmp]` in `netmon.conf.example`; `enabled=false`, `motion_enabled=false`.
- [ ] Surveillance API `health` block + camera-detail Health section (honest
      staleness/blind rendering); UI rebuilt.
- [ ] Collector README (`netmon/poller/README.md` addition) — OIDs, intervals,
      the Bosch gotchas, and the SNMP-must-be-enabled prerequisite.
- [ ] Runbook note (`docs/runbooks/`) for enabling SNMP on the fleet + rollout.

## 10. Open questions (do not guess — track for owner)

- **Q1 — device_state vs. alerts-only.** Should "camera rebooted / interface
  down" write a `device_state` dimension (schema change to the fixed enum) or
  stay purely `alert_rules` over `camera_*`? Recommendation: **alerts-only** v1
  (no enum change), consistent with spec 10 §3.
- **Q2 — SNMPv3 at fleet scale.** If the fleet standardizes on v3, credentials
  are uniform (one `[camera_snmp]` v3 user) — confirm the cameras allow a shared
  RO v3 user, or whether per-camera creds are needed (would need a secrets story
  beyond a single config block; flag if so).
- **Q3 — non-Bosch vendors.** Which other camera vendors are in the fleet, and
  do we have (or need to capture) their MIBs before writing their profiles?
  v1 covers Bosch only; others no-op until a profile exists.
- **Q4 — motion polling scope.** Is sub-minute VCA motion actually wanted in
  NetMon (vs. left to Milestone's own event/alarm path via D5 WebSocket)? If the
  D5 alarm feed covers it, the 1-minute motion poll may be droppable entirely.

## Next session

- Awaiting ⛔ **D10** sign-off (spec 11 §6). Nothing is coded until then; the
  Bosch template is committed as the reference artifact and this spec is the
  design of record. Build order once approved: migration `020` → `camera_snmp`
  sweep + `bosch` profile (fixtures first) → alert rules (shadow) → API + UI.
- Confirm Q1–Q4 with the owner; capture Bosch fixtures from a lab camera.
