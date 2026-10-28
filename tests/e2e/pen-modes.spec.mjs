import { chromium } from "playwright";
import { pathToFileURL } from "url";
import path from "node:path";

// The pen's add / remove modes, measured in the real editor.
//
// `P` picks the pen up in draw mode and walks draw -> add -> remove while it is
// already up. In add and remove the pointer RESOLVES a path rather than requiring
// one to be selected first, so the assertions hover over a shape that is not
// selected and check the document changed.
const html = path.resolve(process.cwd(), process.argv[2] ?? "dist/index.html");

/** Three anchors, so "remove" has something left to remove twice. */
const D = "M 0 0 L 120 0 L 120 90";

const ELEMENTS = [
  { id: "shape", type: "path", name: "Shape", x: 300, y: 300, width: 120, height: 90, d: D, strokes: [{ color: "#FFFFFF", width: 2 }] },
  { id: "far", type: "path", name: "Far", x: 800, y: 500, width: 120, height: 90, d: D, strokes: [{ color: "#FFFFFF", width: 2 }] }
];

const results = [];
const check = (name, ok, detail = "") => {
  results.push(!!ok);
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
  bridge.setElements(JSON.parse(JSON.stringify(elements)), { canvas: { ...base.canvas, width: 2000, height: 1400 } });
}, ELEMENTS);
await page.waitForTimeout(700);

const readDoc = () =>
  page.evaluate(() => window.__FISH_BRIDGE__.getDoc().pages.find((p) => p.id === window.__FISH_BRIDGE__.getDoc().activePageId).children);
const dOf = (id) => page.evaluate((i) => window.__FISH_BRIDGE__.getDoc().pages.find((p) => p.id === window.__FISH_BRIDGE__.getDoc().activePageId).children.find((e) => e.id === i).d, id);
const boxOf = (sel) =>
  page.evaluate((s) => {
    const n = document.querySelector(s);
    if (!n) return null;
    const b = n.getBoundingClientRect();
    return { cx: b.x + b.width / 2, cy: b.y + b.height / 2, x: b.x, y: b.y, w: b.width, h: b.height };
  }, sel);

/**
 * Which mode is live.
 *
 * Read from the canvas overlay, not the inspector: the mode buttons only exist
 * while a path is open for editing, and this spec drives the pen TOOL for half of
 * its checks, where there is no section to read.
 */
const penModeLabel = () =>
  page.evaluate(() => {
    const n = document.querySelector("[data-pen-mode]");
    return n ? n.getAttribute("data-pen-mode") : "no pen overlay";
  });
/** Same question asked of the inspector, for when the pen tool is not up.
 *
 * Read as a COMPUTED fill, not as a class name. The highlight's token was
 * renamed twice (`bg-surfaceBorder` → `bg-brand-wash` → `bg-field-active`) and
 * the class-string probe went stale the first time, reporting "none
 * highlighted" for a button that was plainly lit. A segment either paints a
 * background or it does not — that is the whole of what this asks. */
const penModeFromPanel = () =>
  page.evaluate(() => {
    const btns = [...document.querySelectorAll('button[title^="Pen —"]')];
    if (btns.length !== 3) return `expected 3 mode buttons, saw ${btns.length}`;
    const active = btns.find((b) => {
      const bg = getComputedStyle(b).backgroundColor;
      return bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent";
    });
    return active ? active.getAttribute("title") : "none highlighted";
  });

// Selecting a path is what puts the Vector section in the inspector, which is
// where the assertions read the mode from. The mode buttons themselves only exist
// while the path is open for EDITING, so the first check is that a merely selected
// path shows none of them.
const modeButtons = () => page.evaluate(() => document.querySelectorAll('button[title^="Pen —"]').length);

await page.evaluate(() => window.__FISH_BRIDGE__.selectElement("shape"));
await page.waitForTimeout(300);
check("a selected-but-unedited path shows no pen mode buttons", (await modeButtons()) === 0, String(await modeButtons()));

await page.evaluate(() => window.__FISH_BRIDGE__.selectElement("shape"));
await page.waitForTimeout(150);
await page.keyboard.press("Enter");
await page.waitForTimeout(400);
check("entering edit mode reveals them", (await modeButtons()) === 3, String(await modeButtons()));

