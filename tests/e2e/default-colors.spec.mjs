import { chromium } from "playwright";
import { pathToFileURL } from "node:url";
import path from "node:path";

// What colour a new element starts in, checked in the real editor rather than
// against the constant: every entry point is exercised, because "the default"
// is not one value the code reads from one place unless all of them agree.
//
//   1. closed shapes — rect / ellipse / polygon land in the neutral grey
//   2. ink           — line / arrow / pen path land in black
//   3. the paint     — and the pixels agree: an arrow's head is part of its ink,
//                      not a white marker of its own
//
// The values live in `src/core/dsl/defaults.ts`. Per-type colours are exactly
// how this canvas ended up with a blue rectangle, a purple ellipse and a green
// polygon, so a tool that decides its own is the regression this file is for.
//
// An entry point that used to be here — an icon dragged out of the assets panel —
// is gone: the icon set is a plugin now and the shell has no grid left to drag
// from. What it asserted was a model question, not a painted one, and
// `tests/plugins.test.ts` (`icon insert`) already pins the same ink for both
// paint modes.
const html = path.resolve(process.cwd(), process.argv[2] ?? "dist/index.html");

/** The single source is `src/core/dsl/defaults.ts`; these are what it must stay. */
const NEUTRAL = "#D9D9D9";
const INK = "#000000";

const results = [];
const pageErrors = [];
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  results.push({ name, ok });
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.on("pageerror", (e) => pageErrors.push(String(e)));

await page.goto(pathToFileURL(html).href);
await page.waitForFunction(() => !!window.__FISH_BRIDGE__);
await page.evaluate(() => {
  const bridge = window.__FISH_BRIDGE__;
  const doc = bridge.getDoc();
  bridge.setElements([]);
});
await page.waitForTimeout(400);

const pageElements = () =>
  page.evaluate(() => {
    const doc = window.__FISH_BRIDGE__.getDoc();
    return JSON.parse(JSON.stringify(doc.pages.find((p) => p.id === doc.activePageId).children));
  });

/** The canvas is `absolute inset-0` and the panels float over it, so screen
 * points are read from the viewport and kept clear of both side panels. */
const anchor = await page.evaluate(() => {
  const r = document.querySelector("[data-canvas-root]").getBoundingClientRect();
  return { left: r.left, top: r.top };
});
const at = (dx, dy) => ({ x: Math.round(anchor.left + dx), y: Math.round(anchor.top + dy) });

const createdBy = async (run) => {
  const before = new Set((await pageElements()).map((el) => el.id));
  await run();
  await page.waitForTimeout(250);
  const created = (await pageElements()).find((el) => !before.has(el.id));
  await page.keyboard.press("Escape");
  await page.waitForTimeout(100);
  return created;
};

/** Drag a box with whichever tool is armed. */
const drawWith = (key, from, to) =>
  createdBy(async () => {
    await page.keyboard.press(key);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(Math.round((from.x + to.x) / 2), Math.round((from.y + to.y) / 2), { steps: 4 });
    await page.mouse.move(to.x, to.y, { steps: 4 });
    await page.mouse.up();
  });

/** Rect / polygon / arrow have no key, so the tool is armed through the menu. */
const armFromMenu = async (tool) => {
  await page.click('[data-shape-caret="true"]');
  await page.click(`[data-shape-item="${tool}"]`);
  await page.waitForTimeout(100);
};
const drawFromMenu = (tool, from, to) =>
  createdBy(async () => {
    await armFromMenu(tool);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(Math.round((from.x + to.x) / 2), Math.round((from.y + to.y) / 2), { steps: 4 });
    await page.mouse.move(to.x, to.y, { steps: 4 });
    await page.mouse.up();
  });

// ---- 1. closed shapes: the neutral grey ------------------------------------
const rect = await drawWith("r", at(400, 200), at(560, 300));
check("a rectangle is born in the neutral grey", rect?.fills?.[0]?.color === NEUTRAL, JSON.stringify(rect?.fills));

const ellipse = await drawWith("o", at(620, 200), at(760, 300));
check("an ellipse too", ellipse?.fills?.[0]?.color === NEUTRAL, JSON.stringify(ellipse?.fills));

const polygon = await drawFromMenu("polygon", at(820, 200), at(960, 300));
check(
  "and so is a polygon, which has no key of its own",
  polygon?.type === "polygon" && polygon?.fills?.[0]?.color === NEUTRAL,
  JSON.stringify(polygon?.fills)
);

// ---- 2. line drawings: black ------------------------------------------------
const line = await drawWith("l", at(400, 370), at(560, 370));
check("a line is ink, not grey", line?.strokes?.[0]?.color === INK, JSON.stringify(line?.strokes));

const arrow = await drawFromMenu("arrow", at(620, 370), at(780, 370));
check(
  "an arrow too",
  arrow?.type === "arrow" && arrow?.strokes?.[0]?.color === INK,
  JSON.stringify(arrow?.strokes)
);

