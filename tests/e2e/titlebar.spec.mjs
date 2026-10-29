import { chromium } from "playwright";
import { pathToFileURL } from "url";
import path from "node:path";

// The title bar claims the window's top edge, which puts it in `fitBounds`'s
// way: a fit asks `unobstructedArea`, which reads boxes off the DOM and gives up
// only the edge each `[data-ui-panel]` declares. "top" did not exist before this
// bar, so the claims worth making here are not "it renders" but "a fit sees it".
//
// The fit assertions below compare the CENTRE of the content against the centre
// of the area a fit is allowed to use, not the content's top edge against the
// bar's bottom. A top-edge comparison cannot fail: `fitRect` always leaves
// FIT_MARGIN (48px) of slack, and 48 > any plausible bar height, so the content
// clears the bar whether or not the "top" branch exists. Centring is what
// actually differs — subtracting 36px off the top moves the area's middle by 18px
// — and a check that cannot fail is not a check.
const html = path.resolve(process.cwd(), process.argv[2] ?? "dist/index.html");
const VIEW = { width: 1600, height: 1000 };
const FIT_MARGIN = 48;

/** The rect a fit may use, derived the way `unobstructedArea` derives it. */
const uncoveredArea = () =>
  page.evaluate(() => {
    const canvas = document.querySelector("canvas")?.parentElement ?? document.body;
    const view = canvas.getBoundingClientRect();
    let left = 0;
    let top = 0;
    let right = view.width;
    let bottom = view.height;
    for (const panel of document.querySelectorAll("[data-ui-panel]")) {
      const b = panel.getBoundingClientRect();
      const l = b.left - view.left;
      const r = b.right - view.left;
      const t = b.top - view.top;
      const bo = b.bottom - view.top;
      if (Math.min(r, right) <= Math.max(l, left) || Math.min(bo, bottom) <= Math.max(t, top)) continue;
      if (panel.dataset.uiPanel === "left") left = Math.max(left, r);
      else if (panel.dataset.uiPanel === "right") right = Math.min(right, l);
      else if (panel.dataset.uiPanel === "dock") bottom = Math.min(bottom, t);
      else if (panel.dataset.uiPanel === "top") top = Math.max(top, bo);
    }
    return { x: left, y: top, width: right - left, height: bottom - top };
  });

const contentBox = () =>
  page.evaluate(() => {
    const n = document.querySelector('[data-element-id="tb_a"]');
    if (!n) return null;
    const b = n.getBoundingClientRect();
    return { left: b.left, top: b.top, width: b.width, height: b.height, right: b.right, bottom: b.bottom };
  });

