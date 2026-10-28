import { chromium } from "playwright";
import { pathToFileURL } from "url";
import path from "path";
import nodeFs from "node:fs";

// Six claims about the zoom range and the keys that drive it, none of which a core
// unit test can make — they are all about what the shell actually does with the
// number:
//
//   1. Figma's 6400% ceiling is REACHABLE, and holds there
//   2. the 2% floor is reachable, and holds there
//   3. a page whose stored `metadata.viewport.zoom` is out of range opens CLAMPED
//   4. 1 / 2 (no Shift) and Plus / Minus walk the framing keys and the ladder,
//      and the title bar's two buttons run the same commands
//   5. 0 / Shift+0 / Cmd+0 return to 1:1
//   6. the readout lives inside a `[data-ui-panel]` box, so it can never be covered by it
//
// (3) is the one that decides where the bound lives. A stored viewport is read
// back on undo, on redo and on a page switch, so a hand-edited file or a
// model-authored one can carry any number at all — clamping at those three call
// sites is three chances to forget. So the document is written here with a
// deliberately absurd zoom, and the assertion is on the transform the browser
// ends up painting with, not on a function's return value.
const html = path.resolve(process.cwd(), process.argv[2] ?? "dist/index.html");

const MAX_ZOOM = 64;
const MIN_ZOOM = 0.02;

// Every page here is entered at most once for the viewport assertions, and that is
// load-bearing rather than incidental: `handleSelectPage` stamps the live viewport
// into the page it is leaving, so a page you have already visited carries YOUR
// last position and whatever it was authored with is gone. A page's stored
// viewport therefore only survives until first entry — which is also the only
// time a value that came out of a file (rather than out of this session) can be
// read at all.
const PAGES = [
  {
    id: "zr_1",
    name: "Boot",
    canvas: { width: 800, height: 600 },
    children: [
      { id: "zr_r1", type: "rect", name: "A", x: 0, y: 0, width: 600, height: 400, fills: [{ type: "solid", color: "#3E63DD" }] },
      { id: "zr_r2", type: "rect", name: "B", x: 700, y: 500, width: 200, height: 100, fills: [{ type: "solid", color: "#F76B15" }] }
    ]
  },
  { id: "zr_2", name: "Absurd", canvas: { width: 800, height: 600 }, children: [], metadata: { viewport: { x: 100, y: 100, zoom: 1e9 } } },
  { id: "zr_3", name: "Subpixel", canvas: { width: 800, height: 600 }, children: [], metadata: { viewport: { x: 100, y: 100, zoom: 0.000001 } } },
  { id: "zr_4", name: "Sane", canvas: { width: 800, height: 600 }, children: [], metadata: { viewport: { x: 100, y: 100, zoom: 2 } } }
];

const DOC = {
  version: "0.1",
  docId: "zoom_range_fixture",
  name: "Zoom range",
  canvas: { width: 800, height: 600 },
  pages: PAGES,
  activePageId: "zr_1"
};

// A shell hands the document to the engine by writing it into the file, so a
// fixture that only went through the test bridge would never see the stored
// viewport at all — `applyDoc` replaces the active page's elements and nothing
// else. The file is the only path that exercises the loader.
const shell = nodeFs.readFileSync(html, "utf-8");
const withDoc = shell.replace(
  /(<script\s+id=["']design-doc["'][^>]*>)[\s\S]*?(<\/script>)/i,
  (_m, open, close) => `${open}\n${JSON.stringify(DOC, null, 2).replace(/</g, "\\u003c")}\n${close}`
);
const docPath = path.join(path.dirname(html), ".zoom-range-fixture.fish.html");
nodeFs.writeFileSync(docPath, withDoc, "utf-8");

const results = [];
// `detail` is what a failure prints. Without it a red line names the check and
// nothing else, which is the same as no check when the numbers are the point.
const check = (name, actual, expected, detail = "") =>
  results.push({ name, ok: JSON.stringify(actual) === JSON.stringify(expected), actual, expected, detail });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});

