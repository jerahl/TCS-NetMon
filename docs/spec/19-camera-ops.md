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

### Retention SLA answered — 30 days, with older video offloaded to Wasabi

The owner supplied this on 2026-09-03, closing the third of the handoff's
blocked-on-owner questions. It resolves how to read the numbers in §4 and
introduces a gap none of the interfaces can see.

**Against a 30-day SLA, configured retention meets it everywhere — with no
margin.** Live storage is 30 days on 21 of 22 recorders (NHS 45), so the SLA
sits exactly on the configured boundary. Anything that causes early deletion
puts a recorder *under* SLA, and that is precisely what over-commitment does:
XProtect deletes early when the volume fills, whatever `retainMinutes` says.

The five over-committed recorders (§ #93) therefore matter more, not less, now
the target is known. **TMS-BCD-DVR is the sharpest case**: 30-day live, **no
archive at all**, and over-committed — the only recorder with no second tier
absorbing an early deletion.

### Wasabi is invisible to every interface available

Every storage path on the estate is a local drive letter:

```
D:\Archive   D:\MediaDatabase   E:\Archive   E:\MediaDatabase
```

That is the complete set across all 22 recorders and their archives. **No cloud
tier appears anywhere in Milestone's storage configuration**, so whatever moves
video to Wasabi runs outside Milestone's archive chain — Milestone does not know
the tier exists.

Consequences worth stating before anything is built on them:

1. Milestone's retention figures (30 d live, 61 d cumulative) describe **local**
   retention only. They are not the total video available.
2. The **ImageServer probe (#112)** asks Milestone "is there video at
   *now − 30 days*". It can only answer for video Milestone can serve. If a
   frame has been offloaded and Milestone is not configured to retrieve it, the
   probe reads "no video" for a clip that exists in Wasabi — a false shortfall.
3. Conversely, if the offload *moves* rather than copies, local retention could
   fall below 30 days while the SLA is still met from Wasabi — and nothing in
   NetMon would see the cloud copy.

So the SLA is verifiable **against local storage** and not against the estate as
a whole, until it is known how the offload is wired: whether it copies or moves,
whether Milestone can retrieve from it, and what holds the catalogue. That is an
owner question, and it is the one that decides whether #112 measures the SLA or
only the local half of it.

### #112's stated blocker is now clear

#112 is "blocked on camera addressing validating against live data (#108)".
§6 populated `mgmt_ip` for 2,651 cameras from validated live payloads, so that
dependency is met. The probe itself — raw TCP to the recorder on 7563, XML
request, token auth, one `goto` at the SLA boundary per camera — needs no SDK,
no Windows and no second runtime, and it answers M2's headline question without
either of the two blocked inputs (used space, volume size).

It is the highest-value remaining M2 item, and the Wasabi question above governs
how its answer should be read.

### Wasabi offload is out of scope (owner, 2026-09-03)

A separate application handles it. That resolves the ambiguity above rather than
leaving it open, and the picture is coherent: the offload takes video **older**
than the SLA window, so within 30 days the video is local and Milestone can
serve it. **#112's answer is therefore the SLA answer**, not half of it — the
false-shortfall risk in the previous section does not arise.

camera-ops verifies local retention against a 30-day SLA. Long-term cloud
retention belongs to the other application and is explicitly not modelled here.

### #112 — reachable, but it is original protocol work

Two things established 2026-09-03:

**The port is open.** TCP 7563 answers on every recorder tested (ALB, ARC, BHS,
CES, CHS, CO), so the probe is viable from the NetMon host — no firewall change
needed, unlike #111's WinRM.

**The server waits for the client.** Connecting and listening yields no banner,
so the client speaks first and an implementation must open with a handshake
rather than parse a greeting.

**There is no prior art in this repository.** Grepping `reference/`, `scripts/`
and `netmon/` for the port or the protocol name returns one false positive — a
UUID that happens to contain `7563`. The owner's Zabbix collectors cover the
Config API and the ESS, not ImageServer, and #112 itself is unbuilt on the
camera-ops side too ("not built: everything from M1 onward"). So the ImageServer
client is **new protocol work against an undocumented-here wire format**, not a
port of something existing.

That is worth its own scoped session rather than a tail-end implementation:
the format has to be established before code is written, and a probe that
misreads a response would answer M2's headline question wrongly rather than not
at all. The groundwork it needed is done — addressing (§6), the SLA, and the
scope boundary above.

## 9. WinRM readiness — measured 2026-09-04

`scripts/winrm_check.py` answers what #111 needs to know before an account is
provisioned. It sends no credentials: WinRM answers an anonymous `POST /wsman`
with `401` and a `WWW-Authenticate` header, so listener presence and offered
auth mechanisms are readable unauthenticated. One TCP connect and one
unauthenticated POST per host — what any monitoring probe does. **Not impacket
and not WMI over DCOM**, for the Cortex XDR reason in §3.

Result across the 22 recorders:

| | |
|---|---|
| WinRM listening | **19** |
| auth offered | `Negotiate, Kerberos` on all 19 — no Basic, no NTLM-only |
| serving WinRM on **5986** (what #111 specifies) | **0** |
| serving WinRM on **5985** | **19** |
| not reachable | 3 |

**#111's port assumption does not hold — more completely than a first read
suggested.** It specifies 5986/tcp. Eighteen recorders refuse that port
outright, and the four that *accept* a TCP connection (`arc`, `nms`, `okd`,
`sky`) **reset during the TLS handshake**, so nothing is serving WinRM behind
it. An open port is not a listener, and counting it as one would have sent the
implementation at a socket that hangs up.

Every working listener is plain 5985. That is still usable — Negotiate/Kerberos
encrypts the payload at the message layer, so 5985 is not cleartext — but the
ticket's port should change to 5985 rather than the deviation being discovered
mid-implementation.

Per-recorder provisioning worklist: `docs/design/winrm-provisioning-worklist.md`.

The three unreachable ones fail in two different ways, and the difference is the
actionable part:

- **`sve-bcd-dvr`, `tran-bcd-ms` — refused on both ports.** The host answers and
  nothing is listening: WinRM is not enabled there.
- **`co-bcd-dvr` — timeout on both.** Packets dropped, so a firewall between the
  NetMon host and that recorder rather than a recorder setting.

All three are otherwise healthy — ping up, Milestone reporting them up — so this
is specifically a WinRM gap, not a dead host.

### What the script deliberately cannot do

It does not authenticate, and it says so. This host has no WinRM client, no
Kerberos (`/etc/krb5.conf` absent) and no `pywinrm`. A listening port and an
offered mechanism are necessary, not sufficient. To go further, in order:

1. an account — a JEA constrained endpoint, or one scoped to the `root/cimv2`
   namespace, which is all `Win32_LogicalDisk` needs;
2. a client on this host. `pywinrm` is the ordinary choice and is **a new
   dependency requiring sign-off** (CLAUDE.md §3);
3. for Kerberos rather than NTLM, `/etc/krb5.conf` for the domain and a keytab
   or ticket for the service account.

## 10. D5 — the ESS, run live for the first time (2026-09-04)

D5 wired the Events/State transport in July against a fake, and deferred the
schema mapping *"until it could be observed rather than guessed"*. Running it
against the live VMS found three bugs in the client and produced the evidence
the mapping needs. None of the three could have been caught by a fixture.

### Three bugs, each of which looked like something else

1. **Wrong path — `/api/ws/events`, missing the version segment.** The gateway
   answers **404** at the HTTP upgrade, before any ESS command is sent. The real
   path is `/api/ws/events/v1`
   (`reference/zabbix/milestone/milestone_ess_state.py:13`).
2. **`addSubscription` sent no `filters`, and was accepted.** An unfiltered
   subscription subscribes to **nothing**: the handshake reported success and
   45 seconds passed without a frame, against an estate of 2,659 cameras. A
   green handshake was not evidence of a working stream. The filter shape is
   `{modifier: "include", resourceTypes, sourceIds: ["*"], eventTypes: ["*"]}`.
3. **The 1 MiB frame limit closed the socket on the first real reply.** This
   estate's `getState` snapshot is **4,253,984 bytes**, and `websockets` closes
   with 1009 above its default — so the failure presented as a dropped
   connection rather than a size problem. `max_size` is now 32 MiB, with
   headroom because the snapshot grows with the camera count.

A fourth thing was not a bug but a misreading: **the `getState` reply *is* the
state snapshot.** The client sent the command and discarded the response,
waiting for state to arrive as events. It never would. The reply is now kept.

### The mapping evidence

`getState` over `resourceTypes: ["cameras"]` returns **16,406 states** for 2,659
cameras — CloudEvents-shaped, `{id, source, specversion, stategroupid, time,
type}`, with `source` as `cameras/<guid>`. Across them: **9 state groups and 21
distinct (stategroupid, type) pairs**, the largest four covering ~2,300–2,500
cameras each, which is the shape of a per-camera status dimension.

Those GUIDs are what still need naming — which is "Communication OK", which is
"Recording Started", which is "Motion". The reference ships a
`--list-stategroups` diagnostic for exactly this reason, so the naming is a
lookup against this install rather than a guess. **The pairs are recorded in the
commit; nothing has been mapped onto `device_state` yet**, because inventing a
meaning is the failure §4.5 forbids and is precisely what D5 deferred.

### What the ESS carries, and what it does not

| `resourceTypes` | Accepted | States |
|---|---|---|
| `cameras` | yes | **16,406** |
| `hardware` | yes | **2,368** |
| `recordingServers` | yes | **152** — 9 pairs across all 22 recorders |
| `storages` | yes | **0** |
| `servers` | yes | 0 |

**This settles §8's hypothesis, against it.** Used space is *not* in the Events/
State interface: `storages` is an accepted resource type that returns nothing.
So M2's second input is unavailable from both Milestone interfaces, and
`spaceCapped` stays blocked rather than merely unimplemented.

`recordingServers` returning 152 states across all 22 is the consolation, and
possibly a real one: the D10 investigation found the SDK exposes disk *events*
(`RunningOutOfDiskSpace`, `ArchiveDiskAvailableMessage`) even though it exposes
no capacity API. If one of those nine pairs is a disk-pressure state, it would
give M2 an actionable signal without a byte count — worth checking when the
GUIDs are named.

## 11. The ESS state map, resolved (2026-09-04)

The GUIDs are named, and **authoritatively rather than by inference**: the Config
API's `/api/rest/v1/eventTypes` returns 590 event types carrying `id`, `name`,
`displayName` and `stateGroupId`, which is the lookup
`reference/zabbix/milestone/milestone_ess_resolve.py` was written to perform.
So D5's mapping is a join, not a guess.

### Cameras — 9 groups, 21 states, 16,406 rows

| State | Group | Cameras |
|---|---|---|
| MotionStopped / MotionStarted | Motion | 2,504 / 5 |
| **CommunicationStarted** | Communication | **2,425** |
| **CommunicationError** | Communication | **97** |
| **CommunicationStopped** | Communication | **12** |
| FeedOverflowStopped / Begin | FeedOverflow | 2,312 / 13 |
| LiveClientFeedTerminated / Requested | LiveClientFeed | 2,308 / 117 |
| **RecordingStopped** | Recording | **1,846** |
| **RecordingStarted** | Recording | **665** |
| Recording FPS Critical / Warning / Normal / Undefined | Recording FPS | 1,259 / 170 / 577 / 44 |
| Live FPS Critical / Warning / Normal / Undefined | Live FPS | 1,134 / 18 / 847 / 45 |
| ManualRecordingStopped | ManualRecording | 3 |
| Disabled | Disabled/Enabled | 5 |

### Recording servers — 9 states, all 22 covered

| State | Recorders |
|---|---|
| Retention time **Normal** | **22 — all** |
| CPU Usage Normal | 22 |
| CommunicationStarted | 22 |
| **Service Available Critical** | **11** |
| Service Available Normal | 11 |
| GPU Memory / Rendering / Decoding Undefined | 21 each |
| DatabaseDiskAvailable | 1 (WFS only) |

### What this changes for M2

**`Retention time Critical/Normal` is a Milestone-native retention signal, and
it needs no WinRM.** §8 concluded that both of M2's remaining inputs were
unreachable and the flags were stuck at `null`. That holds for the *numbers* —
used space and volume size are still unavailable — but Milestone is evaluating
retention itself and publishing a verdict, and every one of the 22 currently
reads **Normal**.

That is not the same as the byte-level `spaceCapped`/`overCommitted` pair, and it
must not be presented as if it were: it is Milestone's own judgement, computed
against thresholds NetMon cannot see. But it is an actionable signal available
today, on an estate where five recorders are configured larger than their disk
and the SLA sits exactly on the 30-day boundary. Worth wiring before the byte
counts, not after.

### Live findings worth acting on independently of any build

- **11 of 22 recorders report `Service Available Critical`** — ALB, ARC, CES,
  CHS, EMS, NHS, OKH, RQS, SKY, TMS, bhs. Half the estate. All are otherwise
  healthy (ICMP up, Milestone reporting them up, recording), so this is a
  specific sub-service rather than a down recorder, and **what it names should be
  established before it is alerted on** — but half an estate in a critical state
  that nothing is watching is the same shape as the over-committed storage
  finding.
- **1,259 cameras in `Recording FPS Critical`** and 1,134 in `Live FPS
  Critical`, against 577 and 847 Normal respectively.
- **109 cameras with communication problems** (97 `CommunicationError`, 12
  `CommunicationStopped`). Compare the 195 that do not answer ICMP (§7): the
  populations differ, which is exactly the cross-source disagreement M1 wants
  surfaced rather than averaged.

### A correction this makes available

NetMon's `recording` dimension currently reads **up for all 2,659 cameras**,
because it is derived from the Config API's `recordingEnabled` — a
*configuration* flag. The ESS reports **1,846 `RecordingStopped` against 665
`RecordingStarted`**, which is *state*. Those answer different questions and the
current dimension is answering the less useful one.

Not changed here: motion- and schedule-triggered recording means "stopped right
now" is normal for most cameras most of the time, so mapping `RecordingStopped`
onto `recording = down` would manufacture an outage out of ordinary operation.
The distinction needs deciding before it is wired — which is the same reason D5
deferred the mapping in the first place.

## 12. Camera status from the ESS — the alert storm, resolved (2026-09-04)

### The bug behind 2,659 alerts

Cameras carried `source_status = blind` because the Config API has no
per-camera status field — an honest "cannot tell". But that value was only ever
written on the *failure* path, and **nothing on the success path cleared it**:
the success path writes `source_status` for recording servers and `recording`
for cameras, never `source_status` for a camera. So a failure two days earlier
left 2,659 rows that no subsequent healthy cycle could correct, and each one
held an open `source_blind` alert.

That has been the single largest source of alert noise all along — the storm
spec 16 C3 proposed *suppressing* by excluding cameras from roll-ups. It did not
need suppressing. It needed the state to be true.

### What was wired

ESS Communication → camera `source_status`, with the mapping resolved
authoritatively from `/api/rest/v1/eventTypes` (§11):

| ESS state | `source_status` | severity |
|---|---|---|
| `CommunicationStarted` | up | ok |
| `CommunicationError` | down | crit |
| `CommunicationStopped` | down | crit |

**Only the Communication group.** Recording is excluded on the owner's
instruction — recording here is motion-triggered, so `RecordingStopped` is the
ordinary resting state and mapping it would manufacture an outage out of normal
operation. The FPS groups are left until someone decides what Critical means.

The ESS is enrichment and fails soft: a WebSocket problem returns `None`, prior
state is left untouched rather than downgraded to a guess, and `degraded`
records it so the failure is visible. `[milestone] ess_enabled` turns it off
without a deploy (§4.3); it defaults **on**, because leaving 2,659 false alerts
in place is not a neutral default.

### Result

| | before | after |
|---|---|---|
| camera `source_status = blind` | 2,659 | **147** |
| camera `up` | 0 | **2,415** |
| camera `down` | 0 | **97** |
| **total open alerts (fleet)** | **2,744** | **229** |

The 147 still blind are cameras with no Communication state in the snapshot —
genuinely unknown, and left that way.

### The tiebreaker earned its keep

Of the 97 cameras the ESS calls down, **65 also fail ICMP** and **32 answer it**.
Only the former raise alerts: `device_source_down` applies the native-poller
tiebreaker, so a camera Milestone calls down while the network says it is up
does not alert. That is the disagreement M1 asks to be surfaced rather than
averaged — and it is now visible in `device_state` with `source` naming which
probe produced each verdict (`milestone-ess` vs `poller`), exactly as M1
specifies.
