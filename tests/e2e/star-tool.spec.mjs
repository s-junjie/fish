import { chromium } from "playwright";
import { pathToFileURL } from "url";
import path from "path";

// The star tool, driven the way a person drives it: pick it from the dock's
// shape dropdown, drag on the canvas, then read the painted pixels. The unit
// tests already pin the outline arithmetic, so what is left to prove here is the
// half that only exists in a browser — that the dock arms the tool, the drag
// creates a `star` rather than a rect, the renderer paints a star with a hole in
// the middle, and the three inspector controls move the real geometry.
const html = path.resolve(process.cwd(), process.argv[2] ?? "dist/index.html");
const results = [];
const check = (name, ok, detail) =>
  results.push({ name, ok: !!ok, detail }) &&
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});

await page.goto(pathToFileURL(html).href);
await page.waitForFunction(() => !!window.__FISH_BRIDGE__);

// Empty canvas, so the draw drag starts on nothing and cannot grab a layer.
await page.evaluate(() => {
  const bridge = window.__FISH_BRIDGE__;
  const base = bridge.getDoc();
  bridge.setElements([], { canvas: { ...base.canvas, width: 3000, height: 2000 } });
});

const canvasBox = await page.evaluate(() =>
  document.querySelector("[data-canvas-root]").getBoundingClientRect().toJSON()
);
check("canvas root is the full window", canvasBox.x === 0 && canvasBox.y === 0, JSON.stringify(canvasBox));

// Zoom-to-fit means the canvas does NOT open at 1:1, so every world coordinate
// below is derived from the canvas's own stage transform rather than assumed.
const view = await page.evaluate(() => {
  const attr = (() => { const s = document.querySelector("[data-stage-transform]"); const a = s && s.getAttribute("transform"); if (a) return a; const svg = s && s.ownerSVGElement; const t = svg ? getComputedStyle(svg).transform : ""; const m = /matrix\(([\d.eE+-]+), 0, 0, ([\d.eE+-]+), ([\d.eE+-]+), ([\d.eE+-]+)\)/.exec(t); return m ? "translate(" + m[3] + ", " + m[4] + ") scale(" + m[1] + ")" : null; })();
  const t = /translate\(([-\d.]+), ([-\d.]+)\) scale\(([-\d.]+)\)/.exec(attr);
  return { panX: Number(t[1]), panY: Number(t[2]), zoom: Number(t[3]) };
});
check("the canvas transform is readable", Number.isFinite(view.zoom) && view.zoom > 0, JSON.stringify(view));

// --- arm the star from the dock -------------------------------------------
// The dropdown only exists once `shapeMenuOpen` is true, and Preact has to
// re-render before the entries are in the DOM — so opening and picking are two
// steps with a wait between them, not one evaluate.
await page.click('[data-shape-caret="true"]');
await page.waitForSelector('[data-shape-item="star"]', { timeout: 5000 }).catch(() => {});
const armed = await page.evaluate(() => {
  const item = document.querySelector('[data-shape-item="star"]');
  if (!item) return false;
  item.click();
  return true;
});
check("the shape dropdown offers a star entry", armed === true);

// The dock swaps its glyph to whatever shape is armed. Compared against the
// entry we just clicked rather than a lucide class name, which is not in the DOM.
const icons = await page.evaluate(() => {
  const dockPath = document.querySelector('[data-tool="shape"] svg path');
  return { dock: dockPath?.getAttribute("d")?.slice(0, 24) ?? null };
});
check(
  "the dock's shape button now shows a star glyph",
  typeof icons.dock === "string" && icons.dock.startsWith("M11.525"),
  icons.dock ?? "none"
);

// Drag a box well clear of every panel, in SCREEN pixels off the canvas box.
const PRESS = { x: canvasBox.x + 700, y: canvasBox.y + 300 };
const DRAG = 200;
await page.mouse.move(PRESS.x, PRESS.y);
await page.mouse.down();
await page.mouse.move(PRESS.x + DRAG, PRESS.y + DRAG, { steps: 12 });
await page.mouse.up();

