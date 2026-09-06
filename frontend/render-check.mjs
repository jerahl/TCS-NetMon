// Render page components with representative props and assert they do not
// throw. esbuild does not resolve identifiers, so a variable referenced
// outside its scope fails only in the browser — which is how
// "usedKnown is not defined" reached production on the Surveillance page.
import { build } from "esbuild";
import { createRequire } from "module";

const entry = `
export * as surveillance from "./src/pages/surveillance.jsx";
export * as cameraDetail from "./src/pages/camera_detail.jsx";
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
const { surveillance: S, cameraDetail: D, React, renderToString } = mod.exports;

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
