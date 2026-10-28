import { chromium } from "playwright";
import { pathToFileURL } from "url";
import path from "path";

// A master component is a published definition, so from OUTSIDE a plain click
// anywhere inside it selects the master, and only a double click (or Cmd/Ctrl
// pierce) reaches a child. That barrier lifts once something inside is selected —
// otherwise the selection is trapped and nothing in a component can be
// rearranged. Frames keep their existing "select, then enter" behavior; this spec
// pins all three.
const html = path.resolve(process.cwd(), process.argv[2] ?? "dist/index.html");
const results = [];
const check = (name, actual, expected) =>
  results.push({ name, ok: JSON.stringify(actual) === JSON.stringify(expected), actual, expected });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});

await page.goto(pathToFileURL(html).href);
await page.waitForFunction(() => !!window.__FISH_BRIDGE__);

const leaf = (id, x, y, width, height, color) => ({
  id,
  type: "rect",
  name: id,
  x,
  y,
  width,
  height,
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
            },
            {
              id: "inner",
              type: "component",
              name: "INNER",
              x: 30,
              y: 180,
              width: 360,
              height: 110,
              fills: [{ type: "solid", color: "#242424" }],
              clipContent: false,
              children: [makeLeaf("NESTED", 30, 30, 100, 50, "#F59E0B")]
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
        },
        {
          id: "pf",
          type: "frame",
          name: "PF",
          x: 0,
          y: 520,
          width: 420,
          height: 320,
          fills: [{ type: "solid", color: "#2A2A2A" }],
          clipContent: false,
          children: [makeLeaf("PLEAF", 30, 30, 120, 80, "#EC4899")]
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
const nodeAt = (id) =>
  page.evaluate((elId) => {
    const stack = [...(window.__FISH_BRIDGE__.getElements() || [])];
    while (stack.length) {
      const el = stack.shift();
      if (el.id === elId) return { x: el.x, y: el.y, type: el.type };
      if (el.children) stack.push(...el.children);
    }
    return null;
  }, id);
const dragBy = async (id, dx, dy) => {
  const from = await centerOf(id);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + dx, from.y + dy, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(180);
};
// Escape now walks up one container, so a setup that needs TRUE emptiness clears
// through the bridge instead of assuming one press is a reset.
const clearSelection = () => page.evaluate(() => window.__FISH_BRIDGE__.selectElements([]));

const clickAt = async (pt, times = 1) => {
  if (times === 1) await page.mouse.click(pt.x, pt.y);
  else await page.mouse.dblclick(pt.x, pt.y);
  await page.waitForTimeout(120);
};
const click = async (id, times = 1) => clickAt(await centerOf(id), times);

// A point inside `frameId` but clear of `childId`: a frame's bbox also carries
// the title label drawn above its box, so its center is not the box center.
const clickInFrameAwayFromChild = async (frameId, childId, times = 1) => {
  const pt = await page.evaluate(
    ([f, c]) => {
      const fr = document.querySelector(`[data-element-id="${f}"]`).getBoundingClientRect();
      const cr = document.querySelector(`[data-element-id="${c}"]`).getBoundingClientRect();
      return {
        x: Math.min(cr.right + 24, fr.right - 8),
        y: Math.min(cr.bottom + 24, fr.bottom - 8)
      };
    },
    [frameId, childId]
  );
  await clickAt(pt, times);
};

for (const id of ["LEAF", "sub", "DEEP"]) {
  await clearSelection();
  await click(id);
  check(`a plain click on ${id} selects the master`, await selected(), ["master"]);
}

await clearSelection();
await click("LEAF", 2);
check("a double click on a direct child enters the master", await selected(), ["LEAF"]);

await clearSelection();
await click("DEEP", 2);
check("a double click pierces a nested frame inside the master", await selected(), ["DEEP"]);

await clearSelection();
await clickInFrameAwayFromChild("sub", "DEEP", 2);
check("a double click on a nested frame selects that frame", await selected(), ["sub"]);

// The barrier is an "outside" rule. Once a child is selected the master must stop
// swallowing clicks, or every further click bounces back to it and the one node
// you drilled into is the only thing you can ever reach.
await click("LEAF", 2);
await click("sub");
check("a sibling click inside the master reaches the sibling", await selected(), ["sub"]);

await clearSelection();
await click("DEEP", 2);
await clickInFrameAwayFromChild("sub", "DEEP");
check("a deep selection also counts as being inside", await selected(), ["sub"]);

// And the point of all that: the children of a component can be moved. The delta
// is not asserted against the pointer — the canvas is at whatever zoom the app
// chose, and the drag snaps, which can pull an axis all the way back — only that
// the CHILD moved and the master stayed put. Before, the click selected the
// master, so the drag moved the master instead.
const movedBy = async (id, dx, dy) => {
  const before = await nodeAt(id);
  await dragBy(id, dx, dy);
  const after = await nodeAt(id);
  return { id, dx: after.x - before.x, dy: after.y - before.y };
};

await clearSelection();
await click("LEAF", 2);
check("a child of a master is selected for dragging", await selected(), ["LEAF"]);
const leafMove = await movedBy("LEAF", 90, 60);
check("a child of a master can be dragged", leafMove.dx !== 0 || leafMove.dy !== 0, true);
check("dragging the child left the master where it was", (await nodeAt("master")).x, 0);
check("dragging it kept it selected", await selected(), ["LEAF"]);

await clearSelection();
await click("DEEP", 2);
const deepMove = await movedBy("DEEP", 40, 30);
check("a nested frame's child can be dragged too", deepMove.dx !== 0 || deepMove.dy !== 0, true);
check("its frame stayed put", (await nodeAt("sub")).x, 200);

// The master itself is still movable by clicking inside it — that is the whole
// point of the barrier from the outside.
await clearSelection();
await click("LEAF");
check("from outside, the master is what a click selects", await selected(), ["master"]);
const masterBefore = await nodeAt("master");
const childBefore = await nodeAt("LEAF");
await dragBy("LEAF", 70, 50);
const masterAfter = await nodeAt("master");
check(
  "with the master selected, an inside click moves the master",
  [masterAfter.x !== masterBefore.x || masterAfter.y !== masterBefore.y],
  [true]
);
check("and leaves the child alone", (await nodeAt("LEAF")).x, childBefore.x);

await clearSelection();
await click("NESTED");
check("a nested component is its own barrier", await selected(), ["inner"]);
await click("NESTED", 2);
check("a double click enters the nested component", await selected(), ["NESTED"]);

// Instances resolve their rendered children to the instance itself; an instance
// is not a master, so the barrier must not touch this path.
await clearSelection();
await click("inst_LEAF");
check("clicking a rendered instance child selects the instance", await selected(), ["inst"]);
await clearSelection();
await click("inst_LEAF", 2);
check("a double click enters an instance", await selected(), ["inst_LEAF"]);

// Frames keep the "select, then enter" behavior the barrier must not disturb.
await clearSelection();
await click("PLEAF");
check("a plain frame still gates its children", await selected(), ["pf"]);
await click("PLEAF");
check("a selected frame still swallows a child click", await selected(), ["pf"]);
await click("PLEAF", 2);
check("a double click still enters a frame", await selected(), ["PLEAF"]);
await click("PLEAF");
check("once inside a frame, siblings stay directly clickable", await selected(), ["PLEAF"]);

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : `  -> got ${JSON.stringify(r.actual)}, want ${JSON.stringify(r.expected)}`}`);
}
console.log(`\n${results.length - failed.length}/${results.length} passed`);
console.log("pageErrors", errors.slice(0, 5));

await browser.close();
process.exit(failed.length === 0 && errors.length === 0 ? 0 : 1);
