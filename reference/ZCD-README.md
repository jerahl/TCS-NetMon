# TCS Dashboard — Zabbix Frontend Module

Custom-skinned operations pages that live inside Zabbix:

| Page                  | URL                                              | Status                       |
| --------------------- | ------------------------------------------------ | ---------------------------- |
| Global Dashboard      | `zabbix.php?action=tcs.global.view`              | Mock data (synthetic)        |
| AP Detail (Wireless)  | `zabbix.php?action=tcs.dashboard.view&hostid=N`  | Wired to live Zabbix data    |
| FortiGate Firewall    | `zabbix.php?action=tcs.fortigate.view`           | Live (SNMP + FortiAnalyzer)  |
| Switch Port Status    | `zabbix.php?action=tcs.switches.view`            | Mock data (SNMP wiring)      |
| Servers               | `zabbix.php?action=tcs.servers.view`             | Mock data (agent wiring)     |
| Surveillance NOC      | `zabbix.php?action=tcs.surveillance.view`        | Mock data (Milestone wiring) |
| Camera Detail         | `zabbix.php?action=tcs.camera.view&id=…`         | Mock data                    |
| Recording Server      | `zabbix.php?action=tcs.server.view&id=…`         | Mock data                    |

All pages share a unified sidebar (`global-nav.jsx`) that cross-links between
them and back to the default Zabbix UI (`zabbix.php?action=dashboard.view`).

```
ui/modules/tcs_dashboard/
├── manifest.json
├── Module.php                         menu registration
├── actions/
│   ├── ActionGlobal.php               Global Dashboard controller (mock data)
│   ├── ActionDashboard.php            AP Detail controller (live data)
│   ├── ActionDashboardData.php        AP Detail JSON refresh endpoint
│   ├── ActionSwitches.php             Switches controller (mock data)
│   ├── ActionServers.php              Servers controller (mock data)
│   ├── ActionSurveillance.php         Surveillance controller (mock data)
│   ├── ActionCamera.php               Camera Detail controller (mock data)
│   └── ActionServer.php               Recording Server Detail controller (mock data)
├── views/
│   ├── global.view.php
│   ├── dashboard.view.php
│   ├── switches.view.php
│   ├── servers.view.php
│   ├── surveillance.view.php
│   ├── camera.view.php
│   └── server.view.php
└── assets/
    ├── styles.css                     shared design tokens (incl. AP-nav rail)
    ├── primitives.jsx                 shared (Icon, SourceBadge, etc.)
    ├── tweaks-panel.jsx               shared (settings flyout)
    ├── global-nav.jsx                 unified sidebar + topbar (all pages)
    ├── nvr-shell.jsx                  back-compat shim for NVRSidebar/NVRTopbar
    ├── global-data.jsx                Global Dashboard mock data
    ├── global-app.jsx                 Global Dashboard entry point
    ├── global.css                     Global Dashboard-specific styles
    ├── tabs.jsx                       AP Detail tabs
    ├── shell.jsx                      AP Detail page header + sidecar + AP nav
    ├── app.jsx                        AP Detail entry point
    ├── data-bridge.jsx                AP Detail server↔client adapter
    ├── nvr-data.jsx                   Surveillance/Server/Camera mock data
    ├── nvr-overview.jsx               Surveillance overview widgets
    ├── nvr-app.jsx                    Surveillance entry point
    ├── nvr-camera.jsx                 Camera Detail entry + widgets
    ├── nvr-server.jsx                 Recording Server Detail entry + widgets
    ├── surveillance.css               Surveillance-specific styles
    ├── switches-data.jsx              Switches mock data
    ├── switches-widgets.jsx           Switches port-grid widgets
    ├── switches-app.jsx               Switches entry point
    ├── switches.css                   Switches-specific styles
    ├── servers-data.jsx               Servers mock data
    ├── servers-widgets.jsx            Servers fleet/sidecar widgets
    ├── servers-app.jsx                Servers entry point
    └── servers.css                    Servers-specific styles
```

## Install

1. Copy this whole folder to your Zabbix UI's modules directory:

   ```
   <zabbix-ui-root>/modules/tcs_dashboard/
   ```

   On a typical Linux install that path is `/usr/share/zabbix/modules/`.
   The folder name **must** match the `id` in `manifest.json` (`tcs_dashboard`).

2. In the Zabbix web UI go to **Administration → General → Modules**, click
   **Scan directory**, find "TCS Dashboard" in the list, and toggle it to
   **Enabled**.