// The pen is not a drag: click the anchors and Enter commits the path.
const pen = await createdBy(async () => {
  await page.keyboard.press("p");
  for (const p of [at(400, 460), at(470, 530), at(560, 460)]) {
    await page.mouse.click(p.x, p.y);
    await page.waitForTimeout(120);
  }
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
});
check("a pen path is ink too", pen?.type === "path" && pen?.strokes?.[0]?.color === INK, JSON.stringify(pen?.strokes));
check("and the pen actually produced a path", (pen?.d ?? "").length > 0, `${(pen?.d ?? "").length} chars`);

// ---- 3. the ink the renderer actually lays down -----------------------------
//
// A model assertion cannot see this one: the arrow's stroke was `#000000` while
// its head stayed white, because the head is a `<marker>` carrying a fill of its
// own. A colour written in two places is a colour that can disagree, and only
// painted pixels can say whether it did. The subject is probed alone, and every
// box is taken relative to the ink's own bounding box, so nothing below depends on
// how the canvas maps world coordinates to the screen.
const clearCanvas = async () => {
  await page.evaluate(() => {
    const bridge = window.__FISH_BRIDGE__;
    const doc = bridge.getDoc();
    bridge.setElements([]);
  });
  await page.waitForTimeout(300);
};

/** Painted pixels, read in-page. Serialising the live canvas into a data URL is
 * the only way to ask what was painted without a PNG decoder, and a data URL
 * rather than a blob URL is what keeps the canvas untainted (`file://` origins
 * taint it and `getImageData` then throws). */
const inkStats = () =>
  page.evaluate(async () => {
    const svg = document.querySelector("[data-canvas-root] svg");
    const rect = svg.getBoundingClientRect();
    const clone = svg.cloneNode(true);
    clone.setAttribute("width", String(Math.round(rect.width)));
    clone.setAttribute("height", String(Math.round(rect.height)));
    const img = new Image();
    await new Promise((res, rej) => {
      img.onload = res;
      img.onerror = rej;
      img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(new XMLSerializer().serializeToString(clone));
    });
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(rect.width);
    canvas.height = Math.round(rect.height);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const at = (x, y) => {
      const i = (y * canvas.width + x) * 4;
      return { a: data[i + 3], lum: 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2] };
    };
    const sample = (x0, y0, w, h) => {
      let darkest = 255;
      let opaque = 0;
      for (let y = y0; y < y0 + h; y++) {
        for (let x = x0; x < x0 + w; x++) {
          const p = at(x, y);
          if (p.a < 128) continue;
          opaque++;
          if (p.lum < darkest) darkest = p.lum;
        }
      }
      return { darkest: Math.round(darkest), opaque };
    };
    let darkest = 255;
    let opaque = 0;
    let minX = 1e9;
    let minY = 1e9;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < canvas.height; y++) {
      for (let x = 0; x < canvas.width; x++) {
        const p = at(x, y);
        if (p.a < 128) continue;
        opaque++;
        if (p.lum < darkest) darkest = p.lum;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    return {
      darkest: Math.round(darkest),
      opaque,
      box: [minX, minY, maxX, maxY],
      // A `stroke-width: 2` arrowhead is 20px long and widest at its back, while
      // the shaft only occupies a pixel either side of the axis — so a band along
      // the top of the ink's right end is head, and nothing but head.
      head: sample(maxX - 17, minY + 1, 14, 3),
      // Nothing is painted above the ink, so an empty band is the control that
      // says these numbers came from ink and not from a painted background.
      above: sample(minX, minY - 8, maxX - minX + 1, 4)
    };
  });

await clearCanvas();
await createdBy(async () => {
  await armFromMenu("arrow");
  await page.mouse.move(at(620, 370).x, at(620, 370).y);
  await page.mouse.down();
  await page.mouse.move(at(700, 370).x, at(700, 370).y, { steps: 4 });
  await page.mouse.move(at(780, 370).x, at(780, 370).y, { steps: 4 });
  await page.mouse.up();
});
await page.waitForTimeout(200);
const arrowInk = await inkStats();
check("the arrow puts ink on the canvas", arrowInk.opaque > 100, `${arrowInk.opaque} px`);
check(
  "and its head is painted in the shaft's own ink, not a marker's white",
  arrowInk.head.darkest < 90,
  `head darkest=${arrowInk.head.darkest} over ${arrowInk.head.opaque} px`
);
check("the probe reads ink, not a painted background", arrowInk.above.opaque === 0, `${arrowInk.above.opaque} px above it`);

check("no page errors", pageErrors.length === 0, pageErrors[0] || "");

await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0 || pageErrors.length > 0) {
  console.log("FAILED:", failed.map((f) => f.name).join(", "));
  process.exit(1);
}
