# Build brief — Milestone data acquisition rework

Executable, phased plan to move Milestone status/inventory off external shell
scripts onto: (1) native Zabbix REST SCRIPT items for inventory, (2) a single
WebSocket collector for monitoring state, and (3) a browser WebSocket client for
the live NOC UI.

**Read first:** [`milestone-rest-rework.md`](milestone-rest-rework.md) (design
rationale + endpoint facts). This brief is the build sequence; that doc is the
"why".

---

## Orientation (do not re-derive)

**Repo / layout** — everything lives in `jerahl/ZabbixCustomDashboard`:

- `tcs_dashboard/zabbix/milestone/` — **acquisition**: the Zabbix templates,
  the existing external scripts being removed, the future `collector/` and
  `test/fixtures/`. The base template export (`Milestone XProtect by HTTP` +
  camera templates) is versioned here at
  `templates/milestone_by_http_api.yaml`.
- `tcs_dashboard/` (controllers, views, JSX bridges) — **consumption**: the PHP
  module. No Milestone PHP client exists yet.

**APIs (all on the API Gateway host)**

- Token: `POST {scheme}://{host}/API/IDP/connect/token`,
  `Content-Type: application/x-www-form-urlencoded`,
  body `grant_type=password&username=…&password=…&client_id=GrantValidatorClient`.
  Response has `access_token` + `expires_in`.
- Config REST base: `{scheme}://{host}/API/rest/v1`.
- Events & State WebSocket: `{ws|wss}://{host}/api/ws/events/v1`.

**Hard facts that constrain design**

- The Gateway camera object is **config only** — no live state, no
  `/cameras/{id}/state`. Live state comes from the WS API only.
