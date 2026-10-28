import { chromium } from "playwright";
import { pathToFileURL } from "url";
import path from "node:path";

// What the selection paints when a grid frame is chosen: a dashed outline of
// every cell it would place a child into.
//
// `grid-layout.test.ts` proves the rectangles; what only a browser can answer is
// that the OVERLAY draws them, that they land on the cells rather than beside
// them, and that they stand down with everything else the selection owns.
const html = path.resolve(process.cwd(), process.argv[2] ?? "dist/index.html");

const ELEMENTS = [
  {
    id: "G",
    type: "frame",
    name: "Grid",
    x: 300,
    y: 200,
    width: 400,
    height: 300,
    fills: [{ type: "solid", color: "#1E1E1E" }],
    display: "grid",
    "grid-template-columns": 3,
    "column-gap": 20,
    "row-gap": 20,
    padding: 20,
    // `a` and `c` sit in adjacent columns, because a gap band only exists
    // BETWEEN two tracks that both hold something — a grid with one child per
    // column has no gutter to draw, which is the geometry being honest.
    children: [
      { id: "a", type: "rect", name: "A", x: 0, y: 0, width: 10, height: 10, fills: [{ type: "solid", color: "#30A46C" }] },
      { id: "c", type: "rect", name: "C", x: 0, y: 0, width: 10, height: 10, fills: [{ type: "solid", color: "#8B5CF6" }] },
      { id: "b", type: "rect", name: "B", x: 0, y: 0, width: 10, height: 10, "grid-area": { row: 2, column: 3 }, fills: [{ type: "solid", color: "#3E63DD" }] }
    ]
  },
  {
    id: "M",
    type: "frame",
    name: "Masonry",
    x: 800,
    y: 200,
    width: 300,
    height: 200,
    fills: [{ type: "solid", color: "#1E1E1E" }],
    display: "grid",
    "grid-template-columns": 2,
    masonry: true,
    gap: 10,
    padding: 10,
    children: [{ id: "m1", type: "rect", name: "M1", x: 0, y: 0, width: 40, height: 40, fills: [{ type: "solid", color: "#F76B15" }] }]
  },
  {
    id: "S",
    type: "frame",
    name: "Stack",
    x: 800,
    y: 500,
    width: 300,
    height: 200,
    fills: [{ type: "solid", color: "#1E1E1E" }],
    display: "flex",
    "flex-direction": "row",
    gap: 10,
    padding: 10,
    children: [{ id: "s1", type: "rect", name: "S1", x: 0, y: 0, width: 40, height: 40, fills: [{ type: "solid", color: "#8B5CF6" }] }]
  }
];

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `\n      ${detail}` : ""}`);
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });

await page.goto(pathToFileURL(html).href);
await page.waitForFunction(() => !!window.__FISH_BRIDGE__);
await page.evaluate((elements) => {
  const bridge = window.__FISH_BRIDGE__;
  const base = bridge.getDoc();
  bridge.setElements(JSON.parse(JSON.stringify(elements)), { canvas: { ...base.canvas, width: 4000, height: 3000 } });
}, ELEMENTS);
await page.waitForTimeout(500);

const settle = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
const select = async (id) => {
  await page.evaluate((elId) => window.__FISH_BRIDGE__.selectElement(elId), id);
  await settle();
  await page.waitForTimeout(150);
};
/**
 * The overlay's cell rects in SCREEN space. No zoom conversion: the claim is
 * that a cell and the child the pass placed in it are the same box, and two
 * screen rects answer that without solving for anything.
 */
const cellBoxes = () =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll("[data-grid-cell]")).map((n) => {
      const b = n.getBoundingClientRect();
      return { id: n.getAttribute("data-grid-cell"), x: b.left, y: b.top, w: b.width, h: b.height };
    })
  );

// ------------------------------------------------------------ the grid preview
await select("G");
const cells = await cellBoxes();
check("a selected grid draws every cell", cells.length === 6, `cells=${cells.length}`);
check("six cells for three columns and two rows", new Set(cells.map((c) => c.id)).size === 6,
  cells.map((c) => c.id).join(" "));

// The cell must line up with where the pass actually places a child: A is in r0c0,
// B is pinned to r1c2. Convert both back to document coordinates and compare.
const model = await page.evaluate(() => {
  const doc = window.__FISH_BRIDGE__.getDoc();
  const els = JSON.parse(JSON.stringify(doc.pages.find((p) => p.id === doc.activePageId).children));
  const g = els.find((e) => e.id === "G");
  return { a: g.children.find((c) => c.id === "a"), b: g.children.find((c) => c.id === "b"), frame: { x: g.x, y: g.y } };
});
const paintedChild = (id) =>
  page.evaluate((elId) => {
    const n = document.querySelector(`[data-element-id="${CSS.escape(elId)}"]`);
    const b = n.getBoundingClientRect();
    return { left: b.left, top: b.top, width: b.width, height: b.height };
  }, id);
const aPainted = await paintedChild("a");
const aCell = cells.find((c) => c.id === "r0c0");
check("the first cell's origin IS the first child's origin",
  Math.abs(aCell.x - aPainted.left) < 1 && Math.abs(aCell.y - aPainted.top) < 1,
  `cell ${Math.round(aCell.x)},${Math.round(aCell.y)} vs child ${Math.round(aPainted.left)},${Math.round(aPainted.top)}`);
check("and the cell is exactly as big as the child the pass gave it",
  Math.abs(aCell.w - aPainted.width) < 1 && Math.abs(aCell.h - aPainted.height) < 1,
  `cell ${Math.round(aCell.w)}x${Math.round(aCell.h)} vs child ${Math.round(aPainted.width)}x${Math.round(aPainted.height)}`);

const bPainted = await paintedChild("b");
const bCell = cells.find((c) => c.id === "r1c2");
check("a pinned child lands in the cell the preview names for it",
  bCell && Math.abs(bCell.x - bPainted.left) < 1 && Math.abs(bCell.y - bPainted.top) < 1,
  `r1c2 ${bCell ? `${Math.round(bCell.x)},${Math.round(bCell.y)}` : "missing"} vs B ${Math.round(bPainted.left)},${Math.round(bPainted.top)}`);

const stroke = await page.evaluate(() => {
  const g = document.querySelector("[data-grid-cells]");
  const s = getComputedStyle(g);
  return { stroke: s.stroke, width: s.strokeWidth, dash: s.strokeDasharray, fill: s.fill, events: s.pointerEvents };
});
check("the cells are dashed, unfilled, never hit targets, and wear the selection blue",
  stroke.stroke === "rgb(27, 114, 255)" && stroke.fill === "none" && stroke.events === "none" && parseFloat(stroke.dash) > 0,
  JSON.stringify(stroke));

await page.locator('[data-ui-panel="right"]').screenshot({ path: "/tmp/shot-grid-selected.png" }).catch(() => {});
await page.screenshot({ path: "/tmp/shot-grid-canvas.png" });

// -------------------------------------------------------- where it must not be
await select("M");
check("masonry draws none — its rows are whatever the shortest column is",
  (await page.locator("[data-grid-cells]").count()) === 0,
  `count=${await page.locator("[data-grid-cells]").count()}`);

await select("S");
check("a stack draws none", (await page.locator("[data-grid-cells]").count()) === 0);

await select("a");
check("a leaf inside the grid draws none — the cells belong to the frame",
  (await page.locator("[data-grid-cells]").count()) === 0);

// ---------------------------------------------------------- still one overlay
await select("G");
check("the selection is still ONE overlay group",
  (await page.locator("[data-selection-overlay]").count()) === 1);

// ------------------------------------------- and it survives a spacing scrub
// The box stands down while a value is worked, so that nothing jumps under the
// numbers being read. The cells are what the gesture is ABOUT: they are where
// the gutter opening can be seen, so taking them away with the box removes the
// feedback and leaves the user editing blind.
//
// The gap field is addressed through its row: its handle is an axis icon, and
// several rows carry one, so a bare `[data-scrub-label]` grabs the wrong field.
const gapLabel = page.locator('[data-ui-panel="right"] span:text-is("Gap") + div [data-scrub-label]').first();
const hasGapField = (await gapLabel.count()) > 0;
if (hasGapField) {
  const before = await cellBoxes();
  const g = await gapLabel.boundingBox();
  await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
  await page.mouse.down();
  await page.mouse.move(g.x + g.width / 2 + 40, g.y + g.height / 2, { steps: 10 });
  await page.waitForTimeout(250);
  const boxDuring = await page.locator("[data-selection-overlay]").count();
  const cellsDuring = await page.locator("[data-grid-cell]").count();
  const bandsDuring = await page.locator("[data-spacing-band]").count();
  check("scrubbing the gap takes the selection box off and keeps the cells",
    boxDuring === 0 && cellsDuring === 6,
    `box=${boxDuring} cells=${cellsDuring} bands=${bandsDuring}`);
  check("and the scrub's own band is on screen, so the gutter being opened is visible",
    bandsDuring > 0, `bands=${bandsDuring}`);

  const during = await cellBoxes();
  check("the cells moved with the gap — they are the current tracks, not a snapshot",
    Math.abs(during[0].w - before[0].w) > 1 && Math.abs(during[1].x - before[1].x) > 1,
    `cell0 ${Math.round(before[0].w)} → ${Math.round(during[0].w)}px, cell1 x ${Math.round(before[1].x)} → ${Math.round(during[1].x)}`);

  await page.mouse.up();
  // The chrome comes back when the pointer LEAVES the panel, not on release:
  // a handle has to exist before a drag can grab it.
  await page.mouse.move(600, 800);
  await page.waitForTimeout(300);
  check("leaving the panel brings the box back and the cells stay",
    (await page.locator("[data-selection-overlay]").count()) === 1 &&
      (await page.locator("[data-grid-cell]").count()) === 6);
} else {
  check("the grid's gap field is reachable", false, "no Gap row label in the panel");
}

await browser.close();
if (errors.length) { console.log("--- page errors ---"); errors.slice(0, 6).forEach((e) => console.log("  " + e)); }
const failed = results.filter((r) => !r.ok);
console.log(`\n${failed.length === 0 ? "ALL CHECKS PASS" : `${failed.length} CHECK(S) FAILED`}\n`);
process.exit(failed.length === 0 && errors.length === 0 ? 0 : 1);