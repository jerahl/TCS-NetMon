# Spec 15 — Page-by-page parity with ZabbixCustomDashboard

**Status:** DRAFT — awaiting owner sign-off
**Scope:** every page in the ZCD sidebar **except ZBX · Status**, dropped from
scope at the owner's direction — D2 already retired it and NetMon Status stands
on its own, so there is no parity question to answer. Numbering below still
follows the ZCD sidebar order, so #7 is absent by design.
Companion to **spec 14** (Global page), which stays the reference for the
design-token port and the shell.
**Observed:** all 21 ZCD nav entries and all 15 NetMon routes, 2026-08-31, 1600×1200.
**Relates to:** spec 11 §4 (parity map), spec 10.0–10.6, spec 13, gates D1–D10.

---

## 0. Read this first — four findings that change the plan

### 0.1 Nine of ZCD's pages are labelled DEMO in production

Cortex XDR, all five PacketFence pages, and Recording Server Detail carry a red
banner: *"This data is for Demo only and not live… part of the roadmap."* Spec 11
already recorded PF and XDR as mock; **Recording Server Detail is a third one it
doesn't flag.**

Consequence: for those pages "parity" cannot mean matching behaviour, because
there is no behaviour. It means *borrowing the layout* and filling it with the
live data NetMon already holds. On NAC in particular NetMon is not behind — it is
already the only live version that exists.

### 0.2 Several ZCD pages are rich in layout and currently reading zero

Not mock — genuinely wired, genuinely empty right now:

| ZCD page | What it reads today |
|---|---|
| XIQ · Status | 0 APs / 0 sites / 0 clients / RF health 0; *"Loading AP fleet from Zabbix…"* never resolves |
| Switches (default host ARC-MDF) | 0 ports up/down/total, `Not Present (32)`, `Searching (137)`, CPU 0%, 0°C |
| FortiGate | Model —, FortiOS —, sessions 0, throughput 0.00 Gbps, 0 of 0 interfaces up |
| Surveillance NOC | 0/44 recording servers online, 0/2,662 cameras, storage 0.0/0 TB, retention 0 days, sites listed as **raw GUIDs** |
| Cameras | *"CAMERA NOT FOUND"* without a host id — it is a detail page, not a list |

So the parity bar is lower than the screenshots imply. Copy the **layout** (it is
good, and it is the muscle memory), don't inherit the **promise**. Several of
these NetMon already beats on live data: 737/783 APs, 158 switches with real port
faceplates, 2,655 cameras.

### 0.3 NetMon is already ahead in five places

NAC (live, five tabs, 41,878 nodes vs ZCD's mock 12,847) · Problems (Ack /
Assign / Suppress 1h vs ZCD's ack-only) · Events (source + dimension + type
filters) · Site Map (ZCD has nothing comparable) · and **honest empty
states** — NetMon's VoIP page says *"No trunks cached — the 3CX collector hasn't
populated the trunk table"* where ZCD's shows a confident `0`. That honesty
convention should be kept and spread, not designed away in the name of parity.

### 0.4 One data defect breaks five pages at once

**Site attribution is largely missing.** On `#/xiq`, all but one of 783 APs read
site `Unassigned`. On Events and Problems the SITE / LOCATION column prints
`Wireless APs` — a device *group* leaking into the site field. Cameras (2,655)
carry no site at all. Site device counts on Global run 1–18 where ZCD's run
2–32.

That single defect degrades Global's site health map, the Problems site mosaic,
the Events site filter, the Site Map roll-up, and both host navigators —
simultaneously. **It is the highest-leverage fix in the program: one job, five
payoffs.** It should land before any of the per-page visual work.

---

## 1. Summary matrix

Verdict key: **AHEAD** · **NEAR** (small visual/functional delta) · **BEHIND** ·
**RETIRE** · **NEW**

