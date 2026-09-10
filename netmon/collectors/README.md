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
- **Events/State snapshot** (inside the cycle): `startSession → addSubscription
  → getState` over the ESS WebSocket, ~16,500 states out of one ~4 MB reply.
  Gives per-camera `source_status` (the Config API has no such field) and the
  four recording-server state columns. Runs every `interval_s`.
- **Live Events/State subscription** (`ess_live.py`, spec 20 S7) — **default
  off**, `[milestone] ess_live = true` to enable. Holds the same subscription
  open and applies camera `source_status` as events arrive, instead of once a
  cycle.
  - *Stream shape (measured live 2026-09-08):* frames are `{"events":[…]}` with
    no top-level command; each event carries the same six keys a `getState`
    state does, so one parser serves both. ~61 frames/s, ~200 events/s.
  - *What is written:* only `Communication*` events, which move
    `source_status`. Motion and recording churn — 9,354 MotionStart and 2,406
    RecordingStarted in one 120 s sample — is counted and **dropped**: writing
    it would bury `state_events` under an estate behaving normally.
  - *Batching:* deltas are coalesced per camera and written once per
    `ess_live_flush_s` (default 5 s), never per event. A failed flush keeps its
    deltas for the next one, and a newer verdict always wins over a retried one.
  - *Reconnect:* `ws.py`'s backoff, watchdog `ess_live_watchdog_s` (default
    180 s — higher than ws.py's 60 s because overnight the motion traffic that
    dominates the stream stops). Every reconnect re-applies the full `getState`
    snapshot, so anything missed while down is repaired immediately.
  - *Two writers, on purpose:* the 120 s snapshot keeps running. Both derive the
    same dimension from the same interface, `write_states` logs a transition
    only when a value actually moves, and the newer observation wins — so the
    cycle acts as a repair for anything the stream missed. Recording-server
    state columns stay the cycle's alone (it owns that row with a
    replace-on-refresh upsert).
  - *Observability:* `collector_health` row `milestone_ess_live` plus a live
    panel on NetMon Status (socket state, reconnects, frames, events, applied,
    busiest event types). Snapshot states are counted apart from stream events,
    because a connect stages ~2,500 `CommunicationStarted` states and mixing
    them makes the stream look like it carries camera changes it does not.
- **Device identity backfill** (`/api/rest/v1/hardware/{id}/hardwareDriverSettings`):
  MAC, serial, firmware and vendor per hardware record → `cameras.mac/serial/
  firmware/vendor` (migration 025). **This is the only place Milestone exposes a
  camera MAC** — neither `/cameras` nor `/hardware` carries one, which is why
  `cameras.mac` was NULL estate-wide for months even though the Management
  Client shows a MAC for every camera.
  - *Rate limit shape:* no collection form. Asking for `/hardwareDriverSettings`
    without a parent answers HTTP 400 telling you to prefix it, so this is one
    request per hardware record at ~300 ms — ~12 min for 2,489 if swept whole.
    Each cycle therefore fetches at most `identity_batch` of the records still
    missing a MAC; at the defaults the estate fills in ~30 min and then costs
    nothing, since the values are static.
  - *Failure mode:* soft and per-record. A hardware that errors leaves its
    cameras NULL and adds `identity` to the overview's `degraded` list, so a
    stalled backfill is distinguishable from a finished one.
  - *Gotcha:* an unrecognised query param on this API returns `{"array": []}`
    rather than an error — `/hardware?fields=all` reports zero hardware. Treat
    an unexpectedly empty array as a malformed request, not an empty fleet.
- **Config:** `[milestone] enabled, host, user, pass, scheme, client_id,
  verify_ssl, interval_s, identity_batch, identity_concurrency, ess_live,
  ess_live_flush_s, ess_live_watchdog_s`.

Both collectors are standalone-runnable
(`python -m netmon.collectors.packetfence|milestone --once|--loop`).

## Camera operations (`netmon/cameras/`) — the one write to hardware

Not a collector: `[camera_ops]`, spec 20 S8 / gate D11, **default off with
dry-run on**. Listed here because it shares the vendor-profile idiom and because
its *read* half is a source read like any other.

- **Reading a Bosch camera's firmware:** RCP+ over the same credentialed HTTPS
  the snapshot proxy uses —
  `GET /rcp.xml?command=0x0cd4&type=P_STRING&direction=READ`
  (`CONF_SOFTWARE_VERSION_FORMATTED`, RCP+ reference 9.80 §2.612). Returns
  `<major>.<minor>.<build>`.
  - *Gotcha:* the value is **not** in `<payload>` — that echoes the request and
    is always empty. It is in `<result><str>`.
  - *Why the formatted command:* the compact form (`783`) that 888 cameras
    report through Milestone can confirm a release but never a build, so it can
    only ever verify as `indeterminate`. Asking the camera directly is what
    makes a firmware roll provable.
- **Verification order:** vendor read, then Milestone's stored value. Which one
  answered is recorded per item in `camera_batch_items.verified_by`, because a
  Milestone-sourced confirmation is at most one identity-backfill cycle old and
  is weaker evidence.
- **Writing** (firmware upload) is a multipart POST to `/upload.htm` with the
  file in a part named **`net.bin`** — both read off the camera's own service
  page, not inferred; `net.bin` appears in no documentation and is not an RCP+
  command.
  - *Authenticate first, always.* Digest costs a challenge round trip, and httpx
    pays it by sending the request unauthenticated once. With a 91 MiB image
    that means shipping the whole file to be told "authenticate first", and the
    camera drops the connection — two live attempts died at 0.8s before this was
    understood. A cheap GET primes the challenge on the same auth object.
  - *Proven on hardware 2026-09-08:* alb-cam-44 went 7.83.0027 → 7.93.0024,
    verified by its own RCP+ read, 1m55s end to end.
  - Still gated: `[camera_ops]` flags plus `proving_device_id`, which restricts
    pre-flight to one nominated camera.
