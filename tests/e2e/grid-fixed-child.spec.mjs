import { chromium } from "playwright";
import { pathToFileURL } from "url";
import path from "node:path";

// A grid cell sizes an axis the child left UNSAID, and only that.
//
// `grid-layout.test.ts` proves the rule; what is unproven without a browser is
// that a person can reach it — that typing a width, picking Fixed in the size
// menu, and dragging a handle all pin the size instead of being recomputed away
// by the next pass. The claim is expressed against a grid that GROWS: a pinned
// child keeps its number, an unsaid one follows the cell.
const html = path.resolve(process.cwd(), process.argv[2] ?? "dist/index.html");

const ELEMENTS = [
  {
    id: "G",
    type: "frame",
    name: "Grid",
    x: 300,
    y: 200,
    width: 300,
    height: 200,
    fills: [{ type: "solid", color: "#1E1E1E" }],
    display: "grid",
    "grid-template-columns": 2,
    gap: 0,
    padding: 0,
    children: [
      { id: "open", type: "rect", name: "Open", x: 0, y: 0, width: 50, height: 50, fills: [{ type: "solid", color: "#30A46C" }] },
      { id: "fill", type: "rect", name: "Fill", x: 0, y: 0, width: 50, height: 50, sizing: { width: "fill", height: "fill" }, fills: [{ type: "solid", color: "#3E63DD" }] }
    ]
  }
];

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `\n      ${detail}` : ""}`);
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
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
await page.waitForTimeout(400);

const settle = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
const docEl = async (id) =>
  page.evaluate((elId) => {
    const doc = window.__FISH_BRIDGE__.getDoc();
    const els = JSON.parse(JSON.stringify(doc.pages.find((p) => p.id === doc.activePageId).children));
    const walk = (list) => {
      for (const el of list) {
        if (el.id === elId) return el;
        const f = el.children ? walk(el.children) : null;
        if (f) return f;
      }
      return null;
    };
    return walk(els);
  }, id);
const select = async (id) => {
  await page.evaluate((elId) => window.__FISH_BRIDGE__.selectElement(elId), id);
  await settle();
  await page.waitForTimeout(200);
};
/** The painted box in DOCUMENT units, zoom solved from a sibling whose box is known. */
const painted = async (id, ref) =>
  page.evaluate(({ id, refId, refWidth }) => {
    const t = document.querySelector(`[data-element-id="${CSS.escape(id)}"]`);
    const r = document.querySelector(`[data-element-id="${CSS.escape(refId)}"]`);
    if (!t || !r) return null;
    const zoom = r.getBoundingClientRect().width / refWidth;
    const b = t.getBoundingClientRect();
    return { width: Math.round(b.width / zoom), height: Math.round(b.height / zoom) };
  }, { id, refId: ref.id, refWidth: ref.width });
const setField = async (label, value) => {
  const field = page.locator(`[data-scrub-field="${label}"]`);
  await field.fill(String(value));
  await field.press("Enter");
  await settle();
  await page.waitForTimeout(250);
};
/** A real drag of the east edge handle, aimed from the DOM rather than from pan/zoom math. */
const dragEastHandle = async (dx) => {
  const box = await page.locator('[data-resize-handle="mr"]').boundingBox();
  if (!box) return false;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 - dx, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  await settle();
  await page.waitForTimeout(300);
  return true;
};

// ------------------------------------------------------------------ the rule
const open0 = await docEl("open");
const fill0 = await docEl("fill");
check("an unsaid axis is the cell's: Open stretched to 150x200",
  open0.width === 150 && open0.height === 200 && open0.sizing === undefined,
  `Open = ${open0.width}x${open0.height}, sizing=${JSON.stringify(open0.sizing ?? null)}`);
check("and `fill` is the box it always was", fill0.width === 150 && fill0.height === 200,
  `Fill = ${fill0.width}x${fill0.height}`);

// ------------------------------------------------------------------ the W field
await select("open");
check("the W field is live for a child the cell is stretching",
  await page.locator('[data-scrub-field="W"]').isEnabled(),
  `shows ${await page.locator('[data-scrub-field="W"]').inputValue()}`);
await setField("W", 60);
const open1 = await docEl("open");
check("typing a width PINS it — the cell no longer takes it back",
  open1.width === 60 && open1.sizing?.width === "fixed",
  `Open = ${open1.width}, sizing=${JSON.stringify(open1.sizing ?? null)}`);

// -------------------------------------------------------------------- the menu
await select("fill");
await page.locator('[data-scrub-field="W"]').locator("xpath=following-sibling::button").click();
await page.waitForTimeout(200);
await page.getByText("Fixed", { exact: true }).first().click();
await settle();
await page.waitForTimeout(250);
const fill1 = await docEl("fill");
check("choosing Fixed in the size menu pins that axis too",
  fill1.sizing?.width === "fixed",
  `Fill sizing=${JSON.stringify(fill1.sizing ?? null)}`);

// ------------------------------------------------- and the pin outlives a resize
await select("G");
await setField("W", 500);
const open2 = await docEl("open");
const fill2 = await docEl("fill");
check("widening the grid grows the cell and not the two pinned children",
  open2.width === 60 && fill2.width === 150,
  `Open = ${open2.width}, Fill = ${fill2.width}, cells are 250`);

// One unsaid child left, to prove the control: it follows the cell.
await page.evaluate(() => {
  const bridge = window.__FISH_BRIDGE__;
  const doc = bridge.getDoc();
  const page0 = doc.pages.find((p) => p.id === doc.activePageId);
  const grid = page0.children.find((e) => e.id === "G");
  grid.children.push({ id: "open2", type: "rect", name: "Open2", x: 0, y: 0, width: 50, height: 50, fills: [{ type: "solid", color: "#F76B15" }] });
  bridge.applyDoc({ ...doc, pages: doc.pages.map((p) => (p.id === page0.id ? { ...p, children: [grid] } : p)) });
});
await page.waitForTimeout(400);
const open3 = await docEl("open2");
check("a child added after the resize still follows the cell", open3.width === 250,
  `Open2 = ${open3.width}`);

// ------------------------------------------------------------------- the handle
await select("open2");
// The overlay is a render behind the selection, so wait for it rather than
// counting on the frame the click committed.
const eastHandle = page.locator('[data-resize-handle="mr"]');
const handleArrived = await eastHandle
  .waitFor({ state: "attached", timeout: 5000 })
  .then(() => true)
  .catch(() => false);
check("an unsaid child in a cell still offers live resize handles", handleArrived,
  `east handles=${await eastHandle.count()}`);
const beforeDrag = await docEl("open2");
const dragged = await dragEastHandle(60);
const open4 = await docEl("open2");
const paintOpen = await painted("open2", await docEl("open"));
check("dragging its east handle pins it and resizes it, and the canvas agrees",
  dragged && open4.width < beforeDrag.width && open4.sizing?.width === "fixed" &&
    paintOpen && paintOpen.width === Math.round(open4.width),
  `${Math.round(beforeDrag.width)} → ${Math.round(open4.width)}, sizing=${JSON.stringify(open4.sizing ?? null)}, painted ${paintOpen?.width}`);

// ----------------------------------------------------------------- the undo
await page.evaluate(() => window.__FISH_BRIDGE__.undo());
await page.waitForTimeout(350);
const open5 = await docEl("open2");
check("one undo takes the drag back, pin and all",
  open5.width === beforeDrag.width && open5.sizing?.width === undefined,
  `Open2 = ${Math.round(open5.width)}, sizing=${JSON.stringify(open5.sizing ?? null)}`);

await browser.close();
if (errors.length) { console.log("--- page errors ---"); errors.slice(0, 6).forEach((e) => console.log("  " + e)); }
const failed = results.filter((r) => !r.ok);
console.log(`\n${failed.length === 0 ? "ALL CHECKS PASS" : `${failed.length} CHECK(S) FAILED`}\n`);
process.exit(failed.length === 0 && errors.length === 0 ? 0 : 1);