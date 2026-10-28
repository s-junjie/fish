import { chromium } from "playwright";
import { pathToFileURL } from "url";
import path from "path";

// Cmd/Ctrl-hover previews what a click would select, as a DASHED outline.
//
// It is the one box on the canvas still placed by adding a translation-only
// origin and turning by the hovered layer's own `rotation` — so inside a turned
// frame the dashed outline sat beside the element instead of on it, which is
// worse than no preview at all: it promises a click will select something the
// pointer is not on.
//
// Measured off the live DOM like every other box spec here — the outline is
// read off the hover chrome itself, and the artwork off its painted hit path.

const html = path.resolve(process.cwd(), process.argv[2] ?? "dist/index.html");
const results = [];
const check = (name, actual, expected) =>
  results.push({ name, ok: JSON.stringify(actual) === JSON.stringify(expected), actual, expected });
const checkClose = (name, actual, expected, tol = 1.5) => {
  const ok = typeof actual === "number" && Number.isFinite(actual) && Math.abs(actual - expected) <= tol;
  results.push({ name, ok, actual, expected: `${expected} ±${tol}` });
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});

await page.goto(pathToFileURL(html).href);
await page.waitForFunction(() => !!window.__FISH_BRIDGE__);

const plain = (id, x, y, w, h, extra = {}) => ({
  id,
  type: "rect",
  name: id,
  x,
  y,
  width: w,
  height: h,
  fills: [{ type: "solid", color: "#3B82F6" }],
  ...extra
});

const frame = (id, x, y, w, h, extra = {}) => ({
  id,
  type: "frame",
  name: id,
  x,
  y,
  width: w,
  height: h,
  fills: [{ type: "solid", color: "#FFFFFF" }],
  children: [],
  ...extra
});

const applySetup = (elements) =>
  page.evaluate((els) => {
    const bridge = window.__FISH_BRIDGE__;
    const base = bridge.getDoc();
    bridge.setElements(els, { canvas: { ...base.canvas, width: 4000, height: 3000 } });
  }, elements);

const settle = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

/**
 * The hover outline's box, and the artwork's box, in viewport pixels.
 *
 * The dashed outline is a single dashed rect with no distinguishing marker, so it
 * is found by elimination: the only dashed rect on the canvas that is not part
 * of the selection chrome is this preview.
 */
const measureHover = (id) =>
  page.evaluate((elId) => {
    const art = document.querySelector(`[data-element-id="${elId}"] [data-hit="true"]`);
    if (!art) return null;
    const artBox = art.getBoundingClientRect();
    // The preview is the dashed rect drawn when hovering an unselected layer.
    const dashed = [...document.querySelectorAll("rect[stroke-dasharray]")].filter((r) => {
      const s = getComputedStyle(r);
      return s.strokeDasharray && s.strokeDasharray !== "none";
    });
    const hit = dashed.find((r) => {
      const b = r.getBoundingClientRect();
      return b.width > 4 && b.height > 4;
    });
    return { art: artBox, hover: hit ? hit.getBoundingClientRect() : null };
  }, id);

/** Hover the artwork's painted centre, with the selection modifier held. */
const cmdHoverOver = async (id) => {
  const m = await measureHover(id);
  if (!m) return null;
  const x = m.art.x + m.art.width / 2;
  const y = m.art.y + m.art.height / 2;
  await page.keyboard.down("Meta");
  await page.mouse.move(x, y);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await page.mouse.move(x + 1, y);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await page.keyboard.up("Meta");
  return measureHover(id);
};

const center = (b) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });

const scenario = async (name, elements, id, expectedTurn) => {
  await applySetup(elements);
  await settle();
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  // Zoom to fit first: the canvas is 4000×3000, so without it the frame starts
  // off-viewport and there is nothing to hover.
  await page.keyboard.press("Shift+Digit1");
  await settle();

  const after = await cmdHoverOver(id);
  if (!after || !after.hover) {
    check(`${name}: the hover preview appears`, false, true);
    return;
  }
  check(`${name}: the dashed outline appears`, true, true);
  const a = center(after.art);
  const c = center(after.hover);
  checkClose(`${name}: outline centre is on the artwork (x)`, c.x, a.x);
  checkClose(`${name}: outline centre is on the artwork (y)`, c.y, a.y);
  if (expectedTurn !== undefined) {
    // The box's own width/height must survive the turn too — a preview drawn as
    // an axis-aligned outline around a turned layer is a different size as well
    // as a different angle.
    checkClose(`${name}: outline matches the artwork width`, after.hover.width, after.art.width, 3);
    checkClose(`${name}: outline matches the artwork height`, after.hover.height, after.art.height, 3);
  }
};

// ------------------------------------- the reported case: frame AND content turned
await scenario(
  "frame and content both rotated",
  [frame("F", 600, 400, 400, 300, { rotation: -35, children: [plain("c", 40, 30, 120, 80, { rotation: 25 })] })],
  "c"
);

// ------------------------------------------------------- only the frame is turned
await scenario(
  "only the frame rotated",
  [frame("F", 600, 400, 400, 300, { rotation: -35, children: [plain("c", 40, 30, 120, 80)] })],
  "c"
);

// ------------------------------------------------------- only the content is turned
await scenario(
  "only the content rotated",
  [frame("F", 600, 400, 400, 300, { children: [plain("c", 40, 30, 120, 80, { rotation: 25 })] })],
  "c"
);

// ------------------------------------------ the untouched case must not move either
await scenario(
  "unrotated frame is unchanged",
  [frame("F", 600, 400, 400, 300, { children: [plain("c", 40, 30, 120, 80)] })],
  "c"
);

// ------------------------------------------------------ two turned ancestor levels
await scenario(
  "two levels of rotated ancestors",
  [
    frame("F", 600, 400, 400, 300, {
      rotation: -35,
      children: [frame("G", 30, 20, 200, 150, { rotation: 18, children: [plain("c", 15, 10, 90, 60)] })]
    })
  ],
  "c"
);

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(
    `${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : `  -> ${JSON.stringify(r.actual)} (expected ${JSON.stringify(r.expected)})`}`
  );
}
console.log(`\n${results.length - failed.length}/${results.length} passed`);
console.log("pageErrors", errors.slice(0, 5));

await browser.close();
process.exit(failed.length === 0 && errors.length === 0 ? 0 : 1);