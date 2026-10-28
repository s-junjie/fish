import { chromium } from "playwright";
import { pathToFileURL } from "url";
import path from "path";

// A ⌘-click in the Layers panel must not move the list under the pointer.
//
// The reveal effect scrolls to the *primary* selection. ⌘-clicking a row that is
// earlier in document order (visually lower, because the panel paints the top of
// the z-order first) makes that row the primary — and if the row is only partly
// visible at the bottom edge, the reveal re-centres it, jumping the panel by half
// a viewport. Nothing was hidden, so nothing needed revealing: the click should
// leave `scrollTop` exactly where the user left it.
const html = path.resolve(process.cwd(), process.argv[2] ?? "dist/index.html");
const results = [];
const check = (name, ok, actual) => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  -> ${JSON.stringify(actual)}`}`);
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
const settle = () =>
  page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(r))))
  );

// 80 sibling rows overflow the panel, so a partly clipped row exists at the edge.
await page.evaluate(() => {
  const bridge = window.__FISH_BRIDGE__;
  const base = bridge.getDoc();
  const els = [];
  for (let i = 0; i < 80; i++) {
    els.push({
      id: `r${i}`,
      type: "rect",
      name: `Row ${i}`,
      x: 100 + (i % 10) * 130,
      y: 100 + Math.floor(i / 10) * 110,
      width: 100,
      height: 80,
      fills: [{ type: "solid", color: "#3B82F6" }]
    });
  }
  bridge.setElements(els, { canvas: { ...base.canvas, width: 4000, height: 4000 } });
});
await settle();

// The reveal and the windowing both lay the list out from `LAYER_ROW_HEIGHT`, so
// the painted row has to be that tall. Measurements below assume it is.
const rowGeometry = await page.evaluate(() => {
  const rows = [...document.querySelectorAll("[data-layer-row]")]
    .slice(0, 3)
    .map((n) => n.getBoundingClientRect());
  return {
    heights: rows.map((b) => Math.round(b.height)),
    pitches: rows.slice(1).map((b, i) => Math.round(b.top - rows[i].top))
  };
});
check("every row is the 26px the scroll plan lays out", rowGeometry.heights.every((h) => h === 26), rowGeometry);
check("consecutive rows are 30px apart (26 + the 4px gap)", rowGeometry.pitches.every((p) => p === 30), rowGeometry);

const geometry = await page.evaluate(() => {
  const panel = document.querySelector('[data-ui-panel="left"]');
  let scroller = null;
  for (const el of panel ? panel.querySelectorAll("*") : []) {
    const s = getComputedStyle(el);
    if (s.overflowY === "auto" && el.scrollHeight > el.clientHeight) {
      scroller = el;
      break;
    }
  }
  if (!scroller) return null;
  window.__sc = scroller;
  const box = scroller.getBoundingClientRect();
  return {
    clientHeight: scroller.clientHeight,
    scrollTop: scroller.scrollTop,
    left: box.left,
    top: box.top,
    bottom: box.bottom
  };
});
check("the Layers list overflows", Boolean(geometry), geometry);

// r20 becomes the primary. The panel reveals it and settles.
await page.evaluate(() => window.__FISH_BRIDGE__.selectElement("r20"));
await settle();
const afterSelect = await page.evaluate(() => window.__sc.scrollTop);
check("selecting r20 reveals it", afterSelect > 100, afterSelect);

// Place r10 (earlier in document order, so lower in the panel) with its bottom
// 8px past the visible edge: a partly clipped row the pointer can still hit.
// The window renders it first (scroll to its planned position), then the scroll
// is corrected from its measured box — the row is 28px tall, not the 26px the
// pre-render plan assumes, so arithmetic on the plan alone would miss it.
const clipped = await page.evaluate(async () => {
  const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const sc = window.__sc;
  const rowTop = 8 + (79 - 10) * 30;
  sc.scrollTop = Math.max(0, rowTop - sc.clientHeight / 2);
  await frame();
  let row = document.querySelector('[data-layer-row="r10"]');
  if (!row) return { rendered: false, scrollTop: sc.scrollTop };
  const c0 = sc.getBoundingClientRect();
  const b0 = row.getBoundingClientRect();
  sc.scrollTop += b0.bottom - (c0.bottom + 8);
  await frame();
  row = document.querySelector('[data-layer-row="r10"]');
  const c = sc.getBoundingClientRect();
  const b = row ? row.getBoundingClientRect() : null;
  const hit = document.elementFromPoint(c.left + 60, c.bottom - 4);
  return {
    rendered: true,
    scrollTop: sc.scrollTop,
    rowTop: b ? Math.round(b.top) : null,
    rowBottom: b ? Math.round(b.bottom) : null,
    containerBottom: Math.round(c.bottom),
    hitRow: hit ? Boolean(hit.closest('[data-layer-row="r10"]')) : false
  };
});
check("r10 is partly clipped at the bottom edge", clipped.rowBottom > clipped.containerBottom, clipped);
check("and the clipped sliver is the row under the pointer", clipped.hitRow, clipped);

const before = await page.evaluate(() => window.__sc.scrollTop);
await page.keyboard.down("Meta");
await page.mouse.click(geometry.left + 60, clipped.containerBottom - 4);
await page.keyboard.up("Meta");
await settle();
await page.waitForTimeout(50);

const state = await page.evaluate(() => ({
  scrollTop: window.__sc.scrollTop,
  selected: window.__FISH_BRIDGE__.getSelectedIds().sort()
}));
check("⌘-click adds r10 to the selection", JSON.stringify(state.selected) === JSON.stringify(["r10", "r20"]), state.selected);
check("⌘-click leaves the list where it was", state.scrollTop === before, {
  before,
  after: state.scrollTop,
  jump: Math.round(state.scrollTop - before)
});

check("no console errors", errors.length === 0, errors.slice(0, 3).join(" | "));

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
await browser.close();
process.exit(failed.length === 0 && errors.length === 0 ? 0 : 1);
