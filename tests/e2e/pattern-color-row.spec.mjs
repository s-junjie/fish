import { chromium } from "playwright";
import { pathToFileURL } from "url";
import path from "node:path";

// A pattern's colour row: its alpha well is a scrub — one gesture, one undo
// entry — and the picker it opens edits a COLOUR, so it offers no kind switcher.
//
// The undo half did not hold: the pattern body wrote its colour as a DISCRETE
// edit, so every pointermove of the drag committed a snapshot of its own.
// `commit` clears the frozen gesture snapshot as it records, which left
// `endGesture` nothing to collapse, and a 40px drag became ~40 undo steps. The
// bracket the row already passed down was inert; the write had to stop claiming
// to be discrete.
const html = path.resolve(process.cwd(), process.argv[2] ?? "dist/index.html");

const ELEMENTS = [
  {
    id: "p_pat",
    type: "rect",
    name: "Pattern Rect",
    x: 240,
    y: 220,
    width: 260,
    height: 180,
    fills: [
      {
        type: "pattern",
        motif: "dots",
        tile: { width: 16, height: 16 },
        foreground: "#EF4444",
        background: "#FFFFFF"
      }
    ]
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
await page.evaluate((elements) => {
  const bridge = window.__FISH_BRIDGE__;
  const base = bridge.getDoc();
  bridge.setElements(JSON.parse(JSON.stringify(elements)), {
    canvas: { ...base.canvas, width: 2000, height: 1400 }
  });
}, ELEMENTS);
await page.waitForTimeout(700);

const paint = () =>
  page.evaluate(() => {
    const doc = window.__FISH_BRIDGE__.getDoc();
    const page_ = doc.pages.find((p) => p.id === doc.activePageId);
    return page_.children.find((e) => e.id === "p_pat").fills[0];
  });
const undo = () => page.evaluate(() => window.__FISH_BRIDGE__.undo());

await page.evaluate(() => window.__FISH_BRIDGE__.selectElement("p_pat"));
await page.waitForTimeout(300);
await page.locator("[data-paint-swatch]").first().click();
await page.waitForTimeout(350);
check("the pattern body is on screen", (await page.locator("[data-pattern-motif]").count()) === 5);

// ── 1. the alpha scrub is one undo step ─────────────────────────────────────
const alpha = page.locator('[data-color-panel] [data-scrub-label="%"]').first();
const box = await alpha.boundingBox();
check("the colour row has an alpha handle to drag", !!box, JSON.stringify(box));
// Left, because the row opens at 100% and a drag right has nowhere to go.
await page.mouse.move(box.x + 4, box.y + box.height / 2);
await page.mouse.down();
await page.mouse.move(box.x - 36, box.y + box.height / 2, { steps: 12 });
await page.mouse.up();
await page.waitForTimeout(400);

const dragged = await paint();
check(
  "dragging it changes the alpha",
  /^#[0-9a-f]{6}[0-9a-f]{2}$/i.test(dragged.foreground) && dragged.foreground.toLowerCase() !== "#ef4444",
  `foreground=${dragged.foreground}`
);

await undo();
await page.waitForTimeout(300);
const afterOne = await paint();
check(
  "ONE undo returns the colour the drag started from",
  afterOne.foreground.toLowerCase() === "#ef4444",
  `after one undo foreground=${afterOne.foreground}`
);
check(
  "and the pattern itself is still the layer's fill",
  afterOne.type === "pattern" && afterOne.motif === "dots",
  JSON.stringify(afterOne)
);

// ── 2. a TYPED alpha is still recorded, and still exactly one step ──────────
// The same field, the other shape of edit: the drag stopped claiming to be
// discrete, and a typed value must not have stopped being recorded with it.
const field = page.locator('[data-color-panel] [data-scrub-field="%"]').first();
await field.click();
await field.fill("60");
await page.keyboard.press("Enter");
await page.waitForTimeout(400);
const typed = await paint();
check(
  "typing an alpha applies it",
  /^#[0-9a-f]{6}99$/i.test(typed.foreground),
  `foreground=${typed.foreground}`
);

await undo();
await page.waitForTimeout(300);
const afterTypedUndo = await paint();
check(
  "and one undo takes it back",
  afterTypedUndo.foreground.toLowerCase() === "#ef4444",
  `foreground=${afterTypedUndo.foreground}`
);

// ── 3. the picker this row opens edits a colour, not a kind ─────────────────
// It used to show the full switcher. Gradient / Image / Pattern switched the
// panel to a paint the field cannot store — the write keeps `solid` and drops
// the rest — so the choice was visible and inert. Kind belongs to the fill
// stack, which is the panel BEHIND this one.
// A field's Enter commits without closing the panel, so the pattern panel is
// still standing here; the guard is for a dismissal earlier in the run.
if ((await page.locator("[data-color-panel]").count()) === 0) {
  await page.locator("[data-paint-swatch]").first().click();
  await page.waitForTimeout(350);
}
await page.locator('[data-color-panel] [data-paint-swatch="color-field"]').first().click();
await page.waitForTimeout(350);

const panels = await page.evaluate(() =>
  [...document.querySelectorAll("[data-color-panel]")].map((panel) => ({
    tabs: [...panel.querySelectorAll("[data-paint-tab]")].map((b) => b.getAttribute("data-paint-tab")),
    hasSv: !!panel.querySelector('[data-sv-area="1"]')
  }))
);
check("the colour row opens a picker of its own", panels.length === 2, `panels=${panels.length}`);
check(
  "the host — the fill's own panel — keeps its four kinds",
  JSON.stringify(panels[0]?.tabs) === JSON.stringify(["solid", "gradient", "image", "pattern"]),
  JSON.stringify(panels[0])
);
check(
  "the colour picker offers no kind switcher at all",
  panels[1]?.tabs.length === 0,
  JSON.stringify(panels[1]?.tabs)
);
check("and it is the solid picker", panels[1]?.hasSv === true, JSON.stringify(panels[1]));

check("no console errors", errors.length === 0, errors.slice(0, 3).join(" | "));

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
await browser.close();
process.exit(passed === results.length ? 0 : 1);
