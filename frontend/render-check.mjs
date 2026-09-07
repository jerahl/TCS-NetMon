// Render page components with representative props and assert they do not
// throw. esbuild does not resolve identifiers, so a variable referenced
// outside its scope fails only in the browser — which is how
// "usedKnown is not defined" reached production on the Surveillance page.
import { build } from "esbuild";
import { createRequire } from "module";

const entry = `
export * as surveillance from "./src/pages/surveillance.jsx";
export * as cameraDetail from "./src/pages/camera_detail.jsx";
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
const { surveillance: S, cameraDetail: D, primitives: P, React, renderToString } = mod.exports;

const CAM = (over) => ({ device_id: 1, name: "chs-cam-1", site: "Central High",
  model: "Bosch FLEXIDOME", recording_state: "up", recording_server: "CHS-BCD-DVR",
  ip: "10.32.18.4", ...over });

const cases = [
  ["CamerasTab · every status tier", S.CamerasTab, {
    counts: { up: 2422, down: 228, down_confirmed: 82, down_source_only: 15,
              down_network_only: 131, blind: 139, unknown: 1 } }],
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

  // Camera detail with everything resolved: the path where the port is known
  // and PoE cycling is offered.
  ["CameraDetailView · full uplink", D.CameraDetailView, {
    cam: { ...CAM(), state: {
             source_status: { value: "up", source: "milestone-ess" },
             ping: { value: "up", updated_at: "2026-09-06T12:00:00Z" },
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
                 last_port: "4:37", online: 1, updated_at: "2026-09-06T12:00:00Z" },
           siblings: [{ device_id: 2, name: "chs-cam-1 - Camera 2", recording_state: "up" }] },
    meta: { packetfence_url: "https://pf.example" } }],

  // …and the honest-gap path: blind, no port resolved, no PF record. The page
  // must still render and say why each thing is missing rather than blank out.
  ["CameraDetailView · blind, unresolved", D.CameraDetailView, {
    cam: { ...CAM({ ip: null, recording_state: null }),
           state: { source_status: { value: "blind", source: "milestone" } },
           switch_port: null, pf: null, siblings: [] },
    meta: {} }],

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
