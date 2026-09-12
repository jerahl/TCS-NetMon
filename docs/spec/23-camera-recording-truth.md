# Spec 23 — Camera recording truth, and common-cause detection

**Status:** built 2026-09-12
**Trigger:** owner, 2026-09-12 — *"check the cameras NHS show 237 down cameras, but the
cameras aren't down, the DVR storage is full so they are not recording."*

---

## 1. The incident

At **2026-09-11 19:49:14**, in a single second, all **234** cameras behind
`NHS-BCD-DVR` transitioned `source_status: up → down`. The recorder had filled
up and stopped accepting streams.

```
2026-09-11 19:49:14   up -> down   x234     <- NHS-BCD-DVR
2026-09-11 19:49:14   up -> down   x27      <- OKD-DVR-MS (same second)
2026-09-10 05:49:41   up -> down   x4
```

What NetMon showed the operator: **237 down cameras at Northridge High.**

What was actually true, from NetMon's own tables:

| tier | count | means |
|---|---|---|
| `down_source_only` | 233 | answers ICMP; Milestone reports a fault |
| `down_network_only` | 17 | no ICMP answer |
| `down_confirmed` | 4 | both agree |

233 of the 237 were answering ICMP the whole time. Neither recorder
(`NHS-BCD-DVR`, `OKD-DVR-MS`) transitioned at all — both kept reporting
`CommunicationStarted` while every camera behind them dropped.

## 2. What was wrong

**W1 — `recording` asserted health it never measured.** The dimension was
derived from Milestone's `recordingEnabled`/`enabled`, which are
*configuration*: "is this camera set up to record". It therefore read
`up` / severity `ok` for **all 2,659 devices**, fleet-wide, permanently — and
went on doing so for all 234 NHS cameras that were writing nothing to disk.
This is exactly the fabricated-health failure CLAUDE.md §4.5 forbids.

The `camera_not_recording` alert rule keyed on it had opened **zero** alerts in
its entire life, which is the tell.

**W2 — the UI called a reachable camera "down".** The API had the tiers right
all along (`_camera_status_counts`), but the page rolled `down_confirmed +
down_source_only` into one number labelled "down", and called the latter
"Milestone-down" — jargon that does not tell an operator the camera is fine and
the recorder is not. It sends them to the wrong end of the cable.

**W3 — nothing said "these failed together".** 234 cameras failing in the same
second is not 234 faults; it is one. Nothing in NetMon expressed that, so the
shared cause had to be inferred by a human noticing the count was implausible.

### Not a defect, contrary to first reading

`recording_servers.storage_used_gb` is NULL for every recorder, and
`storage_by_rs` initialises `used_gb` to `None` and never assigns it. That looks
like a dropped assignment but is **deliberate**: the XProtect Config API exposes
configured size, not consumed space — that needs WinRM (OpenProject #111). The
`None` is the honest placeholder, guarded by `storage_used_known` so the UI
cannot divide by a fabricated zero. Left exactly as it was.

The consequence stands, though: **NetMon cannot see "disk full"**, which is why
the actual cause of this incident is invisible to it. `retention_state` read
`Retention time Normal` on NHS throughout.

## 3. Decisions

| # | Decision | Rationale |
|---|---|---|
| **R1** | **`recording` is written `unknown`/`unknown`, always.** | Nothing NetMon can reach measures it: ESS recording events are motion-triggered, so `RecordingStopped` is the resting state (owner, 2026-09-04), and consumed disk needs WinRM. §4.5 says report the gap, not a guess. The config flag is not lost — `build_cameras` already persists it as `cameras.enabled`. |
| **R2** | **`cameras_recording` / `cameras_not_recording` return `None`, with `cameras_recording_known: false`.** | Same shape `storage_used_gb` already uses. A confident `0` reads as an estate-wide outage; a confident `2,651` reads as health nobody checked. |
| **R3** | **`camera_not_recording` rule disabled** (migration `034`). | An enabled rule that structurally cannot fire tells an operator a thing is monitored when it is not. Disabled, not deleted, so the row documents the intent for whoever wires a real signal. |
| **R4** | **"Milestone-down" → "not recording"; "down" → "unreachable".** | The two failure shapes were already counted separately; only the words collapsed them. |
| **R5** | **New `/api/surveillance/common-cause`.** Cameras that change state within `window_s` of each other, grouped by recording server (falling back to site), reported as one finding. | Cameras do not fail simultaneously. The cluster *is* the diagnosis. |

## 4. The common-cause endpoint

`GET /api/surveillance/common-cause?hours=48&min_cameras=5&window_s=120`

Read-only over `state_events`, which is append-only — so this is history, not a
new judgement. It reports what happened together and names the thing those
cameras share; it does not claim to know *why*.

Design notes:

* **Sliding window, not a fixed bucket.** A `DATE_FORMAT` bucket splits a
  cluster that straddles `:59`/`:00` — precisely the case worth catching.
* **Grouped per recorder, never merged across.** NHS (234) and Oakdale (27)
  dropped in the same second; merging them would name the wrong thing. Two
  recorders is two findings.
* **Only `down`/`blind`.** Recovery is not a fault.
* **Sub-second spans are called out** — "in the same second" is the strongest
  form of the signal.

Live, over the last 72 h, it finds 7 clusters, the largest being the 234.

## 5. What this does not fix

NetMon still cannot see that a recorder's disk is full. The signals it has are
weak proxies: `retention_state` said `Normal` on NHS throughout, and
`Service Available Critical` is shared by 11 recorders, so it does not
discriminate. Closing this properly needs the WinRM dependency (OpenProject
#111) or a Milestone signal nobody has found yet.

What changed is that NetMon no longer *claims* otherwise, and it now points at
the recorder instead of the cameras.

## 6. Next session

- The 20:45:04 event on 2026-09-11 (five recorders down, all back at 20:51:16)
  looks like a management-server blip rather than five recorder faults. The
  common-cause endpoint groups per recorder, so it shows five findings there.
  Worth deciding whether a cross-recorder cluster should roll up further.
- `Service Available Critical` is currently descriptive-only (spec 19 §12, to
  avoid an alert storm). Eleven recorders carry it. Worth revisiting whether it
  means anything once someone checks one against the console.
