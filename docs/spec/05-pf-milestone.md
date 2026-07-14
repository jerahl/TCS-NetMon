# Spec 05 — Collectors: PacketFence & Milestone (Phase 5)

Two more source collectors on the `base.Collector` contract, plus the one
genuinely long-lived connection in the system: a resilient Events/State
WebSocket for Milestone. Read-only throughout (CLAUDE.md §4.1).

## PacketFence (NAC / endpoints)

Ported from `reference/lib/PFClient.php`.

- **Auth:** `POST /api/v1/login` → token, sent **raw** in `Authorization:` (no
  `Bearer`); auto-refresh once on 401. PF answers **404 on empty** `/search`
  results — treated as empty, not an error (a hard-won reference gotcha).
- **What it does:** a supervised task refreshes a cached **NAC summary**
  (registered / unregistered node counts, recent 802.1X reject events) and
  records `collector_health`. The `/api/nac` endpoint serves that cached
  snapshot to the NAC page.
- **Not merged into `devices`.** Whether PF node data belongs in the registry
  or stays a linked view is an open question (§9, "do not guess"). So PF is a
  **linked live view**, cached; it does not write `device_state`. This defers
  the merge decision cleanly.
- **Blind / stale:** on PF unreachable the task fails loud into
  `collector_health` and the cached snapshot keeps its last-good `fetched_at`
  (visibly stale, never fabricated). The NAC page shows the collector's health.
- PF queries are slow → cache hard, minutes-scale interval, never in a request
  path.

## Milestone XProtect (surveillance)

Ported from `reference/zabbix/milestone/*`.

- **Auth:** OAuth2 password grant `POST {base}/IDP/connect/token`
  (`client_id=GrantValidatorClient`) → bearer `access_token`.
- **Config API** (`/api/rest/v1`): `GET /recordingServers` (state/version),
  `/recordingServers/{id}/hardware`, `/hardware/{id}/cameras`. The polling
  collector writes, for devices matched by `milestone_hardware_id`:
  `source_status` for recording servers (running → up), and the `recording`
  dimension for cameras (recording → up / down). Blind on unreachable.
- **Events/State WebSocket** — the live path. NetMon owns a **resilient**
  WebSocket task (`collectors/ws.py`): reconnect with exponential backoff, and
  a **watchdog** that forces a reconnect when no message arrives within a
  timeout. This is the first candidate for standalone execution if it
  misbehaves in-process; it runs the same code standalone
  (`python -m netmon.collectors.milestone`). The Milestone subscribe payload /
  message→state mapping is wired to `write_state`; the exact event schema is
  validated against the live VMS at deploy.
- Cameras/recording-servers are matched to existing registry rows; auto-
  registering newly-discovered cameras is a deferred follow-up (not guessed
  here).

## Resilient WebSocket contract (`collectors/ws.py`)

`ResilientWebSocket(connect, handle, *, watchdog_s, base_backoff, max_backoff)`:
`connect` is an injectable async-context-manager factory (real
`websockets.connect` in prod, a fake in tests); `handle(msg)` processes one
message. `run()` loops: connect → reset backoff → pump messages (each resets
the watchdog) → on drop/watchdog, back off (capped, doubling) and reconnect;
`stop()` ends it cleanly. Counters (`reconnects`, `messages`) are exposed for
health/observability. **The forced-disconnect test drives this with a scripted
fake connection that drops mid-stream and asserts it reconnects and keeps
handling messages.**

## UI

- **NAC** (`#/nac`) — reads `/api/nac`: reg/unreg counts, recent auth failures,
  node list. Renders "PacketFence not enabled" when the collector is off.
- **Surveillance** (`#/surveillance`) — reads `/api/status` filtered to
  `camera` / `recording_server`, showing `recording` / `source_status`.

## Definition of Done

- [ ] NAC page live via `/api/nac` (cached PF snapshot).
- [ ] Surveillance page live (camera/recording-server state).
- [ ] WebSocket survives a forced-disconnect test (reconnect + watchdog).
- [ ] PF + Milestone collector READMEs written.
- [ ] `pytest` green (pf/milestone parse + collector + ws); UI rebuilt.

## Deferred / next

- PF↔registry merge decision (§9). Auto-registration of Milestone cameras.
- Live Milestone WS event-schema validation (deploy). 3CX + rConfig (Phase 7).
