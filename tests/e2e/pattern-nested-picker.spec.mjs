import { chromium } from "playwright";
import { pathToFileURL } from "url";
import path from "node:path";

// A pattern layer's two colours are `ColorField`s inside the pattern picker, and
// a ColorField opens a picker of its own — so the pattern panel is a HOST with a
// NESTED colour panel on top. The host must survive every press that lands in the
// child: `useDismiss` closes on a capture-phase pointerdown outside itself, and a
// child portaled to `body` is outside by that test. Without the exemption the
// nested picker closed the host on the very press meant to change a colour.
const html = path.resolve(process.cwd(), process.argv[2] ?? "dist/index.html");

const ELEMENTS = [
  {
    id: "p_pat",
    type: "rect",
    name: "Pattern Rect",
    x: 240,
    y: 220,
    width: 260,
    height: 180,
    fills: [
      {
        type: "pattern",
        motif: "dots",
        tile: { width: 16, height: 16 },
        foreground: "#EF4444",
        background: "#FFFFFF"
      }
    ]
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
await page.evaluate((elements) => {
  const bridge = window.__FISH_BRIDGE__;
  const base = bridge.getDoc();
  bridge.setElements(JSON.parse(JSON.stringify(elements)), { canvas: { ...base.canvas, width: 2000, height: 1400 } });
}, ELEMENTS);
await page.waitForTimeout(700);

const panels = () => page.locator("[data-color-panel]").count();
const paint = () =>
  page.evaluate(() => {
    const doc = window.__FISH_BRIDGE__.getDoc();
    const page_ = doc.pages.find((p) => p.id === doc.activePageId);
    const el = page_.children.find((e) => e.id === "p_pat");
    return el.fills[0];
  });

await page.evaluate(() => window.__FISH_BRIDGE__.selectElement("p_pat"));
await page.waitForTimeout(300);

const swatch = page.locator("[data-paint-swatch]").first();
await swatch.click();
await page.waitForTimeout(300);
check("the pattern body is on screen", (await page.locator("[data-pattern-motif]").count()) === 5);
check("one picker open", (await panels()) === 1, `panels=${await panels()}`);

// ---- 1. a press in the nested picker must not close the host ---------------
const motifField = page.locator("[data-color-panel] [data-paint-swatch='color-field']").first();
await motifField.click();
await page.waitForTimeout(300);
check("the Motif swatch opens a second picker", (await panels()) === 2, `panels=${await panels()}`);

const sv = page.locator('[data-sv-area="1"]');
await sv.click({ position: { x: 12, y: 108 } });
await page.waitForTimeout(300);
check("a press in the nested picker leaves both open", (await panels()) === 2, `panels=${await panels()}`);
const afterSv = await paint();
check(
  "and the Motif colour is the one that changed",
  /^#[0-9a-f]{6}/i.test(afterSv.foreground) && afterSv.foreground.toUpperCase() !== "#EF4444",
  `foreground=${afterSv.foreground}`
);
check("the motif itself was not touched", afterSv.motif === "dots", `motif=${afterSv.motif}`);

// ---- 2. Enter in the nested hex field commits there, not the host ---------
const hex = page.locator('[data-hex-input="1"]');
await hex.click();
await hex.fill("");
await hex.type("0F766E");
await page.keyboard.press("Enter");
await page.waitForTimeout(300);
check("Enter in the nested hex field commits and leaves both panels open", (await panels()) === 2, `panels=${await panels()}`);
check("the typed colour was committed", /0f766e/i.test((await paint()).foreground), `foreground=${(await paint()).foreground}`);
// Escape unwinds one layer: the picker the field belonged to goes, the host stays.
await page.keyboard.press("Escape");
await page.waitForTimeout(300);
check("and Escape closes only the child", (await panels()) === 1, `panels=${await panels()}`);

// ---- 3. the background row behaves the same ------------------------------
const bgField = page.locator("[data-color-panel] [data-paint-swatch='color-field']").last();
await bgField.click();
await page.waitForTimeout(300);
check("the Background swatch opens a second picker", (await panels()) === 2, `panels=${await panels()}`);
await page.locator('[data-sv-area="1"]').click({ position: { x: 200, y: 12 } });
await page.waitForTimeout(300);
check("a press in it leaves both open", (await panels()) === 2, `panels=${await panels()}`);
check(
  "and only the background changed",
  (await paint()).background.toUpperCase() !== "#FFFFFF" && (await paint()).foreground.toLowerCase() === "#0f766e",
  JSON.stringify(await paint())
);

// ---- 4. dismissal unwinds one layer per press ------------------------------
// The press outside both panels belongs to the CHILD: the picker closes, the
// pattern editor stays open and its layer stays selected. The press must not
// reach the canvas either — clearing the selection would unmount the editor and
// collapse two layers into one press.
const selected = () => page.evaluate(() => window.__FISH_BRIDGE__.getSelectedIds().length);
const outside = { x: 700, y: 850 };
await page.mouse.click(outside.x, outside.y);
await page.waitForTimeout(300);
check("a press outside closes only the nested picker", (await panels()) === 1, `panels=${await panels()}`);
check("and does not reach the canvas", (await selected()) === 1, `selected=${await selected()}`);
await page.mouse.click(outside.x, outside.y);
await page.waitForTimeout(300);
check("the next press closes the pattern picker", (await panels()) === 0, `panels=${await panels()}`);
check("and it IS the canvas's: the selection cleared", (await selected()) === 0, `selected=${await selected()}`);

// ---- 5. Escape unwinds the same way --------------------------------------
await page.evaluate(() => window.__FISH_BRIDGE__.selectElement("p_pat"));
await page.waitForTimeout(300);
await page.locator("[data-paint-swatch]").first().click();
await page.waitForTimeout(300);
await page.locator("[data-color-panel] [data-paint-swatch='color-field']").first().click();
await page.waitForTimeout(300);
check("two pickers are open again", (await panels()) === 2, `panels=${await panels()}`);
await page.keyboard.press("Escape");
await page.waitForTimeout(300);
check("Escape closes the nested picker", (await panels()) === 1, `panels=${await panels()}`);
await page.keyboard.press("Escape");
await page.waitForTimeout(300);
check("Escape closes the pattern picker too", (await panels()) === 0, `panels=${await panels()}`);

check("no console errors", errors.length === 0, errors.slice(0, 3).join(" | "));

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
await browser.close();
process.exit(passed === results.length ? 0 : 1);