| # | ZCD page | NetMon route | Verdict | Headline gap |
|---|---|---|---|---|
| 1 | Global Dashboard | `#/` | BEHIND | see spec 14 |
| 2 | XIQ · Status | `#/xiq` | NEAR | ZCD adds APs-by-site grid, SSID table, channel heatmap, RF health, firmware dial. NetMon has live data ZCD doesn't |
| 3 | Wireless APs (AP Detail) | `#/wireless` → **same page as `#/xiq`** | BEHIND | two nav items, one page. No AP navigator, no 9-tab detail |
| 4 | Switches | `#/switches` | NEAR | 8 tabs both sides; NetMon missing PoE / CPU / temp sweeps; ZCD's XIQ + CLI tabs vs NetMon's FDB + Triggers |
| 5 | Firewall (FortiGate) | `#/fortigate` (deep-link) | RETIRE→D1 | deferred to 11.x by decision; ZCD's own page reads zeros |
| 6 | Servers | `#/servers` (deep-link) | RETIRE | D2 — stays Zabbix's domain |
| 8 | VoIP · 3CX | `#/voip` | BEHIND | **3CX collector is not in the supervised task set at all** |
| 9 | Cortex XDR | — | RETIRE | D8; ZCD's is DEMO |
| 10 | Problems | `#/problems` | BEHIND (visuals) / AHEAD (actions) | no severity strip, no site×category mosaic, no constellation, no grouping toggles |
| 11 | Events Console | `#/events` | NEAR | no ack cell, no saved views, no tags, no bulk ack, no time-range picker |
| 12 | Connected Devices | `#/nac` tab 1 | AHEAD | ZCD is DEMO |
| 13 | NAC Policies | `#/nac` tab 4 | BEHIND | ZCD mock has auth-source health + role→VLAN→ACL chain; NetMon tab unverified |
| 14 | User Sessions | `#/nac` tab 2 | AHEAD | ZCD is DEMO |
| 15 | Quarantine | `#/nac` tab 3 | BEHIND | ZCD mock has per-endpoint isolation cards + violation catalogue + remediation queue |
| 16 | PF · Cluster Status | `#/nac` tab 5 | BEHIND | ZCD mock has per-node service matrix + Galera lag + queue depths |
| 17 | NOC Overview | `#/surveillance` tab 1 | BEHIND | 3-row table vs 7-tab NOC wall — but ZCD's is reading zeros |
| 18 | Cameras | `#/surveillance` tab 2 | BEHIND | ZCD's nav entry is a broken detail page; no camera detail in NetMon |
| 19 | Recording Servers | `#/surveillance` tab 3 | BEHIND | ZCD's detail page is DEMO; 6 tabs + channel grid |
| 20 | Evidence Lock | (none) | BEHIND | no NetMon tab |
| 21 | VMS Alarms | (none) | BLOCKED→D5 | approved, needs WebSocket wiring |
| — | *(no ZCD equivalent)* | `#/map` | NEW | **basemap watermarked "API KEY REQUIRED"**; uses a different shell from the rest of the app |
| — | *(no ZCD equivalent)* | `#/registry`, `#/settings` | NEW | admin surfaces ZCD never had |

---

## 2. Page detail

### 2 · XIQ · Status — NEAR

**ZCD:** 5-cell KPI strip (Access Points / Online / Offline-Critical / Connected
Clients with ax·ac·legacy split / RF Health Score vs target ≥ 90) · APs-by-site
tinted grid with All / Issues / Healthy filter and severity legend · Broadcast
SSIDs table (SSID, auth, VLAN, clients, assoc success, Gbps) with WLAN-config
deep link · Top Client APs · 5 GHz channel-utilisation heatmap (top 8 sites, CCA
mean, per-channel columns 36→161) · Firmware compliance dial.

**NetMon:** 5 KPI cells (737/783 connected · 45 down · 7,347 clients · band split
5 GHz 2,963 / wired 4,384 · 86% on 10.7.5.2) · site + text filter · flat 783-row
table (AP, site, model, IP, firmware, clients, uptime, policy).

**Gaps:** APs-by-site grid, SSID table, top-client-APs, channel heatmap, RF
health score, firmware dial rendered as a dial.
**Data:** 782 of 783 APs read site `Unassigned` (§0.4). Band split is labelled
`5: 2963 · wired: 4384` — a wireless page reporting *wired* clients in the band
breakdown needs checking; ZCD splits by radio generation instead.
**Note:** NetMon's data here is live and ZCD's is not. This is a layout-borrow.
**Est.** 1.5–2 wk (channel heatmap needs per-radio CCA from the 10.2 cycles).

### 3 · Wireless APs / AP Detail — BEHIND

