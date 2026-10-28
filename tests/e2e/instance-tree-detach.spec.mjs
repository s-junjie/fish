import { activeElements } from "./_support/doc.mjs";
import { chromium } from "playwright";
import { pathToFileURL } from "url";
import path from "path";

// Three things an instance owes the user, all of them about the boundary between
// "projection" and "real node":
//   1. a projection may not be nested inside the thing it projects (it would
//      never finish resolving) — refused on both reparent paths, with the master
//      never lighting up as a target;
//   2. the layer tree expands an instance and selects its children, which is the
//      only way to reach a nested leaf without hunting for it on the canvas;
//   3. detaching hands over REAL nodes: keeping the derived markers would leave
//      every "not in the document tree" refusal alive on a frame that is.
const html = path.resolve(process.cwd(), process.argv[2] ?? "dist/index.html");
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  (${detail})`}`);
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

await page.evaluate(() => {
  const bridge = window.__FISH_BRIDGE__;
  const base = bridge.getDoc();
  bridge.setElements([
      {
        id: "master",
        type: "component",
        name: "MASTER",
        x: 0,
        y: 100,
        width: 300,
        height: 200,
        fills: [{ type: "solid", color: "#2A2A2A" }],
        clipContent: false,
        children: [
          {
            id: "LABEL",
            type: "text",
            name: "LABEL",
            x: 20,
            y: 20,
            width: 160,
            height: 24,
            content: "Caption",
            style: { fontFamily: "Inter", fontSize: 14, color: "#111111" }
          },
          {
            id: "SUB",
            type: "frame",
            name: "SUB",
            x: 20,
            y: 90,
            width: 220,
            height: 90,
            fills: [{ type: "solid", color: "#1F1F1F" }],
            clipContent: false,
            children: [
              {
                id: "DEEP",
                type: "rect",
                name: "DEEP",
                x: 20,
                y: 20,
                width: 60,
                height: 40,
                fills: [{ type: "solid", color: "#10B981" }]
              }
            ]
          }
        ]
      },
      {
        id: "inst",
        type: "instance",
        name: "INST",
        componentId: "master",
        x: 700,
        y: 100,
        width: 300,
        height: 200
      },
      // A plain layer, used to prove the layer-tree drop gesture works at all.
      {
        id: "spare",
        type: "rect",
        name: "SPARE",
        x: 1200,
        y: 100,
        width: 80,
        height: 40,
        fills: [{ type: "solid", color: "#F59E0B" }]
      }
    ], { canvas: { ...base.canvas, width: 4000, height: 3000 } });
});

await page.waitForTimeout(400);

