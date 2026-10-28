import { chromium } from "playwright";
import { pathToFileURL } from "url";
import path from "path";

/**
 * The Scale tool and the Selection-colors strip.
 *
 * Both are checked through what they leave in the document, because both are only
 * observable in the state they write: a swatch that exists but rewrites nothing,
 * or a scale field that reads 2x and leaves the box alone, look identical to ones
 * that work until you read the document afterwards.
 */
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

const settle = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
const rect = (id, x, y, color) => ({
  id,
  type: "rect",
  name: id,
  x,
  y,
  width: 100,
  height: 60,
  fills: [{ type: "solid", color }]
});

const applySetup = (elements) =>
  page.evaluate((els) => {
    const b = window.__FISH_BRIDGE__;
    const base = b.getDoc();
    b.setElements(els, { canvas: { ...base.canvas, width: 4000, height: 3000 } });
  }, elements);

const view = async () =>
  page.evaluate(() => {
    const svg = document.querySelector("svg.pointer-events-auto");
    const box = svg.parentElement.getBoundingClientRect();
    const m = /translate\((-?[\d.]+), (-?[\d.]+)\) scale\(([\d.]+)\)/.exec((() => { const s = document.querySelector("[data-stage-transform]"); const a = s && s.getAttribute("transform"); if (a) return a; const svg = s && s.ownerSVGElement; const t = svg ? getComputedStyle(svg).transform : ""; const m = /matrix\(([\d.eE+-]+), 0, 0, ([\d.eE+-]+), ([\d.eE+-]+), ([\d.eE+-]+)\)/.exec(t); return m ? "translate(" + m[3] + ", " + m[4] + ") scale(" + m[1] + ")" : null; })());
    return { left: box.left, top: box.top, panX: parseFloat(m[1]), panY: parseFloat(m[2]), zoom: parseFloat(m[3]) };
  });
const at = (v, wx, wy) => ({ x: v.left + v.panX + wx * v.zoom, y: v.top + v.panY + wy * v.zoom });
const pan = () =>
  page.evaluate(() => (() => { const s = document.querySelector("[data-stage-transform]"); const a = s && s.getAttribute("transform"); if (a) return a; const svg = s && s.ownerSVGElement; const t = svg ? getComputedStyle(svg).transform : ""; const m = /matrix\(([\d.eE+-]+), 0, 0, ([\d.eE+-]+), ([\d.eE+-]+), ([\d.eE+-]+)\)/.exec(t); return m ? "translate(" + m[3] + ", " + m[4] + ") scale(" + m[1] + ")" : null; })());

// ================================================================= the Scale tool
await applySetup([
  {
    id: "pad",
    type: "frame",
    name: "pad",
    x: 100,
    y: 100,
    width: 200,
    height: 100,
    borderRadius: 10,
    strokes: [{ color: "#000000", width: 2 }],
    display: "flex",
    "flex-direction": "column",
    gap: 8,
    padding: 12,
    children: [rect("inner", 12, 12, "#FFFFFF")]
  }
]);
await settle();
await page.evaluate(() => window.__FISH_BRIDGE__.selectElement("pad"));
await settle();

// Scale is one of three answers to "how do I move this", so it lives in the
// Move/Hand group rather than beside it. The check that matters is that the group
// is ONE group with three entries, not a button that happens to be nearby.
const openNavMenu = async () => {
  await page.locator("[data-nav-caret]").click();
  await settle();
};
await openNavMenu();
check("Scale sits in the Move/Hand group", await page.locator("[data-nav-menu] [data-scale-tool]").count(), 1);
check("as one of three entries, with Move and Hand", await page.locator("[data-nav-menu] button").count(), 3);
await openNavMenu();
await settle();

await page.evaluate(() => {
  document.body.click();
  return true;
});
await page.keyboard.press("k");
await settle();
check("the scale parameters appear in the inspector", await page.locator("[data-scale-section]").count(), 1);
check("W and H are offered", await page.locator('[data-scale-section] [data-scrub-field="W"]').count(), 1);
check("the factor field is there", await page.locator("[data-scale-factor-menu]").count(), 1);
check("the anchor grid is there", await page.locator("[data-scale-anchor]").count(), 1);
check("with nine anchor points", await page.locator("[data-scale-anchor] [data-scale-anchor-option]").count(), 9);
check(
  "centred by default, the way Figma does",
  await page.locator('[data-scale-anchor-option="0.5,0.5"]').getAttribute("aria-checked"),
  "true"
);

