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

### S2 — The numbers the header and overview need (1 session, collector + API)

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

### S3 — Cameras tab: navigator + thumbnail wall (1–2 sessions)

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

### S5 — Camera Detail parity (1–2 sessions)

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

### S6 — Sites · Servers · Storage · Alarms · Evidence Lock tabs (1–2 sessions)

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

**Sequencing:** after S1–S6 and after D7 (S4) has proven the camera-side HTTP
path and credentials in production. Then: batch machinery + firmware store +
Bosch profile in dry-run (2 sessions), the Milestone-mediated investigation above
(half a session, read-only, can run in parallel), first canary batches, then
rings. Estimate 3–4 sessions for the machinery + Bosch profile, 1 per additional
vendor.

### S7 — Liveness (optional, after S1–S6)

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
- [ ] S3 navigator + table/thumbnail toggle; 2,651 cameras render without jank
- [ ] S4 snapshot proxy behind `[camera_snapshot] enabled = false`; owner has provisioned the read-only camera login; allow-list + vendor + size tests green; spec 11 D7 entry updated
- [ ] S5 camera detail in ZCD's four-tab layout with still, active issue, reachability strip, four PF/PoE buttons, recent events
- [ ] S6 Sites / Servers / Storage / Alarms / Evidence Lock tabs; every unavailable metric named, none rendered as 0
- [ ] S8 (D11) bulk camera ops: `firmware_images` / `camera_batches` / `camera_batch_items` migrations with rollback notes; batch runner as a supervised task; Bosch profile fixture-tested; `[camera_ops]` default-off + dry-run default; canary → rings → abort threshold; verification by read-back; admin-only; open questions above answered in this spec before the first live batch
- [ ] Every new component has a `render-check.mjs` case for its no-data shape; API tests for every new query param
- [ ] Runbook `docs/runbooks/surveillance.md` updated: what each tab reads, what needs WinRM, how to enable snapshots, how to run and abort a batch

## Next session

- [x] S0 — `reference/` synced from the 2026-09-07 bundle (LF-normalised; `etc-zabbix/`, `httpd/`, `cron/`, `server-scripts/`, `dist/`, `vendor/`, `graphify-out/` excluded). Index in `reference/readme.md`.
- [x] S1 — shell primitives + fonts. Inter shipped as the single variable file (352 KB, weights 100–900) rather than four statics: smaller, and the design's `font-weight: 500` now renders as a real 500. JetBrains Mono has no variable woff2 upstream, so 400/500/600 are static.
- [x] The three S8 questions are answered (see §3 S8). One follow-on is open and is the owner's: deferring the setting catalogue means firmware — the irreversible half — would be the first thing S8 ships, so pick the proving ground (lab camera vs. a two-setting minimal catalogue).
- [ ] **S2 next.** Highest-value items, in order: RS service state from the ESS (`_ess_camera_status` reads only `cameras/` today; spec 19 §11 has 9 recording-server states covering all 22 servers, and the Overview's recorder tiles currently colour off the Config API's `running` flag); per-RS camera counts so `chans_total` stops being null; `sites`/version/licence investigation for the header chip; `https_enabled` / `https_port` / `channel` into `cameras` — S4's snapshot proxy needs all three and collecting them now avoids a second migration.
- [ ] A restart of `netmon.service` is required for S1's two API additions (`device_type`/`limit` on `/api/alerts`, `milestone_host` on `/api/meta`). Until then the live page's alarm cell counts estate-wide alerts, because FastAPI ignores query params it does not know about — the static bundle updates without a restart but the API does not.
