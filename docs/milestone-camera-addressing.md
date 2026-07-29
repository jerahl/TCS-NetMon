# Milestone camera addressing — can the VMS supply a management address?

**Task:** #16 — gates D7 (camera JPEG snapshot proxy) and D10 (direct camera SNMP
monitoring), both approved 2026-07-28 on the stated prerequisite that camera
`mgmt_ip` would be populated from Milestone.
**Investigated:** 2026-07-28, read-only (GET only; the sole POST was the OAuth
token grant `MilestoneClient` already performs).
**Live environment probed:** the production XProtect API Gateway via the
effective settings overlay (`settings.overlay_config`).

---

## Verdict

> ## ✅ ADDRESSES AVAILABLE
>
> - **Endpoint:** `GET /api/rest/v1/hardware` (bulk form
>   `GET /api/rest/v1/hardware?disabled&includeChildren=cameras&page=0&size=10000`)
> - **Field:** `hardware.address` — a **URL-shaped string**, e.g. `http://10.x.x.x/`.
>   Requires scheme/path/port stripping to a bare host (the reference script's
>   `bare_host()` already does exactly this).
> - **Camera → hardware join:** `camera.relations.parent` = `{type: "hardware", id: <hw-guid>}`.
>   Present and resolvable for **2,662 / 2,662** cameras.
> - **Cardinality:** predominantly **1 camera : 1 address (2,418 of 2,659 = 90.9 %)**,
>   but **N : 1 for 241 cameras across 62 addresses** — multi-imager encoders.
>   Disambiguated by `camera.channel`, which is present on all 2,662 cameras and
>   unique within each encoder.
> - **Coverage: 2,659 / 2,659 (100 %)** of the enabled registry cameras resolve to
>   a routable private address.
>
> **The earlier payload-validation finding was correct but incomplete.** `/cameras`
> genuinely has no `address` field — but it was never supposed to. The address lives
> on the **parent hardware object**, exactly as Milestone engineering documents and
> as the owner's own Zabbix script already implements.

**Caveat that keeps this from being a clean "just populate it":** the N:1 encoder
case **does** collide with the contested-address guard (§5). Populating `mgmt_ip`
naively on all 2,659 rows leaves 241 of them permanently `unknown` for ping/snmp.
D7 and D10 remain feasible, but D10's polling unit must be **hardware, not camera**.

---

## 1. Where the answer already was

`reference/zabbix/milestone/milestone_cameras_state.py` — the owner's working
Zabbix collector — exists *precisely* for this problem. Its module docstring
(lines 8–17) states it outright:

> The cameras returned by `/api/rest/v1/cameras` don't carry the IP address —
> that lives on the parent hardware object. Per Milestone engineering guidance on
> the developer forum, the recommended bulk pattern is
> `GET /api/rest/v1/hardware?includeChildren=cameras`, which returns every
> hardware record together with its child cameras in a single call.

So ZCD **did** obtain a camera address, and the method is a solved problem in the
repo. Two helpers are directly reusable:

| Helper | File / line | Purpose |
|---|---|---|
| `bare_host()` | `milestone_cameras_state.py:104` | `http://10.x.x.x/` → `10.x.x.x`; handles port, trailing path, and `[ipv6]` literals |
| `flatten_cameras()` | `milestone_cameras_state.py:676` | walks hardware → child cameras, injecting `address`, `mac`, `hardwareId`, `hardwareModel`, `recordingServerId` per camera |

`flatten_cameras()` also documents the N:1 fact explicitly at line 708:
*"Pull MAC once per hardware — every camera under this hardware shares the same
parent MAC."* The same is true of the address.

`milestone_cameras_read.sh:16-21` confirms the ZCD dashboard consumed
`$.address` as an LLD macro, i.e. Zabbix created a per-camera host keyed on the
**parent hardware's** address — including for encoder channels.

### What the current NetMon collector does wrong

`netmon/collectors/milestone.py:111` already tries for an address:

```python
"ip": _first(cam, "address", "ip") or _first(hw, "address", "ip"),
```

The fallback to `hw` is right in spirit, but it never fires, because
`build_cameras()` looks the hardware up by:

```python
hw = hw_by_id.get(str(_first(cam, "hardwareId", "hardware") or ""), {})
```

**`/cameras` returns no `hardwareId` field** (see §2 for the full field list) — the
parent is only reachable via `relations.parent.id`. So the lookup key is always
`""`, `hw` is always `{}`, and `cameras.ip` is always NULL. That is a one-line
class of bug, and it is the whole reason the prerequisite looked unmet.