3. The new entry appears under the **Monitoring** menu. Or hit it directly:

   ```
   /zabbix.php?action=tcs.dashboard.view&hostid=10847
   ```

   Without `hostid` you'll see the empty-state ("Select a host"). For now the
   easiest pattern is to link to it from a Zabbix host map / inventory page
   with the hostid baked in. A host-picker dropdown is a 30-line addition to
   `app.jsx` if you want one.

## Cross-page navigation

Every page renders the unified sidebar from `global-nav.jsx`. Top-level
structure:

- **Default Zabbix Dashboard** (small pill above the brand) — exits the
  custom UI and returns to standard Zabbix.
- **Monitoring**: Global Dashboard · Hosts · Wireless APs · Switches ·
  Servers · Problems · Events.
- **Identity (PacketFence)**: Connected Devices · NAC Policies · User
  Sessions · Quarantine.
- **Surveillance (Milestone)**: NOC Overview · Cameras · Recording Servers ·
  Evidence Lock · VMS Alarms.

URLs live in one place — `window.TCS_NAV` at the top of `global-nav.jsx`. If
you change a route or rename an action, update that single object.

The "Wireless APs" link from the other pages goes to `tcs.dashboard.view`
without a `hostid`, which lands on the empty-state ("Select a host"). If you
want it to deep-link to a specific host, change `window.TCS_NAV.apDetail` to
include the hostid you want. Same applies to `cameraDetail` / `serverDetail`
(both go to a generic detail view today; pass `&id=…` to land on a specific
camera or recording server once those views are wired to real data).

## Zabbix Server Status — required templates

The TCS Zabbix Server Status page (`zabbix.php?action=tcs.zbx.status.view`)
reads from these stock Zabbix templates plus one TCS companion:

| Template                                        | Source                                                  | Where it goes                              |
| ----------------------------------------------- | ------------------------------------------------------- | ------------------------------------------ |
| `Zabbix server health`                          | stock — included with Zabbix                            | host running `zabbix-server`               |
| `Zabbix proxy health`                           | stock — included with Zabbix                            | every `zabbix-proxy` host                  |
| `Zabbix agent active`                           | stock — included with Zabbix                            | server + proxy hosts                       |
| `TCS Zabbix server forks by agent active`       | this repo: [`templates/tcs_zabbix_server_forks_by_agent.yaml`](templates/tcs_zabbix_server_forks_by_agent.yaml) | host running `zabbix-server` |

The TCS template adds one `proc.num[,,,"zabbix_server: <type> #"]` item per
Zabbix server process type (poller, history syncer, preprocessing worker,
housekeeper, …). It depends on `Zabbix agent active` being present on the
server host. The dashboard pairs the running fork count with the `%busy`
value from the server-health template so each process row shows both.

To install:

1. **Configuration → Templates → Import** the YAML.
2. Apply both `Zabbix agent active` and `TCS Zabbix server forks by agent
   active` to the host that monitors `zabbix-server`.
3. Wait one polling interval (5 min). The dashboard's "Internal Processes"
   panel will then show fork counts next to each `%busy` bar; rows show
   "— forks" until the agent items populate.

## Map your real item keys

The PHP controller has placeholder item keys in `ActionDashboard::collectItems()`:

```php
$key_map = [
    'cpu'     => 'system.cpu.util',
    'memory'  => 'vm.memory.utilization',
    'temp'    => 'sensor.temp.value[CPU]',
    'poeDraw' => 'extreme.ap.poe.draw',
    ...
];
```

Edit the right-hand side to match the keys actually defined on your Extreme
AP / ICMP / PacketFence templates. If a key isn't found on the host the
frontend renders a `—` and a "missing" badge — useful while you're wiring
things up.

A quick way to dump the actual keys on a host:

```bash
curl -sS http://<zabbix>/api_jsonrpc.php \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"item.get","params":{"output":["key_","name"],"hostids":["10847"]},"auth":"<token>","id":1}' \
  | jq -r '.result[] | "\(.key_)\t\(.name)"'
```

## FortiGate firewall data — FortiAnalyzer

The FortiGate page (`zabbix.php?action=tcs.fortigate.view`) is driven by the
**"FortiGate by SNMP"** template for everything SNMP exposes — device health,
interfaces, IPsec tunnel up/down, SD-WAN SLA, sessions, and the IPS counters.
Four sections SNMP can't cover are filled from **FortiAnalyzer** instead:

