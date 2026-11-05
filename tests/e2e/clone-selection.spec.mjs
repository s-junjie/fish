import { chromium } from "playwright";
import { pathToFileURL } from "url";
import path from "path";

// What a clone leaves SELECTED.
//
// A pasted or Cmd+D'd subtree used to arrive with every descendant in the
// selection, so the canvas painted one dashed outline per layer inside the copy
// — a frame showed a box around itself and around each child, and the
// multi-selection union box on top. The copy is one unit: what lands selected is
// its root, exactly like a click on a frame selects the frame and nothing else.

const html = path.resolve(process.cwd(), process.argv[2] ?? "dist/index.html");
const results = [];
const check = (name, actual, expected) => {
  results.push({ name, ok: JSON.stringify(actual) === JSON.stringify(expected), actual, expected });
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

const applySetup = () =>
  page.evaluate(() => {
    const bridge = window.__FISH_BRIDGE__;
    const base = bridge.getDoc();
    const rect = (id, x, y, w, h) => ({
      id, type: "rect", name: id, x, y, width: w, height: h,
      fills: [{ type: "solid", color: "#3B82F6" }]
    });
    bridge.setElements(
      [
        rect("alpha", 400, 400, 200, 150),
        {
          id: "stack", type: "frame", name: "stack", x: 900, y: 400, width: 400, height: 200,
          children: [rect("kid1", 10, 10, 60, 60), rect("kid2", 80, 10, 60, 60)]
        },
        { id: "target", type: "frame", name: "target", x: 900, y: 900, width: 300, height: 300, children: [] }
      ],
      { canvas: { ...base.canvas, width: 4000, height: 3000 } }
    );
  });

const settle = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
const selected = () => page.evaluate(() => window.__FISH_BRIDGE__.getSelectedIds());
const topLevelIds = () => page.evaluate(() => window.__FISH_BRIDGE__.getElements().map((e) => e.id));
const elementCount = () => page.evaluate(() => window.__FISH_BRIDGE__.getElements().length);
const getEl = (id) => page.evaluate((elId) => window.__FISH_BRIDGE__.getElements().find((e) => e.id === elId), id);
// The dashed per-layer outlines `SelectionOverlay` paints for an individually
// selected layer. One box per selected element — the thing a clone must not
// multiply. The 2/2 dash is this group's own; no other canvas chrome uses it.
const dashedOutlines = () => page.locator('svg g[stroke-dasharray="2 2"] rect').count();
const select = async (ids) => {
  await page.evaluate((list) => window.__FISH_BRIDGE__.selectElements(list), ids);
  await settle();
};
const press = async (key) => {
  await page.keyboard.press(key);
  await settle();
};
// The copy an operation produced, found by "an id that was not there before".
const newIdsSince = async (before) => {
  const after = await topLevelIds();
  return after.filter((id) => !before.includes(id));
};

// 1. Cmd+D on a frame selects the copy — and only the copy.
await applySetup();
await select(["stack"]);
const beforeDuplicate = await topLevelIds();
await press("Control+d");
check("cmd+d adds one top-level element", await elementCount(), beforeDuplicate.length + 1);
const [cloneId, ...extraRoots] = await newIdsSince(beforeDuplicate);
check("cmd+d selects exactly one element", await selected(), [cloneId]);
check("cmd+d produced a single root", extraRoots, []);
const clone = await getEl(cloneId);
check("cmd+d copy is a frame", clone && clone.type, "frame");
check("cmd+d copy carries both children", (clone?.children ?? []).length, 2);
check(
  "cmd+d copy re-mints child ids",
  (clone?.children ?? []).some((c) => c.id === "kid1" || c.id === "kid2"),
  false
);
check("cmd+d paints a single selection box, not one per layer", await dashedOutlines(), 0);

// The counter above is only meaningful if it can report the defect: selecting a
// frame together with its children is exactly the state the bug produced.
await select(["stack", "kid1", "kid2"]);
check("a frame selected with its children does paint one box each", await dashedOutlines(), 3);

// 2. A second Cmd+D on the copy stays a whole-unit selection.
await select([cloneId]);
await press("Control+d");
check("a repeated cmd+d still selects one element", (await selected()).length, 1);
check("a repeated cmd+d paints no per-layer boxes", await dashedOutlines(), 0);

// 3. Copy + paste in the same file: same rule, via the beside-original path.
await applySetup();
await select(["stack"]);
const beforePaste = await topLevelIds();
await press("Control+c");
await press("Meta+v");
const [pastedId] = await newIdsSince(beforePaste);
check("paste selects exactly one element", await selected(), [pastedId]);
check("paste paints no per-layer boxes", await dashedOutlines(), 0);
const pasted = await getEl(pastedId);
check("paste keeps the whole subtree", (pasted?.children ?? []).length, 2);

// 4. Paste into a selected container — the `into` path has its own insert.
await applySetup();
await select(["stack"]);
await press("Control+c");
await select(["target"]);
await press("Meta+v");
const targetFrame = await getEl("target");
check("paste into a container lands the copy inside it", targetFrame.children.length, 1);
const intoSelection = await selected();
check("paste into a container selects the copy's root", intoSelection, [targetFrame.children[0].id]);
check(
  "and not the layers inside it",
  targetFrame.children[0].children.some((c) => c.id === intoSelection[0]),
  false
);
check("paste into a container paints no per-layer boxes", await dashedOutlines(), 0);

// 5. Paste onto empty canvas — the `onto-canvas` path, third insert primitive.
await applySetup();
await select(["stack"]);
await press("Control+c");
await select([]);
const beforeCanvasPaste = await topLevelIds();
await press("Meta+v");
const [canvasClonedId] = await newIdsSince(beforeCanvasPaste);
check("a paste with nothing selected selects the copy's root", await selected(), [canvasClonedId]);
check("and paints no per-layer boxes", await dashedOutlines(), 0);

// 6. Two sources stay two units: the fix collapses descendants, not a real
//    multi-selection.
await applySetup();
await select(["stack", "alpha"]);
const beforeTwo = await topLevelIds();
await press("Control+d");
const twoRoots = await newIdsSince(beforeTwo);
check("duplicating two layers selects both copies", await selected(), twoRoots);
check("and paints one box each, nothing from inside them", await dashedOutlines(), 2);

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : `  -> ${JSON.stringify(r.actual)} (expected ${JSON.stringify(r.expected)})`}`);
}
console.log(`\n${results.length - failed.length}/${results.length} passed`);
console.log("pageErrors", errors.slice(0, 5));

await browser.close();
process.exit(failed.length === 0 && errors.length === 0 ? 0 : 1);
