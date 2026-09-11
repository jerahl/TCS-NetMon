// Render page components with representative props and assert they do not
// throw. esbuild does not resolve identifiers, so a variable referenced
// outside its scope fails only in the browser — which is how
// "usedKnown is not defined" reached production on the Surveillance page.
import { build } from "esbuild";
import { createRequire } from "module";

const entry = `
export * as surveillance from "./src/pages/surveillance.jsx";
export * as cameraDetail from "./src/pages/camera_detail.jsx";
export * as cameras from "./src/pages/cameras.jsx";
export * as netmonStatus from "./src/pages/netmon_status.jsx";
export * as cameraOps from "./src/pages/camera_ops.jsx";
export * as cameraSnapshot from "./src/pages/camera_snapshot.jsx";
export * as primitives from "./src/primitives.jsx";
export * as automation from "./src/pages/automation.jsx";
export { default as React } from "react";
export { renderToString } from "react-dom/server";
`;
const res = await build({
  stdin: { contents: entry, resolveDir: process.cwd(), loader: "jsx" },
  bundle: true, write: false, format: "cjs", platform: "node",
  jsx: "automatic", logLevel: "silent",
  // This build has no output path, so a stylesheet import has nowhere to go.
  // The harness only exercises JS scope and render output, and a page's CSS
  // cannot cause the "identifier is not defined" class of bug it exists to
  // catch — so discard it rather than teach this build about assets.
  loader: { ".css": "empty" },
});
const require = createRequire(import.meta.url);
const mod = { exports: {} };
new Function("module", "exports", "require", res.outputFiles[0].text)(mod, mod.exports, require);
const { surveillance: S, cameraDetail: D, cameras: C, cameraSnapshot: SNAP,
        netmonStatus: NS, cameraOps: OPS, automation: AUTO, primitives: P, React,
        renderToString } = mod.exports;

const CAM = (over) => ({ device_id: 1, name: "chs-cam-1", site: "Central High",
  model: "Bosch FLEXIDOME", recording_state: "up", recording_server: "CHS-BCD-DVR",
  ip: "10.32.18.4", ...over });