- `GET /cameras` has **no pagination** (only `?disabled=`). Stage per recording
  server: `GET /recordingServers/{id}/hardware` → `GET /hardware/{id}/cameras`.
  Config-API `page`/`size` support is **undocumented** (the documented paging is
  the Events REST API's) — Phase 0 probes it before payload sizing.
- WS session resumes within a **30s** window via `sessionId` + last `eventId`,
  recovering missed events. New session (`startSession` status 201) requires
  re-`addSubscription`; resumed (200) does not. A **failed resume returns a
  plain 201** — branch on the status code, never assume the resume worked.
- Event/state `source` is `"cameras/<guid>"` — prefix-strip before keying.
- `getState` at ~2,560 cameras takes **1–2 minutes** to first byte and needs
  `max_size` ≈ 128 MB on the WS client (see `milestone_ess_state.py`).
- Browser `WebSocket` can't set headers → auth is the in-band
  `{command:'authenticate', token:'Bearer …'}` message, not the connect header.
  The WS handshake is not subject to CORS preflight; only the token `fetch` is.

**Event-type GUIDs for the subscription** (from sample `event_types.py`)

| Meaning | GUID |
|---|---|
| communication_started | `dd3e6464-7dc0-405a-a92f-6150587563e8` |
| communication_stopped | `0ee90664-2924-42a0-a816-4129d0ecabdc` |
| communication_error | `a334af1c-4b4b-4957-9e5f-ab8ca07feab6` |
| recording_started | `4577f552-765a-438c-bc7d-e5ff1f754bc3` |
| recording_stopped | `79a94f89-92de-4fca-8a43-5561d407423d` |

`communication_started` already matches the template macro
`{$MILESTONE.ESS.TYPE.COMMUNICATION_OK}`.

> **Coverage caveat:** `event_types.py` also defines hardware-level comm events
> (`communication_hw_*`), motion, and live-feed-terminated. Today's pipeline
> subscribes `eventTypes:["*"]` and dedupes by `stategroupid`; narrowing to the
> 5 GUIDs above is gated on the Phase 0 stategroup coverage audit.

**Existing template item keys to preserve** (consumers depend on these)

`milestone.cam.ess.comm.type[{#CAM.ID}]`, `milestone.cam.ess.comm.time[{#CAM.ID}]`,
`milestone.cam.ess.rec.type[{#CAM.ID}]`, `milestone.cam.ess.raw[{#CAM.ID}]`,
`milestone.cam.status[{#CAM.ID}]` (CALCULATED), `milestone.cam.alarm[{#CAM.ID}]`
(CALCULATED). Repoint their data source; **do not rename keys**.

Cameras are LLD **item prototypes on the one Milestone host** (not host
prototypes): trapper targeting is `<milestone-host> <key[guid]> <value>` —
no GUID→host mapping table.

---

## Cross-cutting guardrails (apply in every phase)

- **Secrets never in git, never in client JS.** Use Zabbix secret macros
  (`{$MILESTONE.PASSWORD}`) and a server-side secrets file for the collector.
  The browser receives only a short-lived token minted server-side — never the
  VMS password.
- **Never set `Access-Control-Allow-Origin: *`** on the production Gateway.
- **Don't touch the working AP Detail pipeline** or unrelated dashboard pages.
- **Keep item keys stable** (above). Schema-breaking changes ripple into the PHP
  controllers and CALCULATED items.
- **Test against dev XProtect first.** No production cutover until Phase 3 gate.
- Each phase is a self-contained work session with its own Definition of Done.
  Do not start a phase until the prior phase's DoD is met.

---

## Phase 0 — Dev harness & API verification

**Objective:** prove the three API surfaces work against dev XProtect before
writing any integration code.

**Tasks**
1. Create a dedicated basic VMS user (read-only role sufficient for events +
   config GET). Record host, scheme, creds in a local untracked `.env`.
2. Verify token: `curl -sk -X POST .../API/IDP/connect/token -d 'grant_type=…'`
   → confirm `access_token` + note `expires_in`.
3. Verify config: `GET /API/rest/v1/recordingServers`, then
   `GET /recordingServers/{id}/hardware`, then `GET /hardware/{id}/cameras`.
   Capture one full camera object and one RS object as fixtures.
4. Verify WS: connect with `websocat`/`wscat` using the bearer header, send
   `startSession` (blank ids), `addSubscription` (`resourceTypes:["cameras"]`,
   the 5 GUIDs above), `getState`; confirm a baseline arrives and that toggling
   a camera produces a delta event. Capture sample messages as fixtures.
5. Note Gateway behavior on the WS `Origin` header (for Phase 4 planning).
6. **Pagination probe:** request `GET /hardware?page=0&size=2` (and the same on
   `/cameras`) — determine whether the Config API honors paging or silently
   ignores it. Record the answer; Phase 1 payload sizing depends on it.
7. **Stategroup coverage audit:** run
   `milestone_ess_state.py --list-stategroups` piped through
   `milestone_ess_resolve.py` on dev; confirm the 5 subscription GUIDs cover
   every stategroup the template's macros/CALCULATED items read. Decide whether
   `resourceTypes` needs `"hardware"` (for `communication_hw_*` events).
8. **Synthetic-event check:** `POST /events` with a comm/recording `type` GUID
   and `source:"cameras/{id}"` (service token likely required — user tokens can
   only trigger External/MIPDevice generator types). Record whether synthetic
   events appear in the WS *state* stream or only the event log — this decides
   how Phase 2's DoD can be tested without physically toggling cameras.
9. **Resume-window confirmation:** kill the WS, resume with stored
   `sessionId`+`eventId` at ~25s and ~35s; confirm 200 vs 201. The 30s figure
   is from the ESS docs, not observable in the sample/specs.

**Definition of Done:** token, per-RS camera enumeration, and a live WS delta
all observed and captured as fixtures in
`tcs_dashboard/zabbix/milestone/test/fixtures/`; answers recorded for tasks
6–9.

**Out of scope:** any Zabbix or dashboard changes.

---

## Phase 1 — Template scaffolding for collector-fed inventory

**Architecture pivot (2026-06):** native Zabbix Script items cannot do
fleet-scale inventory here. Duktape cannot hold ~2,500 hardware + ~2,500 camera
objects in memory during assembly, and the Script-item timeout is hard-capped
(so paging more aggressively only fixes the API time, not the assembly OOM).
The Phase 2 collector — already required for ESS WebSocket state — is extended
to **also** own inventory: a daily REST poll inside the collector pushes the
camera/groups/RS-extras blobs to **trapper** items via `zabbix_sender`. Result:
**one** service replaces all eight externals, not just ESS.

**Objective:** scaffold the template so the collector has trapper items to push
to, with the camera external still live in parallel. No removal happens here —
cutover is deferred to Phase 3 once the collector is healthy.

**Tasks**
1. Rename/curate the versioned base export to
   `templates/milestone_by_http_api.yaml` (done).
2. **Camera plane — collector-fed trapper** (`milestone.cameras.getall`, done).
   Shape matches the legacy external snapshot (`{__count, __fetched_at,
   __array:[…], "<guid>":{…}}`) so the camera LLD and every
   `milestone.cam.<config>[{#CAM.ID}]` dependent can be repointed here unchanged
   on cutover. Item exists alongside the live `milestone_cameras_read.sh[3600]`
   external; nothing depends on it yet.

   > **Phase 0 findings (dev, 2026-06-10):** 22 recording servers, ~2,489
   > hardware (≈1:1 hardware↔camera, single-channel). IDP path
   > `/API/IDP/connect/token`; Config base `…/api/rest/v1`. Both `/hardware` and
   > `/cameras` page (`?size=` truncates); `includeChildren=cameras` works on
   > the global `/hardware` (embeds cameras) but **not** on the RS-scoped
   > `/recordingServers/{id}/hardware`. **MAC is not available in bulk** (no
   > inline settings) → `$.mac` will be blank from the collector path too
   > (degrades XIQ MAC correlation only; host creation uses `address`).
   > `cameraGroups` have no inline counts.
   >
   > A native paged-join Script item was prototyped (validated against fixtures:
   > 81/81 group-camera parent resolution, Bosch vendor regex still matches).
   > It was reverted when dev confirmed Duktape OOMs at fleet scale and the
   > timeout can't be raised — hence the pivot to collector-pushed trapper.

   The collector's REST-poll path will mirror the proven
   `milestone_cameras_state.py` (paged global `/hardware?includeChildren=cameras`
   then `__array` + per-GUID assembly), but in Python (no Duktape limits) and
   running in the same service that holds the ESS WebSocket.
3. **Groups plane — collector-fed trapper** (`milestone.groups.get`, **done**).
   Trapper item alongside `milestone_groups_read.sh[3600]`; collector will walk
   `/cameraGroups` + per-group membership (26 calls — no inline counts) and
   push the legacy `{__array,"<guid>":{…}}` shape once per REST-pump tick.
4. **RS-extras plane — collector-fed trapper** (`milestone.rs.extras.get`,
   **done**, on the `Milestone XProtect RS extras by HTTP` template). One
   trapper receiving the composed blob; the collector assembles per the rework
   doc §2a disposition:
   - storage rollups + per-storage `__storages` list ← REST pump walks
     `/recordingServers/{id}/storages` per RS;
   - camera/hardware counts ← derived from the camera blob the REST pump
     already assembles (no extra REST call);
   - RS service state ← arrives via the ESS WebSocket (collector WS pump),
     not REST polling.
5. Set inventory cadences (collector-side: 1h–1d as appropriate per blob). No
   external removal in this phase.

**Definition of Done (met, dev-import pending):** template parses; three
collector-fed trapper items present (`milestone.cameras.getall`,
`milestone.groups.get`, `milestone.rs.extras.get`) and empty; the existing
externals still run and feed the live LLDs unchanged (no regression).
Repointing the LLDs and deleting the externals is Phase 3.

**Out of scope:** the collector implementation (Phase 2); any cutover (Phase 3);
dashboard (Phase 4).

---

## Phase 2 — Collector service: WS → Zabbix trappers (monitoring plane)

**Objective:** one durable service that holds the WS, baselines via `getState`,
streams deltas, and pushes per-camera state into Zabbix trapper items.

**Operational decisions (locked 2026-06-15):**
- **Host:** Zabbix **proxy** that already polls the Milestone hosts.
  `zabbix_sender` targets the proxy on 10051 (loopback if the proxy ships the
  collector; otherwise short LAN path). Outbound 443 to the API Gateway is
  already permitted from the proxy.
- **WS subscription filter:** `modifier:include`, `resourceTypes:['cameras']`,
  the 5 camera-level event-type GUIDs from the brief's Orientation table
  (Phase 0 task 7 stategroup-coverage audit confirmed they cover every state
  group the template's `milestone.cam.ess.*` and CALCULATED items read).
- **Secrets:** `/etc/milestone-collector/env` (0600 root:root), loaded by the
  systemd unit via `EnvironmentFile=`. Variables match
  `test/.env.example` (`MILESTONE_HOST`, `MILESTONE_SCHEME`, `MILESTONE_USER`,
  `MILESTONE_PASSWORD`, `MILESTONE_CLIENT_ID`, `MILESTONE_VERIFY_TLS`) plus
  `ZABBIX_SERVER` (proxy address) and `ZABBIX_SENDER_HOST` (the host name the
  trapper items live on).

**Seed code:** start from the in-repo `milestone_ess_state.py`, **not** the
Milestone sample — it already encodes the production lessons (rework doc §4a):
`max_size` 128 MB, the `getState`-vs-keepalive-ping interplay, the
`websockets` >=13/<13 header-kwarg shim, `source` prefix-stripping, and
`stategroupid` dedup (`by_group`).

The collector now owns **two** push paths against the same XProtect Gateway,
sharing one token-refresh loop and one secrets file:

- **WS push (continuous)** — the original Phase 2 design: holds the ESS
  WebSocket, baselines via `getState`, streams deltas to the per-camera
  `milestone.cam.ess.*` trappers.
- **REST poll (periodic)** — the Phase 1 pivot: daily (or per-blob cadence)
  fetches of the camera, groups, and RS-storage collections, pushed as JSON
  blobs to the corresponding `milestone.*` trapper items.

**Seed code:** for the WS path, start from the in-repo `milestone_ess_state.py`
(production lessons: `max_size` 128 MB, `getState`-vs-keepalive interplay,
`websockets` >=13/<13 header-kwarg shim, `source` prefix-stripping,
`stategroupid` dedup). For the REST path, port `milestone_cameras_state.py`'s
paged global `/hardware?includeChildren=cameras` walk + `__array`+per-GUID
assembly — it's already proven at this fleet scale and we cleared its constraints
on Phase 1's failed Script-item attempt.

**Tasks**
1. Adapt into `collector/milestone_collector.py`:
   - shared token fetch + **background refresh** before `expires_in`; the WS
     applies fresh token on next reconnect, the REST poll picks it up next tick
     (the Milestone sample has neither — both are new work).
   - **WS pump** (async task): connect loop with reconnect/backoff;
     `startSession` resume via stored `sessionId` + `lastEventId`; **branch on
     status**: 201 (new *or* failed resume) → `addSubscription` (filter per
     Phase 0 task 7 outcome) + `getState` baseline; 200 → continue. Read-pump
     design — keepalive pings must be serviced while the 1–2 min `getState`
     baseline assembles (the one-shot script's `ping_interval=None` is not an
     option for a daemon). Strip the `cameras/` prefix from `source`; classify
     comm vs. rec via `stategroupid`; emit `zabbix_sender` lines.
   - **REST pump** (scheduled task, daily/per-blob): page
     `/hardware?includeChildren=cameras`, page `/cameraGroups` + per-group
     membership, walk `/recordingServers/{id}/storages` per RS; assemble the
     legacy `{__array,"<guid>":{…}}` shapes the LLDs expect; push as one
     `zabbix_sender` line per blob to `milestone.cameras.getall`,
     `milestone.groups.get`, and the RS-storage trappers.
   - **No GUID→host registry needed:** cameras are LLD item prototypes on the
     single Milestone host (rework doc §4); sender lines are
     `<milestone-host> <key[guid]> <value>`.
2. Add **trapper** item prototypes to the template:
   - State trappers: repoint `milestone.cam.ess.comm.type[{#CAM.ID}]`,
     `…comm.time`, `…rec.type`, `…ess.raw` to **Zabbix trapper**, fed by the WS
     pump. Keep `milestone.cam.status` / `…alarm` CALCULATED unchanged.
   - Inventory trappers: `milestone.cameras.getall` (done), `milestone.groups.get`,
     the RS-storage trappers, RS service-state trapper.
3. Config via env/secrets file (host, scheme, creds, Zabbix server addr, sender
   host-name strategy, per-blob REST cadences). Structured logging; exit
   non-zero on fatal.
4. Provide a `systemd` unit (`collector/milestone-collector.service`) and a
   `--once` / dry-run mode that prints sender lines without sending.

**Definition of Done:** toggling a camera's comm/recording state on dev — or a
synthetic `POST /events` trigger if Phase 0 task 8 confirmed it reaches the WS
stream — shows up in the corresponding Zabbix trapper item within seconds; the
REST pump's first run populates `milestone.cameras.getall` (and the groups/RS
trappers) with values byte-compatible against the legacy externals (diffed
during parity); killing and restarting the collector recovers WS state (resume
< 30s, else `getState` re-baseline) and re-runs the REST pump on schedule; a
status trigger fires/clears correctly. Optionally load-test sender fan-out
with `POST /events/bulk`.

**Out of scope:** repointing the LLDs / deleting the externals (Phase 3),
dashboard (Phase 4).

---

## Phase 3 — Cutover & decommission (production gate)

**Objective:** retire **all** external scripts (state and inventory); the
collector becomes the sole source. Reversible.

**Tasks**
1. Run the collector in parallel with **all** existing externals on dev for a
   soak period: diff `milestone.cam.ess.*` against `milestone_ess_read.sh`'s
   parsed output (state), and diff `milestone.cameras.getall`/`milestone.groups.get`/
   the RS-storage trappers against the corresponding `milestone_*_read.sh`
   externals (inventory). Field-level parity on the camera blob is the
   load-bearing check — that's what drives the LLD and every per-camera
   dependent.
2. On parity, repoint the LLDs and dependents to the trapper items:
   - `milestone.cameras.discovery` master + `milestone.cam.raw[{#CAM.ID}]`
     master → `milestone.cameras.getall` (per-camera dependents below already
     hang off `milestone.cam.raw` and need no further change).
   - `milestone.groups.discovery` master + `milestone.grp.raw[{#GRP.ID}]`
     master → `milestone.groups.get`.
   - RS-storage discoveries / dependents → the RS-storage trappers.
   - ESS state items → already trapper-fed at Phase 2 import.
3. Remove **all** Milestone external items from the template
   (`milestone_cameras_read.sh[3600]`, `milestone_ess_read.sh[]`,
   `milestone_groups_read.sh[3600]`, `milestone_rs_read.sh[3600]`) and the
   `Milestone XProtect RS extras by HTTP` template linkage if its content is
   now redundant.
4. Decommission sweep — against the **live** `externalscripts/` dir and
   crontab, not just git (at least one deployed script,
   `milestone_groups_state.py`, was never in the repo): remove cron entries,
   `/var/lib/zabbix/milestone_*.json` snapshots, and the matching
   `.err`/`.lock`/log files.
5. Confirm `grep -r ExternalScripts` / template has **zero** Milestone external
   refs. Update the milestone README + the dashboard integration-plan §3c (the
   "deploy N scripts" step is gone).
6. Production rollout: import template, deploy collector service, set secret
   macros. Keep the old scripts archived (git tag) for rollback.

**Definition of Done:** production runs with no Milestone external scripts (and
no orphaned cron entries or snapshot files); inventory + status both healthy;
rollback path documented.

**Out of scope:** dashboard (Phase 4).

---

## Phase 4 — Live UI plane: server-minted token + browser WS bridge

**Objective:** take Surveillance NOC / Camera Detail / Recording Server pages off
mock data with a live browser WS feed, without exposing VMS credentials.

**Tasks**
1. Build `lib/MilestoneClient.php` (~250 lines): server-side token mint
   (service account, `grant_type=password`), short-TTL token returned to the
   browser; also the per-RS REST helpers reused for thumbnails. Creds from
   `Config::milestone()` (mirror existing PF/XIQ config pattern).
2. Extend `actions/ActionSurveillanceData.php`: returns initial payload (camera
   list + last-known state from Zabbix items) **and** a freshly minted WS token.
3. Build `assets/surveillance-ws.jsx`: open `wss://{host}/api/ws/events/v1`,
   send `authenticate(token)` → `startSession` → `addSubscription`
   (`resourceTypes:['cameras']`, the 5 GUIDs) → render deltas into
   `window.MILESTONE` / `window.SITES` (names already used by `nvr-data.jsx`).
   Reconnect with backoff, resume via `sessionId`+`eventId`.
4. Wire `ActionSurveillance` / `ActionCamera` / `ActionServer` to the live
   bridge; filter Camera/RS detail by `id` query param (shared payload).
5. **Before cross-origin:** verify Phase-0 Gateway `Origin` finding. If rejected,
   reverse-proxy the dashboard same-origin or scope CORS to the dashboard origin
   only. Never `ACAO:*`.

**Definition of Done:** NOC tiles update live as camera state changes; VMS
password never appears in client JS or network payloads (only a short-lived
token); detail views render from the shared payload; pages off mock data.

**Out of scope:** camera-wall video thumbnails beyond a static snapshot
(separate effort).

---

## Phase 5 — Hardening & operations

**Objective:** make the collector and bridge production-grade and observable.

**Tasks**
1. **Monitor the monitor:** Zabbix item + trigger on collector liveness
   (heartbeat trapper or systemd watchdog) — alert if state stops flowing.
2. Token/secret rotation runbook; verify behavior across token expiry, Gateway
   restart, and network blips (forced reconnect + re-baseline).
3. Collector metrics: events/sec, reconnect count, last-baseline time, send
   failures. Log rotation. Backoff caps.
4. Docs: collector README (install, systemd, config, secrets,
   troubleshooting); update the dashboard README for the surveillance pages and
   CORS posture.

**Definition of Done:** a deliberately induced Gateway restart and a token
expiry both auto-recover with no manual action and ≤ one resume gap; collector
downtime raises a Zabbix alert; runbook covers rotation and rollback.

---

## Dependency order

`0 → 1 → 2 → 3` is strict (inventory LLD `{#CAM.ID}` underpins the collector's
item keying; cutover gates on parity). `4` depends only on `0` + `1` (it needs
the camera list and the token pattern) and can run in parallel with `2`/`3`.
`5` follows `3` and `4`.

---

## Fallback (documented, not planned)

If a collector service is ever disallowed, the REST Events API
`/eventSessions` polling fallback exists but is strictly inferior (rework doc
§4c) — and it only returns **stored** events: the event-type retention policy
(Management Client → Tools → Options → Alarms and Events, ≥ 1 day) must be
configured or it returns empty arrays regardless of code correctness.
