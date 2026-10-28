import { chromium } from "playwright";
import { pathToFileURL } from "url";
import path from "path";

// A resize must reach the layers INSIDE the frame while the handle is still moving,
// not only when it is released. The per-frame pass used to be a single bottom-up
// walk: `resizeStackWithPins` freshens the dragged frame's own children, but a child
// TWO levels down is still laid out before the frame in between has its new width,
// so the boxes in between move and their contents stand still until pointerup runs
// the full two-pass relayout. Structure below: P > F1 (fill) > F2 (fill) > g1, g2.
const html = path.resolve(process.cwd(), process.argv[2] ?? "dist/index.html");
const results = [];
const check = (name, ok, detail) => results.push({ name, ok: !!ok, detail });
const checkNear = (name, actual, expected, tol = 1) =>
  check(name, typeof actual === "number" && Math.abs(actual - expected) <= tol, `got ${actual}, want ${expected}`);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});

await page.goto(pathToFileURL(html).href);
await page.waitForFunction(() => !!window.__FISH_BRIDGE__);

await page.evaluate(() => {
  const bridge = window.__FISH_BRIDGE__;
  const base = bridge.getDoc();
  const fill = () => ({ width: "fill", height: "fixed" });
  const row = (id, w, h, children, sizing) => ({
    id,
    type: "frame",
    name: id,
    x: 0,
    y: 0,
    width: w,
    height: h,
    sizing,
    fills: [{ type: "solid", color: "#374151" }],
    display: "flex",
    "flex-direction": "row",
    gap: 0,
    padding: 0,
    "align-items": "flex-start",
    children
  });
  const leaf = (id) => ({
    id,
    type: "rect",
    name: id,
    x: 0,
    y: 0,
    width: 100,
    height: 40,
    sizing: fill(),
    fills: [{ type: "solid", color: "#3B82F6" }]
  });
  bridge.setElements(
    [
      row(
        "P",
        400,
        300,
        [row("F1", 400, 200, [row("F2", 400, 100, [leaf("g1"), leaf("g2")], fill())], fill())],
        { width: "fixed", height: "fixed" }
      )
    ].map((el) => ({ ...el, x: 200, y: 200 })),
    { canvas: { ...base.canvas, width: 4000, height: 3000 } }
  );
});

const readView = () =>
  page.evaluate(() => {
    const svg = document.querySelector("svg.pointer-events-auto");
    const box = svg.parentElement.getBoundingClientRect();
    const s = document.querySelector("[data-stage-transform]");
    const a = s && s.getAttribute("transform");
    if (a) {
      const m = /translate\((-?[\d.]+), (-?[\d.]+)\) scale\(([\d.]+)\)/.exec(a);
      return { pan: { x: +m[1], y: +m[2] }, zoom: +m[3], rect: { left: box.left, top: box.top } };
    }
    const owner = s && s.ownerSVGElement;
    const m = /matrix\(([\d.eE+-]+), 0, 0, ([\d.eE+-]+), ([\d.eE+-]+), ([\d.eE+-]+)\)/.exec(
      owner ? getComputedStyle(owner).transform : ""
    );
    return { pan: { x: +m[3], y: +m[4] }, zoom: +m[1], rect: { left: box.left, top: box.top } };
  });
const toScreen = async (wx, wy) => {
  const v = await readView();
  return { x: v.rect.left + v.pan.x + wx * v.zoom, y: v.rect.top + v.pan.y + wy * v.zoom };
};
const settle = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
const readTree = () =>
  page.evaluate(() => {
    const find = (nodes, id) => {
      for (const n of nodes) {
        if (n.id === id) return n;
        const hit = n.children ? find(n.children, id) : null;
        if (hit) return hit;
      }
      return null;
    };
    const roots = window.__FISH_BRIDGE__.getElements();
    const box = (id) => {
      const n = find(roots, id);
      return { x: n.x, y: n.y, width: n.width, height: n.height };
    };
    return { P: box("P"), F1: box("F1"), F2: box("F2"), g1: box("g1"), g2: box("g2") };
  });

await settle();
await page.evaluate(() => window.__FISH_BRIDGE__.selectElement("P"));
await settle();

// East handle of P sits on x = 600, mid height. The drag is driven in SCREEN pixels,
// which the gesture divides by the zoom to get world units.
const view = await readView();
const from = await toScreen(600, 350);
const dx = 200 * view.zoom;
await page.mouse.move(from.x, from.y);
await page.mouse.down();
for (let i = 1; i <= 10; i++) await page.mouse.move(from.x + (dx * i) / 10, from.y);
await settle();

const mid = await readTree();
checkNear("the dragged frame takes the new width", mid.P.width, 600);
checkNear("its fill child follows immediately", mid.F1.width, 600);
checkNear("so does the frame inside that", mid.F2.width, 600);
checkNear("the leaf two levels down is re-measured in the same frame", mid.g1.width, 300);
checkNear("and its sibling moves over", mid.g2.x, 300);
checkNear("the sibling is re-measured too", mid.g2.width, 300);

await page.mouse.up();
await settle();

const after = await readTree();
checkNear("releasing changes nothing", after.g1.width, 300);
checkNear("releasing keeps the sibling where it was", after.g2.x, 300);

const failed = results.filter((r) => !r.ok);
const pageErrors = errors.filter((e) => !/favicon/i.test(e));
console.log(JSON.stringify({ results, errors: pageErrors }, null, 2));
await browser.close();
if (failed.length || pageErrors.length) process.exit(1);
