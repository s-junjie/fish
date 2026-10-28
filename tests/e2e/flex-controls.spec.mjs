import { chromium } from "playwright";
import { pathToFileURL } from "url";
import path from "path";

// The three flex controls added beside the original single gap / equal split:
//   1. a second, cross-axis gap field that only appears once the stack wraps;
//   2. an align-content menu for the wrapped lines, likewise wrap-only;
//   3. a flex-grow weight on a child that fills its parent's main axis, and
//      nothing at all on one that does not.
//
// Each is driven through the real inspector and read back from the document, so
// a control that renders but writes nothing fails here rather than looking right.
const html = path.resolve(process.cwd(), process.argv[2] ?? "dist/index.html");
const results = [];
const check = (name, ok, detail) => results.push({ name, ok: !!ok, detail });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});

await page.goto(pathToFileURL(html).href);
await page.waitForFunction(() => !!window.__FISH_BRIDGE__);

await page.evaluate(() => {
  const bridge = window.__FISH_BRIDGE__;
  const base = bridge.getDoc();
  bridge.setElements([
      {
        id: "WRAP",
        type: "frame",
        name: "Wrap",
        x: 100,
        y: 100,
        width: 210,
        height: 300,
        fills: [{ type: "solid", color: "#F4F4F5" }],
        display: "flex",
        "flex-direction": "row",
        "flex-wrap": "wrap",
        gap: 10,
        "align-content": "center",
        children: [
          { id: "w1", type: "rect", x: 0, y: 0, width: 90, height: 40, fills: [{ type: "solid", color: "#111111" }] },
          { id: "w2", type: "rect", x: 100, y: 0, width: 90, height: 40, fills: [{ type: "solid", color: "#222222" }] },
          { id: "w3", type: "rect", x: 0, y: 50, width: 90, height: 40, fills: [{ type: "solid", color: "#333333" }] }
        ]
      },
      {
        id: "GROWF",
        type: "frame",
        name: "Grow",
        x: 100,
        y: 500,
        width: 300,
        height: 80,
        fills: [{ type: "solid", color: "#F4F4F5" }],
        display: "flex",
        "flex-direction": "row",
        gap: 0,
        children: [
          { id: "g1", type: "rect", x: 0, y: 0, width: 50, height: 40, sizing: { width: "fill" }, fills: [{ type: "solid", color: "#111111" }] },
          { id: "g2", type: "rect", x: 150, y: 0, width: 50, height: 40, sizing: { width: "fill" }, fills: [{ type: "solid", color: "#222222" }] },
          { id: "g3", type: "rect", x: 250, y: 0, width: 40, height: 40, fills: [{ type: "solid", color: "#333333" }] }
        ]
      },
      {
        id: "HUGW",
        type: "frame",
        name: "Hug wrap",
        x: 500,
        y: 100,
        width: 210,
        height: 90,
        sizing: { height: "fit-content" },
        fills: [{ type: "solid", color: "#F4F4F5" }],
        display: "flex",
        "flex-direction": "row",
        "flex-wrap": "wrap",
        gap: 10,
        children: [
          { id: "h1", type: "rect", x: 0, y: 0, width: 90, height: 40, fills: [{ type: "solid", color: "#111111" }] },
          { id: "h2", type: "rect", x: 100, y: 0, width: 90, height: 40, fills: [{ type: "solid", color: "#222222" }] },
          { id: "h3", type: "rect", x: 0, y: 50, width: 90, height: 40, fills: [{ type: "solid", color: "#333333" }] }
        ]
      }
    ], { canvas: { ...base.canvas, width: 3000, height: 2000 } });
});

const settle = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
const select = async (id) => {
  await page.evaluate((i) => window.__FISH_BRIDGE__.selectElement(i), id);
  await settle();
};
const has = (selector) => page.evaluate((s) => !!document.querySelector(s), selector);
// The document stores auto layout FLAT (CSS property names at the top level), so
// a probe that reads `el.layout` reads a key nothing writes.
const docLayout = (id) =>
  page.evaluate((i) => {
    const el = window.__FISH_BRIDGE__.getElements().find((e) => e.id === i);
    if (!el) return null;
    return {
      display: el.display,
      direction: el["flex-direction"],
      wrap: el["flex-wrap"],
      align: el["align-items"],
      alignContent: el["align-content"],
      gap: el.gap,
      rowGap: el["row-gap"],
      columnGap: el["column-gap"]
    };
  }, id);
