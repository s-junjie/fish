import { chromium } from "playwright";
import { pathToFileURL } from "url";
import path from "path";

// Figma's two frame-resize affordances: "Resize to fit" (an inspector action, since
// the command only ever applied to a frame) and Cmd/Ctrl+drag on a handle, which
// resizes the frame and leaves its contents exactly where they are. The unit tests
// pin the maths; this pins the button, the modifier and the handles a hugging frame
// only grows while the modifier is held.
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

const applySetup = (children, frameExtra = {}) =>
  page.evaluate(
    ({ kids, extra }) => {
      const bridge = window.__FISH_BRIDGE__;
      const base = bridge.getDoc();
      bridge.setElements([
          {
            id: "F",
            type: "frame",
            name: "F",
            x: 300,
            y: 200,
            width: 400,
            height: 300,
            fills: [{ type: "solid", color: "#1F1F1F" }],
            children: kids,
            ...extra
          },
          { id: "FAR", type: "rect", name: "FAR", x: 1500, y: 1200, width: 200, height: 200 }
        ], { canvas: { ...base.canvas, width: 4000, height: 3000 } });
    },
    { kids: children, extra: frameExtra }
  );

const readView = () =>
  page.evaluate(() => {
    const svg = document.querySelector("svg.pointer-events-auto");
    const box = svg.parentElement.getBoundingClientRect();
    const m = /translate\((-?[\d.]+), (-?[\d.]+)\) scale\(([\d.]+)\)/.exec((() => { const s = document.querySelector("[data-stage-transform]"); const a = s && s.getAttribute("transform"); if (a) return a; const svg = s && s.ownerSVGElement; const t = svg ? getComputedStyle(svg).transform : ""; const m = /matrix\(([\d.eE+-]+), 0, 0, ([\d.eE+-]+), ([\d.eE+-]+), ([\d.eE+-]+)\)/.exec(t); return m ? "translate(" + m[3] + ", " + m[4] + ") scale(" + m[1] + ")" : null; })());
    return {
      pan: { x: parseFloat(m[1]), y: parseFloat(m[2]) },
      zoom: parseFloat(m[3]),
      rect: { left: box.left, top: box.top }
    };
  });
const toScreen = async (wx, wy) => {
  const v = await readView();
  return { x: v.rect.left + v.pan.x + wx * v.zoom, y: v.rect.top + v.pan.y + wy * v.zoom };
};
const settle = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
const getFrame = () =>
  page.evaluate(() => {
    const f = window.__FISH_BRIDGE__.getElements().find((e) => e.id === "F");
    return {
      x: f.x,
      y: f.y,
      width: f.width,
      height: f.height,
      sizing: f.sizing ?? null,
      kids: (f.children || []).map((c) => ({ id: c.id, x: c.x, y: c.y, width: c.width, height: c.height }))
    };
  });
const rightClickWorld = async (wx, wy) => {
  const p = await toScreen(wx, wy);
  await page.mouse.click(p.x, p.y, { button: "right" });
  await settle();
};
const dragWorld = async (from, dx, dy, modifiers = []) => {
  for (const m of modifiers) await page.keyboard.down(m);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(from.x + (dx * i) / 10, from.y + (dy * i) / 10);
  await page.mouse.up();
  for (const m of modifiers) await page.keyboard.up(m);
  await settle();
};

const plain = (id, x, y, w, h, extra = {}) => ({ id, type: "rect", name: id, x, y, width: w, height: h, ...extra });

// ------------------------------------------------------------------ resize to fit
await applySetup([
  { ...plain("a", 20, 30, 100, 50), fills: [{ type: "solid", color: "#3B82F6" }] },
  { ...plain("b", 200, 150, 60, 40), fills: [{ type: "solid", color: "#EF4444" }] }
]);
await settle();
await page.evaluate(() => window.__FISH_BRIDGE__.selectElement("F"));
await settle();