**ZCD:** the deepest page in the app. AP Navigator (725 APs, filter, All /
Problems 23, per-site expanders with down-counts) · header with reachability,
uptime, XIQ · SNMP · PING chips, PacketFence link, and **Reboot AP / Cycle PoE /
Reevaluate access** buttons · **9 tabs**: Overview, Wireless, Wired, Clients,
Events, Alerts, Graphs, Latest Data, Configuration · Device Health dials ·
Connectivity Issues (association / authentication / network failures) · Packet
Loss · Live Telemetry grid (uplink in/out, latency, pkt loss, noise 2.4/5, TX
power 2.4/5) with Grafana deep-link · System + Network information panels.

**NetMon:** `#/wireless` renders the **same fleet table as `#/xiq`**. AP detail
exists at `#/ap/:id` but has no nav path and no navigator.

**Gaps:** everything above except the write actions (built 2026-07-29 per D4).
**Also:** ZCD's own telemetry panels all read *"no history"* — the 24h ring
buffer (10.6) can fill NetMon's equivalents, which ZCD cannot.
**Decision needed:** two nav entries pointing at one page is worse than one
entry. Either build the navigator + detail landing, or collapse `#/wireless`
into `#/xiq` until it exists.
**Est.** 2.5–3 wk — the largest single item in this spec.

### 4 · Switches — NEAR

**ZCD tabs:** Port Status · Topology · Stack Health · VLAN · PoE Budget · XIQ ·
CLI · Config Backups. Host Navigator (154 switches, per-site problem counts) ·
5-cell KPI strip · port grid with Up/Down/Disabled/Not-Present/PoE-On/Searching
legend and speed distribution · CPU/MEM/temp/PSU/FAN chips · Port Detail with a
PacketFence pane · Uplinks Top Talkers.

**NetMon tabs:** Ports · FDB · Topology · VLANs · Stack · PoE · Triggers ·
Backups. Navigator (158 switches, 25 sites, collapse-all) · 7-cell KPI strip ·
faceplate with SFP marks and per-member up/down · Port Detail · Top Talkers with
util and error deltas · **SSH button** (ssheasy — ZCD's CLI tab equivalent) ·
24h throughput sparkline.

**Gaps:** ZCD's XIQ tab (per-switch cloud view) has no NetMon counterpart;
NetMon's KPI cells read `—` for **PoE draw / budget, CPU (max slot), TEMP (max
slot)** — the deferred 10.1 sweeps (PoE, ENTITY, fans/PSUs).
**Data:** navigator's first group is `UNASSIGNED · 1 down · 2` (§0.4).
`snmp_inventory` shows **60 task failures** on NetMon Status, and its sweep
duration is 587 s — worth a look before adding sweeps to it.
**Verdict:** functionally the closest page in the app. Finish the three deferred
sweeps and it is done.
**Est.** 1–1.5 wk.

### 5 · Firewall (FortiGate) — RETIRE → D1

**ZCD:** 6-cell KPI strip (sessions, new/sec, throughput, CPU 15m peak, threats
blocked 24h, VPN status) · WAN throughput 24h · Session activity 24h · Device
health dials · Interfaces table · IPsec site-to-site.
**NetMon:** greyed nav entry, Zabbix deep-link (shipped 10.0).
**Recommendation:** hold D1 as decided — defer to 11.x. ZCD's own page reads
zeros for model, FortiOS, HA, uptime and every interface, so there is little to
be behind. If it is pulled forward, the 10.1 `snmpbulkwalk` pattern makes it
cheap.
**Est.** 2 wk if pulled forward; 0 now.

### 6 · Servers — RETIRE (confirmed)

**ZCD:** Server Navigator (29 hosts, 2 sites), 9 tabs, hardware/OS/network
panels, RDP + SSH launchers, Zabbix template list, live Problems pane.
**NetMon:** greyed deep-link.
**Recommendation:** D2 stands. Note the page is *not* mock — it is the most
genuinely live page in ZCD, which is exactly why servers should stay in Zabbix.

### 8 · VoIP · 3CX — BEHIND

**ZCD:** 6-cell strip (active calls x/256, calls today, registered phones
1,324/1,437 with unreg count, avg MOS 1h, ASR, SIP trunks 5/6 with degraded
flag) · Concurrent calls 24h chart with peak/ACD/ASR · Call quality 24h (MOS,
jitter, packet loss, round-trip, each against a target) · **Active Calls · Live**
table with direction, both parties, duration, signal bars.
**NetMon:** 3 cells all `0/0`, 24h trends flat, and two honest empty states.

