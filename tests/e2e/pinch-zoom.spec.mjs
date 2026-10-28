import { chromium } from "playwright";
import { pathToFileURL } from "url";
import path from "path";

// A trackpad pinch reaches the browser as a ctrl+wheel, and the browser's default
// action for one is page zoom — which scales the panels, the toolbars and the canvas
// as one. Pinching over the canvas is the canvas zoom, so that has to keep working;
// pinching anywhere else has to be swallowed rather than resize the whole UI.
//
// The events are dispatched rather than driven from a real trackpad: an untrusted
// event still runs every listener in the chain and still records `defaultPrevented`,
// which is exactly the contract here. What it cannot show is the browser's own zoom
// actually being suppressed, since a synthetic event has no default action to
// suppress — the assertions read the flag, not the page scale.
const html = path.resolve(process.cwd(), process.argv[2] ?? "dist/index.html");
const results = [];
const check = (name, actual, expected) =>
  results.push({ name, ok: JSON.stringify(actual) === JSON.stringify(expected), actual, expected });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});

await page.goto(pathToFileURL(html).href);
await page.waitForFunction(() => !!window.__FISH_BRIDGE__);

const settle = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

/**
 * Wheel a point on screen and report whether anything cancelled it. `ctrl` stands in
 * for the modifier the browser synthesises for a pinch.
 */
const wheelAt = (x, y, { ctrl = false, deltaY = -100 } = {}) =>
  page.evaluate(
    ({ px, py, isCtrl, dy }) => {
      const target = document.elementFromPoint(px, py);
      if (!target) return "no element under the point";
      const ev = new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        ctrlKey: isCtrl,
        deltaY: dy,
        clientX: px,
        clientY: py
      });
      target.dispatchEvent(ev);
      return ev.defaultPrevented;
    },
    { px: x, py: y, isCtrl: ctrl, dy: deltaY }
  );

const readView = () =>
  page.evaluate(() => {
    const m = /translate\((-?[\d.]+), (-?[\d.]+)\) scale\(([\d.]+)\)/.exec((() => { const s = document.querySelector("[data-stage-transform]"); const a = s && s.getAttribute("transform"); if (a) return a; const svg = s && s.ownerSVGElement; const t = svg ? getComputedStyle(svg).transform : ""; const m = /matrix\(([\d.eE+-]+), 0, 0, ([\d.eE+-]+), ([\d.eE+-]+), ([\d.eE+-]+)\)/.exec(t); return m ? "translate(" + m[3] + ", " + m[4] + ") scale(" + m[1] + ")" : null; })());
    return { zoom: parseFloat(m[3]) };
  });

await page.evaluate(() => window.__FISH_BRIDGE__.selectElement(""));
await settle();

// The pages header stands in for the left panel: it is the one thing in the sidebar
// that is always rendered, whatever the selection happens to be.
const pagesBox = await page.locator("[data-pages-section]").boundingBox();
check("the pages section is on screen", Boolean(pagesBox), true);
const leftX = pagesBox.x + pagesBox.width / 2;
const leftY = pagesBox.y + pagesBox.height / 2;
// The inspector is pinned to the right edge; a point well inside it cannot land on
// the canvas, whose own wheel handler would answer for the result.
const rightX = 1600 - 120;
const rightY = 500;

check("a pinch over the layers panel is swallowed", await wheelAt(leftX, leftY, { ctrl: true }), true);
check("a pinch over the inspector is swallowed", await wheelAt(rightX, rightY, { ctrl: true }), true);

// The one thing that must NOT be swallowed: the canvas zoom. If the guard had been
// written as a capturing listener or a stopPropagation, the wheel would never reach
// the canvas and pinching on the canvas would do nothing at all.
const before = await readView();
const svgBox = await page.locator("svg.pointer-events-auto").boundingBox();
await wheelAt(svgBox.x + svgBox.width * 0.5, svgBox.y + svgBox.height * 0.5, { ctrl: true });
await settle();
const after = await readView();
check("a pinch over the canvas still zooms the canvas", after.zoom > before.zoom, true);

// A two-finger scroll carries no modifier, and it is how a panel scrolls. Cancelling
// it would trade one broken gesture for another.
check("a two-finger scroll over the layers panel is left alone", await wheelAt(leftX, leftY), false);
check("a two-finger scroll over the inspector is left alone", await wheelAt(rightX, rightY), false);

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : `  -> ${JSON.stringify(r.actual)} (expected ${JSON.stringify(r.expected)})`}`);
}
console.log(`\n${results.length - failed.length}/${results.length} passed`);
console.log("pageErrors", errors.slice(0, 5));

await browser.close();
process.exit(failed.length === 0 && errors.length === 0 ? 0 : 1);
