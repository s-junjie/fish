import { chromium } from "playwright";
import { pathToFileURL } from "url";
import path from "path";

/**
 * The four behaviours that were wrong, each pinned at the level it actually failed.
 *
 * Every one of these was invisible to a unit test and, for three of them, to the
 * existing e2e suite too: the shift-drag case looked right because the assertions
 * only ever checked that an axis was held, and the instance case looked right
 * because the control that was dead was not the one under test.
 */
const html = path.resolve(process.cwd(), process.argv[2] ?? "dist/index.html");
const results = [];
// Printed as it goes: a throw three quarters of the way through would otherwise
// hide every check that already passed, which is how a late failure gets
// misread as an early one.
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  results.push({ name, ok, actual, expected });
  console.log(`${ok ? "✔" : "✖"} ${name}`);
  if (!ok) console.log(`    expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
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

const settle = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
const rect = (id, x, y, w, h, color) => ({
  id, type: "rect", name: id, x, y, width: w, height: h, fills: [{ type: "solid", color: color || "#3B82F6" }]
});
const applySetup = (elements, styles) =>
  page.evaluate(
    ({ els, sts }) => {
      const b = window.__FISH_BRIDGE__;
      const base = b.getDoc();
      b.setElements(els, { canvas: { ...base.canvas, width: 4000, height: 3000 }, ...(sts ? { styles: sts } : {}) });
    },
    { els: elements, sts: styles }
  );
const box = (id) =>
  page.evaluate((elId) => {
    const find = (list) => {
      for (const el of list) {
        if (el.id === elId) return el;
        const hit = find(el.children || []);
        if (hit) return hit;
      }
      return null;
    };
    const el = find(window.__FISH_BRIDGE__.getElements());
    return { x: el.x, y: el.y, w: el.width, h: el.height };
  }, id);
const ids = () => page.evaluate(() => window.__FISH_BRIDGE__.getElements().map((e) => e.id));
const view = async () =>
  page.evaluate(() => {
    const svg = document.querySelector("svg.pointer-events-auto");
    const box = svg.parentElement.getBoundingClientRect();
    const m = /translate\((-?[\d.]+), (-?[\d.]+)\) scale\(([\d.]+)\)/.exec((() => { const s = document.querySelector("[data-stage-transform]"); const a = s && s.getAttribute("transform"); if (a) return a; const svg = s && s.ownerSVGElement; const t = svg ? getComputedStyle(svg).transform : ""; const m = /matrix\(([\d.eE+-]+), 0, 0, ([\d.eE+-]+), ([\d.eE+-]+), ([\d.eE+-]+)\)/.exec(t); return m ? "translate(" + m[3] + ", " + m[4] + ") scale(" + m[1] + ")" : null; })());
    return { left: box.left, top: box.top, panX: parseFloat(m[1]), panY: parseFloat(m[2]), zoom: parseFloat(m[3]) };
  });
const at = (v, wx, wy) => ({ x: v.left + v.panX + wx * v.zoom, y: v.top + v.panY + wy * v.zoom });

// =========================================== shift+drag keeps the free axis's snap
// The FREE axis is the one the pointer is NOT asking to move, and that is the axis
// a guide is still allowed to move — the point of shift-drag is to slide a layer
// along a line until it clicks into alignment.
//
// Case 1: mostly downward, so X is locked. The drag carries the top edge to 404 and
// stops there, four px past the target's top edge at 400, so an exact 400 can only
// have come from the snap.
await applySetup([rect("mover", 40, 40, 60, 60), rect("target", 200, 400, 80, 80, "#EF4444")]);
await settle();
await page.evaluate(() => window.__FISH_BRIDGE__.selectElement("mover"));
await settle();
let v = await view();
let from = at(v, 70, 70);
let to = at(v, 70 + 164, 70 + 364);
await page.keyboard.down("Shift");
await page.mouse.move(from.x, from.y);
await page.mouse.down();
await page.mouse.move(to.x, to.y, { steps: 12 });
await page.mouse.up();
await page.keyboard.up("Shift");
await settle();
const moved = await box("mover");
check("a downward drag locks X and does not move it", moved.x, 40);
check("and the free axis snaps to a guide it did not stop on", moved.y, 400);

// Case 2: mostly rightward, so Y is locked and X is the free one.
await applySetup([rect("mover", 40, 40, 60, 60), rect("target", 200, 400, 80, 80, "#EF4444")]);
await settle();
await page.evaluate(() => window.__FISH_BRIDGE__.selectElement("mover"));
await settle();
v = await view();
from = at(v, 70, 70);
to = at(v, 70 + 164, 70 + 100); // X dominant so Y is the locked axis; left edge 40+164 = 204, four px past the guide
await page.keyboard.down("Shift");
await page.mouse.move(from.x, from.y);
await page.mouse.down();
await page.mouse.move(to.x, to.y, { steps: 12 });
await page.mouse.up();
await page.keyboard.up("Shift");
await settle();
const moved2 = await box("mover");
check("a rightward drag locks Y and does not move it", moved2.y, 40);
check("and the free axis snaps", moved2.x, 200);

// ==================================== an instance child can unlink its own style
const styles = [{ id: "ps_blue", name: "Blue", styleType: "paint", paints: [{ type: "solid", color: "#3B82F6" }] }];
await applySetup(
  [
    {
      id: "c_card", type: "component", name: "Card", x: 0, y: 0, width: 200, height: 100,
      children: [rect("bg", 0, 0, 200, 100, "#3B82F6")],
      // The binding lives on the master child, which is where a real style is set.
      ...{}
    },
    { id: "inst_1", type: "instance", name: "Card instance", componentId: "c_card", x: 400, y: 0, width: 200, height: 100 }
  ],
  styles
);
// Seed the binding explicitly (the object above is built by the helper).
await page.evaluate((sts) => {
  const b = window.__FISH_BRIDGE__;
  const d = b.getDoc();
  const els = b.getElements().map((e) =>
    e.id === "c_card"
      ? { ...e, children: e.children.map((c) => ({ ...c, fillStyleId: "ps_blue" })) }
      : e
  );
  b.setElements(els, { styles: sts });
}, styles);
await settle();

v = await view();
const inside = at(v, 500, 50);
await page.mouse.click(inside.x, inside.y);
await settle();
await page.mouse.dblclick(inside.x, inside.y);
await settle();
check("clicked into the instance's child", await page.evaluate(() => window.__FISH_BRIDGE__.getSelectedIds()), ["inst_1_bg"]);
const pillUp = () => page.evaluate(() => Boolean(Array.from(document.querySelectorAll("span")).find((s) => s.textContent.trim() === "Blue")));
check("the child shows the master's style", await pillUp(), true);
check("and is not editable yet", await page.locator("[data-paint-row]").count(), 0);

await page.locator('button[title="Detach Style"]').first().click();
await settle();
check("Detach Style unlinks it", await pillUp(), false);
check("and the colour becomes editable", await page.locator("[data-paint-row]").count(), 1);
check(
  "by writing a null override, not by deleting the field",
  await page.evaluate(() => JSON.stringify(window.__FISH_BRIDGE__.getElements().find((e) => e.id === "inst_1").overrides)),
  '[{"targetId":"bg","property":"fillStyleId","value":null}]'
);

const hex = page.locator("[data-paint-row] input").first();
await hex.fill("#FF0000");
await hex.press("Enter");
await settle();
check(
  "and a custom colour lands on the instance, not the master",
  await page.evaluate(() => {
    const d = window.__FISH_BRIDGE__.getDoc();
    return JSON.stringify(window.__FISH_BRIDGE__.getElements().find((e) => e.id === "inst_1").overrides);
  }),
  '[{"targetId":"bg","property":"fillStyleId","value":null},{"targetId":"bg","property":"fills","value":[{"type":"solid","color":"#ff0000"}]}]'
);
check(
  "while the master keeps its own",
  await page.evaluate(() => {
    const d = window.__FISH_BRIDGE__.getDoc();
    const c = window.__FISH_BRIDGE__.getElements().find((e) => e.id === "c_card");
    return c.children[0].fills[0].color;
  }),
  "#3B82F6"
);
// The header strip used to carry its own unlink cards beside this, so the same
// detach lived in two places; detaching is the card's button and the strip has none.
check("the header strip offers no second place to unlink", await page.locator("[data-instance-unlink]").count(), 0);

// ================================= the colours strip: children, and no data loss
await applySetup([
  rect("a", 0, 0, 60, 60, "#FF0000"),
  rect("b", 0, 100, 60, 60, "#FF0000"),
  rect("c", 0, 200, 60, 60, "#00FF00"),
  rect("d", 300, 0, 60, 60, "#123456"),
  rect("e", 300, 100, 60, 60, "#654321"),
  { id: "card", type: "frame", name: "card", x: 600, y: 0, width: 200, height: 200,
    children: [rect("hd", 10, 10, 100, 30, "#00FFFF"), rect("bd", 10, 60, 100, 30, "#FF00FF")] }
]);
await settle();
v = await view();
let p = at(v, 30, 30);
await page.mouse.click(p.x, p.y);
await settle();
p = at(v, 330, 30);
await page.keyboard.down("Shift");
await page.mouse.click(p.x, p.y);
await page.keyboard.up("Shift");
await settle();
p = at(v, 700, 150);
await page.keyboard.down("Shift");
await page.mouse.click(p.x, p.y);
await page.keyboard.up("Shift");
await settle();
check("selected a, d and a frame", (await page.evaluate(() => window.__FISH_BRIDGE__.getSelectedIds())).sort(), ["a", "card", "d"]);

// One row per colour, keyed on the colour: a solid row is `data-paint-row` with
// its lowercased hex. The frame's children are resolved into the strip because
// the palette walks the selection as subtrees.
const swatches = await page.locator('[data-selected-colors] [data-paint-row]').evaluateAll((ns) => ns.map((n) => n.getAttribute("data-paint-row")).sort());
check(
  "the strip resolves the colours INSIDE the selected frame",
  swatches,
  ["#00ffff", "#123456", "#ff0000", "#ff00ff"]
);

const beforeIds = await ids();
await page.locator('[data-paint-row="#ff0000"] [data-paint-swatch]').click();
await settle();
/* `[data-hex-input]` — `input[type="text"]` .first() is the alpha scrub field
   (ColorValueFields renders it above the hex), so this was filling a hex into
   alpha, watching the parse fail, and then asserting on an unchanged fill. */
/* Scoped to the OPEN panel. `data-hex-input` is not unique: the strip keeps an
   inline one per colour row (`selection-<id>`), so an unscoped `.first()` filled
   a hex into whichever row happened to be first — a different layer — and then
   asserted on the one that had been clicked. */
const hex2 = page.locator("[data-color-panel] [data-hex-input]");
await hex2.fill("#00AAFF");
await hex2.press("Enter");
await settle();
check("changing a colour leaves every other layer in the document", await ids(), beforeIds);
check(
  "and only rewrote the layers that carried it",
  await page.evaluate(() => {
    const d = window.__FISH_BRIDGE__.getDoc();
    const find = (list, id) => { for (const e of list) { if (e.id === id) return e; const h = find(e.children || [], id); if (h) return h; } return null; };
    const page = d.pages.find((p) => p.id === d.activePageId) ?? d;
    return [find(page.children, "a").fills[0].color, find(page.children, "d").fills[0].color];
  }),
  ["#00aaff", "#123456"]
);

check("no page errors", errors, []);

const failed = results.filter((r) => !r.ok).length;
await browser.close();
console.log(failed === 0 ? "\nAll checks passed" : `\n${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
