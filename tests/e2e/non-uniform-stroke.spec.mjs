import { chromium } from "playwright";
import { pathToFileURL } from "url";
import path from "node:path";

// The one-shot side renderer (`stroke.side`) is the only consumer of
// `renderNonUniformStroke`, which now lives in `ui/canvas/non-uniform-stroke.tsx`.
// Nothing else renders it, so this spec is the only proof that the extracted
// module is wired into the built shell and still paints the right edges.
//
//   side:"top"  — one line on the top edge, nothing on the other three
//   side:"all"  — the control: all four edges
//   rounded     — mismatched per-side weights (16/16/16/24) on a rounded box:
//                 the corner must still follow the radius, and the BL corner
//                 specifically must sweep the short way round it
//   outside     — the same box with outside align and the screenshot's
//                 weights (50/24/13/13): every side must land outside the
//                 shape, corners included
//
// Probing is in world coordinates and the SVG is rasterised through a canvas, so
// the assertions do not depend on the default pan/zoom.
const html = path.resolve(process.cwd(), process.argv[2] ?? "dist/index.html");

const TOP = { id: "nus_top", type: "rect", name: "Top Only", x: 200, y: 200, width: 300, height: 200 };
const ALL = { id: "nus_all", type: "rect", name: "All Sides", x: 600, y: 200, width: 300, height: 200 };
// Rounded, with a four-sided border that is NOT uniform — the case that used to
// draw four straight edges around a corner the shape never had.
const ROUNDED = { id: "nus_rounded", type: "rect", name: "Rounded Sides", x: 1000, y: 200, width: 300, height: 200, borderRadius: 40 };
const R = 40;
// Top-right corner arc: centre at (x + w - R, y + R), sampled at 45° along it.
const ARC_X = 1000 + 300 - R + R * Math.SQRT1_2;
const ARC_Y = 200 + R - R * Math.SQRT1_2;
// Bottom-left corner arc: centre at (x + bl, y + h - bl), sampled on the 135°
// diagonal at mid-band of the 24-wide corner (the band spans radius 28..52).
// The BL arc runs left-point to bottom-point, the one direction whose short way
// round the corner is counter-clockwise; with the wrong sweep it bulges across
// the corner instead of following it, and this point goes bare.
const BL_X = 1000 + R - 34 * Math.SQRT1_2;
const BL_Y = 200 + (200 - R) + 34 * Math.SQRT1_2;
// Outside align, the screenshot's weights. The bottom band must sit BELOW the
// shape (it used to be drawn at h - w/2, inside, and the mask ate it), and the
// top-right corner must stay a true arc on its own centre (it used to re-solve
// the circle through mismatched endpoints and cut across the corner).
// Placed below ROUNDED so every probed point stays inside the rasterised
// stage — the spec samples the cloned SVG at its layout size, and anything
// past the right edge of the viewport is clipped away before it is read.
const OUTSIDE = { id: "nus_outside", type: "rect", name: "Outside Sides", x: 1000, y: 500, width: 300, height: 200, borderRadius: 40 };
const OUT_BOTTOM_X = 1000 + 150;
const OUT_BOTTOM_Y = 500 + 200 + 8;
const OUT_TR_X = 1000 + 260 + 80 * Math.cos((-11.3 * Math.PI) / 180);
const OUT_TR_Y = 500 + 40 + 80 * Math.sin((-11.3 * Math.PI) / 180);

const ELEMENTS = [
  { ...TOP, strokes: [{ width: 16, color: "#FF0000", side: "top" }] },
  { ...ALL, strokes: [{ width: 16, color: "#FF0000", side: "all" }] },
  { ...ROUNDED, strokes: [{ width: 16, color: "#FF0000", side: "custom", sides: { top: 16, right: 16, bottom: 16, left: 24 } }] },
  { ...OUTSIDE, strokes: [{ width: 0, color: "#FF0000", side: "custom", sides: { top: 50, right: 24, bottom: 13, left: 13 }, align: "outside" }] }
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
  bridge.setElements(JSON.parse(JSON.stringify(elements)), { canvas: { ...base.canvas, width: 1920, height: 1080 } });
}, ELEMENTS);
await page.waitForTimeout(600);

