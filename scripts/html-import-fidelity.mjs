/**
 * Fidelity report for the HTML importer against a real page.
 *
 * Where `probe-html-import.mjs` asserts the P0 criteria on a built-in sample,
 * this one answers "how far off is THIS file, and where". It renders the page in
 * a clean iframe as ground truth, imports it, and reports the worst box deltas
 * by DOM path alongside the unmapped properties grouped by count — so the gap
 * list is driven by measurement rather than by guessing which CSS is missing.
 *
 *   node scripts/html-import-fidelity.mjs demo/design-directions/a-instrument.html [width] [height]
 */

import { chromium } from "playwright";
import * as esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const file = process.argv[2];
if (!file) {
  console.error("usage: node scripts/html-import-fidelity.mjs <page.html> [viewportWidth] [viewportHeight]");
  process.exit(1);
}
const VIEWPORT_W = Number(process.argv[3] ?? 1280);
const VIEWPORT_H = Number(process.argv[4] ?? 900);
const SAMPLE = fs.readFileSync(path.resolve(file), "utf-8");

const bundle = await esbuild.build({
  stdin: {
    contents: `export { importHtmlDocument } from "./src/core/import/html-import";`,
    resolveDir: root,
    sourcefile: "fidelity-entry.ts",
    loader: "ts"
  },
  bundle: true,
  format: "iife",
  globalName: "FishHtmlImport",
  target: "es2022",
  write: false,
  logLevel: "warning"
});

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: VIEWPORT_W, height: VIEWPORT_H } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => {
  if (m.type() === "error" && !/ERR_|Failed to load resource/.test(m.text())) errors.push(m.text());
});

await page.setContent("<!doctype html><html><body></body></html>");
await page.addScriptTag({ content: bundle.outputFiles[0].text });

const payload = await page.evaluate(
  async ({ sample, width, height }) => {
    const frame = document.createElement("iframe");
    frame.style.cssText = `position:absolute;left:-30000px;top:0;width:${width}px;height:${height}px;border:0`;
    frame.srcdoc = sample;
    document.body.appendChild(frame);
    await new Promise((resolve, reject) => {
      frame.addEventListener("load", resolve, { once: true });
      setTimeout(() => reject(new Error("ground-truth iframe never loaded")), 15000);
    });
    // Let webfonts and images settle inside the frame too.
    try {
      await frame.contentWindow.document.fonts.ready;
    } catch {
      /* no FontFaceSet */
    }

    const truth = {};
    const frameBody = frame.contentDocument.body;
    const base = frameBody.getBoundingClientRect();
    truth.body = { x: 0, y: 0, width: base.width, height: base.height };
    const walkTruth = (el, prefix) => {
      Array.from(el.children).forEach((child, index) => {
        const key = `${prefix}/${index}`;
        const r = child.getBoundingClientRect();
        truth[key] = { x: r.left - base.left, y: r.top - base.top, width: r.width, height: r.height };
        walkTruth(child, key);
      });
    };
    walkTruth(frameBody, "body");

    const result = await FishHtmlImport.importHtmlDocument(sample, { viewportWidth: width, viewportHeight: height, rootName: "Fidelity" });

    const boxes = [];
    const walkEls = (els, ox, oy, parentId) => {
      for (const el of els) {
        const x = ox + el.x;
        const y = oy + el.y;
        boxes.push({
          id: el.id,
          parentId,
          type: el.type,
          name: el.name ?? null,
          x,
          y,
          width: el.width,
          height: el.height,
          layout: el.layout ?? null,
          sizing: el.sizing ?? null
        });
        if (el.children) walkEls(el.children, x, y, el.id);
      }
    };
    walkEls(result.elements, 0, 0, null);

    return { report: result.report, boxes, truth, elementCount: boxes.length, assetCount: result.assets.length };
  },
  { sample: SAMPLE, width: VIEWPORT_W, height: VIEWPORT_H }
);

await browser.close();