const cases = [
  ["OverviewTab · used space unknown", S.OverviewTab, {
    summary: { cameras_total: 2651, cameras_recording: 2651, servers_total: 22,
               servers_up: 22, storage_total_gb: 1837600, storage_used_gb: null,
               storage_used_known: false, overview: null },
    storagePct: null }],
  ["OverviewTab · used space known", S.OverviewTab, {
    summary: { cameras_total: 10, cameras_recording: 10, servers_total: 1,
               servers_up: 1, storage_total_gb: 100, storage_used_gb: 40,
               storage_used_known: true, overview: null },
    storagePct: 40 }],

  // The by-school grid. Includes an unnamed site because 96% of the registry
  // had no site until the resolver landed and some rows still resolve to NULL —
  // a tile keyed on a null site name must not collide or crash.
  ["SiteTiles · mixed health", S.SiteTiles, {
    rows: [
      { site: "Bryant High", total: 264, up: 240, down_confirmed: 7,
        down_source_only: 4, down_network_only: 13, blind: 15, recording: 258 },
      { site: "Central Elementary", total: 83, up: 77, down_confirmed: 5,
        down_source_only: 0, down_network_only: 1, blind: 1, recording: 83 },
      { site: null, total: 8, up: 8, down_confirmed: 0, down_source_only: 0,
        down_network_only: 0, blind: 0, recording: 8 },
    ],
    filter: "all", onFilter: () => {}, onPick: () => {} }],

  // Counts as quoted strings — what MariaDB's Decimal SUM() serialised to
  // before db.py coerced it. Rendered "011010084717…" in the footer instead of
  // a total, showed "10" on a badge for 1 down + 0 unreachable, and made every
  // tile red because "0" is truthy. Asserted below, not just rendered.
  ["SiteTiles · counts arriving as strings", S.SiteTiles, {
    rows: [
      { site: "MLK", total: 114, up: "83", down_confirmed: "11",
        down_source_only: "0", down_network_only: "20", blind: "20", recording: "94" },
      { site: "Skyland", total: 59, up: "59", down_confirmed: "0",
        down_source_only: "0", down_network_only: "0", blind: "0", recording: "59" },
    ],
    filter: "all", onFilter: () => {}, onPick: () => {} },
   (html) => {
     // React SSR puts <!-- --> between adjacent text nodes, so match on the
     // text as a reader sees it rather than on the raw markup.
     const text = html.replace(/<!-- -->/g, "");
     if (!text.includes("11 camera(s) down")) throw new Error("footer did not add up");
     if (text.includes("110")) throw new Error("counts concatenated instead of adding");
     if (!text.includes("✓")) throw new Error("a site with nothing wrong scored as a failure");
   }],


  // ─── S2: environment facts, ESS verdicts, the 24h trend ─────────────────
  ["OverviewTab · version and licence known", S.OverviewTab, {
    summary: { cameras_total: 2662, cameras_recording: 2438, servers_total: 22,
               servers_up: 22, servers_down: 0, storage_total_gb: 1837600,
               storage_used_gb: null, storage_used_known: false, overview: null,
               cameras_by_status: { up: 2422 },
               management_server: "CO-MILESTONE", version: "25.2.0.1",
               license_product: "Device License", license_activated: 2491,
               license_not_licensed: 0 },
    storagePct: null, sites: [], servers: [], alarms: [], meta: {},
    onPickSite: () => {} },
   (html) => {
     const text = html.replace(/<!-- -->/g, "");
     if (!text.includes("25.2.0.1")) throw new Error("XProtect version not shown");
     if (!text.includes("2,491")) throw new Error("activated licence count not shown");
     if (text.includes("/ 2,491") || text.includes("2491 /")) {
       throw new Error("invented a licence total — there is none to divide by");
     }
   }],

  // Half this estate carries a months-old "Service Available Critical". The
  // pill must show the VMS's own word and carry the age, and must not be
  // rendered as green just because it is unfamiliar.
  ["EssState · critical", S.EssState, {
    value: "Service Available Critical", at: "2026-04-24T07:13:31Z" },
   (html) => {
     if (!html.includes("Critical")) throw new Error("verdict not shown");
     if (!html.includes("state-pill err")) throw new Error("critical not tinted as an error");
   }],
  ["EssState · undefined is not health", S.EssState, {
    value: "GPU Memory Undefined", at: "2026-04-24T07:13:31Z" },
   (html) => {
     if (html.includes("state-pill ok")) throw new Error("Undefined rendered as healthy");
   }],
  ["EssState · absent", S.EssState, { value: null, at: null },
   (html) => {
     if (!html.includes("—")) throw new Error("missing verdict did not render a dash");
   }],

  ["ServersTab · ESS verdict columns", S.ServersTab, {
    rows: [{ device_id: 1, name: "BHS-BCD-DVR", hostname: "bhs-bcddvr-ms", site: "Bryant High",
             version: "25.2", chans_total: 264, chans_recording: 258,
             storage_total_gb: 100600, retention_days: 61, status: "up",
             comm_state: "Communication Started", cpu_state: "CPU Usage Normal",
             retention_state: "Retention time Warning",
             service_state: "Service Available Critical",
             states_at: "2026-04-24T07:13:31Z" },
           { device_id: 2, name: "WFS-BCD-DVR", hostname: null, site: null,
             version: null, chans_total: null, chans_recording: null,
             storage_total_gb: null, retention_days: null, status: "blind",
             comm_state: null, cpu_state: null, retention_state: null,
             service_state: null, states_at: null }] },
   (html) => {
     const text = html.replace(/<!-- -->/g, "");
     if (!text.includes("Warning")) throw new Error("retention warning not surfaced");
     if (!text.includes("never raise alerts") && !text.includes("none of these three raise alerts")) {
       throw new Error("the states' non-alerting nature was not stated");
     }
   }],

  // ─── Camera detail, ZCD's layout (spec 20 S5) ───────────────────────────
  // Everything resolved: the path where the port is known and PoE cycling is
  // offered. Rendered on each of the four tabs, because a card that only
  // appears on "config" is otherwise never exercised.
  ...["overview", "live", "events", "config"].map((tab) => [
    `CameraDetailView · full uplink · ${tab} tab`, D.CameraDetailView, {
      cam: { ...CAM(), http_port: null, vendor: "Bosch", firmware: "8.10.0",
             serial: "0451234567", codec: "H.264", resolution: "1920x1080",
             fps_target: 15, bitrate_mode: "VBR", recording_mode: "Motion",
             groups: [{ id: "g", name: "CHS", site_display_name: "Central High School" }],
             state: {
               source_status: { value: "up", source: "milestone-ess",
                                updated_at: "2026-09-07T12:00:00Z" },
               ping: { value: "up", updated_at: "2026-09-07T12:00:00Z" },
               recording: { value: "up" },
               reachability: { value: "up" } },
             switch_port: { switch_device_id: 42, switch_name: "WFS-MDF",
               switch_site: "Westlawn", port: "4:37", ifindex: 437,
               oper_state: "up", speed_mbps: 1000, is_sfp: 0, poe_delivering: 1,
               poe_watts: 6.4, macs_on_port: 1, pf_agrees: true, pf_port: "4:37",
               candidates: 1, poe_cycle_safe: true,
               why: "fewest MACs on port, PoE-delivering copper, confirmed by PacketFence" },
             pf: { mac: "00:11:22:33:44:55", computername: "cam-1", role: "cameras",
                   reg_status: "reg", vlan: "300", last_switch: "10.0.0.9",
                   last_port: "4:37", online: 1, updated_at: "2026-09-07T12:00:00Z" },
             events: [
               { dimension: "reachability", old_value: "up", new_value: "down_confirmed",
                 severity: "crit", source: "netmon", occurred_at: new Date(Date.now() - 3.6e6).toISOString() },
               { dimension: "source_status", old_value: "down", new_value: "up",
                 severity: "ok", source: "milestone-ess", occurred_at: new Date(Date.now() - 7.2e6).toISOString() },
             ],
             siblings: [{ device_id: 2, name: "chs-cam-1 - Camera 2", recording_state: "up" }] },
      meta: { packetfence_url: "https://pf.example" },
      alerts: [], tab },
    // The tab that owns each card must actually render it.
    (html) => {
      const text = html.replace(/<!-- -->/g, "");
      const want = { overview: "Device health", live: "Stream configuration",
                     events: "Recent events", config: "Network &amp; identity" }[tab];
      if (!text.includes(want)) throw new Error(`${tab} tab did not render ${want}`);
      if (!text.includes("Central High School")) throw new Error("group label missing from the header");
    },
  ]),

  // …and the honest-gap path: blind, no port, no PF record, no identity, no
  // history. Every card must still render and say why it is empty.
  ["CameraDetailView · blind, unresolved", D.CameraDetailView, {
    cam: { ...CAM({ ip: null, recording_state: null, model: null }),
           state: { source_status: { value: "blind", source: "milestone" } },
           switch_port: null, pf: null, siblings: [], groups: [], events: [] },
    meta: {}, alerts: [] },
   (html) => {
     const text = html.replace(/<!-- -->/g, "");
     if (!text.includes("No address")) throw new Error("missing address not stated");
     if (!text.includes("No state transitions recorded")) throw new Error("empty history not explained");
   }],

  // An open alert: ZCD's Acknowledge is inert, NetMon's is the real lifecycle.
  ["CameraDetailView · open alert drives the Active Issue card", D.CameraDetailView, {
    cam: { ...CAM(), state: { reachability: { value: "down_confirmed" } },
           switch_port: null, pf: null, siblings: [], groups: [], events: [] },
    meta: {},
    alerts: [{ id: 7, rule_name: "unreachable_confirmed", severity: "crit",
               opened_at: "2026-09-07T10:00:00Z", acked_by: null, closed_at: null }] },
   (html) => {
     if (!html.includes("Active issue")) throw new Error("open alert did not surface");
     if (!html.includes("Suppress 1h")) throw new Error("no lifecycle action offered");
   }],

  ["ReachabilityStrip · quiet 24h", D.ReachabilityStrip, {
    events: [{ dimension: "reachability", old_value: "down_confirmed", new_value: "up",
               severity: "ok", source: "netmon", occurred_at: "2026-09-01T00:00:00Z" }] },
   (html) => {
     if (!html.includes("No probe changed its verdict")) throw new Error("quiet window not explained");
   }],

  // The snapshot components render before (and without) a fetch — which is the
  // state every viewer sees first, and the one that has to explain itself.
  ["CameraPreview · nothing fetched yet", SNAP.CameraPreview, {
    cam: { device_id: 1, name: "cam-x", resolution: null, fps_target: null,
           codec: null, state: {} }, url: null },
   (html) => {
     if (!html.includes("cam-x")) throw new Error("overlay lost the camera name");
   }],
  ["CameraPreview · both probes say gone", SNAP.CameraPreview, {
    cam: { device_id: 1, name: "cam-y", state: { reachability: { value: "down_confirmed" } } },
    url: null },
   (html) => {
     if (!html.includes("No signal")) throw new Error("a confirmed-down camera was still asked");
   }],
  ["CamThumb · confirmed down is not fetched", SNAP.CamThumb, {
    cam: { device_id: 2, name: "cam-z", reachability: "down_confirmed" } },
   (html) => {
     if (!html.includes("NO SIGNAL")) throw new Error("tile did not say why it is blank");
     if (!html.includes("cam-tile err")) throw new Error("down tile not tinted");
   }],
  ["ThumbnailWall · pages beyond the first 48", C.ThumbnailWall, {
    rows: Array.from({ length: 60 }, (_, i) => ({
      device_id: i + 1, name: `cam-${i}`, reachability: "up" })),
    total: 2662, problems: 0, onProblems: () => {} },
   (html) => {
     const text = html.replace(/<!-- -->/g, "");
     if (!text.includes("page 1 of 2")) throw new Error("page position not disclosed");
     if (!text.includes("1–48 of 60")) throw new Error("the range on show is not stated");
     // 48 tiles, not 60 and not all of them: the page size is the proxy's
     // concurrency bound, not a cosmetic choice. Counted on the tile's note
     // element, which appears exactly once per tile — "cam-tile" itself also
     // matches "cam-tile-note" and doubles the count.
     const tiles = text.split("cam-tile-note").length - 1;
     if (tiles !== 48) throw new Error(`page rendered ${tiles} tiles, expected 48`);
     if (!text.includes("Next")) throw new Error("no way forward from page 1");
     // Prev must be dead on the first page rather than absent.
     if (!/‹ Prev<\/button>/.test(text) || !text.includes("disabled")) {
       throw new Error("Prev not present-and-disabled on the first page");
     }
     // Two pages only — the first/last shortcuts would just repeat Prev/Next.
     if (text.includes(">first<")) throw new Error("jump links shown for a 2-page wall");
   }],

  ["ThumbnailWall · a single page keeps its plain kicker", C.ThumbnailWall, {
    rows: Array.from({ length: 12 }, (_, i) => ({
      device_id: i + 1, name: `cam-${i}`, reachability: "up" })),
    total: 12, problems: 0, onProblems: () => {} },
   (html) => {
     const text = html.replace(/<!-- -->/g, "");
     if (!text.includes("12 camera(s)")) throw new Error("count not shown");
     if (text.includes("cam-wall-pager")) throw new Error("pager rendered for one page");
   }],

  ["ThumbnailWall · a long fleet offers the jump links", C.ThumbnailWall, {
    rows: Array.from({ length: 1204 }, (_, i) => ({
      device_id: i + 1, name: `cam-${i}`, reachability: "up" })),
    total: 2662, problems: 0, onProblems: () => {} },
   (html) => {
     const text = html.replace(/<!-- -->/g, "");
     if (!text.includes("page 1 of 26")) throw new Error("page count wrong for 1,204 rows");
     if (!text.includes(">first<") || !text.includes(">last<")) {
       throw new Error("no shortcut to the ends of a 26-page wall");
     }
     if (!text.includes("1,204")) throw new Error("total not thousands-separated");
   }],
  ["ThumbnailWall · empty with a way out", C.ThumbnailWall, {
    rows: [], total: 2662, problems: 229, onProblems: () => {} },
   (html) => {
     const text = html.replace(/<!-- -->/g, "");
     if (!text.includes("229")) throw new Error("empty wall offered no next step");
   }],

  // ─── Cameras page: the Milestone group tree (spec 20 S3) ────────────────
  ["CamerasView · tree with a school in trouble", C.CamerasView, {
    groups: [
      { id: "g-bhs", name: "BHS", path: "BHS", site_display_name: "Paul W. Bryant High",
        site: "Bryant High", total: 264, up: 240, down_confirmed: 7, down_source_only: 4,
        down_network_only: 13, blind: 15, recording: 258, milestone_camera_count: 265,
        updated_at: "2026-09-07T12:00:00Z" },
      { id: "g-sky", name: "SKY", path: "SKY", site_display_name: "Skyland Elementary",
        site: "Skyland", total: 59, up: 59, down_confirmed: 0, down_source_only: 0,
        down_network_only: 0, blind: 0, recording: 59, milestone_camera_count: 59,
        updated_at: "2026-09-07T12:00:00Z" },
      // Empty in Milestone — three groups on the live estate are. Must render
      // as "no cameras", never be hidden.
      { id: "g-nes", name: "NES", path: "NES", site_display_name: "Northington Elementary",
        total: 0, milestone_camera_count: 0, updated_at: "2026-09-07T12:00:00Z" },
      // In Milestone but nothing imported: the gap has to be visible.
      { id: "g-old", name: "OLD TCT", path: "OLD TCT", total: 0,
        milestone_camera_count: 12, updated_at: "2026-09-07T12:00:00Z" },
    ],
    cams: [
      { device_id: 1, name: "bhs-cam-01", site: "Bryant High", model: "Bosch FLEXIDOME",
        ip: "10.32.18.4", reachability: "up", recording_state: "up", group_ids: ["g-bhs"] },
      { device_id: 2, name: "bhs-cam-02", site: "Bryant High", model: "Bosch FLEXIDOME",
        ip: "10.32.18.5", reachability: "down_confirmed", recording_state: "down",
        group_ids: ["g-bhs"] },
      { device_id: 3, name: "bhs-cam-03", site: "Bryant High", model: "AXIS M3007",
        ip: "10.32.18.6", source_status: "blind", group_ids: ["g-bhs"] },
      // Two groups — 25 cameras on the live estate are, and the camera must
      // appear under both rather than silently under one.
      { device_id: 4, name: "shared-cam", site: "Bryant High", model: "Bosch",
        ip: "10.32.18.7", reachability: "down_network_only", group_ids: ["g-bhs", "g-sky"] },
      { device_id: 5, name: "sky-cam-01", site: "Skyland", model: "Bosch",
        ip: "10.40.18.4", reachability: "up", recording_state: "up", group_ids: ["g-sky"] },
      // In no group at all — must not vanish from the navigator.
      { device_id: 6, name: "orphan-cam", site: null, model: null, ip: null,
        reachability: "up", group_ids: [] },
    ],
    activeId: "2", collapsed: new Set(["g-sky"]), onToggle: () => {},
    onAllCollapsed: () => {}, status: "", onStatus: () => {}, q: "", onQ: () => {} },
   (html) => {
     const text = html.replace(/<!-- -->/g, "");
     if (!text.includes("Paul W. Bryant High")) throw new Error("school name not shown beside the group code");
     if (!text.includes("Not in any group")) throw new Error("ungrouped cameras were dropped");
     if (!text.includes("12 camera(s) in Milestone, none imported")) {
       throw new Error("un-imported cameras not disclosed");
     }
     if (!text.includes("no cameras in this group")) throw new Error("empty group not explained");
     // The shared camera appears under both of its groups.
     if (text.split("shared-cam").length - 1 < 2) throw new Error("multi-group camera shown once");
   }],

  // Every group collapsed: the counts must still be visible, or collapsing the
  // tree would hide an outage.
  ["CamerasView · all collapsed still shows the down count", C.CamerasView, {
    groups: [{ id: "g", name: "BHS", path: "BHS", total: 2, down_confirmed: 1,
               milestone_camera_count: 2 }],
    cams: [{ device_id: 1, name: "c1", reachability: "down_confirmed", group_ids: ["g"] },
           { device_id: 2, name: "c2", reachability: "up", group_ids: ["g"] }],
    activeId: null, collapsed: new Set(["g"]), onToggle: () => {},
    onAllCollapsed: () => {}, status: "", onStatus: () => {}, q: "", onQ: () => {} },
   (html) => {
     if (!html.includes("site-prob")) throw new Error("collapsed group hid its problem count");
   }],

  ["CamerasView · no groups cached", C.CamerasView, {
    groups: [], cams: [], activeId: null, collapsed: new Set(), onToggle: () => {},
    onAllCollapsed: () => {}, status: "", onStatus: () => {}, q: "", onQ: () => {} },
   (html) => {
     if (!html.includes("No camera groups cached")) throw new Error("empty tree said nothing");
   }],

  ["GroupNode · counts arriving as strings", C.GroupNode, {
    group: { id: "g", name: "MLK", total: "114", down_confirmed: "11",
             down_source_only: "0", down_network_only: "20", blind: "20",
             milestone_camera_count: "114" },
    rows: [{ device_id: 1, name: "c1", reachability: "down_confirmed" }],
    activeId: null, collapsed: false, onToggle: () => {} },
   (html) => {
     if (html.includes(">110<")) throw new Error("string counts concatenated instead of adding");
   }],

  // ─── Shell primitives (spec 20 S1) ──────────────────────────────────────
  // Every slot optional: a page that has no address, no chip and no range must
  // render the same header as one that has all three.
  ["PageHeader · full", P.PageHeader, {
    title: "Surveillance NOC", ip: "milestone-gw.example", tag: "XProtect 2025 R2",
    pills: [{ label: "recorders", value: "22 / 22", severity: "ok" },
            { label: "cameras", value: "2,651" }, null],
    range: "Live · 24h history", back: { href: "#/", label: "Back" } }],
  ["PageHeader · bare", P.PageHeader, { title: "Surveillance NOC", pills: [] }],
  ["Tabs · badges and tints", P.Tabs, {
    tabs: [{ id: "a", label: "Overview" },
           { id: "b", label: "Cameras", badge: "2,651", kind: "err" },
           { id: "c", label: "Storage", badge: null }],
    active: "b", onChange: () => {} }],
  // A metric nothing feeds must render "—", not 0 — the whole reason this
  // primitive takes null rather than defaulting.
  ["StatCell · unknown value", P.StatCell, {
    label: "Storage used", value: null, sub: "not exposed by the Config API", subTone: "warn" },
   (html) => {
     if (!html.includes("—")) throw new Error("null value did not render an em dash");
     if (html.includes(">0<")) throw new Error("null value rendered as zero");
   }],
  ["Card · source badge and link", P.Card, {
    title: "Recording servers", source: "milestone", kicker: "22 recorder(s)",
    link: { href: "#/surveillance?tab=servers", label: "All recorders" },
    children: "body" }],

  // ─── Surveillance overview (spec 20 S1) ─────────────────────────────────
  // The shape on the live estate: storage used unknown, no agent metrics, a
  // mixed retention range across recorders.
  ["OverviewTab · live shape", S.OverviewTab, {
    summary: { cameras_total: 2651, cameras_recording: 2438, servers_total: 22,
               servers_up: 22, servers_down: 0, storage_total_gb: 1837600,
               storage_used_gb: null, storage_used_known: false, overview: null,
               cameras_by_status: { up: 2422, down_confirmed: 82 } },
    storagePct: null,
    sites: [{ site: "Bryant High", total: 264, up: 240, down_confirmed: 7,
              down_source_only: 4, down_network_only: 13, blind: 15, recording: 258 }],
    servers: [{ device_id: 1, name: "BHS-BCD-DVR", site: "Bryant High", role: "Recording Server",
                version: "25.2", chans_total: 264, chans_recording: 258,
                storage_total_gb: 100600, storage_used_gb: null, retention_days: 61,
                status: "up" },
              { device_id: 2, name: "NHS-BCD-DVR", site: "Northridge", role: "Recording Server",
                version: "25.2", chans_total: 180, chans_recording: 176,
                storage_total_gb: 88000, storage_used_gb: null, retention_days: 31,
                status: "down" }],
    alarms: [{ id: 5, device_id: 9, device_name: "chs-cam-4", device_type: "camera",
               site: "Central High", rule_name: "unreachable_confirmed", severity: "crit",
               opened_at: "2026-09-07T10:00:00Z", acked_by: null }],
    meta: { milestone_host: "milestone-gw.example" },
    onPickSite: () => {} },
   (html) => {
     const text = html.replace(/<!-- -->/g, "");
     if (!text.includes("1.8 PB")) throw new Error("configured storage not formatted as PB");
     if (!text.includes("31–61 days")) throw new Error("mixed retention not shown as a range");
     if (!text.includes("not available")) throw new Error("unknown used space not explained");
     if (text.includes("0%")) throw new Error("unknown used space rendered as a percentage");
   }],

  // Everything still loading: the page must render its shell, not crash on
  // nulls, and must not claim "no alarms" before the fetch lands.
  ["OverviewTab · nothing loaded yet", S.OverviewTab, {
    summary: { cameras_total: 0, cameras_recording: 0, servers_total: 0, servers_up: 0,
               servers_down: 0, storage_total_gb: 0, storage_used_gb: null,
               storage_used_known: false, overview: null, cameras_by_status: {} },
    storagePct: null, sites: null, servers: null, alarms: null, meta: null,
    onPickSite: () => {} }],

  ["AlarmFeed · empty", S.AlarmFeed, { rows: [] },
   (html) => {
     if (!html.includes("No open alerts")) throw new Error("empty feed said nothing");
   }],
  ["AlarmFeed · truncated", S.AlarmFeed, {
    rows: Array.from({ length: 14 }, (_, i) => ({
      id: i, device_id: i + 1, device_name: `cam-${i}`, device_type: "camera",
      site: "BHS", rule_name: "source_unreachable", severity: "warn",
      opened_at: "2026-09-07T09:00:00Z", acked_by: i % 3 ? null : "sappleby" })),
    limit: 10 },
   (html) => {
     // SSR splits adjacent text nodes with <!-- -->; match what a reader sees.
     if (!html.replace(/<!-- -->/g, "").includes("4 more open")) {
       throw new Error("truncation not disclosed");
     }
   }],
  ["AlarmsTab · filters over mixed severities", S.AlarmsTab, {
    rows: [{ id: 1, device_id: 2, device_name: "cam-a", device_type: "camera", site: "BHS",
             rule_name: "unreachable_confirmed", severity: "crit",
             opened_at: "2026-09-07T09:00:00Z", acked_by: null },
           { id: 2, device_id: 3, device_name: "NHS-BCD-DVR", device_type: "recording_server",
             site: "Northridge", rule_name: "device_source_down", severity: "warn",
             opened_at: "2026-09-07T08:00:00Z", acked_by: "sappleby" }] }],
  ["AlarmsTab · nothing open", S.AlarmsTab, { rows: [] }],
  ["ServersTab · mixed state", S.ServersTab, {
    rows: [{ device_id: 1, name: "BHS-BCD-DVR", hostname: "bhs-bcddvr-ms", site: "Bryant High",
             role: "Recording Server", version: "25.2", chans_total: 264, chans_recording: 258,
             storage_total_gb: 100600, retention_days: 61, status: "up" },
           { device_id: 2, name: "WFS-BCD-DVR", hostname: null, site: null, role: null,
             version: null, chans_total: null, chans_recording: null,
             storage_total_gb: null, retention_days: null, status: "blind" }] }],
  // ─── S6: Sites / Storage / Alarms actions / Evidence Lock ──────────────
  ["SitesTab · a school in trouble beside a clean one", S.SitesTab, {
    sites: [
      { site: "Bryant High", total: 264, up: 240, down_confirmed: 7,
        down_source_only: 4, down_network_only: 13, blind: 0, recording: 258 },
      { site: "Skyland", total: 59, up: 59, down_confirmed: 0, down_source_only: 0,
        down_network_only: 0, blind: 0, recording: 59 },
      // Cameras with no site attribution: 96% of the registry had none before
      // the resolver, and a null key must not collide or crash.
      { site: null, total: 8, up: 8, down_confirmed: 0, down_source_only: 0,
        down_network_only: 0, blind: 0, recording: 8 },
    ],
    context: [
      { site: "Bryant High", recorders: 1, recorder_names: "bhs-bcddvr-ms.tcs.tusc.k12.al.us",
        storage_total_gb: 107000, retention_days: 61, switches: 14, aps: 65 },
      // In /sites but not in /site-context — a school with cameras and no
      // recorder linked. The row must still render.
      { site: "Skyland", recorders: 0, recorder_names: null, storage_total_gb: null,
        retention_days: null, switches: 4, aps: 18 },
    ] },
   (html) => {
     const text = html.replace(/<!-- -->/g, "");
     if (!text.includes("7 down · 4 Milestone-down · 13 no ICMP")) {
       throw new Error("failure shapes collapsed into one number");
     }
     if (!text.includes("all clear")) throw new Error("a clean school did not say so");
     if (!text.includes("bhs-bcddvr-ms")) throw new Error("recorder not named");
     if (text.includes("bhs-bcddvr-ms.tcs")) throw new Error("FQDN not shortened");
     if (!text.includes("14 switches") || !text.includes("65 APs")) {
       throw new Error("network context missing");
     }
     if (!text.includes("none linked")) throw new Error("a school with no recorder said nothing");
     if (!text.includes("used —")) throw new Error("configured capacity could read as usage");
   }],

  ["SitesTab · counts arriving as strings", S.SitesTab, {
    sites: [{ site: "MLK", total: "114", up: "63", down_confirmed: "11",
              down_source_only: "0", down_network_only: "20", blind: "20" }],
    context: [{ site: "MLK", recorders: 1, recorder_names: "mlk-bcd-dvr",
                storage_total_gb: "76000", retention_days: "61", switches: "4", aps: "18" }] },
   (html) => {
     if (html.includes(">110<")) throw new Error("string counts concatenated instead of adding");
   }],

  // The ring is a claim about proportion. With no consumed figure there is no
  // proportion, and drawing one anyway is the worst thing this page could do.
  ["StorageView · no consumed figure draws no ring", S.StorageView, {
    rows: [{ name: "BHS-BCD-DVR", hostname: "bhs-bcddvr-ms", storage_total_gb: 107000,
             storage_used_gb: null, retention_days: 61 }],
    summary: { storage_total_gb: 1837600, storage_used_gb: null, storage_used_known: false },
    context: [{ site: "Bryant High", recorder_names: "bhs-bcddvr-ms",
                storage_total_gb: 107000, retention_days: 61 }] },
   (html) => {
     const text = html.replace(/<!-- -->/g, "");
     if (text.includes("<svg")) throw new Error("a ring was drawn from configured size alone");
     if (!text.includes("Consumed space is not exposed")) {
       throw new Error("the missing figure was not named");
     }
     if (!text.includes("1.8 PB")) throw new Error("configured total not shown in the ring slot");
     if (!text.includes("Over-commit")) throw new Error("the over-commit gap went unnamed");
     if (!text.includes("not exposed")) throw new Error("volumes table hid the unknown used column");
   }],

  ["StorageView · a real fraction draws the ring", S.StorageView, {
    rows: [{ name: "TEST-DVR", hostname: "test", storage_total_gb: 100,
             storage_used_gb: 91, retention_days: 30 }],
    summary: { storage_total_gb: 100, storage_used_gb: 91, storage_used_known: true },
    context: [] },
   (html) => {
     const text = html.replace(/<!-- -->/g, "");
     if (!text.includes("<svg")) throw new Error("a known fraction drew no ring");
     if (!text.includes("91%")) throw new Error("the percentage is not stated");
   }],

  ["AlarmsTab · an operator gets working row actions", S.AlarmsTab, {
    rows: [{ id: 1, device_id: 2, device_name: "bhs-cam-02", device_type: "camera",
             site: "Bryant High", rule_name: "device_down", severity: "crit",
             opened_at: "2026-09-08T08:00:00Z" }],
    role: "operator", onChanged: () => {} },
   (html) => {
     const text = html.replace(/<!-- -->/g, "");
     for (const label of ["Ack", "Assign", "Suppress 1h"]) {
       if (!text.includes(label)) throw new Error(`${label} missing for an operator`);
     }
     if (!text.includes("does not stop the state being")) {
       throw new Error("suppression's meaning not explained");
     }
   }],

  ["AlarmsTab · a viewer is told, not refused", S.AlarmsTab, {
    rows: [{ id: 1, device_id: 2, device_name: "bhs-cam-02", device_type: "camera",
             site: "Bryant High", rule_name: "device_down", severity: "crit",
             opened_at: "2026-09-08T08:00:00Z", acked_by: null }],
    role: "viewer", onChanged: () => {} },
   (html) => {
     const text = html.replace(/<!-- -->/g, "");
     if (text.includes("Suppress 1h")) throw new Error("a viewer was shown actions that 403");
     if (!text.includes("need the operator role")) throw new Error("no explanation for the viewer");
   }],

  ["AlarmsTab · an acked alarm offers no second Ack", S.AlarmsTab, {
    rows: [{ id: 1, device_id: 2, device_name: "bhs-cam-02", device_type: "camera",
             site: "Bryant High", rule_name: "device_down", severity: "warn",
             opened_at: "2026-09-08T08:00:00Z", acked_by: "sappleby" }],
    role: "admin", onChanged: () => {} },
   (html) => {
     const text = html.replace(/<!-- -->/g, "");
     if (/>Ack</.test(text)) throw new Error("Ack offered on an already-acked alarm");
     if (!text.includes("Assign")) throw new Error("Assign should still be available");
   }],

  // ─── S8: the bulk-operations surface ───────────────────────────────────
  ["GateStrip · every gate closed says so", OPS.GateStrip, {
    status: { enabled: false, dry_run: true, firmware_update: false,
              account_configured: false, proving_device_id: 1592 } },
   (html) => {
     const text = html.replace(/<!-- -->/g, "");
     // Five gates, all shut. A page that rendered them as open would be lying
     // about the only thing on it that matters.
     if ((text.match(/gate shut/g) || []).length !== 5) {
       throw new Error("a closed gate rendered as open");
     }
     if (!text.includes("proving camera #1592")) throw new Error("proving camera not named");
   }],

  ["GateStrip · armed and live", OPS.GateStrip, {
    status: { enabled: true, dry_run: false, firmware_update: true,
              account_configured: true, proving_device_id: 0 } },
   (html) => {
     if (html.includes("gate shut")) throw new Error("an open gate rendered as closed");
   }],

  ["BatchItems · the four outcomes read differently", OPS.BatchItems, {
    items: [
      { id: 1, name: "alb-cam-44", ip: "10.21.18.44", ring: 0, status: "verified",
        before_value: "7.83.0027", after_value: "7.93.0024", verified_by: "vendor" },
      { id: 2, name: "cam-b", ip: "10.1.1.2", ring: 1, status: "indeterminate",
        before_value: "783", after_value: "793", verified_by: "milestone",
        message: "reported '793', which cannot prove 7.93.0024" },
      { id: 3, name: "cam-c", ip: "10.1.1.3", ring: 1, status: "failed",
        before_value: "7.83.0027", after_value: "7.83.0027", message: "did not reach" },
      { id: 4, name: "cam-d", ip: "10.1.1.4", ring: 1, status: "skipped",
        message: "already on 7.93.0024" },
    ] },
   (html) => {
     const text = html.replace(/<!-- -->/g, "");
     if (!text.includes("canary")) throw new Error("ring 0 not labelled as the canary");
     for (const w of ["verified", "indeterminate", "failed", "skipped"]) {
       if (!text.includes(w)) throw new Error(`${w} missing`);
     }
     // Provenance of the confirmation is on the row: the two are not worth the same.
     if (!text.includes("vendor") || !text.includes("milestone")) {
       throw new Error("verified_by not shown");
     }
   }],

  ["BatchCard · a dry run says so and offers no abort", OPS.BatchCard, {
    batch: { id: 7, op: "firmware_update", status: "done", dry_run: 1,
             firmware_version: "7.93.0024",
             items: [{ id: 1, name: "alb-cam-44", ip: "10.21.18.44", ring: 0,
                       status: "would_run", before_value: "7.83.0027" }] } },
   (html) => {
     const text = html.replace(/<!-- -->/g, "");
     if (!text.includes("DRY RUN")) throw new Error("a dry run did not say so");
     if (text.includes("Abort")) throw new Error("abort offered on a finished batch");
   }],

  ["ImageRow · an image with no platform is flagged", OPS.ImageRow, {
    image: { id: 1, version: "7.93.0024", platform: null, filename: "b793.fw",
             size_bytes: 95217328, models: ["FLEXIDOME IP 5000i IR"], sha256: "66989c27" },
    selected: false, onSelect: () => {} },
   (html) => {
     const text = html.replace(/<!-- -->/g, "");
     if (!text.includes("not stated")) throw new Error("a missing platform passed silently");
     if (!text.includes("91 MiB")) throw new Error("size not human-readable");
   }],

  ["CameraPicker · eligibility comes from the image", OPS.CameraPicker, {
    image: { id: 1, version: "7.93.0024", platform: "CPP6/7/7.3",
             models: ["FLEXIDOME IP 5000i IR"] },
    cameras: [
      { device_id: 1, name: "cam-ok", ip: "10.1.1.1", site: "BHS",
        model: "FLEXIDOME IP 5000i IR", firmware: "7.83.0027",
        platform: "CPP6/7/7.3", reachability: "up" },
      // Already there, in the compact form 888 cameras report. Offering this
      // one would build a batch the server refuses.
      { device_id: 2, name: "cam-current", ip: "10.1.1.2", site: "BHS",
        model: "FLEXIDOME IP 5000i IR", firmware: "793",
        platform: "CPP6/7/7.3", reachability: "up" },
      { device_id: 3, name: "cam-down", ip: "10.1.1.3", site: "BHS",
        model: "FLEXIDOME IP 5000i IR", firmware: "7.83.0027",
        platform: "CPP6/7/7.3", reachability: "down_confirmed" },
      { device_id: 4, name: "cam-wrong-cpp", ip: "10.1.1.4", site: "BHS",
        model: "FLEXIDOME IP 5000i IR", firmware: "7.83.0027",
        platform: "CPP14/15/16", reachability: "up" },
      // A different model entirely: not listed at all, because the image's
      // allow-list is what decides what is even a candidate.
      { device_id: 5, name: "cam-5100i", ip: "10.1.1.5", site: "BHS",
        model: "FLEXIDOME indoor 5100i IR", firmware: "9.00.0210",
        platform: "CPP14/15/16", reachability: "up" },
    ],
    selected: [1], onToggle: () => {}, onBulk: () => {}, maxBatch: 50,
    // Ruled-out rows are hidden by default now, so this case asks for them:
    // it is the reasons themselves that are under test here.
    showRuledOut: true },
   (html) => {
     const text = html.replace(/<!-- -->/g, "");
     if (text.includes("cam-5100i")) throw new Error("a camera outside the allow-list was listed");
     if (!text.includes("already on 7.93.0024")) {
       throw new Error("the compact firmware form was not recognised as current");
     }
     if (!text.includes("camera is CPP14/15/16, image is CPP6/7/7.3")) {
       throw new Error("platform mismatch not explained");
     }
     if (!text.includes("reachability is down_confirmed")) throw new Error("down camera not ruled out");
     if (!text.includes("1</b> eligible now")) throw new Error("eligible count wrong");
   }],

  // The complaint that started this: after a roll, 50 already-updated cameras
  // still filled the firmware tab. "already on 7.93.0024" in the last column is
  // not the same as being off the list, and blocked rows also eat the 200-row
  // cap so the cameras that DO need the image fall off the bottom.
  ["CameraPicker · updated cameras drop off the list", OPS.CameraPicker, {
    image: { id: 1, version: "7.93.0024", platform: "CPP7.3",
             models: ["FLEXIDOME IP 4000i"] },
    cameras: [
      { device_id: 1, name: "tms-cam-140", ip: "10.92.18.100", site: "TMS",
        model: "FLEXIDOME IP 4000i", firmware: "7.93.0024",
        platform: "CPP7.3", reachability: "up" },
      { device_id: 2, name: "tms-cam-141", ip: "10.92.18.106", site: "TMS",
        model: "FLEXIDOME IP 4000i", firmware: "7.93.0024",
        platform: "CPP7.3", reachability: "up" },
      { device_id: 3, name: "tms-cam-999", ip: "10.92.18.200", site: "TMS",
        model: "FLEXIDOME IP 4000i", firmware: "7.10.0074",
        platform: "CPP7.3", reachability: "up" },
    ],
    selected: [], onToggle: () => {}, onBulk: () => {}, maxBatch: 50 },
   (html) => {
     const text = html.replace(/<!-- -->/g, "");
     if (text.includes("tms-cam-140") || text.includes("tms-cam-141")) {
       throw new Error("an already-updated camera is still listed");
     }
     if (!text.includes("tms-cam-999")) {
       throw new Error("the camera that still needs the image was hidden too");
     }
     if (!text.includes("1</b> eligible now")) throw new Error("eligible count wrong");
     if (!text.includes("2 ruled out")) throw new Error("the ruled-out toggle is missing");
   }],

  // Nothing left to do at this school: say so, rather than an empty table.
  ["CameraPicker · a finished school says so", OPS.CameraPicker, {
    image: { id: 1, version: "7.93.0024", platform: "CPP7.3",
             models: ["FLEXIDOME IP 4000i"] },
    cameras: [
      { device_id: 1, name: "tms-cam-140", ip: "10.92.18.100", site: "TMS",
        model: "FLEXIDOME IP 4000i", firmware: "7.93.0024",
        platform: "CPP7.3", reachability: "up" },
    ],
    selected: [], onToggle: () => {}, onBulk: () => {}, maxBatch: 50 },
   (html) => {
     const text = html.replace(/<!-- -->/g, "");
     if (!text.includes("Nothing at")) throw new Error("no 'nothing to do' message");
     if (!text.includes("0</b> eligible now")) throw new Error("eligible count wrong");
   }],

  ["CameraPicker · one school at a time", OPS.CameraPicker, {
    image: { id: 1, version: "7.93.0024", platform: "CPP7.3",
             models: ["FLEXIDOME IP 5000i IR"] },
    cameras: [
      { device_id: 1, name: "tms-cam-1", ip: "10.1.1.1", site: "TMS",
        model: "FLEXIDOME IP 5000i IR", firmware: "7.83.0027",
        platform: "CPP7.3", reachability: "up" },
      { device_id: 2, name: "tms-cam-2", ip: "10.1.1.2", site: "TMS",
        model: "FLEXIDOME IP 5000i IR", firmware: "7.83.0027",
        platform: "CPP7.3", reachability: "up" },
      { device_id: 3, name: "bhs-cam-1", ip: "10.2.1.1", site: "Bryant High",
        model: "FLEXIDOME IP 5000i IR", firmware: "7.83.0027",
        platform: "CPP7.3", reachability: "up" },
      // A school with nothing left to do still appears — "this one is done" is
      // worth reading when planning the next evening.
      { device_id: 4, name: "sky-cam-1", ip: "10.3.1.1", site: "Skyland",
        model: "FLEXIDOME IP 5000i IR", firmware: "7.93.0024",
        platform: "CPP7.3", reachability: "up" },
    ],
    selected: [], onToggle: () => {}, onBulk: () => {}, maxBatch: 50,
    site: "TMS", onSite: () => {} },
   (html) => {
     const text = html.replace(/<!-- -->/g, "");
     // Filtered to the chosen school...
     if (text.includes("bhs-cam-1")) throw new Error("another school's cameras were listed");
     if (!text.includes("tms-cam-2")) throw new Error("the chosen school's cameras are missing");
     // ...but the chips still count the whole estate, or picking a school would
     // hide the work waiting at the others.
     if (!text.includes("Bryant High")) throw new Error("other schools vanished from the map");
     if (!text.includes("Skyland")) throw new Error("a finished school was hidden");
     if (!text.includes("sp-chip done")) throw new Error("a school with nothing eligible not dimmed");
     if (!text.includes("2</b> eligible now")) throw new Error("per-school eligible count wrong");
     if (!text.includes("at TMS")) throw new Error("the bulk button does not name the school");
   }],

  ["CameraPicker · a school needing more than one batch says so", OPS.CameraPicker, {
    image: { id: 1, version: "7.93.0024", platform: "CPP7.3",
             models: ["FLEXIDOME IP 5000i IR"] },
    cameras: Array.from({ length: 130 }, (_, i) => ({
      device_id: i + 1, name: `tms-cam-${i}`, ip: `10.1.1.${i}`, site: "TMS",
      model: "FLEXIDOME IP 5000i IR", firmware: "7.83.0027",
      platform: "CPP7.3", reachability: "up" })),
    selected: [], onToggle: () => {}, onBulk: () => {}, maxBatch: 50,
    site: "TMS", onSite: () => {} },
   (html) => {
     const text = html.replace(/<!-- -->/g, "");
     // 130 eligible, 50 to a batch: the page says how many evenings this is
     // rather than leaving the cap to look like an obstacle.
     if (!text.includes("3 batches to finish TMS")) {
       throw new Error("the number of batches for this school is not stated");
     }
   }],

  ["CameraPicker · no image chosen yet", OPS.CameraPicker, {
    image: null, cameras: [], selected: [], onToggle: () => {}, onBulk: () => {},
    maxBatch: 50 },
   (html) => {
     if (!html.includes("Choose a firmware image first")) {
       throw new Error("no guidance before an image is picked");
     }
   }],

  ["EssLiveCard · a healthy stream", NS.EssLiveCard, {
    live: { connected: true, reconnects: 0, frames: 7366, events: 24000, applied: 3,
            last_message_at: Date.now() / 1000,
            top_event_types: [["MotionStart", 9354], ["MotionEnd", 9311]] } },
   (html) => {
     const text = html.replace(/<!-- -->/g, "");
     if (!text.includes("connected")) throw new Error("socket state not shown");
     // The gap between events and applied is the filter working, and the card
     // has to make that legible rather than look like a bug.
     if (!text.includes("24,000") || !text.includes("MotionStart 9,354")) {
       throw new Error("stream volume not reported");
     }
     if (!text.includes("never written")) throw new Error("dropped events unexplained");
   }],

  ["EssLiveCard · a socket that is down says so", NS.EssLiveCard, {
    live: { connected: false, reconnects: 12, frames: 0, events: 0, applied: 0,
            last_message_at: null, top_event_types: [] } },
   (html) => {
     if (!html.includes("down")) throw new Error("a dead socket rendered as fine");
   }],

  ["EvidenceLockTab · names the reason it is empty", S.EvidenceLockTab, {},
   (html) => {
     const text = html.replace(/<!-- -->/g, "");
     if (!text.includes("Unknown request")) throw new Error("the gateway's own answer is not quoted");
     if (!text.includes("Smart Client")) throw new Error("no route to the locks that do exist");
   }],

  ["ServerMini · no metrics at all", S.ServerMini, {
    s: { device_id: 3, name: "TRAN-BCD-DVR", site: null, role: null, version: null,
         chans_total: null, storage_total_gb: null, retention_days: null, status: "blind" } }],
  // Automation (spec 22). The canvas itself needs a DOM, but importing the
  // module evaluates it — which is what this harness is for — and the guard
  // panel is the part an operator reads before trusting the engine.
  ["GuardPanel · thresholds come from config", AUTO.GuardPanel, {
    guards: { max_state_age_s: 1800, site_cluster_max: 3, switch_cluster_max: 2,
              require_port_confirmed_within_s: 86400, per_device_cooldown_s: 21600,
              fleet_rate_limit: 6 } },
   (html) => {
     if (!html.includes("G4")) throw new Error("the blast-radius guard is not listed");
     if (!html.includes("3 / site")) throw new Error("the site limit is not shown");
     if (!html.includes("24h")) throw new Error("the port-confidence window is not shown");
   }],

  ["GuardPanel · config not loaded yet", AUTO.GuardPanel, { guards: null },
   (html) => {
     // All ten must still be named: an operator asking "what will stop this?"
     // gets an answer even before /meta lands.
     for (const g of ["G1", "G5", "G10"]) {
       if (!html.includes(g)) throw new Error(`${g} missing without config`);
     }
   }],
];