| Section                  | Source     | Notes                                            |
| ------------------------ | ---------- | ------------------------------------------------ |
| Top Threat Signatures    | FortiAnalyzer | IPS/`attack` logs, grouped by signature       |
| Top Policies by Hit Count| FortiAnalyzer | `traffic` logs, grouped by `policyid`         |
| SSL-VPN · Connected Users| FortiAnalyzer (+ZBX count) | `event`/vpn logs, latest session per user |
| IPsec RX/TX MB + peer    | FortiAnalyzer (+ZBX up/down) | `event`/vpn logs, summed per tunnel  |
| UTM block counts (AV/WF/App/DNS) | FortiAnalyzer | per-engine block logs                  |

If FortiAnalyzer isn't configured the dashboard still works — those cards just
render their empty state and carry a `FAZ` badge showing the source is
unconfigured. SNMP data is never blocked by a FortiAnalyzer outage.

### Configure (Zabbix global macros)

Set these under **Administration → General → Macros**:

| Macro                              | Required | Example                          |
| ---------------------------------- | -------- | -------------------------------- |
| `{$TCS.FORTIANALYZER.URL}`         | yes      | `https://fortianalyzer.tcs.local`|
| `{$TCS.FORTIANALYZER.USER}`        | session auth | `dashboard_ro`               |
| `{$TCS.FORTIANALYZER.PASS}`        | session auth | (read-only API user password)|
| `{$TCS.FORTIANALYZER.TOKEN}`       | token auth   | (FAZ 7.x API-user token)     |
| `{$TCS.FORTIANALYZER.ADOM}`        | no (default `root`) | `root`                |
| `{$TCS.FORTIANALYZER.VERIFY.SSL}`  | no (default `1`) | `0` to skip TLS verify    |

Two auth modes:

- **Session login** (works on all FAZ versions): set `USER` + `PASS`. The
  client calls `exec /sys/login/user`, caches the session id, and re-logs in
  on expiry.
- **API token** (FAZ 7.x "API user"): set `TOKEN`. It's sent as a
  `Authorization: Bearer` header and takes precedence over `USER`/`PASS` — no
  login round-trip.

Create a FAZ admin / API user scoped to the ADOM that holds your FortiGate's
logs. **The admin must have `JSON API Access` set to `Read-Write`**
(System Settings → Admin → Administrators → *user* → JSON API Access). This is
the most common gotcha: session login (`/sys/login/user`) succeeds regardless
of this setting, but every actual API call — including the `logsearch` the
dashboard runs — returns `-32603 "Access denied. user=, userfrom=JSON(api_user)"`
until it's enabled. `Read-Write` (not just `Read`) is required because
`logsearch` uses the `add` method to create a search task. The admin's profile
also needs access to the relevant ADOM and Log View; the dashboard itself only
ever reads.

### How it fetches

`lib/FortiAnalyzerClient.php` issues JSON-RPC `logsearch` calls to
`<URL>/jsonrpc`, polls the async search task, and aggregates the top-N in PHP.
Results are cached **120s** (separate from the 30s SNMP cache) so the slow log
searches don't run on every page refresh. Searches are filtered to the primary
FortiGate by serial (`inventory.serialno_a`) when known, else they cover the
whole ADOM. The look-back window is 24h.

**Log field names** follow the FortiOS 7.x schema (`attack`, `policyid`,
`sentbyte`, `tunnelid`, …). If your FAZ runs an older FortiOS or a customized
log format and a card stays empty, check a raw `logsearch` response and adjust
the field reads in `FortiAnalyzerClient` (the aggregators and the `LOGTYPE`
map). A field mismatch degrades to an empty card — it never errors the page.

## PacketFence data

PacketFence is a separate system, not Zabbix. The boot payload exposes
`pfClients` and `pfAuthFails` arrays but they're empty by default. To fill
them in:

1. Open `actions/ActionDashboard.php`.
2. Implement `collectPacketFence($hostid)` to call your PF instance's REST
   API (`/api/v1/nodes`, `/api/v1/reports/...`).
3. Uncomment `$boot['pfClients'] = $this->collectPacketFence($hostid);` in
   `doAction()`.

Cache aggressively — PF queries are slow and the page polls every 30s.

## Live refresh