*(No file under `netmon/` was modified by this investigation.)*

---

## 2. Live evidence

### `GET /api/rest/v1/cameras` — 2,662 records, no address

Complete field set returned (no envelope wrapper key; the array is the payload):

```
channel(num)  coverageDepth  coverageDirection  coverageFieldOfView
createdDate   description    displayName        edgeStorageEnabled
edgeStoragePlaybackEnabled   enabled            failoverSetting
gisPoint      icon           id                 lastModified
manualRecordingTimeoutEnabled  manualRecordingTimeoutMinutes
name          prebufferEnabled  prebufferInMemory  prebufferSeconds
ptzEnabled    recordKeyframesOnly  recordOnRelatedDevices
recordingEnabled  recordingFramerate  recordingStorage{id,type}
relations{parent,self}  shortName
```

**Ruled out on the camera object:** `address`, `ip`, `host`, `hostname`, `uri`,
`url`, `mac`, `macAddress`, `hardwareId`. None exist. Confirmed.

The `relations` object — the thing the validation run flagged — is a two-key
pointer pair, and it is the join key:

```json
{
  "parent": { "type": "hardware", "id": "<hardware-guid>" },
  "self":   { "type": "cameras",  "id": "<camera-guid>" }
}
```

`relations.parent.type == "hardware"` for **2,662 / 2,662** cameras;
`relations.parent.id` resolves against `/hardware` for **2,662 / 2,662**.

### `GET /api/rest/v1/hardware` — 2,489 records, address on every one

```
address(str)  description  displayName  enabled(bool)
hardwareDriverPath{id,type}  id  lastModified  model  name
passwordLastModified  relations{parent,self}  userName
```

| Measure | Value |
|---|---|
| Hardware records | 2,489 |
| With a non-empty `address` | **2,489 / 2,489 (100 %)** |
| Distinct raw `address` values | 2,486 |
| Address form | `http://<ipv4>/` — 100 % `http` scheme, 100 % bare IPv4 literal, **0 hostnames** |
| Range | all RFC1918 private (`10.x.x.x` ×2,469 · `192.x.x.x` ×15 · plus 5 with explicit ports) |
| Non-default port present | 5 (`:443` ×4, `:8080` ×1) |
| `enabled: false` hardware | 0 |
| `relations.parent` | `{type: "recordingServers", id: …}` — gives the RS grandparent for free |

`GET /api/rest/v1/recordingServers/{id}/hardware` (22 recording servers; 135
hardware under RS[0]) returns the **identical field shape including `address`**,
so the per-RS walk is an equivalent route to the same data.

### Cardinality — child cameras per hardware

```
cameras per hardware:  0 → 5    1 → 2,423   2 → 3
                       3 → 6    4 → 51      11 → 1
total child cameras: 2,662
```

The 51 four-channel and one eleven-channel records are the multi-imager
encoders. Across the 2,659 **registry-linked** cameras:

| | Addresses | Cameras |
|---|---|---|
| Sole claimant (clean 1:1) | 2,418 | **2,418** |
| Shared — one hardware, multiple channels (encoder) | 61 | 239 |
| Shared — **two distinct hardware records on one IP** | 1 | 2 |
| **Total** | **2,480** | **2,659** |

`camera.channel` is present on 2,662 / 2,662 and is **unique within each shared
address** (verified). Channel values on shared addresses run 0–10.

⚠️ **One genuine conflict worth reporting separately:** a single address is claimed
by **two different hardware GUIDs**. That is not an encoder — it is either a
duplicate/stale Milestone hardware entry or a real IP conflict on the camera VLAN.
It is a data-quality item for the owner, not an addressing blocker.

### MAC — available, but only per-hardware

`GET /api/rest/v1/hardwareDriverSettings/{hardware-guid}` returns
`data.hardwareDriverSettings` with:

```
detectedModelName  displayName  firmwareUpgradeSupported  firmwareVersion
httpSEnabled  httpSPort  httpSValidateCertificate  httpSValidateHostname
macAddress  passwordChangeMaxLength  passwordChangeMinLength
passwordChangeRequirements  passwordChangeSupported  productID
sealingEnabled  serialNumber
```

- The **collection** form `GET /api/rest/v1/hardwareDriverSettings` (no id) →
  **HTTP 400**. Only the by-id form works.