const readPad = () =>
  page.evaluate(() => {
    const f = window.__FISH_BRIDGE__.getElements().find((e) => e.id === "pad");
    const child = f.children[0];
    return {
      x: f.x, y: f.y, w: f.width, h: f.height, r: f.borderRadius,
      stroke: f.strokes?.[0]?.width, gap: f.gap, padding: f.padding,
      cx: child.x, cw: child.width
    };
  });

// 2x through the factor field, from the document's own starting size.
await page.locator('[data-scale-factor-menu="true"]').click();
await settle();
await page.locator('[data-scale-preset-option="2"]').click();
await settle();
const doubled = await readPad();
check("the box doubled", [doubled.w, doubled.h], [400, 200]);
check("and stayed centred on its anchor", [doubled.x, doubled.y], [0, 50]);
check("the corner radius scaled — a scale, not a resize", doubled.r, 20);
check("the stroke width scaled too", doubled.stroke, 4);
check("the auto-layout gap and padding scaled", [doubled.gap, doubled.padding], [16, 24]);
// The frame is a flex column, which stretches its child across the content box:
// the child's width is the frame's content width (400 − 2×24 padding), not its
// authored box doubled. The local position is the padding, doubled like
// everything else.
check("and the child's box and local position", [doubled.cw, doubled.cx], [352, 24]);

// A top-left anchor then keeps the corner and grows right/down.
await page.locator('[data-scale-anchor-option="0,0"]').click();
await settle();
await page.locator('[data-scale-factor-menu="true"]').click();
await settle();
await page.locator('[data-scale-preset-option="1"]').click();
await settle();
const fromCorner = await readPad();
check("a top-left anchor pins the corner", [fromCorner.x, fromCorner.y], [0, 50]);
check("and shrinks into it", [fromCorner.w, fromCorner.h], [200, 100]);

// The W field is the same edit expressed as a size.
await page.locator('[data-scale-section] [data-scrub-field="W"]').fill("300");
await page.locator('[data-scale-section] [data-scrub-field="W"]').press("Enter");
await settle();
const typed = await readPad();
// 300 from a 200x100 reference is 1.5x, so the height follows and the 10px radius
// and 2px stroke scale with it. A W that left the height alone would be a resize.
check("typing a width scales both axes", [typed.w, typed.h], [300, 150]);
check("and the properties came with it", [typed.r, typed.stroke], [15, 3]);

// The factor must still read against the size the tool was ENTERED with, not the
// size the last edit produced. This is the regression that a rebuild-every-render
// `selectedElements` dependency caused: the reference was recaptured after every
// commit, so "1x" could never mean "as you found it" and the field read 1x over a
// box that was 2x.
const factorNow = await page.locator("[data-scale-factor] input").inputValue();
check("the factor is measured from the tool's entry size, not the last edit", Number(factorNow), 1.5);

// Shrinking and growing back has to land on the design it started from. It used to
// land on a square-cornered one, and a visibly stretched one: the box had a 1px floor
// so a layer could never become unclickable, and that floor was a permanent edit to the
// document rather than a display guard — 3x5 came back as 10x16.7, and a 27.6px frame
// measured back at 28 by the layout pass came back at 280, wider than its parent.
//
// The W field is absolute against the reference the tool was entered with, so this is
// a real round trip: ask for 1px of 200, then type 200 back.
const scaleW = async (v) => {
  await page.locator('[data-scale-section] [data-scrub-field="W"]').fill(String(v));
  await page.locator('[data-scale-section] [data-scrub-field="W"]').press("Enter");
  await settle();
};
await scaleW(1);
const floored = await readPad();
// 1 of 200 is a factor of 0.005, and the floor now sits a hundredth of a pixel away
// rather than a whole one, so the request is honoured: 200x100 lands on 1x0.5 and
// keeps its 2:1 either way. The radius follows the shorter side, which is the one that
// really is shorter.
check("asked for 1px of 200, the box takes the request instead of stopping at a whole pixel", [floored.w, floored.h], [1, 0.5]);
check("and the radius is scaled with the box, not left behind on it", floored.r, 0.05);
await scaleW(200);
const back = await readPad();
check("typing the original width back restores the box", [back.w, back.h], [200, 100]);
check("with the corner still rounded", back.r, 10);
check("and the stroke with it", back.stroke, 2);

