import { chromium } from "playwright";
import { pathToFileURL } from "url";
import path from "node:path";

// Two claims about the zoom keys, both of which are only true together:
//
//   1. `Shift+1` frames every VISIBLE layer inside the part of the canvas the
//      floating panels leave uncovered — the canvas is full-bleed, so "fits" and
//      "fits without sitting under the inspector" are different claims
//   2. `Shift+0` sits at 1:1 with the middle of that area held still
//
// The fixture is placed around the world origin on purpose: an element whose own
// x/y are (0, 0) has its painted top-left AT the pan offset, which is what lets
// this spec derive `{zoom, pan}` from `getBoundingClientRect` alone instead of
// reaching into the app.
const html = path.resolve(process.cwd(), process.argv[2] ?? "dist/index.html");

/** `FIT_MARGIN` in `useCanvasViewport.ts`: the breathing room a fit leaves. */
const FIT_MARGIN = 48;
const A_W = 600;
const A_H = 400;

const ELEMENTS = [
  { id: "z_a", type: "rect", name: "A", x: 0, y: 0, width: A_W, height: A_H, fills: [{ type: "solid", color: "#3E63DD" }] },
  { id: "z_b", type: "rect", name: "B", x: 700, y: 500, width: 200, height: 100, fills: [{ type: "solid", color: "#F76B15" }] }
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
const idle = async () => {
  await settle();
  await page.waitForTimeout(150);
  await settle();
};

const boxOf = (id) =>
  page.evaluate((elId) => {
    const n = document.querySelector(`[data-element-id="${CSS.escape(elId)}"]`);
    if (!n) return null;
    const b = n.getBoundingClientRect();
    return { left: b.left, top: b.top, right: b.right, bottom: b.bottom, width: b.width, height: b.height };
  }, id);

/**
 * The window-space boxes of the chrome, recomputed here on purpose: the point of
 * the assertions below is that the implementation agrees with an independent
 * reading of what is actually painted over the canvas.
 */
const chromeRects = () =>
  page.evaluate(() =>
    [...document.querySelectorAll("[data-ui-panel]")].map((panel) => {
      const b = panel.getBoundingClientRect();
      return { side: panel.dataset.uiPanel, left: b.left, top: b.top, right: b.right, bottom: b.bottom };
    })
  );

/** `{zoom, pan}` derived from a layer that sits at the world origin. */
const view = async () => {
  const a = await boxOf("z_a");
  const zoom = a.width / A_W;
  return { zoom, panX: a.left, panY: a.top };
};
const worldAt = async (screenX, screenY) => {
  const { zoom, panX, panY } = await view();
  return { x: (screenX - panX) / zoom, y: (screenY - panY) / zoom };
};

/** The rect the panels leave uncovered: between their inner edges, above the dock. */
const uncovered = async () => {
  const rects = await chromeRects();
  const root = await page.evaluate(() => {
    const r = document.querySelector("[data-canvas-root]").getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  });
  // One branch per anchored edge, mirroring `unobstructedArea`: a fourth edge
  // (the title bar's "top") added a subtraction this reading has to make too,
  // and without it every centre below came out half a bar too high.
  let { left, right, bottom } = root;
  let top = root.top;
  for (const r of rects) {
    if (r.side === "left") left = Math.max(left, r.right);
    else if (r.side === "right") right = Math.min(right, r.left);
    else if (r.side === "dock") bottom = Math.min(bottom, r.top);
    else if (r.side === "top") top = Math.max(top, r.bottom);
  }
  return { left, top, right, bottom };
};

// ---- 0. seed sanity --------------------------------------------------------
const canvasRoot = await page.evaluate(() => {
  const r = document.querySelector("[data-canvas-root]").getBoundingClientRect();
  return { left: r.left, top: r.top, width: r.width, height: r.height };
});
check(
  "the canvas is the window, so screen coordinates are canvas coordinates",
  canvasRoot.left === 0 && canvasRoot.top === 0 && canvasRoot.width === 1600 && canvasRoot.height === 1000,
  JSON.stringify(canvasRoot)
);

const seeded = await page.evaluate(() => document.querySelectorAll("[data-element-id]").length);
check("both fixture layers render", seeded === 2, `rendered=${seeded}`);

const initial = await view();
check("the canvas opens zoom-to-fit at 0.8", Math.abs(initial.zoom - 0.8) < 1e-6, `zoom=${initial.zoom}`);

// ---- 1. Shift + 1 ----------------------------------------------------------
await page.keyboard.press("Shift+1");
await idle();

const area = await uncovered();
const a = await boxOf("z_a");
const b = await boxOf("z_b");
const content = {
  left: Math.min(a.left, b.left),
  top: Math.min(a.top, b.top),
  right: Math.max(a.right, b.right),
  bottom: Math.max(a.bottom, b.bottom)
};

const overlaps = (r, c) => Math.min(r.right, c.right) > Math.max(r.left, c.left) && Math.min(r.bottom, c.bottom) > Math.max(r.top, c.top);
const covered = (await chromeRects()).filter((r) => overlaps(r, content));
check(
  "Shift+1 frames the layers clear of every panel",
  covered.length === 0,
  covered.length ? `overlaps ${covered.map((r) => r.side).join(", ")}` : `content=${JSON.stringify(content)}`
);

const centreX = (content.left + content.right) / 2;
const centreY = (content.top + content.bottom) / 2;
check(
  "and centres them in the uncovered area",
  Math.abs(centreX - (area.left + area.right) / 2) <= 2 && Math.abs(centreY - (area.top + area.bottom) / 2) <= 2,
  `content centre (${centreX}, ${centreY}) vs area centre (${(area.left + area.right) / 2}, ${(area.top + area.bottom) / 2})`
);

const leftoverX = area.right - area.left - (content.right - content.left);
const leftoverY = area.bottom - area.top - (content.bottom - content.top);
const tightest = Math.min(leftoverX, leftoverY);
check(
  "and spends the space: the binding axis keeps exactly the margin",
  Math.abs(tightest - FIT_MARGIN * 2) <= 2,
  `leftoverX=${leftoverX.toFixed(1)} leftoverY=${leftoverY.toFixed(1)} expected=${FIT_MARGIN * 2}`
);

// ---- 2. Shift + 0 ----------------------------------------------------------
const focusX = (area.left + area.right) / 2;
const focusY = (area.top + area.bottom) / 2;
const heldWorld = await worldAt(focusX, focusY);

await page.keyboard.press("Shift+0");
await idle();

const atOneToOne = await view();
check("Shift+0 lands on 1:1, not on some near-1 zoom", Math.abs(atOneToOne.zoom - 1) < 1e-6, `zoom=${atOneToOne.zoom}`);

const stillHeld = await worldAt(focusX, focusY);
check(
  "and holds the middle of the visible area still while zooming",
  Math.abs(stillHeld.x - heldWorld.x) <= 2 && Math.abs(stillHeld.y - heldWorld.y) <= 2,
  `was (${heldWorld.x.toFixed(1)}, ${heldWorld.y.toFixed(1)}), now (${stillHeld.x.toFixed(1)}, ${stillHeld.y.toFixed(1)})`
);

const oneToOne = await boxOf("z_a");
check(
  "1:1 paints a world pixel as a screen pixel",
  Math.abs(oneToOne.width - A_W) <= 1 && Math.abs(oneToOne.height - A_H) <= 1,
  `${oneToOne.width} x ${oneToOne.height}`
);

// ---- 3. a hidden layer is not part of what "fit" frames --------------------
await page.click('[data-layer-eye="z_b"]');
await idle();
await page.keyboard.press("Shift+1");
await idle();

// A is the only visible layer left, so framing it means its own centre is the
// one that lands on the middle of the area — B's box must not pull it.
const focused = await worldAt(
  (await uncovered()).left + ((await uncovered()).right - (await uncovered()).left) / 2,
  (await uncovered()).top + ((await uncovered()).bottom - (await uncovered()).top) / 2
);
check(
  "Shift+1 frames the visible layers only: a hidden one does not drag the box",
  Math.abs(focused.x - A_W / 2) <= 2 && Math.abs(focused.y - A_H / 2) <= 2,
  `area centre is at world (${focused.x.toFixed(1)}, ${focused.y.toFixed(1)}), A centre is (${A_W / 2}, ${A_H / 2})`
);

// ---- 4. a text field keeps the keyboard ------------------------------------
// Every zoom key is also reachable as an ordinary character, and `1` / `2` / `+` /
// `-` are reachable WITHOUT Shift, so a field holding the keyboard is the only
// thing between typing a number into a name and moving the view. A leaked binding
// here would be invisible in every other assertion here and would corrupt a
// rename, so the whole set is pressed, not just the two the claim was written for.
const beforeTyping = await view();
await page.dblclick('[data-layer-row="z_a"]');
await page.waitForTimeout(250);
const editing = await page.evaluate(() => {
  const el = document.activeElement;
  return el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA") ? el.tagName : null;
});
if (editing) {
  const typed = ["Shift+0", "Shift+1", "Shift+2", "1", "2", "+", "-"];
  for (const keys of typed) {
    await page.keyboard.press(keys);
  }
  await page.waitForTimeout(150);
  const afterTyping = await view();
  check(
    "typing in a field does not move the viewport",
    Math.abs(afterTyping.zoom - beforeTyping.zoom) < 1e-6 && Math.abs(afterTyping.panX - beforeTyping.panX) < 1e-6,
    `zoom ${beforeTyping.zoom} -> ${afterTyping.zoom}`
  );
  // The other half of the same claim: a key that is swallowed by the field rather
  // than by the view is typed, and a binding that leaked would eat the character.
  const fieldValue = await page.evaluate(() => (document.activeElement ? document.activeElement.value : ""));
  check(
    "and every one of those keys reached the field instead of being eaten",
    [...new Set("012+-")].every((c) => fieldValue.includes(c)),
    `value=${JSON.stringify(fieldValue)}`
  );
  await page.keyboard.press("Escape");
} else {
  check("typing in a field does not move the viewport", false, "double-clicking the layer row did not open its rename input");
}

// ---- verdict ---------------------------------------------------------------
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
console.log("pageErrors", errors.slice(0, 5));

await browser.close();
process.exit(failed.length === 0 && errors.length === 0 ? 0 : 1);