- Bulk inline `includeChildren=cameras,hardwareDriverSettings` is **rejected** on
  this deployment (matching the fallback the reference script anticipates at
  lines 350–360). MAC therefore costs **~2,489 additional GETs**, one per
  hardware — exactly why the reference script has `--no-mac` and a thread pool.
- `httpSEnabled` / `httpSPort` are the authoritative per-hardware answer to
  "http or https, and on what port" — directly relevant to D7 (§4).

### Operational note — the bulk call is slow

`hardware?includeChildren=cameras&size=10000` **exceeded the client's 30 s
`TIMEOUT`** and raised `httpx.ReadTimeout` on first attempt; it completed with the
timeout raised to 180 s. `milestone_client.TIMEOUT = 30.0` is too low for this
call and would fail-loud on every cycle. The reference script defaults to
`--timeout 60` and offers paginated fallback for the same reason.

---

## 3. Answers to the four questions

**(a) Is a routable address available for each camera?**
Yes. 100 % of the 2,659 enabled registry cameras, all RFC1918, all bare IPv4.

**(b) From which endpoint and field?**
`GET /api/rest/v1/hardware` → `address` (URL-shaped, needs `bare_host()`
normalisation). Joined to cameras via `camera.relations.parent.id`, or obtained
pre-joined via `?disabled&includeChildren=cameras`.

**(c) 1:1 or N:1?**
**Mixed.** 2,418 cameras are sole claimants of their address. 241 cameras share
62 addresses — 239 of those are legitimate multi-imager encoders (one physical
host, N logical cameras, distinguished by `channel`), plus 2 cameras on a genuine
duplicate-IP conflict.

**(d) How many of the 2,659 could be populated?**
All 2,659 — but only **2,418 (90.9 %)** would carry an *unambiguous* address that
the poller will act on. Current state confirmed: 2,659 enabled cameras, **0 with
`mgmt_ip`, 0 with `snmp_capable = 1`**.

**No collision with the existing registry.** All 964 currently-addressed enabled
devices occupy 949 addresses, and **0** of the 2,480 camera addresses is already
claimed by a switch/AP/other device type. The cameras live in their own ranges.

---

## 4. What this means for D7 (JPEG snapshot proxy)

**Feasible — the addressing prerequisite is met.** With `mgmt_ip` populated the
proxy can resolve a registered camera address server-side and never accept a
caller-supplied URL, which is the constraint the owner attached to the approval.

Three things the address alone does not settle, and which the proxy design must
handle rather than assume:

1. **Scheme.** Milestone stores `http://` for 100 % of hardware — that is the
   *driver connection* URL, not proof the camera refuses TLS. The approval text
   assumes `https://<camera>/snap.jpg`. `hardwareDriverSettings.httpSEnabled` /
   `httpSPort` is the per-hardware truth; use it rather than hardcoding a scheme.
2. **Port.** 5 hardware carry a non-default port. Preserve it — `bare_host()`
   deliberately strips it, so the proxy needs the *unstripped* value or a
   separately captured port column.
3. **The snapshot path is per-vendor, and per-*channel* on encoders.** For the 241
   encoder-channel cameras, `https://<host>/snap.jpg` returns *one* imager's
   frame, not the requested camera's. The channel must be carried into the
   snapshot URL, and the correct parameter differs by vendor. This is an open
   item for D7's spec, not something to guess.

**Recommendation:** D7 proceeds. The 2,418 clean 1:1 cameras work with a simple
host-based URL; the 241 encoder channels need a per-vendor channel-aware path and
should be phased or rendered "snapshot unavailable" until that map exists.

## 5. What this means for D10 (direct camera SNMP) — and the contested-address guard

**Feasible, with one required design correction.**

### The guard *does* collide

`netmon/poller/poller.py:122-159` (`_apply` / `_ambiguous_ips`) refuses to write
a ping or SNMP verdict for any address claimed by more than one enabled device,
and `netmon/state.py:41` (`native_trustworthy`) discards native readings in both
directions once `ip_claimants > 1`. That guard exists because of the 2026-07-28
`oak-DEAD` / `DEAD_AP` false-alert incident.

Measured forecast of populating `mgmt_ip` on all 2,659 cameras:

| Outcome | Rows |
|---|---|
| Contested addresses created | 62 |
| Camera rows that would receive **no ping/snmp verdict, ever** | **241** |
| Camera rows with a clean, sole-claimant address | **2,418 (90.9 %)** |

