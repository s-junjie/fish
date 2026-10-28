import { chromium } from "playwright";
import { pathToFileURL } from "url";
import path from "node:path";

// Grid tracks and cell placement, from the INSPECTOR to the canvas.
//
// `grid-layout.test.ts` already proves the engine honours `columnSizes`,
// `rowSizes` and `layoutCell`; what is unproven without a browser is the other
// half of the same claim — that a person can reach them. A DSL field with no
// control is a capability the import has and the product does not, so the two
// are asserted together: the document says what was written, the painted box
// says the layout pass read it.
//
// The painted claim is expressed as a FRACTION of the parent's painted box, so
// it survives whatever zoom the canvas happened to open at.
const html = path.resolve(process.cwd(), process.argv[2] ?? "dist/index.html");

const ELEMENTS = [
  {
    id: "G",
    type: "frame",
    name: "Grid",
    x: 400,
    y: 200,
    width: 400,
    height: 120,
    fills: [{ type: "solid", color: "#1E1E1E" }],
    display: "grid",
    "grid-template-columns": [120,200,80],
    "grid-template-rows": [40,80],
    "column-gap": 0,
    "row-gap": 0,
    padding: 0,
    children: [
      { id: "a", type: "rect", name: "A", x: 0, y: 0, width: 10, height: 10, fills: [{ type: "solid", color: "#30A46C" }], "grid-area": { column: 1, row: 1 } },
      { id: "b", type: "rect", name: "B", x: 0, y: 0, width: 10, height: 10, fills: [{ type: "solid", color: "#3E63DD" }], "grid-area": { columnSpan: 2 } },
      { id: "c", type: "rect", name: "C", x: 0, y: 0, width: 10, height: 10, fills: [{ type: "solid", color: "#F76B15" }], "grid-area": { column: 3, row: 2 } }
    ]
  },
  {
    id: "S",
    type: "frame",
    name: "Stack",
    x: 900,
    y: 200,
    width: 300,
    height: 120,
    fills: [{ type: "solid", color: "#1E1E1E" }],
    display: "flex",
    "flex-direction": "row",
    gap: 10,
    padding: 0,
    children: [{ id: "s1", type: "rect", name: "S1", x: 0, y: 0, width: 40, height: 40, fills: [{ type: "solid", color: "#8B5CF6" }] }]
  },
  // A grid with a ratio in it, which is what an import writes from `1fr`. The
  // point of the field is not that it can be typed — it is that the track still
  // means something after the frame is resized, which a measured px cannot.
  {
    id: "F",
    type: "frame",
    name: "Ratio",
    x: 900,
    y: 500,
    width: 400,
    height: 120,
    fills: [{ type: "solid", color: "#1E1E1E" }],
    display: "grid",
    "grid-template-columns": [120,{"fr":1},80],
    "column-gap": 0,
    "row-gap": 0,
    padding: 0,
    children: [
      { id: "f1", type: "rect", name: "F1", x: 0, y: 0, width: 10, height: 10, fills: [{ type: "solid", color: "#30A46C" }] },
      { id: "f2", type: "rect", name: "F2", x: 0, y: 0, width: 10, height: 10, fills: [{ type: "solid", color: "#3E63DD" }] },
      { id: "f3", type: "rect", name: "F3", x: 0, y: 0, width: 10, height: 10, fills: [{ type: "solid", color: "#F76B15" }] }
    ]
  },
  // A plain equal grid, which is what a user authors — and therefore the case
  // where the track editor used to be INVISIBLE, because it rendered only when
  // the document already had tracks.
  {
    id: "H",
    type: "frame",
    name: "Plain",
    x: 400,
    y: 500,
    width: 300,
    height: 120,
    fills: [{ type: "solid", color: "#1E1E1E" }],
    display: "grid",
    "grid-template-columns": 3,
    "column-gap": 0,
    "row-gap": 0,
    padding: 0,
    children: [
      { id: "h1", type: "rect", name: "H1", x: 0, y: 0, width: 10, height: 10, fills: [{ type: "solid", color: "#30A46C" }] },
      { id: "h2", type: "rect", name: "H2", x: 0, y: 0, width: 10, height: 10, fills: [{ type: "solid", color: "#3E63DD" }] },
      { id: "h3", type: "rect", name: "H3", x: 0, y: 0, width: 10, height: 10, fills: [{ type: "solid", color: "#F76B15" }] }
    ]
  }
];

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `\n      ${detail}` : ""}`);
};
const near = (a, b, tol = 0.01) => Math.abs(a - b) <= tol;

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

const docEl = async (id) => {
  const els = await pageElements();
  const walk = (list) => {
    for (const el of list) {
      if (el.id === id) return el;
      const found = el.children ? walk(el.children) : null;
      if (found) return found;
    }
    return null;
  };
  return walk(els);
};

/**
 * A painted box, converted back into document coordinates.
 *
 * The zoom and pan are solved from a reference element whose document box is
 * known, rather than from a ruler placed for the purpose: the canvas culls what
 * is off screen, so a fixture rect parked outside the viewport is simply not
 * there to measure. The reference is a LEAF, because a frame's own group carries
 * its name label above the box.
 */
const paintedDoc = (id, refSheet, refDoc) =>
  page.evaluate(
    ({ targetId, refId, refBox }) => {
      const target = document.querySelector(`[data-element-id="${CSS.escape(targetId)}"]`);
      const reference = document.querySelector(`[data-element-id="${CSS.escape(refId)}"]`);
      if (!target || !reference || refBox.width === 0) return null;
      const r = reference.getBoundingClientRect();
      const zoom = r.width / refBox.width;
      const panX = r.left - refBox.x * zoom;
      const panY = r.top - refBox.y * zoom;
      const c = target.getBoundingClientRect();
      return {
        x: Math.round((c.left - panX) / zoom),
        y: Math.round((c.top - panY) / zoom),
        width: Math.round(c.width / zoom),
        height: Math.round(c.height / zoom)
      };
    },
    { targetId: id, refId: refSheet.id, refBox: { x: refSheet.abs.x, y: refSheet.abs.y, width: refSheet.width, height: refSheet.height } }
  );

const select = async (id) => {
  await page.evaluate((elId) => window.__FISH_BRIDGE__.selectElement(elId), id);
  await settle();
};

const setField = async (selector, value) => {
  const field = page.locator(selector);
  await field.fill(String(value));
  await field.press("Enter");
  await settle();
};

// -------------------------------------------------------------------- basics
const grid = await docEl("G");
check(
  "the tracks are read as three columns and two rows",
  grid?.["grid-template-columns"]?.length === 3 && grid?.["grid-template-rows"]?.length === 2,
  `columnSizes=${JSON.stringify(grid?.["grid-template-columns"])} rowSizes=${JSON.stringify(grid?.["grid-template-rows"])}`
);

const layoutOf = (el) => ({ x: Math.round(el.x), y: Math.round(el.y), w: Math.round(el.width), h: Math.round(el.height) });

/** The grid frame and its children, with each child's canvas-absolute box. */
const sheet = async () => {
  const els = await pageElements();
  const frame = els.find((e) => e.id === "G");
  const children = {};
  for (const child of frame?.children ?? []) {
    children[child.id] = { ...child, abs: { x: frame.x + child.x, y: frame.y + child.y } };
  }
  return { frame, children };
};

const initial = await sheet();
// The reference is re-read with the sheet every time: editing a track resizes
// `a` itself, and a stale scale would be applied to every box measured after it.
const paint = (current, id) => paintedDoc(id, current.children.a, current.children.a.abs);

// The reference has to measure itself before it measures anything else.
const selfCheck = await paint(initial, "a");
check(
  "the reference reads back as the box the document gives it",
  selfCheck !== null && selfCheck.x === Math.round(initial.children.a.abs.x) && selfCheck.width === Math.round(initial.children.a.width),
  `painted=${JSON.stringify(selfCheck)} model=${JSON.stringify(initial.children.a.abs)}`
);

// `b` spans two tracks and says nothing about WHERE, so flow places it: column 1
// is taken by `a`, and the first place two tracks fit is columns 2-3.
const layoutOf2 = (el) => ({ x: Math.round(el.x), y: Math.round(el.y), w: Math.round(el.width), h: Math.round(el.height) });
check(
  "flow steps around an explicit cell rather than landing on top of it",
  JSON.stringify(layoutOf2(initial.children.a)) === JSON.stringify({ x: 0, y: 0, w: 120, h: 40 }) &&
    JSON.stringify(layoutOf2(initial.children.b)) === JSON.stringify({ x: 120, y: 0, w: 280, h: 40 }) &&
    JSON.stringify(layoutOf2(initial.children.c)) === JSON.stringify({ x: 320, y: 40, w: 80, h: 80 }),
  `a=${JSON.stringify(layoutOf2(initial.children.a))} b=${JSON.stringify(layoutOf2(initial.children.b))} c=${JSON.stringify(layoutOf2(initial.children.c))}`
);

const bPaint = await paint(initial, "b");
check(
  "and the canvas paints exactly where the model put it",
  bPaint !== null && bPaint.x === initial.frame.x + 120 && bPaint.y === initial.frame.y && bPaint.width === 280,
  `painted=${JSON.stringify(bPaint)} model=${JSON.stringify(initial.children.b.abs)}`
);

// --------------------------------------------------------------- the controls
await select("G");
const columnTrackCount = await page.locator('[data-stack-tracks="column"] input[data-scrub-field]').count();
const rowTrackCount = await page.locator('[data-stack-tracks="row"] input[data-scrub-field]').count();
check(
  "the inspector shows a control per track, on both axes",
  columnTrackCount === 3 && rowTrackCount === 2,
  `column fields=${columnTrackCount} row fields=${rowTrackCount}`
);

await setField('[data-stack-tracks="column"] input[data-scrub-field="1"]', 150);
const afterColumn = await sheet();
const bPaint2 = await paint(afterColumn, "b");
check(
  "editing a track writes the document AND moves the painted child",
  afterColumn.frame?.["grid-template-columns"]?.[0] === 150 &&
    Math.round(afterColumn.children.b.x) === 150 &&
    Math.round(afterColumn.children.b.width) === 280 &&
    bPaint2?.x === afterColumn.frame.x + 150,
  `columnSizes[0]=${afterColumn.frame?.["grid-template-columns"]?.[0]} model x=${Math.round(afterColumn.children.b.x)} painted x=${bPaint2?.x} (frame at ${afterColumn.frame?.x})`
);

await setField('[data-stack-tracks="row"] input[data-scrub-field="1"]', 70);
const afterRow = await sheet();
const cPaint = await paint(afterRow, "c");
check(
  "and so does a row track",
  afterRow.frame?.["grid-template-rows"]?.[0] === 70 && Math.round(afterRow.children.c.y) === 70 && cPaint?.y === afterRow.frame.y + 70,
  `rowSizes[0]=${afterRow.frame?.["grid-template-rows"]?.[0]} model y=${Math.round(afterRow.children.c.y)} painted y=${cPaint?.y}`
);

// ------------------------------------------------------------------ the spans
await select("b");
const spanColumn = page.locator('[data-stack-cell-span="column"] input');
const spanRow = page.locator('[data-stack-cell-span="row"] input');
check(
  "a grid child offers a span control on both axes",
  (await spanColumn.count()) === 1 && (await spanRow.count()) === 1,
  `column=${await spanColumn.count()} row=${await spanRow.count()}`
);

check(
  "and the span it already has is what the field shows",
  (await spanColumn.inputValue()) === "2",
  `value=${await spanColumn.inputValue()}`
);

await setField('[data-stack-cell-span="column"] input', 1);
const afterSpan = await sheet();
check(
  "narrowing the span to one track drops grid-area rather than storing a no-op",
  afterSpan.children.b?.["grid-area"] === undefined && Math.round(afterSpan.children.b.width) === 200,
  `grid-area=${JSON.stringify(afterSpan.children.b?.["grid-area"] ?? null)} width=${Math.round(afterSpan.children.b.width)}`
);

// WHERE a child sits is not a field: that is what dragging it on the canvas is,
// and a track number typed here could only ever disagree with the box on screen.
const cellFieldCount = await page
  .locator('[data-stack-cell-span="column"] input, [data-stack-cell-span="row"] input')
  .count();
const panelText = await page.locator('[data-ui-panel="right"]').innerText();
check(
  "the panel offers no field for WHICH track, and no paragraph saying one exists",
  cellFieldCount === 2 && !/1 = the first/.test(panelText) && !/how many tracks it spans/i.test(panelText),
  `fields=${cellFieldCount} old note=${/1 = the first/.test(panelText)}`
);

// The two fields are glyphs, so what they span has to be said somewhere — a
// tooltip, not a paragraph of text under the controls.
const spanTitle = await page.locator('[data-stack-cell-span="column"]').getAttribute("title");
check(
  "and each span says so in its tooltip",
  /columns/i.test(spanTitle ?? ""),
  `title=${JSON.stringify(spanTitle)}`
);

// A child with no pin has nothing to reset, and a reset for nothing does nothing.
check(
  "an unpinned child is offered no Auto button",
  (await page.locator('[data-stack-cell-auto="true"]').count()) === 0,
  `count=${await page.locator('[data-stack-cell-auto="true"]').count()}`
);

// `c` is pinned to column 3 / row 2, which is what an import writes from
// `grid-column: 3`. The pin has no field any more, so this is the way out of it.
await select("c");
check(
  "a child pinned to a track offers the way back out",
  (await page.locator('[data-stack-cell-auto="true"]').count()) === 1,
  `count=${await page.locator('[data-stack-cell-auto="true"]').count()}`
);

await page.locator('[data-stack-cell-auto="true"]').click();
await settle();
const afterAuto = await docEl("c");
check(
  "and Auto drops the pin instead of leaving an invisible placement",
  afterAuto?.["grid-area"] === undefined,
  `grid-area=${JSON.stringify(afterAuto?.["grid-area"] ?? null)}`
);

// ------------------------------------------------------------------ the reset
await select("G");
await page.locator('[data-stack-tracks-mode="column-equal"]').click();
await settle();
const reset = await docEl("G");
const bReset = await docEl("b");
check(
  "distributing evenly drops the tracks and falls back to a count",
  reset?.["grid-template-columns"] === 3 && Math.round(bReset.width) === 133,
  `tracks=${JSON.stringify(reset?.["grid-template-columns"] ?? null)} b.width=${Math.round(bReset.width)}`
);

// ------------------------------- the editor has to be reachable from an equal grid
await select("H");
const switchCount = await page.locator('[data-stack-tracks-mode="column-custom"]').count();
const equalIsActive = await page.locator('[data-stack-tracks-mode="column-equal"]').count();
const fieldsBefore = await page.locator('[data-stack-tracks="column"] input[data-scrub-field]').count();
check(
  "a grid with NO tracks still offers the editor — nothing else can create them",
  switchCount === 1 && equalIsActive === 1 && fieldsBefore === 0,
  `custom switch=${switchCount} equal switch=${equalIsActive} track fields=${fieldsBefore}`
);

const h1Before = layoutOf(await docEl("h1"));
await page.locator('[data-stack-tracks-mode="column-custom"]').click();
await settle();
const hAfterMaterialise = await docEl("H");
const h1After = layoutOf(await docEl("h1"));
// Equal and an all-`fr` list are the same division, so the tracks that get
// written are SHARES: a list of px numbers that happens to be equal only looks
// like a proportional layout until the frame is resized, and the stepper that
// comes next treats an `fr` list as one (a new track takes a share).
check(
  "and choosing Tracks materialises the division already on screen as equal shares, moving nothing",
  JSON.stringify(hAfterMaterialise?.["grid-template-columns"]) === JSON.stringify([{ fr: 1 }, { fr: 1 }, { fr: 1 }]) &&
    JSON.stringify(h1After) === JSON.stringify(h1Before),
  `columnSizes=${JSON.stringify(hAfterMaterialise?.["grid-template-columns"] ?? null)} h1 before=${JSON.stringify(h1Before)} after=${JSON.stringify(h1After)}`
);

await page.locator('[data-stack-tracks-mode="column-equal"]').click();
await settle();
const hBack = await docEl("H");
const h1Back = layoutOf(await docEl("h1"));
check(
  "and back to Equal drops the list and keeps the count, still moving nothing",
  hBack?.["grid-template-columns"] === 3 && JSON.stringify(h1Back) === JSON.stringify(h1Before),
  `tracks=${JSON.stringify(hBack?.["grid-template-columns"] ?? null)} h1=${JSON.stringify(h1Back)}`
);

// ------------------------------------------- the count edits the track list itself
await select("G");
await page.locator('[data-stack-tracks-mode="column-custom"]').click();
await settle();
const shownCount = await page.locator('[data-stack-count="columns"] input').inputValue();
const tracksShown = await page.locator('[data-stack-tracks="column"] input[data-scrub-field]').count();
check(
  "the count the stepper shows is the count the track list has",
  shownCount === "3" && tracksShown === 3,
  `stepper=${shownCount} fields=${tracksShown}`
);

await page.locator('[data-stack-count="columns"] button[aria-label="+1"]').click();
await settle();
const fourCols = await docEl("G");
const fieldsFour = await page.locator('[data-stack-tracks="column"] input[data-scrub-field]').count();
// What the tracks come to in px, which is not the stored list once any of them
// is a share — the claim is about the room the children are given.
const fourTracks = fourCols?.["grid-template-columns"];
const trackSum = (Array.isArray(fourTracks) ? fourTracks : []).reduce(
  (total, t) => total + (typeof t === "number" ? t : 0),
  0
);
check(
  "adding a column adds a track — and the fields follow the count, not the other way round",
  fieldsFour === 4 && Array.isArray(fourTracks) && fourTracks.length === 4,
  `fields=${fieldsFour} tracks=${JSON.stringify(fourTracks ?? null)}`
);

// Whatever the list is made of, the children have to fit the frame: a px list
// is scaled back to the room there is, and an `fr` list divides it instead. The
// check is on the boxes, because that is the only one of the two the caller can
// see.
const overflow = await sheet();
const pastTheFrame = Object.values(overflow.children).filter(
  (child) => Math.round(child.x + child.width) > Math.round(overflow.frame.width) + 1
);
const widths = Object.values(overflow.children).map((c) => Math.round(c.width));
check(
  // Three children in four tracks: the fourth cell is simply empty, which is
  // the point — a list that only gained one must not push the last child past
  // the frame, and every child that IS there still measures one quarter of it.
  "and the tracks share the frame rather than overflowing it",
  widths.length === 3 && widths.every((w) => near(w, 100, 0.5)) && pastTheFrame.length === 0,
  `stored px sum=${trackSum} widths=${widths.join(",")} overflowing=${pastTheFrame.length}`
);

// ------------------------------------------------------------------ the ratio
await select("F");
const frUnit = page.locator('[data-stack-tracks="column"] [data-stack-track-unit="fr"]');
const pxUnits = await page.locator('[data-stack-tracks="column"] [data-stack-track-unit="px"]').count();
check(
  "an fr track says which unit it is, beside the px ones it sits with",
  (await frUnit.count()) === 1 && pxUnits === 2,
  `fr=${await frUnit.count()} px=${pxUnits}`
);

const fBefore = await docEl("F");
const f2Before = await docEl("f2");
// The unit is a MENU, not a toggle: freezing to px keeps the box where it is
// while going to fr rearranges the row, and the sentence saying so lives in the
// menu. So choosing px is two presses — the unit, then the option.
await frUnit.click();
await settle();
const unitMenu = await page.locator("[data-track-unit-menu]").count();
check("pressing a unit opens the menu rather than committing the conversion", unitMenu === 1, `menus=${unitMenu}`);
await page.locator('[data-stack-tracks="column"] [data-track-unit-option="px"]').first().click();
await settle();
const fFrozen = await docEl("F");
const f2After = await docEl("f2");
check(
  "freezing an fr track writes the size it currently resolves to, so nothing moves",
  typeof fFrozen?.["grid-template-columns"]?.[1] === "number" &&
    Math.round(fFrozen["grid-template-columns"][1]) === 200 &&
    Math.round(f2After.width) === Math.round(f2Before.width) &&
    Math.round(f2After.x) === Math.round(f2Before.x),
  `columnSizes=${JSON.stringify(fFrozen?.["grid-template-columns"] ?? null)} f2 ${Math.round(f2Before.x)}/${Math.round(f2Before.width)} → ${Math.round(f2After.x)}/${Math.round(f2After.width)}`
);
check(
  "and the fr track was the one the frame had been giving its leftover to",
  Math.round(f2Before.width) === 200 && Math.round(fBefore?.["grid-template-columns"]?.[0]) === 120,
  `f2 was ${Math.round(f2Before.width)}px of a 400px frame`
);

// ---------------------------------------------------- and where it does not apply
await select("s1");
const stackCell = await page.locator('[data-stack-cell-span="column"]').count();
check(
  "a child of a stack is offered no span control — a stack has no tracks to span",
  stackCell === 0,
  `count=${stackCell}`
);

await browser.close();

if (errors.length > 0) {
  console.log("\n--- page errors ---");
  for (const e of errors.slice(0, 6)) console.log(`  ${e}`);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${failed.length === 0 ? "ALL CHECKS PASS" : `${failed.length} CHECK(S) FAILED`}\n`);
process.exit(failed.length === 0 ? 0 : 1);
