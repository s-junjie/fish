import { chromium } from "playwright";
import { pathToFileURL } from "url";
import path from "node:path";

// The inspector's number fields must move the canvas on every ARROW press, not
// only on blur/Enter. The regression: the field was a type=number input, whose
// native spinner only rewrites the field text and waits for blur, so the drawing
// froze while the number changed. The field is a text input now (it has to be —
// it accepts arithmetic), so the handler is the only thing that steps a value.

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

const docWidth = () =>
  page.evaluate(() => {
    const doc = window.__FISH_BRIDGE__.getDoc();
    const el = window.__FISH_BRIDGE__.getElements().find((e) => e.id === "r1");
    return el ? el.width : null;
  });
// The painted truth: the SVG shape's box (a rect is painted as a path), not the
// document field.
const paintedWidth = () =>
  page.evaluate(() => {
    const node = document.querySelector('[data-element-id="r1"] path');
    if (!node) return null;
    return node.getBBox().width;
  });

const W = '[data-ui-panel="right"] [data-scrub-field="W"]';
await page.click(W);
await page.waitForTimeout(150);

const w0 = await docWidth();
await page.keyboard.press("ArrowUp");
await page.waitForTimeout(120);
const w1 = await docWidth();
check("ArrowUp resizes live (+1)", w1 === w0 + 1, `width ${w0} -> ${w1}`);

await page.keyboard.press("Shift+ArrowUp");
await page.waitForTimeout(120);
const w2 = await docWidth();
check("Shift+ArrowUp resizes live (+8)", w2 === w1 + 8, `width ${w1} -> ${w2}`);

await page.keyboard.press("ArrowDown");
await page.waitForTimeout(120);
const w3 = await docWidth();
check("ArrowDown resizes live (-1)", w3 === w2 - 1, `width ${w2} -> ${w3}`);

const paint = await paintedWidth();
// The canvas paints on the DEVICE-PIXEL grid (`src/ui/canvas/pixel-align.ts`): at a
// fractional zoom every edge is rounded to a whole device pixel so two coincident
// fills do not leave a seam. The painted width is therefore the document width
// snapped — 208 at zoom 0.8 is 207.5 — and comparing it to the document number
// raw fails on a canvas that is drawing exactly right. `r1` sits at x = 0, so its
// left edge snaps to 0 and only the right edge moves.
const zoom = await page.evaluate(() => {
  const s = document.querySelector("[data-stage-transform]");
  const a = s && s.getAttribute("transform");
  if (a) return parseFloat(/scale\(([\d.]+)\)/.exec(a)[1]);
  const owner = s && s.ownerSVGElement;
  const m = /matrix\(([\d.eE+-]+), 0, 0, ([\d.eE+-]+), ([\d.eE+-]+), ([\d.eE+-]+)\)/.exec(
    owner ? getComputedStyle(owner).transform : ""
  );
  return m ? parseFloat(m[1]) : 1;
});
const expectedPaint = Math.round(w3 * zoom) / zoom;
check(
  "the canvas really repaints at the new size",
  paint !== null && Math.abs(paint - expectedPaint) < 0.01,
  `painted=${paint} doc=${w3} expected=${expectedPaint} at zoom ${zoom}`
);

console.log(`\n${results.filter(Boolean).length}/${results.length} checks passed`);
if (errors.length) console.log(`pageErrors:\n  ${errors.join("\n  ")}`);
await browser.close();
process.exit(results.every(Boolean) && errors.length === 0 ? 0 : 1);
