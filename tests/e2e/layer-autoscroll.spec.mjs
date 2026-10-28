import { chromium } from "playwright";
import { pathToFileURL } from "url";
import path from "path";

// Selecting a layer on the canvas reveals it in the Layers panel. The reveal is a
// JUMP, not a scroll: a selection moving through the canvas re-arms it every step,
// and an animated scroll spends that whole run chasing a target that keeps leaving.
// Measured per frame, an instant jump leaves the final position in one step; an
// animation walks through dozens of intermediate ones.
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

// 80 sibling rows overflow the panel by a lot, so revealing the row at the far end
// is a scroll no single frame of an animation could finish. The first element sits
// at the BOTTOM of the z-ordered list, which is the end worth scrolling to.
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

// The list's own scroller, found from the panel down — never from the target row,
// which is exactly the thing not rendered before the reveal.
const found = await page.evaluate(() => {
  const panel = document.querySelector('[data-ui-panel="left"]');
  for (const el of panel ? panel.querySelectorAll("*") : []) {
    const s = getComputedStyle(el);
    if (s.overflowY === "auto" && el.scrollHeight > el.clientHeight) {
      window.__sc = el;
      return { scrollTop: el.scrollTop, clientHeight: el.clientHeight, scrollHeight: el.scrollHeight };
    }
  }
  return null;
});
check("the Layers list has a scroller that overflows", Boolean(found), true);
check("and it starts at the top", found.scrollTop, 0);
check("with the target row outside the rendered window", await page.evaluate(() => !!document.querySelector('[data-layer-row="r0"]')), false);

const sampleFrames = (n) =>
  page.evaluate(
    (frames) =>
      new Promise((resolve) => {
        const out = [];
        let left = frames;
        const step = () => {
          out.push(Math.round(window.__sc.scrollTop));
          if (--left > 0) requestAnimationFrame(step);
          else resolve(out);
        };
        requestAnimationFrame(step);
      }),
    n
  );

await page.evaluate(() => window.__FISH_BRIDGE__.selectElement("r0"));
const after = await sampleFrames(60);

const final = after[after.length - 1];
const intermediate = after.filter((v) => v > 2 && v < final - 2).length;

check("selecting the layer reveals it (the list scrolled a long way)", final - found.scrollTop > 1000, true);
check("and the row is in the document afterwards", await page.evaluate(() => !!document.querySelector('[data-layer-row="r0"]')), true);
check("the reveal is one jump, not an animation", intermediate, 0);

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : `  -> ${JSON.stringify(r.actual)} (expected ${JSON.stringify(r.expected)})`}`);
}
console.log(`\n${results.length - failed.length}/${results.length} passed`);
console.log("pageErrors", errors.slice(0, 5));

await browser.close();
process.exit(failed.length === 0 && errors.length === 0 ? 0 : 1);