const created = await page.evaluate(() => {
  const doc = window.__FISH_BRIDGE__.getDoc();
  const pg = doc.pages.find((p) => p.id === doc.activePageId) ?? doc;
  const els = pg.children ?? [];
  return els.length === 1 ? els[0] : { count: els.length, types: els.map((e) => e.type) };
});
check("the drag created exactly one element", created.count === undefined, JSON.stringify(created));
check("it is a star", created.type === "star", `type=${created.type}`);
check("named Star", created.name === "Star", `name=${created.name}`);
check(
  "with Figma's defaults",
  created.points === 5 && created.innerRadius === 0.382,
  `points=${created.points} inner=${created.innerRadius}`
);

// The drag is corner-anchored like every other FISH shape, so the world box is
// the screen delta divided by the zoom we read off the svg.
const expectSide = Math.round(DRAG / view.zoom);
check(
  `the drag made a ${expectSide}x${expectSide} box`,
  created.width === expectSide && created.height === expectSide,
  `${created.width}x${created.height}`
);
check(
  "the box starts where the press was, in world coordinates",
  created.x === Math.round((PRESS.x - canvasBox.x - view.panX) / view.zoom) &&
    created.y === Math.round((PRESS.y - canvasBox.y - view.panY) / view.zoom),
  `${created.x},${created.y}`
);

const STAR_ID = created.id;
const readStar = () =>
  page.evaluate((id) => {
    const doc = window.__FISH_BRIDGE__.getDoc();
    const pg = doc.pages.find((p) => p.id === doc.activePageId) ?? doc;
    return (pg.children ?? []).find((e) => e.id === id);
  }, STAR_ID);
const paintedD = () =>
  page.evaluate(
    (id) => document.querySelector(`[data-element-id="${id}"] path`)?.getAttribute("d") || "",
    STAR_ID
  );

// --- what is painted ------------------------------------------------------
const d0 = await paintedD();
check("the star is painted", d0.length > 0, d0.slice(0, 60));
check(
  "its outline has ten vertices at the default five points",
  (d0.match(/L/g) || []).length === 9,
  `${(d0.match(/L/g) || []).length} line commands`
);
check("and no corner radius yet, so the outline is hard-edged", !d0.includes("C"));

// The ink sits inside the model box rather than filling it — a 5-point star
// inscribed in a circle leaves the corners empty. Derived from getBBox, so it
// is zoom-independent.
const ink = await page.evaluate((id) => {
  const bb = document.querySelector(`[data-element-id="${id}"] path`).getBBox();
  return { w: bb.width, h: bb.height, top: bb.y };
}, STAR_ID);
check(
  "the ink is inset from its box, as an inscribed star must be",
  ink.w < created.width && ink.h < created.height,
  `ink ${ink.w.toFixed(1)}x${ink.h.toFixed(1)} in a ${created.width} box`
);
check("the top tip touches the box top", Math.abs(ink.top) < 0.01, `y=${ink.top}`);

// The claim only pixels can settle. A 5-point star is a SOLID ten-vertex
// outline — the spikes come from concave valleys between the tips, NOT from a
// hole, so "the centre is empty" is a false test. What separates a star from a
// disc is that some horizontal scan crosses the outline twice: a convex shape
// fills exactly one run on every row, a star leaves a notch open between two
// spikes. Judged on COLOUR, since the clone has a transparent (not page) ground.
const shape = await page.evaluate(async () => {
  const svg = document.querySelector("[data-canvas-root] svg");
  const rect = svg.getBoundingClientRect();
  const clone = svg.cloneNode(true);
  clone.setAttribute("width", String(Math.round(rect.width)));
  clone.setAttribute("height", String(Math.round(rect.height)));
  const img = new Image();
  await new Promise((res, rej) => {
    img.onload = res;
    img.onerror = rej;
    img.src =
      "data:image/svg+xml;charset=utf-8," +
      encodeURIComponent(new XMLSerializer().serializeToString(clone));
  });
  const c = document.createElement("canvas");
  c.width = Math.round(rect.width);
  c.height = Math.round(rect.height);
  const ctx = c.getContext("2d");
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, c.width, c.height).data;
  const ink = (x, y) => data[(Math.round(y) * c.width + Math.round(x)) * 4 + 3] >= 128;

  // Find the ink's own bbox first: the clone's user space does not line up with
  // the viewport, so hardcoded offsets sample empty canvas and answer nothing.
  let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
  for (let y = 0; y < c.height; y++) {
    for (let x = 0; x < c.width; x++) {
      if (ink(x, y)) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }

  // Every row of the ink, counted as disjoint runs.
  let maxRuns = 0;
  let splitRows = 0;
  for (let y = minY; y <= maxY; y++) {
    let runs = 0;
    let inRun = false;
    for (let x = minX; x <= maxX; x++) {
      if (ink(x, y)) {
        if (!inRun) runs++;
        inRun = true;
      } else inRun = false;
    }
    if (runs > maxRuns) maxRuns = runs;
    if (runs > 1) splitRows++;
  }
  return {
    inkW: maxX - minX,
    inkH: maxY - minY,
    maxRuns,
    splitRows,
    // A control that must be empty, so the run count cannot be counting a
    // background: the band above the ink is outside every panel.
    bandAboveOpaque: (() => {
      for (let x = minX; x <= maxX; x++) if (ink(x, minY - 8)) return true;
      return false;
    })()
  };
});

