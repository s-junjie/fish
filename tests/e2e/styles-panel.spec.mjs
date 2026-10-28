import { chromium } from "playwright";
import { pathToFileURL } from "url";
import path from "node:path";

// The Local Styles panel, driven end to end:
//   1. no empty-state hint — an empty Text Styles group shows its header and "+",
//      never a "No text styles" line
//   2. rows reorder by dragging the grip, and the new order is what the document
//      stores (the regression: the list had no reorder at all)
const html = path.resolve(process.cwd(), process.argv[2] ?? "dist/index.html");

const STYLES = [
  { id: "style_paint_a", name: "Orange", styleType: "paint", paints: [{ type: "solid", color: "#FF8800" }] },
  { id: "style_text_a", name: "Body", styleType: "text", style: { fontFamily: "Inter", fontSize: 14 } },
  { id: "style_paint_b", name: "Blue", styleType: "paint", paints: [{ type: "solid", color: "#0055FF" }] }
];

const ELEMENTS = [
  {
    id: "r_stack",
    type: "rect",
    name: "Stacked",
    x: 0,
    y: 60,
    width: 200,
    height: 120,
    fills: [{ type: "solid", color: "#FFFFFF" }],
    strokes: [{ color: "#FF8800", width: 6 }]
  }
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
await page.evaluate(
  ({ styles, elements }) => {
    const bridge = window.__FISH_BRIDGE__;
    const base = bridge.getDoc();
    bridge.setElements(JSON.parse(JSON.stringify(elements)), { canvas: { ...base.canvas, width: 1920, height: 1080 }, styles: JSON.parse(JSON.stringify(styles)) });
  },
  { styles: STYLES, elements: ELEMENTS }
);
await page.waitForTimeout(600);

// The local styles live in the inspector's Design System tab, Styles inner tab —
// the suite drives the panel the way a user opens it.
await page.click('[data-testid="inspector-tab-design-system"]');
await page.waitForTimeout(150);
await page.click('[data-design-system-tabs="1"] button:has-text("Styles")');
await page.waitForTimeout(300);

const rowIds = () =>
  page.evaluate(() =>
    [...document.querySelectorAll('[data-ui-panel="right"] [data-style-row]')].map((el) =>
      el.getAttribute("data-style-row")
    )
  );
const docStyleIds = () => page.evaluate(() => (window.__FISH_BRIDGE__.getDoc().styles || []).map((s) => s.id));
const panelText = () =>
  page.evaluate(() => {
    const panel = document.querySelector('[data-ui-panel="right"]');
    return panel ? panel.innerText : "";
  });

// Tolerant hooks: an older bundle simply has no grip, which must read as a FAIL
// rather than a 30 s click timeout.
const dragHandle = async (styleId, toY) => {
  const box = await page.evaluate((id) => {
    const btn = document.querySelector(`[data-ui-panel="right"] [data-style-handle="${CSS.escape(id)}"]`);
    if (!btn) return null;
    const b = btn.getBoundingClientRect();
    return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
  }, styleId);
  if (!box) return false;
  await page.mouse.move(box.x, box.y);
  await page.mouse.down();
  await page.mouse.move(box.x, toY, { steps: 8 });
  await page.waitForTimeout(120);
  const indicator = await page.evaluate(
    () => document.querySelectorAll('[data-testid="style-drop-indicator"]').length
  );
  await page.mouse.up();
  await page.waitForTimeout(300);
  return indicator > 0;
};

// ---- 1. an empty group keeps its header, without an empty-state hint --------
// The group headers are label-tier type: `innerText` reads them back uppercased,
// so the match is case-insensitive.
const text = await panelText();
check("the Text Styles group is on screen", /text styles/i.test(text), text.split("\n").slice(0, 8).join(" | "));
check("no 'No text styles' hint", !/no text styles/i.test(text));
check("no empty-state hint for any group", !/no (color|effect) styles/i.test(text), text.replace(/\n/g, " | "));
check(
  "the text style row itself is listed",
  (await rowIds()).includes("style_text_a"),
  JSON.stringify(await rowIds())
);

// ---- 2. reordering the color style rows ------------------------------------
// The document stores styles interleaved (see STYLES above); the panel is what
// groups them by type. So a reorder inside the color group must permute only
// the paint entries *in place* — the text style keeps its exact index. These
// expectations are derived from the seed rather than hardcoded, because an
// assertion that restates the grouped display order cannot tell "reordered the
// color group" apart from "re-sorted the whole array by type".
// The panel groups by type in schema order: paint, stroke, text, effect.
const groupedOrder = ["style_paint_a", "style_paint_b", "style_text_a"];
const paintIds = STYLES.filter((s) => s.styleType === "paint").map((s) => s.id);
// `paint_b` is dragged above `paint_a`; every other paint style keeps its place.
const paintReordered = [paintIds[1], paintIds[0], ...paintIds.slice(2)];
let paintCursor = 0;
const expectedDocOrder = STYLES.map((s) =>
  s.styleType === "paint" ? paintReordered[paintCursor++] : s.id
);

check(
  "rows start grouped by type",
  JSON.stringify(await rowIds()) === JSON.stringify(groupedOrder),
  JSON.stringify(await rowIds())
);

const firstRowTop = await page.evaluate(() => {
  const el = document.querySelector('[data-ui-panel="right"] [data-style-row="style_paint_a"]');
  return el.getBoundingClientRect().top;
});
check("dragging a row shows a drop indicator", await dragHandle("style_paint_b", firstRowTop + 2));
const afterDrag = await rowIds();
check(
  "the dropped row moves above its target",
  JSON.stringify(afterDrag) === JSON.stringify(["style_paint_b", "style_paint_a", "style_text_a"]),
  JSON.stringify(afterDrag)
);

const stored = await docStyleIds();
check(
  "only the color group is reordered",
  JSON.stringify(stored) === JSON.stringify(expectedDocOrder),
  `${JSON.stringify(stored)} (expected ${JSON.stringify(expectedDocOrder)})`
);
check(
  "the text style keeps its index",
  stored.indexOf("style_text_a") === STYLES.findIndex((s) => s.id === "style_text_a"),
  `index ${stored.indexOf("style_text_a")}`
);

// ---- 2b. the row itself opens the style, as a token row does ---------------
// The editor used to hang off a hover-only pencil, which made "open this style"
// the one action a card could not do when you aimed at it. The row opens it now
// — the pencil stays as the visible hint, exactly as on a token row — and the
// grip must stay a grip: its press ends in a click, and a click there must not
// open the editor.
await page.click('[data-ui-panel="right"] [data-style-row="style_paint_a"]');
await page.waitForTimeout(400);
const openedName = await page
  .locator('[role="dialog"] input[name="style-name"]')
  .inputValue()
  .catch(() => null);
check(
  "clicking a style row opens its editor",
  openedName === "Orange",
  `style name field: ${openedName}`
);
check(
  "the hover pencil is still offered, as on a token row",
  (await page.locator('[data-ui-panel="right"] [data-style-edit]').count()) > 0
);
await page.keyboard.press("Escape");
await page.waitForTimeout(300);
await page.click('[data-ui-panel="right"] [data-style-handle="style_paint_b"]');
await page.waitForTimeout(300);
check(
  "a click on the drag grip does not open the editor",
  (await page.locator('[role="dialog"]').count()) === 0
);

// ---- 2c. a text style offers type only, no effects -------------------------
// Its properties are the fixed type rows; the plus at that header opened the
// effect menu (Drop Shadow / Inner Shadow / Layer Blur), which let a text style
// carry a shadow. Effects belong to the layer or to an effect style.
await page.click('[data-ui-panel="right"] [data-style-row="style_text_a"]');
await page.waitForTimeout(400);
const textAdd = await page.locator('[role="dialog"] [data-style-add-layer]').count();
const textEffectMenu = await page.locator('[role="dialog"] [data-effect-menu]').count();
check("a text style has no add-property plus", textAdd === 0, `plus buttons: ${textAdd}`);
check("and no effect menu behind it", textEffectMenu === 0);
await page.keyboard.press("Escape");
await page.waitForTimeout(300);

console.log(`\n${results.filter(Boolean).length}/${results.length} checks passed`);
if (errors.length) console.log(`pageErrors:\n  ${errors.join("\n  ")}`);
await browser.close();
process.exit(results.every(Boolean) && errors.length === 0 ? 0 : 1);
