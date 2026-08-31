# Spec 14 — Global page parity with ZabbixCustomDashboard

**Status:** DRAFT — awaiting owner sign-off
**Scope:** the NetMon **Global** page and the app shell around it (topbar, sidebar,
design tokens, shared primitives). Other pages inherit the primitives but are
not re-laid-out here.
**Relates to:** spec 11 §4 (page-parity map, Global row: "📋 spec 10.5"), spec 10.5
(`/api/summary`, `/api/sites`, severity strip, system cards), spec 10.6 (24h ring buffer).
**Observed:** ZCD Global at `zabbix.php?action=tcs.global.view` and NetMon `#/` on 2026-08-31.

---

## 1. Why this spec exists

Spec 10.5 shipped a Global page that is *functionally in the right shape* — KPI
row, system cards, site grid, trigger table, event feed. Side by side with ZCD,
it reads as a different, thinner product. Three distinct gaps, and they need
different fixes:

1. **Design system.** ZCD has ~30 CSS custom properties (4-step background ramp,
   4 text levels, per-source brand colors, semantic + Zabbix severity scales,
   3 radii, Inter + JetBrains Mono). NetMon has 7 (`--bg --panel --panel2
   --border --text --dim --accent`), one accent, no mono declaration, no
   severity scale. Every visual difference downstream traces back here.
2. **Missing components.** No severity strip, no Top Problem Hotspots panel, no
   per-system sparklines, no per-site problem/availability roll-up on Global, no
   topbar, no filters on the trigger table, no source badges on events.
3. **The data behind the components isn't true yet.** This is the important one.
   ZCD's Global reads: 145 High, 27 Warning, 42 hosts down of 1,017. NetMon's
   reads: 2,742 open alerts of which 2,659 are warn, 2,661 devices unknown,
   2,659 source-blind, VoIP `0/0 trunks`, config backups `no backup data`,
   surveillance `2659 recording / 2655 total`. A severity strip built on top of
   that would be a very handsome lie.

So the plan is: **tokens and primitives first (no risk), data truth second
(gated), then the components that display it.** Painting before G2 would produce
a dashboard that looks like ZCD and can't be trusted, which is worse than the
thin one that's there now.

---

## 2. Component-by-component gap table

ZCD Global, top to bottom. Verdicts: ✅ present · 🔶 partial · ❌ absent.

| # | ZCD component | What it contains | NetMon today | Gap |
|---|---|---|---|---|
| 1 | **Topbar** | back chevron, breadcrumb `Tuscaloosa City Schools / Operations / Global`, ⌘K search field ("Find host, MAC, user, IP…"), refresh button, overflow menu | ❌ none; search lives in the sidebar | Add persistent topbar |
| 2 | **Page header** | `Global Dashboard` + pill `OPERATIONS · TIER-1`; meta line `● All proxies polling · Last refresh 11:55:44 AM · Auto-refresh 30s · Polled hosts 1,017 · Templates —`; right-side time-range picker `Last 24h` | 🔶 `Global` + `updated 0s ago` | Pill, meta line, range picker |
| 3 | **Severity strip** | 6 tinted cells: Disaster / High / Warning / Info / Acknowledged / Hosts down — each with source badge, big colored number, sub-note (`145 unack`, `+12 in 1h`, `drift`, `0% of total`, `of 1,017`) | ❌ six *inventory* tiles instead (Devices / Up / Down / Unknown / Source blind / Open alerts) | Needs a severity model, not just a layout |
| 4 | **System snapshot** | section header + `5 systems · 4 need attention`; 3-col grid of cards. Per card: icon, title, subtitle (`ExtremeCloud IQ · 788 hosts`), source badge + status pill, **3 KPIs** (label / value / sub-note), **labeled 24h sparkline**, footer = single most important message + `OPEN ↗` | 🔶 6 cards in a flat row with status pill + 2–3 KPIs + `source · age` footer. No icon, no sparkline, no headline message, no deep link, no "N need attention" | Sparkline, headline, deep link, grid |
| 5 | **Sites — health map** | 25 tiles, 12-col grid, segmented filter `All 25 / Issues 13 / OK 12`; per tile: problem count or ✓, name, `N hosts`, `SLA 100.00%`, background tinted by worst severity; below: severity legend + `56 problems · 229 hosts shown` | 🔶 23 tiles with name + `N dev` + left-border tint. No count, no hosts, no SLA, no filter, no legend, no summary | Roll-up data + tile redesign |
| 6 | **Active triggers** | segmented `All / Disaster / High / Warning` + `All ↗`; columns SEV badge / AGE / HOST + trigger text / SITE chip / source badge / pulse dot; inner scroll | 🔶 dot / DEVICE / RULE / SINCE / ACK. No severity label, no site column, no filter, no source badge | Severity + site + filter |
| 7 | **Top problem hotspots** | `by site`; 6 rows: id chip, site name, problem count, severity-colored bar, footer `N hosts · SLA 100.00%` | ❌ absent | New panel |
| 8 | **Recent events** | header carries **three** source badges (ZBX / PF / EXT) + `Open in event console ↗`; rows: time, source badge, host, color-coded verb (`Resolved:` green / `Trigger:` amber) + message | 🔶 "State transitions / Recent events": dot / device / dimension / `down → up` / age | Source badges, verb coloring, console link |
| 9 | **Sidebar** | collapse toggle + `‹ DEFAULT ZABBIX DASHBOARD` escape hatch; brand block; sections MONITORING / IDENTITY (PACKETFENCE) / SURVEILLANCE (MILESTONE); **live count on nearly every item**; footer chips `Zabbix Server ● 7.4.9`, `PacketFence API ● v15`, `XProtect Mgmt ● 25.3 R2` | 🔶 sections MONITORING / ACCESS & EVENTS / SYSTEM / ADMINISTRATION / SOURCES; counts on 2 items only; footer `v0.1.0 · 3624 devices` | Counts, section grouping, platform-version chips |