check("the star painted a body", shape.inkW > 20 && shape.inkH > 20, `${shape.inkW}x${shape.inkH}`);
check("a control band above the ink is empty", shape.bandAboveOpaque === false);
check(
  "some rows cross the outline twice — it is concave, not a disc",
  shape.maxRuns >= 2,
  `max ${shape.maxRuns} runs`
);
check(
  "and the notch is open over a real span of rows, not one antialiased line",
  shape.splitRows >= 3,
  `${shape.splitRows} split rows`
);

// --- the inspector's three controls --------------------------------------
await page.evaluate((id) => window.__FISH_BRIDGE__.selectElement(id), STAR_ID);
await page.waitForTimeout(400);
const titles = await page.evaluate(() =>
  [...document.querySelectorAll('[data-ui-panel="right"] [title]')].map((n) => n.getAttribute("title"))
);
check("the inspector offers Points", titles.includes("Points"), JSON.stringify(titles.slice(0, 8)));
check("the inspector offers Inner radius", titles.includes("Inner radius · 100% = polygon"));
check("the inspector offers Corner radius", titles.includes("Corner Radius"));
check("the inspector offers Corner smoothing", titles.includes("Corner smoothing"));
check("the iOS preset is on the same panel", await page.evaluate(() => Boolean(document.querySelector('[data-corner-preset="ios"]'))));

/**
 * Type into a ScrubInput and COMMIT it. `fill` alone only fires `input`, and
 * ScrubInput is draft-semantics: it holds the typed string in local state and
 * writes the document on Enter or blur, so a fill that never commits is a
 * silently-passing assertion.
 */
const setField = async (title, value) => {
  const sel = `[data-ui-panel="right"] [title="${title}"] input`;
  if ((await page.locator(sel).count()) === 0) return false;
  await page.fill(sel, String(value));
  await page.press(sel, "Enter");
  await page.waitForTimeout(200);
  return true;
};

// The two corner controls, driven through the real inputs. The pair is the point:
// the radius sets how DEEP the corner is cut and the smoothing how ROUND it is,
// and neither may move the other's value.
check("the radius field is reachable", await setField("Corner Radius", 18));
const radiused = await readStar();
check("the radius control wrote the document", radiused?.cornerRadius === 18, `stored=${radiused?.cornerRadius}`);
const dRadius = await paintedD();
check("a radius alone rounds every corner", (dRadius.match(/C/g) || []).length === 10);
const cutAfterRadius = /^M ([-\d.]+) ([-\d.]+)/.exec(dRadius);

