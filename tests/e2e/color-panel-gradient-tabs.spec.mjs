import { chromium } from "playwright";
import { pathToFileURL } from "url";
import path from "node:path";

// The colour panel's tab contract, measured in the real editor.
//
// The four gradient dialects used to be four tabs beside Solid and Image, so the
// row said "linear / radial / angular / diamond / solid / image" — six names for
// two different questions. They are ONE tab now, with the dialects a row below
// it, and that row only exists while the tab does.
//
// Every check below reads the DOCUMENT, because a switcher that highlights a
// button and writes nothing looks exactly like one that works until you read the
// fill afterwards. The geometry check is the other half: four labels in a 240 px
// panel is the kind of layout that "looks right" in the source and spills onto
// its neighbour on screen.
const html = path.resolve(process.cwd(), process.argv[2] ?? "dist/index.html");

const RECT = {
  id: "gt_rect",
  type: "rect",
  name: "Gradient Rect",
  x: 200,
  y: 200,
  width: 240,
  height: 160,
  fills: [
    {
      type: "linear-gradient",
      from: "#FF0000",
      to: "#0000FF",
      angle: 90,
      stops: [
        { color: "#FF0000", offset: 0 },
        { color: "#0000FF", offset: 1 }
      ]
    }
  ]
};

const results = [];
/** `ok` must be a boolean: a non-empty string or array here passes vacuously. */
const check = (name, ok, detail = "") => {
  results.push(!!ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `\n      ${detail}` : ""}`);
};
/** The value form, so a "wrong string" fails instead of being truthy. */
const same = (name, actual, expected) =>
  check(name, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)}`);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});

await page.goto(pathToFileURL(html).href);
await page.waitForFunction(() => !!window.__FISH_BRIDGE__);
await page.evaluate((rect) => {
  const bridge = window.__FISH_BRIDGE__;
  const base = bridge.getDoc();
  bridge.setElements([JSON.parse(JSON.stringify(rect))], { canvas: { ...base.canvas, width: 2000, height: 1400 } });
}, RECT);
await page.waitForTimeout(700);

const settle = () => page.waitForTimeout(250);
const fillType = () =>
  page.evaluate(() => {
    const doc = window.__FISH_BRIDGE__.getDoc();
    const active = doc.pages.find((p) => p.id === doc.activePageId);
    return active.children.find((e) => e.id === "gt_rect").fills[0].type;
  });
const tabs = () =>
  page.evaluate(() => [...document.querySelectorAll("[data-paint-tab]")].map((n) => n.getAttribute("data-paint-tab")));
const dialects = () =>
  page.evaluate(() =>
    [...document.querySelectorAll("[data-paint-kind]")].map((n) => n.getAttribute("data-paint-kind"))
  );
const panelOpen = async () => (await page.locator("[data-color-panel]").count()) === 1;

await page.evaluate(() => window.__FISH_BRIDGE__.selectElement("gt_rect"));
await settle();
await page.locator("[data-paint-swatch]").last().click();
await settle();
check("the fill swatch opens the colour panel", await panelOpen());

// ---- the row is tabs, and the dialects are not among them -------------------
same("the switcher is four tabs, not seven", await tabs(), ["solid", "gradient", "image", "pattern"]);
same("a gradient fill opens on the Gradient tab with its dialects below it", await dialects(), [
  "linear-gradient",
  "radial-gradient",
  "angular-gradient",
  "diamond-gradient"
]);

// ---- the dialects write the document, in place ------------------------------
// The dialect row is a DROPDOWN now (four labels never fit a 240px panel), so a
// dialect is chosen with `selectOption` rather than by clicking a button. The
// four `<option data-paint-kind>` nodes keep `dialects()` above meaningful.
await page.selectOption("[data-gradient-kinds]", "diamond-gradient");
await settle();
same("picking a dialect writes it to the fill", await fillType(), "diamond-gradient");
check("and the panel stays open on it", await panelOpen());
await page.selectOption("[data-gradient-kinds]", "angular-gradient");
await settle();
same("one dialect switches to another without going through solid", await fillType(), "angular-gradient");

// ---- the row belongs to the tab ---------------------------------------------
await page.selectOption("[data-paint-kind-select]", "solid");
await settle();
same("the Solid tab writes a solid", await fillType(), "solid");
same("and takes the dialect row away with it", await dialects(), []);
check("no dialect row is left in the DOM", (await page.locator("[data-gradient-kinds]").count()) === 0);

await page.selectOption("[data-paint-kind-select]", "gradient");
await settle();
same("the Gradient tab re-enters the dialect that was last chosen", await fillType(), "angular-gradient");
same("with the whole dialect row back", await dialects(), [
  "linear-gradient",
  "radial-gradient",
  "angular-gradient",
  "diamond-gradient"
]);

// ---- the row fits the panel -------------------------------------------------
//
// It is one dropdown now, so there is no per-label overflow to measure: what
// still has to hold is that the control sits inside the panel's own box and
// shows the dialect the document carries.
const fit = await page.evaluate(() => {
  const panel = document.querySelector("[data-color-panel]").getBoundingClientRect();
  const node = document.querySelector("[data-gradient-kinds]");
  const row = node.getBoundingClientRect();
  return {
    rowInside: row.left >= panel.left - 1 && row.right <= panel.right + 1,
    rowWidth: Math.round(row.width),
    rowHeight: Math.round(row.height),
    shown: node.value
  };
});
check(
  "the dialect row sits inside the panel",
  fit.rowInside,
  `row left/right within panel, width=${fit.rowWidth}`
);
same("and the dropdown shows the dialect the fill carries", fit.shown, "angular-gradient");
check("the dialect row is a field's height, not a tab strip's", fit.rowHeight === 25, `height=${fit.rowHeight}`);

// ---- a tab the document cannot satisfy must not write a paint ---------------
//
// The document has no bitmap, so Image mode can only be REQUESTED: the body has
// to appear so the upload button is reachable, while the fill is left alone. A
// paint without an `assetId` fails normalization and would be dropped on save.
await page.selectOption("[data-paint-kind-select]", "image");
await settle();
check("the Image tab shows its body with an upload button", (await page.locator("[data-image-upload]").count()) === 1);
check("with nothing to frame yet, so no fit control", (await page.locator("[data-image-fit]").count()) === 0);
same("and the fill is left as the gradient it was", await fillType(), "angular-gradient");

check("no page errors", errors.length === 0, errors.join(" | "));

await browser.close();
const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed === 0 && errors.length === 0 ? 0 : 1);
