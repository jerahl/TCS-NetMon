# Spec 19 — Camera Ops

**Status:** IN PROGRESS (started 2026-09-02)
**Supersedes:** the standalone-app boundary recorded in OpenProject **#117**
**Relates to:** spec 13 (D10 direct camera SNMP), spec 11 D7 (JPEG proxy),
spec 14 D-4/D-5/D-6 (surveillance count and storage defects), spec 15 §2·17–21.

---

## 1. The boundary decision was reversed by the owner

Camera Ops was designed as a **standalone** VMS operations app that would sit
*alongside* NetMon and be collected by it as a read-only federated source, like
XIQ or PacketFence. The handoff of 2026-09-02 states that plainly — *"camera-ops
decides; NetMon delivers"* — records that it was argued out over several turns,
and warns against reopening it without reading OpenProject #117.

**The owner reversed it on 2026-09-02:** Camera Ops is now a sub-project of TCS
NetMon, built inside this repository. The reason is specific and worth keeping,
because it is what made the original split look necessary:

> It was a separate app because I thought it may need direct DB access to
> Milestone, but it does not.

Direct access to the Milestone `Surveillance` database was the one requirement
NetMon's architecture could not absorb — CLAUDE.md §1 federates from source APIs
and §4.1 keeps every integration read-only through a published interface. With
that requirement gone, the separation bought nothing and cost the usual price of
two codebases: two collectors against the same Config API, two config files, two
sets of credentials for `co-milestone`.

**This spec, not #117, is now the record.** #117 was read in full on 2026-09-03
once the OpenProject connector was fixed, and it is more specific than the
handoff suggested — it uses the phrase "sub-project" in the narrow OpenProject
sense and explicitly pre-empts the reading the owner has now confirmed:

> **Nested for organisation only** — it remains a **separate application**, with
> its own repository, database, deploy and release cycle. […] it does not make
> camera-ops a NetMon module.

The owner confirmed on 2026-09-03 that the merge reading is the current one, so
that paragraph and everything built on it is superseded. What #117 lists as
**leaving** NetMon therefore **stays**:

- Milestone schema mapping (`/cameras`, `/hardware`, `/recordingServers`,
  `/storages`) — including the storage walk fixed in §4 below
- camera addressing for ~2,659 cameras
- **D7** camera JPEG snapshot proxy
- **D5** ESS WebSocket schema mapping
- the Milestone portion of the payload-harness cutover gate
- **D10** camera SNMP (spec 13), with its poller load assessment

Two NetMon work packages exist only to serve the separate-app architecture and
are void under this decision:

| WP | Subject | Disposition |
|---|---|---|
| **#122** | Build `netmon/collectors/camera_ops.py` federated source | void — there is no second app to federate from |
| **#123** | Drop migration 013 camera tables, retire the Surveillance page | void — and actively harmful: §4 has just made those tables carry real data |

#123 is the one to catch early. It would drop `cameras` and `recording_servers`
and retire the Surveillance page — the exact tables and page that now hold the
storage roll-up. Its own rollback note calls the drop clean because the tables
are "re-swept within minutes with nothing to export", which was true when they
were empty and is not the point any more.

Not yet done, and needing the UI either way: Camera Ops (project 5) still has
**no parent set** — confirmed 2026-09-03. `create_project` can set a parent only
at creation and the connector has no `update_project`.

What does **not** change: the Milestone integration stays read-only through the
Config API, and everything in the old M7 (write actions) stays gated behind the
same D4 chokepoint as the four existing operator actions.

## 2. Work carried over from the standalone project

The standalone code — `cameraops/milestone/addressing.py`, `client.py`,
`config.py`, `milestone_storage_state.py` and three test suites — lives on the
owner's workstation at `C:\Users\sappleby.TCS\Documents\CoWork\projects\camera-ops\`
and is **not reachable from the deploy host**. It has been unit-tested but never
run against the live server. Bringing it across is a separate step; where NetMon
already has a working equivalent (a Config API client, a config loader, a
migration runner) the NetMon one should win rather than be duplicated.

The driver is unchanged and dated: the Boring Toolbox demo it replaces is
licensed for 48 of ~2,486 hardware and **expires 2026-09-30**, not being renewed.

## 3. Findings established before the merge, which still hold

These came out of the standalone work and are settled. Do not re-derive them:

- **Archive retention is cumulative from recording, not additive.**
  `MAX(retainMinutes)`, never `SUM`. Now pinned by a NetMon test.
- **There is no `GET /storages` collection endpoint.** Only `/storages/{id}`,
  `/storages/{id}/archiveStorages` and `/recordingServers/{id}/storages`.
