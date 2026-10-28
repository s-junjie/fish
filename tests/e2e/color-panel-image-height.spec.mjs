import { chromium } from "playwright";
import { pathToFileURL } from "url";
import path from "node:path";

// The image body of the colour panel ends in the whole photo axis list, and the
// list is the only part of the body that grows with the document's vocabulary:
// it went from 7 axes to 10 and the popover went to ~670px, which is a popover
// deciding its height off a slider count.
//
//   1. the axes live in a fixed WINDOW — the panel does not grow with the list
//   2. the window scrolls, and the last axis is reachable by scrolling
//   3. the pinned chrome above it (the preview) does not move while it scrolls
//   4. the window's own bar is the only cost: no horizontal overflow, and the
//      knob at either end of a row stays inside the window instead of being cut
//   5. a short viewport keeps the bar on the LIST and never on the panel: the
//      popover is a flex column in image mode, so the clamp lands on the axis
//      window, which gives up height (and stays the scroller) instead of the
//      whole body scrolling under a fixed preview
const html = path.resolve(process.cwd(), process.argv[2] ?? "dist/index.html");

const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";

const ELEMENTS = [
  {
    id: "p_img",
    type: "rect",
    name: "Image Rect",
    x: 200,
    y: 200,
    width: 240,
    height: 160,
    // A full invert parks one knob hard against each end of the window — the only
    // position where a knob can be clipped.
    fills: [{ type: "image", assetId: "a1", fit: "cover", adjust: { invert: 1 } }]
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
  ({ elements, uri }) => {
    const bridge = window.__FISH_BRIDGE__;
    const base = bridge.getDoc();
    bridge.setElements(JSON.parse(JSON.stringify(elements)), { canvas: { ...base.canvas, width: 2000, height: 1400 }, assets: [{ id: "a1", name: "pic.png", uri, width: 1, height: 1 }] });
  },
  { elements: ELEMENTS, uri: PNG }
);
await page.waitForTimeout(700);

const measure = () =>
  page.evaluate(() => {
    const list = document.querySelector("[data-adjust-sliders]");
    const panel = document.querySelector("[data-color-panel]");
    if (!list || !panel) return null;
    const rows = [...list.querySelectorAll("[data-slider]")];
    const box = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
    };
    return {
      panelHeight: panel.getBoundingClientRect().height,
      panelTop: panel.getBoundingClientRect().top,
      panelClientHeight: panel.clientHeight,
      panelScrollHeight: panel.scrollHeight,
      panelClientWidth: panel.clientWidth,
      panelScrollWidth: panel.scrollWidth,
      windowHeight: list.clientHeight,
      contentHeight: list.scrollHeight,
      windowWidth: list.clientWidth,
      windowScrollWidth: list.scrollWidth,
      pitch: list.scrollHeight / rows.length,
      rows: rows.length,
      sliders: rows.map((r) => r.dataset.slider),
      last: rows[rows.length - 1]?.dataset.slider,
      list: box(list),
      invertKnob: box(document.querySelector('[data-slider="invert"] [data-slider-knob]')),
      bwKnob: box(document.querySelector('[data-slider="grayscale"] [data-slider-knob]'))
    };
  });

// ---- 1. the window, at a viewport with room to spare ----------------------
await page.evaluate(() => window.__FISH_BRIDGE__.selectElement("p_img"));
await page.waitForTimeout(300);
await page.locator("[data-paint-swatch]").first().click();
await page.waitForTimeout(400);

const tall = await measure();
// Named, not counted: `ADJUST_AXES` in `src/core/dsl/color-filter.ts` is the list
// the panel is built from (`version-consistency.test.ts` keeps it in step with the
// schema and the labels), and a missing row has to say WHICH axis is missing — a
// bare count turns an added axis into "11 !== 10" and tells a reader nothing.
const AXES = ["exposure", "brightness", "contrast", "saturation", "temperature", "tint", "highlights", "shadows", "hueRotate", "invert", "grayscale"];
check(
  "the image body renders every axis",
  JSON.stringify(tall?.sliders) === JSON.stringify(AXES),
  JSON.stringify(tall && { rows: tall.rows, sliders: tall.sliders })
);
check(
  "the axes are windowed, not merely listed",
  !!tall && tall.windowHeight < tall.contentHeight,
  JSON.stringify(tall && { window: tall.windowHeight, content: tall.contentHeight })
);