### What NOT to copy

- **ZBX source badges.** There is no Zabbix at runtime (spec 11 §5.2). Replace
  with NetMon's own source vocabulary: `XIQ · PF · MILESTONE · 3CX · RCONFIG ·
  SNMP · NATIVE`. Same badge component, honest content.
- **"All proxies polling / Polled hosts / Templates."** Zabbix-internal concepts.
  Translate to NetMon's equivalents: collectors healthy *n*/*m*, oldest sweep age,
  registry size, poller/engine enabled state.
- **Cortex XDR nav item** — dropped (D8).
- **Servers nav item** — D2: stays a Zabbix deep-link.
- **NetMon's SOURCES sidebar block is better than ZCD's footer chips** — keep it,
  and *add* platform-version chips rather than swapping.

---

## 3. Design system port (Phase G0)

Lift ZCD's token set as-is. Observed values, for direct transcription:

```css
:root {
  /* backgrounds: 4-step ramp */
  --bg:#0d1117; --bg-1:#131822; --bg-2:#181f2c; --bg-3:#1f2738;
  /* lines */
  --line:#232c3f; --line-2:#2c3650;
  /* text: 4 levels */
  --fg:#e6ecf5; --fg-2:#b8c2d4; --muted:#6b7793; --muted-2:#4a5572;
  /* semantic */
  --ok:#34d399; --warn:#f5b300; --err:#f25f5c; --info:#5fa8d3; --accent:#5b8cff;
  /* per-source brand (remap: zbx→native, ext→xiq, add ms/3cx/rcfg) */
  --pf:#f5b300; --ext:#7c5cff; --cx:#2bd6c0; --xdr:#e84393;
  /* Zabbix severity scale — keep the values, they're the operators' muscle memory */
  --sev-info:#7499FF; --sev-warning:#FFC859; --sev-average:#FFA059;
  --sev-high:#E97659; --sev-disaster:#E45959; --sev-na:#97AAB3;
  /* misc */
  --grid:rgba(255,255,255,0.04);
  --r-1:4px; --r-2:6px; --r-3:10px;
  --mono:"JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace;
  --sans:"Inter", -apple-system, system-ui, sans-serif;
}
```

Mapping from NetMon's current 7 tokens (so the rest of the app doesn't break in
the same commit): `--bg`→`--bg`, `--panel`→`--bg-1`, `--panel2`→`--bg-2`,
`--border`→`--line`, `--text`→`--fg`, `--dim`→`--muted`, `--accent`→`--accent`.
Keep the old names as aliases for one release, then remove.

**Typography is doing more work than the palette.** ZCD uses JetBrains Mono for
every number, count, timestamp, hostname, and label — that tabular alignment is
most of why it reads as an operations console. Inter for prose. Both must be
self-hosted (no CDN — the repo already dropped Babel-standalone/unpkg for
esbuild; don't reintroduce a network dependency in the font layer).

**Primitives to build** (`frontend/src/components/`), each used by ≥2 pages:

`Card` / `CardHeader` · `SevCell` · `SystemCard` · `SiteTile` · `Sparkline`
· `SrcBadge` · `StatusPill` · `SegToggle` · `MetaLine` · `SevBadge` · `SiteChip`
· `Bar` (hotspot bars) · `Topbar` · `Breadcrumb`

ZCD's own class names are a decent naming guide (`sev-cell`, `sys-kpi`,
`site-tile`, `hotspot-row`, `src-badge`, `seg-btn`) if matching them helps future
side-by-side diffing.

---

## 4. Data truth gate (Phase G2 — blocking)

Everything below must be resolved, or explicitly waived in writing, before G3–G5
paint anything. Each is a finding from the 2026-08-31 side-by-side, and each
matches the pattern spec 11 §7 already named: **a green `collector_health` row
says a cycle completed, not that it wrote true data.**

| # | Finding | Evidence | Likely cause |
|---|---|---|---|
| D-1 | **3CX collector has never run.** VoIP card: `0/0 trunks registered`, extensions `—`, footer `threecx · never` | ZCD: 17/17 trunks, 1,323/1,437 extensions, 9/256 active calls | The dead `system_status()` spec 10.4 flagged for wiring |
| D-2 | **rConfig writes nothing.** `no backup data`, current `—`, stale `0`, footer `rconfig · 45s ago` — green and empty | ZCD has config-backup freshness | Same class as the `_TS_KEYS`/`last_backup_at` finding in spec 11 §7 |
| D-3 | **Camera fleet is unknown *and* recording.** 2,661 UNKNOWN, 2,659 SOURCE BLIND, 2,659 of 2,742 open alerts are `warn`, while Surveillance says all cameras recording | ZCD: 42 hosts down of 1,017 | Cameras have no `mgmt_ip`/`snmp_capable` (D7/D10 prerequisite) so the native poller can't see them; `source_blind` fires per camera |
| D-4 | **`2659 recording / 2655 total`** — recording exceeds total | arithmetic | Two different queries/denominators |
| D-5 | **Storage `0 / 0 GB`** | ZCD shows storage | Known: Milestone `/storages` answers HTTP 400, swallowed at `log.info` |
| D-6 | **22 recording servers** vs Zabbix's **8** | direct conflict | Milestone inventory counting something other than RS, or Zabbix under-monitors |
| D-7 | **23 sites vs 25 tiles.** ZCD carries `Unassigned` (32 hosts), `Servers` (25), `Video/Milestone` (12) as pseudo-sites | Global tiles | NetMon has no surfaced unassigned bucket; 2,659 cameras aren't site-attributed |
| D-8 | **`[poller] enabled` still open**, per spec 11 next-session notes — the whole native-tiebreaker design assumes the fping sweep runs | zero `ping` rows in `device_state` | Owner decision + `snmp_community` review + ICMP blast-radius check |
| D-9 | **`[engine] enabled = false`** ⇒ stale `alerts` rows can never close (Verner's phantom `problems=3`) | spec 11 notes | Owner decision; a severity strip over un-closable alerts is unusable |
| D-10 | **Duplicate registry entry** for `192.168.100.253` (ids 834 `VES-GYM` + 1029) inflating a site's device count | spec 11 notes | Replaced switch, old XIQ record survives |
| D-11 | **Every ACK cell reads `—`** | trigger table | Ack exists in the API; either unused in practice or not joined into the Global query |

**Exit criteria for G2:**
`scripts/validate_payloads.py` passes clean (it is a standing cutover gate, not a
one-off), D-1…D-7 either fixed or waived, D-8/D-9 decided, and the top-line alert
count is within an explainable delta of Zabbix's. Then stop and report.

**On D-3 specifically** — there are two honest answers and they should be chosen
between deliberately, not by default:
(a) populate camera addresses (already a D7 prerequisite) so cameras stop being
source-blind; or
(b) treat "Milestone says recording" as sufficient evidence for a camera and
suppress `source_blind` for the camera device class entirely.
Either is defensible. Doing neither leaves 2,659 warnings permanently pinned to
the top of the dashboard, which trains operators to ignore the number — the exact
failure spec 11 §5 warns about with notification fatigue.

---

## 5. Phases

Sized for 6–10 hrs/week. Each ends demonstrably working and independently
reversible; each ends with a stop-and-report.

| Phase | Deliverable | Backend work | Est. |
|---|---|---|---|
| **G0 — Design system** | Full token set, self-hosted Inter + JetBrains Mono, 14 primitives, alias shim for the old 7 tokens. Existing pages keep rendering unchanged | none | 1–1.5 wk |
| **G1 — Shell** | Topbar (breadcrumb, ⌘K moved up, refresh, auto-refresh interval control); page header pill + meta line + `Last 24h` picker; sidebar section regroup + live counts on every item + platform-version chips | `/api/meta` gains source-platform versions; `/api/summary` gains per-nav counts | 1–1.5 wk |
| **G2 — Data truth gate** | D-1…D-11 above; `validate_payloads.py` clean. **Blocking.** | 3CX + rConfig collectors, Milestone storage/RS/camera-count fixes, site attribution, dedupe, poller/engine decisions | 2–3 wk |
| **G3 — Severity strip + hotspots** | 6-cell strip with sub-notes; Top Problem Hotspots panel | Severity model: map `alert_rules.severity` → Disaster/High/Warning/Info; `/api/summary` adds counts-by-severity, unacked, 1h delta, devices-down-of-total; `/api/sites` adds problem count + 24h availability from `state_events` | 1.5–2 wk |
| **G4 — System snapshot** | 3-col card grid, icons, `N systems · M need attention`, per-card 24h sparkline, headline message, `OPEN ↗` deep links | Per-domain worst-open-alert query; per-domain series from `state_samples` (10.6 buffer — data already exists, just unwired per card) | 1.5–2 wk |
| **G5 — Sites map + consoles** | Site tiles with count/hosts/availability/severity tint + `All / Issues / OK` filter + legend + summary; Active Triggers with SEV badge, site chip, source badge, severity filter; Recent Events with source badges + colored verbs + console link | reuses G3 endpoints; `/api/events` source + verb fields | 1.5–2 wk |
| **G6 — Honesty & polish** | Staleness badging everywhere; empty states that say *why* (`3CX collector has never run` beats `—`); auto-refresh; contrast pass; side-by-side screenshot set as the acceptance artifact | none | 1 wk |

**≈10–13 weeks** at that cadence. G0 and G1 are safe to start immediately and in
parallel with G2's investigation; G3–G5 must not start before G2 reports.

Ordering rationale: G0 before everything (every later phase consumes the
primitives). G1 next because it's the highest visual return per hour and touches
no data semantics. G2 before G3–G5 for the reason in §1.3.

---

## 6. Acceptance criteria

Parity is reached when, on one screen, for the in-scope domains:

- [ ] Every ZCD Global component in §2 is present or has a written waiver.
- [ ] Every number on NetMon Global is reconcilable with its source platform, and
      the reconciliation is written down (not "collector is green").
- [ ] No permanently-pinned alert class dominates the top-line count.
- [ ] Every KPI that can't be computed says why, in words, rather than `—`.
- [ ] Every card links out to the page that explains it (`OPEN ↗`).
- [ ] Side-by-side screenshots of ZCD Global and NetMon Global at 1600px, both
      committed to `docs/design/global-parity/`.
- [ ] An operator asked "which site is worst right now, and why" answers it from
      NetMon Global in the same number of glances as from ZCD.

The last one is the real test, and it's the spec 11 cutover criterion restated
for this page.

---

## 7. Open questions for the owner

1. **Visual identity: clone or dialect?** Copy ZCD's layout and order exactly
   (fastest to build, zero retraining, but bakes in Zabbix-shaped framing like
   the Disaster/High/Warning/Info ladder), or keep ZCD's *design system* while
   letting NetMon's information architecture differ where its data model is
   genuinely different (source-blind is a real state Zabbix has no cell for)?
   This spec assumes **clone the system, allow the strip to differ** — the strip
   is the one place NetMon knows something ZCD doesn't.
2. **D-3:** populate camera addresses, or suppress `source_blind` for cameras?
3. **D-8 / D-9:** flip `[poller] enabled` and `[engine] enabled` on? G3 is not
   meaningful with the engine off.
4. **Severity ladder:** adopt Zabbix's five levels verbatim (operator muscle
   memory, and the colors are already in the token set), or NetMon's own
   crit/warn/info three?
5. **Does this become spec 14, or fold into spec 10.5 as a revision?** It is
   arguably 10.5's unfinished half rather than new scope.