**Gaps:** all of the above.
**Data (the blocker):** NetMon Status lists eight collectors — engine, history,
milestone, packetfence, poller_ping, poller_snmp, rconfig, snmp_inventory.
**There is no `threecx` row.** The collector isn't merely un-run, it is not in
the supervised set. Spec 10.4's "wire the existing dead `system_status()`" is the
task, and spec Q4 (whether v20 exposes a Users endpoint, or ODBC is needed) is
still open — NetMon's own empty state says so.
**Design note:** ZCD's Active Calls table shows caller names and outside numbers
on a page that could sit on a wall display. Decide deliberately whether NetMon
reproduces that or masks it (see §3.3).
**Est.** 2–2.5 wk, most of it collector work, and gated on spec Q4.

### 10 · Problems — BEHIND on visuals, AHEAD on actions

**ZCD:** header stats (Sources, Active 64, Open 64, Acknowledged 0, Worst High) ·
5-cell severity strip each with a 6h sparkbar · **Sites × Categories mosaic**
(11 sites × 6 device classes, dot = problem count, colour = worst severity) ·
**Constellation** scatter (site on x, age on y) · view toggles Mosaic /
Constellation / Matrix-only · severity filter chips · grouping toggles Severity /
Site / Category / Source / Flat · Active Problems tiles grouped by severity.

**NetMon:** Location + Type dropdowns, flat 2,742-row table (severity, device,
location, type, rule, opened, owner, ack) with **Ack / Assign / Suppress 1h** per
row.

**Gaps:** severity strip, mosaic, constellation, view + grouping toggles,
header stat line.
**Ahead:** ZCD offers ack only; NetMon offers ack, assign and suppress.
**Data:** 2,742 open of which ~2,659 are the camera `device_source_down` /
`source_blind` class — the same storm spec 14 D-3 covers. A severity strip over
that is unreadable. Location column shows `Wireless APs` and `Unassigned`
(§0.4). The engine runs in `shadow`, so alert lifecycle needs confirming before
building a lifecycle UI.
**Est.** 2–2.5 wk, gated on the camera-noise decision.

### 11 · Events Console — NEAR

**ZCD:** header stats (in-window 463/463, Open 9, Acknowledged 0, MTTA/MTTR) ·
6-cell strip (All events, Disaster, High, Warning, Open·unack, Acknowledged) ·
Event volume 24h histogram with severity legend, peak and quietest buckets ·
filter bar: search, time range, severity, status, source, site, host group, tags
· **saved views** chips (Disaster+High open / Open·unack / Acknowledged /
Resolved 24h / Warning only) · table with row checkboxes, SEV, STATUS, TIME,
AGE, SRC, HOST, SITE, PROBLEM, TAGS.

**NetMon:** 5-cell strip (3,110 events 24h, 189 critical, 2,695 warning, 226 OK,
0 info) · events-per-hour bars · five filter dropdowns (severity, source, site,
type, dimension) + search · table (severity, time, age, source, device, site,
type, change).

**Gaps:** acknowledged cell, MTTA/MTTR, saved views, tags, row checkboxes + bulk
ack, explicit time-range picker, open/unack status column, histogram legend with
peak/quietest.
**Ahead:** source and dimension filters ZCD lacks.
**Data:** SITE column prints `Wireless APs` (§0.4).
**Est.** 1–1.5 wk. Best return per hour of any page in this spec.

### 12–16 · PacketFence (five ZCD pages → NetMon's five `#/nac` tabs)

All five ZCD pages are **DEMO**. NetMon's `#/nac` is live: 41,878 nodes, 16,451
registered, 25,427 unregistered, 0 pending, 20,745 online, auth-method split
(EAP 14,007 / Ethernet-NoEAP 5,843), and a node table with MAC, hostname, owner,
role, registration, IP, OS fingerprint, location, auth, last-seen.