let failed = 0;
for (const [name, Comp, props, assert] of cases) {
  try {
    const html = renderToString(React.createElement(Comp, props));
    // A component that renders without throwing can still render nonsense, so
    // a case may carry an assertion over the produced HTML.
    if (assert) assert(html);
    console.log(`  ok    ${name}  (${html.length} chars)`);
  } catch (e) {
    failed++;
    console.log(`  FAIL  ${name}\n        ${e.message}`);
  }
}
// ── round-trip: the stored document must survive a lap through the canvas ──
// A bug here does not throw; it silently saves a different workflow than the
// one on screen.
const DOC = {
  nodes: [
    { id: "t", kind: "trigger", label: "Camera down",
      position: { x: 0, y: 200 },
      config: { dimension: "source_status", value: "down", device_type: "camera",
                min_duration_s: 900 } },
    { id: "b", kind: "branch", label: "Ping?", position: { x: 240, y: 200 },
      config: { predicate: "ping_up" } },
    { id: "a", kind: "action", label: "Cycle PoE", position: { x: 500, y: 300 },
      config: { action: "poe_cycle" } },
  ],
  edges: [
    { source: "t", target: "b" },
    { source: "b", target: "a", when: "false" },
  ],
};
try {
  const meta = { predicates: [{ key: "ping_up", question: "does it answer ping?" }],
                 actions: [{ key: "poe_cycle", label: "Cycle PoE", disruptive: true }] };
  const flow = AUTO.toFlow(DOC, meta);
  const back = AUTO.fromFlow(flow.nodes, flow.edges);
  const same = JSON.stringify(back) === JSON.stringify(DOC);
  if (!same) {
    throw new Error(`round-trip changed the document:\n  in  ${JSON.stringify(DOC)}\n  out ${JSON.stringify(back)}`);
  }
  // The branch arm must survive, or the engine routes down the wrong path.
  if (flow.edges.find((e) => e.source === "b").data.when !== "false") {
    throw new Error("branch arm lost in translation");
  }
  // A disruptive action must be flagged on the node itself.
  if (!flow.nodes.find((n) => n.id === "a").data.warn) {
    throw new Error("a disruptive action is not flagged on the canvas");
  }
  console.log("  ok    graph round-trip · stored doc survives the canvas");
} catch (e) {
  failed++;
  console.log(`  FAIL  graph round-trip\n        ${e.message}`);
}

process.exit(failed ? 1 : 0);
