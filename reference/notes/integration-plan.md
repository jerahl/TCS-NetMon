# Dashboard Integration Plan — wiring the companion repos

Audit of `jerahl/ZabbixSwitchPortWidgets`, `jerahl/MilestoneZabbix`, and
`jerahl/ZabbixExtremeIQ` against the current `tcs_dashboard` module, with a
sequenced plan to take every page off mock data. Builds on
`notes/lift-manifest.md` (file-by-file classification) and the v1.0
project plan; this doc is the "what's wireable now / what's still missing"
delta.

---

## 1. Status per page

| Page | Controller | Data source today | Live? |
|---|---|---|---|
| AP Detail | `ActionDashboard` + `ActionDashboardData` | `host.get` / `item.get` against XIQ + ICMP templates | **Yes** (placeholder item keys still in `collectItems()`) |
| Global | `ActionGlobal` | `global-data.jsx` synthetic | No |
| Switches | `ActionSwitches` | `switches-data.jsx` mock | No |
| Servers | `ActionServers` | `servers-data.jsx` mock | No |
| Surveillance NOC | `ActionSurveillance` | `nvr-data.jsx` mock | No |
| Camera Detail | `ActionCamera` | `nvr-data.jsx` mock | No |
| Recording Server | `ActionServer` | `nvr-data.jsx` mock | No |

Only AP Detail has a real data pipeline (controller → boot + 30s
`tcs.dashboard.data` poll → `data-bridge.jsx` → window globals). Every other
page is a render shell waiting for a parallel bridge.

---

## 2. What can be wired *now* (no new code from the source repos)

These pages can move to live data using only what's already in our tree
plus standard `host.get` / `item.get` calls:

### 2a. Global Dashboard — wire entirely from Zabbix core APIs
No external systems needed. KPIs / severity / heatmap / triggers all come
from `trigger.get`, `problem.get`, `host.get`, `event.get`.

- Build `ActionGlobalData` (parallel to `ActionDashboardData`) that
  returns `{kpis, sites, triggers, events, trend24h}`.
- Build `assets/global-bridge.jsx` that adapts the payload into
  `window.GLOBAL_KPIS` / `window.GLOBAL_SITES` / `window.GLOBAL_TRIGGERS`
  (names already used by `global-data.jsx`).
- Site grouping: use Zabbix host-group names with a configurable prefix
  (e.g. `Site/*`) — same convention `data-bridge.jsx` uses for AP sites.

Effort: ~1 day. No new templates, no new macros, no new clients.

### 2b. AP Detail — finish the placeholder map
`ActionDashboard::collectItems()` still has stub keys
(`extreme.ap.poe.draw`, etc.). Replace with the real keys from the
**lifted XIQ template** once it's imported into Zabbix (see §3a). Zero
new code — just align right-hand sides of `$key_map` to
`extreme_xiq_aps_by_api.yaml`'s item keys.

Effort: 1–2 hours after the template is imported.

---

## 3. What's lift-and-adapt from the companion repos

These are documented in detail in `lift-manifest.md`; this section is the
"what slots into which page" view.

### 3a. From `jerahl/ZabbixExtremeIQ` → AP Detail polish + Switches PoE valuemaps

