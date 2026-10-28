import { chromium } from "playwright";
import { pathToFileURL } from "url";
import path from "path";

// A resolved instance child is painted but never stored. Everything a canvas
// gesture does to it writes back to the document tree by id, so the engine must
// not OFFER those gestures: no transform handles, no drag, and a refusal (with a
// hint) instead of a silent no-op for the keyboard paths. The nested case is the
// one that used to be unreachable: a derived frame is absent from the tree, so
// the frame-depth rules measured nothing on it and the second double click
// bounced back to the instance, leaving the frame's own children unreachable.
const html = path.resolve(process.cwd(), process.argv[2] ?? "dist/index.html");
const results = [];
const check = (name, ok, detail) => results.push({ name, ok: !!ok, detail });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});

await page.goto(pathToFileURL(html).href);
await page.waitForFunction(() => !!window.__FISH_BRIDGE__);

const leaf = (id, x, y, w, h, color) => ({
  id,
  type: "rect",
  name: id,
  x,
  y,
  width: w,
  height: h,
  fills: [{ type: "solid", color }]
});

await page.evaluate(
  ([leafSrc]) => {
    const makeLeaf = eval(`(${leafSrc})`);
    const bridge = window.__FISH_BRIDGE__;
    const base = bridge.getDoc();
    bridge.setElements([
        {
          id: "master",
          type: "component",
          name: "MASTER",
          x: 0,
          y: 100,
          width: 420,
          height: 320,
          fills: [{ type: "solid", color: "#2A2A2A" }],
          clipContent: false,
          children: [
            {
              id: "LABEL",
              type: "text",
              name: "LABEL",
              x: 30,
              y: 190,
              width: 160,
              height: 24,
              content: "Caption",
              style: { fontFamily: "Inter", fontSize: 14, color: "#111111" }
            },
            makeLeaf("LEAF", 30, 30, 120, 80, "#3B82F6"),
            {
              id: "sub",
              type: "frame",
              name: "SUB",
              x: 200,
              y: 30,
              width: 190,
              height: 150,
              fills: [{ type: "solid", color: "#1F1F1F" }],
              clipContent: false,
              children: [makeLeaf("DEEP", 30, 30, 60, 40, "#10B981")]
            }
          ]
        },
        {
          id: "inst",
          type: "instance",
          name: "INST",
          componentId: "master",
          x: 500,
          y: 100,
          width: 420,
          height: 320
        }
      ], { canvas: { ...base.canvas, width: 4000, height: 3000 } });
  },
  [leaf.toString()]
);

await page.waitForTimeout(400);