await page.goto(pathToFileURL(docPath).href);
await page.waitForFunction(() => !!window.__FISH_BRIDGE__);

const settle = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

/** The zoom the canvas is actually painted at, read off the stage transform. */
const readZoom = () =>
  page.evaluate(() => {
    const m = /scale\(([\d.]+)\)/.exec((() => { const s = document.querySelector("[data-stage-transform]"); const a = s && s.getAttribute("transform"); if (a) return a; const svg = s && s.ownerSVGElement; const t = svg ? getComputedStyle(svg).transform : ""; const m = /matrix\(([\d.eE+-]+), 0, 0, ([\d.eE+-]+), ([\d.eE+-]+), ([\d.eE+-]+)\)/.exec(t); return m ? "translate(" + m[3] + ", " + m[4] + ") scale(" + m[1] + ")" : null; })());
    return parseFloat(m[1]);
  });

/**
 * `ctrlKey` stands in for the modifier a pinch or Cmd/Ctrl+scroll carries, which
 * is the canvas's own zoom. The events are spaced by a frame each so the handler
 * reads the zoom the previous one left behind — a burst in one tick would have
 * every event compute from the same stale closure value.
 */
const pinch = (times) =>
  page.evaluate(async (n) => {
    const target = document.elementFromPoint(800, 500);
    for (let i = 0; i < n; i++) {
      target.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, ctrlKey: true, deltaY: -100 }));
      await new Promise((r) => requestAnimationFrame(r));
    }
  }, times);

const unpinch = (times) =>
  page.evaluate(async (n) => {
    const target = document.elementFromPoint(800, 500);
    for (let i = 0; i < n; i++) {
      target.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, ctrlKey: true, deltaY: 100 }));
      await new Promise((r) => requestAnimationFrame(r));
    }
  }, times);

const openPage = async (id) => {
  await page.click(`[data-page-id="${id}"]`);
  await settle();
  await page.waitForTimeout(120);
  await settle();
};

/** The window-space box of a layer, the way the fit assertions read the canvas. */
const boxOf = (id) =>
  page.evaluate((elId) => {
    const n = document.querySelector(`[data-element-id="${CSS.escape(elId)}"]`);
    if (!n) return null;
    const b = n.getBoundingClientRect();
    return { left: b.left, top: b.top, right: b.right, bottom: b.bottom };
  }, id);

/** The rect the floating chrome leaves uncovered, read independently of the app. */
const uncovered = async () => {
  const rects = await page.evaluate(() =>
    [...document.querySelectorAll("[data-ui-panel]")].map((panel) => {
      const b = panel.getBoundingClientRect();
      return { side: panel.dataset.uiPanel, left: b.left, top: b.top, right: b.right, bottom: b.bottom };
    })
  );
  const root = await page.evaluate(() => {
    const r = document.querySelector("[data-canvas-root]").getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  });
  // One branch per anchored edge, mirroring `unobstructedArea`: the title bar
  // added a "top" to subtract, and without it every centre below came out half
  // a bar too high.
  let { left, right, bottom } = root;
  let top = root.top;
  for (const r of rects) {
    if (r.side === "left") left = Math.max(left, r.right);
    else if (r.side === "right") right = Math.min(right, r.left);
    else if (r.side === "dock") bottom = Math.min(bottom, r.top);
    else if (r.side === "top") top = Math.max(top, r.bottom);
  }
  return { left, top, right, bottom };
};

const press = async (keys) => {
  await page.keyboard.press(keys);
  await settle();
  await page.waitForTimeout(120);
  await settle();
};

/**
 * `FIXT_MARGIN` in `useCanvasViewport.ts`: the breathing room a fit leaves.
 */
const FIT_MARGIN = 48;