if (tall) {
  const visibleRows = (tall.windowHeight + 6) / tall.pitch;
  // The cap is 168px and the pitch is measured, so the window shows FIVE AND A
  // HALF rows — the half-row is the "there is more below" cue, and the app says
  // so at the constant. This bound was `<= 5`, which only held for the 137px cap
  // e2bfd50 replaced.
  check(
    "the window is a few rows tall, not the whole list",
    visibleRows > 5 && visibleRows <= 6,
    `window=${tall.windowHeight} pitch=${tall.pitch.toFixed(1)} rows=${visibleRows.toFixed(1)}`
  );
  // What the panel would be with the list unclipped — read off the same DOM, so
  // the "before" side is a measurement rather than a number nobody can check.
  const unclipped = tall.panelHeight + (tall.contentHeight - tall.windowHeight);
  // "Materially shorter" in rows, not in pixels: a fixed 150 could not survive the
  // cap moving to 168, and 149px of saving is four and a half rows at this pitch.
  check(
    "and the panel is materially shorter for it",
    unclipped - tall.panelHeight >= 4 * tall.pitch,
    `saved=${Math.round(unclipped - tall.panelHeight)} fourRows=${Math.round(4 * tall.pitch)}`
  );

  // ---- 4. the window's own chrome costs no more than the bar ---------------
  check(
    "the window adds no horizontal scrollbar on top of its own",
    tall.windowScrollWidth <= tall.windowWidth,
    `client=${tall.windowWidth} scroll=${tall.windowScrollWidth}`
  );
  check(
    "a knob at the right end is not cut by the window",
    tall.invertKnob && tall.list && tall.invertKnob.right <= tall.list.right + 0.5,
    JSON.stringify({ knob: tall.invertKnob, list: tall.list })
  );
  check(
    "a knob at the left end is not cut either",
    tall.bwKnob && tall.list && tall.bwKnob.left >= tall.list.left - 0.5,
    JSON.stringify({ knob: tall.bwKnob, list: tall.list })
  );

  const scroll = await page.evaluate((before) => {
    const list = document.querySelector("[data-adjust-sliders]");
    const preview = document.querySelector("[data-color-panel] [data-image-preview]");
    const previewTop = preview.getBoundingClientRect().top;
    list.scrollTop = list.scrollHeight;
    const inside = (el) => {
      const a = el.getBoundingClientRect();
      const b = list.getBoundingClientRect();
      return a.top >= b.top - 1 && a.bottom <= b.bottom + 1;
    };
    const rows = [...list.querySelectorAll("[data-slider]")];
    return {
      lastVisible: inside(rows[rows.length - 1]),
      firstVisible: inside(rows[0]),
      previewMoved: Math.abs(preview.getBoundingClientRect().top - previewTop) > 0.5,
      panelHeight: document.querySelector("[data-color-panel]").getBoundingClientRect().height,
      windowHeight: list.clientHeight,
      grew: document.querySelector("[data-color-panel]").getBoundingClientRect().height - before
    };
  }, tall.panelHeight);

  check("scrolling reaches the last axis", scroll.lastVisible, JSON.stringify(scroll));
  check("the first axis left through the top of the window", !scroll.firstVisible, JSON.stringify(scroll));
  check("the preview above it never moved", !scroll.previewMoved, JSON.stringify(scroll));
  check("and the panel did not grow", Math.abs(scroll.grew) < 0.5, JSON.stringify(scroll));
  check("the window is unchanged by scrolling", scroll.windowHeight === tall.windowHeight, JSON.stringify(scroll));
}

// ---- 5. a short viewport keeps the one scroller on the axis list ----------
await page.setViewportSize({ width: 1600, height: 620 });
await page.waitForTimeout(400);
const short = await measure();
check(
  "a short viewport clamps the panel inside it",
  !!short && short.panelHeight <= 620 - short.panelTop && short.panelHeight < 620,
  JSON.stringify(short && { panel: Math.round(short.panelHeight), top: Math.round(short.panelTop) })
);
check(
  "but the panel itself does not scroll: the bar is never on the whole panel",
  !!short && short.panelScrollHeight <= short.panelClientHeight + 1,
  JSON.stringify(short && { scroll: short.panelScrollHeight, client: short.panelClientHeight })
);
check(
  "the axis list is the one scroller there",
  !!short && short.windowHeight < short.contentHeight,
  JSON.stringify(short && { window: short.windowHeight, content: short.contentHeight })
);
check(
  "so it gave up height below its own cap to make the panel fit",
  !!short && !!tall && short.windowHeight < tall.windowHeight,
  JSON.stringify(short && tall && { short: short.windowHeight, cap: tall.windowHeight })
);
check(
  "and the clamped panel is still not scrollable sideways",
  !!short && short.panelScrollWidth <= short.panelClientWidth + 1,
  JSON.stringify(short && { scroll: short.panelScrollWidth, client: short.panelClientWidth })
);

if (short) {
  const deep = await page.evaluate(() => {
    const list = document.querySelector("[data-adjust-sliders]");
    list.scrollTop = list.scrollHeight;
    const rows = [...list.querySelectorAll("[data-slider]")];
    const b = list.getBoundingClientRect();
    const last = rows[rows.length - 1].getBoundingClientRect();
    return {
      lastVisible: last.top >= b.top - 1 && last.bottom <= b.bottom + 1,
      panelBar: document.querySelector("[data-color-panel]").scrollHeight >
        document.querySelector("[data-color-panel]").clientHeight + 1
    };
  });
  check("the shrunken window still scrolls to the last axis", deep.lastVisible, JSON.stringify(deep));
  check("and scrolling it never puts the bar back on the panel", !deep.panelBar, JSON.stringify(deep));
}

check("no console errors", errors.length === 0, errors.slice(0, 3).join(" | "));

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
await browser.close();
process.exit(passed === results.length ? 0 : 1);
