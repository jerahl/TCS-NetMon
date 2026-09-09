# Paste-ready: README banner snippets for the three widget repos

These three snippets are intended to be pasted at the **top of each repo's
README** (right under the project title). They flag that the widget repos
remain installable but that active development of the dashboards now lives
in `jerahl/ZabbixCustomDashboard` (the `tcs_dashboard` module). The tone is
"this still works, but here's where to look next" — not a hard deprecation.

The tcs_dashboard module **lifts the data layers** from each of these repos
(templates, external scripts, PHP API clients) and reuses them inside its
unified custom dashboards. It does **not** replace the widget shells — those
keep working as standalone Zabbix dashboard widgets.

---

## `jerahl/MilestoneZabbix` — README banner

```markdown
> ### Status note (May 2026)
>
> The **template + external scripts** in this repo (`Milestone by HTTP API.yaml`,
> `milestone_cameras_*.{sh,py}`, `milestone_ess_*.{sh,py}`) are the canonical
> data layer for Milestone XProtect monitoring under Zabbix and continue to be
> developed here.
>
> The **`milestone_camera_status/` and `pf_device/` widgets** still install
> and run as standalone Zabbix 7.x dashboard widgets. New visual work and
> integration with the Camera Detail / Recording Server Detail / Surveillance
> NOC dashboards now lives in
> [`jerahl/ZabbixCustomDashboard`](https://github.com/jerahl/ZabbixCustomDashboard)
> (the `tcs_dashboard` module). That module lifts the template + external
> scripts from this repo and reuses them as its surveillance data layer —
> see its `Project_Plan_v1_0.html` for the integration plan.
>
> tl;dr: keep this repo for the template, look at `tcs_dashboard` for the
> next-gen UI.
```

---

## `jerahl/ZabbixSwitchPortWidgets` — README banner

```markdown
> ### Status note (May 2026)
>
> The **EXOS PoE template additions** in `templates/` and the
> **PacketFence-15 device-enrichment client** in `pf_device/` are the
> canonical data layer for Extreme switch port monitoring under Zabbix and
> continue to be developed here.
>
> The **`switchports/`, `portdetail/`, and `pf_device/` widgets** still
> install and run as standalone Zabbix 7.x dashboard widgets. New visual
> work and integration with the unified Switches / Port Detail dashboards
> now lives in
> [`jerahl/ZabbixCustomDashboard`](https://github.com/jerahl/ZabbixCustomDashboard)
> (the `tcs_dashboard` module). That module lifts the templates + the
> PHP API client from this repo and reuses them as its switches data
> layer — see its `Project_Plan_v1_0.html` for the integration plan.
>
> tl;dr: keep this repo for the template additions and the PF client,
> look at `tcs_dashboard` for the next-gen UI.
```

---

## `jerahl/ZabbixExtremeIQ` — README banner

```markdown
> ### Status note (May 2026)
>
> The **Extreme Cloud IQ HTTP-API templates** in `templates/` and
> **`XIQClient.php`** (the XIQ Cloud API bridge) are the canonical data
> layer for Extreme AP monitoring under Zabbix and continue to be developed
> here.
>
> The **`apdetail/` and `xiq_ap_status/` widgets** still install and run as
> standalone Zabbix 7.x dashboard widgets. New visual work and integration
> with the unified AP Detail dashboard now lives in
> [`jerahl/ZabbixCustomDashboard`](https://github.com/jerahl/ZabbixCustomDashboard)
> (the `tcs_dashboard` module). That module lifts the XIQ template and
> `XIQClient.php` from this repo and reuses them as its wireless data
> layer — see its `Project_Plan_v1_0.html` for the integration plan.
>
> tl;dr: keep this repo for the XIQ template + API client, look at
> `tcs_dashboard` for the next-gen UI.
```