/** Pinch in batches, settling between them, until the zoom stops moving. */
const driveTo = async (direction) => {
  // A burst of notches inside ONE evaluate does not compound the way a real
  // gesture's do: the handler reads the zoom the last render left behind, and
  // inside a single evaluate a rAF can resolve before the app has committed the
  // previous one. Batching with a settle between is what a hand on a trackpad
  // actually does, and it is also the only reason the "and N more notches do not
  // push past it" assertions below mean anything.
  const batch = () => (direction > 0 ? pinch(10) : unpinch(10));
  let previous = null;
  for (let i = 0; i < 40; i++) {
    await batch();
    await settle();
    const now = await readZoom();
    if (now === previous) break;
    previous = now;
  }
  await settle();
  return readZoom();
};

const readPercent = () => page.textContent('[data-zoom-bar] [data-zoom-value="true"]');

// ---- seed sanity ----------------------------------------------------------
const seededPages = await page.evaluate(() => window.__FISH_BRIDGE__.getDoc().pages.length);
check("the fixture's pages load", seededPages, 4);
const A_W = 600;
const seededLayers = await page.evaluate(() => document.querySelectorAll("[data-element-id]").length);
check("the fixture's layers render on the boot page", seededLayers, 2);
const opening = await readZoom();
check("the canvas does NOT adopt a stored viewport at boot, so the two are separable", opening, 0.8);

// ---- 2. the readout shows the zoom it is painting at ------------------------
// An indicator that lags the canvas is worse than none: the whole reason to have
// a number is to stop guessing which rung you are on.
check("the readout names the opening zoom", await readPercent(), "80%");

// ---- 2b. the readout sits inside chrome, not over it ----------------------
// It has been a bottom-left pill, a full-width status strip, the inspector's
// footer and now the title bar's right side. Which chrome is incidental;
// the claim is containment, because being carried by a measured chrome box is
// what makes overlap impossible rather than merely unlikely — and what keeps
// the box visible to `unobstructedArea`, so a fit never frames a layer under
// the readout either.
const [panelBox, zoomBox] = await page.evaluate(() => {
  const p = document.querySelector('[data-ui-panel="top"]').getBoundingClientRect();
  const z = document.querySelector('[data-zoom-bar] [data-zoom-control="true"]').getBoundingClientRect();
  return [{ l: p.left, t: p.top, r: p.right, b: p.bottom }, { l: z.left, t: z.top, r: z.right, b: z.bottom }];
});
check(
  "the readout sits inside chrome's box, so it cannot be covered by it",
  zoomBox.l >= panelBox.l && zoomBox.r <= panelBox.r && zoomBox.t >= panelBox.t && zoomBox.b <= panelBox.b,
  true,
  `bar ${JSON.stringify(panelBox)} vs readout ${JSON.stringify(zoomBox)}`
);
// Being anchored is one thing; FITTING inside is another. The title bar is 48px
// and the buttons are the 26px `iconLg` box — the cluster carries no vertical
// padding of its own, because one pixel of it spills past the edge it is
// supposed to be carried by.
check(
  "and it fits inside that bar's height rather than spilling past it",
  panelBox.b >= zoomBox.b && zoomBox.t >= panelBox.t,
  true,
  `bar bottom ${panelBox.b}, readout bottom ${zoomBox.b}`
);

// ---- 3. `2` frames the selection, WITH OR WITHOUT SHIFT --------------------
// TWO layers, and the union is the claim: a frame that used one element's own box
// instead of the union would still look right while framing a single layer.
await page.click('[data-layer-row="zr_r1"]');
await settle();
await page.keyboard.down("Shift");
await page.click('[data-layer-row="zr_r2"]');
await page.keyboard.up("Shift");
await settle();
// Sorted: the panel is front-first by design, so the ORDER is not the claim here —
// the SET is.
const chosen = await page.evaluate(() => window.__FISH_BRIDGE__.getSelectedIds().sort());
check("both layers are selected", chosen, ["zr_r1", "zr_r2"]);

