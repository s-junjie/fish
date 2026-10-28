import { chromium } from "playwright";
import { pathToFileURL } from "node:url";
import path from "node:path";

// A colour style made FROM an image fill has to preview the bitmap.
//
// The regression: `paintStackLayers` skips an image layer it cannot resolve, so
// the style editor's banner — which composed the stack itself, without an asset
// lookup — drew the checkerboard and nothing else. That reads as "this colour
// style has no colour", not "this preview forgot the image", so it survived. The
// style CARDS in the picker's list had the same hole.
//
//   1. banner  — creating a paint style from an image fill shows the bitmap
//   2. row     — the draft's own "Image" row shows it too, not a grey square
//   3. card    — after saving, the style's mark in the list shows it too
const html = path.resolve(process.cwd(), process.argv[2] ?? "dist/index.html");

// A flat magenta 8x8 bitmap. Flat is enough: the check is that SOMETHING from the
// asset table reached the preview, and the checkerboard's two greys are the only
// other thing that could be there.
const PHOTO = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGO4ZtyCFTEMLQkA3IJjQZlFNp0AAAAASUVORK5CYII=";

const ELEMENTS = [
  {
    id: "img_fill",
    type: "rect",
    name: "Photo",
    x: 0,
    y: 0,
    width: 300,
    height: 200,
    fills: [{ type: "image", assetId: "asset_photo", fit: "cover" }]
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
  ({ elements, photo }) => {
    const bridge = window.__FISH_BRIDGE__;
    const base = bridge.getDoc();
    bridge.setElements(JSON.parse(JSON.stringify(elements)), {
      canvas: { ...base.canvas, width: 1920, height: 1080 },
      assets: [{ id: "asset_photo", name: "photo.png", kind: "image", uri: photo }]
    });
  },
  { elements: ELEMENTS, photo: PHOTO }
);
await page.evaluate(() => window.__FISH_BRIDGE__.selectElement("img_fill"));
await page.waitForTimeout(400);

/** The stack a preview drew, as the layer backgrounds it painted with. */
const swatchLayers = (scope) =>
  page.evaluate((sel) => {
    const root = document.querySelector(sel);
    if (!root) return null;
    return Array.from(root.querySelectorAll("div")).map(
      (d) => getComputedStyle(d).backgroundImage || ""
    );
  }, scope);

// ---- 1. the banner ------------------------------------------------------------
await page.click('[data-style-library-trigger="paint"]');
// The picker opens on its list half; its only header action with no style bound
// is the create button.
await page.click('[role="dialog"] button[aria-label="Create Style"]');
await page.waitForTimeout(400);

const banner = await swatchLayers('[role="dialog"] [data-paint-stack-swatch]');
check(
  "the banner previews the image fill",
  !!banner && banner.some((bg) => bg.includes(PHOTO)),
  banner ? `layers: ${banner.join(" | ").slice(0, 160)}` : "no swatch in the dialog"
);

// ---- 2. the draft's own row ---------------------------------------------------
const row = await swatchLayers('[role="dialog"] [data-paint-swatch]');
check(
  'the "Image" row swatch previews it',
  !!row && row.some((bg) => bg.includes(PHOTO)),
  row ? `layers: ${row.join(" | ").slice(0, 160)}` : "no row swatch in the dialog"
);

// ---- 3. the fill panel that row opens ----------------------------------------
// Clicking the row's swatch opens the colour panel on the draft's own paint. It
// is a separate host with its own `assets` argument, so the row previewing the
// bitmap did not imply this panel could: it listed no bitmaps at all and opened
// on "Missing image", which reads as "the document lost this picture".
await page.click('[role="dialog"] [data-paint-swatch]');
await page.waitForTimeout(500);
const panelAsset = await page
  .locator("[data-image-asset] select")
  .evaluate((el) => el.options[el.selectedIndex]?.text ?? "")
  .catch(() => "");
const panelSrc = await page
  .locator("[data-image-preview-bitmap]")
  .getAttribute("href")
  .catch(() => null);
check(
  "the fill panel opens on the style's own bitmap",
  panelAsset === "photo.png" && !!panelSrc && panelSrc.startsWith(PHOTO.slice(0, 30)),
  `asset: ${panelAsset} / src: ${String(panelSrc).slice(0, 30)}`
);
// Escape closes the panel (the first layer) without closing the editor behind it.
await page.keyboard.press("Escape");
await page.waitForTimeout(300);

// ---- 4. saving it as a colour style ------------------------------------------
await page.fill('[role="dialog"] input[name="style-name"]', "Photo fill");
await page.click('[role="dialog"] button[type="submit"]');
await page.waitForTimeout(600);

await page.click('[data-style-library-trigger="paint"]');
await page.waitForTimeout(400);
const card = await swatchLayers('[role="dialog"] [data-style-list-row] [data-paint-stack-swatch]');
check(
  "the saved style's card previews it too",
  !!card && card.some((bg) => bg.includes(PHOTO)),
  card ? `layers: ${card.join(" | ").slice(0, 160)}` : "no swatch on the card"
);

check("no page errors", errors.length === 0, errors.slice(0, 3).join(" / "));

await browser.close();
const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
