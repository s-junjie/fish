import { chromium } from "playwright";
import { pathToFileURL } from "node:url";
import path from "node:path";

// Where the DRAWN line sits inside the box the author sees.
//
// CSS applies `letter-spacing` after every character, the last one included, so
// the box the browser reserves for a line is exactly one tracking wider than the
// ink in it. Alignment is computed against that reserved box, which left centred
// text half a tracking left of centre and right-aligned text a whole tracking
// short of the right edge — in the export as well as on the canvas, because both
// align the width the browser reports.
//
// The box is NOT the thing to shrink: measured, `"Hello world"` at 24px tracked
// by 4 laid out as ONE line in the reserved 162.7px box and as TWO in the 158.7px
// ink-width one. So the fix moves the painted line instead — a margin on the
// wrapper, NOT a CSS transform: WebKit drops an ancestor `transform` for a
// `foreignObject` whose HTML content creates a containing block, and a translate
// there painted the whole text at the SVG origin in Safari. This spec measures
// the ink (`Range.getBoundingClientRect` over the text node) against the
// element's own box, which is the thing a person judges "centred" by.
//
// The untracked pair is the control: it has to stay put, or the fix has moved
// text nobody asked it to move.
const html = path.resolve(process.cwd(), process.argv[2] ?? "dist/index.html");
const results = [];
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  results.push({ name, ok: !!ok });
}

const TRACKING = 8;

const ELEMENTS = () => [
  {
    id: "mid_plain",
    type: "text",
    name: "mid-plain",
    x: 100,
    y: 100,
    width: 400,
    height: 60,
    content: "Centre me",
    style: { fontFamily: "Inter", fontSize: 24, color: "#000000", align: "center", fontVariantNumeric: "normal" }
  },
  {
    id: "mid_tracked",
    type: "text",
    name: "mid-tracked",
    x: 100,
    y: 200,
    width: 400,
    height: 60,
    content: "Centre me",
    style: {
      fontFamily: "Inter",
      fontSize: 24,
      color: "#000000",
      align: "center",
      letterSpacing: TRACKING,
      fontVariantNumeric: "normal"
    }
  },
  {
    id: "end_plain",
    type: "text",
    name: "end-plain",
    x: 100,
    y: 300,
    width: 400,
    height: 60,
    content: "Right me",
    style: { fontFamily: "Inter", fontSize: 24, color: "#000000", align: "right", fontVariantNumeric: "normal" }
  },
  {
    id: "end_tracked",
    type: "text",
    name: "end-tracked",
    x: 100,
    y: 400,
    width: 400,
    height: 60,
    content: "Right me",
    style: {
      fontFamily: "Inter",
      fontSize: 24,
      color: "#000000",
      align: "right",
      letterSpacing: TRACKING,
      fontVariantNumeric: "normal"
    }
  }
];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });

await page.goto(pathToFileURL(html).href);
await page.waitForFunction(() => !!window.__FISH_BRIDGE__ && !!window.__fish);

await page.evaluate((elements) => {
  const base = window.__FISH_BRIDGE__.getDoc();
  window.__FISH_BRIDGE__.applyDoc(
    window.__fish.normalize({
      ...base,
      canvas: { width: 900, height: 600 },
      pages: [{ id: "p1", name: "Page 1", children: elements }],
      activePageId: "p1"
    }).document
  );
}, ELEMENTS());

/**
 * The element's own box, and the extent of the GLYPHS painted inside it.
 *
 * A `Range` over the whole text node reports the inline box, which includes the
 * trailing `letter-spacing` — the very thing under test — so measuring it would
 * measure the reserved box back and prove nothing. The first character's rect
 * gives the glyph start, and the LAST character's rect ends one tracking past
 * its glyph, so the tracking (scaled like everything else on the canvas) comes
 * back off. What is left is the ink: the part a person sees.
 *
 * The scale is not assumed: it is the rendered box over the document's own
 * width, because the canvas opens fitted rather than at 1:1.
 */
