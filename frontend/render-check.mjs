// Render page components with representative props and assert they do not
// throw. esbuild does not resolve identifiers, so a variable referenced
// outside its scope fails only in the browser — which is how
// "usedKnown is not defined" reached production on the Surveillance page.
import { build } from "esbuild";
import { createRequire } from "module";

const entry = `
export * as surveillance from "./src/pages/surveillance.jsx";
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
const { surveillance: S, React, renderToString } = mod.exports;

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
];

let failed = 0;
for (const [name, Comp, props] of cases) {
  try {
    const html = renderToString(React.createElement(Comp, props));
    console.log(`  ok    ${name}  (${html.length} chars)`);
  } catch (e) {
    failed++;
    console.log(`  FAIL  ${name}\n        ${e.message}`);
  }
}
process.exit(failed ? 1 : 0);
