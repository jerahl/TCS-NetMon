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
- **What it does (Phase 10.3):** persists one `pf_nodes` row per MAC — identity
  (`/nodes/search`, cursor-paged) + role *name* (`/node_categories`, resolves
  the numeric `category_id`) + current switch/port/ssid/802.1X (open
  `/locationlogs/search`), merged and replace-on-refreshed via
  `db.replace_rows`. All three fetches are required — partial data must never
  overwrite good rows (§4.5). Page-level singletons go to `snapshot_cache`
  keys (`pf.rejects`, `pf.cluster`, `pf.services`, `pf.queues`, `pf.sources`,
  `pf.profiles`, `pf.violations`), each **fail-soft**: a failing endpoint
  flips only its key to `ok=0` and never blocks the node cycle. Served by
  `/api/nac[/nodes|/sessions|/quarantine|/policies|/cluster]` (DB-only; the
  Phase-5 in-memory snapshot is gone). `pf_nodes.mac` is the FDB⋈PF and
  wireless-client identity join key.
- **Interval:** `[packetfence] interval_s` (default 300s — PF is slow; cache
  hard, never in a request path).
- **Failure modes:** node fetch failure fails loud into `collector_health` and
  leaves `pf_nodes` visibly stale (never blanked); a snapshot-endpoint failure
  is isolated to its key (`ok=0`). Never stale-as-fresh.
- **Config:** `[packetfence] enabled, url, user, pass, verify_ssl, interval_s, node_limit`.
- **Snapshot endpoint paths** (`SNAPSHOT_FETCHES` in `packetfence.py`) follow
  PF's documented v1 REST surface — confirm against production PF 12.3; a
  wrong path shows `ok=0` on the NAC Policies/Cluster tabs (the honest signal).

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

## 3CX (`threecx.py`, `threecx_client.py`) — voice

Ported from `reference/lib/ThreeCXClient.php`. **v20 REST, not ODBC** (Phase 0
decision).

- **Auth:** OAuth2 client-credentials → `POST /connect/token` → bearer (cached,
  refreshed on 401).
- **Endpoint:** `GET /xapi/v1/Trunks` (OData). Writes `device_state` dimension
  `trunk` (registered → up/down) for devices matched by `threecx_ref`. Blind on
  unreachable. Interval `[threecx] interval_s` (default 120s).
- **Config:** `[threecx] enabled, url, client_id, client_secret, verify_ssl,
  interval_s`.

## rConfig (`rconfig.py`, `rconfig_client.py`) — config-backup freshness

Ported from `reference/lib/RConfigClient.php`.

- **Auth:** `apitoken: <token>` header (not Bearer); **HTTPS only**.
- **Endpoint:** `GET /api/v2/devices` (paged). Writes `device_state` dimension
  `config_backup` — `fresh` (≤ `stale_after_s`, default 7d) / `stale` / `unknown`
  (timestamp unreadable — never fresh-when-unsure) — for devices matched by
  `rconfig_device_id`. Blind on unreachable. Interval `[rconfig] interval_s`
  (default 600s).
- **Config:** `[rconfig] enabled, url, api_token, verify_ssl, interval_s,
  stale_after_s`.

Both are standalone-runnable (`python -m netmon.collectors.threecx|rconfig`).
