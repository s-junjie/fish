import { chromium } from "playwright";
import { pathToFileURL } from "url";
import path from "node:path";


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

const DIRTY_Y = -8.4399999999999;

await page.goto(pathToFileURL(html).href);
await page.waitForFunction(() => !!window.__FISH_BRIDGE__);
await page.evaluate((dirtyY) => {
  const bridge = window.__FISH_BRIDGE__;
  const base = bridge.getDoc();
  bridge.setElements(
    [
      {
        id: "r1",
        type: "rect",
        name: "Rect",
        x: 12.300000000000001,
        y: dirtyY,
        width: 200,
        height: 120,
        fills: [{ type: "solid", color: "#3E63DD" }]
      }
    ],
    { canvas: { ...base.canvas, width: 1920, height: 1080 } }
  );
  bridge.selectElement("r1");
}, DIRTY_Y);
await page.waitForTimeout(500);

const el = () =>
  page.evaluate(() => window.__FISH_BRIDGE__.getElements().find((e) => e.id === "r1") ?? null);

const X = '[data-ui-panel="right"] [data-scrub-field="X"]';
const Y = '[data-ui-panel="right"] [data-scrub-field="Y"]';

const shownX = await page.inputValue(X);
const shownY = await page.inputValue(Y);
check("X shows the float tail as a short number", shownX === "12.3", `field reads "${shownX}"`);
check("Y shows the float tail as a short number", shownY === "-8.44", `field reads "${shownY}"`);

const initial = await el();
check("showing a dirty coordinate leaves the stored value alone", initial?.y === DIRTY_Y, `y ${initial?.y}`);

await page.click(Y);
await page.click(X);
await page.waitForTimeout(200);
const afterBlur = await el();
check("focus and blur without an edit do not rewrite the document", afterBlur?.y === DIRTY_Y, `y ${afterBlur?.y}`);

await page.fill(Y, "8.123456789");
await page.press(Y, "Enter");
await page.waitForTimeout(250);
const typed = await page.inputValue(Y);
check("a typed number is capped at the field's decimal limit", typed === "8.12", `field reads "${typed}"`);
const afterType = await el();
check(
  "and the stored coordinate is the number the field shows",
  typeof afterType?.y === "number" && Math.abs(afterType.y - 8.12) < 1e-9,
  `y ${afterType?.y}`
);

console.log(`\n${results.filter(Boolean).length}/${results.length} checks passed`);
if (errors.length) console.log(`pageErrors:\n  ${errors.join("\n  ")}`);
await browser.close();
process.exit(results.every(Boolean) && errors.length === 0 ? 0 : 1);
