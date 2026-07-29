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
  `up` (connected, ok) / `down` (not connected, crit) / `unknown` (XIQ isn't
  managing it, see below) / `blind` (source unreachable, warn). Backfills empty
  `devices.mgmt_ip` from XIQ `ip_address`.
- **`device_admin_state` gates up/down** (`source_state`): XIQ reports
  `connected: false` for every device it is not actively managing
  (`UNMANAGED` / `NEW` / `BOOTSTRAP`), so only `MANAGED` devices get a real
  `up`/`down` — the rest map to `unknown`, never crit. Reading `connected`
  alone flagged 13 switches down district-wide while 11 of them were answering
  SNMP (2026-07-27). A missing `device_admin_state` is treated as managed.
- **AP-detail cycles (10.2):** the `detail`/`radios`/`clients`/`ssids` cycles
  persist `ap_details`/`ap_radios`/`wireless_clients`/`ssids`. **NetMon's registry
  `device_type` is authoritative** — only devices typed `ap` flow through the
  AP-detail path. Switches federated from XIQ get up/down `source_status`
  only; their port/PoE/FDB detail comes from the SNMP inventory sweep, never
  the AP endpoints, even when XIQ reports a switch's `device_function` as an
  AP. Correct a mis-classified device from the web Registry (device edit) —
  the type override is insert-only in the seed/import upsert, so it survives
  re-imports. (XIQ's switch-specific wired-client grid is a **POST** — a
  non-GET source call, owner-gated per CLAUDE.md §2/§4.1 — not implemented.)
- **Radios are NOT on the device payload.** `XiqDevice` has no `radios`
  property in the published schema and 0 of 1,364 live `views=FULL` rows carried
  one, so `ap_radios` sat at **0 rows** while the collector logged clean
  successes and the AP Detail radio table rendered blank (fixed 2026-07-28 —
  `docs/xiq-ap-radios.md`). They come from **`GET /devices/radio-information`**
  (`XiqRadioEntity` → `XiqRadio`), whose field names differ from what the old
  code assumed: **`channel_number`** (not `channel`) and **`channel_width` as
  the enum `MHZ_20|MHZ_40|MHZ_80|MHZ_160|MHZ_320`** (not `"20MHz"` — the width
  parser is anchored accordingly, or every real radio parses to NULL). `band`
  still comes from `frequency`, a genuine string enum (`2.4GHz`/`5GHz`/`6GHz`),
  never from the radio index: 783 of 783 APs here run wifi0 *and* wifi1 at 5 GHz.
- **`ap_radios.clients` is deliberately NULL.** `XiqRadio.clients` is an array
  of `XiqWirelessClient`, and those objects hold no client identity —
  `network_policy_name`/`ssid`/`ssid_status`/`ssid_security_type`. It is the
  radio's SSID list, not its clients: across 1,574 live radios its ssid set was
  identical to `wlans[]`'s on 1,574/1,574, no radio ever repeated an ssid, and
  the per-AP total took only two values (3 or 6) while XIQ's own
  `active_clients` for those APs ran 1..30+. `len()` would write the same "3"
  onto every radio in the fleet, so the column stays empty and the page renders
  "—" (§4.5). A real per-radio count is derivable from `/clients/active`'s
  `interface_name` (`wifi0.1`) — a follow-up, not a guess.
- **Client band is an INTEGER enum.** `/clients/active` returns `radio_type`
  as an int, not a band string: **1 = 2.4G, 2 = 5G, 3 = WIRED, 4 = 6G,
  5 = THREAD** (verbatim from the tenant's own `GET /openapi`, ExtremeCloud IQ
  API 25.11.1-3; corroborated against live `channel`/`mac_protocol` — see
  `docs/xiq-radio-type-enum.md`). Mapping it through the *AP radio* band map
  (`XiqRadio.frequency`, a string enum: `2.4GHz`/`5GHz`/`6GHz`) left
  `wireless_clients.band` NULL for **every** client until 2026-07-28.
  `/clients/active` also returns **wired switch clients** (≈85% of rows on this
  fleet), which is why `wired` is a real band label here.
- **Unmapped enum values are loud, not NULL (§4.5).** Any `radio_type` /
  `frequency` / `channel_width` value the maps don't cover logs a WARNING
  (rate-limited to one per distinct value per 5 min) and is counted into
  `snapshot_cache` key
  `xiq.unmapped_enums` — `ok=1, total=0` on a clean cycle, `ok=0` plus
  `{value: count}` when something is unmapped. The clients cycle also logs its
  per-band histogram, so an all-`unknown` cycle is obvious. Query it with:
  `SELECT ok, payload FROM snapshot_cache WHERE \`key\` = 'xiq.unmapped_enums';`
- **Interval:** `[xiq] status_interval_s` (default 180s).
- **Rate limits:** 7,500 req/hr per VIQ, **shared across all integrations**
  (Zabbix, SolarWinds, NetMon). `RateLimit-Remaining`/`-Reset` tracked; a low-
  quota warning logs under 500 remaining. The `radios` cycle adds
  `ceil(APs / 50)` calls per run — `deviceIds` is a required parameter and
  `limit` caps at 50, so there is no cheaper fleet-wide form: **16 calls per
  cycle for 783 APs, ≈192/h at the 300 s default**, taking the collector from
  ≈1.3–1.6k to ≈1.5–1.8k calls/h (~24% of quota). `radios_interval_s` /
  `radios_enabled` throttle or disable it.
- **Failure modes:**
  - 401 / transport / 5xx → **blind**: every XIQ device's `source_status` set
    to `blind`, error recorded, raised loud. Never stale-as-fresh.
  - 429 → throttled, **not** blind: prior state left intact, health error
    recorded, back off.
  - A device in the registry but absent from a successful fleet fetch → prior
    state left untouched (not fabricated).
  - A failed `radios` fetch raises before `replace_rows`, so the previous
    `ap_radios` rows stay visible-and-stale (badged by `updated_at`) instead of
    being wiped.
- **Config:** `[xiq] enabled`, `api_token` (secret), `base_url`,
  `status_interval_s`, `detail_enabled`/`detail_interval_s`,
  `radios_enabled`/`radios_interval_s`, `clients_enabled`/`clients_interval_s`,
  `ssids_enabled`/`ssids_interval_s`.

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
