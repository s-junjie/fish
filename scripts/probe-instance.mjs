import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const file = process.argv[2];
if (!file) {
  console.error("usage: node scripts/probe-instance.mjs <file.fish.html> [instanceId]");
  process.exit(1);
}
const targetId = process.argv[3];

const abs = path.resolve(file);
const html = fs.readFileSync(abs, "utf-8");
const m = html.match(/<script\s+id=["']design-doc["'][^>]*>([\s\S]*?)<\/script>/i);
const doc = JSON.parse(m[1]);

const pages = doc.pages || [];
const activePage = pages.find((p) => p.id === doc.activePageId) || pages[0];
const all = [];
(function walk(els) { for (const e of els) { all.push(e); if (e.children) walk(e.children); } })(activePage?.children || []);
const byId = new Map(all.map((e) => [e.id, e]));

// pick target instance
const inst = targetId ? byId.get(targetId) : all.find((e) => e.type === "instance");
if (!inst || inst.type !== "instance") { console.error("no instance found"); process.exit(1); }
const master = byId.get(inst.componentId);
const countSubtree = (e) => 1 + (e.children || []).reduce((a, c) => a + countSubtree(c), 0);
console.log(`instance ${inst.id} "${inst.name}" @(${inst.x},${inst.y}) ${inst.width}x${inst.height} componentId=${inst.componentId}`);
console.log(`master subtree size: ${countSubtree(master)} nodes, direct children: ${(master.children || []).length}`);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 2400, height: 2000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (msg) => { if (msg.type() === "error") errors.push(msg.text()); });

await page.goto("file://" + abs);
await page.waitForTimeout(2500);

const probe = await page.evaluate((instId) => {
  const root = document.querySelector(`[data-element-id="${instId}"]`);
  if (!root) return { found: false };
  const desc = root.querySelectorAll("[data-element-id]");
  const box = root.getBoundingClientRect();
  const tagInfo = Array.from(desc).slice(0, 12).map((d) => {
    const b = d.getBoundingClientRect();
    return {
      id: d.getAttribute("data-element-id"),
      tag: d.tagName,
      x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height),
      fill: getComputedStyle(d).fill || getComputedStyle(d).backgroundColor,
      opacity: getComputedStyle(d).opacity,
      visibility: getComputedStyle(d).visibility,
      display: getComputedStyle(d).display,
      text: d.tagName === "text" ? (d.textContent || "").slice(0, 30) : undefined,
    };
  });
  return {
    found: true,
    tag: root.tagName,
    box: { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.width), h: Math.round(box.height) },
    descendants: desc.length,
    innerLen: root.innerHTML.length,
    sample: tagInfo,
  };
}, inst.id);

console.log("=== DOM probe ===");
console.log(JSON.stringify(probe, null, 1));

// screenshot the instance region (clipped)
const out = `figma-imports/probe-${inst.id}.png`;
if (probe.found) {
  await page.screenshot({ path: out, clip: { x: Math.max(0, probe.box.x - 20), y: Math.max(0, probe.box.y - 20), width: Math.min(1800, probe.box.w + 40), height: Math.min(1600, probe.box.h + 40) } });
  console.log("screenshot:", out);
}
console.log("page errors:", errors.length ? errors.slice(0, 5) : "none");
await browser.close();