/** Taller than the area, so the fit is height-bound and centres vertically. */
const ELEMENTS = [
  {
    id: "tb_a",
    type: "rect",
    name: "A",
    x: 0,
    y: 0,
    width: 600,
    height: 3000,
    fills: [{ type: "solid", color: "#3E63DD" }]
  }
];

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `\n      ${detail}` : ""}`);
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: VIEW });
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
  bridge.setElements(JSON.parse(JSON.stringify(elements)), { canvas: { ...base.canvas, width: 4000, height: 3000 } });
}, ELEMENTS);
await page.waitForTimeout(400);

const settle = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
const idle = async () => {
  await settle();
  await page.waitForTimeout(200);
  await settle();
};

const barBox = () =>
  page.evaluate(() => {
    const n = document.querySelector("[data-title-bar]");
    if (!n) return null;
    const b = n.getBoundingClientRect();
    return { top: b.top, left: b.left, width: b.width, height: b.height, bottom: b.bottom };
  });

const contentTop = () =>
  page.evaluate(() => {
    const n = document.querySelector('[data-element-id="tb_a"]');
    if (!n) return null;
    return n.getBoundingClientRect().top;
  });

// ------------------------------------------------------------------ the bar
const bar = await barBox();
check("a title bar exists and spans the window", bar !== null && bar.top === 0 && bar.left === 0 && bar.width === VIEW.width, JSON.stringify(bar));
check("it is anchored to the top edge for the viewport maths", (await page.evaluate(() => document.querySelector("[data-title-bar]")?.dataset.uiPanel)) === "top");

// ------------------------------------------- it must not sit on the panels
// The bar spans the window and is above both side panels in z, so the panels
// have to start below it. They used to run under it, and the bar's 36px strip
// swallowed the top of both headers: the inspector's History button had 24 of
// its 26px under the bar and was unclickable, and the layer tabs were worse.
// Overlap is asserted geometrically AND by hit-testing, because a box that
// merely intersects is not yet a click that fails.
const panelTops = await page.evaluate(() =>
  [...document.querySelectorAll('[data-ui-panel="left"], [data-ui-panel="right"]')].map((p) => ({
    side: p.dataset.uiPanel,
    top: p.getBoundingClientRect().top
  }))
);
for (const p of panelTops) {
  check(`the ${p.side} panel starts below the bar`, p.top >= (bar?.bottom ?? 0), `panel top ${p.top}, bar bottom ${bar?.bottom}`);
}

const hitTargets = await page.evaluate(() => {
  const probe = (sel, label) => {
    const n = document.querySelector(sel);
    if (!n) return { sel, ok: false, why: "not found" };
    const b = n.getBoundingClientRect();
    const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
    return {
      sel,
      ok: !!hit && (n === hit || n.contains(hit) || hit.contains(n)),
      why: hit ? `${hit.tagName}.${String(hit.className).slice(0, 30)}` : "nothing"
    };
  };
  return [
    probe('[data-testid="panel-tab-layers"]', "layer tab"),
    probe('[data-testid="panel-tab-assets"]', "assets tab"),
    probe('[data-ui-panel="right"] [title]', "inspector header button"),
    probe("[data-autosave-status]", "autosave badge")
  ];
});
for (const h of hitTargets) {
  check(`the middle of ${h.sel} is the topmost thing at that point`, h.ok, `hit: ${h.why}`);
}

// ------------------------------------------------------- what lives in it
// The zoom cluster rides the bar's right side (fit · − · readout · +),
// after the save status and before Present; updates moved to the left beside
// the document name. The inspector's old footer is gone, so its absence is
// asserted too.
const zoomInBar = await page.evaluate(() => !!document.querySelector("[data-zoom-bar] [data-zoom-control]"));
check("the bar carries the zoom readout", zoomInBar);
const zoomInTopPanel = await page.evaluate(() => {
  const panel = document.querySelector('[data-ui-panel="top"]');
  const cluster = document.querySelector("[data-zoom-bar] [data-zoom-control]");
  if (!panel || !cluster) return false;
  return panel.contains(cluster);
});
check("the cluster is inside the measured top panel, not floating over it", zoomInTopPanel);
const statusBarGone = await page.evaluate(() => !document.querySelector("[data-status-bar]"));
check("the full-width status strip is gone", statusBarGone);
const zoomInInspector = await page.evaluate(() => !!document.querySelector('[data-ui-panel="right"] [data-zoom-control]'));
check("the inspector no longer carries a zoom cluster", zoomInInspector === false);
const presentInBar = await page.evaluate(() => !!document.querySelector("[data-title-bar] [data-present-button]"));
check("the way into presentation sits in the bar", presentInBar);
const autosaveInBar = await page.evaluate(() => !!document.querySelector("[data-autosave-status]"));
check("autosave badge sits in the bar", autosaveInBar);

// The bar's order is the claim: updates belongs to the file and follows the
// name on the left; zoom is the canvas readout on the right, with Present
// keeping the outer corner so the two app actions are not split by it.
const barOrder = await page.evaluate(() => {
  const rect = (sel) => {
    const n = document.querySelector(sel);
    return n ? n.getBoundingClientRect() : null;
  };
  const box = (r) => (r ? { left: r.left, right: r.right } : null);
  return {
    bar: box(rect("[data-title-bar]")),
    name: box(rect("[data-title-bar-name]")),
    updates: box(rect("[data-update-button]")),
    zoom: box(rect("[data-zoom-bar]")),
    present: box(rect("[data-present-button]"))
  };
});
check(
  "updates is integrated into the logo on the far left before the document name",
  barOrder.updates.left < barOrder.name.left && barOrder.updates.right <= barOrder.name.left,
  JSON.stringify(barOrder)
);
check(
  "zoom sits left of Present, and Present owns the right corner",
  barOrder.zoom.right <= barOrder.present.left && barOrder.present.right > barOrder.updates.right,
  JSON.stringify(barOrder)
);

// -------------------------------------------------------- fit must clear it
// Compared by CENTRE, because the top edge cannot discriminate: `fitRect` leaves
// FIT_MARGIN above the content either way, and 48px clears a 36px bar with or
// without the "top" branch. Subtracting the bar off the top moves the area's
// middle up by half the bar's height, which is the whole observable difference.
await page.keyboard.press("Shift+1");
await idle();
const areaWithBar = await uncoveredArea();
const fitted = await contentBox();
const areaCentreY = areaWithBar.y + areaWithBar.height / 2;
const contentCentreY = fitted ? fitted.top + fitted.height / 2 : NaN;
check(
  "with chrome up, a fit centres content in the area BELOW the bar",
  Number.isFinite(contentCentreY) && Math.abs(contentCentreY - areaCentreY) < 2,
  `content centre ${contentCentreY}, area centre ${areaCentreY} (area y=${areaWithBar.y} h=${areaWithBar.height})`
);
check(
  "and that area really did give up the bar's strip",
  areaWithBar.y >= (bar?.bottom ?? 0) - 1 && areaWithBar.y > 0,
  `area top ${areaWithBar.y}, bar bottom ${bar?.bottom}`
);
check("with chrome up, a fit frames content below the bar", fitted !== null && fitted.top >= (bar?.bottom ?? 0), `content top ${fitted?.top}, bar bottom ${bar?.bottom}`);

// ------------------------------------ and stop clearing it once chrome is down
await page.keyboard.press("Meta+.");
await idle();
const hiddenBar = await barBox();
check("⌘. slides the bar off the top", hiddenBar !== null && hiddenBar.bottom <= 1, JSON.stringify(hiddenBar));

await page.keyboard.press("Shift+1");
await idle();
const areaNoBar = await uncoveredArea();
const fittedNoBar = await contentBox();
const areaCentreNoBar = areaNoBar.y + areaNoBar.height / 2;
const contentCentreNoBar = fittedNoBar ? fittedNoBar.top + fittedNoBar.height / 2 : NaN;
check(
  "with chrome down, every panel has given its strip back",
  areaNoBar.height > areaWithBar.height && areaNoBar.y === 0,
  `${areaWithBar.height} with bar -> ${areaNoBar.height} without, top ${areaNoBar.y}`
);
check(
  "and the fit re-centres in the taller area",
  Number.isFinite(contentCentreNoBar) && Math.abs(contentCentreNoBar - areaCentreNoBar) < 2,
  `content centre ${contentCentreNoBar}, area centre ${areaCentreNoBar}`
);
check(
  "the free fit lands at FIT_MARGIN, nothing else",
  contentTop() !== null && Math.abs(await contentTop() - FIT_MARGIN) < 2,
  `expected ~${FIT_MARGIN}, got ${await contentTop()}`
);

await page.keyboard.press("Meta+.");
await idle();

// ------------------------------------------------------------------ history
await page.click("[data-autosave-status]");
await idle();
await page.click("[data-title-bar-history]");
await idle();
const historyOpen = await page.evaluate(() => !!document.querySelector("[data-history-panel]"));
check("the history door opens its panel", historyOpen, `[data-history-panel] present: ${historyOpen}`);

// It is anchored under the bar, and `h-full` there means "the whole viewport" —
// which put 36px of it below the fold, scrollport included.
const historyBox = await page.evaluate(() => {
  const n = document.querySelector("[data-history-panel]");
  if (!n) return null;
  const b = n.getBoundingClientRect();
  return { top: b.top, bottom: b.bottom, height: b.height };
});
check(
  "the history panel ends at the bottom of the window, not past it",
  historyBox !== null && historyBox.bottom <= VIEW.height + 1 && historyBox.height <= VIEW.height,
  JSON.stringify(historyBox)
);
await page.keyboard.press("Escape");
await idle();

// ------------------------------------------------------------------ auto-save
// The controller emits only from inside a flush and never a synthetic idle
// before its first one, so reading this line means waiting for a real save
// rather than asserting on a placeholder. That is also the honest version of
// the claim: the bar shows what auto-save is doing, and with nothing done yet
// there is nothing to say.
await page.evaluate(() => {
  const b = window.__FISH_BRIDGE__;
  const next = JSON.parse(JSON.stringify(b.getDoc()));
  const page = next.pages.find((p) => p.id === next.activePageId) || next.pages[0];
  page.children[0].x = 240;
  b.applyDoc(next);
});
const autosaveWire = await page
  .waitForFunction(
    () => {
      const n = document.querySelector("[data-autosave-status]");
      return n ? `${n.dataset.autosaveKind}: ${n.textContent.trim()}` : false;
    },
    { timeout: 8000 }
  )
  .then((h) => h.jsonValue())
  .catch(() => null);
check("an edit makes auto-save report itself in the bar", autosaveWire !== null, String(autosaveWire));

check("no console errors", errors.length === 0, errors.join("\n      "));

await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) process.exit(1);
