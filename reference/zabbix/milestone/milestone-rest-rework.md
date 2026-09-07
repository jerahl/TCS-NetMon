# Milestone data acquisition — REST + WebSocket rework (drop external scripts)

Rethink of how `tcs_dashboard` / the Milestone Zabbix template pull data, based
on three Milestone APIs:

- **Config/Gateway API** — `Milestone Integration Platform VMS RESTful API`,
  base `https://<host>/API/rest/v1`, bearer auth. Pure configuration CRUD.
- **Events and State WebSocket API** — `wss://<host>/api/ws/events/v1/`, bearer
  header. Push stream of stateful events + on-demand `getState`. **This is the
  live-status source.** (Ref: milestonesys/mipsdk-samples-protocol
  `EventsAndStateWebSocketApiPython`.)
- **REST Events API** — `Milestone XProtect RESTful Events API`, `/eventSessions`
  polling. A daemon-free *fallback* for status; strictly inferior to the WS API.

All planes share one OAuth2 token endpoint: `POST /API/IDP/connect/token`,
`grant_type=password`, `client_id=GrantValidatorClient` (matches the template's
`{$MILESTONE.CLIENT_ID}`). Token has `expires_in` — must be renewed for any
long-lived integration.

> **Repo note (2026-06):** everything described here lives in **one** repo —
> `jerahl/ZabbixCustomDashboard` — under `tcs_dashboard/zabbix/milestone/`
> (scripts, templates, and the future `collector/`). Earlier drafts referenced
> a separate `MilestoneZabbix` repo; that split no longer exists. The base
> template export (`Milestone XProtect by HTTP` + camera templates) is
> versioned alongside this doc.

---

## 1. The core split: config plane vs. status plane

The Gateway camera object is **pure configuration** (`channel`, `displayName`,
`enabled`, `failoverSetting`, coverage, edge-storage). **No live-state field, no
`/cameras/{id}/state`.** (Confirmed against the Config API OpenAPI spec: the
camera schema carries recording *settings*, prebuffer, PTZ, coverage — nothing
live.) Live "is it communicating / recording" only exists in the Events and
State WebSocket API. The event-type GUIDs already in the template's
`{$MILESTONE.ESS.*}` macros (e.g. `communication_started = dd3e6464-…`) are
WebSocket event types — the current `milestone_ess_read.sh` is already hitting
this same API.

Inventory and status are two separate pipelines, different sources, sizes,
cadences, and *transport models* (poll vs. push).

| Plane | Source | Transport | Consumer | Ingest |
|---|---|---|---|---|
| Inventory | Gateway `/cameras`, `/cameraGroups`, `/recordingServers`, `/hardware` | REST poll inside the collector (1h–1d) | Zabbix | trapper items ← `zabbix_sender` |
| Status — monitoring | Events & State WebSocket | push, collector daemon, 24/7, service acct | Zabbix (alerting/history) | trapper items |
| Status — live UI | Events & State WebSocket | push, browser client, operator-attended | Surveillance NOC page | direct `window.MILESTONE` |

Both status rows hit the **same** WS API (`wss://<host>/api/ws/events/v1`); they
differ only in consumer and transport. The collector is unattended and durable;
the browser client is live-only and ephemeral. See §7.

**Inventory pivot (2026-06):** the inventory row was originally specced as
"Zabbix SCRIPT item → LLD" (native, no helper). Dev import revealed that at
this fleet's scale (~2,500 hardware / ~2,500 cameras) Duktape cannot hold the
assembled blob and the SCRIPT-item timeout is hard-capped — paging the API more
aggressively only fixes the fetch time, not the assembly OOM. The collector
already owns the long-lived, credential-bearing connection for the WS path, so
the inventory REST poll moved into the collector too: one service, one
`zabbix_sender` push path, trapper items on the Zabbix side. See §2 below.

---

## 2. Inventory plane — collector-pushed trappers (pivot, 2026-06)

The template still runs a handful of small Script items that pull a single
collection inline (`milestone.license.get`, `milestone.rs.getall`,
`milestone.sites.get`) — those stay native. But the **fleet-scale** config
collections (cameras, groups, RS storages) move to the collector:

| Current external item | Replace with |
|---|---|
| `milestone_cameras_read.sh[3600]` | trapper `milestone.cameras.getall` ← collector REST pump |
| `milestone_groups_read.sh[3600]` | trapper `milestone.groups.get` ← collector REST pump |
| `milestone_rs_read.sh[3600]` | RS-storage trappers + RS service state on the WS pump (RS-extras §2a) |

**Why this changed from the original "pure REST, no helper" design.** Dev import
confirmed two limits on Zabbix 7.4 Script items at this fleet's scale:
Duktape's JS heap cannot hold the assembled `{__array,"<guid>":{…}}` blob with
~2,500 cameras × ~2,500 hardware joined, and the Script-item timeout is
hard-capped (paging the API smaller doesn't help — the OOM is in assembly, not
fetch). Two earlier-rejected alternatives also fail: multi-item shard with
external assembly collapses back to needing one master item that doesn't
exist; per-RS staging via the RS LLD can't feed camera-LLD dependents
(cross-LLD master rule, see §3 below).

What *does* work, and is also the cleanest end state: the Phase 2 collector
already owns a long-lived, credential-bearing connection to the Gateway for
the WS path, so adding a periodic REST pump there costs almost nothing
operationally and **one** service replaces all eight externals (not just ESS).
The trapper items on the Zabbix side carry the legacy shape; the LLDs and
per-camera dependents see no schema change at cutover.

### 2a. RS extras disposition (review finding)

`milestone_rs_read.sh` is **not** a thin `GET /recordingServers` wrapper.
Per `milestone_rs_state.py` and its README, the snapshot carries RS service
state, per-RS camera/hardware counts, storage capacity/used/retention rollups,
and the per-storage LLD that power the Servers/Storage tabs and the Sites
storage bar. Disposition:

- **Storage rollups / per-storage LLD** — collector REST pump walks
  `GET /recordingServers/{id}/storages` per RS and pushes to RS-storage
  trappers.
- **Camera/hardware counts** — derive for free from the camera blob the REST
  pump already assembles; no extra calls.
- **RS service state** — live state; by this doc's own split it belongs to the
  status plane (collector WS pump), not REST polling.

---

## 3. Why per-RS Script-item staging doesn't work either (left for context)

`GET /cameras` originally appeared to lack paging (the OpenAPI spec declares
no `page`/`size`); Phase 0 found paging actually works on this deployment. The
original sketch was therefore to stage the inventory pull as one Script-item
master *per recording server* via
`GET /recordingServers/{id}/hardware` → `GET /hardware/{id}/cameras`. That
design fails for two independent reasons:

1. **Cross-LLD master rule.** Zabbix forbids a dependent item *prototype* from
   having a master that is a prototype of a *different* LLD rule. Per-RS
   camera fetchers would be prototypes of the **RS** LLD; per-camera dependents
   are prototypes of the **camera** LLD — they can't legally connect. Keeping
   the `milestone.cam.*` keys stable (a hard guardrail) requires a single
   master holding the whole fleet, which is what fails the Script-item heap
   limits in §2.
2. **Per-hardware fan-out blows the Script-item timeout.** Even at the largest
   RS, walking `/hardware/{id}/cameras` per hardware is O(135) sequential GETs
   per item, and there are 22 such items.

Both constraints land at the same conclusion as §2: the inventory assembly
runs in the collector (Python, no Duktape heap, no timeout cap), not in Zabbix.