check("the smoothing field is reachable", await setField("Corner smoothing", 100));
const smoothed = await readStar();
const dSmooth = await paintedD();
check("the smoothing control wrote the document", smoothed?.cornerSmoothing === 1, `stored=${smoothed?.cornerSmoothing}`);
check(
  "and the renderer repainted every one of the ten corners as a curve",
  (dSmooth.match(/C/g) || []).length === 10,
  `${(dSmooth.match(/C/g) || []).length} curves`
);
// Smoothing changes the corner's character, NOT how deep it is cut. Same M point
// before and after is what proves the two controls are not the same knob.
check(
  "smoothing did not move the cut-back, so the radius still owns depth",
  /^M ([-\d.]+) ([-\d.]+)/.exec(dSmooth).slice(1).join() === cutAfterRadius.slice(1).join(),
  `cut ${cutAfterRadius?.slice(1).join()} -> ${/^M ([-\d.]+) ([-\d.]+)/.exec(dSmooth)?.slice(1).join()}`
);
// The tip is gone, because a radius of 18 out of a 250 box blunts it.
const inkSmooth = await page.evaluate((id) => {
  const bb = document.querySelector(`[data-element-id="${id}"] path`).getBBox();
  return { top: bb.y, h: bb.height };
}, STAR_ID);
check("the tip is gone once the corners are rounded", inkSmooth.top > 1, `top=${inkSmooth.top.toFixed(2)}`);

check("the iOS preset is clickable", await page.evaluate(() => {
  const b = document.querySelector('[data-corner-preset="ios"]');
  if (!b) return false;
  b.click();
  return true;
}));
await page.waitForTimeout(250);
const ios = await readStar();
check("and it writes Figma's 0.6", ios?.cornerSmoothing === 0.6, `stored=${ios?.cornerSmoothing}`);

check("the points field is reachable", await setField("Points", 3));
const repointed = await readStar();
const d3 = await paintedD();
check("the points control wrote the document", repointed?.points === 3, `stored=${repointed?.points}`);
// Smoothing is still on from the step above, so each corner is exactly one curve
// and the curve count IS the corner count — three points, six vertices.
check(
  "a 3-point star has six corners",
  (d3.match(/C/g) || []).length === 6,
  `${(d3.match(/C/g) || []).length} curves`
);

// Inner radius is the third control. Smoothing goes back to 0 first, so the six
// VERTICES are the outline and their radii can be read straight off — with
// smoothing on, the arc endpoints sit at the cut-back points, not on the
// circumradius, and would say nothing about the spike depth.
// Back to a hard edge so the six VERTICES are the outline and their radii can be
// read straight off — with smoothing on, the endpoints are cut-back points.
check("the radius returns to 0", await setField("Corner Radius", 0));
check("the inner radius field is reachable", await setField("Inner radius · 100% = polygon", 90));
const wide = await readStar();
check("the inner radius control wrote the document", wide?.innerRadius === 0.9, `stored=${wide?.innerRadius}`);
const dWide = await paintedD();
const vertexRadii = (d, cx, cy) => {
  const nums = (d.match(/[ML]\s+[-\d.]+\s+[-\d.]+/g) || []).map((m) =>
    m.split(/\s+/).slice(1).map(Number)
  );
  return nums.map(([x, y]) => Math.hypot(x - cx, y - cy));
};
const cx = wide.width / 2;
const rWide = vertexRadii(dWide, cx, wide.height / 2);
check("a hard-edged 3-point star has six vertices", rWide.length === 6, `${rWide.length}`);
check(
  "at 90% the vertices alternate between 90% and 100% of the outer radius",
  Math.min(...rWide) > cx * 0.89 &&
    Math.min(...rWide) < cx * 0.91 &&
    Math.max(...rWide) > cx * 0.99 &&
    Math.max(...rWide) <= cx + 0.01,
  `radii ${Math.min(...rWide).toFixed(1)}..${Math.max(...rWide).toFixed(1)} of ${cx}`
);

// --- and the whole thing survives the export path -------------------------
const exported = await page.evaluate(
  (id) =>
    new XMLSerializer().serializeToString(
      document.querySelector(`[data-element-id="${id}"]`).cloneNode(true)
    ),
  STAR_ID
);
check(
  "the star serialises with real geometry, not a placeholder",
  exported.includes("<path") && / d="M\s[-\d.]/.test(exported),
  exported.slice(exported.indexOf("<path"), exported.indexOf("<path") + 70)
);

await page.screenshot({ path: ".workbuddy/artifacts/star-tool.png" });
const panel = await page.$('[data-ui-panel="right"]');
if (panel) await panel.screenshot({ path: ".workbuddy/artifacts/star-inspector.png" });

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed, ${errors.length} console errors`);
if (errors.length) console.log("page errors:\n" + errors.slice(0, 8).join("\n"));
await browser.close();
process.exit(failed.length === 0 && errors.length === 0 ? 0 : 1);