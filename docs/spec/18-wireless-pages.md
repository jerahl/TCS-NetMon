# Spec 18 — XIQ and Wireless pages

**Status:** BUILT 2026-08-31 (navigator, site grid, per-radio counts)
**Scope:** `#/xiq`, `#/wireless`, `#/ap/:id` and the wireless API behind them.
**Relates to:** spec 15 §2 (XIQ · Status — NEAR) and §2·3 (Wireless APs —
BEHIND, "the largest single item in this spec"), spec 15 Q1 and Q6, spec 17
(site attribution, a prerequisite for the site grid).

---

## 1. What was wrong

Three defects, in descending order of how much they cost an operator:

1. **`#/xiq` and `#/wireless` rendered the same component.** `main.jsx:68-69`
   pointed both routes at `XiqPage`, so the app had two nav entries for one
   page — and the AP detail at `#/ap/:id` had **no path into it at all**. The
   only way to reach an AP was to find it in a flat 783-row table.
2. **No APs-by-site grid**, the ZCD component spec 15 lists first. It was not
   buildable before today: 782 of 783 APs read site `Unassigned` (spec 17).
3. **`ap_radios.clients` was NULL on all 1,574 rows**, so AP Detail's radio
   table read "—" in every row of every AP.

## 2. What was built

### 2.1 `#/wireless` is now the AP Navigator

Per-site collapsible groups with down-counts, a Problems-only toggle, a text
filter, and the AP detail in the right pane — deliberately the *same* idiom as
the Switches navigator (same grouping, same `localStorage` collapse memory, same
"a collapsed group still confesses its problems" rule from §4.5) rather than a
second idiom for the same job. `#/wireless/:id` selects an AP; `#/ap/:id` still
works standalone.

**This answers spec 15 Q1** — build the navigator rather than collapse the two
nav entries. The division of labour is now explicit and cross-linked: `#/xiq` is
the fleet dashboard (KPIs, per-site health, SSIDs, firmware), `#/wireless` is
per-AP drill-down.

### 2.2 APs-by-site grid on `#/xiq`

Tiles tinted by worst status, `All / Issues / Healthy` filter, click-to-filter
into the AP table. A pure client-side roll-up of `/api/wireless/aps` — no new
endpoint. `unknown` is never folded into `ok`: no reading is not a good reading.

Only possible because spec 17 landed hours earlier. It is the first visible
payoff of that work and a concrete instance of spec 16 C1's point — several
"missing" components are starved, not absent.

### 2.3 Per-radio client counts, derived not stored

`ap_radios.clients` stayed NULL because XIQ's `XiqRadio.clients` is an array of
*SSID descriptors*, and `len()` would have stamped a plausible fabrication onto
every radio in the fleet (see `build_radio_rows`). The real association is on
the client side: `/clients/active` returns `interface_name`, where `wifi0.3`
names radio `wifi0` and `1:51` is a switch slot:port.

Migration `021` adds `wireless_clients.radio`; `_radio_name()` parses only the
radio form, leaving wired clients NULL — "not on a radio" is a fact, not a gap.
The count is then rolled up **at read time** in `/api/wireless/aps/{id}`, the
rule `ssids` already follows. `ap_radios.clients` is left unwritten rather than
back-filled, because the column has no truthful source.

Result: 874 of 1,574 radios report a real client count; the remaining 700
genuinely have none and report `0`, which is a different answer from "unknown".

## 3. What cannot be built, and why

Spec 15 §2 estimated the XIQ page at "1.5–2 wk (channel heatmap needs per-radio
CCA from the 10.2 cycles)". **That data does not exist**, and no amount of
collector work produces it. `GET /devices/radio-information` on this tenant
returns exactly nine fields, confirmed live 2026-08-31:

```
channel_number  channel_width  clients  frequency  mac_address
mode            name           power    wlans
```

There is no utilization, CCA, noise, or airtime field anywhere in the payload.
Consequently:

| ZCD component | Status | Reason |
|---|---|---|
| 5 GHz channel-utilisation heatmap | **Not buildable** | no CCA/utilization from XIQ |
| RF Health Score | **Not buildable** | ZCD derives it from utilization; ZCD's own page reads 0 |
| AP Device Health dials (CPU/mem) | **Not buildable** | `cpu_pct`/`mem_pct` 0/783 — not in the payload |
| Connectivity Issues / Packet Loss / Live Telemetry | **Not buildable** | ZCD sources these from Zabbix items, which NetMon is replacing; its own panels read "no history" |

`ap_radios.util_pct` and `noise_dbm` therefore stay NULL columns with no writer.
They are kept rather than dropped because a future source (SNMP against the AP,
or an XIQ API revision) would fill them; the API returns them and the UI renders
"—", which is honest.