| ZCD page | Layout worth borrowing | NetMon status |
|---|---|---|
| Connected Devices | 6-cell strip, endpoint-connections 24h histogram, **devices-by-role donut**, role/status filter chips, CSV export | AHEAD on data; wants the donut + chips + export |
| User Sessions | 6-cell strip by auth method, auth-method donut, **sessions-by-SSID stacked bar**, per-session duration bars, "Disconnect selected" | AHEAD on data; wants the two charts |
| Quarantine | per-endpoint isolation cards (site, port, VLAN, isolated-since, violation, recent-activity timeline, Release / Whitelist 24h / Open ticket), **Active Violations catalogue** with 24h hit counts, **Remediation queue** | tab unverified; this is the richest PF layout and has no NetMon analogue |
| NAC Policies | 6-cell strip, **Authentication Sources health list** (per-source auth/24h + OK/warn), **Roles → VLAN → ACL → bandwidth mapping** | tab unverified |
| PF · Cluster Status | 6-cell strip, **per-node cards** (primary/secondary, CPU/mem/disk, RADIUS req/s, DB conn, auth latency, per-service chips, pfacct queue), performance 60m charts, **Galera replication** panel | tab unverified |

**Recommendation:** treat PF as **layout-import, not data-work** — NetMon has the
data. Priority order: Quarantine (highest operational value), Cluster Status,
NAC Policies, then the two charts on the tabs that already work.
**Est.** 2.5–3 wk for all five tabs.
**Data note:** ZCD's mock numbers are internally consistent fiction (173
unregistered of 12,847). NetMon's live 25,427 unregistered of 41,878 is a real
number that will surprise people — worth confirming the definition of
"unregistered" before it goes on a dashboard.

### 17–21 · Surveillance (five ZCD nav entries → one 7-tab ZCD page)

ZCD's Cameras, Recording Servers, Evidence Lock and VMS Alarms nav entries are
**tabs of `tcs.surveillance.view`**, plus two standalone detail pages
(`tcs.camera.view`, `tcs.server.view`).

**ZCD NOC Overview:** 7 tabs (Overview, Sites 26, Cameras, Recording Servers 44,
Alarms 1, Storage, Evidence Lock) · 4-cell strip (cameras online, recording
servers, active VMS alarms, Smart Client sessions) · XProtect panel (device
licences, mgmt server, recording/failover/mobile servers, retention, evidence
lock) · Live Ingress 24h with storage-write / avg-CPU / cameras-online /
alarms-per-hour · Sites list with drill-down · Recording Servers cards with
CPU/mem/disk and RAID badges.
**Reading today:** 0/44 servers online, 0/0 cameras, 0.0/0 TB, retention 0 days,
**sites listed as raw GUIDs**.

**ZCD Camera nav entry:** *"CAMERA NOT FOUND"* — a detail page with no list.
**ZCD Recording Server Detail:** DEMO. 6 tabs (Overview, Channels, Storage,
Network, Events, Configuration) · 6-cell strip · resource utilisation 24h ·
server health dials · **224-channel recording grid**.

**NetMon:** 4 tabs (NOC Overview, Cameras, Recording Servers, Storage) · 5 cells
(2,655 cameras / 2,659 recording / 0 not recording / 22-22 servers up / storage
`—`) · a 3-row XProtect table · an Alarms panel that explains it needs D5.

**Gaps:** Sites tab, Alarms tab (D5 approved, needs wiring), Evidence Lock tab,
live-ingress panel, recording-server cards and detail, camera detail, channel
grid.
**Data:** `2,659 recording / 2,655 total` — recording exceeds total. Storage
`0/0 GB` (the known `/storages` HTTP 400). **22** recording servers where Zabbix
says 8 and ZCD says 44 — three sources, three answers. 2,655 cameras with no
`mgmt_ip` and no site (§0.4, and the D7/D10 prerequisite).
**Recommendation:** this is the page where NetMon's advantage is largest and its
data is weakest. Fix the counts before adding tabs.
**Est.** 3–3.5 wk including the D5 wiring.

### — · Site Map — NEW (NetMon-only)

Full-bleed Leaflet map, 21 up / 2 degraded / 0 down, fiber links rendered by
kind and utilisation, animated flow, event feed, site list with codes and device
counts, DARK / NOC MODE / EDIT MAP controls, legend.

**Two issues:**
1. **The basemap is watermarked "API KEY REQUIRED"** across the entire tile
   layer (CARTO key missing or expired). On the one page ZCD can't match, this
   is the first thing a visitor sees.
