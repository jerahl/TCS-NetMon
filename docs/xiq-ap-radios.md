# `ap_radios` was empty — radios are not on the device payload

**Task #18 · investigated and fixed 2026-07-28 · verdict: ROOT CAUSE CONFIRMED (authoritative + corroborated), FIXED**

## Verdict

`ap_radios` had **0 rows** and could never fill, because `build_ap_rows()` read a
`radios` key off `GET /devices?views=FULL` that **does not exist**:

- `XiqDevice` has **no** `radios` property in the tenant's published schema, and
- **0 of 1,364** live `views=FULL` rows carried one (re-verified today).

Radios come from a separate endpoint, **`GET /devices/radio-information`**, whose
field names differ from the ones the collector guessed. The AP Detail page's
"Radios" card was therefore blank for the entire life of Phase 10.2, while
`collector_health.xiq` reported clean successes.

## The authoritative field list

`GET /openapi` (read-only), **ExtremeCloud IQ API `25.11.1-3`** — the same source
that settled the client `radio_type` enum (task #15).

### `GET /devices/radio-information` → `PagedXiqRadioEntity`

| Parameter | In | Required | Notes |
|---|---|---|---|
| `deviceIds` | query | **yes** | array of int64. **There is no fleet-wide form** — you must name the devices. |
| `page` | query | no | min 1, default 1 |
| `limit` | query | no | **max 50**, default 10 (the other list endpoints allow 100) |
| `includeDisabledRadio` | query | no | default `false` — left at the default, see below |

Envelope: `{page, count, total_pages, total_count, data: [XiqRadioEntity]}`
(confirmed live: `count`/`total_count`/`total_pages` all present).

`XiqRadioEntity` = `{device_id: int64, radios: [XiqRadio]}` — one entity per
device, so `limit` is effectively a *device* page size.

### `XiqRadio` — every field, verbatim from the schema

| Field | Type | Values (schema) | `ap_radios` column |
|---|---|---|---|
| `name` | string (**required**) | `wifi0` / `wifi1` / `wifi2` live | `radio` |
| `channel_number` | integer int32 | — | `channel` |
| `channel_width` | string (**required**) | **enum** `MHZ_20`, `MHZ_40`, `MHZ_80`, `MHZ_160`, `MHZ_320` | `width_mhz` (digits parsed) |
| `mode` | string (**required**) | enum `_11bg _11a _11an _11ng _11ac _11ax_2g _11ax_5g _11ax_6g _11be_2g _11be_5g _11be_6g` | *(not stored — no column; corroborates band)* |
| `mac_address` | string | `XXXXXXXXXXXX` | *(not stored — no column)* |
| `power` | integer int32 | dBm | `tx_power_dbm` |
| `frequency` | string | **enum** `2.4GHz`, `5GHz`, `6GHz` | `band` |
| `clients` | array of `XiqWirelessClient` | see below | **NULL — deliberately** |
| `wlans` | array of `XiqWirelessWlan` | adds `bssid` | *(not stored — no column)* |

Nothing was invented and no column was added: `util_pct` / `noise_dbm` stay NULL
as they always have ("NULL until sourced", migration 011).

### The trap: `clients` is an SSID list, not a client count

`XiqRadio.clients` is an array of **`XiqWirelessClient`**, whose *only* fields
are `network_policy_name`, `ssid`, `ssid_status`, `ssid_security_type`. There is
no client identity anywhere in the object — it is a per-WLAN descriptor. Live
proof (783 APs, 1,574 radios, one read-only drain, 2026-07-28):

| Test | Result |
|---|---|
| `clients[]` ssid-set vs `wlans[]` ssid-set | identical on **1,574 / 1,574** radios |
| radios whose `clients[]` repeats an ssid (would prove per-client) | **0** of 1,565 non-empty |
| distinct per-AP totals of `len(clients[])` | only **`{3, 6}`** (= SSIDs × radios) |
| agreement with XIQ's own `active_clients` (which runs 1..30+) | **1 of 783 APs** |
| element key set, every element | `{network_policy_name, ssid, ssid_security_type, ssid_status}` |

So `len(radio["clients"])` would have written the same **`3`** onto essentially
every radio in the fleet. That is a plausible-looking fabricated number, which
§4.5 forbids far more than an empty column, so **`ap_radios.clients` is written
as NULL** and the AP Detail page renders `—` (it already uses `r.clients ?? "—"`).

A real per-radio client count *is* obtainable: `/clients/active` carries
`interface_name` (`wifi0.1`, `wifi1.3`), which attributes each client to a
specific radio — exact even on the dual-5G APs where band alone cannot. That
needs the radios and clients cycles to agree on a refresh, so it is recorded as
a follow-up rather than guessed at here.

### `includeDisabledRadio` stays `false`

`XiqRadio` has **no enabled flag**, so a disabled radio is indistinguishable
from one on the air. On this fleet 2.4 GHz is disabled almost everywhere (only 8
radios report it); listing the rest with a channel and a power level would read
as "broadcasting". Absent is the honest answer. If the owner wants disabled
radios shown, that needs a column to mark them, i.e. a migration.

## What changed

**`netmon/collectors/xiq_client.py`**
- New `get_radio_information(device_ids, batch=50)` → `XiqRadioEntity` rows.
  GET only. Batches ids 50 at a time (because `deviceIds` is required and
  `limit` caps at 50) and drains pages within a batch, sequentially on one
  connection — the tenant quota is shared with every other integration.
- `RADIO_PAGE_LIMIT = 50` documented against the schema.

**`netmon/collectors/xiq.py`**
- `_width_mhz()` **fixed**: it used `re.match(r"(\d+)", …)`, anchored at the
  start, which cannot parse `MHZ_20` — and every live radio on this fleet is
  `MHZ_20` (1,574/1,574), so the column would have been 100% NULL the moment
  radios arrived. Now `re.search`, so `"MHZ_20"`, `"20"`, `"20MHz"`, `20` and
  `"mhz_80"` all parse. Absent/blank → NULL silently (XIQ said nothing);
  **present but unparseable → `_note_unmapped()`**, the existing task-#15
  mechanism (rate-limited WARNING + per-cycle tally published to
  `snapshot_cache['xiq.unmapped_enums']`, `ok=0` when non-empty). No second
  mechanism was invented; `channel_width` simply joins `radio_type` and
  `frequency` as a watched field.
- `build_ap_rows()` now returns **only** `ap_details` rows. Its radio loop was
  dead code reading a key XIQ never sends; leaving it would have kept the
  fiction alive.
- New **`build_radio_rows(entities, xiq_to_dev, now, ap_ids, tally)`** →
  `ap_radios` rows. Registry `device_type` stays authoritative (a device NetMon
  types as a `switch` gets no radio rows even when XIQ answers for it), band
  still comes from the radio's own `frequency` and never the index, and rows are
  keyed `(device_id, radio)` so a duplicate can't break the replace.
- New **`radios` cycle** in `run_once`, alongside `detail`/`clients`/`ssids`:
  independently enable/disable-able and intervalled (§4.3) via
  `[xiq] radios_enabled` / `radios_interval_s` (default on, 300 s). It asks only
  for the registry's AP ids. A failed fetch raises **before** `replace_rows`, so
  previous rows stay visible-and-stale instead of being wiped (§4.5). The cycle
  logs its band histogram, so an all-`unknown` cycle is obvious.

**`netmon.conf.example`** — `radios_enabled` / `radios_interval_s` with the call
cost spelled out. **`netmon/collectors/README.md`** — endpoint, field-name traps,
the `clients` decision, failure mode, and the quota arithmetic.

No migration, no new dependency, no schema change, no non-GET call.

## Call-volume impact

`deviceIds` is **required** — there is no bulk/fleet-wide form of this endpoint —
and `limit` caps at 50, so the cost is `ceil(APs / 50)` calls per cycle:

| | |
|---|---|
| Registry APs | **783** |
| Calls per radios cycle | **16** (verified: one full live drain took exactly 16) |
| Cycles/hour at the 300 s default | 12 |
| **Added calls/hour** | **≈192** |
| Collector before | ≈1,300–1,600 /h |
| Collector after | **≈1,500–1,800 /h** |
| Tenant quota (shared with Zabbix/SolarWinds) | 7,500 /h |
| Share of quota after | **≈20–24%** |

This stays inside the ≈25%-of-quota budget spec 11 records, so it ships enabled;
it is not a "blows the budget, stop" case. If headroom does get tight,
`radios_interval_s = 900` drops it to ≈64 calls/h without losing the page, and
`radios_enabled = false` removes it entirely. Worth noting the per-device
alternative would have been **783 calls per cycle** (~9,400/h — over quota on its
own); batching by 50 is what makes this affordable.

## Live verification (read-only, no DB write)

One drain of `/devices/radio-information` for all 783 registry APs (16 GETs),
replayed through `build_radio_rows()` with **no** writer called:

```
registry: 942 XIQ-linked devices, 783 typed 'ap'
live entities replayed:   783
ap_radios rows produced:  1574        (table currently holds 0)
distinct devices covered: 783

band histogram:        {'2.4': 8, '5': 1566}
width_mhz histogram:   {'20': 1574}
radio-name histogram:  {'wifi0': 783, 'wifi1': 783, 'wifi2': 8}
NULL band: 0 · NULL width_mhz: 0 · NULL channel: 0 · NULL tx_power: 0
NULL clients: 1574 (intentional)
channel range:  0 - 165        tx_power range: 0 - 20
unmapped enum tally: {} (clean)
duplicate (device_id, radio) keys: 0
```

**1,574 rows, zero unexpected NULLs, zero unmapped values.** Notes on the shape:

- **Dual-5G is universal here** — all 783 APs run `wifi0` *and* `wifi1` at 5 GHz.
  Deriving band from the radio index would have been wrong 783 times over
  (spec 00 G10); `frequency` is why it is right.
- Only **8 radios report 2.4 GHz** (the `wifi2` of 8 tri-radio APs), consistent
  with the fleet-wide 2.4 GHz disable and with `includeDisabledRadio=false`.
- **100% `MHZ_20`** — which is exactly why the old leading-anchored regex was
  fatal rather than cosmetic.
- **11 radios report `channel_number: 0` together with `power: 0`** (all 5 GHz,
  all with 3 WLANs configured) — a radio that is up but not on a channel. Passed
  through faithfully rather than nulled; inventing a sentinel rule would be a
  guess. The same 11 are among the 15 radios at `power: 0`.
- `mode` corroborates `frequency` perfectly: `_11ax_5g` × 1,566 / `_11ax_2g` × 8.

## Tests

`tests/test_xiq.py` (suite green: **333 passed**, up from 329):

- `test_width_mhz_parses_the_MHZ_20_enum_and_flags_junk` — all five enum members,
  the legacy spellings, blank→NULL-silently, junk→tallied loudly.
- `test_build_radio_rows_uses_the_real_radio_information_shape` — field-for-field
  against the sanitized live payload, dual-5G, switch exclusion, unknown-id drop.
- `test_radio_clients_array_is_never_counted_as_clients` — pins the decision that
  an SSID list must not become a client count.
- `test_radios_cycle_populates_ap_radios_and_keeps_stale_rows_on_failure` —
  asserts the device payload carries no `radios` key yet `ap_radios` fills (5
  rows, `{'5': 4, '2.4': 1}`, no NULL widths), and that a failed radio fetch
  raises while leaving the prior rows in place.
- `test_xiq_cycles_are_interval_gated_and_disableable` — extended: `radios_enabled
  = false` performs no fetch at all, and the cycle is interval-gated.

Fixtures:

- **`tests/fixtures/xiq_radio_information.json` (new)** — structure copied
  verbatim from the live drain, identifiers replaced. Covers dual-5G, a `wifi2`
  2.4 GHz radio with no `wlans` key (exactly as the 8 live tri-radio APs report
  it), a `power: 0` radio, `MHZ_80` alongside the fleet's universal `MHZ_20`, and
  a switch entity that must be ignored.
- **`tests/fixtures/xiq_devices_full.json` (corrected)** — the invented
  `radios[]` arrays (`"5G"`, `channel`, `"80MHz"`, `clients: 5`) are **gone**;
  that fiction is precisely why the old tests passed while production held 0
  rows. Key set now matches the live 1,364-row union, `product_type` uses the
  real `AP_305C` spelling, and one AP omits `active_clients` because two thirds
  of live rows do.

Sanitization (§4.6, spec 10 Q8): no credentials, no real MACs or BSSIDs, no
usernames, no client hostnames, no real device ids. The `clients[]`/`wlans[]`
objects carry no client identity by construction; SSID names are the generic ones
already used across the fixtures.

## Reproducing / re-checking after an XIQ upgrade

The field names and enums are versioned with the API, so re-read them rather
than trusting this document after a tenant upgrade — one read-only GET:

```
GET {base_url}/openapi        # Authorization: Bearer <[xiq] api_token>
# → paths['/devices/radio-information'].get.parameters
# → components.schemas.{PagedXiqRadioEntity,XiqRadioEntity,XiqRadio,XiqWirelessClient}
```

Effective config is the **DB overlay over the file** — the conf file alone is not
the truth:

```python
cfg = settings.overlay_config(config.load_config('/etc/netmon/netmon.conf'), engine)
```

All probing for this task was read-only GETs (`/openapi`, `/devices?views=FULL`,
`/devices/radio-information`): ~45 calls total against a 7,500/hr shared quota,
plus read-only `SELECT`s against NetMon's DB. Nothing was written to `ap_radios`
— the 1,574 figure is what the builder produced in memory.

## Follow-ups (not done here)

1. **Per-radio client counts** from `/clients/active`'s `interface_name`
   (`wifi0.1`) — exact even on dual-5G APs, and free of extra API calls, but it
   requires the radios and clients cycles to share a refresh. Until then
   `ap_radios.clients` is NULL and the page shows "—".
2. **`ap_details.clients_total` is NULL for 489 of 783 APs** because
   `active_clients` is present on only 432 of 1,364 live device rows. Not a
   NetMon bug — XIQ omits it — but the Wireless page's per-AP client column is
   two-thirds empty, and the same `interface_name` roll-up would fix it.
3. `mode` (`_11ax_5g`) and the radio `mac_address`/`bssid` are fetched and
   discarded; a Wi-Fi-generation chip or a BSSID lookup would need columns
   (migration) and is out of scope here.
4. **A NetMon Status surface for `xiq.unmapped_enums` still does not exist** —
   carried over from task #15. The signal is in the DB (`ok = 0`) and the log,
   but nothing badges it, which is how a broken mapping hid for weeks in the
   first place. `channel_width` now feeds the same key, so the gap matters more.
