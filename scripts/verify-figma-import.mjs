#!/usr/bin/env node
// Headless render verification for Figma-imported .fish.html files.
//
// Unlike a string assertion, this loads the real document in Chromium and
// measures geometry of actual rendered SVG nodes. It reports:
//   - how many [data-element-id] nodes the engine actually drew
//   - console / page errors (a crash shows up here, not just in markup)
//   - whether content landed on-screen (negative-origin regression check)
//   - a geometry cross-check on a sample of nodes vs the design-doc
//
// Usage: node scripts/verify-figma-import.mjs <file.fish.html>

import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const file = process.argv[2];
if (!file) {
  console.error("usage: node scripts/verify-figma-import.mjs <file.fish.html> [--viewport WxH]");
  process.exit(1);
}
let viewportArg = "1600x1000";
for (let i = 3; i < process.argv.length; i++) {
  if (process.argv[i] === "--viewport") viewportArg = process.argv[++i];
}
const [vw, vh] = viewportArg.split("x").map((n) => parseInt(n, 10));
const VIEWPORT = { width: vw || 1600, height: vh || 1000 };

const html = fs.readFileSync(file, "utf-8");
const m = html.match(/<script\s+id=["']design-doc["'][^>]*>([\s\S]*?)<\/script>/i);
if (!m) {
  console.error("no design-doc block found");
  process.exit(1);
}
const doc = JSON.parse(m[1]);

// Flatten design-doc nodes, keeping id for the sample cross-check.
const pages = doc.pages || [];
const activeElements =
  (pages.find((p) => p.id === doc.activePageId)?.children || pages[0]?.children || []);
const flat = [];
(function walk(els) {
  for (const e of els) {
    flat.push(e);
    if (e.children) walk(e.children);
  }
})(activeElements);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: VIEWPORT });
const errors = [];
page.on("console", (msg) => {
  if (msg.type() === "error") errors.push(msg.text());
});
page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));

await page.goto("file://" + path.resolve(file), { waitUntil: "load" });
await page.waitForSelector("[data-element-id]", { timeout: 60000 });
// Let the engine settle the initial layout / zoom.
await page.waitForTimeout(2500);

const result = await page.evaluate((expectedIds) => {
  const nodes = Array.from(document.querySelectorAll("[data-element-id]"));
  const first = nodes[0];
  const svg = first ? first.closest("svg") : document.querySelector("svg");
  const svgBox = svg ? svg.getBoundingClientRect() : { left: 0, top: 0, width: 0, height: 0 };

  let zero = 0;
  let negativeOrigin = 0;
  for (const n of nodes) {
    const b = n.getBoundingClientRect();
    if (b.width === 0 && b.height === 0) zero++;
    if (b.left - svgBox.left < -2 && b.top - svgBox.top < -2) negativeOrigin++;
  }

  const sample = expectedIds.slice(0, 30).map((id) => {
    const el = document.querySelector(`[data-element-id="${CSS.escape(id)}"]`);
    if (!el) return { id, missing: true };
    const b = el.getBoundingClientRect();
    return {
      id,
      rendered: { w: Math.round(b.width), h: Math.round(b.height) },
      onscreen: b.right > 0 && b.bottom > 0 && b.left < window.innerWidth && b.top < window.innerHeight,
    };
  });

  return {
    total: nodes.length,
    zero,
    negativeOrigin,
    sample,
    viewport: { w: window.innerWidth, h: window.innerHeight },
    svg: { w: Math.round(svgBox.width), h: Math.round(svgBox.height) },
  };
}, flat.slice(0, 30).map((e) => e.id));

await browser.close();

console.log("== Figma import render verification ==");
console.log("rendered [data-element-id]:", result.total);
console.log("zero-size nodes:        ", result.zero);
console.log(
  "negative-origin nodes:  ",
  result.negativeOrigin,
  result.negativeOrigin > 0 ? "  <-- OFF-CANVAS regression" : "  (none, good)"
);
console.log("console/page errors:    ", errors.length ? errors.slice(0, 10) : "none");
console.log("svg size:               ", `${result.svg.w}x${result.svg.h}`, "| viewport", `${result.viewport.w}x${result.viewport.h}`);
console.log("sample (first 30 design-doc nodes):");
for (const s of result.sample) {
  if (s.missing) console.log("   ", s.id, "MISSING in DOM");
  else console.log("   ", s.id, "|", `${s.rendered.w}x${s.rendered.h}`, s.onscreen ? "onscreen" : "OFF");
}