// An empty patch of the frame: a right-click must resolve to the frame itself,
// exactly as a left click there would.
await rightClickWorld(300 + 20, 200 + 250);
check("right-click on a frame opens the menu", await page.locator("[data-context-menu]").count(), 1);
check("the menu also offers the clipboard commands", await page.locator('[data-context-item="pasteStyle"]').count(), 1);
// Resize to fit is not a menu row. The command only ever applied to a frame, and the
// menu lists its rows for every layer, so the entry was a permanently disabled
// control on everything else — a legend where the user only ever needed a button.
check(
  "but the menu no longer offers resize to fit",
  await page.locator('[data-context-item="resizeToFit"]').count(),
  0
);
await page.keyboard.press("Escape");
await settle();

// The command itself, from the inspector: an icon action in the Size section header.
// It is offered for a FRAME and for nothing else — a permanently disabled button
// on every shape is chrome the user cannot act on, so the panel does not draw it.
// Escape doubles as deselect, so the frame is re-picked to stand in for "the menu
// closed and the user went on to use the panel".
await page.evaluate(() => window.__FISH_BRIDGE__.selectElement("F"));
await settle();
const panelFit = page.locator('[data-resize-to-fit="true"]');
check("the panel offers resize to fit for a frame", await panelFit.count(), 1);
check("and it is live", await panelFit.isDisabled(), false);
await panelFit.click();
await settle();
const fit = await getFrame();
check("resize to fit moves the frame onto its content", [fit.x, fit.y], [320, 230]);
check("resize to fit shrinks the frame to the content union", [fit.width, fit.height], [240, 160]);
check(
  "resize to fit leaves the content where it was on the canvas",
  fit.kids.map((k) => [k.x + fit.x, k.y + fit.y]),
  [
    [320, 230],
    [500, 350]
  ]
);

await page.evaluate(() => window.__FISH_BRIDGE__.selectElement("a"));
await settle();
check("a shape is not offered the button at all", await panelFit.count(), 0);

// Inside a frame the layout engine can still own the box, and that refusal keeps
// the disabled state *with* the reason (LESSONS §15).
await applySetup([plain("a", 0, 0, 80, 40), plain("b", 0, 60, 80, 40)], {
  sizing: { height: "fit-content" },
  display: "flex",
  "flex-direction": "column",
  gap: 20,
  padding: 10
});
await settle();
await page.evaluate(() => window.__FISH_BRIDGE__.selectElement("F"));
await settle();
check("a stack still shows it, disabled with the reason", [await panelFit.count(), await panelFit.isDisabled()], [1, true]);
check(
  "and the disabled state explains itself",
  await panelFit.getAttribute("title"),
  "An auto-layout frame sizes itself from its children"
);

// ------------------------------------------------------ cmd+drag resizes the frame
// `stretch` is the constraint that makes the two gestures differ: a plain drag
// widens the child with the frame, and Cmd+drag must not touch it at all.
const stretchKid = plain("a", 20, 20, 100, 100, {
  constraints: { horizontal: "stretch", vertical: "top" }
});
await applySetup([stretchKid]);
await settle();
await page.evaluate(() => window.__FISH_BRIDGE__.selectElement("F"));
await settle();
const { zoom } = await readView();
// `dragWorld` takes SCREEN pixels; the gesture divides by the zoom itself.
const grow = Math.round(240 * zoom);

const eastHandle = await toScreen(300 + 400, 200 + 150);
await dragWorld(eastHandle, grow, 0);
const plainResize = await getFrame();
check("a plain drag resizes the frame", plainResize.width, 400 + 240);
check(
  "a plain drag stretches the child with it",
  plainResize.kids[0].width,
  100 + 240
);
await applySetup([stretchKid]);
await settle();
await page.evaluate(() => window.__FISH_BRIDGE__.selectElement("F"));
await settle();
await dragWorld(eastHandle, grow, 0, ["Meta"]);
const cmdResize = await getFrame();
check("cmd+drag resizes the frame", cmdResize.width, 400 + 240);
check(
  "cmd+drag leaves the child's size alone",
  [cmdResize.kids[0].width, cmdResize.kids[0].height],
  [100, 100]
);
check("cmd+drag leaves the child's position alone", [cmdResize.kids[0].x, cmdResize.kids[0].y], [20, 20]);

