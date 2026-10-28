import { chromium } from "playwright";
import { pathToFileURL } from "url";
import path from "path";

// Alt/Option on a resize handle pins the CENTRE instead of the edge opposite the
// handle — Figma's reading of the gesture, and the mirror of what the same key
// does on a move (duplicate). The unit tests pin `resolveResizeBox`; this pins the
// three things only a real editor can answer: that the handle drag reaches it,
// that the modifier is read per frame rather than at pointer-down, and that the
// key does NOT also arm the duplicate — a resize is not a move, and a copy
// appearing under an Alt-resize would be the two gestures colliding.
const html = path.resolve(process.cwd(), process.argv[2] ?? "dist/index.html");
const results = [];
const check = (name, actual, expected) =>
  results.push({ name, ok: JSON.stringify(actual) === JSON.stringify(expected), actual, expected });
const checkNear = (name, actual, expected, tol = 3) => {
  const ok =
    Array.isArray(actual) && actual.length === expected.length && actual.every((v, i) => Math.abs(v - expected[i]) <= tol);
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

const applySetup = (elements) =>
  page.evaluate((els) => {
    const bridge = window.__FISH_BRIDGE__;
    const base = bridge.getDoc();
    bridge.setElements(JSON.parse(JSON.stringify(els)), { canvas: { ...base.canvas, width: 4000, height: 3000 } });
  }, elements);

// Both boxes sit in the left half of the world, so every handle is on the
// visible canvas rather than under the 288px inspector rail on the right.
const R = { id: "R", type: "rect", name: "R", x: 200, y: 300, width: 200, height: 100, fills: [{ type: "solid", color: "#3B82F6" }] };
const S = { id: "S", type: "rect", name: "S", x: 600, y: 900, width: 100, height: 100, fills: [{ type: "solid", color: "#EF4444" }] };
const BOX = [R, S];

const settle = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
const getEl = (id) =>
  page.evaluate((elId) => {
    const f = window.__FISH_BRIDGE__.getElements().find((e) => e.id === elId);
    return f ? { x: f.x, y: f.y, width: f.width, height: f.height } : null;
  }, id);
const elementCount = () => page.evaluate(() => window.__FISH_BRIDGE__.getElements().length);
const measureOverlays = () => page.locator("[data-measure-overlay]").count();
const select = async (id) => {
  await page.evaluate((elId) => window.__FISH_BRIDGE__.selectElement(elId), id);
  await settle();
};
/**
 * The handle's own box, read off the DOM. Deriving it from world coordinates
 * would be a second implementation of the overlay's layout, and it silently
 * stops testing anything the day the two disagree — it put the group handle
 * behind the inspector rail on the first run.
 */
const handleAt = async (type) => {
  const box = await page.locator(`[data-multi-resize-handle="${type}"]`).boundingBox();
  if (!box) throw new Error(`no multi handle ${type}`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
};
const singleHandleAt = async (type) => {
  const box = await page.locator(`[data-resize-handle="${type}"]`).boundingBox();
  if (!box) throw new Error(`no single handle ${type}`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
};

const readView = () =>
  page.evaluate(() => {
    const m = /translate\((-?[\d.]+), (-?[\d.]+)\) scale\(([\d.]+)\)/.exec((() => { const s = document.querySelector("[data-stage-transform]"); const a = s && s.getAttribute("transform"); if (a) return a; const svg = s && s.ownerSVGElement; const t = svg ? getComputedStyle(svg).transform : ""; const m = /matrix\(([\d.eE+-]+), 0, 0, ([\d.eE+-]+), ([\d.eE+-]+), ([\d.eE+-]+)\)/.exec(t); return m ? "translate(" + m[3] + ", " + m[4] + ") scale(" + m[1] + ")" : null; })());
    return { zoom: parseFloat(m[3]) };
  });
const { zoom } = await readView();
// Drags are in SCREEN pixels; the gesture divides by the zoom itself.
const world = (n) => Math.round(n * zoom);

const dragFrom = async (from, dx, dy, modifiers = [], { sample = null } = {}) => {
  for (const m of modifiers) await page.keyboard.down(m);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) {
    await page.mouse.move(from.x + (dx * i) / 10, from.y + (dy * i) / 10);
    if (sample && i === 10) {
      await settle();
      await sample();
    }
  }
  await page.mouse.up();
  for (const m of modifiers) await page.keyboard.up(m);
  await settle();
};

/** The modifier arrives halfway through: `at` is the move index it is pressed on. */
const dragWithLateModifier = async (from, dx, dy, at, modifier) => {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= at; i++) await page.mouse.move(from.x + (dx * i) / 10, from.y + (dy * i) / 10);
  await page.keyboard.down(modifier);
  for (let i = at + 1; i <= 10; i++) await page.mouse.move(from.x + (dx * i) / 10, from.y + (dy * i) / 10);
  await page.mouse.up();
  await page.keyboard.up(modifier);
  await settle();
};

const centreOf = (b) => [b.x + b.width / 2, b.y + b.height / 2];
const unionCentre = (...boxes) => {
  const minX = Math.min(...boxes.map((b) => b.x));
  const minY = Math.min(...boxes.map((b) => b.y));
  const maxX = Math.max(...boxes.map((b) => b.x + b.width));
  const maxY = Math.max(...boxes.map((b) => b.y + b.height));
  return [(minX + maxX) / 2, (minY + maxY) / 2];
};

// ------------------------------------------------ one layer, from the centre
await applySetup(BOX);
await select("R");
const start = await getEl("R");
// Sampled MID-gesture, because that is the only moment a stray duplicate or a
// distance readout would exist.
await dragFrom(await singleHandleAt("br"), world(60), world(20), ["Alt"], {
  sample: async () => {
    check("alt-resizing creates no duplicate", await elementCount(), 2);
    check("and draws no distance inspector over the handle", await measureOverlays(), 0);
  }
});
const alt = await getEl("R");
check("alt+drag doubles the width the pointer asked for", alt.width, start.width + 120);
check("alt+drag doubles the height too", alt.height, start.height + 40);
check("alt+drag holds the centre", centreOf(alt), centreOf(start));

// Shift composes: the ratio holds AND the centre holds.
await applySetup(BOX);
await select("R");
const shiftStart = await getEl("R");
await dragFrom(await singleHandleAt("br"), world(60), world(20), ["Alt", "Shift"]);
const shiftAlt = await getEl("R");
check(
  "shift+alt keeps the ratio",
  Math.round((shiftAlt.width / shiftAlt.height) * 1000),
  Math.round((shiftStart.width / shiftStart.height) * 1000)
);
check("shift+alt holds the centre", centreOf(shiftAlt), centreOf(shiftStart));
check("shift+alt takes the height from the ratio, not the pointer", shiftAlt.height, shiftStart.height + 60);

// An edge handle grows both sides of ONE axis and leaves the other alone.
await applySetup(BOX);
await select("R");
const edgeStart = await getEl("R");
await dragFrom(await singleHandleAt("mr"), world(30), 0, ["Alt"]);
const edgeAlt = await getEl("R");
check("alt on an east handle doubles the width", edgeAlt.width, edgeStart.width + 60);
check("and leaves the height exactly as it was", edgeAlt.height, edgeStart.height);
check("and still holds the centre", centreOf(edgeAlt), centreOf(edgeStart));

// ------------------------------------------- the modifier is read per frame
await applySetup(BOX);
await select("R");
const lateStart = await getEl("R");
await dragWithLateModifier(await singleHandleAt("br"), world(60), world(20), 5, "Alt");
const late = await getEl("R");
check("alt pressed mid-resize re-centres the box", centreOf(late), centreOf(lateStart));
check("and the size is the doubled one", [late.width, late.height], [lateStart.width + 120, lateStart.height + 40]);

// ---------------------------------------------------- a multi-selection
// The union of R and S is 200..700 x 300..1000, so its centre is (450, 650).
await applySetup(BOX);
await select("R");
await page.keyboard.down("Shift");
const onS = await page.locator("[data-element-id='S']").first().boundingBox();
await page.mouse.click(onS.x + onS.width / 2, onS.y + onS.height / 2);
await page.keyboard.up("Shift");
await settle();
check("two layers are selected", await page.evaluate(() => window.__FISH_BRIDGE__.getSelectedIds().length), 2);
const unionBefore = unionCentre(await getEl("R"), await getEl("S"));

await dragFrom(await handleAt("br"), world(60), world(20), ["Alt"]);
const rAfter = await getEl("R");
const sAfter = await getEl("S");
check("a group alt-resize creates no duplicate", await elementCount(), 2);
// Snapping may nudge the union by a pixel or two, so the centre is asserted with
// a tolerance — the point is that it is the CENTRE that held.
checkNear("the group grew about its centre", unionCentre(rAfter, sAfter), unionBefore);
check("and the group is wider and taller than it was", [rAfter.x < 200, sAfter.y > 900], [true, true]);

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : `  -> ${JSON.stringify(r.actual)} (expected ${JSON.stringify(r.expected)})`}`);
}
console.log(`\n${results.length - failed.length}/${results.length} passed`);
console.log("pageErrors", errors.slice(0, 5));

await browser.close();
process.exit(failed.length === 0 && errors.length === 0 ? 0 : 1);