**Reference notes** (carried over from earlier drafts that planned native
staging — kept because the collector's REST pump observes the same facts):

- **Pagination.** The Config API OpenAPI spec declares no `page`/`size` on
  `/hardware` or `/cameras`, but Phase 0 (2026-06) confirmed both collections
  honour paging on this deployment. The documented `page`/`size` (0+, 1–2000)
  paging belongs to the Events REST API — easy to conflate.
- **`includeChildren`.** Works on the **global** `/hardware` (embeds cameras),
  does **not** work on the RS-scoped `/recordingServers/{id}/hardware`. MAC is
  not exposed in bulk via any `includeChildren=settings` path on this Gateway
  (Phase 0); the collector accepts `$.mac=""` rather than fanning out to
  per-hardware `/settings`.
- **Minimal object.** The trapper consumers only need id, displayName, enabled,
  address, hardwareId, hardwareName, hardwareModel, channel, lastModified,
  recordingServerId, groupName, relations — the collector slims to those
  before pushing (matches `milestone_cameras_state.py`'s KEEP set).
- **Cadence.** 1h–1d per blob (collector-side scheduling).

---

## 4. Status plane — one WebSocket collector, push to trappers

The WS API cannot live in a Zabbix poller item: SCRIPT (Duktape) has no
WebSocket client, no async, ~60s lifetime cap, and no state between runs (can't
persist `last_event_id`). So status = **one small collector service** feeding
Zabbix **trapper items** via `zabbix_sender`. This replaces all eight polling
scripts with a single event-driven service — a simplification, not a regression.

Collector loop (from the sample, adapted):

1. Get bearer (`/API/IDP/connect/token`). Refresh on a timer before `expires_in`;
   apply the fresh token on the next reconnect. (The Milestone Python sample has
   **no** token refresh and only a naive 1s-retry reconnect — both are additions
   we own, not something to copy.)
2. `connect(wss://<host>/api/ws/events/v1/, Authorization: Bearer <token>)`.
3. `startSession(sessionId, lastEventId)` →
   **201** = new session → `addSubscription` + `getState` (full baseline);
   **200** = resumed (within 30s) → subscription + missed events auto-recovered.
   **Branch on the status code, not on intent**: a failed resume comes back as
   a plain 201 with a fresh session — the collector must detect that and
   re-subscribe + re-baseline rather than assume its resume worked.
4. `addSubscription` filter: `modifier:include`, `resourceTypes:["cameras"]`
   (optionally `"hardware"`), `eventTypes:[` comm started/stopped/error,
   recording started/stopped `]` (GUIDs already in `event_types.py` / macros).
5. `getState` once per new session → baseline of all current camera states.
6. Loop `receive_events` → push **only changed cameras** to trappers; track
   `lastEventId` for resume (`events[-1].id` per batch).

This is the "not all at once" ideal: subscribe once, baseline once, then receive
deltas. No 2,500-row poll, no per-camera polling.

### 4a. Hard-won lessons the collector must inherit (review finding)

The existing one-shot fetcher `milestone_ess_state.py` already encodes
production lessons at ~2,560 cameras; the collector starts from it, not from
the Milestone sample:

- **`getState` takes 1–2 minutes** to produce its first byte at this scale and
  needs `max_size` ≈ 128 MB on the websocket client. The one-shot script
  disables keepalive pings (`ping_interval=None`) because the response blocks
  past the default 20s ping window. A long-lived collector **cannot** disable
  pings — it needs a read-pump design where pings/other frames are serviced
  while the baseline response assembles. This is the biggest engineering risk
  in the collector.
- **Event/state `source` is `"cameras/<guid>"`** — prefix-strip before mapping
  (see `pivot_by_camera()`).
- **Dedup by `stategroupid`**: the current pipeline keeps a per-camera
  `by_group` map (`{stategroupid: {type, time}}`) and that is what the
  template's per-camera extractions resolve against. The collector's comm-vs-rec
  classification should reuse it. The diagnostics for mapping GUIDs to meanings
  already exist: `milestone_ess_state.py --list-stategroups` and
  `milestone_ess_resolve.py`.
- **`websockets` >= 13 vs < 13** header-kwarg shim (`additional_headers` vs
  `extra_headers`, resolved at import time) — carry it over.

### 4b. Subscription coverage — verify before narrowing (review finding)

The sample's `event_types.py` also defines **hardware-level** communication
events (`communication_hw_started/stopped/error`), motion, and
live-feed-terminated GUIDs. The current pipeline subscribes
`eventTypes:["*"]` and dedupes by stategroup; the rework narrows to 5
camera-level GUIDs. If any state the template's macros/CALCULATED items extract
is carried by a different GUID in this install (e.g. hw-level comm errors when
a whole encoder drops), the collector will silently miss it. **Before locking
the filter**, run `--list-stategroups` + `milestone_ess_resolve.py` on dev and
confirm the 5 GUIDs cover every stategroup the template reads; decide whether
`resourceTypes` should include `"hardware"`.

**Trapper item mapping** (collector → existing template keys):

| Event / state | Trapper key (per camera) | Source field |
|---|---|---|
| communication state | `milestone.cam.ess.comm.type[{CAM.ID}]` | event type GUID |
| comm state change time | `milestone.cam.ess.comm.time[{CAM.ID}]` | event `time` |
| recording state | `milestone.cam.ess.rec.type[{CAM.ID}]` | event type GUID |
| raw state record | `milestone.cam.ess.raw[{CAM.ID}]` | full event JSON |

**Trapper targeting is simpler than "map source → Zabbix host"** (review
finding): cameras are LLD **item prototypes on the one Milestone host**, not
host prototypes. The collector emits
`<milestone-host> milestone.cam.ess.comm.type[<guid>] <value>` sender lines —
no GUID→host registry needed.

Keep the existing CALCULATED `milestone.cam.status[{CAM.ID}]` and
`milestone.cam.alarm[{CAM.ID}]` — they derive from the trapper-fed comm/rec
types unchanged.

### 4c. Daemon-free fallback (only if a service is disallowed)

REST Events API `POST /eventSessions` + `GET /eventSessions/{id}/events` returns
`addedToSession`/`deletedFromSession` deltas, pollable by a SCRIPT item. But:
polling on an interval (not push), no `getState` baseline, and the session id
can't be persisted cleanly between SCRIPT runs (→ create-poll-discard each run,
lossy). **Retention gotcha (review finding):** `GET /events` only returns
*stored* events — storage depends on the event-type retention policy
(Management Client → Tools → Options → Alarms and Events, retention ≥ 1 day).
System stateful events like comm started/stopped may not be stored at all by
default, in which case this fallback returns empty arrays no matter how correct
the polling code is. Strictly inferior; take only under a no-service policy,
and document the retention prerequisite if ever exercised.

### 4d. Synthetic events as a test lever (review finding)

The Events REST API's `POST /events` (and `POST /events/bulk`, 207
multi-status) can trigger events with a chosen `type` GUID and
`source: "cameras/{id}"` — a way to exercise the collector's parse→map→send
chain end-to-end without physically toggling cameras, and to load-test the
trapper fan-out at fleet scale. Caveats: a *service* token can trigger any type
from `GET /eventTypes`, a *user* token only External/MIPDevice generator types —
so triggering the system comm/recording GUIDs may need a service token — and
whether synthetic triggers flow into the WS *state* stream (vs. just the event
log) must be checked on dev first.

