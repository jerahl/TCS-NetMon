# Runbook — Live-source payload validation

Code: `scripts/validate_payloads.py`. Tests: `tests/test_validate_payloads.py`
(diff logic, fixture `tests/fixtures/payload_drift.json` — synthetic values).
Spec: `docs/spec/11-standalone-scope.md` §7 (the 10.2/10.3/10.4 exit criterion).

Phases 10.2–10.4 were built by **inferring** payload shapes from the ZCD
reference add-on — nothing was ever confirmed against a live tenant. That is the
top cutover risk in spec 11: a parser reading a key the source does not send
does not crash, it quietly writes NULL. The page then shows "—" forever and the
alert never fires. This harness turns that silence into a report.

## How it works (30 seconds)

For every configured source it fetches **one payload per endpoint** and diffs the
live JSON against the contract the code declares — the Pydantic model where one
exists (`netmon/models/xiq.py`), otherwise the exact keys the collector reads,
aliases included.

| Finding | Means | Consequence |
|---|---|---|
| `MISSING` | none of the keys the code reads is in the payload | the column/state can never be populated |
| `NULL` | a required / non-nullable field arrived `null` | Pydantic drops the row, or the parser writes nothing |
| `ALWAYS-NULL` | the key exists but is `null` in every sampled row | same practical outcome as MISSING |
| `RETYPED` | present, but the JSON type differs from the declaration | lookups by string/int silently miss |
| `PARTIAL` | present in only some rows | the field is conditional — check *which* rows |
| `ALIAS-ONLY` | the canonical key is absent, a fallback alias matched | works today, brittle; fix the primary name |
| `EXTRA` | keys the source sends and the code ignores | informational: data we could be using |

`‼` marks a **blocker** (the contract calls the field required — the row cannot
be built). `!` is a warning (a column stays NULL). `·` is informational.

## Running it

```bash
cd /opt/netmon/src
sudo -u netmon .venv/bin/python -m scripts.validate_payloads \
     --config /etc/netmon/netmon.conf --source all
```

```bash
--source xiq|packetfence|milestone|threecx|rconfig|all   # default all
--limit N            # rows sampled per paged endpoint (default 25)
--json               # machine-readable report (same content)
--include-disabled   # also probe sources the effective config disables
--fail-on required   # exit 1 only on blockers, not on every MISSING
```

Config is read the way the collectors read it — file **plus** the `app_settings`
overlay (`docs/runbooks/settings.md`). That matters: on this VM the conf file
says `enabled = false` for collectors that are actually live, and only the
overlay tells the truth. The header line says how many override rows were
applied; if it says `UNAVAILABLE`, the DB was unreachable and a live source can
wrongly read as disabled.

Exit codes — the run is checklist-gateable:

| Code | Meaning |
|---|---|
| `0` | every attempted source validated, no MISSING/NULL findings |
| `1` | at least one MISSING/NULL finding (`--fail-on required` narrows to blockers) |
| `2` | something could not be validated: unreachable, unauthenticated, errored, or an endpoint returned zero rows |

A disabled or credential-less source exits `0` but is printed
`SKIPPED (not validated)` — it is never counted as validated. **The cutover
checklist is satisfied only when every in-scope source prints `VALIDATED` and no
`‼` line remains.**

## Read-only and safe to paste

* Every data fetch is a **GET**. The only POSTs are the sources' own token grants
  (Milestone `/IDP/connect/token`, 3CX `/connect/token`, PF `/api/v1/login`) and
  PacketFence's `/search` query idiom — PF exposes no GET for a filtered node or
  locationlog list. Nothing is created, changed or deleted (§4.1).
* Milestone is touched through the **Config API only** — never the Events/State
  WebSocket.
* The report contains field **names, JSON types and counts** only, never a
  payload value (§4.6). Key names that are really identifiers (MAC, IP, UUID,
  email, hex blob) print as `<dynamic-key>`; error text is scrubbed of URLs,
  credentials, MACs and IPs. `EXTRA` lines carry a shape hint
  (`str(len=19)`, `list[dict](n=3)`, `dict(keys=9)`) — and a credential-named
  field degrades to the bare type, because even a password's length is a hint.
  Nothing is written to disk — the report goes to
  stdout, so redirect it yourself if you want to keep it, and remember that a
  redirected file is yours to review before it goes anywhere near the repo.