// `Shift+2` is Figma's spelling and the only one that reaches this command: a bare
// digit sets the selection's opacity (`useShortcuts.ts:384`), so pressing `2` here
// would repaint the layers instead of framing them.
const beforeBare = await readZoom();
await press("2");
check("a bare digit sets opacity, so the view does not move", await readZoom(), beforeBare);
await press("Shift+2");
const sel = await Promise.all([boxOf("zr_r1"), boxOf("zr_r2")]);
const selBox = {
  left: Math.min(sel[0].left, sel[1].left),
  top: Math.min(sel[0].top, sel[1].top),
  right: Math.max(sel[0].right, sel[1].right),
  bottom: Math.max(sel[0].bottom, sel[1].bottom)
};
const area = await uncovered();
const framedW = selBox.right - selBox.left;
const framedH = selBox.bottom - selBox.top;
const centredX = Math.abs((selBox.left + selBox.right) / 2 - (area.left + area.right) / 2) <= 2;
const centredY = Math.abs((selBox.top + selBox.bottom) / 2 - (area.top + area.bottom) / 2) <= 2;
check(
  "Shift+2 centres the SELECTION in the uncovered area",
  centredX && centredY,
  true,
  `selection centre (${((selBox.left + selBox.right) / 2).toFixed(1)}, ${((selBox.top + selBox.bottom) / 2).toFixed(1)}) vs area centre (${((area.left + area.right) / 2).toFixed(1)}, ${((area.top + area.bottom) / 2).toFixed(1)})`
);
check(
  "and spans both layers, not one",
  framedW > A_W + 100,
  true,
  `framed ${framedW.toFixed(1)} wide, one layer is ${A_W}`
);
check(
  "and spends the space: the binding axis keeps exactly the margin",
  Math.abs(Math.min(area.right - area.left - framedW, area.bottom - area.top - framedH) - FIT_MARGIN * 2) <= 2,
  true,
  `slack ${Math.min(area.right - area.left - framedW, area.bottom - area.top - framedH).toFixed(1)}, expected ${FIT_MARGIN * 2}`
);

// The Shift spelling is Figma's, so dropping it would break muscle memory; both
// must reach the same command.
const fitted = await readZoom();
await pinch(6);
await settle();
check("a pinch really did move it off the fit", (await readZoom()) !== fitted, true, `fit ${fitted}, after pinch ${await readZoom()}`);
await press("Shift+2");
check("and Shift+2 frames the same selection", await readZoom(), fitted);

// With nothing selected there is no box to frame, and the view must not move on
// a guess — an unexpected jump is worse than a key that does nothing.
await page.keyboard.press("Escape");
await page.evaluate(() => window.__FISH_BRIDGE__.selectElement(""));
await settle();
const idle = await readZoom();
await press("2");
check("2 with no selection leaves the view alone", await readZoom(), idle);

// ---- 4. 1:1 by both spellings (Shift+0, Cmd+0) -----------------------------
// A bare `0` cannot be one of them: the digits are the opacity keys now, so with
// no selection it reaches no command at all rather than resetting the zoom.
await press("Shift+0");
check("Shift+0 is 1:1", await readZoom(), 1);
check("and the readout agrees", await readPercent(), "100%");

await pinch(6);
await settle();
const beforeReset = await readZoom();
check("a pinch really did move it off 1:1", beforeReset > 1.001, true);
await press("0");
check("a bare 0 leaves the zoom alone", await readZoom(), beforeReset);

await pinch(6);
await settle();
await press("Meta+0");
check("Cmd+0 is 1:1 too, the chord people reach for out of habit", await readZoom(), 1);

