import { chromium } from "playwright";
import { pathToFileURL } from "url";
import path from "node:path";

// Hiding a child of a stack re-lays the stack out immediately — the siblings
// close the gap, a hugging frame shrinks, the hidden layer keeps the box it had,
// and showing it again puts it back in the flow. Nothing here is about colour:
// what a new element starts in is `default-colors.spec.mjs`, which owns that
// claim for every entry point.
//
// The layout is read twice on purpose: the document (`bridge.getDoc`) says what
// the model decided, `getBoundingClientRect` says what was painted. "The numbers
// moved" and "the canvas moved" are different claims.
const html = path.resolve(process.cwd(), process.argv[2] ?? "dist/index.html");

const ELEMENTS = [
  {
    id: "hide_stack",
    type: "frame",
    name: "Hide Stack",
    x: 500,
    y: 120,
    width: 200,
    height: 140,
    sizing: { height: "fit-content" },
    fills: [{ type: "solid", color: "#2B2B2B" }],
    display: "flex",
    "flex-direction": "column",
    gap: 10,
    padding: 0,
    children: [
      { id: "h_a", type: "rect", name: "A", x: 0, y: 0, width: 120, height: 40, fills: [{ type: "solid", color: "#30A46C" }] },
      { id: "h_b", type: "rect", name: "B", x: 0, y: 50, width: 120, height: 40, fills: [{ type: "solid", color: "#3E63DD" }] },
      { id: "h_c", type: "rect", name: "C", x: 0, y: 100, width: 120, height: 40, fills: [{ type: "solid", color: "#F76B15" }] }
    ]
  }
];

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `\n      ${detail}` : ""}`);
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
await page.evaluate((elements) => {
  const bridge = window.__FISH_BRIDGE__;
  const base = bridge.getDoc();
  bridge.setElements(JSON.parse(JSON.stringify(elements)), { canvas: { ...base.canvas, width: 4000, height: 3000 } });
}, ELEMENTS);
await page.waitForTimeout(400);

const settle = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

const pageElements = () =>
  page.evaluate(() => {
    const doc = window.__FISH_BRIDGE__.getDoc();
    return JSON.parse(JSON.stringify(doc.pages.find((p) => p.id === doc.activePageId).children));
  });
const inDoc = async (id) => {
  const walk = (list) => {
    for (const el of list) {
      if (el.id === id) return el;
      if (el.children) {
        const hit = walk(el.children);
        if (hit) return hit;
      }
    }
    return null;
  };
  return walk(await pageElements());
};
const boxOf = (id) =>
  page.evaluate((elId) => {
    const n = document.querySelector(`[data-element-id="${CSS.escape(elId)}"]`);
    if (!n) return null;
    const b = n.getBoundingClientRect();
    return { left: b.left, top: b.top, right: b.right, bottom: b.bottom, width: b.width, height: b.height };
  }, id);
const idle = async () => {
  await settle();
  await page.waitForTimeout(150);
  await settle();
};
/** Painted pixels per world pixel, read off a node both sides know the size of. */
const zoomOf = async () => (await boxOf("h_a")).height / (await inDoc("h_a")).height;

// ---- 0. seed sanity --------------------------------------------------------
const seeded = await pageElements();
const stack = await inDoc("hide_stack");
check("the fixture stack hugs its three children", stack.width === 200 && stack.height === 140, `${stack.width}x${stack.height}`);
check(
  "the fixture children sit at 0 / 50 / 100",
  [stack.children[0].y, stack.children[1].y, stack.children[2].y].join(",") === "0,50,100",
  JSON.stringify(stack.children.map((c) => c.y))
);
const beforeA = await boxOf("h_a");
const beforeC = await boxOf("h_c");
const zoom = await zoomOf();
const paintedGap = Math.round((beforeC.top - beforeA.top) / zoom);
check(
  "the painted gap between A and C is the model's 100px",
  Math.abs(paintedGap - 100) <= 1,
  `painted=${paintedGap} at zoom ${zoom}`
);
check("three children render", seeded.length === 1 && (await page.evaluate(() => document.querySelectorAll("[data-element-id]").length)) === 4);

// ---- 1. hide the middle child ---------------------------------------------
await page.click('[data-layer-eye="h_b"]');
await idle();

const hiddenRow = await page.evaluate(() => document.querySelector('[data-element-id="h_b"]') === null);
const afterHide = await inDoc("hide_stack");
check("the hidden child is no longer painted", hiddenRow === true);
check(
  "C takes B's slot",
  afterHide.children[2].y === 50,
  `C.y=${afterHide.children[2].y}`
);
check(
  "and B keeps the box it had, so showing it again is not a jump",
  afterHide.children[1].y === 50,
  `B.y=${afterHide.children[1].y}`
);
check(
  "the hugging frame shrinks by one row and its gap",
  afterHide.height === 90,
  `height=${afterHide.height}`
);

const afterA = await boxOf("h_a");
const afterC = await boxOf("h_c");
const closedGap = Math.round((afterC.top - afterA.top) / zoom);
check(
  "the canvas agrees with the model: the gap closed on screen too",
  Math.abs(closedGap - 50) <= 1,
  `painted=${closedGap}`
);

// ---- 2. show it again ------------------------------------------------------
await page.click('[data-layer-eye="h_b"]');
await idle();
const reshowed = await inDoc("hide_stack");
check(
  "showing the child puts it back in the flow",
  [reshowed.children[1].y, reshowed.children[2].y, reshowed.height].join(",") === "50,100,140",
  JSON.stringify([reshowed.children[1].y, reshowed.children[2].y, reshowed.height])
);
check("and it is painted again", (await boxOf("h_b")) !== null);

// ---- 3. hide the first child instead --------------------------------------
await page.click('[data-layer-eye="h_a"]');
await idle();
const firstHidden = await inDoc("hide_stack");
check(
  "a hidden first child leaves A's box behind for the others",
  [firstHidden.children[1].y, firstHidden.children[2].y].join(",") === "0,50",
  JSON.stringify([firstHidden.children[1].y, firstHidden.children[2].y])
);
check("the stack is the two rows that are left", firstHidden.height === 90, `height=${firstHidden.height}`);
await page.click('[data-layer-eye="h_a"]');
await idle();

// ---- 4. the inspector's grid readout counts what the pass places -----------
const gridCells = (id, extra = {}) => ({
  id,
  type: "rect",
  name: id,
  x: 0,
  y: 0,
  width: 80,
  height: 40,
  fills: [{ type: "solid", color: "#30A46C" }],
  ...extra
});
// The grid track lists come from `inFlowChildren` — the same predicate the layout
// pass uses — so a hidden child must not buy itself a row of tracks. Measured
// through the ROW TRACK FIELDS rather than a readout: `{used}/{rows} rows
// filled` was removed from the panel in 74f52c3 and this check outlived it.
//
// `rows` is deliberately left unset: an authored row count dominates the
// derivation, so with `rows: 4` a hidden child would make no difference and the
// assertion could not fail. Deriving from the flow is the only way round.
const gridFixture = (hidden) => ({
  id: "grid_frame",
  type: "frame",
  name: "Grid",
  x: 300,
  y: 200,
  width: 400,
  height: 320,
  display: "grid",
  "grid-template-columns": 2,
  gap: 10,
  padding: 0,
  "align-items": "start",
  children: [
    gridCells("g1"),
    gridCells("g2"),
    gridCells("g3"),
    gridCells("g4", hidden ? { visible: false } : {}),
    gridCells("g5", hidden ? { visible: false } : {})
  ]
});
const rowTracks = () => page.locator('[data-stack-tracks="row"] input[data-scrub-field]').count();
/** Equal/Tracks is a per-axis switch; the row axis is the second one in the DOM. */
const switchToRowTracks = () =>
  page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].filter((x) => /tracks/i.test(x.textContent ?? ""))[1];
    if (b) b.click();
  });

