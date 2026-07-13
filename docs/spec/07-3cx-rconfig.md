# Spec 07 — Collectors: 3CX & rConfig (Phase 7)

The last two source collectors: voice (3CX) and config-backup freshness
(rConfig). Read-only, on the `base.Collector` contract, same blind/heartbeat
pattern as XIQ/PF/Milestone.

## 3CX (voice)

**Phase 0 decision resolved: REST (v20 xapi), not ODBC.** The reference
`ThreeCXClient.php` already uses the v20 REST API, so no ODBC/`pyodbc`
dependency is needed.

- **Auth:** OAuth2 client-credentials — `POST /connect/token`
  (`client_id` + `client_secret`) → bearer `access_token` (cached to expiry,
  refreshed on 401).
- **Endpoints:** `GET /xapi/v1/Trunks` (OData `{value:[...]}`) for trunk
  registration; `GET /xapi/v1/SystemStatus` for PBX/service health.
- **Writes:** `device_state` dimension `trunk` for devices matched by
  `threecx_ref` — `up` (registered, ok) / `down` (not registered, crit). Blind
  on unreachable. (Feeds the seeded `trunk_unregistered` rule.)

## rConfig (config-backup freshness)

Enrichment: how fresh is each device's last saved config.

- **Auth:** `apitoken: <token>` header (not Bearer); **HTTPS only**.
- **Endpoint:** `GET /api/v2/devices?per_page=100&page=N` (paged) — rows carry
  a last-backup timestamp (field name validated at deploy; several aliases
  accepted).
- **Writes:** `device_state` dimension `config_backup` for devices matched by
  `rconfig_device_id` — `fresh` (ok) when the last backup is within
  `stale_after_s` (default 7d), `stale` (warn) when older, `unknown` when the
  timestamp can't be read (never `fresh`-when-unsure — §4.5). Blind on
  unreachable. (Feeds the seeded `config_backup_stale` rule.)

## Config

`[threecx]`: `enabled, url, client_id, client_secret, verify_ssl, interval_s`.
`[rconfig]`: `enabled, url, api_token, verify_ssl, interval_s, stale_after_s`.
Both registered as supervised tasks when enabled (misconfig logged, skipped);
both standalone (`python -m netmon.collectors.threecx|rconfig`).

## UI

Voice page (`#/voip`) — trunk state (and PBX source_status) from `/api/status`
filtered to `trunk` / `pbx`.

## Definition of Done

- [ ] 3CX trunk state + rConfig config_backup freshness live in `device_state`
      (fixtures here; real systems at deploy).
- [ ] Both blind loudly on unreachable; no stale-as-fresh.
- [ ] Voice status surfaced in the UI.
- [ ] Both collector READMEs; fixture/parse + collector tests green.

## Next

Phase 8 — parallel run & cutover (owner-gated): ≥4 weeks shadow comparison,
then the owner flips `[engine] shadow=false` and disables the Zabbix
network/wireless/voice/camera hosts. Claude Code does not perform the cutover.