const childOf = (parentId, childId) =>
  page.evaluate(
    ([p, c]) => window.__FISH_BRIDGE__.getElements().find((e) => e.id === p)?.children?.find((e) => e.id === c) ?? null,
    [parentId, childId]
  );

/** Type a number into a ScrubInput and commit it on blur, the way a user would. */
const setField = async (selector, value) => {
  await page.evaluate(
    ([s, v]) => {
      const input = document.querySelector(`${s} input`);
      if (!input) return;
      input.focus();
      input.value = String(v);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.blur();
    },
    [selector, value]
  );
  await settle();
};

/**
 * Pick an alignment value the way a person does now: open the field, press the
 * row. These four were native `<select>`s until each option got a drawing, so
 * `selectOption` no longer applies — and driving the real menu also covers the
 * dismissal and the write in one pass.
 */
const pickAlignment = async (attr, value) => {
  await page.click(`[${attr}]`);
  await page.click(`[data-align-option="${value}"]`);
  await settle();
};

// ----------------------------------------------------------- wrap-only fields
await select("WRAP");
check("a wrapping stack shows the cross-axis (line) gap field", await has("[data-stack-line-gap]"));
check("a wrapping stack shows the align-content menu", await has("[data-stack-align-content]"));

const seeded = await page.evaluate(() => document.querySelector("[data-stack-align-content]").dataset.alignValue);
check("the align-content menu reads the document's value", seeded === "center", seeded);

await pickAlignment("data-stack-align-content", "space-between");
await settle();
check(
  "choosing align-content writes it to the document",
  (await docLayout("WRAP"))?.alignContent === "space-between",
  JSON.stringify(await docLayout("WRAP"))
);

// The main gap resets both axes (uniform shorthand), so set it first.
await setField("[data-stack-gap='true']", 16);
const afterMain = await docLayout("WRAP");
check(
  "the main gap field writes the uniform `gap`",
  afterMain?.gap === 16 && afterMain?.rowGap === undefined,
  JSON.stringify(afterMain)
);

await setField("[data-stack-line-gap]", 24);
const afterCross = await docLayout("WRAP");
check(
  "the line-gap field writes the cross axis only, leaving the main gap",
  afterCross?.rowGap === 24 && afterCross?.gap === 16,
  JSON.stringify(afterCross)
);

// A non-wrapping stack gets neither field.
await select("GROWF");
check("a non-wrapping stack shows no line-gap field", !(await has("[data-stack-line-gap]")));
check("a non-wrapping stack shows no align-content menu", !(await has("[data-stack-align-content]")));

// `align-content` can only move lines when there is slack BETWEEN them. A frame
// that hugs its cross axis has none, so the menu is disabled and says why —
// an enabled menu that changes nothing is what got reported as "it does nothing".
const alignContentState = () =>
  page.evaluate(() => {
    const s = document.querySelector("[data-stack-align-content]");
    return { disabled: s?.disabled === true, hint: s?.closest("div.space-y-1")?.querySelector("p")?.textContent ?? "" };
  });

await select("WRAP");
const wide = await alignContentState();
check("a fixed-height stack with two lines leaves align-content enabled", !wide.disabled, wide.hint);

await select("HUGW");
const hug = await alignContentState();
check("a hugging stack disables align-content", hug.disabled);
check("and names the reason", hug.hint.includes("hugs"), hug.hint);

// ------------------------------------------------------------------ flex grow
await select("g1");
check("a fill child shows the flex-grow field", await has("[data-stack-flex-grow]"));
await setField("[data-stack-flex-grow]", 3);
const grown = await childOf("GROWF", "g1");
check("the flex-grow field writes the weight", grown?.["flex-grow"] === 3, JSON.stringify(grown));

await settle();
const widths = await page.evaluate(() =>
  ["g1", "g2"].map((id) => {
    const doc = window.__FISH_BRIDGE__.getDoc();
    const s = window.__FISH_BRIDGE__.getElements().find((e) => e.id === "GROWF");
    return s.children.find((c) => c.id === id).width;
  })
);
// 300 content, less g3's fixed 40 → 260 split 3:1 → 195 / 65
check("the weight is honoured by the layout pass", widths[0] === 195 && widths[1] === 65, JSON.stringify(widths));

await select("g3");
check("a non-fill child shows no flex-grow field", !(await has("[data-stack-flex-grow]")));

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : `  -> ${r.detail ?? ""}`}`);
}
console.log(`\n${results.length - failed.length}/${results.length} passed`);
console.log("pageErrors", errors.slice(0, 5));

await browser.close();
process.exit(failed.length === 0 && errors.length === 0 ? 0 : 1);
