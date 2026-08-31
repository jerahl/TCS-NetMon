# Spec 16 — Source-read corrections to specs 14 and 15

**Status:** DRAFT — amends specs 14 and 15, which were written from the rendered
pages only.
**Sources read:** `jerahl/ZabbixCustomDashboard` @ main (376 commits, 218 files)
and `jerahl/TCS-NetMon` @ main, both pulled in full 2026-08-31.
**Why it exists:** four of specs 14/15's conclusions were wrong, and two of their
open questions are already answered in code. The revised estimate is materially
lower.

---

## 1. The headline correction

**Specs 14 and 15 priced Global parity as backend work. It is almost entirely
frontend work against an API that already returns the data.**

`/api/summary` already returns:

```
generated_at, fleet{total,up,down,unknown,blind,by_type},
severity{crit,warn,ok,unknown},          ← device worst-of roll-up
alerts{open,crit,warn,acked,unacked,assigned},
domains[]{key,label,status,blind,source,updated_at,headline,href,kpis[]}
```

`/api/sites` already returns, per site:

```
status, devices_total, devices_down, devices_degraded,
problems, worst_severity
```

`frontend/src/pages/global.jsx` renders six inventory tiles from `fleet` and
**never reads `summary.severity`** or `alerts.acked / unacked / assigned`. The
severity strip spec 14 §3 costed as a new endpoint plus a severity model is one
component swap over fields that are already in the payload.

`SiteRollup`'s docstring says it plainly: *"`problems`/`worst_severity` are the
Global-page site-tile additions (spec 10 §6 / phase 10.5)."* Built, shipped,
unrendered.

**Effect on spec 14:** G3 drops from 1.5–2 wk to ~0.5 wk. G4's headline and
deep-link work is already done (`global.jsx:115` renders `d.headline`;
`domains[].href` drives the card links). What remains in G4 is per-domain
sparklines and the icon/tint treatment.

---

## 2. Corrections, with evidence

### C1 — The site health map is not missing. It is starved.

Spec 14 §2 row 5 and spec 15 §0.4 called the site tiles a redesign job. They
aren't. `global.jsx:164` already does:

```jsx
{s.problems > 0 && (
  <div className="site-tile-prob" style={{ color: sevColor(s.worst_severity) }}>
    {s.problems} open
  </div>
)}
```

and `:159` already renders `devices_degraded` as "N switches down". The tiles
show only "N dev" **because every site's `problems` is 0** — the 2,742 open
alerts carry `Wireless APs` and `Unassigned` in the location field instead of a
curated site.

So the site-attribution fix doesn't merely *enable* the site map — it lights up
the tiles that are already written, with no frontend change. That promotes it
from "highest-leverage item" to **prerequisite**: several of spec 15's per-page
estimates assume building things that will simply start working.

### C2 — ZCD's SLA figure is fabricated. Don't port it.

Spec 14 §2 listed `SLA 100.00%` as a parity item and suggested computing it from
`state_events`. The first half was wrong:

- `actions/ActionGlobalData.php:481` — `$s['sla'] = null;` (unconditionally, for
  every site)
- `actions/ActionGlobalData.php:346` — `'sla' => ['value' => null, 'target' => 99.5]`
- `assets/global-bridge.jsx:50` — `sla: typeof s.sla === "number" ? s.sla : 100`
- `assets/global-bridge.jsx:57–58` — substitutes `target ?? 100` for the KPI

Every "SLA 100.00%" on the wall today is a hardcoded fallback. Nothing measures
availability anywhere in ZCD.

**Revised position:** NetMon *can* compute this honestly from `state_events`, and
should — but as a NetMon feature, not a parity requirement. Until it is
computed, the row is omitted, not defaulted. Copying the placeholder would
import the one genuinely misleading number on the reference dashboard.

### C3 — ZCD already solved the camera-flood problem, and its answer is a third option

Spec 14 D-3 offered two ways to handle the 2,659 source-blind cameras. ZCD hit
the identical problem and chose a third:

```php
// actions/ActionGlobalData.php:50
private const EXCLUDE_HOST_GROUPS = ['Discovered hosts/Milestone Cameras'];
```

