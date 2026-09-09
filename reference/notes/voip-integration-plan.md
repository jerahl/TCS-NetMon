# VoIP / 3CX page — wiring plan

Status today: `views/voip.view.php` + `assets/voip-app.jsx` render the
page entirely from inline mock data (`window.VOIP_PBX`,
`VOIP_SERVICES`, `VOIP_TRUNKS`, `VOIP_CALLS`, `VOIP_TOP`, `VOIP_QUEUES`,
`VOIP_QUALITY`, `VOIP_SITES`, `VOIP_PROBLEMS`). `ActionVoip.php` is a
title-only shell — no `boot` payload, no data action, no client lib.

Goal: take the page off mock data using the same SSR-boot → bridge →
30 s poll pattern FortiGate uses, with Zabbix as the primary source
and the 3CX XAPI filling the gaps Zabbix can't reach.

---

## 1. Data-source split

The community **"3CX Phone System by HTTP"** Zabbix template
(github.com/v-zhuravlev/zbx-3cx, mirrored in Zabbix's official
integrations list since v6.4) polls 3CX's `/xapi/v1/SystemStatus`
endpoint and exposes the gauges below. Anything beyond that has to
come from a direct 3CX call.

| Dashboard field | Zabbix item key (template) | 3CX XAPI fallback |
|---|---|---|
| `VOIP_PBX.fqdn` / `version` | host inventory + `system.descr` (or `3cx.system.version`) | `GET /xapi/v1/SystemStatus` → `Version`, `FQDN` |
| `VOIP_PBX.uptime` | `system.uptime` from the host OS template | `SystemStatus.Uptime` (seconds since service start) |
| `VOIP_PBX.activeNow` | `3cx.calls.active` | `SystemStatus.CallsActive` (and `/ActiveCalls` count) |
| `VOIP_PBX.capacity` (SC limit) | `3cx.system.maxsim` | `SystemStatus.MaxSimCalls` |
| `VOIP_PBX.callsToday` / inbound/outbound | `3cx.calls.today.*` (3 items) | `/xapi/v1/ReportCallLogData` (date-bucketed) |
| `VOIP_PBX.registeredExt` / `totalExt` | `3cx.extensions.registered` / `.total` | `SystemStatus.ExtensionsRegistered` / `.Total` |
| `VOIP_PBX.avgMos`, ASR, ACD | **not in template** | `SystemStatus.CallQuality` block + `/CallHistoryView` aggregate |
| `VOIP_PBX.history.concur` (96-bucket 24h) | `history.get` on `3cx.calls.active` (15-min trend) | n/a — use Zabbix history |
| `VOIP_SERVICES[]` | `3cx.service.<name>.status` per service | `/xapi/v1/SystemStatus.ServicesStatus[]` |
| `VOIP_TRUNKS[]` (per-trunk channels / ASR / errors) | template only counts `3cx.trunks.registered` total — **no per-trunk** | `/xapi/v1/Trunks` + `/xapi/v1/Trunks({Id})/Stats` |
| `VOIP_CALLS[]` (live active-call list) | **not in template** | `/xapi/v1/ActiveCalls` (poll every 2–5 s) |
| `VOIP_TOP[]` (top-extension talkers today) | **not in template** | `/xapi/v1/ReportExtensionStatistics?period=today` |
| `VOIP_QUEUES[]` (SLA / abandon / waiting) | partial via `3cx.queues.<ext>.waiting` if LLD-discovered | `/xapi/v1/Queues` + `/xapi/v1/Queues({Id})/Performance` |
| `VOIP_QUALITY` (MOS/jitter/loss/RTT 24h) | **not in template** | `/xapi/v1/ReportCallQuality` (or compute from CDR `MOS` field) |
| `VOIP_SITES[].ext[]` (per-extension registration grid) | only the aggregate count is in template | `/xapi/v1/Users` (paged; ~200 rows) — fold `Number`, `RegistrarContact`, `CurrentProfile`, `Forwarding` |
| `VOIP_PROBLEMS[]` | `problem.get` on the 3CX host group | n/a |

**Summary:** Zabbix can drive the KPI strip, the services panel, the
concurrent-calls history chart, and the problems list. Everything
table-shaped (trunks, active calls, queues, top extensions, the
per-site extension grid, call-quality history) needs the 3CX XAPI.

---

## 2. 3CX XAPI surface we need