const doc = () => page.evaluate(() => window.__FISH_BRIDGE__.getDoc());
const docJson = () => page.evaluate(() => JSON.stringify(window.__FISH_BRIDGE__.getElements()));
const selected = () => page.evaluate(() => window.__FISH_BRIDGE__.getSelectedIds());
// Escape now walks up one container, so a setup that needs TRUE emptiness clears
// through the bridge instead of assuming one press is a reset.
const clearSelection = () => page.evaluate(() => window.__FISH_BRIDGE__.selectElements([]));
const centerOf = (selector) =>
  page.evaluate((sel) => {
    const g = document.querySelector(sel);
    if (!g) throw new Error(`${sel} is not rendered`);
    const r = g.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, selector);
const overlay = () =>
  page.evaluate(() => ({
    locked: !!document.querySelector("[data-transform-locked]"),
    resizeHandles: document.querySelectorAll("[data-resize-handle]").length
  }));
const panelRow = (id) => `[data-ui-panel="left"] [data-layer-row="${id}"]`;
const panelHas = (id) => page.evaluate((sel) => !!document.querySelector(sel), panelRow(id));

// --- 2. the layer tree ------------------------------------------------------
check("the instance has a row in the layer tree", await panelHas("inst"));
// Instances start closed: an imported instance can carry hundreds of rows, and
// resolving them is not something a page load should pay for.
check("no derived row is listed before expanding", !(await panelHas("inst_LABEL")));

await page.locator(`${panelRow("inst")} button`).first().click();
await page.waitForTimeout(200);

check("expanding the instance lists its resolved children", await panelHas("inst_LABEL"));
check("a nested child is listed under its derived parent", await panelHas("inst_DEEP"));
const derivative = await page.evaluate(
  (sel) => document.querySelector(sel)?.closest("[data-layer-id]")?.getAttribute("data-derivative") ?? null,
  panelRow("inst_LABEL")
);
check("derived rows are marked as derived", derivative === "true", `data-derivative=${derivative}`);
const dragAttrs = await page.evaluate(
  (sel) => {
    const row = document.querySelector(sel);
    return { draggable: row?.getAttribute("draggable"), actions: row?.querySelectorAll("button").length ?? -1 };
  },
  panelRow("inst_LABEL")
);
// A derived row is not draggable — it has no place in the tree to be moved to —
// but it does carry the lock and the eye: hiding or locking a layer inside one
// instance is an override on that instance, and it is the only way to say so.
check("a derived leaf row offers no drag, but does offer the switches", dragAttrs.draggable === "false" && dragAttrs.actions === 2, JSON.stringify(dragAttrs));

await page.click(panelRow("inst_DEEP"));
await page.waitForTimeout(200);
check("clicking a derived row selects the resolved node", (await selected()).join(), "inst_DEEP");
const derivedOverlay = await overlay();
check("the selected derived node is outlined but transform-locked", derivedOverlay.locked, JSON.stringify(derivedOverlay));
check("the selected derived node draws no handles", derivedOverlay.resizeHandles === 0, JSON.stringify(derivedOverlay));

await page.locator(`${panelRow("inst")} button`).first().click();
await page.waitForTimeout(250);
check("collapsing the instance hides the derived rows again", !(await panelHas("inst_LABEL")));

// Entering the instance on the canvas selects a node that is not in the document
// tree at all, so the panel has to walk the resolution to find the row to open.
// The instance is selected first: the reveal is driven by the selection, and a
// click that lands on the node already selected has nothing to re-open.
await page.click(panelRow("inst"));
await page.waitForTimeout(150);
const deepCenterIdle = await centerOf('[data-element-id="inst_DEEP"]');
await page.mouse.dblclick(deepCenterIdle.x, deepCenterIdle.y);
await page.waitForTimeout(300);
check("double-clicking a nested leaf on canvas selects it", (await selected()).join(), "inst_DEEP");
check("the panel opens the rows needed to show it", await panelHas("inst_DEEP"));

// --- 1. no nesting inside the own master ------------------------------------
await clearSelection();
await page.evaluate(() => window.__FISH_BRIDGE__.selectElement("inst"));
await page.waitForTimeout(150);

const instCenter = await centerOf('[data-element-id="inst"]');
const masterCenter = await centerOf('[data-element-id="master"]');
const masterHighlighted = () =>
  page.evaluate(() => {
    const g = document.querySelector('[data-element-id="master"]');
    return !!g?.querySelector('rect[data-overlay="true"]');
  });
const masterChildren = async () => {
  const d = await doc();
  const master = activeElements(d).find((el) => el.id === "master");
  return (master.children || []).map((c) => c.id);
};

const beforeDragJson = await docJson();
await page.mouse.move(instCenter.x, instCenter.y);
await page.mouse.down();
await page.mouse.move(masterCenter.x, masterCenter.y, { steps: 12 });
await page.waitForTimeout(80);
check("the instance's own master never highlights as a drop target", !(await masterHighlighted()));
await page.mouse.up();
await page.waitForTimeout(200);

check("dropping the instance on its master does not nest it", !(await masterChildren()).includes("inst"));
const afterDropDoc = await doc();
check(
  "the instance is still a top-level element",
  activeElements(afterDropDoc).some((el) => el.id === "inst"),
  `elements=${activeElements(afterDropDoc).map((el) => el.id).join()}`
);
check("the drag still moved it (only the nesting is refused)", (await docJson()) !== beforeDragJson);
const hint = await page.evaluate(() =>
  /nested inside its own main component/i.test(document.body.innerText)
);
check("the refusal is announced", hint);

// The layer tree path must refuse too. HTML5 drag & drop, dropped on the row's
// middle so the panel reads it as "inside".
await page.dragAndDrop(panelRow("inst"), panelRow("master"));
await page.waitForTimeout(250);
check("dropping the instance row on the master row does not nest it", !(await masterChildren()).includes("inst"));
check(
  "the layer-tree refusal leaves an instance where it was",
  await page.evaluate(() => !!window.__FISH_BRIDGE__.getElements().some((el) => el.id === "inst")),
  `doc=${activeElements(await doc()).map((el) => el.id).join()}`
);
// The same gesture on an ordinary layer must still nest it — otherwise the check
// above could pass because drag & drop never happened at all. (`spare` lands in
// the master and stays there; every later assertion is id-based.)
await page.dragAndDrop(panelRow("spare"), panelRow("master"));
await page.waitForTimeout(250);
check(
  "the same layer-tree gesture still nests an ordinary layer",
  (await masterChildren()).includes("spare"),
  JSON.stringify(await masterChildren())
);

// --- 3. detaching releases the clones ---------------------------------------
await clearSelection();
await page.evaluate(() => window.__FISH_BRIDGE__.selectElement("inst"));
await page.waitForTimeout(150);
await page.click('button[title^="Detach Instance"]');
await page.waitForTimeout(300);

const detached = await doc();
const detachedFrame = activeElements(detached).find((el) => el.id === "inst");
check(
  "detaching turns the instance into a frame",
  detachedFrame?.type === "frame" && (detachedFrame?.children || []).length > 0,
  `type=${detachedFrame?.type} children=${JSON.stringify((detachedFrame?.children || []).map((c) => c.id))}`
);
const markers = await page.evaluate(() => {
  const frame = window.__FISH_BRIDGE__.getElements().find((el) => el.id === "inst");
  const walk = (els) =>
    els.flatMap((el) => [Object.keys(el).filter((k) => k.startsWith("__")), ...walk(el.children || [])]);
  return walk(frame?.children || []).flat();
});
check("no derived marker survives the detach", markers.length === 0, `markers=${JSON.stringify(markers)}`);

// A frame row is open by default, so the released children should already be
// listed; open it only if something closed it.
if (!(await panelHas("inst_SUB"))) {
  await page.locator(`${panelRow("inst")} button`).first().click();
  await page.waitForTimeout(300);
}
const panelRowIds = await page.evaluate(() =>
  [...document.querySelectorAll('[data-ui-panel="left"] [data-layer-row]')].map((r) => r.getAttribute("data-layer-row"))
);
check("the released child is listed in the layer tree", panelRowIds.includes("inst_SUB"), JSON.stringify(panelRowIds));
await page.click(panelRow("inst_DEEP"));
await page.waitForTimeout(200);
const releasedOverlay = await overlay();
check("a released child is not transform-locked any more", !releasedOverlay.locked, JSON.stringify(releasedOverlay));
check("a released child draws its resize handles", releasedOverlay.resizeHandles > 0, JSON.stringify(releasedOverlay));

const childBefore = await page.evaluate(() => {
  const frame = window.__FISH_BRIDGE__.getElements().find((el) => el.id === "inst");
  const deep = frame.children.find((c) => c.id === "inst_SUB").children.find((c) => c.id === "inst_DEEP");
  return { x: deep.x, y: deep.y };
});
const deepCenter = await centerOf('[data-element-id="inst_DEEP"]');
await page.mouse.move(deepCenter.x, deepCenter.y);
await page.mouse.down();
await page.mouse.move(deepCenter.x + 60, deepCenter.y + 40, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(250);
const childAfter = await page.evaluate(() => {
  const frame = window.__FISH_BRIDGE__.getElements().find((el) => el.id === "inst");
  const deep = frame.children.find((c) => c.id === "inst_SUB").children.find((c) => c.id === "inst_DEEP");
  return { x: deep.x, y: deep.y };
});
check(
  "a released child can be dragged",
  childAfter.x !== childBefore.x || childAfter.y !== childBefore.y,
  `${JSON.stringify(childBefore)} -> ${JSON.stringify(childAfter)}`
);

await page.evaluate(() => document.activeElement?.blur());
await page.keyboard.press("Delete");
await page.waitForTimeout(200);
const stillThere = await page.evaluate(() => {
  const frame = window.__FISH_BRIDGE__.getElements().find((el) => el.id === "inst");
  return (frame?.children || []).some((c) => c.id === "inst_SUB" && (c.children || []).some((d) => d.id === "inst_DEEP"));
});
check("a released child can be deleted", !stillThere);

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
console.log("pageErrors", errors.slice(0, 5));

await browser.close();
process.exit(failed.length === 0 && errors.length === 0 ? 0 : 1);
