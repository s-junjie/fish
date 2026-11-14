import { chromium } from "playwright";
import { pathToFileURL } from "url";
import path from "node:path";

// Token & Style editor popovers keep edits in local draft state until Save.
// While open, ⌘Z / ⇧⌘Z must undo/redo the draft's own drag or discrete edit
// (even when the name input still holds focus) without touching the document.
const html = path.resolve(process.cwd(), process.argv[2] ?? "dist/index.html");

const TOKENS = [
  { id: "tok_ink", type: "color", name: "brand/ink", value: "#111111" },
  { id: "tok_size", type: "number", name: "text/size", value: 14, category: "typography" }
];
const STYLES = [
  {
    id: "style_fill",
    styleType: "paint",
    name: "Brand Fill",
    paints: [{ type: "solid", color: "#3b82f6" }]
  }
];
const ELEMENTS = [
  {
    id: "rect_1",
    type: "rect",
    name: "Box",
    x: 0,
    y: 0,
    width: 200,
    height: 120,
    fills: [{ type: "solid", color: "#3b82f6", styleId: "style_fill" }]
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

const seed = async () => {
  await page.goto(pathToFileURL(html).href);
  await page.waitForFunction(() => !!window.__FISH_BRIDGE__);
  await page.evaluate(
    ({ tokens, styles, elements }) => {
      const bridge = window.__FISH_BRIDGE__;
      bridge.setElements(JSON.parse(JSON.stringify(elements)), {
        tokens: JSON.parse(JSON.stringify(tokens)),
        styles: JSON.parse(JSON.stringify(styles))
      });
    },
    { tokens: TOKENS, styles: STYLES, elements: ELEMENTS }
  );
  await page.waitForTimeout(400);
  await page.click('[data-testid="inspector-tab-design-system"]');
  await page.waitForTimeout(200);
};

// ---- 1. Color TokenEditorPanel: drag alpha scrub, undo/redo while open ----
await seed();
await page.hover('[data-token-row="tok_ink"]');
await page.click('[data-token-row="tok_ink"] button[aria-label="Edit color token"]');
await page.waitForSelector('[data-token-editor-panel="1"]');

const colorAlpha = page.locator('[data-token-editor-panel="1"] [data-scrub-label="%"]').first();
const colorAlphaBox = await colorAlpha.boundingBox();
check("Color TokenEditorPanel opens with alpha scrub", !!colorAlphaBox);
if (colorAlphaBox) {
  const sx = colorAlphaBox.x + colorAlphaBox.width / 2;
  const sy = colorAlphaBox.y + colorAlphaBox.height / 2;
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  for (let i = 1; i <= 20; i++) await page.mouse.move(sx - i * 2, sy, { steps: 1 });
  await page.mouse.up();
  await page.waitForTimeout(150);

  const afterDrag = await page.inputValue('[data-token-editor-panel="1"] input[name="%"]');
  check("20-frame alpha drag updates Color TokenEditorPanel draft", afterDrag !== "100", `alpha=${afterDrag}`);

  await page.keyboard.press("Meta+z");
  await page.waitForTimeout(150);
  const afterUndo = await page.inputValue('[data-token-editor-panel="1"] input[name="%"]');
  check("one ⌘Z undoes the whole alpha drag while Color TokenEditorPanel stays open", afterUndo === "100", `alpha=${afterUndo}`);

  await page.keyboard.press("Meta+Shift+z");
  await page.waitForTimeout(150);
  const afterRedo = await page.inputValue('[data-token-editor-panel="1"] input[name="%"]');
  check("⇧⌘Z redoes the alpha drag", afterRedo === afterDrag, `alpha=${afterRedo}`);
}

// ---- 2. NumberTokenEditorPanel: drag value scrub while name input has focus ----
await seed();
await page.hover('[data-number-token-row="tok_size"]');
await page.click('[data-number-token-row="tok_size"] button[aria-label="Edit number token"]');
await page.waitForSelector('[data-number-token-editor-panel="1"]');

const numInput = page.locator('[data-number-token-editor-panel="1"] input[name="scrub-input"]').first();
const numBox = await numInput.boundingBox();
check("NumberTokenEditorPanel opens with scrub field", !!numBox);
if (numBox) {
  await numInput.click({ clickCount: 3 });
  await numInput.fill("42");
  await numInput.press("Enter");
  await page.waitForTimeout(150);
  const afterType = await numInput.inputValue();
  check("typed number updates NumberTokenEditorPanel draft", afterType === "42", `val=${afterType}`);

  await page.keyboard.press("Meta+z");
  await page.waitForTimeout(150);
  const afterUndo = await numInput.inputValue();
  check("⌘Z undoes typed number even with input focused", afterUndo === "14", `val=${afterUndo}`);
}

// ---- 3. StylePickerPopover: open Paint style editor, drag alpha scrub, undo while open ----
await seed();
await page.click('button:has-text("Styles")');
await page.waitForTimeout(200);
await page.hover('[data-style-row="style_fill"]');
await page.click('[data-style-edit="style_fill"]');
await page.waitForSelector('[data-field-tab-scope="style-picker"]');

const styleAlpha = page.locator('[data-field-tab-scope="style-picker"] [data-scrub-label="%"]').first();
const styleAlphaBox = await styleAlpha.boundingBox();
check("StylePickerPopover opens with alpha scrub", !!styleAlphaBox);
if (styleAlphaBox) {
  const sx = styleAlphaBox.x + styleAlphaBox.width / 2;
  const sy = styleAlphaBox.y + styleAlphaBox.height / 2;
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  for (let i = 1; i <= 20; i++) await page.mouse.move(sx - i * 2, sy, { steps: 1 });
  await page.mouse.up();
  await page.waitForTimeout(150);

  const afterDrag = await page.inputValue('[data-field-tab-scope="style-picker"] input[name="%"]');
  check("20-frame alpha drag updates StylePickerPopover draft", afterDrag !== "100", `alpha=${afterDrag}`);

  await page.keyboard.press("Meta+z");
  await page.waitForTimeout(150);
  const afterUndo = await page.inputValue('[data-field-tab-scope="style-picker"] input[name="%"]');
  check("one ⌘Z undoes the whole alpha drag while StylePickerPopover stays open", afterUndo === "100", `alpha=${afterUndo}`);

  const docColor = await page.evaluate(() => {
    const s = (window.__FISH_BRIDGE__.getDoc().styles || []).find((x) => x.id === "style_fill");
    return s?.paints?.[0]?.color;
  });
  check("document style remains untouched before Save", docColor === "#3b82f6", `docColor=${docColor}`);
}

console.log(`\n${results.filter(Boolean).length}/${results.length} checks passed`);
if (errors.length) console.log(`pageErrors:\n  ${errors.join("\n  ")}`);
await browser.close();
process.exit(results.every(Boolean) && errors.length === 0 ? 0 : 1);
