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
export * as primitives from "./src/primitives.jsx";
export { default as React } from "react";
export { renderToString } from "react-dom/server";
`;
const res = await build({
  stdin: { contents: entry, resolveDir: process.cwd(), loader: "jsx" },
  bundle: true, write: false, format: "cjs", platform: "node",
  jsx: "automatic", logLevel: "silent",
});
const require = createRequire(import.meta.url);
const mod = { exports: {} };
new Function("module", "exports", "require", res.outputFiles[0].text)(mod, mod.exports, require);
const { surveillance: S, cameraDetail: D, cameras: C, primitives: P, React, renderToString } = mod.exports;

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

  ["CameraPreview · no proxy, no address", D.CameraPreview, {
    cam: { name: "cam-x", resolution: null, fps_target: null, codec: null }, url: null },
   (html) => {
     if (!html.includes("No preview")) throw new Error("empty preview did not say so");
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
  ["ServerMini · no metrics at all", S.ServerMini, {
    s: { device_id: 3, name: "TRAN-BCD-DVR", site: null, role: null, version: null,
         chans_total: null, storage_total_gb: null, retention_days: null, status: "blind" } }],
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
process.exit(failed ? 1 : 0);
