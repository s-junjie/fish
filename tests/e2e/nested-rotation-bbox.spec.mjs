import { chromium } from "playwright";
import { pathToFileURL } from "url";
import path from "path";

// The selection box has to land ON the artwork it frames.
//
// A child of a turned frame is painted INSIDE that frame's rotated group, so
// where it sits — and which way it faces — is not a sum of `x`/`y`. The box was
// computed as one, which is why it lined up perfectly until the frame had a
// `rotation` and then sat beside the artwork, at the wrong angle, offset by
// however far the frame's turn had carried the child.
//
// This spec measures both boxes off the live DOM — the artwork through
// `getBoundingClientRect`, the selection chrome through the overlay's own
// elements — rather than recomputing the geometry here, so it cannot drift away
// from what the canvas actually draws.

const html = path.resolve(process.cwd(), process.argv[2] ?? "dist/index.html");
const results = [];
const check = (name, actual, expected) =>
  results.push({ name, ok: JSON.stringify(actual) === JSON.stringify(expected), actual, expected });
const checkClose = (name, actual, expected, tol = 1.5) => {
  const ok =
    typeof actual === "number" &&
    Number.isFinite(actual) &&
    Math.abs(actual - expected) <= tol;
  results.push({ name, ok, actual, expected: `${expected} ±${tol}` });
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

const select = async (id) => {
  await page.evaluate((elId) => window.__FISH_BRIDGE__.selectElement(elId), id);
  await settle();
};

/**
 * The box's corners and the artwork's box, in viewport pixels.
 *
 * The corners come from the resize handles, whose CENTRES are exactly the box's
 * corners — the rotate hot zones are deliberately offset outward from them, so
 * measuring one of those would report a box that is correct but never matches.
 * The artwork is read off its own painted hit path.
 *
 * Everything is measured off the live DOM rather than recomputed here, so the
 * spec cannot drift away from what the canvas actually draws.
 */
const measure = (id) =>
  page.evaluate((elId) => {
    const center = (r) => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
    const box = (sel) => {
      const n = document.querySelector(sel);
      return n ? n.getBoundingClientRect() : null;
    };
    const art = document.querySelector(`[data-element-id="${elId}"] [data-hit="true"]`);
    const tl = box('[data-resize-handle="tl"]');
    const br = box('[data-resize-handle="br"]');
    if (!art || !tl || !br) return null;
    return {
      tl: center(tl),
      br: center(br),
      art: center(art.getBoundingClientRect())
    };
  }, id);

/**
 * The angle the box's own tl→br diagonal makes with the screen.
 *
 * On an UNROTATED w×h box that is `atan2(h, w)` — not 45°, which is only true of
 * a square and would quietly weaken the assertion on every other shape. Turning
 * the box by θ adds θ to that baseline.
 */
const diagonalAngle = (m) => (Math.atan2(m.br.y - m.tl.y, m.br.x - m.tl.x) * 180) / Math.PI;
const baseDiagonal = (w, h) => (Math.atan2(h, w) * 180) / Math.PI;

/** The centre of the box, as the user sees it. */
const boxCentre = (m) => ({ x: (m.tl.x + m.br.x) / 2, y: (m.tl.y + m.br.y) / 2 });

const scenario = async (name, elements, childId, childBox, expectedTurn) => {
  await applySetup(elements);
  await settle();
  await select(childId);
  const m = await measure(childId);
  if (!m) {
    check(`${name}: the artwork and its box are both on screen`, false, true);
    return null;
  }
  const c = boxCentre(m);
  checkClose(`${name}: the box is centred on the artwork (x)`, c.x, m.art.x);
  checkClose(`${name}: the box is centred on the artwork (y)`, c.y, m.art.y);
  if (expectedTurn !== undefined) {
    checkClose(
      `${name}: the box is turned by the frame and the content`,
      diagonalAngle(m),
      baseDiagonal(childBox.width, childBox.height) + expectedTurn,
      2
    );
  }
  return m;
};

const C = { x: 40, y: 30, width: 120, height: 80 };

// ------------------------------------------------- the reported case: both turned
await scenario(
  "frame and content both rotated",
  [frame("F", 600, 400, 400, 300, { rotation: -35, children: [plain("c", 40, 30, 120, 80, { rotation: 25 })] })],
  "c",
  C,
  -10
);

// ------------------------------------------------------- only the frame is turned
await scenario(
  "only the frame rotated",
  [frame("F", 600, 400, 400, 300, { rotation: -35, children: [plain("c", 40, 30, 120, 80)] })],
  "c",
  C,
  -35
);

// ------------------------------------------------------- only the content is turned
await scenario(
  "only the content rotated",
  [frame("F", 600, 400, 400, 300, { children: [plain("c", 40, 30, 120, 80, { rotation: 25 })] })],
  "c",
  C,
  25
);

// --------------------------------------------------- two levels of turned frames
await scenario(
  "two levels of rotated ancestors",
  [
    frame("F", 600, 400, 400, 300, {
      rotation: -35,
      children: [frame("G", 30, 20, 200, 150, { rotation: 18, children: [plain("c", 15, 10, 90, 60)] })]
    })
  ],
  "c",
  { width: 90, height: 60 },
  -17
);

// ------------------------------------- a turned frame that is nested in a turned one
await scenario(
  "deeply nested under two turned frames",
  [
    frame("F", 600, 400, 500, 400, {
      rotation: 20,
      children: [
        frame("G", 40, 30, 300, 220, {
          rotation: -50,
          children: [plain("c", 20, 15, 100, 70, { rotation: 40 })]
        })
      ]
    })
  ],
  "c",
  { width: 100, height: 70 },
  10
);

// ------------------------------------------ the untouched case must not move either
await scenario(
  "unrotated frame is unchanged",
  [frame("F", 600, 400, 400, 300, { children: [plain("c", 40, 30, 120, 80)] })],
  "c",
  C,
  0
);

await scenario(
  "a turned top-level layer is unchanged",
  [plain("loose", 600, 400, 160, 100, { rotation: 30 })],
  "loose",
  { width: 160, height: 100 },
  30
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