// ------------------------------------- the two gestures, on a constrained child
// A `left`/`top` child must never change its distance from that corner, and a
// `right` child must never change its distance from that edge — including when the
// WEST handle moves the frame's own origin, which is the case that used to drift:
// the constraint maths was handed the frame's canvas box and subtracted its origin
// from a child whose `x` never had it.
await applySetup([
  plain("tl", 20, 30, 100, 80, { constraints: { horizontal: "left", vertical: "top" } }),
  plain("right", 200, 150, 80, 80, { constraints: { horizontal: "right", vertical: "top" } })
]);
await settle();
await page.evaluate(() => window.__FISH_BRIDGE__.selectElement("F"));
await settle();
const beforeWest = await getFrame();
await dragWorld(await toScreen(300, 200 + 150), -grow, 0);
const afterWest = await getFrame();
const byId = (f, id) => f.kids.find((k) => k.id === id);
check("a west-edge drag keeps a top-left child's local position", [byId(afterWest, "tl").x, byId(afterWest, "tl").y], [20, 30]);
check(
  "and keeps a right-pinned child at the same distance from the right edge",
  beforeWest.width - (byId(beforeWest, "right").x + byId(beforeWest, "right").width),
  afterWest.width - (byId(afterWest, "right").x + byId(afterWest, "right").width)
);

// Cmd+drag is the opposite rule: the children hold their position ON CANVAS, and
// their local coordinates are recomputed so the frame grows around them.
await applySetup([
  plain("tl", 20, 30, 100, 80, { constraints: { horizontal: "left", vertical: "top" } }),
  plain("right", 200, 150, 80, 80, { constraints: { horizontal: "right", vertical: "top" } })
]);
await settle();
await page.evaluate(() => window.__FISH_BRIDGE__.selectElement("F"));
await settle();
const beforeFreeze = await getFrame();
await dragWorld(await toScreen(300, 200 + 150), -grow, 0, ["Meta"]);
const afterFreeze = await getFrame();
const canvasX = (f, k) => f.x + k.x;
check("cmd+drag leaves a child's canvas position alone", [canvasX(afterFreeze, byId(afterFreeze, "tl")), canvasX(afterFreeze, byId(afterFreeze, "right"))], [
  canvasX(beforeFreeze, byId(beforeFreeze, "tl")),
  canvasX(beforeFreeze, byId(beforeFreeze, "right"))
]);
check(
  "and gives the top-left child the new distance to the moved edge",
  byId(afterFreeze, "tl").x,
  byId(beforeFreeze, "tl").x + (beforeFreeze.x - afterFreeze.x)
);
// `grow` is screen pixels; the gesture divides by the zoom, so the world delta is
// the 240 this spec asks for.
check("nothing snapped on release: the size is what the drag asked for", afterFreeze.width, beforeFreeze.width + 240);

// ------------------------------------------- cmd+drag unlocks a hugging frame's axis
// A real hugging axis needs a layout pass to act on it, so the frame is a stack
// with a `fit-content` height: the height handles are the ones the engine owns,
// and they do not exist at all until the modifier is held.
await applySetup([plain("a", 0, 0, 100, 60), plain("b", 0, 80, 100, 60)], {
  sizing: { height: "fit-content" },
  display: "flex",
  "flex-direction": "column",
  gap: 20,
  padding: 0
});
await settle();
await page.evaluate(() => window.__FISH_BRIDGE__.selectElement("F"));
await settle();
const before = await getFrame();
// `applyDoc` stores the tree verbatim, so the height here is the authored one. What
// matters is that a relayout would re-hug it back to 140 — the pin is what stops
// that, and the assertions below read `before.height` rather than hard-coding.
check("the stack placed its children", before.kids.map((k) => k.y), [0, 80]);
check("a hugging frame keeps the width handle", await page.locator('[data-resize-handle="mr"]').count(), 1);
check("a hugging frame hides the height handles", await page.locator('[data-resize-handle="bm"]').count(), 0);
await page.keyboard.down("Meta");
await settle();
check(
  "holding cmd offers the height handles",
  await page.locator('[data-resize-handle="bm"]').count(),
  1
);
check("the frame says it is in frame-resize mode", await page.locator('[data-frame-resize="true"]').count(), 1);
await page.keyboard.up("Meta");
await settle();
check("releasing cmd takes them away again", await page.locator('[data-resize-handle="bm"]').count(), 0);