`data-bridge.jsx` polls `tcs.dashboard.data` every 30 seconds and updates the
window globals. If you want push updates instead, swap the `setInterval` for
a Server-Sent Events stream — Zabbix's frontend supports streaming responses
from a controller, you'd just emit `text/event-stream` from `doAction()`.

## Auth and permissions

All controllers require `USER_TYPE_ZABBIX_USER` or higher. If you want to
restrict to a specific user group / role, change `checkPermissions()` in
each action class:

```php
protected function checkPermissions(): bool {
    if ($this->getUserType() < USER_TYPE_ZABBIX_USER) return false;
    return in_array(CWebUser::$data['roleid'] ?? 0, [/* allowed role ids */]);
}
```

Host-level visibility is automatic — the API calls run as the logged-in user,
so they only return hosts that user has read access to.

## Air-gapped installs

The view loads React, ReactDOM, and Babel-standalone from `unpkg.com`. If
your Zabbix server can't reach the internet:

1. Download those three files into `assets/`.
2. Update the `<script src="...">` tags in `views/dashboard.view.php`.
3. Consider doing a real build step (esbuild / vite) so you can drop
   Babel-standalone — it's the heaviest of the three by far.

## Version notes

Tested patterns: Zabbix **6.0 LTS**, **6.4**, **7.0**.

- The menu registration in `Module.php` uses `APP::Component()->get('menu.main')`,
  which exists from 6.0+. For 5.x, the menu API was different (and there was
  no `Zabbix\Core\CModule` namespace) — you'd downgrade `manifest_version` to
  `1.0` and use the older `\Modules\TcsDashboard\Module extends \CModule`
  signature.
- `layout.htmlpage` and `layout.json` exist on 6.0+. On older majors,
  substitute `layout.htmlpage` with whatever the minimal layout was (often
  just omitting `layout` from the action config).
- The `<style>` block at the top of `dashboard.view.php` hides Zabbix's own
  header/sidebar so the dashboard takes the full viewport. The selectors are
  reasonable but Zabbix occasionally renames its top-level chrome elements
  between majors. If after upgrade you see Zabbix's nav reappearing above
  your dashboard, inspect the DOM and update those selectors.
- `select_acknowledges`, the `proxy_hostid` field, and a few other
  `host.get` / `event.get` parameters were renamed in 7.0+. If you upgrade,
  check the API changelog for the methods used in `ActionDashboard.php`.

## What this scaffold deliberately doesn't do

- **No host picker on AP Detail.** Pass `?hostid=` in the URL. Add a
  dropdown in `app.jsx` if you want one — the host list comes from
  `host.get` with no filter.
- **No write paths.** All actions are read-only. If you want acknowledge /
  problem-suppress / config-push buttons in the UI, add a write-action
  controller (e.g. `tcs.dashboard.action`) with CSRF enabled and a method
  whitelist.
- **No real data on Global / Switches / Servers / Surveillance yet.** Each
  page renders its mockup (`global-data.jsx`, `switches-data.jsx`,
  `servers-data.jsx`, `nvr-data.jsx`). The controllers are scaffolded so
  that wiring real data is a parallel job to what's already done for AP
  Detail:
  - **Global:** aggregate trigger + host counts via `trigger.get` and
    `host.get`; build `global-bridge.jsx` mapping them into
    `window.GLOBAL_KPIS` / `window.GLOBAL_SITES` / `window.GLOBAL_TRIGGERS`.
  - **Switches:** Zabbix host.get + item.get against your switch templates.
    Port operational status comes from `ifOperStatus[<index>]` on the
    Generic SNMP template; PoE state from POWER-ETHERNET-MIB
    (`pethPsePortDetectionStatus`). Build `switches-bridge.jsx` mapping
    those into `window.SWITCH_SITES` / `window.ARC_MDF_STACK` /
    `window.makePortDetail`.
  - **Servers:** Zabbix host.get + item.get against your server templates
    (Linux/Windows agent, OS Linux SNMP, Dell iDRAC, etc.). Build
    `servers-bridge.jsx` mapping them into `window.SRV_SITES` /
    `window.SRV_HOST` / `window.SRV_ITEMS`.
  - **Surveillance / Camera / Server detail:** Milestone XProtect's REST API
    (`/api/rest/v1/`) for server health and recording state, optionally
    Zabbix items templated against the recording servers themselves. Build
    `surveillance-bridge.jsx` parallel to `data-bridge.jsx`, mapping the API
    response into `window.MILESTONE` / `window.SITES` / etc.