- `disabled` is the only declared query parameter on Config API collections;
  `page`/`size`/`includeChildren` work on some builds and 400 on others. Ask
  bare first.
- **Neither the Config API nor the MIP SDK exposes disk capacity.** Verified
  against the full OpenAPI spec and all 22 `VideoOS.*` assemblies. Hence WinRM
  (`Win32_LogicalDisk` over Kerberos) — *not* impacket or WMI-over-DCOM, which
  from a Linux host against 22 Windows servers looks like lateral movement to
  Cortex XDR.

## 4. Done 2026-09-02 — the storage roll-up

NetMon's storage roll-up read `0 / 0 GB` for the whole estate (spec 14 D-5,
spec 15 §2·17–21). The cause is finding #2 above: `milestone_client.storage()`
called `GET /api/rest/v1/storages`, which returns **400**, and the collector
caught it and reported a clean cycle over an empty roll-up.

Both halves verified live before changing anything: `/storages` → 400,
`/recordingServers/{id}/storages` → 200.

The walk is now per recording server — 22 calls plus one per live storage for
its archives, 44 GETs on this estate. Two unit errors were fixed with it, and
both had rendered as plausible numbers rather than as errors:

- **`maxSize` is megabytes, not bytes.** NHS's live storage reads 103,014,400,
  which is its 100,600 GB (`/1024`). Dividing by 1e9 gave 0 GB for every
  recorder on the estate.