---

## 5. Migration mapping (current → target)

| Current | Target | Notes |
|---|---|---|
| `milestone_cameras_read.sh[3600]` | trapper `milestone.cameras.getall` ← collector REST pump | legacy `{__array,"<guid>":{…}}` shape preserved |
| `milestone.cam.*[{#CAM.ID}]` config dependents | unchanged | repointed master = the new trapper; same JSONPath |
| `milestone_ess_read.sh[]` | trapper items ← collector WS pump | push, not external poll |
| `milestone.cam.ess.*[{#CAM.ID}]` | repointed to trapper masters | keys unchanged; collector populates |
| `milestone_groups_read.sh[3600]` | trapper `milestone.groups.get` ← collector REST pump | groups + per-group membership (no inline counts) |
| `milestone_rs_read.sh[3600]` | RS-storage trappers ← REST pump; RS state ← WS pump | counts derived from camera blob, no extra REST call |

Result: **zero** files in `ExternalScripts/`; **one** collector service for
both inventory and status; the small inline SCRIPT items already in the
template (`milestone.license.get`, `milestone.rs.getall`, `milestone.sites.get`)
remain native.

---

## 6. Open decisions

- **Collector hosting.** systemd service on the Zabbix server/proxy, or a
  container. It needs outbound 443 to the API Gateway and `zabbix_sender`
  reach to the Zabbix server/proxy (port 10051).
