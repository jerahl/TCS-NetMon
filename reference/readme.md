# `reference/` — the ZabbixCustomDashboard module NetMon replaces

A read-only mirror of `jerahl/ZabbixCustomDashboard` (Zabbix frontend module
`tcs_dashboard`), kept here because it is the authoritative record of the UI
being ported and of every source-API gotcha the original hit. Nothing in this
directory is executed or imported by NetMon.

**Provenance:** synced 2026-09-07 from the `tcs-dashboard-reference` bundle
exported off the production Zabbix server (tcs_dashboard **1.3.0**, Zabbix 7.4.9).
Line endings normalised to LF; content otherwise verbatim.

| Path | What it is |
|---|---|
| `TCS-Dashboard-Functionality.md` | **Start here.** The owner's functional reference for the port: what every page does, which API each panel reads, write actions, macros, external scripts, known gaps |
| `ZCD-README.md`, `Project_Plan_v1_0.html`, `Module.php`, `manifest.json`, `package.json` | the module's own README, project plan, Zabbix module entry point (menu), manifest, Babel build |
| `actions/` | PHP controllers — `Action<Page>` (SSR shell + boot) / `Action<Page>Data` (JSON rollups) / write actions (`ActionSwitchCyclePoe`, `ActionXiqApReboot`, `ActionPfDevice`, `ActionEventsUpdate`, `ActionCameraSnapshot`) |
| `lib/` | external-system clients — XIQ, XIQ fleet, PacketFence, rConfig, 3CX, Milestone, FortiAnalyzer, Zabbix-item `SwitchClient` — with the rate-limit / auth / paging gotchas in comments |
| `assets/` | the React/JSX pages, bridges and per-page CSS. `styles.css` is ported verbatim into `frontend/src/styles.css`; `surveillance.css` etc. likewise. `dist/` and `vendor/` (compiled output, React copies) are **not** mirrored |
| `views/` | the PHP view shells (Google Fonts links, boot-payload injection, script load order) |
| `notes/` | the module's design notes: integration plan, lift manifest, VoIP plan, Zabbix template patches |
| `templates/` | the one Zabbix template the module ships (server forks by agent) |
| `zabbix/milestone/` | the Milestone XProtect work: external-check scripts, ESS (WebSocket) state reader + GUID resolver, the standalone `collector/`, template YAMLs, rework docs, `test/` harness. `template_milestone_camera_bosch.yaml` is the owner's Bosch camera SNMP template (spec 13) |
| `zabbix/milestone/samples/` | **sanitised samples** (first records) of the `/var/lib/zabbix/milestone_*_state.json` files the scripts write, plus log tails and the `.err` marker — the payload shapes NetMon's collector parses |
| `zabbix/externalscripts-deployed/` | the scripts as actually deployed in `/usr/lib/zabbix/externalscripts` on 2026-09-07. They differ from the `zabbix/milestone/` source copies (deployed `*_refresh.sh` wrappers, `milestone_groups_*`) — when the two disagree, this is what ran |

**Deliberately not mirrored:** `etc-zabbix/` (server/web config and the two XIQ
token files — redacted placeholders in the bundle, and credentials never enter
this repo regardless — CLAUDE.md §4.6), `httpd/`, `cron/` (contained the Milestone
service-account password on the command line), `server-scripts/`, and
`graphify-out/`.

Spec 20 (`docs/spec/20-zcd-look-parity.md`) records what changed between the
previous mirror and this one, and the page-by-page plan for matching the look.
