import { activeElements } from "./_support/doc.mjs";
import { chromium } from "playwright";
import { pathToFileURL } from "url";
import path from "path";

// Two inspector actions around the main-component button:
//   1. a selected component no longer offers "Create Instance" — the assets panel
//      is where a component is instantiated from, and a second control next to the
//      definition invited the wrong edit;
//   2. a multi-selection turns the button into "Create Multiple Components", which
//      promotes each top-level selected element into its own component.
const html = path.resolve(process.cwd(), process.argv[2] ?? "dist/index.html");
const results = [];
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  results.push({ name, ok, actual, expected });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  -> got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`);
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

const frame = (id, x, y, w, h) => ({
  id,
  type: "frame",
  name: id,
  x,
  y,
  width: w,
  height: h,
  fills: [{ type: "solid", color: "#2A2A2A" }],
  clipContent: false,
  children: [
    { id: `${id}_kid`, type: "rect", name: "kid", x: 10, y: 10, width: 40, height: 30,
      fills: [{ type: "solid", color: "#3B82F6" }] }
  ]
});

await page.evaluate(
  ([frameSrc]) => {
    const makeFrame = eval(`(${frameSrc})`);
    const bridge = window.__FISH_BRIDGE__;
    const base = bridge.getDoc();
    bridge.setElements([
        makeFrame("A", 0, 0, 200, 150),
        makeFrame("B", 260, 0, 200, 150),
        makeFrame("C", 520, 0, 200, 150),
        // A frame holding another frame, to prove only the outer one is promoted.
        {
          id: "OUTER",
          type: "frame",
          name: "OUTER",
          x: 780,
          y: 0,
          width: 300,
          height: 220,
          fills: [{ type: "solid", color: "#1F1F1F" }],
          clipContent: false,
          children: [makeFrame("INNER", 20, 20, 200, 150)]
        }
      ], { canvas: { ...base.canvas, width: 4000, height: 3000 } });
  },
  [frame.toString()]
);
await page.waitForTimeout(400);

const doc = () => page.evaluate(() => window.__FISH_BRIDGE__.getDoc());
const selected = () => page.evaluate(() => window.__FISH_BRIDGE__.getSelectedIds());

// Multi-selection is a canvas gesture (⇧-click), the only way the app builds one.
// The point is taken from the lower-right of the frame's box: a frame's bounding
// rect also covers the title label drawn above it, so its centre is not the box
// centre, and each fixture frame's child sits in its top-left corner.
const clickFrame = async (id, { shift = false } = {}) => {
  const pt = await page.evaluate((elId) => {
    const r = document.querySelector(`[data-element-id="${elId}"]`).getBoundingClientRect();
    return { x: r.left + r.width * 0.8, y: r.top + r.height * 0.85 };
  }, id);
  if (shift) await page.keyboard.down("Shift");
  await page.mouse.click(pt.x, pt.y);
  if (shift) await page.keyboard.up("Shift");
  await page.waitForTimeout(160);
};
const selectFrames = async (ids) => {
  for (let i = 0; i < ids.length; i += 1) await clickFrame(ids[i], { shift: i > 0 });
};
// A selected frame swallows clicks inside it, so a parent and its own child can
// only be selected together from the layer rows, where ⇧ extends the range.
const row = (id) => `[data-ui-panel="left"] [data-layer-row="${id}"]`;
const selectRows = async (ids) => {
  for (let i = 0; i < ids.length; i += 1) {
    await page.click(row(ids[i]), i > 0 ? { modifiers: ["Shift"] } : {});
    await page.waitForTimeout(160);
  }
};

const panelText = () =>
  page.evaluate(() => document.querySelector('[data-ui-panel="right"]')?.innerText || "");
const createButton = () =>
  page.evaluate(() => {
    const single = document.querySelector("[data-create-component]");
    const many = document.querySelector("[data-create-components]");
    const el = many || single;
    return el
      ? {
          // textContent, not innerText: the glyph is its own span and innerText
          // would fold a newline into the label.
          label: (el.textContent || "").replace("❖", "").trim(),
          count: many ? many.getAttribute("data-create-components") : null,
          disabled: el.disabled
        }
      : null;
  });
const typesOf = (els) => (els || []).map((e) => e.type);

// --- 1. a single frame still promotes one component -------------------------
await selectFrames(["A"]);
const singleLabel = await createButton();
check("a single frame offers the single-component action", [singleLabel?.label, singleLabel?.count], ["Create Component", null]);

// --- 2. several frames offer the batch action -------------------------------
await selectFrames(["A", "B", "C"]);
check("three frames are selected", (await selected()).sort(), ["A", "B", "C"]);
const manyLabel = await createButton();
check("a multi-selection offers the batch action", [manyLabel?.label, manyLabel?.count], ["Create Multiple Components", "3"]);

await page.click("[data-create-components]");
await page.waitForTimeout(400);
const afterBatch = await doc();
check("every selected frame became a component", typesOf(activeElements(afterBatch)), ["component", "component", "component", "frame"]);
check("they kept their ids and names", activeElements(afterBatch).slice(0, 3).map((e) => e.id), ["A", "B", "C"]);
check("the batch is selected together", (await selected()).sort(), ["A", "B", "C"]);
check("the children came along inside each component", typesOf(activeElements(afterBatch)[0].children), ["rect"]);

// The button must go back to its single form now that the selection collapsed.
await selectFrames(["OUTER"]);
check("with one frame selected it is the single action again", (await createButton())?.label, "Create Component");

// --- 3. a frame selected together with its own child promotes only the outer -
await selectRows(["OUTER", "INNER"]);
check("a parent and its child can be selected together", (await selected()).sort(), ["INNER", "OUTER"]);
const nestedLabel = await createButton();
check("a selection containing a nested frame counts only the outer one", nestedLabel?.count, "1");
check("with one target left it keeps the singular wording", nestedLabel?.label, "Create Component");
await page.click("[data-create-components]");
await page.waitForTimeout(400);
const afterNested = await doc();
const outerAfter = activeElements(afterNested).find((e) => e.id === "OUTER");
check(
  "only the outer frame became a component, and it kept the inner one as a child",
  [
    activeElements(afterNested).map((e) => `${e.id}:${e.type}`),
    (outerAfter.children || []).map((c) => `${c.id}:${c.type}`)
  ],
  [
    ["A:component", "B:component", "C:component", "OUTER:component"],
    ["INNER:frame"]
  ]
);

// --- 4. a selected component offers no "Create Instance" -------------------
await selectFrames(["A"]);
const compPanel = await panelText();
// Asserted on the section's own hook rather than a heading string: the panel used
// to say "Main Component" here, and that heading went with the removed component
// properties. What this test is actually about is that selecting a component
// SHOWS the component section — `data-variant-properties` is the element that
// renders it, so a rename of any label cannot quietly turn this into a no-op.
check(
  "the component panel is showing",
  await page.$("[data-variant-properties]") !== null,
  true
);
// Case-insensitive: DESIGN.md keeps every label but the section header in
// sentence case, so the capitalised "Variant" this once matched is a spelling no
// longer allowed to appear — the wording is "Add variant". What is asserted is
// that the panel NAMES the variant axis at all, and the hook above already pins
// the element that renders it.
check(
  "the component panel mentions its variants",
  compPanel.toLowerCase().includes("variant"),
  true
);
check(
  "a selected component offers no Create Instance button",
  [compPanel.includes("Create Instance"), (await page.$('[title="Create Instance"]')) !== null],
  [false, false]
);
check(
  "a selected component offers no promote action either",
  (await createButton())?.label ?? null,
  null
);

// --- 5. the component group sits at the TOP of the panel --------------------
// Asserted with real DOM order, not class names: what matters is what the user
// sees first, and a stylesheet change could re-arrange anything.
const order = await page.evaluate(() => {
  const panel = document.querySelector('[data-ui-panel="right"]');
  const comp = panel.querySelector('[data-inspector-section="component"]');
  const transform = panel.querySelector('[data-inspector-section="transform"]');
  if (!comp || !transform) return { comp: !!comp, transform: !!transform };
  return {
    comp: !!comp,
    transform: !!transform,
    // Node.DOCUMENT_POSITION_FOLLOWING === 4: `transform` comes after `comp`.
    componentAboveTransform: Boolean(comp.compareDocumentPosition(transform) & 4),
    // The wrapper is rendered unconditionally, so "first child" is ALSO true of the
    // empty div a selection with nothing to show would leave behind — the one case
    // where the component section is not on top of anything. Checked apart, so an
    // empty wrapper is reported as the cause rather than as a broken order.
    holdsSomething: comp.childElementCount > 0,
    // …and "top" means the first thing in the panel's scrolling body, not merely
    // above one other section.
    isFirstSection: comp.parentElement.firstElementChild === comp && comp.childElementCount > 0
  };
});
check("the component section is in the panel", order.comp, true);
check("the component section is above the transform section", order.componentAboveTransform, true);
check("the component section actually rendered something", order.holdsSomething, true);
check("the component section is the panel's first section", order.isFirstSection, true);

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
console.log("pageErrors", errors.slice(0, 5));

await browser.close();
process.exit(failed.length === 0 && errors.length === 0 ? 0 : 1);
