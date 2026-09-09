# Spec 20 — Make NetMon look like the Zabbix module, page by page. Cameras first.

**Status:** PLAN (written 2026-09-07 from the `tcs-dashboard-reference` bundle
exported off the production Zabbix server that day — tcs_dashboard 1.3.0).
**Owner decisions 2026-09-07:** vendor Inter + JetBrains Mono woff2 — **yes**;
read-only camera login in `netmon.conf` for the snapshot proxy — **yes**; add
**bulk camera configuration change + bulk firmware update** to the plan —
**yes, as gate D11** (§3 S8; spec 11 §6). S0 done the same day.
**Relates to:** spec 14 (Global parity; G0 tokens / G1 shell), spec 15 (page
parity matrix §2·17–21), spec 19 (Camera Ops — the data behind the page), spec 11
D5 (ESS) / D7 (JPEG proxy) / D4 (write actions), spec 13 (D10 camera SNMP).

---

## 0. What the bundle changed, and what it did not

The zip is the same module `reference/` already mirrors, one release on. Diffed
ignoring line endings, **only three files differ** and five are new:

| File | Change | Matters to NetMon? |
|---|---|---|
| `actions/ActionSurveillanceData.php` | fleet storage roll-up now sums per-RS `storage.total/used.bytes` + min retention; ships `milestoneWs` `{url, token, expiresAt}` in the summary stage | the roll-up shape is what NetMon already computes (spec 19 §4); the WS handshake is the browser-WS design NetMon deliberately does *not* copy (§4 below) |
| `assets/surveillance-ws.jsx` *(new)* | browser opens `wss://…/api/ws/events/v1`, subscribes to 5 camera event GUIDs, patches `window.CAMERAS` live | the GUIDs and state→class mapping agree with spec 19 §11–12 — confirms our mapping |
| `lib/MilestoneClient.php` *(new)* | mints the short-lived bearer for the browser | not needed — NetMon holds the ESS server-side |
| `lib/FortiAnalyzerClient.php`, `actions/ActionVoipSitesData.php`, `assets/switches-data.jsx` *(new)*; `ActionFortigateData.php` | FortiGate (D1, deferred) and VoIP paging | later phases |
| `TCS-Dashboard-Functionality.md` *(new, top level)* | the owner's functional reference for the port | **keep in `reference/`** — it is the best single description of what each page does |

Everything else — every `nvr-*.jsx`, `surveillance.css`, `camera-bridge.jsx`,
`styles.css` — is byte-identical to `reference/`. So the *design* NetMon has been
porting from is current; the gap is in how NetMon composes its pages, not in the
stylesheet. `frontend/src/styles.css` already carries ZCD's `styles.css` verbatim
and the whole of `surveillance.css` (`.stat-grid`, `.cam-tile`, `.cam-grid`,
`.site-row`, `.server-tile`, `.storage-bar`, `.state-pill`, `.rec-pill`,
`.nvr-tbl`, `.cam-filter-bar`, `.trig-filter`, `.link-tbl`, `.ap-nav-*`).

Two things in the bundle to leave alone: `etc-zabbix/secrets/xiq_action_token`
and `etc-zabbix/tcs_dashboard/xiq_api_token` are redacted placeholders (63 and 97
bytes; the real JWTs are 0.9–3.6 KB) — do not copy `etc-zabbix/` into the repo at
all. `MilestoneClient.php`'s credential resolution and the cron line with the
service-account password are documented in the functionality doc §0; provision
those through `/etc/netmon/netmon.conf`, never the repo (CLAUDE.md §4.6).

**Step 0 (half a session):** sync the three changed + five new files into
`reference/`, add `TCS-Dashboard-Functionality.md` beside `reference/readme.md`,
skip `etc-zabbix/`, `httpd/`, `cron/`, `server-scripts/`, `graphify-out/`, `dist/`
and `vendor/`. `reference/zabbix/milestone/` already holds the external scripts.

---

## 1. What "looks like ZCD" actually consists of

Comparing every ZCD page against NetMon's, the visual identity comes from six
recurring structures — not from colours (already identical) and not from the
sidebar (already ported):

1. **Page header block** — `.page-header` › back glyph · `.host-title` (`h1` +
   `.ip` + `.role-tag` chip) · `.host-meta` row of `.pill`s (dot + label + mono
   value) · `.timerange` ("Last 24h · live") on the right. NetMon pages render
   `<h1>` + a `.subtitle` sentence instead.
2. **Tabs with live badges** — `.tabs › .tab › .badge[.warn|.err]`. NetMon tabs
   exist but carry no counts.
3. **Card header grammar** — `.card-h › h3 · SourceBadge · .h-spacer · .h-meta ·
   .h-link`. NetMon's `Card` has title + kicker; the source badge and the
   right-hand link are missing from most cards.
4. **KPI strip** — `.stat-grid › .stat-cell › .lbl (icon + text + badge) / .val
   (+ `.u` unit) / .sub[.ok|.warn|.err]`. Surveillance already uses it; most other
   NetMon pages use the older `.stat` tile.
5. **Dense linked tables** — `.link-tbl.nvr-tbl` with `row-err/row-warn` tinting,
   inline bars (`.ib`), pills in cells, chevron column.
6. **Navigator rail + content** — `380px 1fr` grid, `.ap-nav-card` sticky rail with
   search, `seg-toggle` status filter, per-group collapsible sections with LED
   rows. NetMon has this on Switches and Wireless; not on cameras.

Plus one thing that is not markup: **the typefaces.** ZCD loads Inter and
JetBrains Mono from Google Fonts in every `*.view.php`. NetMon's token stack names
the same faces but ships no font files (spec 14 G0 follow-up), so unless the
viewer's machine has them installed the page falls back to system-ui and looks
noticeably different before a single component is compared. Self-hosting the two
woff2 families (both OFL-licensed; ~600 KB total; static files under
`frontend/`, no npm or Python dependency) is the single highest-return item in
this whole spec. It is not a code dependency, but it is a vendored asset like
leaflet was — **confirm with the owner before adding the files.**

The plan below builds a shared `PageHeader` + `Tabs` (with badges) + `Card`
extension (source badge, right link) once, in S1, and applies them to
Surveillance first. Every later page then inherits the look for free.

---

## 2. Cameras — side by side

### 2.1 ZCD Surveillance NOC (`tcs.surveillance.view`, 7 tabs)

- **Header:** "Surveillance NOC" · mgmt server · product chip · pills: RS online
  x/y, XProtect ver, Cameras licensed x/y, Storage used/total TB, Sites n,
  Loading-stage spinner pill · "Last 24h · live".
- **Tabs:** Overview · Sites *n* · Cameras *n* · Recording Servers *n* · Alarms
  *n*⚠ · Storage · Evidence Lock.
- **Overview:** 4-cell strip (Cameras Online, Recording Servers, Active VMS Alarms,
  Smart Client Sessions) → row: *Milestone XProtect* card (licence bar + kv: mgmt,
  RS, failover, mobile, retention, evidence lock) | *Live Ingress · 24h* area
  chart + 4 spark cells → row: *Sites* list (`.site-row`: dot · name · online/total
  · w/e · storage bar with RS name · chevron) | *Recording Servers* 2-col
  `ServerMini` tiles (CPU/Mem/Disk, RAID pill) → *Active Alarm Feed* (`.alarm-row`).
- **Sites:** 4-cell strip + table (Site, RS, Cameras, Health pill, Storage bar,
  Network/VLAN, APs).
- **Cameras:** 380px *Camera Navigator* (search · All/Online/Warning/Offline
  seg-toggle with counts · site select · summary · collapsible groups with LED rows
  "location / ip · model") | *Thumbnails* `.cam-grid` of `CamThumb` (first 48;
  `<img>` via the server-side snapshot proxy at `size=M`; `NO SIGNAL` overlay when
  err; timestamp overlay).
- **Recording Servers:** 4-cell strip + table with `InlineBar` CPU/Mem, storage
  bar, retention, RAID, uptime.
- **Alarms:** two `.trig-filter` groups (severity, ack) + table with inert
  Ack / Suppress 1h row actions.
- **Storage:** *Fleet storage* `Ring` + kv | *Per-site capacity* `.storage-row`s →
  *Storage volumes* table.
- **Evidence Lock:** counter cell + "not templated" empty state (never had data).
- **Live:** `surveillance-ws.jsx` patches camera state sub-second from the browser.

What it reads in production today (spec 15 §0.2): **0/44 RS online, 0 cameras,
0.0/0 TB, sites as raw GUIDs.** Copy the layout; do not inherit the numbers.

### 2.2 ZCD Camera Detail (`tcs.camera.view`, DEMO-bannered)

Header (name · ip · model chip · pills: state, site·loc, recording, RS link, MAC)
· tabs Overview / Live / Events / Configuration · **320px sidecar** (status line,
`live-large` still with name/ts/res·fps·codec overlays and a blinking REC — or
`NO SIGNAL`; *Smart Client* / *Restart Stream* buttons, both inert; Location,
Hardware, Recording Server blocks) · **right column**: Active Issue card,
Device Health rings (CPU/Mem/ICMP latency/pkt loss — all "—", nothing feeds
them), Live Telemetry spark strip (same), Stream Configuration kv, Network &
Identity kv, **PacketFence & Uplink** card (switch/port/MAC/role/PF IP/last seen +
*View in PF · Reevaluate · Reboot(=restart_switchport) · Cycle PoE*), Live View
card (still + "opens in the camera's own player"), Recent Events.

### 2.3 NetMon today (`#/surveillance`, `#/camera/:id`)

- **Surveillance:** `h1` + subtitle · unlinked-devices banner · **6-cell strip**
  (Cameras, Up, Down, Milestone down, Blind, Storage) · 4 tabs, no badges ·
  Overview = by-school `SiteTiles` grid (the XIQ idiom) + 3-row XProtect kv +
  "Alarms need D5" placeholder · Cameras = filter bar (school chip, 7 status chips
  with counts, search) + flat 8-column table · Servers table · Storage table.
- **Camera detail:** back link · `host-title` + 4 pills · **4 probe cells**
  (Reachability / Milestone / ICMP / Recording) · two columns: 14-row Camera kv +
  *Siblings on this device*; *Uplink — switch port* (FDB-derived, PF agreement,
  trunk-avoidance, `Cycle PoE` only when the access port is confirmed) + *PacketFence*
  kv with View-in-PF. No tabs, no still, no events, no active-issue card, no PF
  Reevaluate / Restart-port buttons (both exist in `netmon/actions.py`).

### 2.4 Where each side is ahead

**NetMon has data ZCD never had:** reachability tiers (spec 19 §13) and ESS-derived
Communication state (§12) on 2,651 cameras; real sites (spec 17) rather than
RS-hostname buckets; vendor/firmware/serial/MAC from `hardwareDriverSettings`;
`http_port`; multi-camera hardware siblings; FDB uplink with PF cross-check;
`state_events` (a real per-device event history); `alerts` with working
Ack/Assign/Suppress; the `state_samples` 24 h ring buffer; four audited write
actions. The truth is better on this side.

**ZCD has composition NetMon lacks:** the 7-tab structure, header pills, tab
badges, navigator + thumbnail wall, server tiles, alarm feed, storage ring/rows,
per-camera tabs and sidecar, PF action row, and the four-button parity with AP
detail.