* Sampling costs one page per endpoint, so it is safe against the XIQ quota
  (a full `--source all` run is tens of calls, not thousands).

## What it does *not* prove

* **A page is not a random sample.** A field only some device types carry
  (`radios` on APs, for instance) can read MISSING purely because the first page
  held none of them. Re-run with a larger `--limit` before believing a surprise.
* **Shape-only endpoints have no contract.** The PF `snapshot_cache` singletons
  (cluster/services/queues/config/*) are rendered by the UI as generic key/value
  cards, so the harness checks reachability and top-level keys only. An empty
  object there is PF's 404-means-empty sentinel and is reported as `EMPTY`.
* **`EMPTY` is not a pass.** An endpoint that returned nothing was not validated;
  that is what exit `2` is for (§4.5 — a blind check must never read healthy).
* It validates **shape, not semantics**. That `running` is a bool says nothing
  about whether its meaning matches what the collector assumes.

## First live run — 2026-07-28

Findings from the deploy VM, sanitized (field names only). No required field was
missing, so there is no hard blocker; every line below is a column that is
silently NULL or wrong today.

| Source | Endpoint | Finding |
|---|---|---|
| xiq | `/devices?views=FULL` | `radios` absent on the sampled page → `ap_radios` unpopulated (page held no APs — re-confirm with a larger `--limit`); `active_clients` partial |
| xiq | `/clients/active?views=FULL` | `radio_type` is **int**, not str → `_band()` never matches, `wireless_clients.band` always NULL |
| xiq | `/network-policies/{id}/ssids` | `enabled` absent → `build_ssid_rows` defaults every SSID to enabled |
| packetfence | `/nodes/search` | `dhcp_fingerprint` and `ip4log.ip` null on every row → `pf_nodes.dhcp_fp`/`ip` blank |
| milestone | `/recordingServers` | `role`, `cameraCount`, `recordingCameraCount`, `retentionDays` absent; `productVersion`→`version`, `running`→`enabled` |
| milestone | `/cameras` | `hardwareId`, `mac`, `address`, `codec`, `framerate`, `resolution`, `recordingMode`, `recordingServerId`, `stateMessage` all absent; `model`→`shortName`; a `relations` object is offered instead (likely where the hardware/RS links live) |
| milestone | `/storages` | HTTP 400 — the endpoint needs different addressing; the storage roll-up is dead (fail-soft, so nothing errors) |
| milestone | `/hardware` | `mac` absent → the camera MAC (and the FDB ⋈ switch-port join) has no source |
| rconfig | `/api/v2/devices` | canonical `last_backup` absent; `_TS_KEYS` matched `updated_at` — but the payload *also* carries `last_backup_at`/`last_backup_status`, which is what freshness should read. Today's `config_backup` is measured off the row's modification time |
| threecx | — | `SKIPPED` — disabled in the effective config; still unvalidated |

Re-run after each parser fix; the exit code is the signal.

## Troubleshooting

| Symptom | Likely cause | Check |
|---|---|---|
| `SKIPPED — no credentials` on a source you know is live | the setting lives in the overlay and the DB was unreachable | the `overlay` header line; `docs/runbooks/settings.md` |
| every endpoint `NOT ATTEMPTED` | the first call failed at transport/auth, so the harness stopped knocking | the first endpoint's `ERROR` line |
| `UNAUTHENTICATED` | token/credential expired or revoked | rotate in Settings; the collector will be failing in `collector_health` too |
| `THROTTLED` | XIQ 429 — reachable but rate-limited | re-run later; a throttle is not a blind source |
| `EMPTY` on a PF snapshot endpoint | PF answered 404 (path wrong for this PF version) | the matching `snapshot_cache` key will read `ok=0` |
| a MISSING you cannot reproduce | first-page sampling | `--limit 200`, or re-run when the fleet state differs |

## See also

- `docs/runbooks/settings.md` — the file/overlay precedence the harness honours
- `netmon/collectors/README.md` — per-collector endpoints, intervals, failure modes
- `docs/spec/11-standalone-scope.md` §7 — where live-source validation sits before cutover