const centerOf = (id) =>
  page.evaluate((elId) => {
    const g = document.querySelector(`[data-element-id="${elId}"]`);
    if (!g) throw new Error(`element ${elId} is not rendered`);
    const r = g.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, id);

const selected = () => page.evaluate(() => window.__FISH_BRIDGE__.getSelectedIds());
const docJson = () => page.evaluate(() => JSON.stringify(window.__FISH_BRIDGE__.getElements()));
// Escape now walks up one container, so a setup that needs TRUE emptiness clears
// through the bridge instead of assuming one press is a reset.
const clearSelection = () => page.evaluate(() => window.__FISH_BRIDGE__.selectElements([]));
const clickAt = async (pt, times = 1) => {
  if (times === 1) await page.mouse.click(pt.x, pt.y);
  else await page.mouse.dblclick(pt.x, pt.y);
  await page.waitForTimeout(140);
};
const click = async (id, times = 1) => clickAt(await centerOf(id), times);
const overlay = () =>
  page.evaluate(() => ({
    locked: !!document.querySelector("[data-transform-locked]"),
    resizeHandles: document.querySelectorAll("[data-resize-handle]").length,
    rotateHandles: document.querySelectorAll("[data-rotate-handle]").length
  }));
const hintVisible = () =>
  page.evaluate(() => /inside an instance/i.test(document.body.innerText));

// The nested frame's own leaf resolves to `inst_DEEP`: derived ids are minted as
// `<instanceId>_<masterNodeId>` at every level.
const nestedLeafRendered = await page.evaluate(
  () => !!document.querySelector('[data-element-id="inst_DEEP"]')
);
check("a leaf inside a nested frame is rendered under the instance", nestedLeafRendered, "inst_DEEP");

// Selection behaviour is unchanged: click = instance, double click = the child.
await clearSelection();
await click("inst_LEAF");
check("a plain click on an instance child still selects the instance", (await selected()).join(), "inst");

await clearSelection();
await click("inst_LEAF", 2);
check("a double click enters the instance", (await selected()).join(), "inst_LEAF");

// P0-8: the leaf INSIDE a nested frame has to be reachable.
await clearSelection();
await click("inst_DEEP", 2);
check(
  "a double click reaches a leaf inside a nested frame inside the instance",
  (await selected()).join(),
  "inst_DEEP"
);

// P0-1: no transform affordance for a derived node, outline still shown.
const lockedOverlay = await overlay();
check("the instance child draws no resize handles", lockedOverlay.resizeHandles === 0, JSON.stringify(lockedOverlay));
check("the instance child draws no rotate handles", lockedOverlay.rotateHandles === 0, JSON.stringify(lockedOverlay));
check("the instance child is still outlined", lockedOverlay.locked, JSON.stringify(lockedOverlay));

// A drag with the pierce modifier keeps the derived node as the drag target (a
// PLAIN drag re-selects the instance and moves it — that is the existing "a
// container swallows the click to move itself" rule, not a bug). Nothing may
// move while the derived node is the target.
const dragBy = async (pt, dx, dy) => {
  await page.mouse.move(pt.x, pt.y);
  await page.mouse.down();
  await page.mouse.move(pt.x + dx, pt.y + dy, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(160);
};

await clearSelection();
await click("inst_DEEP", 2);
let before = await docJson();
const deepBox = await page.evaluate(() => {
  const r = document.querySelector('[data-element-id="inst_DEEP"]').getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
});
await page.keyboard.down("Meta");
await dragBy(deepBox, 60, 40);
await page.keyboard.up("Meta");
check("pierce-dragging an instance child does not move the instance", (await docJson()) === before, "doc mutated");

// The same drag from where a corner handle would sit.
const deepCorner = await page.evaluate(() => {
  const r = document.querySelector('[data-element-id="inst_DEEP"]').getBoundingClientRect();
  return { x: r.right, y: r.bottom };
});
before = await docJson();
await page.keyboard.down("Meta");
await dragBy(deepCorner, 70, 50);
await page.keyboard.up("Meta");
check("dragging a corner of an instance child resizes nothing", (await docJson()) === before, "doc mutated");

// Delete cannot remove a node the master owns — every other instance still
// shows it — so it hides it here instead of warning. That is an override, not a
// no-op: the layer is gone from THIS instance and nowhere else.
await clearSelection();
await click("inst_DEEP", 2);
await page.evaluate(() => document.activeElement?.blur());
before = await docJson();
await page.keyboard.press("Delete");
await page.waitForTimeout(120);
check("Delete on an instance child hides it instead of warning", (await docJson()) !== before, "doc untouched");
check("Delete on an instance child raises no hint", !(await hintVisible()), "hint shown");
const hiddenByDelete = await page.evaluate(() => {
  const inst = window.__FISH_BRIDGE__.getElements().find((e) => e.id === "inst");
  return JSON.stringify(inst.overrides || []);
});
check("the hide lands on the instance as an override", hiddenByDelete.includes('"visible"') && hiddenByDelete.includes("false"), hiddenByDelete);
const masterJson = await page.evaluate(() => JSON.stringify(window.__FISH_BRIDGE__.getElements()));
check("the master itself still shows the node", !masterJson.includes('"visible":false'), "master mutated");

before = await docJson();
await page.keyboard.press("ArrowRight");
await page.waitForTimeout(120);
check("arrow nudge on an instance child leaves the document untouched", (await docJson()) === before, "doc mutated");

before = await docJson();
await page.keyboard.press("]");
await page.waitForTimeout(120);
check("layer order on an instance child leaves the document untouched", (await docJson()) === before, "doc mutated");

// Step 4 (§5.1): the property controls are the STANDARD sections, not a bespoke
// set drawn for instance children, and an edit through them becomes an override.
await clearSelection();
await click("inst_LABEL", 2);
check("entering a text child of an instance selects it", (await selected()).join(), "inst_LABEL");
const panel = await page.evaluate(() => ({
  strip: !!document.querySelector('[data-testid="instance-child-section"]'),
  bespokeContent: !!document.querySelector("[data-instance-content]"),
  typography: !!document.querySelector("[data-typography-section]")
}));
check("the bespoke override controls are gone", !panel.bespokeContent, JSON.stringify(panel));
check("the standard typography section is shown instead", panel.typography, JSON.stringify(panel));
check("the instance child strip is shown", panel.strip, JSON.stringify(panel));

const overridesBefore = await page.evaluate(
  () => (window.__FISH_BRIDGE__.getElements().find((el) => el.id === "inst") || {}).overrides || []
);
// The edit goes through a control this panel ACTUALLY has. It used to fill a
// `[data-typography-content]` field, which was removed when instance children
// stopped shipping a bespoke override set: text content is edited on the canvas,
// so there is no content field here to fill — and `page.fill` on a missing
// selector is a 30s timeout that takes the whole spec down with it. The intent is
// unchanged and still worth asserting: an edit through the STANDARD panel lands
// on the instance as an override rather than on the master.
await page.fill('[data-scrub-field="Size"]', "28");
await page.locator('[data-scrub-field="Size"]').press("Enter");
await page.waitForTimeout(200);
const overridesAfter = await page.evaluate(
  () => (window.__FISH_BRIDGE__.getElements().find((el) => el.id === "inst") || {}).overrides || []
);
check(
  "editing the standard panel writes an override on the instance",
  overridesAfter.length > overridesBefore.length &&
    overridesAfter.some((o) => JSON.stringify(o.value ?? null).includes("28")),
  JSON.stringify(overridesAfter)
);

// The instance itself must keep its handles: the lock is per-node, not per-tree.
await clearSelection();
await click("inst");
const instOverlay = await overlay();
check("the instance itself still draws its handles", instOverlay.resizeHandles === 8, JSON.stringify(instOverlay));
check("the instance itself is not marked transform-locked", !instOverlay.locked, JSON.stringify(instOverlay));

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : `  (${r.detail})`}`);
}
console.log(`\n${results.length - failed.length}/${results.length} passed`);
console.log("pageErrors", errors.slice(0, 5));

await browser.close();
process.exit(failed.length === 0 && errors.length === 0 ? 0 : 1);
