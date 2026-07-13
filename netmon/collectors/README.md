# Collectors

Each collector federates one source platform into NetMon, **read-only** (GET
only; CLAUDE.md §4.1). All share the `base.Collector` contract:

- `run_once() -> int` — one cycle; Pydantic-validated payloads; writes via
  `netmon.state.write_state` (upsert + change→`state_events`).
- `run_guarded()` — heartbeat + error boundary into `collector_health`
  (`netmon.health`). A failure is loud and leaves prior state intact.
- In-process (supervised task, registered in the app lifespan when the source is
  enabled) **and** standalone: `python -m netmon.collectors.<name> --once|--loop`.

What collectors store: **state** (`device_state`/`state_events`), never metric
time-series (§2). Firmware/model/port/PoE/client/CPU detail is live-read by the
UI (Phase 4), not persisted.

---

## XIQ (`xiq.py`, `xiq_client.py`) — ExtremeCloud IQ

Ported from `reference/lib/XIQFleetClient.php`.

- **Endpoint:** `GET /devices?views=BASIC` (paged, `limit=100`,
  `total_pages` drain). Bearer token (`[xiq] api_token`).
- **Writes:** `device_state` dimension `source_status` per matched device —
  `up` (connected, ok) / `down` (not connected, crit) / `blind` (source
  unreachable, warn). Backfills empty `devices.mgmt_ip` from XIQ `ip_address`.
- **Interval:** `[xiq] status_interval_s` (default 180s).
- **Rate limits:** 7,500 req/hr per VIQ, **shared across all integrations**
  (Zabbix, SolarWinds, NetMon). `RateLimit-Remaining`/`-Reset` tracked; a low-
  quota warning logs under 500 remaining.
- **Failure modes:**
  - 401 / transport / 5xx → **blind**: every XIQ device's `source_status` set
    to `blind`, error recorded, raised loud. Never stale-as-fresh.
  - 429 → throttled, **not** blind: prior state left intact, health error
    recorded, back off.
  - A device in the registry but absent from a successful fleet fetch → prior
    state left untouched (not fabricated).
- **Config:** `[xiq] enabled`, `api_token` (secret), `base_url`,
  `status_interval_s`.

A misconfigured enabled source (e.g. empty token) is logged and skipped at
startup — it does not crash the app.

---

## PacketFence (`packetfence.py`, `pf_client.py`) — NAC

Ported from `reference/lib/PFClient.php`.

- **Auth:** `POST /api/v1/login` → token, sent **raw** in `Authorization`
  (no `Bearer`); one auto-refresh on 401. `/search` returns **404 on empty** →
  treated as empty, not an error.
- **What it does:** refreshes a cached NAC snapshot (registered / unregistered
  counts, recent 802.1X rejects, node list) served by `GET /api/nac`. **Not**
  written to `device_state` — PF stays a linked view pending the §9 merge
  decision.
- **Interval:** `[packetfence] interval_s` (default 300s — PF is slow; cache
  hard, never in a request path).
- **Failure modes:** on PF unreachable the task fails loud into
  `collector_health`; the cached snapshot keeps its last-good `fetched_at`
  (`ok:false` flags staleness). Never stale-as-fresh.
- **Config:** `[packetfence] enabled, url, user, pass, verify_ssl, interval_s`.

## Milestone (`milestone.py`, `milestone_client.py`, `ws.py`) — surveillance

Ported from `reference/zabbix/milestone/*`.

- **Auth:** OAuth2 password grant `POST /IDP/connect/token`
  (`client_id=GrantValidatorClient`) → bearer token.
- **Config API poll** (`/api/rest/v1/recordingServers`, `/cameras`): writes,
  for devices matched by `milestone_hardware_id`, `source_status` for recording
  servers (running → up/down) and the `recording` dimension for cameras. Blind
  on unreachable. Interval `[milestone] interval_s` (default 120s).
- **Live Events/State WebSocket** (`ws.py` `ResilientWebSocket`): reconnect +
  exponential backoff + watchdog (forces reconnect on silence). Built and
  tested (forced-disconnect / watchdog), and runnable standalone. **Wiring it
  to a live Milestone socket needs the `websockets` dependency (owner approval
  pending)** — until then the Config-API poll provides state.
- **Config:** `[milestone] enabled, host, user, pass, scheme, client_id,
  verify_ssl, interval_s`.

Both collectors are standalone-runnable
(`python -m netmon.collectors.packetfence|milestone --once|--loop`).
