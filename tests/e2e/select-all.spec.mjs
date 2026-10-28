import { chromium } from "playwright";
import { pathToFileURL } from "url";
import path from "path";

// ⌘A on the canvas, measured in the real editor.
//
// The level it takes comes from the selection: a layer inside a frame selects
// that frame's children, nothing selected selects the page roots. What it never
// takes is a layer a click could not have landed on — a hidden one, a locked one,
// or the children of a hidden frame, which paints nothing at all — and it takes
// nothing while an inner mode is holding the canvas: the text editor selects its
// own characters, and vector edit is about its own anchors.
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

const rect = (id, x, y, w, h, extra = {}) => ({
  id,
  type: "rect",
  name: id,
  x,
  y,
  width: w,
  height: h,
  fills: [{ type: "solid", color: "#3B82F6" }],
  ...extra
});

const text = (id, x, y, content) => ({
  id,
  type: "text",
  name: id,
  x,
  y,
  width: 240,
  height: 40,
  content,
  style: { fontFamily: "Inter", fontSize: 20, color: "#111827" }
});

const applySetup = (elements) =>
  page.evaluate((els) => {
    const bridge = window.__FISH_BRIDGE__;
    const base = bridge.getDoc();
    bridge.setElements(JSON.parse(JSON.stringify(els)), { canvas: { ...base.canvas, width: 4000, height: 3000 } });
  }, elements);

const selected = () => page.evaluate(() => window.__FISH_BRIDGE__.getSelectedIds());
const select = async (id) => {
  await page.evaluate((elId) => window.__FISH_BRIDGE__.selectElement(elId), id);
  await page.waitForTimeout(120);
};
const press = async (key) => {
  await page.keyboard.press(key);
  await page.waitForTimeout(150);
};
const centreOf = (selector) =>
  page.evaluate((s) => {
    const n = document.querySelector(s);
    if (!n) return null;
    const b = n.getBoundingClientRect();
    return { cx: b.x + b.width / 2, cy: b.y + b.height / 2 };
  }, selector);

const DOC = [
  rect("a", 300, 300, 120, 80),
  rect("b", 600, 300, 120, 80),
  rect("hidden", 900, 300, 80, 80, { visible: false }),
  rect("locked", 1100, 300, 80, 80, { locked: true }),
  {
    id: "card",
    type: "frame",
    name: "Card",
    x: 300,
    y: 600,
    width: 320,
    height: 240,
    fills: [{ type: "solid", color: "#E5E7EB" }],
    children: [
      rect("card_child", 20, 20, 80, 40),
      rect("card_child2", 120, 20, 80, 40),
      rect("card_hidden", 20, 100, 80, 40, { visible: false }),
      rect("card_locked", 120, 100, 80, 40, { locked: true })
    ]
  },
  {
    id: "ghost",
    type: "frame",
    name: "Ghost",
    x: 1400,
    y: 600,
    width: 200,
    height: 200,
    visible: false,
    children: [rect("ghost_child", 20, 20, 80, 40)]
  }
];

// ----------------------------------------------------------- nothing selected
await applySetup(DOC);
await press("Escape");
check("the canvas starts with nothing selected", await selected(), []);
await press("Meta+A");
check("⌘A takes the page roots, in document order", await selected(), ["a", "b", "card"]);
check("a hidden layer is not taken", (await selected()).includes("hidden"), false);
check("a locked layer is not taken", (await selected()).includes("locked"), false);
check("a hidden frame is not taken", (await selected()).includes("ghost"), false);
check("a frame's child is not taken with its frame", (await selected()).includes("card_child"), false);

// The selection is real, not a list of ids: the overlay is up for the whole set.
check("the selection overlay is drawn for the whole set", await page.locator("[data-selection-overlay]").count(), 1);

