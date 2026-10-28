import { chromium } from "playwright";
import { pathToFileURL } from "url";
import path from "path";

const html = path.resolve(process.cwd(), process.argv[2] ?? "dist/index.html");
const results = [];
const check = (name, actual, expected) => {
  results.push({ name, ok: JSON.stringify(actual) === JSON.stringify(expected), actual, expected });
};
const checkNear = (name, actual, expected, tol = 1) => {
  const ok = typeof actual === "number" && Math.abs(actual - expected) <= tol;
  results.push({ name, ok, actual, expected });
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});

await page.goto(pathToFileURL(html).href);
await page.waitForFunction(() => !!window.__FISH_BRIDGE__);

// Re-applied before every section: a fault in one gesture must not cascade into
// the next section's geometry assertions.
const applySetup = () =>
  page.evaluate(() => {
    const bridge = window.__FISH_BRIDGE__;
    const base = bridge.getDoc();
    const rect = (id, x, y, w, h) => ({
      id, type: "rect", name: id, x, y, width: w, height: h,
      fills: [{ type: "solid", color: "#3B82F6" }]
    });
    bridge.setElements([
        rect("alpha", 100, 100, 200, 150),
        { id: "gamma", type: "line", name: "gamma", x: 600, y: 400, dx: 200, dy: 100, width: 200, height: 100, strokes: [{ color: "#FFFFFF", width: 3 }] }
      ], { canvas: { ...base.canvas, width: 4000, height: 3000 } });
  });

const readView = () =>
  page.evaluate(() => {
    const svg = document.querySelector("svg.pointer-events-auto");
    const box = svg.parentElement.getBoundingClientRect();
    const m = /translate\((-?[\d.]+), (-?[\d.]+)\) scale\(([\d.]+)\)/.exec((() => { const s = document.querySelector("[data-stage-transform]"); const a = s && s.getAttribute("transform"); if (a) return a; const svg = s && s.ownerSVGElement; const t = svg ? getComputedStyle(svg).transform : ""; const m = /matrix\(([\d.eE+-]+), 0, 0, ([\d.eE+-]+), ([\d.eE+-]+), ([\d.eE+-]+)\)/.exec(t); return m ? "translate(" + m[3] + ", " + m[4] + ") scale(" + m[1] + ")" : null; })());
    return {
      pan: { x: parseFloat(m[1]), y: parseFloat(m[2]) },
      zoom: parseFloat(m[3]),
      rect: { left: box.left, top: box.top, width: box.width, height: box.height }
    };
  });
const toScreen = async (wx, wy) => {
  const v = await readView();
  return { x: v.rect.left + v.pan.x + wx * v.zoom, y: v.rect.top + v.pan.y + wy * v.zoom };
};
const getEl = (id) =>
  page.evaluate((elId) => window.__FISH_BRIDGE__.getElements().find((e) => e.id === elId), id);
const elementCount = () => page.evaluate(() => window.__FISH_BRIDGE__.getElements().length);
const selected = () => page.evaluate(() => window.__FISH_BRIDGE__.getSelectedIds());
const settle = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
const drag = async (from, dx, dy, button = "left") => {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down({ button });
  for (let i = 1; i <= 10; i++) await page.mouse.move(from.x + (dx * i) / 10, from.y + (dy * i) / 10);
  await page.mouse.up({ button });
  await settle();
};
const clearSelection = async () => {
  const empty = await emptyScreenPoint();
  await page.mouse.click(empty.x, empty.y);
  await settle();
};
// Pan accumulates across sections, so an empty spot is found in screen space and
// hit-tested: a world coordinate would drift off the viewport after a few pans.
const emptyScreenPoint = async () => {
  const v = await readView();
  const cands = [[0.5, 0.5], [0.3, 0.25], [0.7, 0.3], [0.35, 0.7], [0.75, 0.65], [0.2, 0.45]];
  for (const [fx, fy] of cands) {
    const x = v.rect.left + v.rect.width * fx;
    const y = v.rect.top + v.rect.height * fy;
    const empty = await page.evaluate(
      ([px, py]) => document.elementFromPoint(px, py)?.tagName?.toLowerCase() === "svg",
      [x, y]
    );
    if (empty) return { x, y };
  }
  throw new Error("no empty screen point found");
};
// A middle press is not a click, so it must never select anything anywhere.
const middleDrag = async (wx, wy, dx, dy) => {
  const before = await readView();
  await drag(await toScreen(wx, wy), dx, dy, "middle");
  const after = await readView();
  return { dx: after.pan.x - before.pan.x, dy: after.pan.y - before.pan.y };
};

