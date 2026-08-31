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