**Spec 15's XIQ estimate should be reduced accordingly** — the remaining
buildable gaps are the SSID table (exists), top-client-APs, and the firmware
dial as a dial, not the two components that dominated the estimate.

Two fields the probe *did* surface and that are worth using later: `mode`
(`_11ax_5g` — the radio's PHY generation) and the client-side `mac_protocol`,
which together give ZCD's ax/ac/legacy client split honestly. Not built here.

## 4. Still open

- **Wired clients in `wireless_clients`** (spec 15 §2): 4,526 of 7,209 rows are
  `radio_type = 3` (WIRED). The band tile lists them on purpose so it agrees
  with the client count beside it, but whether they belong in a table called
  `wireless_clients` is still an owner question.
- **Identity on the glass** (spec 15 §3.3): AP Detail's client table shows
  `username` alongside MAC, IP and hostname; 3,510 rows carry one. Unchanged by
  this work and still undecided.
- **AP Detail tab set** (spec 15 Q6): the detail pane is still one scroll, not
  tabs. With four of ZCD's nine tabs unbuildable (§3), the realistic target is
  ~5 tabs — Overview, Radios, Clients, Events, Configuration.
- Top-client-APs panel and the firmware compliance dial.

## 5. Reversibility

Migration `021` has a rollback note (`DROP COLUMN radio`); nothing writes
`ap_radios.clients`, so dropping it returns AP Detail to "—" exactly as before.
The page changes are frontend-only and revert with the commit. No collector
interval, rate budget, or XIQ call count changed — `interface_name` rides on the
`/clients/active` fetch that already ran every cycle.

---

# Addendum — ZCD design system ported (2026-08-31)

**Owner ask:** *"look in the repo reference/assets and apply the styles and
layout EXACTLY."*

## Base stylesheet

`reference/assets/styles.css` is now the base of `frontend/src/styles.css`,
**byte-identical**, between the `PORT BEGINS` / `PORT ENDS` markers — verified
programmatically (31,945 bytes, exact match), so a future ZCD change can be
re-applied as a diff rather than re-read. That brings the full token set (4-step
background ramp, 4 text levels, per-source brand colours, semantic scale, 3
radii, Inter/JetBrains Mono stacks), the 13px body, the 220px sidebar grid, and
ZCD's card/tab/badge/topbar rules.

Ordering matters: NetMon's own component CSS follows the port, so anything it
redefines silently wins. Four selectors did — `.dot`, `.tabs`, `.tab`,
`.src-badge` — and were removed so the ported rules apply. A comment at the end
of the file records the hazard for future additions.

## Layout

- `.app` is now ZCD's grid (`220px 1fr`, `56px` collapsed) instead of a flex
  row. The collapse class sits on `.app`, so the state moved from `Nav` up to
  `App` — the grid template is an ancestor property.
- Added the `.main` wrapper and **the topbar NetMon never had**: breadcrumb
  (`Tuscaloosa City Schools / Operations / <page>`), search, reload.
- `Card` now emits ZCD's `.card-h > h3` + `.card-b`. This was mandatory, not
  cosmetic: the ported `.card` puts its padding on `.card-b`, so leaving the old
  `.card-body` markup would have rendered every card edge-to-edge. The kicker
  maps onto `.h-meta`, which ZCD already defines for that purpose.

## The one deviation, and why it is not visual

ZCD's PHP views load Inter and JetBrains Mono from `fonts.googleapis.com`
(`views/*.view.php:27`). NetMon does **not** add that `<link>` — CLAUDE.md §3
forbids CDN loads in the bundle, and spec 16 C6 rejects putting an internet
round-trip in front of a NOC dashboard's legibility. The `--sans`/`--mono`
stacks are ZCD's own, unmodified, so where the faces are installed the rendering
is identical and elsewhere it falls back exactly as ZCD's stacks specify.
Self-hosted woff2 is the follow-up that closes the gap completely.

## Per-page stylesheets (2026-08-31, second pass)

All eight relevant page stylesheets are now ported **verbatim** as well —
`global.css`, `switches.css`, `events.css`, `problems.css`, `surveillance.css`,
`voip.css`, `xiq.css`, `packetfence.css` — asserted programmatically (each file's
full text is present in the bundle). `fortigate.css`, `xdr.css` and `servers.css`
are deliberately excluded: those pages are deferred (D1), dropped (D8) and
retired (D2), so their rules would style markup NetMon will never render.

**The measurement that shaped this work:** ZCD's per-page class vocabularies
overlap NetMon's markup by **0–8%** (global 8%, switches 4%, events 3%,
problems 2%, surveillance 0%, voip 0%, xiq 0%, packetfence 1%). They share
almost nothing with each other either — the only class in three or more page
files is `.app`. So a page does not *look* ported when its CSS lands; it looks
ported when its JSX is rewritten onto `sev-cell`/`sys-card`/`swport-*`/`evt-*`.
Shipping the CSS is step one of two, per page.

