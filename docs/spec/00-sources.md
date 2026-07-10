# Spec 00 — Sources & Reconnaissance (Phase 0)

**Status:** in progress (owner-driven). This file tracks per-source API access,
rate limits, payload shapes, and the naming/site reconciliation rules the
Phase 1 registry seed depends on.

> Phase 0 is *mostly owner-driven* — live API access verification (tokens,
> reachability, real device counts) happens on the owner's network, not in a
> Claude Code session. Claude Code's contribution here is: (a) documenting the
> API surface that will be ported from the Zabbix add-on in `reference/`, and
> (b) capturing **sanitized** sample payloads as test fixtures.

## Ported-from-reference note

The Zabbix add-on in `reference/` already implements working HTTP clients for
every source. The NetMon collectors (Phase 3+) port the *request shapes,
endpoint paths, field aliases, and hard-won gotchas* from these PHP clients
into Python (`httpx.AsyncClient`). The reference clients are the authoritative
record of what actually works against live TCS infrastructure.

| Source | Reference client | Auth | Key endpoints (ported later) |
|---|---|---|---|
| ExtremeCloud IQ | `reference/lib/XIQClient.php`, `XIQFleetClient.php` | Bearer token (`fromToken`) | `GET /devices?views=BASIC` (fleet), `GET /devices/{id}`, `GET /devices/{id}/ssid/status`, `GET /clients/active?deviceIds=&views=FULL`, `GET /devices/{id}/alarms` |
| PacketFence | `reference/lib/PFClient.php` | `POST /api/v1/login` → token, raw (no `Bearer`) | `POST /api/v1/nodes/search`, `POST /api/v1/locationlogs/search`, `GET /api/v1/node_categories`, `POST /api/v1/radius_audit_logs/search` |
| rConfig | `reference/lib/RConfigClient.php` | (see reference) | backup freshness / last-change |
| 3CX | `reference/lib/ThreeCXClient.php` | ODBC default (v20 REST TBD) | trunk/extension/call state |
| Milestone | `reference/zabbix/milestone/*` | Config API + Events/State WS | camera state, recording-server health |
| Switch (SNMP/FDB) | `reference/lib/SwitchClient.php` | SNMP | FDB / bridge table (native poller adjacent) |

## Rate limits (from reference client docblocks — validate against production)

- **XIQ:** 7,500 requests/hour **per VIQ (tenant)**, shared across *all*
  integrations (Zabbix, SolarWinds, NetMon). Response headers:
  `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`. `429` →
  back off and skip further calls this cycle. Collector must surface
  `RateLimit-Remaining` into `collector_health`. `listActiveClients` caps
  `limit` at 100. — *source: `XIQClient.php` header comment.*
- **PacketFence:** no documented hard quota; queries are **slow**. Chunk
  `nodes/search` MAC lists into batches of 100 (larger OR clauses 400/truncate).
  Poll in minutes, never in a request path. — *source: `PFClient.php`.*
- **3CX / rConfig / Milestone:** TBD in production reconnaissance.

## Field / gotcha carry-forward (do not re-discover these)

These are baked into the reference clients and must survive the port:

- **XIQ G3:** `mac_address` on `/devices/{id}` is the wireless **base** MAC, not
  eth0. Normalize with colons for display; PF joins use the eth0 MAC.
- **XIQ G4:** `/clients/active` filter param is `deviceIds` (camelCase plural).
  `device_id` silently returns the whole fleet.
- **XIQ G5:** `/clients/active` needs `views=FULL` for rssi/snr/channel/etc.
- **XIQ timestamps:** mixed unix-ms and unix-seconds; normalize with the
  `> 1e10` test.
- **PF 404-on-empty:** `/search` endpoints answer `404` (not `200`+empty) when
  nothing matches — treat as empty, not an error.
- **PF token:** sent raw in `Authorization:` header, **no** `Bearer ` prefix.

## Device registry field mapping (feeds Phase 1 seed)

The `devices` table (spec 01 §schema) is seeded from XIQ fleet + PF node exports.
Field mapping used by `scripts/seed_devices.py`:

**XIQ `/devices?views=BASIC` row → `devices`:**

| XIQ field | `devices` column | Notes |
|---|---|---|
| `id` | `xiq_device_id` | |
| `hostname` | `name` | unique key; see reconciliation rules |
| `ip_address` | `mgmt_ip` | |
| `device_function` | `device_type` | `AP` → `ap`, `SWITCH` → `switch` (see map) |
| `product_type` | (kept in raw only) | model string, not a registry column |

**PF node export row → `devices`:**

| PF field | `devices` column | Notes |
|---|---|---|
| `mac` | `pf_node_mac` | canonical `aa:bb:cc:dd:ee:ff` lowercase |
| `computername` | `name` | fallback to `pf-<mac>` when empty |
| `ip4log.ip` | `mgmt_ip` | |
| `device_class`/`device_type` | `device_type` | mapped to registry vocab |

### Naming / site reconciliation rules (authoritative for the seed)

1. **Canonical `name`** is the XIQ `hostname` when a device exists in XIQ;
   otherwise the PF `computername`; otherwise a synthesized `pf-<mac>` /
   `xiq-<id>`.
2. **Site** is derived from a hostname prefix convention
   (`<SITE>-<role>-<n>`, e.g. `BHS-56-Hallway` → site `BHS`). When the prefix
   is absent, site is `unknown` and the row is flagged for owner review.
3. **`device_type`** is mapped to the registry vocabulary
   (`switch|ap|camera|recording_server|trunk|pbx|other`) via
   `DEVICE_TYPE_MAP`; unknown source types fall back to `other`.
4. **Dedup / merge:** a device present in both XIQ and PF is one row, matched
   first by exact `name`, then by `mgmt_ip`. The XIQ identity wins for `name`
   and `mgmt_ip`; the PF MAC is attached as `pf_node_mac`.
5. `snmp_capable` defaults `true` for `switch`, `false` for `ap`/`camera`
   unless the source export says otherwise (refined in Phase 2).

## DoD checklist

- [x] `docs/spec/00-sources.md` documents API surface + reconciliation rules.
- [x] One sanitized fixture per seed source committed (`tests/fixtures/xiq_devices.json`, `tests/fixtures/pf_nodes.json`).
- [ ] Live API access verified per source (owner, on-network).
- [ ] Production rate limits + real device counts recorded.
- [ ] 3CX v20 REST-vs-ODBC decision recorded.

## Next session

- Owner: capture sanitized real payloads for rConfig / 3CX / Milestone into
  `tests/fixtures/` so those collectors can be fixture-tested in their phases.
- Owner: confirm the hostname→site prefix convention covers all sites, or
  supply an explicit site map file for the seed.
