import { chromium } from "playwright";
import { pathToFileURL } from "url";
import path from "node:path";

// A value edited in the Tokens table costs ONE undo step, whichever control
// produced it.
//
// The table's continuous controls used to record a step per pointermove: the
// alpha scrub committed on every frame, and the colour panel's saturation field
// had no `onGestureStart`/`onGestureEnd` at all. After a real drag the stack
// held a pixel per entry, the state before the drag had been evicted past the
// 100-entry limit, and ⌘Z appeared to do nothing — the panel "could not be
// undone". This spec grades the step count, not the pixels: after a drag, the
// first ⌘Z must land back on the value the drag started from.
const html = path.resolve(process.cwd(), process.argv[2] ?? "dist/index.html");

const TOKENS = [
  { id: "tok_ink", type: "color", name: "brand/ink", value: "#111111" },
  { id: "tok_size", type: "number", name: "text/size", value: 14, category: "typography" }
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
    fills: [{ type: "solid", color: "#111111", tokenId: "tok_ink" }]
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

/** A fresh document and an open table, per check group — no state carries over. */
const seed = async () => {
  await page.goto(pathToFileURL(html).href);
  await page.waitForFunction(() => !!window.__FISH_BRIDGE__);
  await page.evaluate(
    ({ tokens, elements }) => {
      const bridge = window.__FISH_BRIDGE__;
      bridge.setElements(JSON.parse(JSON.stringify(elements)), {
        tokens: JSON.parse(JSON.stringify(tokens))
      });
      bridge.selectElement("rect_1");
    },
    { tokens: TOKENS, elements: ELEMENTS }
  );
  await page.waitForTimeout(600);
  await page.click('[data-testid="inspector-tab-design-system"]');
  await page.waitForTimeout(200);
  await page.click('button[aria-label="Tokens Table"]');
  await page.waitForTimeout(500);
};

const tokenValue = (id) =>
  page.evaluate((tokenId) => {
    const token = (window.__FISH_BRIDGE__.getDoc().tokens || []).find((t) => t.id === tokenId);
    return token ? token.value : null;
  }, id);

// ---- 1. the alpha scrub in a colour cell ----------------------------------
await seed();
await page.click('button:has-text("Colors")');
await page.waitForTimeout(300);
const alphaHandle = page.locator('[data-scrub-label="%"]').first();
const alphaBox = await alphaHandle.boundingBox();
check("the colour cell offers an alpha scrub handle", !!alphaBox);
if (alphaBox) {
  const startX = alphaBox.x + alphaBox.width / 2;
  const y = alphaBox.y + alphaBox.height / 2;
  await page.mouse.move(startX, y);
  await page.mouse.down();
  for (let i = 1; i <= 20; i++) await page.mouse.move(startX - i * 2, y, { steps: 1 });
  await page.mouse.up();
  await page.waitForTimeout(250);

  const dragged = await tokenValue("tok_ink");
  check("a 20-frame alpha drag changes the token", dragged !== "#111111", `value: ${dragged}`);

  await page.keyboard.press("Meta+z");
  await page.waitForTimeout(300);
  const undone = await tokenValue("tok_ink");
  check("one ⌘Z undoes the whole alpha drag", undone === "#111111", `value after ⌘Z: ${undone}`);

  await page.keyboard.press("Meta+z");
  await page.waitForTimeout(300);
  const older = await tokenValue("tok_ink");
  check(
    "and the next ⌘Z reaches the state before the table was populated",
    older === null,
    `value after a second ⌘Z: ${older}`
  );
}

// ---- 2. the colour panel's saturation field -------------------------------
await seed();
const swatch = await page.$('td button[aria-label^="#"]');
check("the colour cell offers its swatch", !!swatch);
if (swatch) {
  await swatch.click();
  await page.waitForTimeout(400);
  const sv = await page.$('[data-sv-area="1"]');
  check("the swatch opens the colour panel", !!sv);
  if (sv) {
    const box = await sv.boundingBox();
    const y = box.y + box.height * 0.5;
    const x0 = box.x + box.width * 0.2;
    await page.mouse.move(x0, y);
    await page.mouse.down();
    for (let i = 1; i <= 20; i++) await page.mouse.move(x0 + i * 4, y - i * 2, { steps: 1 });
    await page.mouse.up();
    await page.waitForTimeout(300);

    const dragged = await tokenValue("tok_ink");
    check("a 20-frame picker drag changes the token", dragged !== "#111111", `value: ${dragged}`);
    await page.keyboard.press("Meta+z");
    await page.waitForTimeout(300);
    const undone = await tokenValue("tok_ink");
    check("one ⌘Z undoes the whole picker drag", undone === "#111111", `value after ⌘Z: ${undone}`);
  }
}

// ---- 3. a typed number is still one step ----------------------------------
await seed();
await page.click('button:has-text("Numbers")');
await page.waitForTimeout(300);
const numberField = await page.$('input[name="scrub-input"]');
check("the number cell offers a field", !!numberField);
if (numberField) {
  await numberField.click({ clickCount: 3 });
  await numberField.fill("36");
  await numberField.press("Enter");
  await page.waitForTimeout(300);
  const typed = await tokenValue("tok_size");
  check("a typed number lands in the token", typed === 36, `value: ${typed}`);
  await page.keyboard.press("Meta+z");
  await page.waitForTimeout(300);
  const undone = await tokenValue("tok_size");
  check("one ⌘Z undoes the typed number", undone === 14, `value after ⌘Z: ${undone}`);
}

console.log(`\n${results.filter(Boolean).length}/${results.length} checks passed`);
if (errors.length) console.log(`pageErrors:\n  ${errors.join("\n  ")}`);
await browser.close();
process.exit(results.every(Boolean) && errors.length === 0 ? 0 : 1);
