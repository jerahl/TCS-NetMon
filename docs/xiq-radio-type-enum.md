# XIQ client `radio_type` — what the integers mean

**Task #15 · investigated and fixed 2026-07-28 · verdict: MAPPING ESTABLISHED (authoritative + corroborated)**

## Verdict

`GET /clients/active` returns `radio_type` as an **integer enum**, not a band
string:

| `radio_type` | Meaning | `wireless_clients.band` written |
|---|---|---|
| `1` | 2.4 GHz | `2.4` |
| `2` | 5 GHz | `5` |
| `3` | **WIRED** | `wired` |
| `4` | 6 GHz | `6` |
| `5` | THREAD | `thread` |

This is not an inference. It is the enum XIQ itself publishes for *this tenant's
own API version*.

## Evidence

### 1. Authoritative — the tenant's published schema

`GET /openapi` (read-only, no auth-state change), **ExtremeCloud IQ API
`25.11.1-3`**, `components.schemas.XiqClient.properties.radio_type`:

```json
{"type": "integer",
 "description": "The radio type. Represented by an integer code for each standard:<br> 1 - 2.4G<br> 2 - 5G<br> 3 - WIRED<br> 4 - 6G<br> 5 - THREAD",
 "format": "int32"}
```

The same document defines the *AP radio* band field differently — a **string**
enum `XiqRadio.frequency ∈ {"2.4GHz", "5GHz", "6GHz"}` — which is why one code
path worked and the other silently did not.

### 2. Empirical corroboration — live fleet, read-only GETs

One full drain of `/clients/active?views=FULL` (39 pages) plus
`/devices?views=FULL` (14 pages), 2026-07-28. Every client row carries three
independent band tells: `channel`, `mac_protocol`, `interface_name`.

**3,870 client rows sampled. Only two `radio_type` values are present on this
fleet.**

| `radio_type` | rows | `channel` | `mac_protocol` | `interface_name` | reading |
|---|---|---|---|---|---|
| `2` | **582** | 100% in 5 GHz UNII (36/40/44/48/149/153/157/161/165); **zero** in 1–14; zero 6 GHz | `802.11ax-5g` 469, `802.11ac` 94, `802.11a` 15, `802.11na` 4 — all 5 GHz PHYs | `wifi0.x` / `wifi1.x` | **5 GHz — proven** |
| `3` | **3,288** | null on 3,282; 6 rows carry a stale 5 GHz channel | `N/A` 825, null 2,461 (2 stale strays) | switch-port notation (`1:51`, `5:36`, `2:14`, …) | **WIRED — proven** |

Supporting facts for `radio_type = 3` = wired: every one of those rows has a
`product_type` that is a **switch** (`X465_48P`, `SwitchEngine_5520_48W`,
`X435_8P_4S`, `NOT_PRE_DEFINED_STACK`, …), never an AP model, and
`connection_type` is `2`/`-1` rather than the `1` seen on all 582 wireless rows.
Conversely every `radio_type = 2` row sits on an AP model (`AP_305C` 505,
`AP_650` 73, `AP_410C` 4).

**Codes `1`, `4` and `5` were not observed on this fleet** — consistent with the
reference dashboard's standing note that "the TCS fleet runs 5 GHz only (2.4 GHz
radios are disabled across the board)" (`reference/actions/ActionXiqData.php`
`bandShells()`), and with 6 GHz not being enabled on the 6E-capable `AP_650`s.
Their meaning therefore rests on the published schema (evidence 1) rather than on
observation, which is exactly why the collector now makes an unexpected value
loud instead of guessing.

### 3. `reference/` (ZCD) — no int mapping, and it read the field differently

ZCD never mapped these integers. It requested the *narrow* projection
`GET /clients/active?fields=ID,RADIO_TYPE,OS_TYPE,SSID`
(`reference/lib/XIQFleetClient.php:132`) and treated the result as a **PHY
standard string**, substring-matching `AX`/`AC`/`11N`/`6E` to build the
Wi-Fi-generation donut (`reference/actions/ActionXiqData.php:707`) — it never
derived a band from it at all. So the reference is *not* authoritative here; it
is only evidence that the field has been ambiguous for a while. (Note the same
substring logic would also silently degrade to "legacy" for every client if that
view returns ints too — a ZCD-side observation, not a NetMon bug.)

## The bug

`netmon/collectors/xiq.py:82` `_band()` did
`_BANDS.get(str(raw or "").strip().upper())`, and `_BANDS` held only band
*strings* (`"5G"`, `"5GHZ"`, …). Fed an int, `str(2)` → `"2"` → no key → `None`.

Confirmed in production before the fix:

```
SELECT COUNT(*) n, SUM(band IS NULL) nullband FROM wireless_clients;
-> n = 3874, nullband = 3874          -- 100% NULL
SELECT band, COUNT(*) FROM wireless_clients GROUP BY band;
-> (NULL, 3874)                        -- one bucket
```

Nothing complained: `collector_health` for `xiq` showed `last_error = NULL`,
`records_written = 934`, a clean `last_success`. The Wireless page's
"Clients by band" stat rendered `—` and read as "no data", not "broken".

## Fix (implemented)

`netmon/collectors/xiq.py`:

1. **`_CLIENT_RADIO_TYPES = {1: "2.4", 2: "5", 3: "wired", 4: "6", 5: "thread"}`**
   with the schema quote and the corroboration recorded inline.
2. **`_client_band()`** for the client path (int enum, tolerant of numeric
   strings, still accepts textual `"5G"`/`"2.4GHz"` so a `fields=RADIO_TYPE`
   view or an older tenant keeps working). `_band()` stays the AP-radio
   `frequency` path. Absent/blank still yields `None` — "XIQ said nothing" is
   distinct from "XIQ said something we don't understand".
3. **Unmapped values are now visible (§4.5)** — the specific thing that let this
   hide for weeks:
   - a **rate-limited WARNING** naming the field and the offending value, at
     most once per distinct value per 5 min (`UNMAPPED_WARN_INTERVAL_S`), so a
     source-side enum change is loud without flooding the log;
   - a **per-cycle tally published to `snapshot_cache['xiq.unmapped_enums']`** —
     `ok = 1, {"counts": {}, "total": 0}` on a clean cycle; `ok = 0` plus
     `{"clients.radio_type=42": 3870, "total": 3870}` when something is
     unmapped. Queryable, badge-able, and it does not scroll away;
   - the clients cycle log line now carries its **per-band histogram**
     (`by band: {'5': 582, 'wired': 3288}`), so an all-`unknown` cycle is
     obvious at a glance.
   No migration and no new dependency: `snapshot_cache` is the existing
   spec-10 §3 table and `write_snapshot` the existing writer.

Verified against the real payload (3,870 live rows replayed through
`build_client_rows`, no DB write): `{'5': 582, 'wired': 3288}`, **zero NULL,
zero unmapped**.

Tests (`tests/test_xiq.py`, suite green):
`test_client_band_maps_the_integer_radio_type_enum`,
`test_unmapped_radio_type_is_loud_not_silently_null`,
`test_client_bands_persist_and_unmapped_values_reach_snapshot_cache`.
`tests/fixtures/xiq_clients_active.json` now carries the **real** shape — int
`radio_type` plus `channel`/`mac_protocol`/`interface_name` (sanitized).

`band` is `VARCHAR(8)` (migration 011), so `wired` / `thread` fit; no schema
change.

## Adjacent findings (NOT fixed here — separate tasks)

1. **`ap_radios` is empty (0 rows) and cannot fill from the current code path.**
   `build_ap_rows()` reads `radios[]` off the fleet payload, but
   `GET /devices?views=FULL` **does not return a `radios` key at all** — 0 of
   1,364 live device rows had one. In API 25.11.1 radios come from a separate
   endpoint, **`GET /devices/radio-information`** (schema `XiqRadioEntity` →
   `XiqRadio`). The field names differ from what the collector expects too:
   `channel_number` (not `channel`), `channel_width` as `"MHZ_20"`-style strings
   (so `_width_mhz()`'s leading-digit regex returns `None`), `clients` as an
   *array* of clients (not a count), and `mode` (`_11ax_5g`) alongside
   `frequency`. The `frequency` values are exactly `2.4GHz`/`5GHz`/`6GHz`, so
   `_band()`'s string map is correct once real radios actually arrive. The
   AP-detail page's radio table is therefore blank today.
   `tests/fixtures/xiq_devices_full.json` encodes the *assumed* shape (`"5G"`,
   `channel`, `"80MHz"`, `clients: 5`) and should be replaced when that path is
   fixed — it is deliberately left alone here so as not to break the existing
   tests for behaviour this task did not change.
2. **`wireless_clients` is ~85% wired clients.** 3,288 of 3,870 rows are switch
   clients (`radio_type = 3`). They are now honestly labelled `band = 'wired'`
   rather than NULL, but whether the *Wireless* page should store or count them
   at all is a product decision for the owner — filtering them out would drop
   85% of the table and change what "clients" means on that page, so no
   behaviour was changed. Note `frontend/src/pages/xiq.jsx:77` renders only the
   `2.4`/`5`/`6` buckets, so `wired` is currently omitted from the "Clients by
   band" chip rather than shown; surfacing it (or excluding wired rows) is a
   follow-up.
3. **A NetMon Status surface for `xiq.unmapped_enums` does not exist yet.** The
   signal is in the DB (`ok = 0`) and in the log; wiring a badge onto the NetMon
   Status page would need a small `/api/collector-health` (or status) addition,
   which is out of scope for this fix.

## Reproducing / re-checking after an XIQ upgrade

The enum is versioned with the API, so re-read it rather than trusting this doc
after a tenant upgrade — one read-only GET:

```
GET {base_url}/openapi        # Authorization: Bearer <[xiq] api_token>
# → components.schemas.XiqClient.properties.radio_type.description
```

Effective config (DB overlay over file — the conf file alone is not the truth):

```python
cfg = settings.overlay_config(config.load_config('/etc/netmon/netmon.conf'), engine)
```

All probing for this task was read-only GETs (`/clients/active`, `/devices`,
`/openapi`); ~55 calls total against a 7,500/hr tenant quota, one drain being
equivalent in cost to a single normal clients cycle. No credential, hostname,
username, MAC or client identifier was written to the repo, the tests, or this
document.