- **Retention is `MAX`, not `SUM`** (finding #1). Summing NHS's 45-day live and
  61-day archive would claim 106 days where it keeps 61.

`used_gb` stays **NULL**, not 0: the Config API exposes configured size but not
consumed space. A 0 would render as "nothing used" on a NOC wall. Consumed space
is the WinRM dependency.

Result — 22 of 22 recorders now carry configured storage and cumulative
retention, **1,837,600 GB** across the estate:

| recorder | live GB | archive GB | total GB | live retention | cumulative |
|---|---|---|---|---|---|
| NHS-BCD-DVR | 100,600 | 20,000 | 120,600 | 45 d | 61 d |
| CHS-BCD-DVR | 98,000 | 20,000 | 118,000 | 30 d | 61 d |
| bhs-bcddvr-ms | 87,000 | 20,000 | 107,000 | 30 d | 61 d |
| TRAN-BCD-MS | 85,000 | 20,000 | 105,000 | 30 d | 61 d |
| … | | | | | |
| TMS-BCD-DVR | 45,000 | 0 | 45,000 | 30 d | 30 d |

This reconciles the handoff's two retention figures, which look contradictory
and are not: **30 days everywhere with NHS at 45** is the *live* storage
setting, and **61 days** is the cumulative total once the archive is counted.
Both are true; they answer different questions. The retention-SLA question the
handoff flags for the owner should be asked about the cumulative figure.

## 5. Next — and what is blocked on what

- **#108 live addressing validation** — the read-only half is done and the
  evidence is captured (`/hardware`, 2,489 records, sanitised). Headline: every
  address is `http://<ipv4>/`, and **6 carry an explicit port — five of them
  `:443` on an `http` scheme**, which is the case a hand-built fixture will not
  have. Checking `addressing.py` against it needs the code, which is on the
  workstation.
- **Over-committed storage** — the handoff's standing production exposure (five
  recorders configured larger than their disk; nothing watching it). The
  *configured* half is now collected; the *disk* half needs WinRM (#111). Until
  then NetMon can show configured size and retention but cannot compute the
  shortfall, and must not imply it can.
- **Blocked on the owner, unchanged:** XProtect version (gates the M8 video
  strategy), WinRM access to the 22 recorders, and the retention SLA.

## 6. M0 addressing — 2026-09-03

The owner corrected the model this rests on, and the correction is load-bearing:

> There are multi-camera devices. One device, one ip, but with multiple cameras.
> not encoders.

Confirmed live. `10.88.18.190` is a **single hardware record** — an AXIS M3007
panoramic — with **eleven** child cameras on channels 0–10. Fleet-wide: 2,423
hardware carry one camera and **61 carry more** (3×2, 6×3, 51×4, 1×11). The
2026-07-28 investigation called these encoders; they are multi-imager cameras,
and the distinction matters because an encoder is a separate box while these are
one device that is up or down as a unit.

### Why NetMon could not see it

`devices.milestone_hardware_id` holds the **camera** GUID — 0 of 2,659 are
hardware ids. That is correct for its actual job (registry↔entity linkage) but
means nothing recorded which physical device a camera belongs to. Consequences:

- the poller's contested-address guard counted 11 camera rows sharing one AXIS
  as 11 rival claimants and refused every verdict;
- D10's SNMP unit could not be the physical host, so a sweep would issue 11
  identical walks against that camera and store 11 copies of its CPU.

### Done

Migration `022` adds `cameras.hardware_id` and `cameras.http_port`, populated
from the hardware parent. The registry linkage key is left alone — it works, and
repurposing it would break entity matching.

| | |
|---|---|
| cameras with `hardware_id` | 2,651 / 2,651 |
| distinct physical devices | **2,473** |
| multi-camera devices | 61 |
| cameras with a non-default HTTP port | 6 (five `:443`, one `:8080`) |

The port is the #108 finding landing: five addresses are `http://<ip>:443/`, an
http scheme on the TLS port. Inferring scheme from port contradicts the field;
dropping the port sends D7's proxy to the wrong socket.

### What this settles, and the one thing it does not

The shared-address problem is now measurable rather than assumed: **61 of the 62
shared IPs are a single physical device**, so the guard's contention there is a
false positive. Keying it on the physical device instead of the IP string would
preserve exactly the protection it was built for — the 2026-07-28
`oak-DEAD`/`DEAD_AP` incident was two *different* devices on one address — while
letting 239 cameras receive an honest verdict.

**The 62nd is a real conflict, and it is a data problem worth fixing:**
`10.132.18.209` at Northridge High carries two distinct hardware records, a Bosch
FLEXIDOME 5000i and a 5100i. Almost certainly a replaced camera whose old
Milestone record survived — the same pattern as the duplicate `192.168.100.253`
switch registry entry. The guard is right to refuse both until one is removed.

### Still the owner's call

Populating `devices.mgmt_ip` for cameras remains open, because it is not only a
schema question:

- it takes the ICMP sweep from ~935 targets to ~3,586, nearly 4×;
- it starts raising ping alerts on a fleet that already carries 2,659 open
  `source_blind` alerts, on top of the unresolved camera-noise decision
  (spec 16 C3);
- with the guard unchanged, 239 of those cameras would sit at `ping = unknown`
  forever.

The guard change and the `mgmt_ip` population should be decided together, since
each is much less useful without the other.

### M0 landed 2026-09-03 — addresses in the registry, cameras out of the ICMP sweep

`devices.mgmt_ip` is now synced from the Milestone hardware address for **2,651
cameras**, so D7's proxy and D10's sweep have a target. Milestone is
authoritative, so the collector syncs rather than fills-if-empty; only changed
rows are written.

**The contested-address guard now counts physical devices, not rows.** With
`cameras.hardware_id` available, eleven channels of one AXIS are one claimant,
while two *different* devices on one address still disagree. Contested rows fell
from what would have been 239 cameras plus 28 pre-existing, to **30** — one real
camera conflict (10.132.18.209) and 14 pre-existing **AP** address duplicates
that have nothing to do with cameras and are worth cleaning up separately.

**Cameras are excluded from the ICMP sweep**, on evidence rather than caution.
The first sweep with addresses gave 2,456 up and **193 down — every one of which
Milestone reports actively recording**, spread across every site rather than one
subnet. So a non-answer means the model does not do ICMP, not that the camera is
down, and `device_down` (rule 3, crit) would have raised 193 provably-wrong
criticals. `[poller] ping_exclude_device_types` defaults to `camera`; clearing it
sweeps everything. SNMP is untouched — it gates on `snmp_capable`, which no
camera carries, so D10's load assessment is not bypassed.

Sweep cost is unchanged: 935 verdicts in 11.7 s, 19% of the 60 s interval. With
cameras included it was 3,584 in 47.1 s — 78%, which is workable but leaves
little margin and would need the interval raised.

### Two operational findings from doing it

**The poller is its own systemd unit.** `[poller] in_process` is false and
`netmon-poller.service` runs the sweep with `AmbientCapabilities=CAP_NET_RAW` —
the durable fix for netmon.service's sandbox stripping it. That unit had been
running **since 29 July**, so `systemctl restart netmon` did not reload the
guard: it kept writing camera verdicts from five-week-old code. Both units need
restarting after touching `netmon/poller/`.

**Sequencing matters more than it looks.** Populating `mgmt_ip` on the live
database *before* the exclusion was deployed gave the running poller a window in
which to sweep cameras, and the engine opened **174** false crit alerts from it.
Shadow mode held — 174 notifications recorded, **0 sent** — so nothing reached a
human, which is precisely what shadow-first is for. The alerts were closed and
the state rows removed. The order should have been: deploy the guard, restart
both units, *then* populate.

## 7. M1 — Inventory and state (started 2026-09-03)

OpenProject **#92**. Its only tracked child is **#111** (recorder host health via
WinRM/CIM), which is blocked on access the owner has to grant, but M1's own
description covers more — and one line of it corrects what §6 had just done:

> **ICMP is ground truth and tiebreaker.** Milestone reporting a camera online
> while the network says otherwise is the disagreement worth surfacing, not
> hiding — and it is why state carries which probe produced it.

Excluding cameras from the ICMP sweep hid exactly that. It was the right stopgap
while `device_down` could misread the silence, but the wrong end state.

### Rules can now be scoped by device type

Migration `023` adds `alert_rules.device_types` (NULL = fleet-wide, so every
existing rule is unchanged) and the engine narrows a rule's state query to those
types. `device_down` is scoped to `switch,ap,recording_server,trunk,pbx,other` —
cameras deliberately absent.

That inverts the stopgap: cameras are **back in the ICMP sweep**
(`ping_exclude_device_types` is now empty) so the fact is recorded, and the rule
declines to read it as an outage. A dimension that means different things to
different hardware needed the rule to say which hardware it meant, rather than
the sweep pretending the hardware does not exist.

### The disagreement, now visible

| | |
|---|---|
| cameras answering ICMP | 2,454 |
| cameras silent on ICMP | **195** |
| of those, Milestone reports recording | **195 — all of them** |
| false `device_down` alerts raised | **0** |

195 cameras are recording video while not answering ping. Two readings — the
model does not implement ICMP, or something on the path blocks it — and either
way it is a fact about the estate rather than an outage. The useful signal from
here is *change*: a camera that answered yesterday and stops has told you
something, and `state_events` is where that shows up.

### Still blocked on the owner

- **#111** — WinRM to the 22 recorders (JEA endpoint or an account scoped to
  `root/cimv2`, 5986/tcp). This is the third evidence path in M1's own table and
  the only one NetMon cannot reach.
- XProtect version, which gates M8's video strategy.
- The retention SLA, which decides whether a shortfall is an alert or a report
  line — and should be asked against the **cumulative** figure (§4).

## 8. M2 — Storage and retention (2026-09-03)

OpenProject **#93**. The differentiator: how many days of video actually sit
behind each camera.

### XProtect version answered — 2025 R2

The owner supplied it and the Config API corroborates: all 22 recorders report
`25.2.16119.1`. That **unblocks M8's video strategy**, which the handoff had
gated on it — WebRTC needs 2023 R1 and playback 2023 R3, so both are available
with two years to spare. It also removes "old version" as an explanation for
anything missing below: 25.2 is current.

### M2's input table needs correcting: two of three are unavailable, not one

#93 lists three inputs and marks only the third as unreachable:

| Input | #93 says | Actually |
|---|---|---|
| Configured retention (`retainMinutes`) | Config API | ✅ collected (§4) |
| Used space (`storageInformation.usedSpace`) | Config API | ❌ **not present on 2025 R2** |
| Physical volume size | WinRM #111 | ❌ blocked, as stated |

Probed read-only against the live gateway:

- the storage object carries 13 fields and the only size-shaped one is
  `maxSize` — configured, not used;
- `GET /storages/{id}/storageInformation` and
  `/recordingServers/{id}/storageInformation` both answer **400**;
- the storage's `relations` holds only `parent` and `self` — no usage
  sub-resource to follow;
- the recordingServer object's 20 fields include nothing about space;
- no OpenAPI document is served, so there is no index to check against.

**Consequence: `spaceCapped` is blocked too, not just `overCommitted`.** #93
treats used-vs-max as the check that works today and over-commitment as the one
waiting on #111. Neither works today. Both flags stay `null`, and — following
#93's own rule — **null, never `false`. An unknown is not a pass.**

### Where used space probably lives

Usage is *state*, not configuration, and the Config API is by name and behaviour
a configuration API. The likely home is the **Events/State (ESS)** interface —
the same one D5 wired the transport for and whose schema mapping was
deliberately deferred until it could be observed rather than guessed. That makes
M2's used-space input and D5's schema work the same task, which is worth knowing
before either is scheduled separately. Stated as a hypothesis: it has not been
probed.

### Corrected on the Surveillance page

The page previously said consumed space "needs WinRM against the recorders".
That conflated two different unknowns: **used space** is Milestone's figure for
how much video is stored, and **volume size** is the disk's capacity from WinRM.
Only the second is a WinRM question. The page now names the actual gap.