await applySetup();
await settle();

// 1. Middle press landing on an element must pan, not select or move it.
await clearSelection();
check("setup: nothing selected", await selected(), []);
let pan = await middleDrag(200, 175, 120, 80);
checkNear("middle drag over element pans x", pan.dx, 120);
checkNear("middle drag over element pans y", pan.dy, 80);
check("middle drag over element selects nothing", await selected(), []);
let alpha = await getEl("alpha");
check("middle drag over element does not move it", [alpha.x, alpha.y], [100, 100]);

// 2. Middle press on a selected element's resize handle must pan, not resize.
await applySetup();
await page.evaluate(() => window.__FISH_BRIDGE__.selectElement("alpha"));
await settle();
pan = await middleDrag(300, 250, 60, 45);
checkNear("middle drag on resize handle pans x", pan.dx, 60);
checkNear("middle drag on resize handle pans y", pan.dy, 45);
alpha = await getEl("alpha");
check("middle drag on resize handle keeps size", [alpha.width, alpha.height], [200, 150]);
check("middle drag on resize handle keeps selection", await selected(), ["alpha"]);

// 3. Middle press on a line endpoint handle must pan, not move the endpoint.
await applySetup();
await page.evaluate(() => window.__FISH_BRIDGE__.selectElement("gamma"));
await settle();
pan = await middleDrag(800, 500, 40, 30);
checkNear("middle drag on line endpoint pans x", pan.dx, 40);
checkNear("middle drag on line endpoint pans y", pan.dy, 30);
let gamma = await getEl("gamma");
check("middle drag on line endpoint keeps endpoint", [gamma.dx, gamma.dy], [200, 100]);

// 4. Middle press on empty canvas pans and selects nothing.
await applySetup();
await clearSelection();
pan = await middleDrag(500, 800, 70, 50);
checkNear("middle drag on empty canvas pans x", pan.dx, 70);
checkNear("middle drag on empty canvas pans y", pan.dy, 50);
check("middle drag on empty canvas selects nothing", await selected(), []);

// 5. Middle press while a shape tool is armed must not start drawing.
await applySetup();
await clearSelection();
await page.keyboard.press("r");
await settle();
// Prove the tool really armed before trusting the assertions below: a left drag
// on empty canvas with the rect tool must create exactly one element.
const countBefore = await elementCount();
await drag(await emptyScreenPoint(), 90, 70, "left");
check("rect tool armed (left drag draws one rect)", await elementCount(), countBefore + 1);
await page.keyboard.press("v");
await settle();
await applySetup();
await clearSelection();
await page.keyboard.press("r");
await settle();
pan = await middleDrag(200, 175, 90, 60);
checkNear("middle drag with rect tool pans x", pan.dx, 90);
checkNear("middle drag with rect tool pans y", pan.dy, 60);
check("middle drag with rect tool creates no element", await elementCount(), countBefore);
check("middle drag with rect tool selects nothing", await selected(), []);
await page.keyboard.press("v");
await settle();

// 6. The primary button must still select and drag (no over-blocking).
await applySetup();
await clearSelection();
const before = await readView();
await drag(await toScreen(200, 175), 75, 45, "left");
const after = await readView();
checkNear("left drag does not pan x", after.pan.x - before.pan.x, 0);
check("left drag selects the element", await selected(), ["alpha"]);
alpha = await getEl("alpha");
// Tolerance covers snap guides: the point is that the primary button still drags.
checkNear("left drag still moves the element x", alpha.x, 175, 25);
checkNear("left drag still moves the element y", alpha.y, 145, 25);

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : `  -> ${JSON.stringify(r.actual)} (expected ${JSON.stringify(r.expected)})`}`);
}
console.log(`\n${results.length - failed.length}/${results.length} passed`);
console.log("pageErrors", errors.slice(0, 5));

await browser.close();
process.exit(failed.length === 0 && errors.length === 0 ? 0 : 1);