// The switch, the shortcut and the panel's X are ONE control, and the tool is a
// MODE read back out of the active tool — a button that set `activeTool` directly
// used to leave the panel showing the previous tool's state, and `toggle` was closed
// over a stale `active` by the global shortcut listener, so K could only ever turn it on.
//
// The panel is the probe for "is Scale on". The dock group is not: it now holds all
// three of Move, Hand and Scale, so it is lit for the tool Scale leaves behind too.
const sectionUp = () => page.locator("[data-scale-section]").count();
// The armed tool wears `bg-brand` — the token that means "armed" since the
// palette refactor. This probe used to look for `bg-blue-600`, the stock blue it
// wore before, so it reported the tool unlit while the tool was lit.
const groupLit = () => page.locator("[data-nav-tool]").evaluate((n) => n.className.includes("bg-brand"));
// The Scale cursor is a custom SVG data URI, so the probe is an inline `cursor`
// carrying a data URI — a keyword could not stretch the diagonal arrow that tells a
// scale from a resize. It lives on the CORNER handles, not the canvas: the arrow has
// to point along the corner under it, so there is no single canvas-wide one, and
// painting one across the whole canvas would promise a scale everywhere the user can
// only drag a handle.
//
// The direction is read out of the drawing, not the label. An earlier probe only
// asked whether the mirror transform was present, which proved the two variants
// differed and nothing more — it passed happily while the shaft sat on the opposite
// diagonal from the name. So: decode the data URI and read the shaft, which runs
// corner to corner and so fixes the diagonal on its own, with no argument about which
// of the two arrowheads is the "real" one. Its start point, reflected about x=16 when
// the mirror is present, is the direction the arrow ends up pointing.
const cornerOrientation = (handle) =>
  page.locator(`[data-resize-handle="${handle}"]`).evaluate((n) => {
    const c = n.style.cursor || "";
    const payload = c.match(/^url\("data:image\/svg\+xml,([^"]+)"\)/)?.[1];
    if (!payload) return c;
    const svg = decodeURIComponent(payload);
    const start = svg.match(/d="M (\d+(?:\.\d+)?) /)?.[1];
    if (!start) return "no-shaft";
    const x = Number(start);
    return (svg.includes("scale(-1") ? 32 - x : x) < 16 ? "nwse" : "nesw";
  });
const corners = ["tl", "tr", "br", "bl"];
const canvasCursor = () =>
  page.evaluate(() => document.querySelector('[data-canvas-root="true"]')?.style.cursor || "");

await page.keyboard.press("k");
await settle();
check("K turns the tool off", await sectionUp(), 0);
await page.keyboard.press("k");
await settle();
check("K brings both back", [(await sectionUp()), (await groupLit())], [1, true]);
await page.locator("[data-scale-close]").click();
await settle();
check("the panel's X turns the tool off too", await sectionUp(), 0);

// ==================================================================== it is a MODE
//
// A mode is temporary: it is entered, it is worked in, and something ends it. Two
// things have to agree when it ends — the tool AND the panel, because a panel left
// standing over a tool that is off is a set of fields that rewrite nothing.
await page.keyboard.press("k");
await settle();
check("back on for the mode checks", await sectionUp(), 1);
check("and the dock's Move slot is showing the Scale icon, not an arrow", await page.locator("[data-nav-tool]").getAttribute("data-nav-icon"), "scale");
check("with each corner offering the big arrow, pointing along its own diagonal", await Promise.all(corners.map(cornerOrientation)), ["nwse", "nesw", "nwse", "nesw"]);
check("and the canvas itself left alone, since only a handle can be scaled from", await canvasCursor(), "");
await page.keyboard.press("Enter");
await settle();
check("Enter leaves the tool", await sectionUp(), 0);
check("with no scale fields left behind", await page.locator('[data-scale-section] [data-scrub-field="W"]').count(), 0);
check("and Move has it, since that is where the tool returns to", await groupLit(), true);
check("so the slot is showing the arrow again", await page.locator("[data-nav-tool]").getAttribute("data-nav-icon"), "select");
check("and the corners are back to plain keywords", await cornerOrientation("tl"), "nwse-resize");

// Clicking the slot while Scale is on is a way OUT, the same as the panel's X: the
// icon on the button is the tool that is armed, so pressing it arms the other one.
await page.keyboard.press("k");
await settle();
await page.locator("[data-nav-tool]").click();
await settle();
check("clicking the lit Scale slot leaves the tool", await sectionUp(), 0);
check("and hands the slot back to Move", await page.locator("[data-nav-tool]").getAttribute("data-nav-icon"), "select");

// Picking ANY other tool ends it. The old switch kept its own copy of "am I on",
// so a dock button that set the active tool left the tool off and the panel on.
await page.keyboard.press("k");
await settle();
await openNavMenu();
await page.locator('[data-nav-menu] button[data-nav-item="hand"]').click();
await settle();
check("picking another tool leaves Scale", await sectionUp(), 0);
// On `data-nav-icon`, not on the title: 6bd37e1 moved the shortcut out of the
// slot's tooltip and into the dropdown row as its own chip, so the tooltip is
// now the bare "Hand tool". The icon is what names which of the three answers
// is armed, and it cannot drift with a label.
check("and that tool really is the active one", await page.locator("[data-nav-tool]").getAttribute("data-nav-icon"), "hand");
await page.keyboard.press("k");
await settle();
check("and Scale can be entered again from it", await sectionUp(), 1);
await page.keyboard.press("v");
await settle();
check("a shortcut tool leaves it too", await sectionUp(), 0);

// Space and the middle button are the two gestures that must NOT end it: they pan
// without ever changing the active tool, so a user who pans to look at something
// comes back to a live Scale tool rather than to a mode that quietly closed.
const dragOnEmptyCanvas = async (button) => {
  const v2 = await view();
  const from = at(v2, 600, 600);
  const to = at(v2, 660, 640);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down({ button });
  await page.mouse.move(to.x, to.y, { steps: 4 });
  await page.mouse.up({ button });
};

await page.keyboard.press("k");
await settle();
await page.keyboard.down("Space");
await dragOnEmptyCanvas("left");
await page.keyboard.up("Space");
await settle();
check("a space-pan keeps the tool on", await sectionUp(), 1);
await dragOnEmptyCanvas("middle");
await settle();
check("a middle-button pan keeps it on too", await sectionUp(), 1);
await page.keyboard.press("Enter");
await settle();
check("Enter still ends it", await sectionUp(), 0);

// With nothing selected the panel must say so rather than vanish, or turning the
// tool on looks like it did nothing.
await page.evaluate(() => window.__FISH_BRIDGE__.selectElement("pad"));
await settle();
await page.keyboard.press("Escape");
await settle();
await page.keyboard.press("k");
await settle();
check("the tool is on with an empty selection", await sectionUp(), 1);
check("and the panel explains why it cannot scale anything", await page.locator("[data-scale-empty]").count(), 1);
await page.keyboard.press("k");
await settle();
check("and it toggles back off", await sectionUp(), 0);

// ======================================================= the Selection-colors strip
await applySetup([
  rect("a", 0, 0, "#FF0000"),
  rect("b", 0, 100, "#FF0000"),
  rect("c", 0, 200, "#00FF00"),
  rect("far", 900, 0, "#FF0000")
]);
await settle();
await page.evaluate(() => window.__FISH_BRIDGE__.selectElement("a"));
await settle();
check("one layer selected: no strip, the Fill section already shows its colours", await page.locator("[data-selected-colors]").count(), 0);

let v = await view();
for (const [wx, wy] of [[50, 130], [50, 230]]) {
  const p = at(v, wx, wy);
  await page.keyboard.down("Shift");
  await page.mouse.click(p.x, p.y);
  await page.keyboard.up("Shift");
  await settle();
}
check("a multi-selection gets the strip", await page.locator("[data-selected-colors]").count(), 1);

// Below Effects, one row per colour.
const sectionOrder = await page.evaluate(() => {
  const panel = document.querySelector('[data-ui-panel="right"]');
  const labels = Array.from(panel.querySelectorAll("span")).map((n) => n.textContent.trim());
  return { colors: labels.indexOf("Selection colors"), effects: labels.findIndex((l) => /effects/i.test(l)) };
});
check("it sits below Effects", sectionOrder.colors > sectionOrder.effects, true);
// One row per colour, keyed on the colour: a solid row is `data-paint-row` with
// its lowercased hex, the way `collectSelectedColors` normalises it.
check("one row per colour", await page.locator('[data-selected-colors] [data-paint-row]').count(), 2);

// Hovering must NOT move the canvas any more: the reveal is a button, not a pan.
const beforePan = await pan();
await page.locator('[data-paint-row="#ff0000"]').hover();
await page.waitForTimeout(150);
check("hovering a swatch leaves the canvas where it was", await pan(), beforePan);
check("and reveals the select button", await page.locator("[data-select-by-color]").count(), 2);

await page.locator('[data-selected-colors] [data-select-by-color]').first().click();
await settle();
const picked = await page.evaluate(() => window.__FISH_BRIDGE__.getSelectedIds().sort());
check("it selects every layer with that colour, replacing what was selected", picked, ["a", "b"]);

// ======================================================== a gradient is editable too
//
// A gradient row used to be a swatch that looked like the solid one beside it and
// refused the click. The check that matters is the DOCUMENT: if the swatch opens
// something decorative, the stops never change and the test still looks fine.
const ramp = (from, to) => ({
  type: "linear-gradient",
  from,
  to,
  angle: 90,
  stops: [
    { color: from, offset: 0 },
    { color: to, offset: 1 }
  ]
});
await applySetup([
  { ...rect("g1", 0, 0, "#FF0000"), fills: [ramp("#FF0000", "#0000FF")] },
  { ...rect("g2", 0, 100, "#FF0000"), fills: [ramp("#FF0000", "#0000FF")] },
  rect("h1", 400, 0, "#00FF00")
]);
await settle();
await page.evaluate(() => {
  const b = window.__FISH_BRIDGE__;
  b.selectElement("g1");
});
await settle();
let vv = await view();
for (const [wx, wy] of [[50, 130], [450, 30]]) {
  const p = at(vv, wx, wy);
  await page.keyboard.down("Shift");
  await page.mouse.click(p.x, p.y);
  await page.keyboard.up("Shift");
  await settle();
}
check("a gradient gets a row of its own", await page.locator('[data-paint-row="gradient"]').count(), 1);
check("and the solid beside it is still there", await page.locator('[data-paint-row="#00ff00"]').count(), 1);

const readStops = () =>
  page.evaluate(() => {
    const els = window.__FISH_BRIDGE__.getElements();
    return [els.find((e) => e.id === "g1").fills[0].stops, els.find((e) => e.id === "g2").fills[0].stops].map(
      (s) => s.map((x) => x.color.toLowerCase()).join("→")
    );
  });

await page.locator('[data-paint-row="gradient"] [data-paint-swatch]').click();
await settle();
check("the swatch opens the paint editor", await page.locator("[data-color-panel]").count(), 1);
check("with the gradient's own stop bar", await page.locator("[data-gradient-bar]").count(), 1);
// The strip's editor can now switch between the tabs that HAVE a colour, because
// a row is keyed on the layer it found and so survives the conversion. An image
// fill is deliberately absent: it has no colour of its own, so it is not one of
// this strip's entries and cannot be listed back to the user.
//
// The gradient dialects are ONE tab with a sub-choice, so they are the row below
// it and not tabs of their own. tests/e2e/color-panel-gradient-tabs.spec.mjs is
// where that sub-row is driven; here it only has to be the row that is shown.
check(
  "it offers the tabs that have a colour",
  await page.evaluate(() =>
    [...document.querySelectorAll("[data-paint-tab]")].map((n) => n.getAttribute("data-paint-tab"))
  ),
  ["solid", "gradient"]
);
check(
  "and no image fill, which this strip cannot represent",
  await page.locator('[data-paint-tab="image"]').count(),
  0
);
check(
  "the gradient dialects are the sub-row, not tabs",
  await page.evaluate(() =>
    [...document.querySelectorAll("[data-paint-kind]")].map((n) => n.getAttribute("data-paint-kind"))
  ),
  ["linear-gradient", "radial-gradient", "angular-gradient", "diamond-gradient"]
);
// Read-only on purpose: this section goes on to edit the gradient's stops, and
// switching the entry to a solid tears the stop bar out from under it. That the
// switch REACHES the document is covered in tests/selected-colors.test.ts, where
// the guard that could swallow it is the thing under test.



// Stop 1 is the selected one on open; the stop bar's handles carry their index.
await page.locator('[data-stop-index="1"]').click();
await settle();
await page.locator('[data-hex-input="1"]').fill("22AA55");
await page.locator('[data-hex-input="1"]').press("Enter");
await settle();
const restopped = await readStops();
check("the edit landed on the document", restopped[0], "#ff0000→#22aa55");
check("and on every layer that shared the gradient", restopped[1], "#ff0000→#22aa55");

// An image fill is not a colour, and this strip is a summary of the selection's
// colours: a row for one can neither be edited nor usefully located, so it only
// makes the palette harder to read. The layer's own Fill section still lists it.
await applySetup([
  { ...rect("g1", 0, 0, "#FF0000"), fills: [ramp("#FF0000", "#0000FF")] },
  rect("h1", 400, 0, "#00FF00"),
  { ...rect("im", 0, 200, "#FF0000"), fills: [{ type: "image", assetId: "a1" }] }
]);
await settle();
await page.evaluate(() => {
  const b = window.__FISH_BRIDGE__;
  b.selectElement("g1");
});
await settle();
vv = await view();
// g1 is already selected, so only the two NEW layers are shift-clicked — a shift-click
// on a selected layer removes it, which would leave a one-layer selection and no strip.
for (const [wx, wy] of [[450, 30], [50, 230]]) {
  const p = at(vv, wx, wy);
  await page.keyboard.down("Shift");
  await page.mouse.click(p.x, p.y);
  await page.keyboard.up("Shift");
  await settle();
}
check("the three layers are selected", await page.locator('[data-selected-colors] [data-paint-row]').count(), 2);
check("an image fill gets no row of its own", await page.locator('[data-paint-row="image"]').count(), 0);
check(
  "and no empty placeholder for it either",
  await page.locator("[data-selected-colors] [data-paint-row]").evaluateAll(
    (ns) => ns.filter((n) => n.getAttribute("data-paint-row") === "").length
  ),
  0
);
// Nothing is lost by leaving it out of a summary of the selection's COLOURS: the
// layer's own Fill section is where an image belongs, and it is still there.
await page.evaluate(() => window.__FISH_BRIDGE__.selectElement("im"));
await settle();
check("the image is still editable where it belongs — the Fill section", await page.locator('[data-paint-stack="fill"] [data-paint-row]').count(), 1);
check("on the right paint", await page.evaluate(
  () => window.__FISH_BRIDGE__.getElements().find((e) => e.id === "im").fills[0].assetId
), "a1");

// ================================== selecting a FRAME shows what is inside it
//
// A frame usually has no fill of its own, so the Fill section reads nothing and
// the colours of its children were nowhere in the panel while the selection was
// visibly three colours.
await applySetup([
  {
    id: "card",
    type: "frame",
    name: "card",
    x: 0,
    y: 0,
    width: 400,
    height: 300,
    children: [
      rect("head", 0, 0, "#FF0000"),
      rect("body", 0, 100, "#00FF00"),
      rect("deep", 0, 200, "#0000FF")
    ]
  }
]);
await settle();
await page.evaluate(() => window.__FISH_BRIDGE__.selectElement("card"));
await settle();
check("a frame alone gets the strip", await page.locator("[data-selected-colors]").count(), 1);
check("listing its children's colours", await page.locator('[data-selected-colors] [data-paint-row]').count(), 3);

// And the edit reaches a child, which is the whole point of showing them.
await page.locator('[data-paint-row="#00ff00"] [data-paint-swatch]').click();
await settle();
await page.locator('[data-hex-input="1"]').fill("123456");
await page.locator('[data-hex-input="1"]').press("Enter");
await settle();
check(
  "and editing one rewrites the child that has it",
  await page.evaluate(() => window.__FISH_BRIDGE__.getElements()[0].children[1].fills[0].color.toLowerCase()),
  "#123456"
);

// ================================== selecting an INSTANCE shows what is inside it
//
// An instance's children live on the master: the tree does not hand them out as
// its own, so a selected instance showed no strip at all while it was visibly
// three colours — and a colour that only those children carry had nowhere to
// land, because the palette's write walks the stored tree and never an instance.
await applySetup([
  {
    id: "chipMaster",
    type: "component",
    name: "CHIP",
    x: 0,
    y: 600,
    width: 300,
    height: 200,
    fills: [{ type: "solid", color: "#112233" }],
    children: [rect("chipHead", 0, 0, "#FF0000"), rect("chipBody", 0, 100, "#00FF00")]
  },
  {
    id: "chip",
    type: "instance",
    name: "CHIP",
    componentId: "chipMaster",
    x: 400,
    y: 600,
    width: 300,
    height: 200
  }
]);
await settle();
await page.evaluate(() => window.__FISH_BRIDGE__.selectElement("chip"));
await settle();
check("an instance alone gets the strip", await page.locator("[data-selected-colors]").count(), 1);
check(
  "listing its own box colour and its children's",
  await page.locator('[data-selected-colors] [data-paint-row]').count(),
  3
);

// The edit lands as an OVERRIDES write: nothing in the palette's path enters the
// instance, so a colour with only these ids would have been a silent no-op.
await page.locator('[data-paint-row="#ff0000"] [data-paint-swatch]').click();
await settle();
await page.locator('[data-hex-input="1"]').fill("123456");
await page.locator('[data-hex-input="1"]').press("Enter");
await settle();
check(
  "and editing it writes an override on the instance",
  await page.evaluate(() => {
    const inst = window.__FISH_BRIDGE__.getElements().find((el) => el.id === "chip");
    return (inst.overrides || []).map((o) => `${o.targetId}:${o.property}:${o.value[0].color.toLowerCase()}`);
  }),
  ["chipHead:fills:#123456"]
);
check(
  "and the master still paints what it always did",
  await page.evaluate(() => {
    const master = window.__FISH_BRIDGE__.getElements().find((el) => el.id === "chipMaster");
    return master.children[0].fills[0].color.toLowerCase();
  }),
  "#ff0000"
);

// A refused scale that is computed and then dropped is the worst failure the
// scale panel has: the number in the field moves, the box does not, and nothing
// says why. The refusal itself is unit-tested against the engine (`scale-ops`);
// what only a browser can see is that the panel SURFACES it — the number in the
// field and the box in the document must both be unchanged, and a reason must be
// on screen. Asserting the hint alone would pass against a panel that showed the
// message and scaled the layer anyway.
await applySetup([rect("locked", 0, 0, "#3E63DD")]);
await settle();
// `k` arms the Scale tool, which is what puts the scale parameters in the
// inspector at all. Clicked off the layer row first: the double-click that
// renames leaves an INPUT holding the keyboard, and `k` would be typed into it.
await page.evaluate(() => document.body.click());
await page.keyboard.press("k");
await settle();
await page.evaluate(() => window.__FISH_BRIDGE__.selectElement("locked"));
await settle();
check("the scale parameters are up", await page.locator("[data-scale-section]").count(), 1);
await page.click('[data-layer-lock="locked"]');
await settle();
const beforeRefusal = await page.evaluate(() => {
  const el = window.__FISH_BRIDGE__.getElements().find((e) => e.id === "locked");
  return [el.width, el.height];
});
await page.locator('[data-scale-section] [data-scrub-field="W"]').fill("200");
await page.locator('[data-scale-section] [data-scrub-field="W"]').press("Enter");
await settle();
check(
  "a refused scale says why",
  await page.evaluate(() => document.body.innerText.includes("A locked layer cannot be scaled")),
  true
);
check(
  "and the refusal is real: the box did not move",
  await page.evaluate(() => {
    const el = window.__FISH_BRIDGE__.getElements().find((e) => e.id === "locked");
    return [el.width, el.height];
  }),
  beforeRefusal
);

check("no page errors", errors, []);

let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  console.log(`${r.ok ? "✔" : "✖"} ${r.name}`);
  if (!r.ok) console.log(`    expected ${JSON.stringify(r.expected)}, got ${JSON.stringify(r.actual)}`);
}
await browser.close();
console.log(failed === 0 ? "\nAll checks passed" : `\n${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
