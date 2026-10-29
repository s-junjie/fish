import { chromium } from "playwright";
import { pathToFileURL } from "url";
import path from "node:path";

// A style editor's draft is LIVE: the canvas moves with it.
//
// The regression: the editor held a deep copy in its own state and wrote the
// document only on submit, so every change — a colour, an alpha, a type size —
// left the canvas painting the saved value until the user pressed Save. A
// designer cannot tune a colour that does not repaint.
//
// The rights this suite grades:
//   1. editing a style repaints every layer wearing it, before Save
//   2. closing without saving puts the canvas AND the document back
//   3. saving keeps the result, and undo takes back the whole edit in ONE step
//      (not one step per preview frame)
const html = path.resolve(process.cwd(), process.argv[2] ?? "dist/index.html");

const STYLES = [
  { id: "style_paint_a", name: "Orange", styleType: "paint", paints: [{ type: "solid", color: "#FF8800" }] }
];

const ELEMENTS = [
  {
    id: "r_bound",
    type: "rect",
    name: "Bound",
    x: 0,
    y: 0,
    width: 200,
    height: 120,
    fillStyleId: "style_paint_a",
    fills: [{ type: "solid", color: "#FF8800" }]
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
    bridge.setElements(JSON.parse(JSON.stringify(elements)), {
      canvas: { ...base.canvas, width: 1920, height: 1080 },
      styles: JSON.parse(JSON.stringify(styles))
    });
  },
  { styles: STYLES, elements: ELEMENTS }
);
await page.waitForTimeout(600);

/** The fill the canvas is PAINTING for the bound rect — not what the document stores. */
const paintedFills = () =>
  page.evaluate(() =>
    [...document.querySelectorAll('[data-element-id="r_bound"] path')].map((p) =>
      (p.getAttribute("fill") || "").toUpperCase()
    )
  );

const storedFills = () =>
  page.evaluate(() => {
    const doc = window.__FISH_BRIDGE__.getDoc();
    const style = (doc.styles || []).find((s) => s.id === "style_paint_a");
    const el = window.__FISH_BRIDGE__.getElements().find((e) => e.id === "r_bound");
    return {
      style: style?.paints?.[0]?.color?.toUpperCase() ?? null,
      element: el?.fills?.[0]?.color?.toUpperCase() ?? null
    };
  });

const openEditor = async () => {
  await page.click('[data-testid="inspector-tab-design-system"]');
  await page.waitForTimeout(150);
  await page.click('[data-design-system-tabs="1"] button:has-text("Styles")');
  await page.waitForTimeout(250);
  await page.click('[data-ui-panel="right"] [data-style-row="style_paint_a"]');
  await page.waitForTimeout(350);
};

const setHex = async (hex) => {
  const input = page.locator('[role="dialog"] input[name="hex-color"]').first();
  await input.click();
  await input.fill(hex);
  await input.press("Enter");
  await page.waitForTimeout(350);
};

check(
  "the fixture is painted from its style",
  (await paintedFills()).includes("#FF8800"),
  JSON.stringify(await paintedFills())
);

// ---- 1. the draft reaches the canvas before Save ---------------------------
await openEditor();
check(
  "the style editor opens on the bound style",
  (await page.locator('[role="dialog"] input[name="style-name"]').inputValue().catch(() => null)) === "Orange"
);
await setHex("#00FF00");
check(
  "the canvas repaints while the draft is unsaved",
  (await paintedFills()).includes("#00FF00"),
  JSON.stringify(await paintedFills())
);
check(
  "and the document's layer moved with it",
  (await storedFills()).element === "#00FF00",
  JSON.stringify(await storedFills())
);

// ---- 2. closing without saving puts everything back ------------------------
await page.keyboard.press("Escape");
await page.waitForTimeout(400);
check("Escape closes the editor", (await page.locator('[role="dialog"]').count()) === 0);
check(
  "the canvas is back on the saved colour",
  (await paintedFills()).includes("#FF8800"),
  JSON.stringify(await paintedFills())
);
const afterCancel = await storedFills();
check(
  "the document is back too — style and layer alike",
  afterCancel.style === "#FF8800" && afterCancel.element === "#FF8800",
  JSON.stringify(afterCancel)
);

// ---- 3. saving keeps it, and undo is ONE step ------------------------------
await openEditor();
await setHex("#00FF00");
await page.click('[role="dialog"] button[type="submit"]');
await page.waitForTimeout(400);
const saved = await storedFills();
check(
  "Save writes the drafted style and its layer",
  saved.style === "#00FF00" && saved.element === "#00FF00",
  JSON.stringify(saved)
);
check("the canvas still paints it", (await paintedFills()).includes("#00FF00"));

await page.evaluate(() => window.__FISH_BRIDGE__.undo());
await page.waitForTimeout(400);
const undone = await storedFills();
check(
  "one undo takes the whole edit back",
  undone.style === "#FF8800" && undone.element === "#FF8800",
  JSON.stringify(undone)
);
check(
  "and the canvas follows the undo",
  (await paintedFills()).includes("#FF8800"),
  JSON.stringify(await paintedFills())
);

console.log(`\n${results.filter(Boolean).length}/${results.length} checks passed`);
if (errors.length) console.log(`pageErrors:\n  ${errors.join("\n  ")}`);
await browser.close();
process.exit(results.every(Boolean) && errors.length === 0 ? 0 : 1);