await page.evaluate((grid) => {
  const bridge = window.__FISH_BRIDGE__;
  const base = bridge.getDoc();
  bridge.setElements([grid], { canvas: { ...base.canvas, width: 2000, height: 1400 } });
}, gridFixture(false));
await page.evaluate(() => window.__FISH_BRIDGE__.selectElement("grid_frame"));
await idle();
await switchToRowTracks();
const rowsWithAll = await rowTracks();

await page.evaluate((grid) => {
  const bridge = window.__FISH_BRIDGE__;
  const base = bridge.getDoc();
  bridge.setElements([grid], { canvas: { ...base.canvas, width: 2000, height: 1400 } });
}, gridFixture(true));
await page.evaluate(() => window.__FISH_BRIDGE__.selectElement("grid_frame"));
await idle();
await switchToRowTracks();
await idle();
const rowsWithHidden = await rowTracks();

check("five cells over two columns is three rows", rowsWithAll === 3, `got ${rowsWithAll}`);
check(
  "and the two hidden ones do not buy a fourth track",
  rowsWithHidden === 2,
  `got ${rowsWithHidden}`
);

// ---- verdict ---------------------------------------------------------------
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
console.log("pageErrors", errors.slice(0, 5));

await browser.close();
process.exit(failed.length === 0 && errors.length === 0 ? 0 : 1);