const geometryOf = (id) =>
  page.evaluate(({ id, tracking }) => {
    const doc = window.__FISH_BRIDGE__.getDoc();
    const els = doc.pages.find((p) => p.id === doc.activePageId).children;
    const spec = els.find((e) => e.id === id);
    const svg = document.querySelector("[data-element-id]").closest("svg");
    const group = svg.querySelector(`[data-element-id="${id}"]`);
    if (!group) return { missing: true };
    const foreign = group.querySelector("foreignObject");
    const box = foreign.getBoundingClientRect();
    const wrapper = foreign.firstElementChild;
    const div = wrapper.firstElementChild;
    const node = div.firstChild;
    const n = node.nodeValue.length;
    const rectOf = (from, to) => {
      const r = document.createRange();
      r.setStart(node, from);
      r.setEnd(node, to);
      return r.getBoundingClientRect();
    };
    const first = rectOf(0, 1);
    const last = rectOf(n - 1, n);
    const scale = box.width / spec.width;
    const trail = (spec.style?.letterSpacing || 0) * scale;
    return {
      scale,
      boxLeft: box.left,
      boxRight: box.right,
      boxCx: box.left + box.width / 2,
      inkLeft: first.left,
      inkRight: last.right - trail,
      inkCx: (first.left + last.right - trail) / 2,
      wrapperShift: Number.parseFloat(getComputedStyle(wrapper).marginLeft) || 0
    };
  }, { id, tracking: TRACKING });

const plainMid = await geometryOf("mid_plain");
const trackMid = await geometryOf("mid_tracked");
const plainEnd = await geometryOf("end_plain");
const trackEnd = await geometryOf("end_tracked");

const rendered =
  !plainMid.missing && !trackMid.missing && !plainEnd.missing && !trackEnd.missing;
check("all four texts render", rendered);
check(
  "the tracked elements really carry the shift, so the test is not a no-op",
  trackMid.wrapperShift !== 0 && trackEnd.wrapperShift !== 0,
  `centre=${trackMid.wrapperShift} right=${trackEnd.wrapperShift}`
);

const TOL = 1;

check(
  "centre: untracked ink is centred (control)",
  Math.abs(plainMid.inkCx - plainMid.boxCx) <= TOL,
  `ink cx=${plainMid.inkCx.toFixed(2)} box cx=${plainMid.boxCx.toFixed(2)} delta=${(plainMid.inkCx - plainMid.boxCx).toFixed(2)}`
);
check(
  "centre: tracked ink is centred too, not half a tracking left",
  Math.abs(trackMid.inkCx - trackMid.boxCx) <= TOL,
  `ink cx=${trackMid.inkCx.toFixed(2)} box cx=${trackMid.boxCx.toFixed(2)} delta=${(trackMid.inkCx - trackMid.boxCx).toFixed(2)} (before the fix: ${(-TRACKING * trackMid.scale / 2).toFixed(2)})`
);
check(
  "right: untracked ink ends at the box's right edge (control)",
  Math.abs(plainEnd.inkRight - plainEnd.boxRight) <= TOL,
  `ink right=${plainEnd.inkRight.toFixed(2)} box right=${plainEnd.boxRight.toFixed(2)} delta=${(plainEnd.inkRight - plainEnd.boxRight).toFixed(2)}`
);
check(
  "right: tracked ink ends at the box's right edge, not a whole tracking short",
  Math.abs(trackEnd.inkRight - trackEnd.boxRight) <= TOL,
  `ink right=${trackEnd.inkRight.toFixed(2)} box right=${trackEnd.boxRight.toFixed(2)} delta=${(trackEnd.inkRight - trackEnd.boxRight).toFixed(2)} (before the fix: ${(-TRACKING * trackEnd.scale).toFixed(2)})`
);

/**
 * The other half: the box did not move. `el.width` is the browser's reserved
 * width, and shrinking it to the ink width is what makes the browser wrap early.
 * A tracked line that fits its box on one line has to keep fitting.
 */
const linesOf = (id) =>
  page.evaluate((id) => {
    const group = document.querySelector(`[data-element-id="${id}"]`);
    const foreign = group.querySelector("foreignObject");
    const div = foreign.firstElementChild.firstElementChild;
    const lineHeight = parseFloat(getComputedStyle(div).lineHeight);
    return Math.round(div.getBoundingClientRect().height / lineHeight);
  }, id);

check(
  "the tracked line still fits on one line, so the box was not shrunk under it",
  (await linesOf("mid_tracked")) === 1,
  `lines=${await linesOf("mid_tracked")}`
);

check("no console errors", errors.length === 0, errors.slice(0, 2).join(" | "));

const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} checks passed`);
console.log("pageErrors", errors.slice(0, 3));
await browser.close();
process.exit(passed === results.length ? 0 : 1);
