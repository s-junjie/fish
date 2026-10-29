import { chromium } from "playwright";
import { pathToFileURL } from "node:url";
import path from "node:path";

/**
 * A live blend mode anywhere in the document must not touch a backdrop blur.
 *
 * The report: "when any element on the canvas has a blend mode other than normal, the background blur effect
 * changes" — with the two screenshots, one panel blurred and one showing a hard
 * seam where the blur should be.
 *
 * One cause, and it is a Chromium one: the moment an `<svg>` contains a
 * `mix-blend-mode` other than `normal`, every `backdrop-filter` inside it stops
 * being applied if any ANCESTOR of that `<svg>` moves it by transform — an HTML
 * ancestor, or the `<svg>` itself, whether the transform is CSS or the SVG
 * attribute. The panel then paints its backdrop unblurred. The pan/zoom used to
 * be exactly that: `transform: translate(...) scale(...)` on the canvas root.
 *
 * The fix is the shape of the transform, not its value — see the note on
 * `stageTransform` in `CanvasArea`. So this spec pins the INVARIANT rather than
 * the spelling: the panel's pixels must be identical with and without a blend
 * mode on the canvas, and the control pins that those pixels are blurred at all,
 * so the check cannot pass by both captures being wrong in the same way.
 */
const html = path.resolve(process.cwd(), process.argv[2] ?? "dist/index.html");
const results = [];
const pageErrors = [];
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  results.push({ name, ok });
}

const rect = (id, over) => ({
  id,
  type: "rect",
  name: id,
  x: 0,
  y: 0,
  width: 10,
  height: 10,
  fills: [{ type: "solid", color: "#000000" }],
  ...over
});

const PANEL = { x: 60, y: 0, width: 250, height: 300 };

/** `blend` and `blur` are the two knobs; everything else is the control. */
const fixture = ({ blend = null, blur = 24 }) => ({
  pages: [
    {
      id: "p1",
      name: "Page 1",
      canvas: { width: 420, height: 660 },
      children: [
        rect("green", { x: 0, y: 0, width: 120, height: 120, fills: [{ type: "solid", color: "#3EC432" }] }),
        rect("red", { x: 0, y: 120, width: 240, height: 120, fills: [{ type: "solid", color: "#D82020" }] }),
        rect("panel", {
          ...PANEL,
          fills: [{ type: "solid", color: "#FFFFFF", opacity: 0.35 }],
          effects: [{ type: "backdrop-blur", blur, enabled: true }]
        }),
        rect("spot", {
          // Left of the panel (which starts at x = 60) and on top of the red
          // rect: the blend has to land on something that is not the white
          // canvas, because white is the fixed point of `multiply`.
          x: 0,
          y: 120,
          width: 50,
          height: 60,
          fills: [{ type: "solid", color: "#3366FF" }],
          ...(blend ? { blendMode: blend } : {})
        })
      ]
    }
  ],
  activePageId: "p1"
});

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 900 }, deviceScaleFactor: 1 });
page.on("pageerror", (e) => pageErrors.push(String(e)));
page.on("console", (m) => {
  if (m.type() === "error") pageErrors.push(m.text());
});
await page.goto(pathToFileURL(html).href);
await page.waitForFunction(() => !!window.__FISH_BRIDGE__ && !!window.__fish);

/** Paint and settle. The flush is two frames so the raster bake has run. */
async function seed(doc) {
  await page.evaluate(async (d) => {
    window.__FISH_BRIDGE__.applyDoc(window.__fish.normalize(d).document);
    await new Promise((r) =>
      requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 120)))
    );
  }, doc);
  await page.evaluate(() => window.__FISH_BRIDGE__.selectElement(""));
  await page.waitForTimeout(180);
}

const boxOf = (id) =>
  page.evaluate((elId) => {
    const b = document.querySelector(`[data-element-id="${elId}"]`).getBoundingClientRect();
    return { x: b.x, y: b.y, width: b.width, height: b.height };
  }, id);

/** The painted pixels of one element, at device scale 1. */
async function shot(id) {
  const box = await boxOf(id);
  const clip = {
    x: Math.round(box.x),
    y: Math.round(box.y),
    width: Math.max(1, Math.round(box.width)),
    height: Math.max(1, Math.round(box.height))
  };
  return { box, png: await page.screenshot({ clip }) };
}

/* --------------------------------------------- 1. the report, as reported */

await seed(fixture({}));
const quiet = await shot("panel");

await seed(fixture({ blend: "multiply" }));
const loud = await shot("panel");

check(
  "the panel is framed identically with and without a blend mode on the canvas",
  Math.round(quiet.box.x) === Math.round(loud.box.x) &&
    Math.round(quiet.box.y) === Math.round(loud.box.y) &&
    Math.round(quiet.box.width) === Math.round(loud.box.width) &&
    Math.round(quiet.box.height) === Math.round(loud.box.height),
  `${JSON.stringify(quiet.box)} vs ${JSON.stringify(loud.box)}`
);
check(
  "a blend mode elsewhere on the canvas leaves the panel's backdrop blur alone",
  quiet.png.equals(loud.png),
  `${quiet.png.length} vs ${loud.png.length} bytes`
);

/* ---------------------------------------- 2. the control: it IS a blur */

// If the panel were NOT blurred, check 1 would pass by both captures being the
// same wrong picture. So the same fixture with no blur must differ.
await seed(fixture({ blend: "multiply", blur: 0 }));
const sharp = await shot("panel");
check(
  "the panel really is blurred — with Frost 0 it paints different pixels",
  !loud.png.equals(sharp.png),
  `${loud.png.length} vs ${sharp.png.length} bytes`
);

/* -------------------------------- 3. the blend itself still composites */

// The fix changes where the transform lives; it must not quietly turn blending
// off. The spot sits on the red rect rather than on bare canvas, precisely so
// that `multiply` is observable — white is the fixed point of every separable
// blend mode this DSL accepts.
await seed(fixture({ blend: null }));
const spotNormal = await shot("spot");
await seed(fixture({ blend: "multiply" }));
const spotBlended = await shot("spot");
check(
  "the blend mode still composites — multiply darkens the spot over the red rect",
  !spotNormal.png.equals(spotBlended.png),
  `${spotNormal.png.length} vs ${spotBlended.png.length} bytes`
);

check("no page errors", pageErrors.length === 0, pageErrors.join(" | "));

await browser.close();

const failed = results.filter((r) => !r.ok);
if (failed.length > 0) {
  console.error(`\n${failed.length} check(s) failed`);
  process.exit(1);
}
console.log("\nAll checks passed");