// The mode buttons live in the Vector section, so they only exist while a path is
// open for editing. The pen TOOL's own P cycle works from a normal tool state, so
// the two halves of this spec are deliberately done in different modes.
const clickMode = async (title) => {
  const box = await page.evaluate((t) => {
    const n = document.querySelector(`button[title="${t}"]`);
    if (!n) return null;
    const r = n.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, title);
  if (!box) return false;
  await page.mouse.click(box.x, box.y);
  await page.waitForTimeout(250);
  return true;
};

// Each button has to land on ITSELF. A control wired to a blind cycle sends the
// click for "add" to whatever comes next, which from "add" is "remove" — the
// button looks inert because the highlight slides off it.
check("clicking Add selects Add", (await clickMode("Pen — add a point to an existing path")) && (await penModeFromPanel()) === "Pen — add a point to an existing path", await penModeFromPanel());
check("clicking Add again stays on Add", (await clickMode("Pen — add a point to an existing path")) && (await penModeFromPanel()) === "Pen — add a point to an existing path", await penModeFromPanel());
check("clicking Remove selects Remove", (await clickMode("Pen — remove a point from an existing path")) && (await penModeFromPanel()) === "Pen — remove a point from an existing path", await penModeFromPanel());
check("clicking Draw selects Draw", (await clickMode("Pen — draw a new path")) && (await penModeFromPanel()) === "Pen — draw a new path", await penModeFromPanel());

await page.keyboard.press("Escape");
await page.waitForTimeout(300);
check("leaving edit mode takes the buttons away again", (await modeButtons()) === 0, String(await modeButtons()));

// ---- 2. P picks the pen up in draw mode, and cycles from there --------------
await page.keyboard.press("p");
await page.waitForTimeout(250);
check("P picks the pen up in draw mode", (await penModeLabel()) === "draw", await penModeLabel());

await page.keyboard.press("p");
await page.waitForTimeout(250);
check("pressing P again advances to add", (await penModeLabel()) === "add", await penModeLabel());

// ---- 3. add: clicking the outline inserts an anchor ------------------------
const shapeBox = await boxOf('[data-element-id="shape"]');
const dBeforeAdd = await dOf("shape");
if (shapeBox) {
  // Halfway along the top edge, which runs from (0, 0) to (120, 0) in local
  // space — so the vertical middle of the element's box, its horizontal quarter.
  await page.mouse.move(shapeBox.cx - shapeBox.w / 4, shapeBox.y + 2);
  await page.waitForTimeout(200);
  await page.mouse.click(shapeBox.cx - shapeBox.w / 4, shapeBox.y + 2);
  await page.waitForTimeout(400);
  const dAfterAdd = await dOf("shape");
  check("add inserts a point on the path under the cursor", dAfterAdd !== dBeforeAdd, `${dBeforeAdd}\n      ${dAfterAdd}`);
} else {
  check("add inserts a point on the path under the cursor", false, "shape not found");
}

// ---- 4. remove: clicking an anchor drops it -------------------------------
await page.keyboard.press("p");
await page.waitForTimeout(250);
check("the pen advances to remove", (await penModeLabel()) === "remove", await penModeLabel());

const anchorBox = await boxOf("[data-pen-anchor-index='1']");
const dBeforeRemove = await dOf("shape");
check("remove mode shows the path's anchors", !!anchorBox, JSON.stringify(anchorBox));
if (anchorBox) {
  await page.mouse.click(anchorBox.cx, anchorBox.cy);
  await page.waitForTimeout(400);
  const dAfterRemove = await dOf("shape");
  check("remove drops the anchor under the cursor", dAfterRemove !== dBeforeRemove, `${dBeforeRemove}\n      ${dAfterRemove}`);
} else {
  check("remove drops the anchor under the cursor", false, "no anchor to click");
}

// ---- 5. the other path is untouched: the mode resolved a path, not a layer ---
const farD = await dOf("far");
check("the unedited path is left alone", farD === D, farD);

// ---- 6. the cycle closes ----------------------------------------------------
await page.keyboard.press("p");
await page.waitForTimeout(250);
check("the cycle returns to draw", (await penModeLabel()) === "draw", await penModeLabel());

check("no console errors", errors.length === 0, errors.slice(0, 3).join(" | "));

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
await browser.close();
process.exit(passed === results.length ? 0 : 1);