### SPA bundling vs ZCD's per-page loads

ZCD is a multi-page PHP module: each view loads `styles.css` plus exactly one
page stylesheet. NetMon ships one bundle, so all of them load everywhere. That
was checked rather than assumed: every rule is namespaced to its own page's
vocabulary, and the only selectors touching shared names are
attribute-qualified — `.app[data-density="dense"]`, `.app[data-pf="1"]`,
`.body.with-tweaks` — which NetMon never sets, so they are inert until a page
opts in. (`data-pf="1"` is worth opting into on `#/nac`: it retints the active
tab and nav marker PacketFence amber.)

### Markup converted so far

| Page | Stylesheet | Markup |
|---|---|---|
| Global | ✅ ported | ✅ **converted** — severity strip, system cards, sites heatmap + legend + seg-toggle, hotspots, triggers |
| XIQ · Status | ✅ ported | ✅ **converted** — 6-cell `xiq-kpi` strip, `sites-grid` AP tiles |
| Wireless APs | (uses switches.css) | ✅ **converted** — same `host-nav` as Switches |
| Switches | ✅ ported | ✅ **converted** — host navigator, `swstat-strip`, `swport-head`/`-title`/`-legend`, `pd-grid` |
| Events | ✅ ported | ⏳ |
| Problems | ✅ ported | ⏳ |
| Surveillance | ✅ ported | ⏳ |
| VoIP | ✅ ported | ⏳ |
| NAC (PacketFence) | ✅ ported | ⏳ |

Two ZCD components became buildable only because earlier work landed, and both
are now on the Global page: the **severity strip** (spec 14 §3 costed it as a
severity model plus a new endpoint — spec 16 C1 was right that `/api/summary`
already returned `severity` and `alerts.acked/unacked` and the page simply never
read them) and **Top Problem Hotspots** (impossible until spec 17, because every
site's `problems` was 0 while alerts carried `Unassigned`).

Two ZCD elements are deliberately not reproduced: the five-level
Disaster/High/Warning/Info ladder (NetMon's enum is four values by decision —
spec 16 C4) and the per-site **SLA %**, which is hardcoded in the reference
(`ActionGlobalData.php:481` sets it null; the bridge substitutes `target ?? 100`
— spec 16 C2). The tile shows device counts instead: omitted, not defaulted.

**Verify visually before merging.** 458 backend tests pass and the bundle builds
and serves, but there is no frontend test suite here — nothing in CI can catch a
layout regression on 13 pages, and this change touches every one of them.

### Switches (2026-09-01)

The largest page, and cheaper than its 1,374 lines of CSS suggested — because
**phase 10.1 had already built the faceplate against ZCD's own class names**
(`.port > .pn/.body/.led-link/.led-speed`, `.swport-grid`, `.swport-member`),
and the port-detail rows already emitted `.pd-lbl`/`.pd-mid`/`.pd-val`. Those
needed no markup change at all. What they needed was for NetMon's *local* copies
of those rules to be deleted, since `switches.css` is appended after them and the
local geometry was quietly winning — the same precedence trap as `.dot`/`.tabs`
in the base port.

Converted markup:

* **Host navigator** — `sw-nav-*` → `host-nav-section`/`-site`/`-children`/
  `-host`, with ZCD's `.caret`/`.site-name`/`.site-prob`/`.h-id` children.
  Collapse is now a class on `.host-nav-children` (ZCD's `.hidden`) rather than
  conditional rendering, which is what its transition expects. The Wireless AP
  navigator moved with it — it shared the deleted `sw-nav-*` rules, and two
  navigators for the same job should not diverge.
* **KPI strip** — `.stat-row` → ZCD's 6-cell `.swstat-strip`. NetMon had seven
  values; CPU and temperature share a cell to keep the grid at six. Three cells
  still read "—" (PoE draw/budget, CPU, temp) because those come from the
  deferred 10.1 sweeps — the strip says so rather than showing 0.
* **Header** — `.swport-head` > `.swport-title` > `.id` with `.host-meta` pills.
* **Legend** — ZCD styles a bare `.swatch`/`.dot-led` and takes the colour from
  the caller, so NetMon's `sw-up`/`sw-down`/`poe-led`/`err-led` variant classes
  are gone and the colours are passed inline.
* **Port detail** — `.pd-cols` → ZCD's `.pd-grid`.

Left alone deliberately: the eight tabs keep NetMon's names (Ports · FDB ·
Topology · VLANs · Stack · PoE · Triggers · Backups). ZCD's set is Port Status ·
Topology · Stack Health · VLAN · PoE Budget · XIQ · CLI · Config Backups — the
difference is real scope, not styling. NetMon has no per-switch XIQ tab, its CLI
equivalent is the SSHEASY button, and it adds FDB and Triggers, which ZCD has no
counterpart for.