const bottomHandle = await toScreen(300 + 400 / 2, 200 + before.height);
await dragWorld(bottomHandle, 0, Math.round(120 * zoom), ["Meta"]);
const hugResize = await getFrame();
check("cmd+drag gives a hugging frame the size the drag asked for", hugResize.height, before.height + 120);
check("and the drag beats the hug it would otherwise get back", hugResize.height === 140, false);
check("and pins the axis, so the layout pass cannot take it back", hugResize.sizing, { height: "fixed" });
check("the children are still exactly where the stack put them", hugResize.kids.map((k) => k.y), [0, 80]);

// ------------------------------- a stack resize moves the children that left the flow
// `applyAutoLayout` places the in-flow children and re-interleaves them into their
// authored slots, which leaves everything else exactly where it was — including a
// child that left the flow, whose whole job is to follow the box. Dragging the
// east handle of a stack used to call that pass alone, so a right-pinned child
// followed a width typed into the inspector and stood still here.
const STACK = {
  display: "flex",
  "flex-direction": "column",
  gap: 0,
  padding: 0
};
const rightPinned = plain("abs", 300, 0, 50, 50, {
  position: "absolute",
  constraints: { horizontal: "right", vertical: "top" }
});
const inFlow = plain("flow", 0, 0, 50, 50);

await applySetup([inFlow, rightPinned], STACK);
await settle();
await page.evaluate(() => window.__FISH_BRIDGE__.selectElement("F"));
await settle();
const beforePins = await getFrame();
const byPinnedId = (f) => f.kids.find((k) => k.id === "abs");

// A plain (unmodified) east-handle drag: the frame resizes, the stack reflows, and
// the child that left the flow follows its own constraint.
await dragWorld(await toScreen(300 + beforePins.width, 200 + 150), grow, 0);
const afterPins = await getFrame();
check("a plain drag resizes the stack", afterPins.width, beforePins.width + 240);
check(
  "and the child pinned to the right edge follows it",
  afterPins.width - (byPinnedId(afterPins).x + byPinnedId(afterPins).width),
  beforePins.width - (byPinnedId(beforePins).x + byPinnedId(beforePins).width)
);
check("the in-flow child keeps its slot", afterPins.kids.find((k) => k.id === "flow").y, 0);

// Cmd+drag is the other frame-resize gesture and must reach the same pass: it
// hands the stack a pinned axis and lets the layout pass take the children from
// there, so a pinned child still has to be moved rather than left behind.
await applySetup([inFlow, rightPinned], STACK);
await settle();
await page.evaluate(() => window.__FISH_BRIDGE__.selectElement("F"));
await settle();
const beforeCmd = await getFrame();
await dragWorld(await toScreen(300 + beforeCmd.width, 200 + 150), grow, 0, ["Meta"]);
const afterCmd = await getFrame();
check("cmd+drag resizes the stack too", afterCmd.width, beforeCmd.width + 240);
check(
  "and moves the child that left the flow just the same",
  afterCmd.width - (afterCmd.kids.find((k) => k.id === "abs").x + afterCmd.kids.find((k) => k.id === "abs").width),
  beforeCmd.width - (beforeCmd.kids.find((k) => k.id === "abs").x + beforeCmd.kids.find((k) => k.id === "abs").width)
);

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : `  -> ${JSON.stringify(r.actual)} (expected ${JSON.stringify(r.expected)})`}`);
}
console.log(`\n${results.length - failed.length}/${results.length} passed`);
console.log("pageErrors", errors.slice(0, 5));

await browser.close();
process.exit(failed.length === 0 && errors.length === 0 ? 0 : 1);