| Lift | Destination | Notes |
|---|---|---|
| `apdetail/includes/XIQClient.php` | `lib/XIQClient.php` | 2518 lines, lift verbatim; namespace rename only. Use `fromToken($XIQ_TOKEN)` for new direct calls (live client lists, location-log graphs that can't be templated). |
| `apdetail/includes/PFClient.php` | `lib/PFClient.php` | 984 lines, lift verbatim. Lets `ActionDashboard::collectPacketFence()` (already stubbed) populate `pfClients` / `pfAuthFails`. Macros `{$PF.URL}` / `{$PF.USER}` / `{$PF.PASSWORD}` / `{$PF.VERIFY.SSL}` need to be created on the PF-monitored host. |
| `templates/Extreme_XIQ_APs.yaml` | `templates/extreme_xiq_aps_by_api.yaml` | Import into Zabbix and apply to AP hosts. Defines `device_function`, status, channel, client count, RSSI, PoE draw, etc. Macros: `{$XIQ_TOKEN}` (secret) and friends — note **underscore** form, not dot. |

After §3a:
- AP Detail's PacketFence panel goes live.
- AP Detail's item keys are real.
- Switches page gains nothing yet, but the EXOS template (§3b) reuses
  the same valuemap conventions.

### 3b. From `jerahl/ZabbixSwitchPortWidgets` → Switches

| Lift | Destination | Notes |
|---|---|---|
| `templates/Extreme EXOS by SNMP w POE.yaml` | `templates/extreme_exos_by_snmp_with_poe.yaml` | Import + apply to switch hosts. Provides `stacking.member[1..8]`, `net.if.status[ifOperStatus.*]`, `snmp.interfaces.poe.dstatus[<m>.<p>]`, PoE valuemap (1=Disabled / 3=Delivering / 4=Fault…). |
| **Build fresh** `lib/SwitchClient.php` (~200 lines) | `lib/SwitchClient.php` | Re-implements `switchports/actions/WidgetView.php` logic as instance methods: `stackMembers()`, `portStatus()`, `poeStatus()`, `fdbTable()`. Pure `API::Item()->get()` — no external HTTP. |
| **Build fresh** `actions/ActionSwitchesData.php` | + `assets/switches-bridge.jsx` | Parallel to `ActionDashboardData` / `data-bridge.jsx`. Maps payload into `window.SWITCH_SITES` / `window.ARC_MDF_STACK` / `window.makePortDetail`. |

Deferred to phase 3 (write-action):
- `portdetail/actions/CyclePoe.php` → `lib/RConfigClient.php` +
  `tcs.switch.cyclepoe.action`. Macros `{$RCONFIG.URL}` /
  `{$RCONFIG.TOKEN}` / `{$RCONFIG.POE_SNIPPET_ID}`. Operator-visible
  button already exists in the UI. **Recommend in scope for v1.0.**

### 3c. From `jerahl/MilestoneZabbix` → Surveillance NOC / Camera / Recording Server

| Lift | Destination | Notes |
|---|---|---|
| `templates/Milestone by HTTP API.yaml` | `templates/milestone_by_http_api.yaml` | Imports the JS-Script items that talk to XProtect. |
| 8 external scripts (`milestone_{cameras,ess}_*.{sh,py}`) | `externalscripts/` | Deploy to Zabbix server's `ExternalScripts` directory. Note: **eight** scripts — `lift-manifest.md` §A.1 Note 2 corrects v1.0 plan which said six. |
| **Build fresh** `lib/MilestoneClient.php` (~250 lines) | | No source-repo PHP client to lift; mirror the JS-Script auth pattern from the template (per-call OAuth2). Needed only for live camera-wall thumbnails — the rest of the data goes through Zabbix items populated by the template. |
| **Build fresh** `actions/ActionSurveillanceData.php` + `assets/surveillance-bridge.jsx` | | Adapt into `window.MILESTONE` / `window.SITES` from `nvr-data.jsx`. Camera + Recording Server detail views share the same payload — filter by `id` query param. |

Macros required (11 total — see lift-manifest §A.1 Note 3): host /
scheme / user / password / OAuth2 client id, **four ESS GUIDs**
(state-group COMMUNICATION + RECORDING, type COMMUNICATION_OK +
RECORDING_STARTED) which are XProtect-instance-specific. Operator must
run a one-time XProtect API call at install to harvest those GUIDs;
install doc needs to spell out the procedure.

Deferred:
- `xiq_ap_status/actions/WidgetAction.php` (reboot / manage / CLI) is
  another write-action surface. **Recommend defer to v2** — buttons can
  be hidden via the existing tweak system. ~2 days when scoped in.

### 3d. Servers — no source-repo data, all Zabbix-native

| Build | Destination | Notes |
|---|---|---|
| `ActionServersData` | parallel to `ActionDashboardData` | Read Linux-agent / Windows-agent / iDRAC SNMP items (`system.cpu.util`, `vm.memory.utilization`, sensor temps, disk SMART, etc.). |
| `assets/servers-bridge.jsx` | | Maps into `window.SRV_SITES` / `window.SRV_HOST` / `window.SRV_ITEMS`. |

No new templates strictly needed if standard Zabbix templates are
already applied; iDRAC support wants the Dell template (community
macro `{$DELL.IDRAC.SNMP.COMMUNITY}` per v1.0 plan §G18).

---

## 4. Cross-cutting work

- **Config helper.** Single `lib/Config.php` returning resolved
  credentials (`Config::pf()`, `Config::xiq()`, `Config::milestone()`,
  `Config::rconfig()`) by reading `usermacro.get`. Source repos either
  used widget-form fields or `CMacrosResolverHelper`; we standardise on
  user macros only.
- **Permissions.** Read views stay `USER_TYPE_ZABBIX_USER`. All
  write-actions (rConfig, eventually XIQ) require
  `USER_TYPE_ZABBIX_ADMIN` and CSRF — pattern lifted from
  `portdetail/actions/CyclePoe.php`.
- **Namespace policy.** Every lifted PHP class moves to
  `Modules\TcsDashboard\Lib`. The two large clients
  (XIQClient/PFClient) carry their `array_is_list` PHP 8.0 polyfill —
  do **not** strip it (Zabbix ships PHP 8.0).
- **Poll cadence.** `data-bridge.jsx` polls 30 s. Reuse that for the
  other bridges; longer for Surveillance ESS (template polls 1d by
  default — the dashboard can poll its cached items at 30 s without
  hitting XProtect).
- **Manifest registration.** Each new `*Data` controller needs an entry
  in `manifest.json` with `layout.json` (see existing
  `tcs.dashboard.data` block).

---

## 5. Sequenced milestones

The numbering here is the implementation order; it tracks but doesn't
duplicate v1.0 `Project_Plan_v1_0.html` M0–M5.

**Phase 1 — no external lifts (≈ 2 days).**
1. `ActionGlobalData` + `global-bridge.jsx`. Global Dashboard live.
2. `ActionServersData` + `servers-bridge.jsx` against existing OS
   templates. Servers page live (iDRAC/sensors come later).
3. Replace placeholder keys in `ActionDashboard::collectItems()` once
   the XIQ template is staged (drop-in once macro `{$XIQ_TOKEN}` is on
   the host).

**Phase 2 — template + client lifts (≈ 5 days).**
4. Lift `XIQClient.php` + `PFClient.php` verbatim into `lib/`.
5. Lift three template YAMLs into `templates/` and import on the
   pilot site (Bryant HS or equivalent).
6. Lift eight Milestone external scripts; deploy on the Zabbix server.
7. Implement `Config.php`. Wire `ActionDashboard::collectPacketFence()`
   (already stubbed). AP Detail PF panel live.
8. Build `SwitchClient.php`, `ActionSwitchesData`, `switches-bridge.jsx`.
   Switches page live.
9. Build `MilestoneClient.php`, `ActionSurveillanceData`,
   `surveillance-bridge.jsx`. Surveillance + Camera Detail + Recording
   Server views live.

**Phase 3 — write-actions (scope-gated, ≈ 1 day if in).**
10. Lift rConfig PoE-cycle: `lib/RConfigClient.php` +
    `tcs.switch.cyclepoe.action` controller. CSRF, admin-only.
    Recommend including in v1.0 — the button is already in the UI.
11. **Defer to v2:** XIQ write-actions (reboot / manage / CLI). Hide
    affected kebab items via tweaks until then.

**Phase 4 — polish.**
12. Replace `unpkg.com` React/ReactDOM/Babel-standalone with a real
    build step (esbuild) so air-gapped installs work and Babel-standalone
    leaves the wire.
13. Tighten `checkPermissions()` per page if role-gating is wanted.
14. Switch `data-bridge.jsx` (and the new bridges) from 30 s polling
    to SSE if push updates are desired.

---

## 6. Open decisions

Need operator/owner sign-off before Phase 2:

1. **rConfig PoE-cycle in v1.0?** Recommend yes. Adds `{$RCONFIG.*}`
   macros and the write-action controller.
2. **XIQ write-actions in v1.0?** Recommend no (defer to v2).
3. **PacketFence macro names.** Source repos use widget form fields,
   not macros. We need to pick the canonical set
   (`{$PF.URL}` / `{$PF.USER}` / `{$PF.PASSWORD}` / `{$PF.VERIFY.SSL}`)
   and document it; v1.0 plan §A2 already proposed these.
4. **Pilot host.** Bryant HS or equivalent — needs to have all four
   source systems (Zabbix host, XIQ APs, EXOS switches, XProtect
   recording server). v1.0 M0 task #3.
5. **Site-grouping convention** for Global Dashboard — host-group prefix
   (`Site/Bryant HS`, `Site/…`) vs. host inventory `location` field.
   Recommend host groups (matches `data-bridge.jsx`).

---

## 7. Estimated total

| Phase | Effort |
|---|---|
| 1 (Global + Servers + AP key map) | 2 days |
| 2 (lifts + Switches + Surveillance) | 5 days |
| 3 (rConfig write-action, scope-gated) | 1 day |
| 4 (polish, optional) | 2–3 days |

**Critical path to "every page on live data": ~7 working days** assuming
the pilot host is identified and Zabbix/XIQ/PF/XProtect creds are in
hand on day one.