// ---- 5. the ladder, by key and by button -----------------------------------
// Rungs from 1:1, so the sequence is the ladder itself rather than a factor.
const ladder = [];
for (let i = 0; i < 5; i++) {
  await press("+");
  ladder.push(await readZoom());
}
check("+ walks the ladder up from 1:1", ladder, [2, 4, 8, 16, 32]);
check("and the readout keeps up", await readPercent(), "3200%");

const down = [];
for (let i = 0; i < 3; i++) {
  await press("-");
  down.push(await readZoom());
}
check("- walks it back down", down, [16, 8, 4]);

// The title bar's two buttons are the same commands, not a second ladder of their own.
await page.click('[data-zoom-bar] [data-zoom-in="true"]');
await settle();
check("the title bar's + runs the same command", await readZoom(), 8);
await page.click('[data-zoom-bar] [data-zoom-out="true"]');
await settle();
check("and its − runs the other one", await readZoom(), 4);

// A zoom off the ladder still lands on a rung, never a factor of one. ONE notch
// gets off the ladder, and which rung it lands on is READ rather than assumed:
// how far a notch travels is the wheel handler's business, and a spec that names
// the destination starts failing the day that number moves — as this one did.
await pinch(1);
await settle();
const offLadder = await readZoom();
await press("+");
check(
  "a zoom between two rungs snaps to the next one, not past it",
  await readZoom(),
  [0.02, 0.05, 0.1, 0.25, 0.5, 1, 2, 4, 8, 16, 32, 64].find((rung) => rung > offLadder * 1.001)
);

// ---- 6. the ceiling is reachable, and holds --------------------------------
const atCeiling = await driveTo(1);
check("Ctrl+scroll reaches Figma's 6400% ceiling", atCeiling, MAX_ZOOM);

await pinch(40);
await settle();
const pastCeiling = await readZoom();
check("and 40 more notches do not push past it", pastCeiling, MAX_ZOOM);

// A zoom this high has to stay a real transform: `scale(64)` paints, a stale or
// NaN factor paints nothing at all.
const painted = await page.evaluate(() => {
  const svg = document.querySelector("svg.pointer-events-auto");
  const box = svg.getBoundingClientRect();
  return box.width > 0 && box.height > 0;
});
check("the canvas is still painted at the ceiling", painted, true);

check("and the readout says 6400% there", await readPercent(), "6400%");

// ---- 7. the floor is reachable, and holds ----------------------------------
const atFloor = await driveTo(-1);
check("Ctrl+scroll reaches the 2% floor", atFloor, MIN_ZOOM);

await unpinch(40);
await settle();
const pastFloor = await readZoom();
check("and 40 more notches do not push past it", pastFloor, MIN_ZOOM);
check("and the readout says 2% there", await readPercent(), "2%");

// ---- 8. a stored zoom is clamped on the way in -----------------------------
// These are the reads that motivated putting the bound in the normalizer: the
// page switch hands `metadata.viewport` straight to the viewport, so a document
// that says 1e9 would otherwise open at a million percent.
await openPage("zr_2");
const absurd = await readZoom();
check("a page storing zoom 1e9 opens clamped to the ceiling", absurd, MAX_ZOOM);

await openPage("zr_3");
const subpixel = await readZoom();
check("a page storing a sub-permille zoom opens clamped to the floor", subpixel, MIN_ZOOM);

await openPage("zr_1");
const noStored = await readZoom();
check("a page storing no viewport at all keeps the live one", noStored, MIN_ZOOM);

await openPage("zr_4");
const sane = await readZoom();
check("a page storing an in-range zoom is honoured as stored", sane, 2);

// ---- verdict ---------------------------------------------------------------
const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : `  -> got ${JSON.stringify(r.actual)}, expected ${JSON.stringify(r.expected)}`}`);
}
console.log(`\n${results.length - failed.length}/${results.length} passed`);
console.log("pageErrors", errors.slice(0, 5));

await browser.close();
process.exit(failed.length === 0 && errors.length === 0 ? 0 : 1);
