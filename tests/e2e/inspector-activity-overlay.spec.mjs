import { chromium } from "playwright";
import { pathToFileURL } from "url";
import path from "path";

/**
 * The selection chrome stands down while an inspector VALUE is worked, and comes
 * back on its own.
 *
 * The second half is the one worth a test. A first version hid the overlay on any
 * `pointerdown` inside the panel, which meant clicking "resize to fit" left the
 * canvas with no handles to grab for two seconds — the next drag did nothing, and
 * three e2e suites failed in a way that read as a broken resize gesture rather than
 * a too-broad rule. A press on a control is a command; only editing is an edit.
 */
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

await page.evaluate(() => {
  const b = window.__FISH_BRIDGE__;
  b.setElements([
      { id: "F", type: "frame", name: "F", x: 300, y: 200, width: 240, height: 160, children: [] },
      { id: "a", type: "rect", name: "a", x: 600, y: 400, width: 100, height: 60, fills: [{ type: "solid", color: "#3B82F6" }] },
      { id: "b", type: "rect", name: "b", x: 600, y: 700, width: 140, height: 90, borderRadius: 18, cornerSmoothing: 0.4, fills: [{ type: "solid", color: "#F5C518" }] }
    ], { ...b.getDoc(), canvas: { ...b.getDoc().canvas, width: 4000, height: 3000 } });
});
await settle();
await page.evaluate(() => window.__FISH_BRIDGE__.selectElement("a"));
await settle();

// Its own marker, not `data-overlay`: the shape-draft group wears that too and is
// always mounted, so the shared attribute counts 2 when the selection is up and 1
// when it is suppressed — a difference that reads as a failure either way.
const overlay = () => page.locator("[data-selection-overlay]").count();
check("the overlay is up with a selection and an idle panel", await overlay(), 1);

// --- editing a value stands it down ---------------------------------------
const widthField = page.locator('[data-scrub-field="W"]');
await widthField.click();
await settle();
check("focusing the width field stands the overlay down", await overlay(), 0);

await widthField.fill("150");
await widthField.press("Enter");
await settle();
check("typing keeps it down", await overlay(), 0);
check("and the edit landed", await page.evaluate(() => window.__FISH_BRIDGE__.getElements().find((e) => e.id === "a").width), 150);

await page.waitForTimeout(2400);
check("and it comes back on its own once the panel goes quiet", await overlay(), 1);

const view = await page.evaluate(() => {
  const svg = document.querySelector("svg.pointer-events-auto");
  const box = svg.parentElement.getBoundingClientRect();
  const m = /translate\((-?[\d.]+), (-?[\d.]+)\) scale\(([\d.]+)\)/.exec((() => { const s = document.querySelector("[data-stage-transform]"); const a = s && s.getAttribute("transform"); if (a) return a; const svg = s && s.ownerSVGElement; const t = svg ? getComputedStyle(svg).transform : ""; const m = /matrix\(([\d.eE+-]+), 0, 0, ([\d.eE+-]+), ([\d.eE+-]+), ([\d.eE+-]+)\)/.exec(t); return m ? "translate(" + m[3] + ", " + m[4] + ") scale(" + m[1] + ")" : null; })());
  return { left: box.left, top: box.top, panX: parseFloat(m[1]), panY: parseFloat(m[2]), zoom: parseFloat(m[3]) };
});

// Scrubbing drives the value from the label, never through the DOM, so `input`
// never fires for it — the only signal is the press on the label itself. The
// number area is a text field, not a handle: a drag there selects text.
const xLabel = page.locator('[data-scrub-label="X"]');
const xBox = await xLabel.boundingBox();
await page.mouse.move(xBox.x + 4, xBox.y + xBox.height / 2);
await page.mouse.down();
await page.mouse.move(xBox.x + 26, xBox.y + xBox.height / 2, { steps: 6 });
await page.mouse.up();
await settle();
check("scrubbing a value stands it down too, with no input event involved", await overlay(), 0);

await page.mouse.move(view.left + 12, view.top + 12);
await settle();
check("leaving the panel brings it back, so a scrub can be followed by a drag", await overlay(), 1);

// --- an ICON-labelled field is still a value edit ---------------------------
// `data-scrub-label` is what this whole mechanism keys on, and it used to be
// written only when the label was a string. Every field labelled with a glyph —
// the corner controls, an ellipse's arcs — therefore kept its overlay up while
// its number was being scrubbed, which is the one thing suppression exists to
// stop. The label's TYPE is a rendering choice; being a value is not.
await page.evaluate(() => window.__FISH_BRIDGE__.selectElement("b"));
await settle();
check("an icon-labelled field still exposes the scrub handle", await page.locator('[data-inspector-section="corner"] [data-scrub-label]').count(), 2);

const cornerLabel = page.locator('[data-inspector-section="corner"] [data-scrub-label]').first();
const cBox = await cornerLabel.boundingBox();
await page.mouse.move(cBox.x + cBox.width / 2, cBox.y + cBox.height / 2);
await page.mouse.down();
await page.mouse.move(cBox.x + cBox.width / 2 + 40, cBox.y + cBox.height / 2, { steps: 6 });
await page.mouse.up();
await settle();
check("scrubbing an icon-labelled field stands the overlay down", await overlay(), 0);
// A rect stores its radius as `borderRadius`, so read that rather than the
// polygon/star spelling. Asserting a NUMBER here would bake the canvas's
// zoom-to-fit into the test; what matters is that the drag moved it the way the
// pointer went, so a scrub that stood the overlay down without changing anything
// cannot pass.
const radiusNow = await page.evaluate(() => window.__FISH_BRIDGE__.getElements().find((e) => e.id === "b").borderRadius);
check("and the value it drives moved the way the pointer went", radiusNow > 18, true);

await page.waitForTimeout(2400);
check("and it still comes back on its own", await overlay(), 1);


await settle();

// --- pressing a control is NOT editing ------------------------------------
// A control that is not a value: pressing it must not stand the overlay down,
// because the next thing the user does is go back to the canvas and grab a handle.
// The anchor grid is the control — it lives INSIDE the panel, which is the case
// the rule is about: a dock button was never an inspector target to begin with.
await page.keyboard.press("k");
await settle();
await page.locator('[data-scale-anchor-option="0,0"]').click();
await settle();
check("a panel button does not stand the overlay down", await overlay(), 1);
await page.keyboard.press("k");
await settle();
// Escape with nothing in path-edit also clears the selection, so put it back
// rather than relying on the popover having consumed the key.
await page.evaluate(() => window.__FISH_BRIDGE__.selectElement("a"));
await settle();

// --- and a canvas press restores it immediately ----------------------------
await page.locator('[data-scrub-field="W"]').click();
await settle();
check("editing stands it down again", await overlay(), 0);
await page.mouse.click(view.left + view.panX + 900 * view.zoom, view.top + view.panY + 620 * view.zoom);
await settle();
check("and a press on the canvas still brings them straight back", await overlay(), 1);

check("no page errors", errors, []);

let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  console.log(`${r.ok ? "✔" : "✖"} ${r.name}`);
  if (!r.ok) console.log(`    expected ${JSON.stringify(r.expected)}, got ${JSON.stringify(r.actual)}`);
}
await browser.close();
console.log(failed === 0 ? "\nAll checks passed" : `\n${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
