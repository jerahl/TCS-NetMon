// esbuild pipeline: bundle the React UI + CSS to static files served by
// FastAPI from netmon/web/. React is bundled locally (no CDN / no external
// fetch at runtime) — CLAUDE.md §3, Phase 4 DoD.
//
//   npm run build           one-shot production build
//   npm run watch           rebuild on change (local dev)

import { build, context } from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outdir = resolve(here, "../netmon/web");
const watch = process.argv.includes("--watch");

mkdirSync(outdir, { recursive: true });
// The HTML shell is static; copy it alongside the bundle.
copyFileSync(resolve(here, "index.html"), resolve(outdir, "index.html"));

const options = {
  entryPoints: [resolve(here, "src/main.jsx")],
  bundle: true,
  format: "iife",
  jsx: "automatic",
  minify: !watch,
  sourcemap: watch,
  target: ["es2020"],
  outfile: resolve(outdir, "app.js"),
  // Leaflet's CSS references its control PNGs; inline them as data URIs so
  // the bundle stays self-contained (no runtime asset fetches).
  loader: { ".css": "css", ".png": "dataurl" },
  logLevel: "info",
};

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  console.log("watching for changes…");
} else {
  await build(options);
  console.log(`built → ${outdir}`);
}