- **Config:** `[camera_ops] enabled, dry_run, config_change, firmware_update,
  user/pass or use_snapshot_credentials, proving_device_id, firmware_dir,
  canary_count, ring_size, max_concurrent, max_batch, abort_pct,
  reboot_timeout_s, connect_timeout_s, timeout_s, verify_ssl`.

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

## Micetro (`micetro.py`, `micetro_client.py`) — DDI: DNS / DHCP / IPAM

New in spec 21 (`docs/spec/21-micetro-ddi.md`) — no ZCD ancestor; this is a
source Zabbix never federated.

**What gap it closes.** `fdb_entries` learns every MAC that forwards a frame;
`pf_nodes` only knows the endpoints PacketFence authenticated. So the
port-detail identity pane showed a card for the Chromebooks and a bare hex
string for the printers, cameras, AV gear and static servers — exactly the
population an operator opened the pane to identify. Micetro is the district's
DDI system of record and holds the missing join, IP ↔ MAC ↔ DNS name, for all
of them.

- **Auth:** HTTP **Basic** on every request; **HTTPS enforced in code** (the
  credential rides every call). Base path `/mmws/api/v2`.
- **Read-only, structurally.** The API docs steer you to
  `POST /micetro/sessions` for a Bearer token, but Basic auth makes that
  unnecessary ("the Login command becomes unnecessary, and the session ID is
  not used" — vendor docs), so the client **has no non-GET method at all**.
  `tests/test_micetro.py::test_client_has_no_non_get_method` parses the module
  AST to keep it that way; adding a write is a reviewable diff needing owner
  sign-off (CLAUDE.md §4.1).
- **NOT SCHEDULED** (owner, 2026-09-09; spec 21 §7b). The only source with no
  supervised task. Mirroring the address space cost ~2,000 requests per sweep
  and measured out at **16 MACs** named that PacketFence could not already name
  (§7a), so lookups moved to search time. `[micetro] enabled` therefore means
  "NetMon may query Micetro at all", **not** "poll".
- **On-demand:** `GET /api/ddi/resolve?ip=` is one request (~0.2s — `addrRef`
  takes a literal IP). `?mac=` has no global equivalent: Micetro stores a MAC
  as a *client identifier*, so NetMon tries an IP it already knows for that MAC
  (PF covers ~84% of FDB MACs) and **only trusts it if Micetro confirms the
  MAC** — a re-leased address holds someone else — then falls back to fanning
  `filter=<mac>` across all 261 subnets (~5s hit, ~10s to prove absence).
  `deep=false` declines that and says why. One scan at a time process-wide;
  60s result cache; writes nothing to the DB.
- **Filtering works**, contrary to an earlier note here: `field=value` with `^`
  for prefix, and a bare value is a free-text match. The "broken" claim came
  from probing `state=Assigned` against a range holding no Assigned addresses
  and misreading the correct 0.
- **Endpoints:** `GET /ipamRecords/<ip>` (lookup), `GET /ranges` +
  `GET /ranges/{ref}/ipamRecords` (the unscheduled `--once` sweep),
  `GET /dhcpScopes`. All list calls `offset`/`limit` paged.
- **Writes:** `ddi_addresses` + `ddi_scopes` (migration 031), replace-on-refresh.
  **No `device_state`** — a DHCP scope is not a device and the dimension column
  is an ENUM, so scope utilization is *visible but silent* until that data-model
  question is answered (spec 21 §6 / Q3). Snapshot keys `micetro.addresses` and
  `micetro.dhcp` carry per-run coverage counts.
- **MAC precedence:** lease → reservation → ARP discovery, with the winner's
  origin stored in `mac_origin`. A lease means the DHCP server handed that
  address to that MAC; discovery can be a scan interval stale. DHCPv6 leases
  carry `duid`/`iaid` rather than a MAC, so v6-only addresses identify by name
  alone (spec 21 Q5).
- **Scale.** Micetro's address space is not NetMon's device count — one `/16`
  container holds 65,534 addresses against a ~3,600 device registry. Only
  `subnet = true` ranges are walked, and a record is kept only if it carries a
  MAC, a DNS name, a lease, a reservation, or a non-`Free` state. Rows therefore
  scale with *assignments*.
- **Failure modes.** `max_records` / `max_ranges` **raise** rather than
  truncate — a half-mirror that looks complete is the fabrication §4.5 forbids,
  and the first `--once` run reports the real numbers to raise them to. Any
  fetch error raises before a single row is written, so prior rows stay visibly
  stale. A pager that ignores `offset` trips `MAX_PAGES` and fails loud.
- **`--once` only, for DHCP scopes.** 261 scopes in 2 requests; fleet-wide
  capacity has no search-time equivalent (nobody searches for "which pools are
  full") and it is where the uncontested value was — 2 pools at 100%.
  `sweep_addresses` defaults **off**; it is the expensive half.
- **Config:** `[micetro] enabled, url, username, password, verify_ssl,
  deep_scan, lookup_concurrency, cache_ttl_s, sweep_addresses, sweep_scopes,
  page_size, max_records, max_ranges, scope_warn_pct, scope_crit_pct`.
