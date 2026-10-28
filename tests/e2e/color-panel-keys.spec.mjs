import { chromium } from "playwright";
import { pathToFileURL } from "url";
import path from "node:path";

// The colour panel's keyboard contract, measured in the real editor:
//
//   1. Enter          — confirms the pick and CLOSES the panel
//   2. Enter in a field — commits the typed value and KEEPS the panel open: a
//                          confirmed number is an edit, not a dismissal
//   3. the X button   — closes it too
//   4. Enter under an open picker — does NOT reach the editor. `useShortcuts`
//                                     listens on `window` in the capture phase, so
//                                     with a path selected Enter used to enter
//                                     vector edit mode *underneath* the open panel:
//                                     the panel closed and the overlay appeared.
const html = path.resolve(process.cwd(), process.argv[2] ?? "dist/index.html");

const ELEMENTS = [
  { id: "p_rect", type: "rect", name: "Color Rect", x: 200, y: 200, width: 240, height: 160, fills: [{ type: "solid", color: "#3B82F6" }] },
  { id: "p_path", type: "path", name: "Edit Path", x: 600, y: 200, width: 220, height: 130, d: "M 0 0 C 60 0 60 120 220 120", strokes: [{ color: "#FFFFFF", width: 2 }] }
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

const select = (id) => page.evaluate((i) => window.__FISH_BRIDGE__.selectElement(i), id);
const panels = () => page.locator("[data-color-panel]").count();
const editing = () => page.evaluate(() => document.querySelectorAll("[data-path-edit]").length);
const colourOf = (id, pick) =>
  page.evaluate(
    ({ elId, fn }) => {
      const doc = window.__FISH_BRIDGE__.getDoc();
      const el = doc.pages.find((p) => p.id === doc.activePageId).children.find((e) => e.id === elId);
      return fn === "fill" ? el.fills[0].color : el.strokes[0].color;
    },
    { elId: id, fn: pick }
  );
/** The stroke section's swatch: the fill one is index 0 of the paint stack. */
const openPanel = async () => {
  const swatch = page.locator("[data-paint-swatch]").last();
  if ((await swatch.count()) === 0) return false;
  await swatch.click();
  await page.waitForTimeout(250);
  return true;
};

// ---- 1. Enter confirms and closes -----------------------------------------
await select("p_rect");
await page.waitForTimeout(300);
check("the fill swatch is reachable", await openPanel());
check("the panel is open", (await panels()) === 1, `panels=${await panels()}`);
await page.keyboard.press("Enter");
await page.waitForTimeout(250);
check("Enter closes the panel", (await panels()) === 0, `panels=${await panels()}`);

// ---- 2. a field commits, and the panel stays ------------------------------
check("the panel reopens", await openPanel());
/* `[data-hex-input="1"]` — the open panel's own field. NOT `input[type="text"]`:
   the panel has two text inputs and the alpha scrub field comes first in DOM
   order, so `.first()` was the alpha well: the spec typed a hex into it, the parse
   was rejected, nothing was written, and the check below failed against a colour
   nobody had changed. The bare attribute is not unique either — the inspector's
   paint rows carry `data-hex-input="fill-<n>"` — so the value is spelled out. */
const field = page.locator('[data-hex-input="1"]');
await field.click();
await field.fill("");
await field.type("FF0000");
await page.keyboard.press("Enter");
await page.waitForTimeout(300);
check("Enter in the hex field keeps the panel open", (await panels()) === 1, `panels=${await panels()}`);
check("and the typed value was committed", /ff0000/i.test(await colourOf("p_rect", "fill")), `fill=${await colourOf("p_rect", "fill")}`);

// ---- 3. dismissal without a close button ----------------------------------
//
// The header now has a title and an X close button (matching EffectPanel).
// Clicking the close button closes the panel.
const closeBtn = page.locator("[data-color-panel] button[aria-label='Close']");
check("it has a close button", (await closeBtn.count()) === 1);
await closeBtn.click();
await page.waitForTimeout(250);
check("close button closes the panel", (await panels()) === 0, `panels=${await panels()}`);
check(
  "and leaves the layer selected, so the swatch is still there",
  (await page.locator("[data-paint-swatch]").count()) > 0
);

check("the panel reopens", await openPanel());
await page.keyboard.press("Escape");
await page.waitForTimeout(250);
check("Escape closes the panel", (await panels()) === 0, `panels=${await panels()}`);
check(
  "and leaves the layer selected, so the swatch is still there",
  (await page.locator("[data-paint-swatch]").count()) > 0
);

check("the panel reopens", await openPanel());
// Empty canvas, derived from the chrome boxes rather than assumed: the midpoint
// between the left and right panels, low enough to be under both layers.
const canvasSpot = await page.evaluate(() => {
  const boxes = [...document.querySelectorAll('[data-ui-panel]')].map((n) => n.getBoundingClientRect());
  const left = Math.max(0, ...boxes.filter((b) => b.left < 100).map((b) => b.right));
  const right = Math.min(window.innerWidth, ...boxes.filter((b) => b.right > window.innerWidth - 100).map((b) => b.left));
  return { x: Math.round((left + right) / 2), y: Math.round(window.innerHeight * 0.72) };
});
await page.mouse.click(canvasSpot.x, canvasSpot.y);
await page.waitForTimeout(300);
check("a press on the canvas closes the panel", (await panels()) === 0, `panels=${await panels()}`);
check(
  "and the press really landed on the canvas: it cleared the selection",
  await page.evaluate(() => window.__FISH_BRIDGE__.getSelectedIds().length === 0),
  `${JSON.stringify(await page.evaluate(() => window.__FISH_BRIDGE__.getSelectedIds()))} @ ${JSON.stringify(canvasSpot)}`
);

// ---- 4. Enter while a path is being edited --------------------------------
await select("p_path");
await page.waitForTimeout(250);
await page.keyboard.press("Enter");
await page.waitForTimeout(350);
check("Enter starts vector edit mode", (await editing()) === 1, `pathEditOverlays=${await editing()}`);

await openPanel();
check("the picker opens on top of vector edit mode", (await panels()) === 1, `panels=${await panels()}`);
await page.keyboard.press("Enter");
await page.waitForTimeout(300);
check("Enter closes the picker", (await panels()) === 0, `panels=${await panels()}`);
check("and does NOT enter/leave vector edit mode underneath it", (await editing()) === 1, `pathEditOverlays=${await editing()}`);

await page.keyboard.press("Escape");
await page.waitForTimeout(300);
check("Escape still leaves vector edit mode once the picker is gone", (await editing()) === 0, `pathEditOverlays=${await editing()}`);

check("no console errors", errors.length === 0, errors.slice(0, 3).join(" | "));

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
await browser.close();
process.exit(passed === results.length ? 0 : 1);
