# Lift Manifest — three companion widget repos

**M0 task #1 output.** Walks every file in `jerahl/MilestoneZabbix`,
`jerahl/ZabbixSwitchPortWidgets`, and `jerahl/ZabbixExtremeIQ` (snapshot of
their `main` branches as of 2026-05-10), classifies each as **lift** (data
layer that moves into `tcs_dashboard/{templates,externalscripts,lib}/`) or
**discard** (widget-rendering shell that stays in the source repo).

This document supersedes the §A1–A7 draft in `Project_Plan_v1_0.html` —
that draft was written from repo READMEs alone; this one is from a full
file walk plus spot-reads of every PHP class. Differences between the
draft and this document are flagged at the bottom under
**[Corrections to Project_Plan_v1_0.html §A](#corrections)**.

---

## Top-level summary

| Repo | Files total | Files to lift | Files to discard | Notes |
|---|---|---|---|---|
| `jerahl/MilestoneZabbix` | 35 | 12 (1 yaml + 8 ext scripts + 1 PHP client + 2 docs) | 13 widget shell + 8 design-bundle | `pf_device/` is byte-identical to copy in `ZabbixSwitchPortWidgets/pf_device/` |
| `jerahl/ZabbixSwitchPortWidgets` | 53 | 1 (yaml — duplicate of EXOS in ZabbixExtremeIQ; lift this one) + write-action scaffolding for rConfig | 27 widget shell + 24 design-bundle + 1 IDE | rConfig PoE cycle is a write-action surface we hadn't accounted for in v1.0 plan |
| `jerahl/ZabbixExtremeIQ` | 33 | 4 (2 yaml + 2 PHP clients) + write-action scaffolding for XIQ ops | 14 widget shell + 12 design-bundle | `apdetail/` PHP clients are the canonical XIQ + PF clients (evolved from `pf_device/`) |

**Net lift target into `tcs_dashboard/`** (after dedup):

```
tcs_dashboard/
├── templates/
│   ├── milestone_by_http_api.yaml          ← MilestoneZabbix/templates/Milestone by HTTP API.yaml
│   ├── extreme_exos_by_snmp_with_poe.yaml  ← ZabbixSwitchPortWidgets/templates/Extreme EXOS by SNMP w POE.yaml
│   └── extreme_xiq_aps_by_api.yaml         ← ZabbixExtremeIQ/templates/Extreme_XIQ_APs.yaml
├── externalscripts/
│   ├── milestone_cameras_read.sh
│   ├── milestone_cameras_refresh.sh
│   ├── milestone_cameras_state.py
│   ├── milestone_ess_read.sh
│   ├── milestone_ess_refresh.sh
│   ├── milestone_ess_state.py
│   ├── milestone_ess_lookup.py             ← was missing from v1.0 plan
│   └── milestone_ess_resolve.py            ← was missing from v1.0 plan
└── lib/
    ├── MilestoneClient.php                 ← built fresh in M1, no source-repo PHP class to lift
    ├── XIQClient.php                       ← lift verbatim from ZabbixExtremeIQ/apdetail/includes/XIQClient.php (2518 lines)
    ├── PFClient.php                        ← lift verbatim from ZabbixExtremeIQ/apdetail/includes/PFClient.php (984 lines)
    ├── SwitchClient.php                    ← built fresh in M1, lifting MAC-learning logic from ZabbixSwitchPortWidgets/switchports/actions/WidgetView.php
    └── RConfigClient.php                   ← built fresh in M1 if we keep PoE-cycle, lifting from ZabbixSwitchPortWidgets/portdetail/actions/CyclePoe.php
```

**Total file count** going into `tcs_dashboard/`: 3 templates + 8 external scripts + 5 PHP clients = **16 files** to lift. Plus three small docs (per-repo INSTALL/README excerpts) for the install workflow. No code lifted via `git mv` — the source repos remain whole; we copy files and adapt namespaces per **[AP G16 carry-forward](#namespacing)**.

---

## §A.1 — `jerahl/MilestoneZabbix`

### Folder map

```
MilestoneZabbix/
├── README.md
├── LICENSE                                                                    [keep in source — repo-level]
├── milestone_camera_status/                       (Zabbix widget — full discard, retains data-layer references)
│   ├── manifest.json                                                          ─ DISCARD (widget manifest)
│   ├── README.md                                                              ─ keep in source
│   ├── Milestone_Dashboard_Project_Plan_v1.html                               ─ design-bundle artifact; keep in source
│   ├── Milestone_Dashboard_Project_Plan_v1_1.html                             ─ design-bundle artifact; keep in source (this is the plan our v1.0 plan companions)
│   ├── Zabbix Extreme.zip                                                     ─ design-bundle archive; keep in source
│   ├── actions/WidgetView.php                                                 ─ DISCARD (widget output controller)
│   ├── includes/WidgetForm.php                                                ─ DISCARD (widget config form)
│   ├── views/widget.view.php                                                  ─ DISCARD (widget render)
│   ├── views/widget.edit.php                                                  ─ DISCARD (widget edit)
│   ├── assets/css/widget.css                                                  ─ DISCARD (widget chrome)
│   ├── assets/css/widget.css.additions                                        ─ DISCARD
│   └── assets/js/class.widget.js                                              ─ DISCARD (widget JS lifecycle)
├── pf_device/                                     (Zabbix widget — full discard except PfClient.php for reference)
│   ├── manifest.json                                                          ─ DISCARD (widget manifest)
│   ├── README.md                                                              ─ keep in source
│   ├── actions/WidgetAction.php                                               ─ DISCARD
│   ├── actions/WidgetView.php                                                 ─ DISCARD
│   ├── includes/PfClient.php                                                  ─ NOT lifted (superseded — see note 1 below)
│   ├── includes/WidgetForm.php                                                ─ DISCARD
│   ├── views/widget.edit.php                                                  ─ DISCARD
│   ├── views/widget.view.php                                                  ─ DISCARD
│   ├── assets/css/widget.css                                                  ─ DISCARD
│   └── assets/js/class.widget.js                                              ─ DISCARD
└── templates/
    ├── README.md                                                              ─ keep in source; excerpts go into our INSTALL.md
    ├── Milestone by HTTP API.yaml                                             ✓ LIFT → tcs_dashboard/templates/milestone_by_http_api.yaml
    ├── milestone_cameras_read.sh                                              ✓ LIFT → tcs_dashboard/externalscripts/
    ├── milestone_cameras_refresh.sh                                           ✓ LIFT → tcs_dashboard/externalscripts/
    ├── milestone_cameras_state.py                                             ✓ LIFT → tcs_dashboard/externalscripts/
    ├── milestone_ess_read.sh                                                  ✓ LIFT → tcs_dashboard/externalscripts/
    ├── milestone_ess_refresh.sh                                               ✓ LIFT → tcs_dashboard/externalscripts/
    ├── milestone_ess_state.py                                                 ✓ LIFT → tcs_dashboard/externalscripts/
    ├── milestone_ess_lookup.py                                                ✓ LIFT → tcs_dashboard/externalscripts/  [missed in v1.0 plan]
    └── milestone_ess_resolve.py                                               ✓ LIFT → tcs_dashboard/externalscripts/  [missed in v1.0 plan]
```

### Notes

**Note 1 — PfClient.php in `pf_device/` is superseded.** The `pf_device/`
widget exists in this repo *and* in `ZabbixSwitchPortWidgets/pf_device/`,
**byte-identical** (`diff -q` exit code 0). The PHP class is a 328-line
static-helper bag (`PfClient::login`, `PfClient::request`, etc.). The
`apdetail/` widget in `jerahl/ZabbixExtremeIQ` ships a 984-line *evolved*
version (now `PFClient.php` with capital F, instance methods, internal
401-retry, `getActiveClientsForAp` orchestration, `locationlogSearch`,
`radiusAuditLog` — see §A.3 below). We lift the apdetail version. The
`pf_device/` static helpers are not lifted; the apdetail version
supersedes them entirely.

**Note 2 — eight external scripts, not six.** The `templates/` folder
contains **eight** Python/shell helpers, not the six the v1.0 plan
referenced. Two ESS helpers (`milestone_ess_lookup.py`,
`milestone_ess_resolve.py`) are additional to the read/refresh/state
triplet. They appear to be ESS-state group lookup utilities (referenced
by the macros `{$MILESTONE.ESS.STATEGROUP.*}` + `{$MILESTONE.ESS.TYPE.*}`).
Lift all eight; M1's INSTALL.md must reference all eight in the deploy
checklist. v1.0 plan (`Project_Plan_v1_0.html` §A1, M1 second task)
needs correction.

**Note 3 — Milestone macros (full list, confirmed from template YAML and
templates/README.md).** Eleven macros, not the four the user mentioned
when authorising auth-normalisation:

| Macro | Default | Required | Notes |
|---|---|---|---|
| `{$MILESTONE.HOST}` | — | yes | API Gateway FQDN/IP |
| `{$MILESTONE.SCHEME}` | `https` | no | `http` or `https` |
| `{$MILESTONE.USER}` | — | yes | XProtect Basic user |
| `{$MILESTONE.PASSWORD}` | — | yes (secret) | matches per-host secret macro |
| `{$MILESTONE.CLIENT_ID}` | `GrantValidatorClient` | no | OAuth2 client id |
| `{$MILESTONE.ESS.DELAY}` | `1d` | no | ESS poll interval |
| `{$MILESTONE.ESS.STATEGROUP.COMMUNICATION}` | — | yes | GUID — comm state group |
| `{$MILESTONE.ESS.STATEGROUP.RECORDING}` | — | yes | GUID — recording state group |
| `{$MILESTONE.ESS.TYPE.COMMUNICATION_OK}` | — | yes | GUID — "OK" state type |
| `{$MILESTONE.ESS.TYPE.RECORDING_STARTED}` | — | yes | GUID — "Recording Started" state type |
| `{$MILESTONE.CAM.NAME.MATCHES}` | `.*` | no | LLD include regex |
| `{$MILESTONE.CAM.NAME.NOT_MATCHES}` | `CHANGE_IF_NEEDED` | no | LLD exclude regex |
| `{$MILESTONE.CAM.PING.INTERVAL}` | `1m` | no | ICMP poll interval |

The four state-group GUIDs are XProtect-instance-specific — operator
runs a one-time XProtect API call at install time to obtain them. The
template's `templates/README.md` documents the procedure. M1's INSTALL.md
needs to reproduce this procedure or link to the source repo's doc.

---

## §A.2 — `jerahl/ZabbixSwitchPortWidgets`

### Folder map

```
ZabbixSwitchPortWidgets/
├── README.md
├── .gitignore + .idea/                                                        [keep in source — IDE config]
├── Zabbix Extreme/                                (design bundle — JSX mockups + project plan HTMLs)
│   ├── *.html *.jsx *.css *.py *.yaml                                         ─ DISCARD (design artifacts; tcs_dashboard already has the rendered UI)
│   └── (24 files)
├── pf_device/                                     (BYTE-IDENTICAL to MilestoneZabbix/pf_device/ — see §A.1 note 1)
│   └── (10 files)                                                             ─ DISCARD entirely; canonical PFClient lives in apdetail
├── switchports/                                   (Switch Port Status widget)
│   ├── manifest.json                                                          ─ DISCARD (widget manifest)
│   ├── README.md                                                              ─ keep in source; reference for item-key conventions
│   ├── Widget.php                                                             ─ DISCARD (1-line CWidget stub)
│   ├── actions/AutoConfig.php                                                 ─ DISCARD (widget edit-time helper)
│   ├── actions/WidgetView.php                                                 ◇ REFERENCE (lift its MAC-learning + stack-detection logic into lib/SwitchClient.php — see note 4)
│   ├── includes/WidgetForm.php                                                ─ DISCARD
│   ├── views/widget.edit.php                                                  ─ DISCARD
│   ├── views/widget.edit.js.php                                               ─ DISCARD
│   ├── views/widget.view.php                                                  ─ DISCARD
│   ├── assets/css/widget.css                                                  ─ DISCARD
│   └── assets/js/class.widget.js                                              ─ DISCARD
├── portdetail/                                    (Switch Port Detail widget — has the rConfig PoE-cycle write-action)
│   ├── manifest.json                                                          ─ DISCARD
│   ├── README.md                                                              ─ keep in source; rConfig setup is well-documented here
│   ├── Widget.php                                                             ─ DISCARD
│   ├── actions/CyclePoe.php                                                   ◇ REFERENCE (lift its rConfig HTTP + macro-reading core into lib/RConfigClient.php — see note 5)
│   ├── actions/WidgetView.php                                                 ◇ REFERENCE (per-port stat aggregation logic — port-state, PoE state, error counters)
│   ├── includes/WidgetForm.php                                                ─ DISCARD
│   ├── views/widget.edit.php + widget.view.php                                ─ DISCARD
│   ├── assets/css/widget.css                                                  ─ DISCARD
│   └── assets/js/class.widget.js                                              ─ DISCARD
└── templates/
    └── Extreme EXOS by SNMP w POE.yaml                                        ✓ LIFT → tcs_dashboard/templates/extreme_exos_by_snmp_with_poe.yaml
```

### Notes

**Note 4 — `switchports/actions/WidgetView.php` ≠ a Zabbix module's
ActionView.** This file is a `CControllerDashboardWidgetView` subclass —
widget-framework only. We can't lift it to `Modules\TcsDashboard\Actions`.
But it contains the operationally-interesting code:

- Stack-member detection via `system.hw.stacking` + `stacking.member[1..8]`
  item keys
- PoE status item keys: `snmp.interfaces.poe.dstatus[<member>.<port>]`
  (zero-padded indexing — `idx/1000` for member, `idx%100` for port)
- PoE status valuemap (1=Disabled, 2=Searching, 3=Delivering Power,
  4=Fault, 6=Other Fault, 7=Test, 8=Deny, 0=ERROR)
- Port-name → snmp-index mapping via `net.if.status[ifOperStatus.<idx>]`
  scan
- Override-host resolution (`fields_values['override_hostid']` is an
  array — take first)

The lift target for M1 is `tcs_dashboard/lib/SwitchClient.php` (new) which
re-implements these patterns as instance methods, callable from
`ActionSwitchesData`. ~200 lines of code, all SNMP item-key conventions,
no protocol logic.

**Note 5 — rConfig PoE-cycle write-action was missed in v1.0 plan.** The
`portdetail/actions/CyclePoe.php` is a write-action: receives a
hostid/snmp_index/iface_name from the browser, calls rConfig's REST API
(`POST /api/v2/snippets/<id>/deploy`), power-cycles the port, returns
JSON `{ok, message, http_status}`. Auth via macros:

| Macro | Type | Required | Notes |
|---|---|---|---|
| `{$RCONFIG.URL}` | text | yes | Base URL — must be HTTPS (action enforces) |
| `{$RCONFIG.TOKEN}` | secret text | yes | rConfig API token |
| `{$RCONFIG.POE_SNIPPET_ID}` | text | yes | Numeric snippet id in rConfig |
| `{$RCONFIG.DEVICE_ID}` | text | no | Pin to specific rConfig device id; otherwise auto-resolved by IP/hostname |

Permissions: requires `USER_TYPE_ZABBIX_ADMIN`. Read-only operators get a
permission error.

**Decision deferred to M3:** is rConfig PoE-cycle in scope for v1.0? Adds
`tcs.switch.cyclepoe.action` controller + `lib/RConfigClient.php`. ~1 day
of work. The dashboard's port-detail card already has the visual button
("CYCLE PoE") in the design — operator clicks it expecting power to
cycle. Recommend including in v1.0; document if deferred. Will revisit
in M3 task list.

**Note 6 — EXOS template is byte-identical to the copy in
`ZabbixExtremeIQ/templates/`.** `diff -q` exit code 0. Lift one canonical
copy. Pick `ZabbixSwitchPortWidgets/templates/` as canonical (subject
matter alignment — this is the switches repo).

**Note 7 — `Zabbix Extreme/` subdirectory is design-bundle artifact.**
This folder contains 24 files: HTML project plans (AP plans v2 / v3.1 /
v3.2, M0 closeouts, PacketFence API findings, XIQ API references, the
Zabbix Dashboard mockup HTML, plus the JSX/CSS files that produced our
dashboards). Same source material the `tcs_dashboard` design bundle came
from. Discard for the lift; the rendered UI is already in `tcs_dashboard`.

---

## §A.3 — `jerahl/ZabbixExtremeIQ`

### Folder map

```
ZabbixExtremeIQ/
├── README.md
├── LICENSE                                                                    [keep in source]
├── Zabbix Extreme/                                (design bundle — same artifacts as ZabbixSwitchPortWidgets/Zabbix Extreme/)
│   └── (12 files)                                                             ─ DISCARD
├── apdetail/                                      (AP Detail widget — has the canonical PFClient.php + XIQClient.php)
│   ├── manifest.json                                                          ─ DISCARD (widget manifest)
│   ├── Widget.php                                                             ─ DISCARD (1-line CWidget stub)
│   ├── actions/WidgetView.php                                                 ◇ REFERENCE (server-side SVG sparkline rendering, Device Health gather pattern, History.get pagination)
│   ├── includes/PFClient.php                                                  ✓ LIFT → tcs_dashboard/lib/PFClient.php (984 lines, evolved from pf_device static helpers)
│   ├── includes/XIQClient.php                                                 ✓ LIFT → tcs_dashboard/lib/XIQClient.php (2518 lines, the canonical XIQ client)
│   ├── includes/WidgetForm.php                                                ─ DISCARD
│   ├── views/widget.edit.php + widget.view.php                                ─ DISCARD
│   ├── assets/css/widget.css                                                  ─ DISCARD
│   └── assets/js/class.widget.js                                              ─ DISCARD
├── xiq_ap_status/                                 (XIQ AP write-actions widget — reboot/manage/CLI)
│   ├── manifest.json                                                          ─ DISCARD
│   ├── README.md                                                              ─ keep in source; documents the action-token security model
│   ├── Widget.php                                                             ─ DISCARD
│   ├── actions/WidgetAction.php                                               ◇ REFERENCE (XIQ write-actions: reboot, manage, unmanage, refresh, CLI — see note 8)
│   ├── actions/WidgetView.php                                                 ◇ REFERENCE (per-AP item resolution from XIQ template)
│   ├── includes/WidgetForm.php                                                ─ DISCARD
│   ├── views/widget.edit.php + widget.view.php                                ─ DISCARD
│   ├── assets/css/widget.css                                                  ─ DISCARD
│   └── assets/js/class.widget.js                                              ─ DISCARD
└── templates/
    ├── Extreme EXOS by SNMP w POE.yaml                                        ─ skip (duplicate of SwitchPortWidgets copy — see §A.2 note 6)
    └── Extreme_XIQ_APs.yaml                                                   ✓ LIFT → tcs_dashboard/templates/extreme_xiq_aps_by_api.yaml
```

### Notes

**Note 8 — XIQClient.php is large (2518 lines) and feature-complete.** Two
factory constructors:
- `XIQClient::fromToken($token)` — uses permanent API token from `{$XIQ_TOKEN}`. **Recommended.** No re-auth on 401 (token revoked → surface error).
- `XIQClient::fromCredentials($user, $pass)` — uses `POST /login` → short-lived JWT (~2 h), cached in APCu (per-FPM-worker) with filesystem fallback at `/tmp/zabbix_xiq_cache/`, auto-refresh on 401.

Cache strategy: APCu primary, filesystem fallback (`/tmp/zabbix_xiq_cache/`,
0700 root:apache). Cache-aware quota tracking (XIQ enforces 7,500
req/hr; client surfaces `RateLimit-Remaining` for monitoring).

PHP 8.0 polyfill: `array_is_list()` declared inline at namespace scope
because XIQClient calls it unqualified (lines ~800/860/958) and Zabbix's
PHP is 8.0. **AP G21 carry-forward applies — keep the polyfill in the
lift.**

Lift instruction: copy the file verbatim, change namespace from
`Modules\APDetail\Includes` → `Modules\TcsDashboard\Lib`. Don't refactor
on the way in. M5 polish can refactor later — the file works.

**Note 9 — PFClient.php (984 lines) is the canonical PacketFence client.**
Header comment makes the lineage explicit:

> Formalized from the static-helper bag in
> `modules/packetfence/includes/PfClient.php`
> (`Modules\PfDevice\Includes\PfClient`). Behaviour is identical [...]
> Static helpers → instance methods. Token state lives on the instance
> [...] Constructor takes the widget-config fields declared in
> WidgetForm (pf_url / pf_user / pf_pass / verify_ssl).

Methods include:
- `login()` — session auth (raw token, no `Bearer ` prefix per PF convention)
- `searchNodes()` — `POST /api/v1/nodes/search`
- `getActiveClientsForAp()` — orchestrated locationlog + nodes merge
- `locationlogSearch()` — `POST /api/v1/locationlogs/search` + bucketed client-count series
- `radiusAuditLog()` — `POST /api/v1/radius_audit_logs/search`
- HTTP 401 → re-auth → retry is internal

Lift instruction: copy verbatim, change namespace
`Modules\APDetail\Includes` → `Modules\TcsDashboard\Lib`. Constructor
takes resolved credential strings, not macro literals — caller (action
controller) reads macros via `Config::pf()` helper from M1 plan.

**Note 10 — XIQ macros use underscore form, not dot form.** Confirmed
from `Extreme_XIQ_APs.yaml`:

| Macro | Default | Required | Notes |
|---|---|---|---|
| `{$XIQ_TOKEN}` | — | yes (secret) | Permanent API token from XIQ Administration → API Access Tokens |
| `{$XIQ_URL}` | `https://api.extremecloudiq.com` | no | API base |
| `{$XIQ_PAGE_SIZE}` | `100` | no | LLD pagination |
| `{$XIQ_FUNCTION}` | `AP` | no | LLD filter for `device_function` |
| `{$XIQ_DISCONNECT_TIME}` | — | no | Disconnect threshold (seconds) |

**Plan correction:** v1.0 plan's `§A9` and `M0 task #2` both use the dot
form (`{$XIQ.TOKEN}`). The actual macro is `{$XIQ_TOKEN}` (underscore).
M1 templates lift carries this name through — no change needed on the
template side.

**Note 11 — `xiq_ap_status/actions/WidgetAction.php` is another
write-action surface (like rConfig in §A.2 note 5).** It exposes:
- `reboot` — POST to XIQ `/devices/{id}/reboot`
- `manage` / `unmanage` — toggle XIQ management state
- `refresh` — re-poll device config from XIQ
- `cli` — execute CLI command from operator-supplied allowlist
- `lro_status` — poll long-running-operation result

Auth: separate from XIQClient's read-side token. Action token lives in a
**file** (default `/etc/zabbix/secrets/xiq_action_token`, root:apache 0640).
Token never traverses the wire / session / DB / Zabbix API. Permissions:
`USER_TYPE_ZABBIX_ADMIN` minimum.

**Decision deferred to M3:** is XIQ write-actions in scope for v1.0?
The dashboards already render the kebab menus (Reboot / Manage / etc.
on AP rows). Wiring them is `tcs.ap.action.action` controller + lifting
the WidgetAction logic. ~2 days. **Recommend deferring to v2** unless
operators specifically ask for in-dashboard AP control — for v1.0 the
buttons can be hidden via a tweak (already in the existing tweak
system).

---

## §B — Cross-repo dedup decisions

| Asset | Source A | Source B | Decision | Reason |
|---|---|---|---|---|
| `pf_device/` widget folder | `MilestoneZabbix/` | `ZabbixSwitchPortWidgets/` | Discard both — superseded by `apdetail/PFClient.php` | byte-identical; both feature-incomplete vs apdetail's evolved client |
| `Extreme EXOS by SNMP w POE.yaml` | `ZabbixSwitchPortWidgets/templates/` | `ZabbixExtremeIQ/templates/` | Lift from SwitchPortWidgets (subject-matter alignment) | byte-identical |
| `Extreme_XIQ_APs.yaml` | `ZabbixExtremeIQ/templates/` (canonical) | `ZabbixExtremeIQ/Zabbix Extreme/` (draft) + `ZabbixSwitchPortWidgets/Zabbix Extreme/` (draft) | Lift from `templates/`, discard the two drafts | drafts diverge from canonical — the templates/ copy is the install-tested one |
| `Zabbix Extreme/` design folders | `ZabbixSwitchPortWidgets/` | `ZabbixExtremeIQ/` | Discard both — same source material as the design bundle that produced `tcs_dashboard`'s rendered UI | repeating the same JSX three times serves no purpose |

---

## §C — Adaptation notes per lift

These are adjustments needed when files move into `tcs_dashboard/`. Mostly
namespace renames + macro-resolution refactors; no rewrites.

### `lib/MilestoneClient.php` (built fresh in M1)

No source-repo PHP class to lift. The Milestone widget
(`milestone_camera_status/`) reads from Zabbix items (already populated by
the template's external scripts) — there's no PHP HTTP client to XProtect
in any of the widget repos. The data layer lives in:

- `templates/Milestone by HTTP API.yaml` — JS Script items embed inline
  OAuth2 token fetch + REST calls (e.g. `milestone.sites.get` is a
  Script item that runs ~50 lines of JS per poll).
- `externalscripts/milestone_cameras_state.py` — Python that calls
  XProtect REST + writes JSON to disk.

For our purposes, M2's `ActionSurveillanceData` mostly reads from Zabbix
(items already cached server-side from template polls). Where it needs to
hit XProtect directly (e.g. live camera thumbnails for the Camera Wall),
M2 builds a thin `MilestoneClient.php` that mirrors the JS Script items'
auth pattern (per-call OAuth2 token, no caching). Estimate ~250 lines.

### `lib/XIQClient.php` (lift from `apdetail/`)

Adaptations:
1. Namespace rename: `Modules\APDetail\Includes` → `Modules\TcsDashboard\Lib`
2. Keep `array_is_list` polyfill (PHP 8.0 — AP G21)
3. Keep APCu cache + filesystem fallback as-is
4. Constructor unchanged — already takes resolved credential strings

### `lib/PFClient.php` (lift from `apdetail/`)

Adaptations:
1. Namespace rename: `Modules\APDetail\Includes` → `Modules\TcsDashboard\Lib`
2. Constructor signature unchanged — takes `pf_url`, `pf_user`, `pf_pass`, `verify_ssl`
3. **Important:** the apdetail widget's WidgetForm collected these as
   per-widget config (operator types them at widget-add time). Our action
   controllers must source them from macros instead — `Config::pf()` in
   M1 spec returns `['url' =&gt; ..., 'user' =&gt; ..., 'pass' =&gt; ..., 'verify_ssl' =&gt; ...]`.
   Macro names need to be confirmed in M0 task #2 — the apdetail repo
   uses widget form fields, not template macros. Best guess based on
   convention: `{$PF.URL}`, `{$PF.USER}`, `{$PF.PASSWORD}` (secret),
   `{$PF.VERIFY.SSL}`. Confirm in M0 follow-up.

### `lib/SwitchClient.php` (built fresh in M1)

Re-implements the operationally-interesting logic from
`switchports/actions/WidgetView.php`:
- `stackMembers(int $hostid): array` — read `stacking.member[1..8]` items
- `portStatus(int $hostid): array` — read `net.if.status[ifOperStatus.*]` items, parse SNMPINDEX
- `poeStatus(int $hostid): array` — read `snmp.interfaces.poe.dstatus[<m>.<p>]` items, valuemap
- `fdbTable(int $hostid): array` — read MAC-learning items if present (currently sourced from Bridge-MIB walk; investigate in M3 whether this is templated or per-call)

No external HTTP — all reads via `API::Item()->get()`. ~200 lines.

### `lib/RConfigClient.php` (built fresh in M1, **scope decision deferred to M3**)

Lift logic from `portdetail/actions/CyclePoe.php`:
- `__construct(string $url, #[\SensitiveParameter] string $token, bool $verify_ssl)`
- `resolveDeviceId(string $hostId, string $hostName, ?string $hostIp, ?int $deviceIdMacro): int`
- `deploySnippet(int $deviceId, int $snippetId, array $vars): array`
- HTTPS enforcement (action refuses non-HTTPS URL)
- TLS verification on by default
- 15s connect / 30s total timeout, explicit User-Agent
- Returns `{ok, message, http_status}`

Estimate ~150 lines. Hold until M3 scope decision.

---

<a id="namespacing"></a>
## §D — Namespace policy (AP G16 carry-forward)

Every PHP class lifted from a source repo gets:

```php
namespace Modules\TcsDashboard\Lib;
```

No exceptions. Even if the source uses `Modules\APDetail\Includes`,
`Modules\PfDevice\Includes`, etc. — those namespaces are widget-specific
and would collide if we lifted under their original names. The only
PHP class moving with its existing namespace is **none** — every lift
gets renamed.

Same rule for any future write-action controllers
(`tcs.switch.cyclepoe.action`, `tcs.ap.action.action`): namespace
`Modules\TcsDashboard\Actions`, class names prefixed naturally
(`ActionSwitchCyclePoe`, etc.).

---

<a id="corrections"></a>
## §E — Corrections to `Project_Plan_v1_0.html`

These items in the v1.0 plan need updating in v1.1 (or a v1.0 errata
section):

| v1.0 reference | What it says | What's actually true |
|---|---|---|
| §A1 + M1 task "Lift Milestone template + 6 external scripts" | "six external scripts (`milestone_cameras_*.{sh,py}`, `milestone_ess_*.{sh,py}`)" | **Eight** external scripts. ESS triplet has two extra utility scripts (`milestone_ess_lookup.py`, `milestone_ess_resolve.py`). |
| §A9 + M0 task #2 | XIQ macros named `{$XIQ.TOKEN}` (dot form) | Actual: `{$XIQ_TOKEN}` (underscore form). Also `{$XIQ_URL}`, `{$XIQ_PAGE_SIZE}`, `{$XIQ_FUNCTION}`, `{$XIQ_DISCONNECT_TIME}`. |
| §A2 + M1 task "Lift PHP API clients" | "extracted from `jerahl/MilestoneZabbix/milestone_camera_status/` widget's HTTP scaffolding" | The `milestone_camera_status/` widget has **no** XProtect HTTP client — it reads from Zabbix items only. `MilestoneClient.php` is built fresh in M1 (estimate 250 lines, mirrors the JS Script items' auth pattern from the template). |
| §A3 + M1 task "Lift PHP API clients" | "PFClient.php — extracted from `pf_device` widgets (both repos have a copy — pick the newer / cleaner one)" | The `pf_device` PfClient.php (lowercase 'f') is **superseded** by the apdetail PFClient.php (capital 'F'). Lift apdetail's 984-line evolved version, not pf_device's 328-line static-helper bag. |
| §A4 ("EXOS PoE addon") | "PoE detection addon YAML" implying an `_addon.yaml` file | Actual file is `Extreme EXOS by SNMP w POE.yaml` — a **full template** (not an addon). The PoE OIDs are inline in the template, not a separate addon file. Lift target name corrected: `tcs_dashboard/templates/extreme_exos_by_snmp_with_poe.yaml`. |
| Plan does not mention | rConfig PoE-cycle write-action (`portdetail/actions/CyclePoe.php`) | Real feature — operator clicks "CYCLE PoE" in the dashboard's port-detail card. Macros: `{$RCONFIG.URL}`, `{$RCONFIG.TOKEN}`, `{$RCONFIG.POE_SNIPPET_ID}`, `{$RCONFIG.DEVICE_ID}`. **Scope decision deferred to M3** — recommend including. |
| Plan does not mention | XIQ AP write-actions (`xiq_ap_status/actions/WidgetAction.php`) | Real feature — reboot / manage / unmanage / refresh / CLI. Action token from `/etc/zabbix/secrets/xiq_action_token` (file, not macro). Permissions ZABBIX_ADMIN. **Scope decision deferred to M3** — recommend deferring to v2 (less-frequently used than rConfig). |
| §A6 "XIQClient.php — Already a clean PHP client class" | "lift verbatim into `tcs_dashboard/lib/XIQClient.php`" | Confirmed — 2518 lines, two factory constructors (`fromToken` recommended, `fromCredentials` for cred fallback), APCu + filesystem cache, PHP 8.0 polyfill inline. Lift verbatim, namespace rename only. |
| §A — missing | Milestone needs **eleven** macros, not the four the user mentioned | See §A.1 Note 3 above. The four ESS GUIDs (`{$MILESTONE.ESS.STATEGROUP.*}` × 2 + `{$MILESTONE.ESS.TYPE.*}` × 2) are XProtect-instance-specific — operator runs a one-time API call to obtain them. INSTALL.md needs to document this. |
| Plan does not mention | `pf_device/` is **byte-identical** in two source repos | Lift one copy or neither (we're picking neither, per Note 1). The `apdetail/PFClient.php` supersedes it. |

Each correction is one-line in v1.1; none of them invalidates the
overall milestone shape. M1's "Lift PHP API clients" task scope grows
slightly (build `MilestoneClient.php` fresh instead of extracting),
M3's scope decision around write-actions adds 1–3 days if scoped in.

---

## §F — Sign-off

M0 task #1 complete. Outputs:

1. This document (`tcs_dashboard/notes/lift-manifest.md`).
2. Source-repo file walk recorded above (snapshot date 2026-05-10, branch `main` for all three).
3. Cross-repo dedup decisions recorded in §B.
4. Adaptation notes per lift target recorded in §C.
5. Corrections to `Project_Plan_v1_0.html` §A captured in §E.

**Unblocks M0 tasks #2 (macro harmonisation — XIQ underscores confirmed,
PF macro names still TBD)** and **#5 (SourceBadge mapping spec — needs
the per-template item-key list which this audit produced).**