- **Session resume vs. re-baseline.** 30s resume window recovers missed events.
  On longer drops, a fresh session + `getState` re-baselines — accept a brief
  state-staleness window on reconnect. (The 30s figure is from the ESS docs,
  not observable in the sample or specs — confirm empirically on dev: kill the
  connection, resume at ~25s vs ~35s, check 200 vs 201.)
- **Token refresh on a long-lived WS.** Auth is connect-time only; refresh in
  the background and use the new token on next reconnect. Decide reconnect
  cadence vs. token TTL so a forced reconnect for re-auth is rare.
- **Subscription filter breadth.** 5 camera-level GUIDs vs. today's
  `eventTypes:["*"]` — gate on the stategroup coverage audit (§4b).
- **Per-RS LLD merge & snapshot shape.** One camera LLD consuming all per-RS
  blobs (preprocessing concat) vs. per-RS prototype sets. Whatever is chosen
  must also decide the dependent-item shape: today dependents resolve
  `$["<guid>"]` against a map carrying both `__array` and per-GUID keys, and
  `ActionSurveillanceData.php` back-fills from `__array` directly — the concat
  preprocessing must rebuild the per-GUID map or every dependent JSONPath (and
  the PHP) changes.
- **`MilestoneClient.php`.** Still only for live camera-wall thumbnails
  (integration-plan §3c) and the §7 token mint. Everything else flows through
  Zabbix items.

---

## 7. Live UI plane — browser WS client (vs. the collector)

Ref: milestonesys/mipsdk-samples-protocol `EventsAndStateWebSocketJavaScript`
(browser sample). Same WS API and session/subscription model as the collector,
but a different client environment, with consequences:

- **Auth is in-band, not header-based.** Browser `WebSocket` can't set request
  headers, so after `onopen` send `{command:'authenticate', token:'Bearer …'}`
  before `startSession`. (The Python/server path uses the connect-time
  `Authorization` header instead.)
- **Token via `fetch`** to `/API/IDP/connect/token` — this cross-origin fetch is
  the *only* reason the sample needs CORS. The WS handshake itself is **not**
  subject to CORS/same-origin policy (no preflight); the Gateway validates the
  `Origin` header and decides.
- **Reconnect** on `onclose` with backoff, resuming via `currentSessionId` +
  `mostRecentEventId` (30s window). Same recovery semantics as the collector.

### Recommended wiring for the Surveillance NOC page

- **Mint the token server-side.** `MilestoneClient.php` (integration-plan §3c)
  / `ActionSurveillanceData` does `grant_type=password` with the service account
  and returns a short-lived token to the browser. The VMS **password never
  reaches client JS**; only a short-lived token does. This also removes the
  cross-origin token fetch, so CORS config on the Gateway is likely unnecessary.
- **Browser opens the WS**, runs `authenticate(token)` →
  `startSession` → `addSubscription` (`resourceTypes:['cameras']`, comm/recording
  event GUIDs) → render deltas into `window.MILESTONE` via a new
  `assets/surveillance-ws.jsx` bridge, parallel to `nvr-data.jsx`.
- **Verify Gateway `Origin` handling on dev** before relying on cross-origin WS
  from the Zabbix-UI host. If the Gateway rejects the origin, reverse-proxy the
  dashboard so it's same-origin, or scope CORS to the dashboard origin only —
  **never** `Access-Control-Allow-Origin: *` on a production VMS.

### Division of labor (do not collapse these)

| | Collector daemon | Browser WS client |
|---|---|---|
| Runs when | 24/7, unattended | only while a NOC tab is open |
| Identity | service account (server-side) | server-minted short-lived token |
| Gives you | alerting, triggers, history/trends, LLD-mapped items | live tile updates, zero round-trip |
| Misses | nothing (durable) | history, alerting, state-when-unwatched |

The browser client makes the dashboard feel live; the collector makes Zabbix
*know*. Build both against the same dev XProtect; they share auth, endpoint, and
subscription filter — only the consumer differs.