3CX v20 exposes the **Configuration / Management API** (a.k.a. XAPI)
at `https://<pbx-fqdn>/xapi/v1/…`. Auth is OAuth2 client credentials
against `/connect/token` — the dashboard creates a dedicated client
("Integrations" tab in the 3CX admin) and stores the client id/secret
in Zabbix global macros. Endpoint paths below are confirmed against
the v20 OpenAPI spec shipped in
[3cx/xapi-tutorial](https://github.com/3cx/xapi-tutorial).

Endpoints the bridge calls (all GET, all OData-shaped):

| Endpoint | What we read | Cadence |
|---|---|---|
| `POST /connect/token` (form `grant_type=client_credentials`) | bearer token — cache in APCu | on demand + refresh on 401 |
| `GET /xapi/v1/SystemStatus` | FQDN, Version, MaxSimCalls, CallsActive, ExtensionsRegistered/Total, TrunksRegistered/Total, ProductCode, CurrentLocalIp | every poll |
| `GET /xapi/v1/Trunks` | rows shaped `{Number, AuthID, IsOnline, SimultaneousCalls, DidNumbers[], Gateway:{Name,Host,Port,Type,TemplateFilename}, TrunkRegTimes:[...]}` | every poll |
| `GET /xapi/v1/ActiveCalls` | minimal `{Id, Caller, Callee, Status, EstablishedAt, ServerNow, LastChangeStatus}` — no codec/MOS/trunk per row in v20 | 5 s (separate sub-fetch) |
| `GET /xapi/v1/Users` (paged 100 rows at a time, `$top` capped at 100) | `{Number, DisplayName, FirstName, LastName, IsRegistered (bool), Enabled, CurrentProfileName, Groups[]}` | every poll |
| `GET /xapi/v1/Groups` | friendly names for the group ids in `User.Groups[]` | every poll |
| `GET /xapi/v1/Queues` | rows shaped `{Id, Number, Name, SLATime, Agents[], MaxCallersInQueue}` | every poll |
| `GET /xapi/v1/ReportExtensionStatistics/Pbx.GetExtensionStatisticsData(periodFrom='…',periodTo='…',extensionFilter=null,callArea=0)?$top=10` | top-talker table (PbxExtensionStatistics rows) | every poll |

Not exposed by the v20 XAPI as a simple read — the dashboard ships
zeros for these slots until follow-up wiring lands:

- **Per-trunk channel utilization** (`chIn`/`chOut`/`asr`/`mos`):
  not on `PbxTrunk`. Would need to aggregate `/ActiveCalls` by trunk
  ID + pull `ReportCallLogData` for ASR/MOS averages.
- **Per-queue live SLA / waiting / abandoned**: not on `PbxQueue`.
  Would need `ReportDetailedQueueStatistics/Pbx.GetDetailedQueueStatisticsData(queueDnStr,startDt,endDt,waitInterval)`
  per queue — too expensive for a 30s rollup; needs its own slower
  pipeline.
- **Per-call MOS / codec** in the active-calls list: 3CX v20 only
  surfaces these on closed CDR rows via
  `ReportCallLogData/Pbx.GetCallQualityReport(cdrId=…)` after the
  call ends.
- **24h call-quality history**: no pre-bucketed endpoint. Would have
  to walk the day's CDR and aggregate — defer to a slower pipeline.
- **Services panel**: `SystemStatus` doesn't carry a services array
  in v20 (services are managed by the host OS, not the PBX).

Live active-calls is split into its own `tcs.voip.calls.data` action
the bridge hits every 5 s; the heavy rollup stays at 30 s.

---

## 3. New files / changes

```
tcs_dashboard/
├── manifest.json                          (+3 actions)
├── Module.php                             (no change — menu entry exists)
├── actions/
│   ├── ActionVoip.php                     (rewrite: emit SSR boot)
│   ├── ActionVoipData.php                 (new: 30 s rollup)
│   └── ActionVoipCallsData.php            (new: 5 s active-calls poll)
├── lib/
│   └── ThreeCXClient.php                  (new: OAuth2 + XAPI wrapper)
├── assets/
│   ├── voip-bridge.jsx                    (new: SSR unpack + poll)
│   └── voip-app.jsx                       (edit: guard mock globals,
│                                           add loading/error states)
├── views/
│   └── voip.view.php                      (edit: window.VOIP_BOOT,
│                                           include bridge)
└── notes/
    └── voip-integration-plan.md           (this file)
```

### 3.1 `lib/ThreeCXClient.php`
Mirrors `PFClient.php` (constructor + `fromMacros`, APCu-cached
bearer, 401-refresh-retry, TLS verify flag, per-call timeout). Public
methods:
- `systemStatus(): array`
- `trunks(): array`
- `activeCalls(): array`
- `users(int $top = 500): array`
- `queues(): array`
- `queuePerformance(string $queueId): array`
- `topExtensions(int $top = 10): array`
- `callQuality(string $bucket = '30m'): array`

### 3.2 Action wiring
- `ActionVoip` builds `$boot = ActionVoipData::emptyPayload() + ['async' => true]`, embeds via `$data['boot']`.
- `ActionVoipData`:
  - Resolves 3CX host via `{$TCS.VOIP.HOST}` macro or first host using the "3CX Phone System by HTTP" template.
  - Pulls Zabbix items (`ActionFortigateData::collectItems` pattern).
  - Calls `ThreeCXClient` for the gap endpoints. Each call is wrapped in try/catch — a 3CX failure degrades to the Zabbix-only subset, not a blank page.
  - APCu-caches the merged payload for 30 s.
- `ActionVoipCallsData`: just `$client->activeCalls()` mapped to the `VOIP_CALLS` shape, 5 s APCu TTL.

### 3.3 Bridge — `voip-bridge.jsx`
Pattern from `fortigate-bridge.jsx`:
- KEYS table maps payload field → window global:
  `pbx → VOIP_PBX`, `services → VOIP_SERVICES`, `trunks → VOIP_TRUNKS`,
  `calls → VOIP_CALLS`, `top → VOIP_TOP`, `queues → VOIP_QUEUES`,
  `quality → VOIP_QUALITY`, `sites → VOIP_SITES`, `problems → VOIP_PROBLEMS`.
- Apply SSR boot from `window.VOIP_BOOT` synchronously.
- Fetch `tcs.voip.data` every 30 s.
- Fetch `tcs.voip.calls.data` every 5 s (active-call panel only).
- `isEmpty()` guard: on empty/error payloads, keep prior data so the
  page never flashes blank.
- Dispatch `tcs:voip-data` so React rerenders.

### 3.4 `voip-app.jsx` changes
Today the file populates `window.VOIP_*` unconditionally at module
scope. Convert each assignment to a `window.VOIP_X = window.VOIP_X || {…mock}`
guard so the bridge's SSR-applied values win. Add a top-of-body
`<DemoBanner mock={isMockData}>` toggle driven by `window.VOIP_SOURCES`.
No other component changes — they already read `window.VOIP_*`.

### 3.5 View
Add to `views/voip.view.php` (between the existing `<style>` and
`<div id="root">`):
```php
<script>
  window.VOIP_BOOT = <?= json_encode($data['boot'] ?? new stdClass(), JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE) ?>;
  window.TCS_VOIP_DATA_URL       = "zabbix.php?action=tcs.voip.data";
  window.TCS_VOIP_CALLS_DATA_URL = "zabbix.php?action=tcs.voip.calls.data";
  /* disable Zabbix whole-page refresh — same dance as fortigate.view.php */
</script>
```
And register `voip-bridge.jsx` between `global-nav` and `voip-app`.

---

## 3.6 3CX API client permissions

Creating the OAuth2 client in **3CX Admin Console → Integrations → API**
is only half the job. The client must be granted **role-based access**
to the XAPI resources the dashboard reads — otherwise the
`/connect/token` call succeeds (so the URL/secret are clearly right)
but every collection endpoint returns **HTTP 403 Forbidden**.

Provisioning checklist:

1. *Admin Console → Integrations → API → Add*.
2. **Client Name**: `tcs-dashboard` (or similar; matches `{$TCS.3CX.CLIENT_ID}`).
3. **Department**: pick a department that has **visibility into all
   extensions** the dashboard needs to render — typically the root
   "DEFAULT" department, or one with the "Can see members of all groups"
   flag set. A department restricted to a single group will 403 on
   `/xapi/v1/Users` for everyone outside it.
4. **Role**: assign **"System Owner"** (full read) or a custom role
   that grants read on each of: `SystemStatus`, `Trunks`, `Users`,
   `Groups`, `Queues`, `ActiveCalls`. Operator/Receptionist roles do
   **not** grant XAPI access.
5. Save, then copy the **Client ID** + **Client Secret** into the
   Zabbix global macros (`{$TCS.3CX.CLIENT_ID}` / `{$TCS.3CX.CLIENT_SECRET}`).
6. If 3CX is on a self-signed cert, set `{$TCS.3CX.VERIFY.SSL}=0`.

If `tcs.voip.data` returns `sources.3cx="error"` with `HTTP 403` in
`xapi_errors`, this checklist is the fix — it's a 3CX-side permission
issue, not a dashboard bug.

---

## 4. Required macros (global)

Created in **Administration → General → Macros** or on the 3CX host:

| Macro | Example | Notes |
|---|---|---|
| `{$TCS.VOIP.HOST}` | `pbx.tcs.local` | authoritative when set — matches host technical name, visible name, or numeric hostid. Template not required. If unset, falls back to first host using the "3CX Phone System by HTTP" template. |
| `{$TCS.3CX.URL}` | `https://pbx.tcs.local:5001` | XAPI base URL |
| `{$TCS.3CX.CLIENT_ID}` | `tcs-dashboard` | OAuth2 client id from 3CX → Integrations |
| `{$TCS.3CX.CLIENT_SECRET}` | (secret) | mark **Secret text** in Zabbix |
| `{$TCS.3CX.VERIFY.SSL}` | `1` | `0` for self-signed labs |

If the macros are missing, the data action falls back to
Zabbix-only mode and surfaces a soft warning banner via the
`payload.warning` slot the bridge already supports.

---

## 5. Sequenced implementation

1. **Scaffolding (this PR).** Plan doc, `ActionVoip` boot, manifest
   entries for `tcs.voip.data` + `tcs.voip.calls.data`, empty
   `ActionVoipData::emptyPayload()`, view-side `window.VOIP_BOOT` +
   bridge include, bridge `apply()` skeleton with KEYS map. Page
   stays mock-driven because `voip-app.jsx` mock assignments still
   run after the (empty) bridge apply.

2. **Zabbix-only data.** Implement `ActionVoipData::buildPayload()`
   for the KPI strip, services, problems, and the concurrent-calls
   24h history from `history.get` on `3cx.calls.active`. Guard the
   mock assignments in `voip-app.jsx`. This alone lights up ~40% of
   the page.

3. **`ThreeCXClient` + Trunks + Users + Queues.** OAuth2 token cache,
   `systemStatus()`, `trunks()`, `users()`, `queues()`,
   `queuePerformance()`. Map into `VOIP_TRUNKS`, `VOIP_QUEUES`,
   `VOIP_SITES`. Top extensions via `topExtensions()` into `VOIP_TOP`.

4. **Active calls (separate 5 s endpoint).** Add
   `ActionVoipCallsData` + the bridge sub-poll. Mark active calls
   refresh interval visibly in the card header.

5. **Call quality history.** `callQuality()` → `VOIP_QUALITY`.
   Cache 5 min since 3CX serves this from CDR — no point polling it
   every 30 s.

6. **Polish.** Remove the mock data block from `voip-app.jsx` once
   live data has been observed in the pilot env for a week. Add a
   dashboard tweak ("show data-source badges") wiring to
   `window.VOIP_SOURCES` so operators see when 3CX is degraded vs.
   Zabbix-only mode.

**Estimate:** 1 day for step 1, 1 day for 2, 2 days for 3, 0.5 day
each for 4–6. **~4–5 working days total** once 3CX OAuth2 client and
template are in place.

---

## 6. Open decisions

1. **Template choice.** Confirm we're standardising on the
   community zbx-3cx HTTP template vs. writing our own that hits
   XAPI directly (a JS-Script template, like the Milestone one).
   Recommend community template — already maintained, exposes the
   right item keys, supports v18/v20.
2. **Active-calls cadence.** 5 s is aggressive — every poll is one
   3CX XAPI call. For larger PBXs this is fine (XAPI tolerates it),
   but if rate-limited we drop to 10 s. Currently the mock card
   header advertises "2s refresh" — change to "5s".
3. **MOS source.** 3CX exposes MOS per-call (RTCP-XR) but not
   cluster-wide rollup; either compute it bridge-side from the
   active-calls list or use `/Defs/CallQualityStatistics`.
   Recommend the latter — server does the work.
4. **Per-extension grid.** 200+ extensions, paged. Cache the user
   list 60 s separately from the rest of the rollup so we don't
   slam `/Users` on every 30 s tick.