2. It uses **its own shell** — own topbar, own control styling — unlike every
   other page. When the design tokens land (spec 14 G0), this page should adopt
   them rather than stay a separate visual language.

**Est.** 0.5 wk (key + token adoption).

---

## 3. Cross-cutting items

### 3.1 Corrections to spec 11's open threads

- **`[poller] enabled` is on.** `poller_ping` reports ok with 935 records,
  `poller_snmp` 158. Spec 11's next-session note lists this as an open question;
  it is answered. But 935 of 3,624 devices means APs and cameras are largely
  outside the sweep — the tiebreaker only tiebreaks for switches.
- **The alert engine runs in `shadow`**, not disabled. Spec 11 records
  `[engine] enabled = false`. Confirm which, because the phantom-stale-alerts
  behaviour depends on it.
- **`rconfig` reports ok with 0 records** — green and writing nothing, the spec 14
  D-2 finding, now confirmed from the heartbeat table rather than inferred from
  the card.
- **`snmp_inventory` has 60 task failures** and a 587 s sweep duration.
- **Recording Server Detail is a third DEMO page** spec 11's parity map doesn't
  mark as mock.

### 3.2 Where the work actually is

Roll-up of the per-page estimates, sorted by return per hour:

| Priority | Work | Est. | Why here |
|---|---|---|---|
| 1 | **Site attribution fix** | 1–1.5 wk | one job, five pages (§0.4) |
| 2 | 3CX collector into the supervised set | 2–2.5 wk | a whole page reads zero; gated on spec Q4 |
| 3 | Surveillance count reconciliation | 1 wk | three sources give three server counts |
| 4 | Events Console finish | 1–1.5 wk | closest page to done |
| 5 | Switches deferred sweeps (PoE, ENTITY, fans/PSU) | 1–1.5 wk | three `—` cells on the strongest page |
| 6 | PacketFence five-tab layout import | 2.5–3 wk | data exists; pure frontend |
| 7 | Problems visual console | 2–2.5 wk | gated on camera-noise decision |
| 8 | AP navigator + detail | 2.5–3 wk | largest single item |
| 9 | Surveillance tabs + D5 alarms | 3–3.5 wk | after the counts are true |
| 10 | XIQ page enrichment | 1.5–2 wk | heatmap needs 10.2 radio data |
| 11 | Site Map key + token adoption | 0.5 wk | cheap, visible |
| — | FortiGate (D1) | 2 wk | deferred by decision |

**≈19–24 weeks** on top of spec 14's 10–13, at 6–10 hrs/week. Sequenced against
spec 14: **G0 (tokens) and G1 (shell) come first and are shared**; item 1 above
belongs inside spec 14's **G2 data-truth gate**, not after it.

### 3.3 A decision that isn't in any spec yet: identity on the glass

NetMon's live NAC tabs display student and staff usernames and owner names next
to MAC, IP, OS and physical switch port. ZCD's VoIP page displays caller names
and outside numbers. Either page could plausibly end up on a wall display or a
shared-office monitor.

This is worth deciding on purpose rather than inheriting: mask identity by
default and reveal on operator/admin role, or accept it and treat those pages as
non-displayable. NetMon already has the role plumbing (SAML claims →
operator/admin, `can_edit` on `/api/meta`), so the enforcement point exists. It
costs little now and is awkward to retrofit after the pages are in use.

---

## 4. Open questions for the owner

1. **`#/xiq` and `#/wireless` render the same page.** Collapse to one nav entry
   now, or leave both pointing at the fleet table until the AP navigator lands?
2. **Camera noise** (spec 14 D-3, repeated here because it gates Problems as
   well as Global): populate camera addresses, or suppress `source_blind` for the
   camera device class?
3. **Which recording-server count is right — 8, 22, or 44?** Everything on the
   surveillance pages depends on the answer.
4. **Import the PF mock layouts, or design NetMon's own?** The mocks are good and
   already shaped for this data. Importing is faster and looks familiar;
   designing fresh avoids inheriting a fiction's information architecture.
5. **Identity masking** (§3.3) — decide before the pages get used, not after.
6. **Does `#/wireless`'s AP detail get ZCD's 9 tabs, or a shorter set?** Latest
   Data and Configuration are Zabbix-shaped and may not translate.
7. **Spec numbering:** this as spec 15 alongside spec 14, or both folded into a
   revision of spec 10.5?