with a comment that describes NetMon's symptom exactly — *"the discovered
Milestone camera hosts in particular flood the host-availability counters with
thousands of 'down' SNMP interfaces that operators monitor via the dedicated
Surveillance dashboard."* The cameras are dropped before anything downstream
sees them, and camera online/total is computed **separately** from a bit-summed
combined-status item (`-1` disabled / `0` OK / `1–7` fault combinations) so the
NVR tile still shows real numbers.

The same file carries `HEATMAP_EXCLUDE_HOSTS` and API-level filtering of
aggregator hosts (`XIQ_AP`) for the same reason: *"fleet-wide problems that would
otherwise dominate the 200-row budget and starve real per-host alerts."*

**Revised D-3, option (c) — recommended:** exclude the camera device class from
the fleet, severity and site roll-ups; keep it authoritative on the Surveillance
card and page, computed from Milestone's own state. Then populate camera
addresses later (the D7/D10 prerequisite) as an enhancement rather than a
prerequisite. This is cheaper than both original options and has a working
precedent in production.

### C4 — NetMon's severity model is already decided, documented, and not Zabbix's

Spec 14 open question #4 asked whether to adopt Zabbix's five levels.
`frontend/src/severity.js` answers it, with the reasoning in the file: the DB
enum is four (`crit / warn / ok / unknown`), deliberately collapsing
disaster+high into "Critical" and mapping `unknown` → "Info", *"a blast-radius
'Disaster' escalation is a later concern, not a DB change."*

**Revised G3:** build a **4-cell severity strip + Acknowledged + Devices-down**,
sourced from `summary.severity` and `summary.alerts`. Do not reopen the DB enum
for cosmetic parity with a five-level ladder. Question #4 is closed.

### C5 — Most of the primitives already exist

Spec 14 §3 listed 14 primitives to build. `frontend/src/primitives.jsx` already
exports `SourceBadge`, `Sparkline`, `Card`, `Stat`, `Freshness`, `Icon`, `Dot`,
`Badge`, `SevText`, `Loading`, `ErrorMsg`, `deviceHref` — and `Sparkline` already
degrades to an honest `—` under two points, while `Freshness` already implements
the staleness badging spec 14 G6 listed as future work.

ZCD's `assets/primitives.jsx` exports only seven: `SourceBadge`, `Sparkline`,
`Ring`, `StatusDot`, `Sev`, `Icon`, `DemoBanner`.

**Revised G0 gap list:** `Ring` (the dials on AP Detail / FortiGate / PF status),
`SevCell`, `SiteTile`, `StatusPill`, `SegToggle`, `MetaLine`, `SiteChip`, `Bar`,
`Topbar`, `Breadcrumb`, `Tabs`. Eleven, not fourteen, and none of the hard ones.

### C6 — The font recommendation needs a caveat spec 14 didn't have

Spec 14 §3 said to self-host Inter and JetBrains Mono. That is right, and now
it is load-bearing: **ZCD fetches both from Google Fonts in every view**
(`views/global.view.php:19`, and the same two lines in camera / dashboard /
events / fortigate / … ). NetMon's `styles.css:1` says the opposite by design —
*"Self-contained (no font/CDN fetch)."*

Porting ZCD's approach would put an internet round-trip in front of a NOC
dashboard's legibility and contradict the offline-tolerance property spec 11 §8
defines. **Self-hosted woff2 only. Never a `<link>` to a CDN.**

### C7 — The density difference is measurable, and cheap to test on its own

- ZCD: `body { font-size: 13px }`, `.app { grid-template-columns: 220px 1fr; column-gap: 14px }`
- NetMon: `body { font: 14px/1.45 system-ui … }`, sidebar `width: 232px`

13 px versus 14 px/1.45, plus ZCD's use of mono for every number, label,
hostname and timestamp, accounts for most of the "denser, more console-like"
impression. Worth trying as a standalone change before the full token port —
it is two lines and it isolates how much of the perceived gap is palette versus
type.

### C8 — The nine DEMO pages are exactly enumerable, and one is a tab I missed

`DemoBanner` render sites, complete:

| File:line | Page |
|---|---|
| `nvr-camera.jsx:101` | Camera Detail |
| `nvr-server.jsx:60` | Recording Server Detail |
| `pf-clients-app.jsx:242` | Connected Devices |
| `pf-nac-app.jsx:230` | NAC Policies |
| `pf-quarantine-app.jsx:233` | Quarantine |
| `pf-sessions-app.jsx:276` | User Sessions |
| `pf-status-app.jsx:253` | PacketFence Status |
| **`switches-app.jsx:255`** | **Config Backups — a *tab*, not a page** |
| `xdr-app.jsx:520` | Cortex XDR Dashboard |

The one spec 15 missed is the interesting one: ZCD's Config Backups tab is mock,
and NetMon's config-backup card reads *"no backup data"* with `rconfig` writing
0 records. **Neither system has ever had working config-backup monitoring.** So
spec 14's D-2 isn't a regression to fix — it is a feature that has never
existed, and should be scoped as new work against rConfig rather than as a
broken collector.

Also worth recording: `Global` and `Servers` render **no** demo banner, so the
root `readme.md`'s "Global Dashboard — Mock data (synthetic)" is stale.
`ActionGlobalData` is live.

### C9 — The 3CX blocker has a written answer in ZCD's own notes

Spec 15 called the missing `threecx` collector a blocker gated on the open spec
Q4 (v20 REST versus ODBC). `notes/voip-integration-plan.md` largely answers it:

- 3CX v20 exposes the **XAPI** at `https://<pbx-fqdn>/xapi/v1/…`, OAuth2
  client-credentials, provisioned as an "Integrations" API client in the
  Management Console (`lib/ThreeCXClient.php` header).
- §1 is a **field-by-field map**: dashboard field → Zabbix item key → XAPI
  endpoint, including which fields the Zabbix template **cannot** supply at all
  — per-trunk stats, the live active-call list, MOS/jitter/loss/RTT, top
  extensions, per-extension registration grid, ASR/ACD.
- §2 enumerates the endpoints (`/SystemStatus`, `/Trunks`,
  `/Trunks({Id})/Stats`, `/ActiveCalls`, `/Users`, `/Queues`,
  `/ReportCallQuality`, `/ReportExtensionStatistics`, `/ReportCallLogData`) with
  poll cadences.

**But there is nothing to lift.** `ThreeCXClient.php` says so in its own header:
*"scaffolding stub — public surface and auth plumbing are defined so
ActionVoipData can wire to it; individual builder bodies are TODO."* ZCD's live
VoIP numbers come from Zabbix items, not from that client.

**Revised position:** write NetMon's 3CX collector against
`notes/voip-integration-plan.md` §2's endpoint table. It is a specification, not
source to port, and it retires spec Q4 as an open item. Estimate holds at
2–2.5 wk but the risk drops sharply — the unknowns were the auth model and the
endpoint list, and both are written down.

### C10 — Two smaller notes

**Time-range parity has a ceiling.** `global-bridge.jsx:37–41` defines
`1h / 6h / 24h / 7d`. NetMon's ring buffer is hard-capped at 24h by D3, so the
picker can offer at most three of the four. Spec 14 G1 should say so rather than
promise a "Last 24h picker" that implies the rest.

**Paint-then-enrich, and its failure mode.** `global-bridge.jsx` documents
`stage=core` (Zabbix-only, fast) versus `stage=enrich` (XIQ / 3CX / Milestone /
24h event scan, slow). That is why XIQ Status sits on *"Loading AP fleet from
Zabbix…"* indefinitely — the enrich stage fails and the skeleton has no timeout.
NetMon renders from its own DB in one pass and doesn't need the pattern, but
should take the lesson: **a never-resolving skeleton is worse than an honest
error**, and NetMon's own `Loading what=` components need a timeout path.

---

## 3. Sizing evidence

Frontend line counts, JSX + CSS:

| | ZCD | NetMon |
|---|---|---|
| Total | **25,073** | **5,986** |
| Switches | 4,697 (`switches-{app,bridge,tabs,widgets}.jsx` + `switches.css`) | 887 (`pages/switches.jsx`) |
| Global | ~1,850 (`global-{app,bridge,data,nav}.jsx` + `global.css`) | 233 (`pages/global.jsx`) |
| Shared shell | 1,738 (`shell.jsx` + `styles.css`) | 745 (`nav.jsx` + `styles.css`) |
| Primitives | 8,529 B / 7 exports | 133 lines / 12 exports |

