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
