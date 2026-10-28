import { chromium } from "playwright";
import { pathToFileURL } from "url";
import path from "node:path";

// An inspector number field is a calculator: `1000/2` commits 500. Two things
// this pins down that a unit test of the parser cannot:
//   - the field really ACCEPTS the operator characters. A type=number input
//     drops `/` at the keystroke, so the feature is invisible in the browser
//     however good the parser is.
//   - a delta field (X/Y) applies the evaluated number ONCE, not once per
//     Enter-then-blur commit.
const html = path.resolve(process.cwd(), process.argv[2] ?? "dist/index.html");

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
await page.evaluate(() => {
  const bridge = window.__FISH_BRIDGE__;
  const base = bridge.getDoc();
  bridge.setElements([
      {
        id: "r1",
        type: "rect",
        name: "Rect",
        x: 0,
        y: 60,
        width: 200,
        height: 120,
        fills: [{ type: "solid", color: "#3E63DD" }]
      }
    ], { canvas: { ...base.canvas, width: 1920, height: 1080 } });
  bridge.selectElement("r1");
});
await page.waitForTimeout(500);

const el = () =>
  page.evaluate(() => {
    const doc = window.__FISH_BRIDGE__.getDoc();
    return window.__FISH_BRIDGE__.getElements().find((e) => e.id === "r1") ?? null;
  });
const paintedWidth = () =>
  page.evaluate(() => {
    const node = document.querySelector('[data-element-id="r1"] path');
    return node ? node.getBBox().width : null;
  });

const W = '[data-ui-panel="right"] [data-scrub-field="W"]';
const H = '[data-ui-panel="right"] [data-scrub-field="H"]';
const X = '[data-ui-panel="right"] [data-scrub-field="X"]';

const commitWith = async (selector, text) => {
  await page.fill(selector, text);
  await page.press(selector, "Enter");
  await page.waitForTimeout(200);
};

// --- 1. the field takes the operator, and commits the arithmetic -------------
await page.fill(W, "1000/2");
const typed = await page.inputValue(W);
check("the field keeps the operator characters as typed", typed === "1000/2", `field reads "${typed}"`);

await page.press(W, "Enter");
await page.waitForTimeout(200);
const halved = await el();
check("1000/2 commits 500", halved?.width === 500, `width ${halved?.width}`);
check("and the field shows the result, not the expression", (await page.inputValue(W)) === "500");

const paint = await paintedWidth();
check("the canvas repaints at the evaluated width", paint !== null && Math.abs(paint - 500) < 0.01, `painted=${paint}`);

// --- 2. precedence and parentheses ------------------------------------------
await commitWith(W, "(100+20)/2");
const parenthesised = await el();
check("(100+20)/2 commits 60", parenthesised?.width === 60, `width ${parenthesised?.width}`);

await commitWith(W, "100*1.5-10");
const precedence = await el();
check("100*1.5-10 commits 140, so * binds tighter than -", precedence?.width === 140, `width ${precedence?.width}`);

// --- 3. a draft that is not an expression changes nothing --------------------
await commitWith(W, "abc");
const afterGarbage = await el();
check("an unparseable draft leaves the document alone", afterGarbage?.width === 140, `width ${afterGarbage?.width}`);
check("and the field falls back to the stored value", (await page.inputValue(W)) === "140");

// --- 4. blur commits an expression too --------------------------------------
await page.fill(W, "400/4");
await page.click(H);
await page.waitForTimeout(200);
const blurred = await el();
check("blur commits 400/4 as 100", blurred?.width === 100, `width ${blurred?.width}`);

// --- 5. an arrow press resolves a pending expression -------------------------
await page.fill(W, "1000/2");
await page.waitForTimeout(100);
await page.keyboard.press("ArrowUp");
await page.waitForTimeout(200);
const arrowed = await el();
check("ArrowUp resolves 1000/2 to 500 and steps to 501", arrowed?.width === 501, `width ${arrowed?.width}`);

// --- 6. a DELTA field applies the evaluated number exactly once --------------
// Enter commits and blurs in the same task, so a field that re-committed its
// draft on blur would land at 50 + 50.
await page.fill(X, "0");
await page.press(X, "Enter");
await page.waitForTimeout(200);
const zeroed = await el();
check("the rect is back at x = 0", zeroed?.x === 0, `x ${zeroed?.x}`);

await page.fill(X, "100/2");
await page.press(X, "Enter");
await page.waitForTimeout(250);
const moved = await el();
check("100/2 in a delta field moves x by 50, once", moved?.x === 50, `x ${moved?.x}`);

console.log(`\n${results.filter(Boolean).length}/${results.length} checks passed`);
if (errors.length) console.log(`pageErrors:\n  ${errors.join("\n  ")}`);
await browser.close();
process.exit(results.every(Boolean) && errors.length === 0 ? 0 : 1);