const { report, boxes, truth } = payload;
const byId = new Map(boxes.map((b) => [b.id, b]));
const pathById = new Map(report.sources.map((s) => [s.id, s.path]));

const delta = (a, b) =>
  Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.width - b.width), Math.abs(a.height - b.height));

const rows = [];
for (const box of boxes) {
  const key = pathById.get(box.id);
  const t = key ? truth[key] : null;
  if (!t) continue;
  rows.push({ box, key, t, d: delta(box, t) });
}
rows.sort((a, b) => b.d - a.d);

const worst = rows[0]?.d ?? 0;
const over1 = rows.filter((r) => r.d > 1).length;
const over10 = rows.filter((r) => r.d > 10).length;
const textRows = rows.filter((r) => r.box.type === "text");

const unmappedByProperty = new Map();
for (const u of report.unmapped) {
  unmappedByProperty.set(u.property, (unmappedByProperty.get(u.property) ?? 0) + 1);
}
const unmappedSorted = [...unmappedByProperty].sort((a, b) => b[1] - a[1]);

const typeCounts = new Map();
for (const b of boxes) typeCounts.set(b.type, (typeCounts.get(b.type) ?? 0) + 1);

console.log(`\n=== fidelity: ${path.relative(root, path.resolve(file))} @ ${VIEWPORT_W}×${VIEWPORT_H} ===`);
console.log(`elements        : ${payload.elementCount}  (${[...typeCounts].map(([t, n]) => `${t} ${n}`).join(", ")})`);
console.log(`assets          : ${payload.assetCount}`);
console.log(`downgraded      : ${report.downgraded.length}`);
console.log(`unmapped        : ${report.unmapped.length} entries, ${unmappedByProperty.size} distinct properties`);
console.log(`maxDelta (all)  : ${worst.toFixed(2)}px`);
console.log(`maxTextDelta    : ${report.maxTextDelta}px`);
console.log(`elements > 1px  : ${over1} / ${rows.length}   > 10px: ${over10}`);
console.log(`text > 1px      : ${textRows.filter((r) => r.d > 1).length} / ${textRows.length}`);

console.log("\n--- worst 18 boxes ---");
for (const r of rows.slice(0, 18)) {
  const parent = r.box.parentId ? pathById.get(r.box.parentId) : "(root)";
  console.log(
    `  ${r.d.toFixed(1).padStart(7)}px  ${r.key.padEnd(18)} ${String(r.box.type).padEnd(5)} ${String(r.box.name).slice(0, 20).padEnd(20)} ` +
      `got ${fmt(r.box)}  want ${fmt(r.t)}`
  );
  console.log(`           parent ${parent}  layout=${r.box.layout ? JSON.stringify(r.box.layout) : "-"}  sizing=${r.box.sizing ? JSON.stringify(r.box.sizing) : "-"}`);
}

console.log("\n--- unmapped by property ---");
for (const [property, count] of unmappedSorted) {
  console.log(`  ${String(count).padStart(4)}  ${property}`);
  // The VALUE is what says whether the gap is a missing feature or a parse that
  // fell over: a count alone cannot tell `url(...)` from a gradient that was
  // dropped halfway through.
  const samples = [...new Set(report.unmapped.filter((u) => u.property === property).map((u) => u.value))].slice(0, 3);
  for (const sample of samples) console.log(`        · ${sample.slice(0, 110)}`);
}

console.log("\n--- downgraded ---");
for (const d of report.downgraded.slice(0, 15)) console.log(`  ${d.maxDelta}px  ${d.name} (${pathById.get(d.id) ?? d.id})`);

if (errors.length > 0) {
  console.log("\n--- page errors ---");
  for (const e of errors.slice(0, 6)) console.log(`  ${e}`);
}
console.log("");

function fmt(b) {
  return `${Math.round(b.x)},${Math.round(b.y)} ${Math.round(b.width)}×${Math.round(b.height)}`;
}