const sample = (points) =>
  page.evaluate(async (pts) => {
    const svg = document.querySelector("svg.pointer-events-auto");
    const clone = svg.cloneNode(true);
    const img = new Image();
    await new Promise((res, rej) => {
      img.onload = res;
      img.onerror = rej;
      img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(new XMLSerializer().serializeToString(clone));
    });
    const canvas = document.createElement("canvas");
    canvas.width = svg.clientWidth || 1600;
    canvas.height = svg.clientHeight || 1000;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const m = /translate\((-?[\d.]+), (-?[\d.]+)\) scale\(([\d.]+)\)/.exec((() => { const s = document.querySelector("[data-stage-transform]"); const a = s && s.getAttribute("transform"); if (a) return a; const svg = s && s.ownerSVGElement; const t = svg ? getComputedStyle(svg).transform : ""; const m = /matrix\(([\d.eE+-]+), 0, 0, ([\d.eE+-]+), ([\d.eE+-]+), ([\d.eE+-]+)\)/.exec(t); return m ? "translate(" + m[3] + ", " + m[4] + ") scale(" + m[1] + ")" : null; })());
    const pan = { x: parseFloat(m[1]), y: parseFloat(m[2]) };
    const zoom = parseFloat(m[3]);
    const out = {};
    for (const [name, x, y] of pts) {
      const d = ctx.getImageData(Math.round(pan.x + x * zoom), Math.round(pan.y + y * zoom), 1, 1).data;
      out[name] = { r: d[0], g: d[1], b: d[2] };
    }
    return out;
  }, points);

const isRed = (p) => p.r > 200 && p.g < 80 && p.b < 80;
const fmt = (p) => `rgb(${p.r},${p.g},${p.b})`;

const px = await sample([
  ["top_top", 350, 208],
  ["top_bottom", 350, 392],
  ["top_left", 208, 300],
  ["top_right", 492, 300],
  ["all_top", 750, 208],
  ["all_bottom", 750, 392],
  ["all_left", 608, 300],
  ["all_right", 892, 300],
  ["rounded_arc", ARC_X, ARC_Y],
  ["rounded_top", 1150, 200],
  ["rounded_left", 1000, 300],
  ["rounded_bl", BL_X, BL_Y],
  ["out_bottom", OUT_BOTTOM_X, OUT_BOTTOM_Y],
  ["out_tr", OUT_TR_X, OUT_TR_Y]
]);

check("side:top paints the top edge", isRed(px.top_top), fmt(px.top_top));
check("side:top leaves the bottom edge bare", !isRed(px.top_bottom), fmt(px.top_bottom));
check("side:top leaves the left edge bare", !isRed(px.top_left), fmt(px.top_left));
check("side:top leaves the right edge bare", !isRed(px.top_right), fmt(px.top_right));
check("control: side:all paints all four edges", [px.all_top, px.all_bottom, px.all_left, px.all_right].every(isRed), [px.all_top, px.all_bottom, px.all_left, px.all_right].map(fmt).join(" "));
check("a per-side border follows the corner radius", isRed(px.rounded_arc), `${fmt(px.rounded_arc)} at (${ARC_X.toFixed(1)}, ${ARC_Y.toFixed(1)})`);
check("a per-side border still paints its edges", isRed(px.rounded_top) && isRed(px.rounded_left), [px.rounded_top, px.rounded_left].map(fmt).join(" "));
check("the BL corner sweeps the short way round the radius", isRed(px.rounded_bl), `${fmt(px.rounded_bl)} at (${BL_X.toFixed(1)}, ${BL_Y.toFixed(1)})`);
check("outside align puts the bottom band below the shape", isRed(px.out_bottom), `${fmt(px.out_bottom)} at (${OUT_BOTTOM_X.toFixed(1)}, ${OUT_BOTTOM_Y.toFixed(1)})`);
check("outside align keeps the corner arc on its own centre", isRed(px.out_tr), `${fmt(px.out_tr)} at (${OUT_TR_X.toFixed(1)}, ${OUT_TR_Y.toFixed(1)})`);
check("no page errors", errors.length === 0, errors.join(" | "));

await browser.close();
const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(passed === results.length ? 0 : 1);