**Neither side has** (and the layout must say so rather than show 0): storage
*used* and RS CPU/mem/disk/RAID (WinRM, OpenProject #111), Smart Client sessions,
evidence-lock detail, camera CPU/mem (D10, spec 13 — post-cutover, default-off).

---

## 3. Phases — cameras

Each phase is one or two owner sessions (6–10 h/wk), ends committed with tests,
`render-check.mjs` cases for every new component, and the checklist in §6
ticked. Order matters: S1 makes the shell primitives every later page uses.

### S1 — Shell parity primitives, applied to Surveillance (1 session)

Frontend only. New in `primitives.jsx`: `PageHeader({title, ip, tag, pills,
range, onBack})`, `Tabs({tabs:[{id,label,badge,kind}], active, onChange})`,
`Card` gains `source` (renders `SourceBadge` in `.card-h`) and `link`
(`.h-link`). Surveillance adopts them:

- Header: **Surveillance NOC** · Milestone host (from `/api/meta`, already
  exposes source URLs) · product chip "XProtect 2025 R2" (spec 19 §8; until S2
  collects it live, read it from `[milestone]` config or omit — never hard-code) ·
  pills: RS online *x/y*, Cameras *recording/total*, Storage *configured* TB
  (labelled "configured", §4.5), Sites *n*, cache age · range chip "Last 24h".
- Tabs with badges: Overview · Sites *n* · Cameras *n* (badge `err` when
  `down_confirmed + down_source_only > 0`) · Recording Servers *n* · Alarms *n*
  (`warn`) · Storage · Evidence Lock. Tab state in the hash query (`#/surveillance?tab=cameras`)
  so deep-links and the ⌘K palette can land on a tab — ZCD persisted it in tweaks.
- KPI strip → ZCD's **4 cells**, keeping NetMon's truth in the sub-lines:
  *Cameras Online* `up / total` sub "n down · n Milestone-down · n no-ICMP · n blind" ·
  *Recording Servers* `up / total` · *Active Alarms* open alerts on
  camera+recording_server devices, sub by severity · *Recording* `recording / total`
  sub "motion-triggered — stopped is normal" (replaces Smart Client Sessions, which
  no interface exposes). The six-tier chips stay on the Cameras tab filter bar.
- Overview: keep `SiteTiles` (it answers "which school" better than ZCD's list —
  spec 15 §0.3 says keep the honesty advantages) but give it ZCD's `.card-h`
  (`h3` Sites · badge · "click a school to filter cameras") · *Milestone XProtect*
  card in ZCD's kv layout, rows rendered "—" until S2 fills them · *Recording
  Servers* `ServerMini` tiles with **Cameras / Storage(configured) / Retention** in
  the three stat slots instead of CPU/Mem/Disk · *Active Alarm Feed* = the last 10
  open alerts on surveillance devices (`/api/alerts?device_type=camera,recording_server`
  — one-line filter addition in `netmon/api/alerts.py`), rows link to `#/camera/:id`.
- The "Alarms need D5" card goes: D5 is wired (spec 19 §10–12).

Fonts: if the owner approves, vendor Inter (400/500/600/700) and JetBrains Mono
(400/500/600) woff2 under `frontend/fonts/` and add the `@font-face` block ahead
of the PORT marker in `styles.css`; esbuild copies them to `netmon/web/`.

### S2 — The numbers the header and overview need — **done 2026-09-07**

Probed read-only first, which changed most of the plan and turned up four
defects that had nothing to do with the new work.

**What the gateway actually holds:**

| Wanted | Endpoint | Result |
|---|---|---|
| management server, version | `/api/rest/v1/sites` | one row: `CO-MILESTONE`, `version 25.2.0.1` — the version spec 19 §8 had to infer |
| licence | `/licenseDetails` | Device License, **2,491 activated, 0 not licensed**. There is **no total** in this response or in `/licenseInformations` — Professional+ licenses per activated device, so ZCD's used/total bar has no source. The page reports activated and unlicensed and invents no ratio |
| camera `channel` | `/cameras` | present on all 2,651; **178 are channels > 0** (multi-imager devices) |
| TLS scheme | `hardwareDriverSettings` | `httpSEnabled` is the STRING `'Yes'`, `httpSPort` an int. **1,695 of 2,651 cameras (64%) have HTTPS enabled** — a proxy assuming either scheme would fail on hundreds |
| recorder states | ESS | the subscription asked for `resourceTypes: ["cameras"]` only, so **zero** recorder states had ever arrived |

**The ESS subscription was half-blind.** Adding `recordingServers` to the same
filter (still D5's three read-only verbs) yields 152 states across all 22
recorders: Communication Started ×22, CPU Usage Normal ×22, Retention time
Normal ×21 + **Warning ×1**, Service Available Critical ×11 / Normal ×11.
Communication now drives recorder `source_status` — better than the Config API's
`running` flag, which describes configuration rather than whether the VMS is
talking to the box. The other three are **descriptive columns only**: half the
estate reads "Service Available Critical" with timestamps weeks to months old,
which looks far more like a state group that was never cleared than eleven
simultaneous outages, and turning that into eleven alerts would repeat the storm
spec 19 §12 spent a day undoing.

**Four defects found while building, none of them in the new feature:**

1. **The camera→recorder link never worked.** `/cameras` carries no
   recording-server reference — the chain is camera → `relations.parent`
   (hardware) → hardware's `relations.parent` (recordingServers). The code
   looked for a `recordingServerId` on the camera, found nothing, and left
   `recording_server_device_id` NULL for **all 2,651 cameras** since Phase 10.4.
   That is why the detail page showed "—" for the recorder and why per-recorder
   camera counts were impossible. Now 2,651 of 2,651 link across 22 recorders.
2. **`chans_total`/`chans_recording` are NULL for all 22 recorders** in the
   Config API, so the counts come from the cameras table in the API layer, where
   the link now exists.
3. **The ESS timestamp broke the whole recorder upsert.** Milestone emits seven
   fractional digits and a trailing Z; MariaDB rejected the string and failed
   every recorder row with "Incorrect datetime value" — one unparsed field
   costing a whole table its refresh.
4. **Milestone is inconsistent with its own state names** — recorders report
   `CommunicationStarted` (no space) beside `CPU Usage Normal` (spaces). Matching
   the spaced form marked all 22 recorders down.

**And one defect I introduced and had to fix properly.** Gating the identity
backfill on "the new field is non-NULL" looked right and was wrong twice over: a
hardware that reports no MAC would be re-fetched every cycle forever, and — worse
— reading back only *asked* hardware meant `replace_rows` re-supplied nothing, so
**2,496 MACs were wiped from the live database** until the backfill came round
again. The fix is migration 028's `identity_at`: "have we asked" is a separate
question from "what do we know", and the read-back has to answer the second on
every cycle. Both are now pinned by tests, and the estate was refilled in one
pass rather than 17 cycles.

**Also delivered:** seven `surveillance.*` history series (one per reachability
tier, not 2,662 per-camera series — D3's ring buffer stays low-cardinality),
feeding the overview's "Cameras · 24h" panel as one labelled sparkline per tier;
`/api/surveillance/site-context` for the Sites tab; header chip and licence pill;
Service / CPU / Retention-state columns on the recorder table with their age in
the tooltip.

### S2-original — the numbers the header and overview need (superseded)

All GET, all Config API, all into `milestone.overview` / `recording_servers`:

- Management server name + product/version — investigate `/api/rest/v1/sites`
  (`sites[0].displayName`, `version`) against the live gateway; spec 19 §8 got
  "2025 R2" from somewhere, record where.
- Licence used/total — investigate `/api/rest/v1/licenseInformations` (or the
  `licenseDetails` child). ZCD parsed a licence string from a site item; if the
  REST resource is absent on 2025 R2, the pill reads "—", not 0.
- Per-RS `chans_total` = cameras linked to that RS (already derivable in SQL; do
  it in the API, not the collector). `chans_recording` = those with
  `recording = up`.
- RS Communication/service state from the ESS — spec 19 §11 has 9 RS states
  covering all 22 servers; `_ess_camera_status` reads only `cameras/`. Extend it
  to `recordingServers/` and write RS `source_status` from it (today RS
  `source_status` comes from `running/enabled` on the Config API record).
- New series in `netmon/history.py`: `surveillance.cameras_up`,
  `.down_confirmed`, `.down_source_only`, `.down_network_only`, `.blind`,
  `.alerts_open` → powers the Overview *Cameras online · 24h* `FleetChart` (ZCD's
  Live Ingress slot; ingress Gbps / storage write / RS CPU are agent-domain and
  stay out). Same 24 h ring, pruned, D3-compliant.
- `/api/surveillance/sites` gains `recording_servers` (names), `storage_total_gb`
  (sum of RS at that site), `aps`, `switches` (counts from `devices`), for the
  Sites tab. ZCD's Network/VLAN column had no source and is dropped.
- `/api/surveillance/summary` gains `management_server`, `version`,
  `license_used/total`, `alarms_open`, `alarms_by_severity`.

### S3 — Cameras as its own page, navigated by the Milestone group tree

**Revised 2026-09-07 on the owner's direction** ("the camera tab should be moved
to its own page (setup like the AP page) with a tree navigation sorted by
milestone groups (Schools)"). The plan had this as a tab with a navigator; it is
a **page** at `#/cameras`, and the tree axis is XProtect's own `cameraGroups`
rather than `devices.site`.

**Done 2026-09-07.** What the live gateway turned out to hold, checked before the
schema was designed rather than after:

- `GET /api/rest/v1/cameraGroups?includeChildren=cameras,cameraGroups` →
  **26 groups**, named by school code (BHS, CHS, NHS, MLK, ARC, CO, BUS…) — the
  same 26 ZCD's "Sites" tab badged.
- **Completely flat** on this deployment: zero subgroups. `parent_id`/`path` are
  still stored and the component still indents, because the API models nesting
  and a reorganisation must not need a migration.
- **2,687 memberships over 2,662 cameras** — 25 cameras are in two groups. That
  is why membership is its own table and why a camera renders under both: a
  single `group_id` column would silently drop one, and appearing twice is what
  Smart Client does.
- **Three groups are empty** (SHEC, OLD TCT, NES) and are rendered as such.
- The group payload carries each camera's **`channel`** — which is exactly what
  S4's snapshot proxy needs for shared-encoder channels (spec 11 D7). Noted for
  S2 rather than taken here.

**The labels needed no new mapping.** `sites.name` already *is* the school code,
so `camera_groups.name = sites.name` yields `display_name` ("Paul W. Bryant
High") and `group_key` (the value in `devices.site`). 18 of 26 groups label
themselves this way; the other 8 (ALB, RQS, OKD, OKH, NES, SHEC, OLD TCT, CNP
Cameras) have no `sites` row under that code and render the code alone, which
operators read fine. Adding those rows is a data task, not a code one.

**Delivered:** migration 026 (`camera_groups`, `camera_group_members`);
`MilestoneClient.camera_groups()` (fast page, then pagination);
`flatten_camera_groups()` ported from the reference collector, reading children
in either shape the API uses; `GET /api/surveillance/camera-groups` (tree +
per-group health, labelled from `sites`), `?group=` on the camera list, and
`groups` on camera detail; `frontend/src/pages/cameras.jsx` — `#/cameras` and
`#/cameras/:id`, ZCD/AP two-column shell, collapse memory, groups with problems
floated to the top, and the six reachability tiers preserved as a select because
seven chips wrap unreadably in a 380px rail. The Surveillance page's Cameras tab
is gone; its school tiles navigate here.

**Two things the tree surfaced immediately**, both by design rather than by
accident: 11 cameras exist in Milestone groups that the registry has never
imported (`WFS` 92 vs 86, `BHS` 265 vs 264, and four more off by one), shown per
group as "N camera(s) in Milestone, none imported"; and the eight unlabelled
groups above. The collector also had to be reordered — the group walk now runs
*after* the camera and recording-server writes, because placed before them a
tree failure skipped the whole inventory refresh.

### S3b — thumbnail wall — **done 2026-09-07, with S4**

Not a Table/Thumbnails toggle in the end. The wall fills the right pane **while
no camera is selected**, and the detail replaces it on click — which is ZCD's
own two-pane Cameras tab, and means the pane always shows the most useful thing
for where you are rather than needing a mode switch. Capped at ZCD's 48 with the
cap stated, because beyond that it is 48 simultaneous proxied fetches into the
camera VLAN and nobody reads 2,662 tiles.

**Paged, not truncated (added 2026-09-08, owner-directed).** 48 stays the page
size — it is the proxy's concurrency bound, not a cosmetic limit — but it is no
longer the end of the wall. "First 48 of 1,204, narrow the filter to see
others" meant the other 1,156 cameras were unreachable from this pane unless
you could already name one, which is the opposite of what a wall is for.
Prev/Next plus first/last (shown only past two pages), the range and page
position in both the card kicker and the pager strip, and Prev/Next present but
disabled at the ends rather than vanishing.

Two details that are the whole reason it is not three lines: the page resets on
a **filter** change and not on a data refresh (the fleet reloads every 30s and
hands down a fresh array; resetting on that would send a wall left open on page
7 home twice a minute), and the page index is **clamped at render** rather than
corrected in state, so a filter that shrinks the fleet while page 7 is open
shows the new last page instead of an empty grid. Each page fetches its own 48
stills on open, which the footer says.

### S4 — camera snapshot proxy (D7) — **built 2026-09-07, default-off**

Everything except the credential, which is the owner's to provision. The code
ships complete and disabled; one config block turns it on with no deploy.

**What made this buildable now** is S2's collection: `https_enabled`,
`https_port` and `channel` are the three fields the URL cannot be built without,
and all three arrived in migration 027.

**The findings that shaped it, all live rather than assumed:**

- **The scheme is not in the address.** Milestone stores 100% of hardware
  addresses as `http://<ip>/`, while `httpSEnabled` says **1,695 of 2,651
  cameras (64%) speak TLS** and 956 do not. Assuming either fails on hundreds.
- **178 cameras are one imager of several.** A bare `/snap.jpg` on such a device
  returns a *different imager's* picture — a plausible image of the wrong place,
  which nobody notices. So `channel > 0` is **refused** with a reason until
  `[camera_snapshot] channel_param` is confirmed against a real device. Refusing
  is the whole point: this is the one failure mode that looks like success.
- **Six cameras carry an explicit port**, five of them `:443` on an `http`
  scheme. Kept as stored; the scheme is never inferred from the port.
- **The vendor field is a driver name**, not a vendor: `Bosch1ch` (2,019),
  `Bosch` (509), `ONVIF` (91), four Axis variants (32). Profiles match on a
  lowercase prefix. Bosch's `/snap.jpg?JpegSize=` is verified from ZCD
  production; Axis uses VAPIX `image.cgi`; **ONVIF is refused with a reason**
  because it publishes its snapshot URI through the Media service over SOAP and
  a guessed path would 404 on all 91.

**Shape:** `GET /api/surveillance/cameras/{device_id}/snapshot?size=M`, viewer
role. The caller passes a `device_id` and nothing else — never a URL, host or
address — and the target is rebuilt from the `cameras` row joined to
`devices.device_type = 'camera'`, so the join rather than a separate check is
what makes a switch impossible to target. `size` is whitelisted exactly as ZCD's
`normSize` does. `netmon/snapshot.py` holds the URL construction as pure
functions, which is where every trap above is tested.

**Every failure carries `X-NetMon-Reason`**, and the UI reads it: a tile that
cannot show a still says *why*. "Proxy disabled", "no profile for this driver",
"imager 2 of a shared device" and "camera rejected the account" are four
different problems, and a blank frame conflates all of them with a dead camera —
which is the thing this page exists not to do. That is also why the components
fetch the image themselves rather than using `<img src>`: an `<img>` cannot read
a response header.

**A camera both probes agree is gone is not asked at all** — the fetch would sit
for the full timeout, and 48 of those stall the wall. A *Milestone-down* camera
**is** asked, because the network can still reach it and a still is the quickest
way to tell a platform problem from a dead camera.

**The invariant this knowingly relaxes:** CLAUDE.md §6 says pages read only
NetMon's DB, with zero source calls at render. This is a device call at render
time. It is bounded — `max_concurrent = 8`, a 5s browser cache, a 48-tile cap,
`enabled = false` by default — and turning it off returns the pages to DB-only
with no deploy. Recorded here rather than left implicit.

**To turn on:** add the read-only camera account to `/etc/netmon/netmon.conf`
under `[camera_snapshot]` (`enabled = true`, `user`, `pass`) and restart. The
section is documented in `netmon.conf.example`. Loading a config that enables it
with no `user` is refused at boot rather than serving silent 503s.

**Both schemes, tried in order (added 2026-09-08, owner instruction).** The
proxy no longer trusts `cameras.https_enabled` as its single attempt: it builds
two candidates per camera — **https first, then http** — and moves to the second
when the first fails at the transport (`build_candidates` in `netmon/snapshot.py`
replaces `build_url`). The stored flag comes from `hardwareDriverSettings.
httpSEnabled` and splits the estate 1,695 TLS / 956 plain, but it was wrong in
the field, and a camera that answers on the other scheme is a working camera
showing an empty tile. Each candidate carries the port that belongs to *its*
scheme, so `https_port = 8443` does not leak into the http URL; the one case
where a port does carry over is the five `http://ip:443` cameras, where 443 is
the other scheme's own default and the camera answers there either way.

The order is a preference, not a sweep: a transport failure moves to the other
scheme, a 401 moves to the other password (never to the other scheme — a camera
that answered 401 speaks this one), and any other answer is the answer. Failing
both names both, so the tile can separate a wrong scheme from an unreachable
camera. Trying https first is cheap when it is wrong — a closed 443 refuses the
connection rather than burning `connect_timeout_s` — and the scheme that
answered is remembered per camera alongside the password.

**A `%` in a password is a `%` (fixed 2026-09-08).** `load_config` built its
`ConfigParser` with the default `BasicInterpolation`, which treats `%` as
syntax: `%%` collapses to one `%`, a lone `%` raises. The proxy therefore sent
an 11-character password where the file held 12, alb-cam-100 answered 401, and
the tile said "camera rejected both configured passwords" while the value as
written authenticated by hand. `interpolation=None` now, in `netmon/config.py`
and `scripts/zabbix_export.py` — a file of credentials must hand back exactly
what was typed — with a regression test over a `%`-bearing password, SNMP
community and DB URL, and the rule stated at the top of `netmon.conf.example`.

**Two passwords, one account (added 2026-09-08).** `pass_backup` is an optional
second password for the same account, tried only after a camera answers 401 to
`pass`. 2,651 cameras are not all on one password: a rotation reaches the
cameras that were online for it, while the ones that were down, or were
installed before it, still answer to the previous one — and with one credential
those tiles read "camera rejected the configured account", leaving someone to
work out per camera which password it is on. The winner is remembered per
`device_id` in a process-local map (`_snap_cred`, beside `_snap_scheme`), because
a 48-tile wall that refreshes would otherwise pay the same dead socket and the
same 401 on every tile forever; the maps are an optimisation only — empty costs one extra 401 per camera, a stale entry
self-corrects on the next fetch, and nothing is persisted. Empty passwords are
dropped rather than sent, so a blank credential cannot masquerade as a rejected
account. With no `pass_backup` the path is exactly as before: one request, and
the reason header says "the configured account" rather than "both configured
passwords".

### S3-original — Cameras tab: navigator + thumbnail wall (superseded)

- `380px 1fr` grid. **Camera Navigator** reuses the Wireless page's `SiteGroup`
  idiom (`host-nav-*`, collapse memory in `localStorage`, collapsed-by-default
  except the active site, "a collapsed group still confesses its problems"):
  groups are real `devices.site`, LEDs are the reachability tier (blind outranks),
  rows "name / ip · model", per-group `n↓` = `down_confirmed + down_source_only`.
  Search · `seg-toggle` All / Up / Down(any) / Blind (NetMon vocabulary; ZCD's
  Online/Warning/Offline collapses the tier that decides the remedy — spec 19 §14)
  · site select. Fed by the existing `/api/surveillance/cameras` (2,651 rows,
  ~0.5 MB — ZCD shipped the same; if it drags, add `?fields=nav`).
- Right pane: **Table | Thumbnails** toggle. Table = today's, moved in. Thumbnails
  = `.cam-grid` of `CamThumb`, first 48 of the filtered set (ZCD's cap), `<img
  loading="lazy">` from the S4 proxy; tier-tinted border (`err` for the two down
  tiers, `warn` for no-ICMP/blind); `NO SIGNAL` overlay for the down tiers; when
  the proxy answers 503 (no credentials) or 501 (no vendor profile) the tile shows
  *that* text instead of a fake gradient. Clicking a tile → `#/camera/:id`.

### S4 — D7: the camera snapshot proxy (1 session + **owner gate**)

D7 was approved 2026-07-28 with one prerequisite — the proxy must resolve only
registered camera addresses. That is now met: spec 19 M0 synced `cameras.ip` /
`http_port` for 2,649 cameras. What remains needs the owner:

- **Credentials.** ZCD used the read-only login in `{$TCS.CAM.USER}/{$TCS.CAM.PASS}`.
  NetMon needs the same in `/etc/netmon/netmon.conf` under a new
  `[camera_snapshot]` (`enabled = false` default, `user`, `pass`,
  `verify_ssl = false` — cameras use self-signed certs on the VMS network,
  `connect_timeout_s = 3`, `timeout_s = 6`, `max_concurrent = 8`,
  `cache_s = 5`). This touches credentials → ask before wiring.
- **Endpoint** `GET /api/surveillance/cameras/{device_id}/snapshot?size=M`
  (viewer role): looks up `cameras` by `device_id` where `devices.device_type =
  'camera'`; never accepts a host, URL or IP from the caller; builds the URL from
  `ip`, `http_port` and a **vendor profile** keyed on `cameras.vendor`
  (migration 025): Bosch `/snap.jpg?JpegSize={S|M|L|XL|WxH}` (ZCD's path — the
  estate is Bosch-first); Axis `/axis-cgi/jpg/image.cgi?resolution=…`; Hanwha
  `/stw-cgi/video.cgi?msubmenu=snapshot&action=view`; unknown vendor → 501 with a
  reason header. Two design corrections spec 11 D7 already recorded apply here:
  Milestone stores every address as `http://`, so the scheme comes from
  `hardwareDriverSettings.httpSEnabled`/`httpSPort` (collect both into `cameras`
  in S2), not from an assumption; and for the ~241 cameras that are channels on a
  shared encoder a bare `/snap.jpg` returns the *wrong imager* — the channel index
  (Bosch `?Channel=n` on `snap.jpg`, Axis `camera=n`) has to enter the per-vendor
  path, so `cameras` also needs the channel number from the Config API record.
  `size` is whitelisted exactly as `ActionCameraSnapshot::normSize`
  does. httpx with Basic/Digest negotiation, no redirects, streams the body back
  with `Cache-Control: private, max-age=5`. Failures return 404/502/503/504 with
  `X-NetMon-Reason` so the tile can say why.
- Read-only and idempotent, so it is **not** a D4 write action; but every fetch is
  a NetMon→device HTTP call at page-view cadence (48 tiles × viewers), which is the
  one place the "zero source calls at render" invariant is knowingly relaxed —
  record that in spec 11 D7's entry, cap concurrency, and keep it off by default.
- Tests: fake httpx transport; asserts on the address allow-list (a `device_id`
  that is a switch → 404), size whitelist, vendor routing, and the reason headers.

### S5 — Camera detail in ZCD's layout — **done 2026-09-07**

Built as specified below, with the substitutions the data forced. ZCD's own
camera page is DEMO-bannered — its rings, sparklines and stream fields render
from `nvr-data.jsx` fixtures and its Smart Client / Restart Stream buttons do
nothing — so this took the structure and filled the slots that have a source.

**Same structure:** `PageHeader` (name · address · model chip · pills for state,
Milestone group, site, recording, recorder, MAC, cache age) · four tabs
(Overview / Live / Events / Configuration, the tab in the URL) · `320px 1fr`
with the sidecar left (status line, 16:9 preview with ZCD's corner overlays,
Open-live-view, Location / Hardware / Recording-server blocks) and the tab's
cards right, in ZCD's order.

**Three slots keep their position and change their mark**, because the data is
shaped differently:

| ZCD slot | ZCD's mark | Here | Why |
|---|---|---|---|
| Device Health | 4 rings: CPU, memory, ICMP latency, packet loss | 4 probe cells: Reachability, Milestone, ICMP, Recording | NetMon has none of ZCD's four per camera (CPU/memory need D10; the poller records up/down without timing). It *does* have four categorical verdicts, which is more than ZCD shows and cannot be drawn as a dial |
| Live Telemetry · 24h | 4 sparklines | transition strip from `state_events` | per-camera series would be 2,662 series in a ring buffer kept deliberately low-cardinality (D3). Transitions are per-device and real — all 2,651 cameras have history |
| Live preview | snapshot via the proxy, over a decorative gradient | framed "No preview" + the reason + Open-live-view | there is no proxy until S4/D7, and ZCD's gradient reads as a dark scene, i.e. as though the camera were working |

**Two things this page does that ZCD's cannot:** the Active Issue card runs the
real alert lifecycle (Ack / Suppress 1h against `/api/alerts`) where ZCD's
Acknowledge is inert; and the uplink card resolves the port from NetMon's own
FDB sweep and cross-checks PacketFence, rather than trusting PF alone. ZCD's
four operator buttons are all present — View in PF, Reevaluate, Restart port,
Cycle PoE — each self-hiding when its target is unknown, all through the audited
chokepoint.

**Live coverage after the build:** 2,651 of 2,651 cameras carry transition
history; 2,465 of 2,662 resolve a switch port by MAC (migration 025's identity
backfill, against 1,532 when the MAC had to come from PacketFence); 329 open
camera alerts feed the Active Issue card.

**A finding the transition strip surfaced immediately:** eight cameras changed
verdict more than 20 times in 24 hours, two of them badly — `bhs-cam-23` 235
times and `tct-cam-73` 114. Four more are channels of one Bosch multi-imager at
`10.132.18.198`, which is a single device flapping and being counted four times.
That is worth chasing on its own; it is also the strongest argument for the
strip, since a sampled sparkline would have averaged it away.

### S5-original — Camera Detail parity (superseded)

Adopt ZCD's structure, fill it with NetMon's data, drop what nothing feeds:

- `PageHeader`: name · `ip[:port]` · model chip · pills: tier pill (blind
  outranks), site, recording (rec-pill), RS (link → Servers tab filtered),
  MAC (mono), cache age · range "Last 24h".
- Tabs **Overview · Live · Events · Configuration** (ZCD's four).
- **Sidecar (320px):** status line · `live-large` still from S4 with the
  name/timestamp/res·fps·codec overlays and `NO SIGNAL` for down tiers; when the
  proxy is off, the frame carries the reason text · buttons: *Open live view ↗*
  (`https://ip[:port]/` in a new tab — ZCD's link-out; no credentials in the URL)
  and *Milestone web client ↗* only if `[milestone] web_client_url` is set (ZCD's
  "Smart Client" button was inert; Smart Client is a desktop app) · Location
  (site), Hardware (vendor · model · firmware · serial · MAC), Recording Server
  blocks. No "Restart Stream" — there is no read-only way to do it.
- **Right column:** *Active Issue* = open alerts on this device (rule name,
  since, severity; Ack / Suppress via the existing alert endpoints) · **Probes**
  = today's 4 cells, kept in place of ZCD's empty CPU/Mem rings (those arrive
  with D10, spec 13 §6, and slot into the same card) · *Reachability · 24h* = a
  state strip drawn from `state_events` for this device (tier changes over the
  window — honest, and it uses the transition log as designed) · *Stream
  Configuration* kv (codec, resolution, fps target, bitrate mode, recording mode)
  · *Network & Identity* kv (IP, HTTP port, MAC, vendor, firmware, serial, RS) ·
  **PacketFence & Uplink** = today's uplink card + PF card merged into ZCD's one
  card, with the four buttons: *View in PF ↗*, `ActionButton reevaluate_access`,
  `ActionButton restart_port` labelled **Restart switch port** (ZCD called it
  "Reboot", which overstates what PF does), `ActionButton poe_cycle` gated by
  `poe_cycle_safe` exactly as now · *Siblings on this device* (NetMon-only; keep)
  · *Recent Events* = `state_events` + closed alerts for this device, ZCD's
  `.event` rows.
- `#/camera/:id?tab=…` in the hash; render-check cases for every tab with a
  blind camera, a down_source_only camera, and a camera with no IP.

### S6 — Sites · Servers · Storage · Alarms · Evidence Lock — **done 2026-09-08**

Built as specified below, with four things worth recording because they were
decided against the live estate rather than at the desk:

**Evidence Lock is a named gap, not a tab that was skipped.** Probed on the live
gateway 2026-09-08: `GET /api/rest/v1/evidenceLocks` answers **400 · "Bad
request: Unknown request"** and the singular spelling 404s. The Config API on
2025 R2 does not publish locks at all — they belong to the Management/Event
server interface the MIP SDK speaks. The tab therefore exists, quotes the
gateway's own answer, and points at Smart Client's *Search → Evidence lock
list*. ZCD's version was a mock with inert Extend/Export buttons, so nothing
working was lost.

**The storage ring is drawn only when there is a fraction.** A ring is a claim
about proportion; with no consumed-space field there is no proportion, and an
arc over a number nobody measured is the most misleading thing this page could
show. `StorageView` renders the ring when `storage_used_known`, and otherwise
puts the configured total in the ring's slot with the reason beside it.
Over-commit stays named. Both branches are render-checked, so the honest branch
is exercised at build time and not only on an estate that happens to lack the
figure.

**Capacity bars compare, they do not fill.** Configured GB has no denominator,
so every bar on Sites, Per-school capacity and Recording Servers is scaled to
the largest peer, coloured differently from the ok/warn utilisation bars, and
carries the words "used —" in the cell. A bar that looks like utilisation gets
read as utilisation.

**`/site-context` grew the half it was already documented to carry.** It now
returns `switches`, `aps` and `recorder_names` beside the recorders, storage and
retention. Two queries stitched in Python rather than one join, because a school
can have recorders and no switches or switches and no recorders, and an inner
join would drop exactly the school whose cameras have nowhere to record.
`GROUP_CONCAT` was avoided on purpose: its `ORDER BY`/`SEPARATOR` spelling is
MariaDB's and the tests run on SQLite. Retention across two recorders at one
school is `MAX`, never `SUM` — the same error that once reported 106 days for a
45-day live plus 61-day archive.

**Alarm row actions work, and a viewer is told rather than refused.** Ack /
Assign / Suppress 1h reuse the Problems console's handlers so the two consoles
cannot drift; the buttons appear for `operator`/`admin` only, and a viewer gets
one sentence saying why. The footer states what Suppress actually does — a
one-hour maintenance window that stops the engine emailing and does not stop the
state being recorded, so the alert stays visible and keeps updating.

The original plan, unchanged:


- **Sites:** ZCD table minus Network/VLAN: dot · site (+ "n switches · n APs")
  · recording server(s) · cameras `up / total` · health pill (`all clear` or
  `n down · n Milestone-down`) · storage bar of **configured** GB with "used —"
  · retention · chevron → Cameras tab filtered.
- **Recording Servers:** dot · host · **Service** pill (ESS RS state from S2) ·
  site · cameras · recording · storage bar (configured; used "—") · retention ·
  version. CPU / Mem / RAID / uptime columns are omitted, not shown as 0: the
  header note says "host metrics need WinRM (#111)".
- **Storage:** ZCD layout — *Fleet storage* card with the `Ring` **only when
  `storage_used_known`**, otherwise the ring slot carries the configured total
  and the one-line reason (today's OverviewTab text) · *Per-site capacity* rows ·
  *Storage volumes* table = today's Storage table in `.link-tbl`. Over-commit
  (configured > disk) stays a named gap until WinRM.
- **Alarms:** open alerts on surveillance devices with ZCD's two `.trig-filter`
  groups (severity; open/acked) and **working** Ack / Assign / Suppress 1h (reuse
  Problems' handlers — ZCD's row actions were inert). Row → `#/camera/:id`.
  Filter param on `/api/alerts` from S1.
- **Evidence Lock:** investigate `/api/rest/v1/evidenceLocks` (GET) on the live
  gateway. If it exists, one collector call → `snapshot_cache['milestone.evidence_locks']`
  and ZCD's `.ev-card` grid (read-only; no Extend/Export). If not, ZCD's empty
  state with the reason. Either way the tab exists so the nav matches.

### S8 — Bulk camera operations: configuration change + firmware update (D11)

**Owner-requested 2026-09-07; recorded as gate D11 in spec 11 §6.** This is the
first NetMon write outside D4's four calls, and it is a different kind of write:
D4's actions go *through a platform* (PF, XIQ, rConfig) that validates them; a
firmware push goes **straight to the camera**, fleet-wide, and a wrong image or
an interrupted upload bricks the device. ZCD never had this — nothing in the
bundle does firmware — so there is no layout to copy; the design has to be
NetMon's own. The owner's approval in principle is the sign-off; the conditions
below are the same D4 got, plus the ones a fleet-wide hardware write needs.

**Two operations, one machinery.**

| Op | What it does | Vendor mechanism (all HTTP to the camera, credentialed) |
|---|---|---|
| **Bulk config change** | apply one setting from a closed catalogue to a selected set of cameras | Bosch RCP+ over HTTP (`/rcp.xml?command=…`); Axis VAPIX `param.cgi?action=update`; Hanwha SUNAPI `stw-cgi/*.cgi?msubmenu=…&action=set` |
| **Bulk firmware update** | upload a vetted firmware image to a selected set, staged | Bosch `/upload.htm` (multipart, then reboot); Axis `firmwaremanagement.cgi` (upgrade + status); Hanwha `system.cgi?msubmenu=firmwareupdate` |

Pilot vendor is **Bosch** (the estate's majority and the owner's existing template
knowledge — spec 13), profile-extensible like the snapshot proxy. Each vendor
profile is one module under `netmon/cameras/vendors/`, fixture-tested against a
fake transport before it ever sees a device.

**Design conditions (non-negotiable, mirroring D4 §4.1–4.3 and adding the
hardware-write ones):**

1. **Admin role only** (D4 used `operator`; bricking risk raises the floor).
2. **Closed registries.** The setting catalogue and the vendor profiles are code,
   not user input — a request names a catalogue key and a value the profile
   validates; it never carries a URL, path, command string or arbitrary
   parameter name. Firmware images are referenced by an id in a NetMon-managed
   store, never by a caller-supplied path or URL.
3. **Firmware store** — `/var/lib/netmon/firmware/<vendor>/<file>` uploaded by an
   admin through NetMon (or dropped on disk), recorded in a new `firmware_images`
   table with vendor, **model allow-list**, version string, SHA-256, size,
   uploaded-by/at. A push refuses any camera whose `model` is not on the image's
   allow-list, or whose current `firmware` already equals the target.
4. **Batches, not loops.** A request creates a `camera_batches` row (op,
   catalogue key/value or image id, selection = explicit device ids, status,
   created by/at) with one `camera_batch_items` row per camera (`pending →
   running → verified | failed | skipped`, per-item message, started/finished).
   The batch runner is a supervised task like the collectors; it survives a
   restart (items are idempotent and re-checked from state), and every item goes
   through the D4 audit chokepoint (`action_audit`) so the record is one place.
5. **Pre-flight, per camera, refuses rather than warns:** `reachability = up`
   (both probes), `source_status = up`, vendor profile exists, model allowed,
   credentials configured, not inside an active `maintenance_windows` exclusion
   the owner marks as "no-touch", and — for firmware — not already at target.
   The batch preview shows the refused items and why before anything is sent.
6. **Canary first, then rings.** A firmware batch runs its first `canary_count`
   cameras (default 1) and **stops** until each reports the new version back
   through the read path (Milestone `hardwareDriverSettings.firmware` after the
   identity backfill, or the vendor's own version endpoint), then proceeds in
   rings of `ring_size` (default 10) with `max_concurrent` (default 3) uploads at
   once and a hard `max_batch` cap (default 50 per batch; the whole fleet is 2,651,
   so a full roll is many batches by design). Any ring with a failure rate above
   `abort_pct` (default 10 %) halts the batch. Config changes use the same rings
   with a higher default `max_batch`.
7. **Verification is a read, not the write's return code.** An item is `verified`
   only when the read path shows the new value/version; `failed` when the device
   comes back with the old one or does not come back within `reboot_timeout_s`
   (default 300). A camera that does not return is an alert, not a log line.
8. **Dry-run is the default.** `[camera_ops] enabled = false`,
   `dry_run = true`, `config_change = false`, `firmware_update = false` — the same
   shape as `[actions]`. Dry-run walks pre-flight and writes the batch/items with
   `would_run`, sends nothing. The owner flips the flags per operation.
9. **Scheduling.** Batches carry an optional `not_before`; the default UI offers
   "tonight 22:00" — firmware never rolls during the school day unless an admin
   types the confirmation phrase.
10. **Milestone stays untouched.** No Config-API write; Milestone re-learns the
    firmware via the identity backfill already running. Recording gaps during a
    reboot are expected and shown on the batch item, not hidden.

**Surface:** a *Bulk actions* tab on the Cameras page (admin only), reachable from
the navigator's multi-select and from the Sites tab ("all at this school"):
select → choose operation → preview (allowed / refused with reasons) → dry-run
result → confirm → batch page with the ring progress, per-item state, abort
button. `GET /api/surveillance/batches`, `POST …/batches` (creates, dry-run by
default), `POST …/batches/{id}/start`, `POST …/batches/{id}/abort`,
`GET …/firmware`, `POST …/firmware` (upload). Plus the vendor **read** side that
S2/D10 do not yet cover and that verification needs: current firmware and a
config read-back per catalogue key.

**Owner answers 2026-09-07:**

1. **Setting catalogue — deferred** ("later item"). So the catalogue, and with it
   bulk *config change*, is not designed yet. The batch machinery is built
   op-agnostic so the catalogue can arrive later without reworking it.
2. **Firmware images — yes**, provenance as proposed: the owner downloads the
   vendor image, uploads it through NetMon, admin only, SHA-256 + model
   allow-list recorded on upload.
3. **XProtect's own firmware push is not in use** — but the owner asked whether
   NetMon could *drive* it rather than talking to cameras directly. Recorded as
   an S8 investigation, because it is genuinely the better shape if it exists:
   Milestone already holds the device credentials and the hardware inventory, and
   a VMS-mediated push means the VMS knows recording is about to pause instead of
   discovering a camera vanished. **It is also a write to Milestone, which every
   integration is currently forbidden from doing (CLAUDE.md §4.1), so it needs
   its own sign-off even though D11 is approved** — D11 covers writes to
   *cameras*, not to the VMS. The investigation is read-only: does the Config API
   expose a firmware/software-update resource on 2025 R2 at all (`/api/rest/v1`
   surface walk), and does it cover the Bosch models this estate runs. If yes,
   compare the two paths before building either; if no, the direct path stands.

**One consequence of (1) worth stating plainly:** deferring the catalogue inverts
the planned risk order. The design sequenced config-change first *because* it is
the reversible half — a wrong NTP server is a support ticket, a wrong firmware
image is a truck roll — and firmware second, after the machinery had proven
itself on low-stakes batches. With the catalogue deferred, the first thing S8
would ship is the dangerous half. Two ways to keep the intended safety margin,
owner's choice:
- **preferred** — run the firmware machinery in `dry_run` and then against a
  deliberate lab/spare camera for the first several batches, treating that as the
  proving ground the config-change half was going to be; or
- name two or three uncontroversial settings now (NTP + time zone would do) so a
  minimal catalogue exists purely to exercise the batch runner.

Either way the canary → ring → abort discipline is not optional for firmware, and
the first live firmware batch should be watched, not scheduled.

---

#### S8 findings, 2026-09-08 — the investigation, and one blocker it uncovered

**1. Milestone cannot be driven. The direct path stands.** The Config API on this
2025 R2 deployment exposes no firmware or software-update resource. 28 candidate
names — `firmware`, `firmwares`, `firmwareUpdate(s)`, `softwareUpdate(s)`,
`deviceFirmware`, `deviceUpdate(s)`, `hardwareUpdate(s)`, `upgrade(s)`,
`firmwarePackages`, `packages`, `driverUpdates`, `installations`, … — every one
answers **404 "Unknown resource"**. `/api/rest/v1/tasks` *does* exist (200) but
returns `{"array": []}` and is the async-task **result** list, not a catalogue of
invokable operations; `recordingServers/{id}/tasks` is the same and equally
empty. A hardware record's `relations` carries only `parent` and `self`, and
`methods`/`actions`/`operations`/`commands` are all unknown resources.

So the question "could NetMon drive XProtect's own push instead of talking to
cameras?" is answered **no** for the REST API — the same shape as evidence locks
(S6): if the capability exists in this version at all it lives behind the MIP
interface, which NetMon does not speak. **The separate VMS-write sign-off that
option would have needed is therefore moot**, and the direct-to-camera path in
D11 is the only one available.

**2. Firmware strings are not one format, and S8's safety conditions are string
comparisons.** Across all 2,651 cameras:

| form | count | examples | vendors |
|---|---|---|---|
| dotted | 1,732 | `7.83.0027` · `6.60.0065` · `6.50.1` | Bosch, Axis |
| compact | 888 | `783` · `660` · `900` · `761` | Bosch only |
| unreadable | 31 | `5.75.1.4` (4-part, fine) · `03500623` · `64500580` | Axis, ONVIF |

`783` and `7.83.0027` are the same firmware written two ways, and **11 of 38
models carry both forms**, so it is per camera, not per model. Left alone this
breaks the two conditions that make a roll safe:

* condition 3 (skip a camera already at target) would have matched nothing for
  the 888 compact cameras and re-pushed firmware they already run;
* condition 7 (verify by read-back) would have marked a *successful* upgrade
  `failed` when the camera reported `790` and the image said `7.90.0123` — and
  under condition 6 those failures count toward `abort_pct`, so a healthy roll
  would have aborted itself.

Fixed before any batch code exists: `netmon/cameras/firmware.py`, pure functions
with 20 tests over the estate's real strings. The asymmetry is deliberate —
**skipping** compares at the coarsest shared precision (a false "already there"
costs one avoided push), while **verifying** demands the target's full precision
and answers `INDETERMINATE` rather than `VERIFIED` when the camera's own format
cannot express it. An unprovable upgrade is not a successful one. Unreadable
strings return None and the camera is refused, never guessed at — including
4-digit compact values, which are ambiguous (6.100 or 61.00?) and which this
estate does not actually report.

**3. Owner answers, 2026-09-08.**

* **Proving ground: the lab/spare camera** (the spec's preferred option). The
  machinery and the Bosch profile are built and run in dry-run; the first live
  batches go to one deliberate spare before any production camera. *Outstanding
  owner action: nominate that camera.*
* **Read-back: vendor read preferred, Milestone as fallback.** Recorded per item
  in `camera_batch_items.verified_by`, because which one answered changes how
  much the answer is worth.

**4. Built 2026-09-08 — the safety core, no executor.** Migration `029`
(`firmware_images`, `camera_batches`, `camera_batch_items`), `[camera_ops]`
(everything off, `dry_run = true`), `netmon/cameras/ops.py` (pre-flight + ring
planning + dry-run batch creation), `netmon/cameras/vendors/` (closed registry,
Bosch only), and `netmon/cameras/firmware.py`. 40 tests. Nothing sends.

Four decisions inside that are worth stating:

* **The account is not the snapshot proxy's.** `[camera_snapshot]` documents its
  credential as read-only and says it "must not be able to change camera
  configuration" — which is exactly why it cannot push firmware. `[camera_ops]`
  takes its own privileged account, and arming the section without one fails at
  boot rather than refusing every camera at pre-flight and looking like a
  fleet-wide fault.
* **Refused cameras are recorded, not omitted.** Each becomes a `skipped` item
  carrying its reason. A batch that quietly dropped them leaves an operator
  unable to tell a camera that was fine from one that was forgotten.
* **The ring discipline is copied onto the batch row** at creation. A batch must
  play by the rules it was created under; reading them from config at run time
  means editing the file mid-roll silently changes the safety margin of
  something already running.
* **A maintenance window means no-touch here**, not just "suppress the email".
  A window is somebody saying this equipment is being worked on, and pushing
  firmware into that is how two people end up at one camera.

**Bosch profile — transport proven, one gap named.** Live probe of a FLEXIDOME
IP 5000i IR: `GET /rcp.xml?command=…&direction=READ` answers **200 `text/xml`**
with a well-formed `<rcp>` envelope, authenticating with the Digest account
NetMon already holds — so RCP+ is reachable and the write path has somewhere to
go. `/info.xml`, `/version.xml`, `/device.xml` and `/deviceinfo.xml` all 400.
The **command code for firmware version is not derivable**: the camera's own
`/js/rcp.js` is a generic transport library with no command constants (zero
occurrences of "firmware"), and the reference bundle carries no Bosch RCP+
material. So `read_firmware_version` raises `VendorReadUnavailable` rather than
guess a code and send it to 2,528 cameras, and verification falls back to
Milestone — which is exactly the arrangement the owner chose. Filling the gap
needs one line from Bosch's RCP+ documentation, not more code.

**5. Executor built 2026-09-08** (`netmon/cameras/runner.py`, 16 tests against a
fake fleet). Canary gate, ring progression, abort threshold, SHA-256 re-check at
run time, read-back verification, and the audit row per item. Still nothing can
be sent: `[camera_ops] enabled = false` and `firmware_update = false`.

Three behaviours in it that are decisions, not mechanics:

* **An `indeterminate` canary halts the batch**, exactly like a failure. 888
  cameras report firmware in a form that cannot prove a build number, so the
  upgrade may well have worked — and a fleet-wide roll should not proceed on
  "probably". The item records which it was, so nobody has to guess later.
* **The SHA-256 is re-checked when the batch runs**, not trusted from upload. An
  image that changed on disk between vetting and roll is not the image that was
  vetted, and the difference is a bricked camera.
* **A rejected upload is a failure immediately**, not something to wait out. The
  verification wait exists for a camera that is flashing, not for one that
  answered 401.

Verification polls in *attempts* rather than against a wall clock — the first
version deadlocked its own tests for minutes, which is exactly how a hung
verification would behave in production.

**Owner answers wired in, 2026-09-08:**

* **`proving_device_id = 1592`** — `alb-cam-44` (10.21.18.44, TASPA, FLEXIDOME
  IP 5000i IR, fw 7.83.0027). While it is set, pre-flight refuses *every* other
  camera, whatever a batch asks for. The proving ground is enforced in code
  rather than remembered at 22:00 on the night of the first batch.
* **`use_snapshot_credentials = true`** — the owner directed reusing the
  account already in `netmon.conf` rather than provisioning a second. Worth
  recording plainly: that account is `service`, which on Bosch hardware is the
  privileged level, so `[camera_snapshot]`'s "read-only" note describes an
  intention and not an enforced limit. Setting both `user` and this flag is
  refused at load, so which account writes to a camera is never ambiguous.

**Live dry-run, 2026-09-08** — migration 029 applied to production, then a real
batch created against the real registry targeting alb-cam-44 plus three
neighbours:

    ALLOW  alb-cam-44   10.21.18.44   FLEXIDOME IP 5000i IR  fw=7.83.0027
    REFUSE alb-cam-100  proving_device_id = 1592
    REFUSE alb-cam-101  proving_device_id = 1592
    REFUSE alb-cam-102  reachability is down_network_only, not up
    → 1 would_run, 3 skipped, 0 audit rows (nothing was sent)

alb-cam-102 refusing itself for an unrelated reason is the reachability tier
doing its job. The placeholder image row and the demo batch were deleted
afterwards: a 28-byte registered "image" is selectable, and a live batch would
push it to a camera.

**Still to build:** the firmware store upload endpoint, the API
(`/api/surveillance/batches`, `/firmware`), and the admin-only Bulk actions tab.
Then the first live canary on alb-cam-44 — watched, not scheduled.

**6. The vendor read, closed 2026-09-08.** The owner supplied the RCP+ reference
(`docs/RCP_doc_9_80_0106.pdf`, Firmware 9.80, 1,404 pages), which names it
exactly:

    2.612  CONF_SOFTWARE_VERSION_FORMATTED  code 0x0cd4 · Read p_string ·
           access "minimal" · "the software version in the form
           <major>.<minor>.<build>" · CPP6/7/7.3, CPP13, CPP14/15/16
    2.611  CONF_SOFTWARE_VERSION            code 0x002f · Read p_string · "always"

The *formatted* one is used, because `<major>.<minor>.<build>` is precisely the
precision `firmware.verify` needs to answer VERIFIED instead of INDETERMINATE —
which means **the vendor read solves the 888-camera problem**: a camera that
Milestone only ever reports as `783` can prove its own build number when asked
directly.

One gotcha found live and now recorded in code: the answer is **not** in
`<payload>` — that element echoes the request and is always empty. It is in
`<result><str>`. Confirmed on two production cameras, both returning
`7.83.0027`, matching Milestone exactly — the first independent corroboration
that NetMon's stored firmware and the hardware agree.

Also recorded from the doc, for when the write path goes live:

* `CONF_UPLOAD_PROGRESS` (0x0701) is a *message*, not a readable value, carrying
  1-100 % and a precise error taxonomy — "wrong or no signature", "flash type
  incompatible", "version too low" — now in `bosch.UPLOAD_ERRORS`. Those are the
  words a failed push should be explained in; "the version did not change" is
  not one of them.
* `CONF_UPLOAD_HISTORY` (0x0b44, Read p_octet) keeps the last ten uploads and is
  readable over this interface. Not parsed yet: its binary ring-buffer layout
  cannot be checked against anything until a real upload has happened.
* `CONF_DEVICE_CAPABILITIES` tag 30 `FW_UPLOAD_SIGNATURE_TAG` says whether a
  device **requires signed firmware** — a pre-flight check worth adding before
  the first ring, since an unsigned image on such a device fails at error 118.

The doc contains no upload endpoint; it covers RCP+ commands only. So
`/upload.htm` remains what spec 20 asserts and what the proving camera will
confirm or refute — which is exactly what a proving camera is for.

**7. The platform gate, 2026-09-08 — found before anything was pushed.** The
owner supplied `CPP14_FW_9.80.0106.fw` and nominated alb-cam-44 as the proving
camera. Those do not go together, and the model allow-list would not necessarily
have caught it, because allow-lists are typed by people and this is the mistake
a person makes.

The camera settles it itself. Every command in the RCP+ reference carries an
availability row for CPP6/CPP7/CPP7.3, CPP13 and CPP14/CPP15/CPP16, so a command
that exists on exactly one generation identifies the generation when asked — an
unsupported command answers HTTP 200 with `<result><err>0x40</err>`, not an HTTP
error. Probed live:

    | model                      | fw        | 0x0d26 | 0x0d1b | 0x0a08 | platform    |
    | FLEXIDOME IP 5000i IR      | 7.83.0027 | err    | err    | 4      | CPP6/7/7.3  |
    | FLEXIDOME IP 4000i         | 7.72.0008 | err    | err    | ok     | CPP6/7/7.3  |
    | FLEXIDOME indoor 5100i IR  | 9.00.0210 | ok     | ok     | err    | CPP14/15/16 |
    | FLEXIDOME outdoor 5100i IR | 9.00.0210 | ok     | ok     | err    | CPP14/15/16 |
    | FLEXIDOME multi 7000i      | 8.00.0155 | err    | err    | err    | unknown     |

So the CPP14 image belongs to the **5100i family** (≈299 cameras on 9.00.0210),
not to the 5000i/4000i fleet (≈1,900 cameras on 7.x) that includes the proving
camera. The owner then supplied `CPP7.3_FW_7.93.0024.fw`, which is the right
pairing: alb-cam-44 is on 7.83.0027 and the image is 7.93.0024.

Migration `030` adds `cameras.platform` and `firmware_images.platform`.
Pre-flight refuses a stored contradiction so a *preview* can say it before
anyone approves a batch, and the runner probes again live immediately before
each upload, storing what it learns. Only a contradiction is fatal: an image
with no platform recorded falls back to the model allow-list, which is where it
was before.

**Both images registered, 2026-09-08:**

    #2  7.93.0024  CPP6/7/7.3   CPP7.3_FW_7.93.0024.fw    91 MiB
        models: FLEXIDOME IP 5000i IR
    #3  9.80.0106  CPP14/15/16  CPP14_FW_9.80.0106.fw     988 MiB
        models: FLEXIDOME indoor 5100i IR, FLEXIDOME outdoor 5100i IR

Each allow-list holds only models **probed** on that platform. Widening them is a
deliberate act against Bosch's release notes, never an assumption. The files live
in `/var/lib/netmon/firmware/bosch/`, not in the repo — a gigabyte of vendor
binary does not belong in git, and the store is where `firmware_dir` points.

**Dry-run against the real registry, both images:**

    CPP7.3 image → alb-cam-44   ALLOW   (7.83.0027, would upload 7.93.0024)
                 → arc-cam-100  REFUSE  model not on this image's allow-list
    CPP14 image  → alb-cam-44   REFUSE  model not on this image's allow-list
                 → arc-cam-100  REFUSE  proving_device_id = 1592

**One correctness fix the 988 MiB image forced:** `load_image` returned the whole
file as bytes and handed the same buffer to every concurrent upload. It now
verifies the SHA-256 by streaming and returns the *path*, and each upload opens
its own handle — a gigabyte of resident data per batch bought nothing.

**8. The admin surface, built 2026-09-08.** `netmon/api/camera_ops.py` (15
tests) and a Bulk-ops pane on the Cameras page (5 render-check cases).

* `GET /firmware`, `PUT /firmware/{vendor}/{filename}`, `POST /firmware`,
  `GET|POST /batches`, `GET /batches/{id}`, `POST /batches/{id}/start|abort`,
  `GET /camera-ops`. **Admin on every one** — D4's actions are operator, and
  this goes straight to hardware.
* **Upload is a raw streamed body, not multipart.** Parsing a 988 MiB multipart
  form needs `python-multipart`, a dependency this project has not taken and did
  not need: there is one file and its name is already in the path. The body is
  written to disk in chunks and hashed as it lands.
* **Placing a file and registering it are two acts.** Placing decides nothing;
  registering is where the model allow-list and platform are typed, and those
  are what decide which cameras may ever receive the image.
* **Arming takes two locks.** A request cannot set `dry_run = false` while
  config says dry-run, so no single request and no single mistake can put
  firmware on a camera.
* `start` runs the guards *before* creating the task — flags, schedule, a
  missing or altered image — so a caller is told now rather than finding a
  failed batch later. It returns when the batch is running, not when it
  finishes: a roll takes minutes per ring and progress lives in the rows.
* `abort` stops the batch progressing; it deliberately cannot interrupt an
  upload in flight, because a half-written flash is worse than a finished one.

The UI leads with the **gates** — every condition between a click and a camera
being flashed, in the order the code checks them, closed ones tinted. "Why is
the button disabled" deserves an answer on the page. There is no select-all (a
full roll is many batches by design), no config-change tab (the catalogue is
deferred, so a button there could only ever be refused), and the pane is reached
by URL rather than a tab strip — it is not somewhere to land while browsing a
wall of stills.

**Owner confirmed 2026-09-08:** alb-cam-44 is the proving camera, knowing it is
a live recording camera at TASPA and that a flash interrupts its recording for
the reboot.

### S8 — the first live canary, 2026-09-08: failed safely, and taught three things

Owner armed `[camera_ops]` and directed the run. Batch 3, one camera
(alb-cam-44), image #2 (7.93.0024, CPP7.3, 91 MiB). **Nothing was flashed. The
camera was untouched and still answers 7.83.0027.**

What happened, in order: the platform probe ran and matched (CPP6/7/7.3 both
sides), the audit row was written *before* anything left, the POST to
`/upload.htm` was accepted at the socket and then dropped — `httpx.ReadError`
after 0.8 s, none of the 91 MiB transferred.

**1. `/upload.htm` was wrong.** Spec 20 asserted it; the camera disagrees. Its
own web UI says where it posts — `js/utils.js`::

    function getZipUrl(zip) { ... return zip ? "zip.xml" : "unzip.xml"; }
    function ajaxUpload(url, file, name, pwd) {
        var formData = new FormData();
        if (pwd) { formData.append("pwd", pwd); }
        formData.append(name, file); ... }

So it is a multipart POST to **`/unzip.xml`**, with an optional `pwd` part.
`UPLOAD_PATH` is corrected. What is still unknown is the **name of the file
part**: `ajaxUpload` takes it from a caller in the settings UI's lazily-loaded
`page_cam_upload` chunk, which the live-view page does not reference. So
`firmware_upload_request` now **refuses to build a request at all** rather than
post a body with a guessed field name. One capture of the browser's own upload
(devtools → Network → the POST to `unzip.xml` → the form-data part name) closes
it, exactly as one line of the RCP+ reference closed the version read.

**2. A transport error killed the whole batch.** The exception propagated out of
`_run_item`, through `asyncio.gather`, out of `run()` — so a single camera
dropping a connection would have ended a 50-camera roll. Now it fails *that
item* and the batch continues (or, for a canary, halts deliberately).

**3. The rows lied.** Because the run crashed, batch 3 and its item sat at
`running` indefinitely — indistinguishable from a batch still working. That is
precisely the staleness this project refuses everywhere else, in the one place
where it would matter most. `run()` now settles every in-flight row before
re-raising, and the halt reason is written where an operator reads it.

A fourth, smaller: `str(httpx.ReadError(""))` is empty, and an exception object
is always truthy, so `f"{exc or 'no detail'}"` produced an empty audit message.
The class name is what makes such a row readable.

All three are covered by a test that reproduces exactly this failure — a fake
camera that accepts the connection and drops it mid-upload.

### S8 — the canary landed, 2026-09-08

**alb-cam-44 is on 7.93.0024, verified by the camera itself.**

    batch 5   done       20:56:11 → 20:58:06
    item      verified   7.83.0027 → 7.93.0024   verified_by = vendor
    audit 7   ok         HTTP 200, 83,385 ms of upload

**The cause of the two failures was neither the endpoint nor the field name.**
It was the digest handshake. Digest sends a request once unauthenticated to
collect the 401, then repeats it with credentials — so a 91 MiB image was being
shipped in full to be told "authenticate first", and this camera drops the
connection rather than reading it. Both attempts died at exactly 0.8 s, which is
a server hanging up on the first bytes, not a transfer failing. A cheap GET now
collects the challenge on the same auth object, and the image goes out
authenticated on its first and only send.

**Correcting the previous entry:** `/upload.htm` was right all along, and
`/unzip.xml` was a wrong turn taken from a plausible string in `utils.js`. The
camera's own service page settles both halves::

    <form method="post" action="upload.htm" enctype="multipart/form-data"
          target="uploadIFrame" id="firmwareUpload">
      <input type="file" name="net.bin" id="fwfile" class="file">

The part name **`net.bin`** was undiscoverable by reasoning — it is not an RCP+
command and appears in no documentation this project holds. It came from reading
the page's markup, reached through the settings bundle's own webpack chunk map
(`1108: "page_cam_upload"` was a decoy; `page_service` is where firmware lives).

**What the run proves, beyond the one camera:** the platform probe matched
before anything was sent; the audit row was written before the bytes left; the
camera went unreachable mid-flash (`ConnectTimeout`) and the poller kept
waiting rather than calling it failed; and verification came from the camera's
own `<major>.<minor>.<build>` answer, not from the POST's 200. Because this was
a single-camera batch, ring 0 was the whole batch — with more cameras it would
now release to ring 1.

**And the two failures were safe failures.** Nothing was half-written, and the
fixes from the previous attempt did their job: the second failed one item
cleanly instead of crashing the batch and leaving rows claiming `running`.

**Known limits, now that it works:**

* `reboot_timeout_s = 300` was enough here (the camera was back in ~90 s), but a
  slower model could exceed it and be recorded `failed` while still upgrading.
  The read-back would correct the record on the next batch; the item would not.
* Milestone's stored firmware still reads 7.83.0027 until the identity backfill
  catches up. The camera and `camera_batch_items.after_value` are the current
  truth, which is exactly why `verified_by` exists.
* One camera is not a ring. The abort threshold and ring progression have been
  tested against a fake fleet, not against hardware.

### S8 — the vendor's CPP table, and a probe that was too coarse

The owner supplied Bosch/Keenfinity's "Which CPP corresponds to certain cameras
and encoders?" table on 2026-09-08, and it corrected something the live probe
had got dangerously wrong.

**The probe proves a band, not a point.** The only legacy marker the RCP+
reference offers (`CONF_CPU_LOAD_VCA`) is documented for CPP6/CPP7/CPP7.3 — and
its availability row does not mention **CPP4 at all**. This estate runs 419 CPP4
cameras (254 `FLEXIDOME IP indoor 5000 HD`, 157 outdoor, 8 panoramic 5000 MP),
every one of which answered that marker and was recorded as "CPP6/7/7.3" by the
first sweep. A CPP7.3 image would then have looked eligible for them.

`netmon/cameras/platforms.py` transcribes the table for the models this estate
runs, with the vendor's CTNs beside each so the mapping can be checked rather
than trusted. Pre-flight and the runner now take **the table as authoritative
for which generation a model is**, and use the probe for what it is genuinely
good at: catching a device that answers as something the table did not expect.
A model the table does not list is refused rather than assumed — that is 69
`FLEXIDOME IP micro 3000i` today, which the article does not cover.

Corrected on the deploy VM: 2,351 stored platforms rewritten from the table, and
69 coarse `CPP6/7/7.3` values cleared, because a band left in a column that
reads like a fact is worse than a NULL.

    FLEXIDOME IP 5000i IR / 5000i / 4000i / 3000i IR   CPP7.3   1,523
    FLEXIDOME IP indoor / outdoor 5000 HD, pano 5000   CPP4       419
    FLEXIDOME indoor / outdoor / pano 5100i IR         CPP14.2    307
    FLEXIDOME multi 7000i (+ IR, 20MP)                 CPP14.1    202
    DINION IP starlight 6000 HD                        CPP7         8
    FLEXIDOME IP micro 3000i                           unlisted    69

`compatible()` requires an exact generation, with one allowance: the vendor
numbers CPP14.1/14.2/14.3 sub-variants sharing a firmware line, so an image
labelled plainly `CPP14` is accepted for those. CPP7 and CPP7.3 are *not*
interchangeable however similar they look, and CPP4 is a different world again.

**Allow-list widened, on the owner's word plus three kinds of evidence.**
`FLEXIDOME IP 4000i` joins image #2 (7.93.0024): the owner said so, the vendor
table lists it as CPP7.3 (NDI/NDE-4502-A/AL), five sampled cameras probe as the
legacy band, and one 4000i on this estate **already runs 7.93.0024**. A
`PATCH /api/surveillance/firmware/{id}` endpoint now exists for exactly this, so
widening is a recorded act rather than a hand-edited row; it refuses an empty
list and cannot touch the file, hash or size, because those identify the image
that was vetted.

Still available to add on the owner's word, both table-confirmed CPP7.3:
`FLEXIDOME IP 5000i` (212 cameras) and `FLEXIDOME IP 3000i IR` (7).

**A Firmware tab on Surveillance (owner-directed 2026-09-08).** The same
machinery, reached from the NOC page rather than only from the Cameras
navigator, and admin-only — a viewer does not see the tab at all, and typing the
URL gets a closed door rather than a hidden one.

The two entrances differ in how a batch is *built*, and the Surveillance one is
the better shape: there is no navigator selection here, so **the image chooses
the cameras**. Pick an image and the tab lists the cameras it is built for —
its own model allow-list decides what is even a candidate — with the ineligible
ones shown greyed and reasoned rather than omitted: `already on 7.93.0024`,
`camera is CPP14/15/16, image is CPP6/7/7.3`, `reachability is down_confirmed`.

That eligibility test repeats pre-flight's logic in the browser, including the
compact-firmware comparison (`793` is `7.93.0024`), for one reason: offering an
operator a batch the server will then refuse entirely is worse than not offering
it. The server pre-flights again and remains the authority.

Selection is capped at `max_batch` with a "select first N" rather than a select
all, and the list stops at 200 rows — a roll is many batches by design, so there
is nothing to gain from rendering 2,000.

**Pick a school (owner-directed 2026-09-09).** That is how a roll actually
happens: one site, one evening, one person who can walk to a camera that does
not come back. 1,170 cameras are eligible for the CPP7.3 image across 23
schools and `max_batch` is 50, so the question is never "all of them" — it is
"which school, and how much of it tonight".

The picker takes a school and filters to it, and says what that school costs:
*"130 camera(s) at TMS match this image's models · 130 eligible now · batches
are capped at 50 — 3 batches to finish TMS"*. The bulk button names the school
it is selecting from.

Three details that are decisions:

* **The chips count the whole estate, not the filtered view.** Choosing TMS must
  not change what Bryant High says it still needs, or the page stops being a map
  of where the work is.
* **A school with nothing eligible stays on the list, dimmed.** "This one is
  done" is worth reading when planning the next evening; hiding it just makes
  someone check by hand.
* **Changing school clears the selection.** Carrying cameras over from the last
  school is how a batch ends up spanning two sites nobody meant to touch
  together.

    TMS 130 · Southview 122 · Bryant High 110 · TASPA 107 · University Place 103
    · Eastwood Middle 100 · Rock Quarry 99 · TCTA 76 · Northridge High 72 · …

### S8 — the proving ground lifted, 2026-09-09

`proving_device_id = 0` at the owner's direction, after alb-cam-44 went
7.83.0027 → 7.93.0024 verified by the camera's own RCP+ read. Every camera that
passes pre-flight is now in scope; the config comment records what was lifted
and when, and setting a device id back re-narrows the machinery to one camera
without a deploy.

**What that changes, stated plainly:** the canary is no longer a camera somebody
nominated in advance. It is now the first camera of whatever batch is created —
so *which camera is first* has become a real choice, made by whoever assembles
the batch, and the picker's name-ordered selection decides it by default.

**What still stands between a request and a camera** (unchanged, and the reason
lifting this one gate is not the same as opening the door):

* the model allow-list — 2 of 18 Bosch models on this estate, so 1,170 of 2,651
  cameras are even candidates;
* the vendor CPP table, exactly matched, with 419 CPP4 cameras and 69 unlisted
  ones refused outright;
* live reachability on both probes, plus Milestone's own verdict;
* no active maintenance window;
* the SHA-256 re-checked against the file on disk at run time;
* a live platform probe immediately before each upload, which fails the item if
  it contradicts the table;
* canary → rings of 10 → halt above 10% failures, 50 per batch;
* an audit row written before any bytes leave, per camera.

Measured at TASPA the moment the gate came off: **137 up cameras → 106 allowed,
31 refused**, every refusal on the allow-list or already-current. That is what a
school looks like now: three batches, and 31 cameras this image was never for.

**Fleet shape for the build:** 2,528 of 2,651 cameras are Bosch (2,019
`Bosch1ch` + 509 `Bosch`) — 95%, confirming Bosch as the pilot vendor; 32 Axis;
91 ONVIF, which have no snapshot path either. 84 distinct model×firmware pairs
across 38 models, so per-image model allow-lists are both necessary and small.

---

**Sequencing:** after S1–S6 and after D7 (S4) has proven the camera-side HTTP
path and credentials in production. Then: batch machinery + firmware store +
Bosch profile in dry-run (2 sessions), the Milestone-mediated investigation above
(half a session, read-only, can run in parallel), first canary batches, then
rings. Estimate 3–4 sessions for the machinery + Bosch profile, 1 per additional
vendor.

### S7 — Liveness — **built 2026-09-08, default-off**

Built as described below, after measuring the stream rather than assuming it.
The spec's own advice was to wait ("the 120 s cadence has been adequate"); the
owner asked for it now, and the measurement is what shaped the result.

**What the estate actually emits.** 120 s of live subscription, taken before any
code was written, because the ESS event schema had never been validated against
this VMS:

    7,366 frames · ~24,000 events
    frame:  {"events":[…]}  — no command or type at the top level
    event:  id, source, specversion, stategroupid, time, type
            — the same six keys a getState state carries, so one parser serves both

    MotionStart 9,354 · MotionEnd 9,311 · RecordingStarted 2,406 ·
    RecordingStopped 2,373 · Recording FPS Warning 520 · LiveClientFeedRequested 171
    … and not one Communication event in the window

Three consequences, which are the design:

1. **Volume is the constraint, not latency.** ~200 events/second sustained. A
   write per event would be 200 transactions/second against tables the
   dashboards read. Events are filtered in memory against a per-connection type
   map and coalesced per camera into one batched `write_states` every
   `ess_live_flush_s` (default 5 s). A failed flush puts its deltas back — but
   never over a newer verdict that arrived while the write was in flight.
2. **Over 99% of the stream must be dropped.** Only `Communication*` moves
   `source_status`. Motion and recording churn is counted and discarded:
   `recording` is a Config-API fact here, and turning 24,000 motion events an
   hour into `state_events` rows would bury the transition log NetMon treats as
   its history (CLAUDE.md §6) under an estate behaving perfectly normally.
3. **A quiet socket is not obviously a dead one.** Overnight the motion that
   dominates this stream stops, so the watchdog is 180 s rather than ws.py's
   60 s default — long enough that an idle night does not force a needless 4 MB
   resync every minute, short enough to notice a dead socket.

**Both readers stay.** The 120 s snapshot inside the Milestone cycle keeps
running: both derive the same dimension from the same interface, `write_states`
records a transition only when a value actually moves, and where they differ the
newer observation wins. That makes the cycle a *repair* for anything the stream
missed while reconnecting — worth more than the bytes it costs. Recording-server
state columns stay the cycle's alone, because it owns that row with a
replace-on-refresh upsert and a second writer would fight it; the live task
therefore subscribes to `cameras` only.

**Supervision.** `Supervisor.register(..., long_running=True)`: no per-run
timeout, because staying connected for hours *is* success, while the exception
boundary and reschedule still apply. Every reconnect re-runs the handshake and
re-applies the full snapshot.

**Observability.** A `collector_health` row (`milestone_ess_live`) plus a
NetMon Status panel — socket state, reconnects, frames, events, state changes
applied, busiest event types. Snapshot states are counted **apart from** stream
events: a connect stages ~2,500 `CommunicationStarted` states, and folding those
into the stream counters makes the stream look like it carries camera changes it
does not. Event *types* are counted, never payloads, and the counter is capped
at 200 keys.

**Verified end-to-end against the live gateway** (2026-09-08, writing to a
scratch DB so production state was untouched): 100 s → 6,168 frames, 21,458
events, 0 reconnects, 2,512 cameras given a baseline from the connect snapshot
(2,421 up / 91 down), and the motion churn dropped as designed.

**Default off** (`[milestone] ess_live = false`). It is a second writer of
camera `source_status` and a socket held open for hours; that is a switch the
owner throws, not something that arrives with an upgrade. The Surveillance page
now polls at 10 s either way, which is what makes the faster state visible.

The original plan:


ZCD patches camera state in the browser over a WebSocket it opens to the
gateway. NetMon must not: pages read only NetMon's DB (CLAUDE.md §6 invariant),
and the browser would need a Milestone bearer. The equivalent is server-side:
promote the ESS from a per-cycle `getState` snapshot (`_ess_camera_status`, every
120 s) to a **long-lived supervised task** that keeps the subscription open and
writes `source_status` deltas as events arrive, reconnecting with back-off; the
Surveillance page then polls at 10 s. Same three verbs (`startSession`,
`addSubscription`, `getState`), still read-only in effect. Do this only once
S1–S6 have been on the glass for a while — the 120 s cadence has been adequate.

---

### S2 follow-up — the Milestone cycle was timing out (2026-09-08)

Reported from the glass: the degraded banner said "groups could not be read"
and NetMon Status showed `milestone` with **61 failures in 517 runs** and
"timed out after 120s". Three separate causes, only one of them mine.

**1. `write_state` per device, 10,000 round trips.** The cycle writes
`recording` for 2,662 cameras plus `source_status` for as many again — over
5,000 calls, each a SELECT plus an upsert in its own transaction. Measured **68s
of a 120s boundary**, while the HTTP it was blamed on totals **21s**. Added
`state.write_states()`: one chunked read-back, one executemany UPDATE, one
INSERT, one event INSERT. Same semantics, including the two that are easy to
lose in a batch — a first observation still counts as a transition from
`unknown`, and `updated_at` is refreshed whether or not the value moved.
**Cycle 68s → 20.5s** for identical output.

**2. A slow endpoint blinded the whole estate.** Three consecutive `/cameras`
failures wrote `source_status = blind` for every registered device. `/cameras`
is 2.9 MB with latency swinging 5–19s, so this fired **about eleven times a day,
940 cameras at a time — roughly 19,000 state events daily**, each episode a
miniature of the storm spec 19 §12 spent a day undoing. Blinding now asks one
cheap question first: `/sites` is a single small record answering in
milliseconds, and if it answers the source is *not* blind — the honest state is
the previous one, left visibly stale. A genuinely unreachable gateway still
blinds, because then stale rows would read as healthy; both halves are pinned by
tests.

**3. The supervisor boundary was tied to the interval.** `timeout_s = max(60,
interval)` = 120s. But this collector shares a host with the SNMP inventory
sweep, which runs **156s**, so a perfectly healthy Milestone cycle measures
~110s when the two overlap — and the boundary killed it, which fed cause 2. Now
`max(300, interval × 2.5)`: long enough that contention alone cannot trip it,
short enough that a genuinely hung cycle is still cancelled. The supervisor
reschedules after completion rather than firing concurrently, so a longer
boundary cannot stack runs.

Verified after: cycle 94s under live contention, 0 failures, no degradation,
blind steady at 139 real cameras rather than 940 fabricated ones.

**Left for the owner, not fixed here:** `snmp_inventory` runs **156s** and is
the box's largest consumer by a wide margin. Nothing is failing because of it
now, but it is what makes every other collector's cycle slow, and it deserves
its own look — the switch sweep is the obvious candidate for the same batching
treatment `write_states` just applied here.

> **Followed up 2026-09-08** — and the guess in that last sentence was wrong.
> The sweep's writes were *already* batched; its cost is SNMP walk time. Taken
> up in `docs/design/109-snmp-inventory-performance.md`, which measured the
> fleet and found the real items: 21% of every pass spent timing out against two
> switches that do not answer SNMP, `poe` costing 36% of the walk time for 2% of
> the data, and — the one that mattered — **a truncated walk being written as
> fact**. `snmpbulkwalk` exits 1 on timeout after printing what it already
> received, and the sweep ignored the exit code, so a lost packet pruned every
> row it never reached and stamped the survivors fresh. Fixed, along with a
> down-host skip and a measured table-walk merge (`poe` −22%, `edp` −66%).

## 4. Rules that hold throughout

- **Copy the layout, not the promise.** Every slot ZCD fills with a zero or a
  mock (Smart Client sessions, RS CPU/Mem/Disk/RAID, storage used, evidence
  locks, camera CPU/Mem) is either omitted or rendered as "—" with the reason in
  the `.sub`/`.h-meta`. `render-check.mjs` gets a case for the unknown-data shape
  of every new component.
- **NetMon's status vocabulary wins.** ZCD's ok/warn/err collapses
  `down_source_only` into `err` (its `camStatusClass` treats ICMP-down as the only
  "err"); NetMon's tiers are what the owner asked for (spec 19 §13). Map to
  ZCD's colours (`err` = both down tiers, `warn` = no-ICMP + blind, `ok` = up) but
  keep the tier words on pills and tooltips.
- **Source badges everywhere ZCD has them**, using NetMon's real provenance
  (`milestone`, `milestone-ess`, `poller`, `snmp`, `packetfence`, `netmon`).
- **No browser→source calls.** Snapshots go through S4's proxy; the ESS stays
  server-side (S7); live view is a plain link-out.
- **Write actions only through `netmon/actions.py`** — S1–S7 register nothing
  new; S8 (D11) adds `camera_config_change` and `camera_firmware_update` to the
  closed registry and nothing else, behind `[camera_ops]` flags that default off.
- **Spec 19 stays the record for camera data**; this spec is the record for the
  camera *pages*. If S2's investigations (sites/version, licence, evidence locks,
  RS ESS states) change what is collected, note it in spec 19 in the same commit.

---

## 5. After cameras — the same method, page by page

Once S1's primitives exist, each remaining page is a composition job over data
NetMon largely has. Suggested order (spec 15 §3.2 estimates still apply):

| Order | Page | What "looks like ZCD" needs | Data gap |
|---|---|---|---|
| 1 | **Events** | header stats + 6-cell strip + saved-view chips + row checkboxes/bulk ack | none — closest to done |
| 2 | **Problems** | severity strip, site×category mosaic, grouping toggles | camera storm resolved (spec 19 §12), so the strip is readable now |
| 3 | **Wireless / AP Detail** | 9-tab detail, header chips (XIQ · SNMP · PING), action row | navigator exists; per-radio telemetry from 10.2 cycles |
| 4 | **XIQ · Status** | APs-by-site grid ✓, SSID table, top-client APs, channel heatmap, firmware dial | CCA per radio |
| 5 | **Switches** | already NEAR; PoE/CPU/temp cells | deferred sweeps |
| 6 | **PacketFence** (5 tabs) | donuts, quarantine cards, auth-source list, cluster node cards | none — ZCD's are mock, NetMon's data is live |
| 7 | **VoIP** | ZCD's header/trunk/queue layout | 3CX collector into the supervised set first |
| 8 | **Global** | spec 14 | spec 14 G2 data-truth gate |

---

## 6. Definition of done — cameras

- [ ] S0 `reference/` synced; `TCS-Dashboard-Functionality.md` in `reference/`; no `etc-zabbix/` content in the repo
- [x] **S1 done 2026-09-07.** `PageHeader` / `Pill` / `Tabs` (badges) / `StatCell` / `Card{source,link}` in `primitives.jsx`; Inter + JetBrains Mono self-hosted from `frontend/fonts/` (esbuild `.woff2` file loader → `netmon/web/fonts/`, url()s rewritten, no CDN); Surveillance rebuilt on them — header with five meta pills, badged tabs, ZCD's four-cell strip, `ServerMini` tiles, live alarm feed, degraded-cycle banner; `/api/alerts` gained `device_type` (comma list) + `limit`; `/api/meta` gained `milestone_host`; tab lives in the hash so deep-links work. **Deviation from the plan, deliberate: five tabs, not seven.** Sites and Evidence Lock need data S2/S6 collect (per-site recorder + switch/AP roll-ups; the evidence-lock endpoint), and a tab that exists only to say "coming later" is worse than no tab. 20 render-check cases green, 509 tests green.
- [ ] S2 mgmt server, version, licence, RS ESS state, per-RS camera counts, surveillance history series, sites roll-up fields — each either collected or recorded as "not exposed by Config API on 2025 R2"
- [x] S3 navigator (tree by Milestone group) + camera wall in the detail pane
- [x] S4 snapshot proxy behind `[camera_snapshot] enabled = false`; allow-list + vendor + size + scheme + channel tests green; the render-at-source relaxation recorded above. Still needs the owner to provision the account.
- [x] **S5 done 2026-09-07** — camera detail in ZCD's four-tab layout: sidecar + preview frame, Device Health as probe cells, 24h transition strip, stream/network kv, one PacketFence & uplink card with all four operator buttons, Active Issue with real Ack/Suppress, Recent Events. `state_events` added to the detail payload. Tab lives in the URL for both routes.
- [x] S6 Sites / Servers / Storage / Alarms / Evidence Lock tabs; every unavailable metric named, none rendered as 0 — done 2026-09-08 (evidence locks probed and refused by the Config API; ring drawn only on a real fraction; row actions operator-gated)
- [ ] S8 (D11) — investigation done 2026-09-08 (Milestone exposes no firmware resource; direct path stands) and `netmon/cameras/firmware.py` built; the write path waits on the owner's proving-ground answer. Remaining: bulk camera ops: `firmware_images` / `camera_batches` / `camera_batch_items` migrations with rollback notes; batch runner as a supervised task; Bosch profile fixture-tested; `[camera_ops]` default-off + dry-run default; canary → rings → abort threshold; verification by read-back; admin-only; open questions above answered in this spec before the first live batch
- [ ] Every new component has a `render-check.mjs` case for its no-data shape; API tests for every new query param
- [ ] Runbook `docs/runbooks/surveillance.md` updated: what each tab reads, what needs WinRM, how to enable snapshots, how to run and abort a batch

## Next session

- [x] S0 — `reference/` synced from the 2026-09-07 bundle (LF-normalised; `etc-zabbix/`, `httpd/`, `cron/`, `server-scripts/`, `dist/`, `vendor/`, `graphify-out/` excluded). Index in `reference/readme.md`.
- [x] S1 — shell primitives + fonts. Inter shipped as the single variable file (352 KB, weights 100–900) rather than four statics: smaller, and the design's `font-weight: 500` now renders as a real 500. JetBrains Mono has no variable woff2 upstream, so 400/500/600 are static.
- [x] The three S8 questions are answered (see §3 S8). One follow-on is open and is the owner's: deferring the setting catalogue means firmware — the irreversible half — would be the first thing S8 ships, so pick the proving ground (lab camera vs. a two-setting minimal catalogue).
- [x] **S3 done 2026-09-07** (out of order, owner-directed): `#/cameras` with the Milestone group tree. Migration 026 applied live, one collector cycle run — 26 groups, 2,676 memberships, 0 cameras ungrouped, no degradation. 23 render-check cases and 514 tests green.
- [x] **S2 done 2026-09-07.** Migrations 027 + 028 applied live; environment facts, recorder ESS verdicts, camera channel/TLS, seven history series, real per-recorder counts. 546 tests and 34 render-check cases green.
- [x] **S3b + S4 done 2026-09-07.** Camera wall in the Cameras page's right pane; snapshot proxy complete and default-off. 560 tests, 38 render-check cases.
- [ ] **Owner action to finish S4 (still outstanding as of 2026-09-08 — `/etc/netmon/netmon.conf` has no `[camera_snapshot]` section and `app_settings` carries no override, so the proxy is off):** add the read-only camera account to `/etc/netmon/netmon.conf` under `[camera_snapshot]` (`enabled = true`, `user`, `pass`, and `pass_backup` for the cameras still on the previous password) and restart `netmon`. Nothing else is outstanding — the code path is tested against every address shape on the estate.
- [ ] **One field needs a real camera to confirm:** the vendor query parameter that selects the imager on a multi-camera device (178 cameras). Until `[camera_snapshot] channel_param` is set they report the gap rather than risk serving a different imager's picture. Confirming it is one request against one Bosch multi-imager once the account exists.
- [ ] ~~**S2 next.** Highest-value items, in order: RS service state from the ESS (`_ess_camera_status` reads only `cameras/` today; spec 19 §11 has 9 recording-server states covering all 22 servers, and the Overview's recorder tiles currently colour off the Config API's `running` flag); per-RS camera counts so `chans_total` stops being null; `sites`/version/licence investigation for the header chip; `https_enabled` / `https_port` / `channel` into `cameras` — S4's snapshot proxy needs all three and collecting them now avoids a second migration.
- [ ] A restart of `netmon.service` is required for S1's two API additions (`device_type`/`limit` on `/api/alerts`, `milestone_host` on `/api/meta`). Until then the live page's alarm cell counts estate-wide alerts, because FastAPI ignores query params it does not know about — the static bundle updates without a restart but the API does not.