// ------------------------------------------- the level the selection sits on
// Drilled into the frame the way a user gets there — a double click on the
// child — rather than by hand-setting the selection, because the level ⌘A takes
// is read from that selection.
const child = await centreOf('[data-element-id="card_child"]');
await page.mouse.dblclick(child.cx, child.cy);
await page.waitForTimeout(220);
check("a double click drilled into the frame's child", await selected(), ["card_child"]);
await press("Meta+A");
check("⌘A takes that child's own level", await selected(), ["card_child", "card_child2"]);
check("a hidden sibling is not taken", (await selected()).includes("card_hidden"), false);
check("a locked sibling is not taken", (await selected()).includes("card_locked"), false);
await press("Meta+A");
check("and pressing it again stays on that level", await selected(), ["card_child", "card_child2"]);

// Escape walks out one level at a time — the container, then the page root.
await press("Escape");
check("escape selects the parent container", await selected(), ["card"]);
await press("Escape");
check("escape clears at the page root", await selected(), []);

// A frame that paints nothing has no level to offer: its children are not on
// screen either, so ⌘A leaves the selection where it was rather than replacing it
// with layers that are not there.
await select("ghost_child");
await press("Meta+A");
check("a hidden frame's child has no level to take", await selected(), ["ghost_child"]);

// A page with nothing selectable at all is the same statement.
await applySetup([rect("hidden", 300, 300, 80, 80, { visible: false }), rect("locked", 500, 300, 80, 80, { locked: true })]);
await select("locked");
await press("Meta+A");
check("with nothing selectable it leaves the selection alone", await selected(), ["locked"]);

// A layer an instance projects is painted but stores no parent, so there is no
// stored level behind it and the page roots are the level that always exists.
await applySetup([
  rect("a", 300, 300, 120, 80),
  {
    id: "comp1",
    type: "component",
    name: "Chip",
    x: 300,
    y: 600,
    width: 200,
    height: 80,
    children: [rect("comp1_label", 20, 20, 120, 40)]
  },
  { id: "inst1", type: "instance", name: "Chip", componentId: "comp1", x: 700, y: 600, width: 200, height: 80 }
]);
await page.waitForTimeout(250);
await select("inst1_comp1_label");
await press("Meta+A");
check("a projected clone falls back to the page roots", await selected(), ["a", "comp1", "inst1"]);

// ------------------------------------------------- the in-canvas text editor wins
await applySetup([text("label", 300, 300, "Hello there"), rect("a", 700, 300, 120, 80)]);
const box = await centreOf('[data-element-id="label"]');
await page.mouse.dblclick(box.cx, box.cy);
await page.waitForTimeout(250);
check("double click opened the text editor", await page.locator('[contenteditable="true"]').count(), 1);
await press("Meta+A");
check("⌘A in the editor does not select the canvas", await selected(), ["label"]);
check("and the editor is still open on it", await page.locator('[contenteditable="true"]').count(), 1);
const nativeSelection = await page.evaluate(() => {
  const sel = window.getSelection();
  const editor = document.querySelector('[contenteditable="true"]');
  return !!sel && sel.rangeCount > 0 && !!editor && editor.contains(sel.getRangeAt(0).startContainer);
});
check("the browser's own select-all went to the text", nativeSelection, true);

// ------------------------------------------------------ vector edit owns the keys
await applySetup([
  { id: "top_path", type: "path", name: "Path", x: 300, y: 300, width: 220, height: 130, d: "M 0 0 L 220 0 L 220 130", strokes: [{ color: "#111827", width: 2 }] },
  rect("a", 700, 300, 120, 80)
]);
await select("top_path");
await press("Enter");
check("enter opened the vector editor", await page.locator("[data-path-edit]").count(), 1);
await press("Meta+A");
check("⌘A while editing a path leaves the page selection alone", await selected(), ["top_path"]);
check("and the vector editor is still open", await page.locator("[data-path-edit]").count(), 1);

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : `  -> ${JSON.stringify(r.actual)} (expected ${JSON.stringify(r.expected)})`}`);
}
console.log(`\n${results.length - failed.length}/${results.length} passed`);
console.log("pageErrors", errors.slice(0, 5));

await browser.close();
process.exit(failed.length === 0 && errors.length === 0 ? 0 : 1);
