import { chromium } from "playwright";
import { pathToFileURL } from "node:url";
import path from "node:path";

// A tilt is a projection, so the selected outline cannot be the flat rectangle
// `worldMatrixOf` describes. Chrome draws the projected quad from the same
// homography the export bakes with, and drops the transform handles whose drag
// math still reads the flat box.
const html = path.resolve(process.cwd(), process.argv[2] ?? "dist/index.html");
const results = [];
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  results.push({ name, ok: !!ok });
};

const BASE = {
  id: "card", type: "rect", name: "Card",
  x: 120, y: 100, width: 260, height: 160,
  fills: [{ type: "solid", color: "#E8A33D" }]
};
const OTHER = { ...BASE, id: "other", x: 420, y: 100, width: 120, height: 90 };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(pathToFileURL(html).href);
await page.waitForFunction(() => !!window.__FISH_BRIDGE__);

async function load(children, selected = ["card"]) {
  await page.evaluate(async ({ children, selected }) => {
    const bridge = window.__FISH_BRIDGE__;
    bridge.applyDoc(window.__fish.normalize({
      version: "0.1",
      canvas: { width: 600, height: 400 },
      pages: [{ id: "p1", name: "Page 1", children }]
    }).document);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 110))));
    bridge.selectElements(selected);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 110))));
  }, { children, selected });
}

const measure = () => page.evaluate(() => {
  const poly = document.querySelector('[data-selection-tilt="true"]');
  const rect = [...document.querySelectorAll('rect[fill="none"]')].find(
    (r) => r.getAttribute("width") === "260" && r.getAttribute("height") === "160"
  );
  const g = document.querySelector('[data-element-id="card"]');
  const painted = g && (g.querySelector('[data-tilt-fo] div') || g.querySelector("rect") || g.querySelector("path"));
  const box = (n) => {
    if (!n) return null;
    const q = n.getBoundingClientRect();
    return { x: +q.x.toFixed(2), y: +q.y.toFixed(2), w: +q.width.toFixed(2), h: +q.height.toFixed(2) };
  };
  const a = box(poly), b = box(painted);
  const delta = a && b ? {
    dx: +(a.x - b.x).toFixed(2), dy: +(a.y - b.y).toFixed(2),
    dw: +(a.w - b.w).toFixed(2), dh: +(a.h - b.h).toFixed(2)
  } : null;
  return {
    hasPoly: !!poly,
    hasRect: !!rect,
    points: poly ? poly.getAttribute("points") : null,
    resize: document.querySelectorAll('[data-resize-handle]').length,
    rotate: document.querySelectorAll('[data-rotate-handle]').length,
    radius: document.querySelectorAll('[data-radius-handle]').length,
    multiPolys: document.querySelectorAll('g[stroke-dasharray="2 2"] polygon').length,
    multiRects: document.querySelectorAll('g[stroke-dasharray="2 2"] rect').length,
    delta
  };
});

const aligned = (m) => m.delta && Object.values(m.delta).every((v) => Math.abs(v) < 0.5);

await load([BASE]);
const flat = await measure();
check("a flat layer keeps its rectangular outline", flat.hasRect && !flat.hasPoly);
check("a flat layer keeps resize and rotate handles", flat.resize > 0 && flat.rotate > 0);

await load([{ ...BASE, rotateX: 30 }]);
const tilted = await measure();
check("a tilted layer draws a projected quad", tilted.hasPoly && !tilted.hasRect);
check("the quad sits on the painted artwork", aligned(tilted), JSON.stringify(tilted.delta));
check("the quad is not a rectangle", (() => {
  const p = tilted.points.split(" ").map((s) => s.split(",").map(Number));
  return Math.abs(p[0][0] - p[3][0]) > 1 || Math.abs(p[0][1] - p[1][1]) > 1;
})(), tilted.points);
check("tilt hides resize, rotate and radius handles", tilted.resize === 0 && tilted.rotate === 0 && tilted.radius === 0);

// A 2D rotation on the same layer is lesson 11's case: Chromium moves the
// projection's vanishing point, so the exact quad and the pixels no longer
// coincide. It must still beat the flat rectangle it replaced.
await load([{ ...BASE, rotation: 30, rotateX: 30 }]);
const composed = await measure();
check("a rotated tilted layer still draws a quad", composed.hasPoly);
const comparison = await page.evaluate(() => {
  const poly = document.querySelector('[data-selection-tilt="true"]');
  const g = document.querySelector('[data-element-id="card"]');
  const painted = g.querySelector('[data-tilt-fo] div');
  const probe = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  for (const [k, v] of Object.entries({ x: "120", y: "100", width: "260", height: "160", fill: "none" })) {
    probe.setAttribute(k, v);
  }
  poly.parentElement.appendChild(probe);
  const b = (n) => { const q = n.getBoundingClientRect(); return [q.x, q.y, q.width, q.height]; };
  const p = b(painted), f = b(probe), q = b(poly);
  probe.remove();
  const err = (a) => +a.reduce((s, v, i) => s + Math.abs(v - p[i]), 0).toFixed(2);
  return { flat: err(f), quad: err(q) };
});
check("under a 2D rotation the quad beats the flat box", comparison.quad < comparison.flat,
  `flat ${comparison.flat}px vs quad ${comparison.quad}px`);

await load([{ ...BASE, rotateX: 30 }]);
await page.keyboard.press("Equal");
await page.waitForTimeout(260);
const zoomed = await measure();
check("the quad stays aligned at another zoom", zoomed.hasPoly && aligned(zoomed), JSON.stringify(zoomed.delta));
await page.keyboard.press("Minus");
await page.waitForTimeout(260);

await load([{ ...BASE, rotateX: 30 }, OTHER], ["card", "other"]);
const multi = await measure();
check("a multi-selection outlines the tilted layer as a quad", multi.multiPolys === 1);
check("the flat sibling keeps a rectangle outline", multi.multiRects === 1);

await load([{ ...BASE, rotateX: 89, perspective: 50 }]);
const degenerate = await measure();
check("a projection behind the viewer falls back to the rectangle", degenerate.hasRect && !degenerate.hasPoly);

await load([BASE]);
const restored = await measure();
check("removing tilt restores the rectangle and its handles", restored.hasRect && restored.resize > 0 && restored.rotate > 0);

check("no page errors", errors.length === 0, errors[0] ?? "");

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) process.exit(1);
