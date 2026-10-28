// Renders a candidate document to a PNG without opening the editor, and prints
// the repairs normalize made to it.
//
//   node scripts/headless-render.mjs design.json -o preview.png
//   node scripts/headless-render.mjs design.json --scale 2
//
// This is the feedback loop an external agent needs: it writes a document, gets
// told what the engine silently changed, and sees what it actually produced.
// It drives a real browser on purpose — the canvas paints through SVG filters,
// foreignObject backdrop-filter and measured text, none of which an offline
// renderer reproduces faithfully, and a preview that lies is worse than none.

import { fileURLToPath, pathToFileURL } from "node:url";
import { loadPlaywright } from "./lib/playwright-loader.mjs";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const outFlag = args.indexOf("-o");
const scaleFlag = args.indexOf("--scale");
// `args[scaleFlag + 1]` with no --scale flag is `args[0]` — the input file
// itself — so the "not a flag's value" test excluded the only candidate and the
// script printed usage for a correct invocation.
const flagValues = new Set(
  [outFlag, scaleFlag].filter((i) => i >= 0).map((i) => args[i + 1])
);
const input = args.find((a) => !a.startsWith("-") && !flagValues.has(a));

if (!input) {
  console.error("usage: node scripts/headless-render.mjs <doc.json> [-o out.png] [--scale 2]");
  process.exit(2);
}

const output = outFlag >= 0 ? args[outFlag + 1] : "preview.png";
const scale = scaleFlag >= 0 ? Number(args[scaleFlag + 1]) : 1;
// The agent kit ships this script next to a blank shell; the repo keeps it two
// directories above `dist/`. Resolving against the script's own location rather
// than `process.cwd()` is what lets the same file serve both — an agent runs it
// from wherever it happens to be standing.
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const shellCandidates = [
  path.resolve(scriptDir, "../blank.fish.html"),
  path.resolve(scriptDir, "../dist/index.html")
];
const shell = shellCandidates.find((p) => fs.existsSync(p));
if (!shell) {
  console.error(
    `no engine shell found. Looked in:\n${shellCandidates.map((p) => `  ${p}`).join("\n")}\n` +
      `Run \`npm run build\` first, or use the shell shipped beside this script.`
  );
  process.exit(2);
}

const { chromium } = await loadPlaywright();

const candidate = JSON.parse(fs.readFileSync(input, "utf-8"));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));
await page.goto(pathToFileURL(shell).href);
await page.waitForFunction(() => !!window.__FISH_BRIDGE__ && !!window.__fish);

const result = await page.evaluate(
  async ([doc, scale]) => {
    const normalized = window.__fish.normalize(doc);
    window.__FISH_BRIDGE__.applyDoc(normalized.document);
    // applyDoc only commits; the SVG still shows the previous document until
    // Preact flushes, and exporting first yields a blank page with no error.
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 60))));
    const dataUrl = await window.__fish.exportCanvasPng({ scale });
    return { repairs: normalized.repairs, dataUrl };
  },
  [candidate, scale]
);

await browser.close();

if (result.dataUrl) {
  const base64 = result.dataUrl.slice(result.dataUrl.indexOf(",") + 1);
  fs.writeFileSync(path.resolve(process.cwd(), output), Buffer.from(base64, "base64"));
}

console.log(JSON.stringify({ output, repairs: result.repairs, pageErrors }, null, 2));
process.exit(pageErrors.length > 0 ? 1 : 0);