So the guard behaves correctly — it refuses to fabricate — but the visible result
is 241 cameras stuck at `ping = unknown` / `snmp = unknown` indefinitely, with
`device_reachable()` falling back to Milestone's `recording` state as the only
evidence. That is honest, and it is also a parity regression the owner should be
told about rather than discover. (Zabbix had the identical ambiguity and simply
wrote the same verdict to all N hosts — i.e. ZCD was quietly wrong here; NetMon
would be loudly unknown.)

### The correction: poll hardware, not cameras

The encoder case is not really contested — it is **one host with N logical
children**, and conflating that with a duplicate-IP conflict is what creates the
problem. Spec 13's own table already splits along this line:

- `camera_health` (CPU, **kernel uptime**, process count, filesystems, identity,
  VMS endpoint) is **per physical host** → one SNMP target per *hardware*.
  Polling it once per camera would issue 11 identical walks against one encoder
  and store 11 copies of the same CPU figure.
- `camera_interfaces` is likewise per host.
- `camera_imagers` is **per imager**, indexed — which is exactly the `channel`
  dimension. One walk yields all N imagers.

**Recommendation for the D10 spec:** make the sweep unit the *hardware* address
(2,480 distinct targets, not 2,659), and fan the per-imager rows out to cameras by
`channel`. This simultaneously fixes the load assessment the owner attached to the
D10 approval: **2,480 targets, not ~2,659**, and the 62 shared ones collapse to
one walk each.

**And it needs a decision the owner must make (do not guess):** how the registry
represents a per-host address for N camera rows without tripping
`_ambiguous_ips`. Three shapes, all schema-level:

1. Populate `mgmt_ip` only on the 2,418 sole claimants; leave the 241 NULL and
   render "shared encoder host". Zero guard impact, honest, loses ICMP for 241.
2. Add a `hardware_ip` / `milestone_hardware_ip` column distinct from `mgmt_ip`,
   so SNMP and the JPEG proxy have a target while the poller's IP-keyed guard is
   untouched. Cleanest, needs a migration.
3. Register the 62 encoders as their own `devices` rows (`device_type` = encoder
   host) carrying the `mgmt_ip`, with the 241 cameras as children. Most faithful
   to reality, largest change.

Option 2 looks lightest and preserves every existing invariant, but this is a
schema + registry-semantics decision and belongs to the owner.

---

## 6. Bottom line for the two gates

| Gate | Prerequisite met? | Status |
|---|---|---|
| **D7** JPEG proxy | ✅ address available for 100 % of cameras | Feasible. Open: per-vendor + per-channel snapshot path; use `httpSEnabled`/`httpSPort` for scheme/port instead of assuming `https`. |
| **D10** camera SNMP | ✅ address available; ⚠️ unit must be hardware | Feasible. Re-target the sweep at 2,480 hardware addresses; resolve the `mgmt_ip`-vs-shared-host registry question first. |

Neither gate needs to be reopened. Spec 13 §2's assumption that "the mgmt IP comes
for free from the Milestone Config API (`cameras.ip`)" is **correct in substance**
— the field is simply on the parent hardware, and the current collector's lookup
key is broken. Spec 13 §2 should be amended to say hardware-derived, and to state
the N:1 encoder reality.

## 7. Follow-ups this investigation surfaced

1. `build_cameras()` looks up hardware by a `hardwareId` field that `/cameras`
   does not return → `cameras.ip` is unconditionally NULL. One-line class of fix
   (use `relations.parent.id`), plus reuse `bare_host()`.
2. `milestone_client.TIMEOUT = 30.0` is too low for the bulk hardware tree
   (observed `ReadTimeout`; succeeded at 180 s).
3. Bulk `includeChildren=…,hardwareDriverSettings` is rejected here → MAC and
   `serialNumber`/`firmwareVersion` cost ~2,489 per-hardware GETs. Decide whether
   the `cameras.mac ⋈ fdb_entries` payoff justifies that per cycle, or fetch it on
   a slow secondary cadence.
4. `GET /api/rest/v1/hardwareDriverSettings` (collection form) → HTTP 400; only
   the by-id form exists. Worth recording alongside the known `/storages` 400.
5. One address is claimed by two distinct Milestone hardware records — duplicate
   entry or a real IP conflict on the camera VLAN. Registry hygiene item.
6. 2,662 Config-API cameras vs 2,659 linked registry rows → 3 unlinked cameras;
   5 hardware records have 0 child cameras.

---

*Method: read-only. `GET` only against the Config API, plus the OAuth token grant
the existing client already performs. No WebSocket. No file under `netmon/` was
modified. Addresses and MACs are reported as shapes, prefixes, and counts only.*