Treat the 4× total as an upper bound, not an estimate. A large share of ZCD's
volume is per-page CSS with heavy duplication, mock datasets (`global-data.jsx`,
`xdr-data.jsx`, `servers-data.jsx`, `fortigate-data.jsx`, `nvr-data.jsx`,
`packetfence-data.jsx` — six of them), and a `dist/` of prebuilt bundles checked
into the repo. NetMon's per-page files are also denser: one `switches.jsx` does
what four ZCD files do.

---

## 4. Revised sequencing

Replaces spec 14 §5 and reorders spec 15 §3.2.

| Phase | Contents | Was | Now |
|---|---|---|---|
| **G0 Design system** | tokens; **self-hosted** woff2; 11 primitives (not 14); try the 13 px density change first, in isolation | 1–1.5 wk | 1 wk |
| **G1 Shell** | topbar, breadcrumb, ⌘K promotion, page-header pill + meta line, range picker **limited to 1h/6h/24h** | 1–1.5 wk | 1–1.5 wk |
| **G2 Site attribution** | **split out of the data-truth gate and promoted to its own phase.** Alerts and devices scoped to curated sites; `Wireless APs` / `Unassigned` stop appearing as locations | (inside G2) | 1–1.5 wk |
| **G3 Data truth** | D-1 (3CX, per C9) · D-2 rescoped as new work (per C8) · D-3 resolved via option (c) (per C3) · D-4…D-7 surveillance counts · D-10 dedupe · D-11 ack · `validate_payloads.py` clean. D-8/D-9 closed: poller is on, engine is in shadow | 2–3 wk | 2–3 wk |
| **G4 Severity strip + hotspots** | render `summary.severity` + `alerts.acked/unacked/assigned`; 4 cells not 6; hotspots from `/api/sites` | 1.5–2 wk | **0.5–1 wk** |
| **G5 System cards** | per-domain sparklines, icons/tint, "N need attention". Headline and deep links already work | 1.5–2 wk | **1 wk** |
| **G6 Consoles** | Events (ack cell, saved views, tags, bulk ack) · Problems (strip, mosaic, constellation, toggles) | 3–4 wk | 3–4 wk |
| **G7 Honesty & polish** | timeout paths for `Loading`; omit-don't-default (per C2); contrast pass; screenshot set | 1 wk | 1 wk |

**Global parity: ~9–11 weeks** (was 10–13, and the composition shifted — less
backend, more of it in the shell).
**Everything else in spec 15: ~17–21 weeks** (was 19–24; site attribution moved
out and several per-page items shrank once C1 is applied).

---

## 5. Question status after the source read

| Question | Status |
|---|---|
| Spec 14 #1 — clone or dialect? | still open, but narrower: C4 settles the severity ladder, so the remaining question is layout order only |
| Spec 14 #2 / spec 15 #2 — camera noise | **answered** — adopt ZCD's exclusion precedent (C3), option (c) |
| Spec 14 #3 — poller / engine | **answered** from NetMon Status: poller on, engine in shadow. Only "should shadow flip?" remains |
| Spec 14 #4 — severity ladder | **closed** by `severity.js` (C4) |
| Spec 14 #5 / spec 15 #7 — spec numbering | still open |
| Spec 15 #1 — `#/xiq` vs `#/wireless` | still open |
| Spec 15 #3 — 8 / 22 / 44 recording servers | still open, and now four-way: ZCD's own page says 44 |
| Spec 15 #4 — import PF mock layouts? | **leaning yes** — they are the only PF layouts that exist, and NetMon supplies the data they were shaped for |
| Spec 15 #5 — identity masking | still open, and unchanged in urgency |
| Spec 15 #6 — AP Detail tab set | narrower: ZCD's Latest Data and Configuration tabs are Zabbix-shaped and have no NetMon analogue; recommend 7 tabs, not 9 |
| Spec 11 Q4 — 3CX v20 REST vs ODBC | **effectively answered** by `notes/voip-integration-plan.md` (C9) |
