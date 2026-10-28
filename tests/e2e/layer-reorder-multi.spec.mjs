import { chromium } from "playwright";
import { pathToFileURL } from "url";
import path from "path";

/**
 * A layer-panel drag carries a BLOCK, not the row the pointer went down on.
 *
 * The panel listed the whole selection, the drop read back one id, and the tree
 * moved exactly that one row — so multi-selecting three layers and dragging them
 * past a fourth left two of them behind, in an order nobody asked for. The
 * canvas has answered this correctly since `applyDropSlot`; this is the panel
 * catching up.
 *
 * The panel lists a z-ordered parent front-first, so the row at the top of the
 * panel is the LAST child in the array. Every expectation below is written in
 * array order and the panel order is asserted separately, because reading the
 * wrong one of the two is how "it did move, just the wrong way" passes.
 */
const html = path.resolve(process.cwd(), process.argv[2] ?? "dist/index.html");
const results = [];
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  results.push({ name, ok, actual, expected });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` — got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`}`);
};
/** The boolean twin, kept separate so a truthy `actual` cannot pass a value check. */
const checkThat = (name, ok, detail) => {
  results.push({ name, ok: !!ok, actual: detail ?? null });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
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
  page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

const rect = (id, y) => ({
  id,
  type: "rect",
  name: id,
  x: 0,
  y,
  width: 100,
  height: 60,
  fills: [{ type: "solid", color: "#3B82F6" }]
});

const fresh = async () => {
  await page.evaluate((els) => {
    const b = window.__FISH_BRIDGE__;
    const doc = b.getDoc();
    b.setElements(els, { canvas: { ...doc.canvas, width: 4000, height: 3000 } });
  }, [rect("n1", 0), rect("n2", 100), rect("n3", 200), rect("n4", 300)]);
  await settle();
};

/** Child order in the document — the array the drop splices. */
const order = () =>
  page.evaluate(() => {
    const doc = window.__FISH_BRIDGE__.getDoc();
    const page_ = doc.pages.find((p) => p.id === doc.activePageId) ?? doc;
    return page_.children.map((el) => el.id);
  });

/** Row order as the user sees it: front-first for a parent with no layout. */
const panelOrder = () =>
  page.evaluate(() =>
    [...document.querySelectorAll('[data-ui-panel="left"] [data-layer-row]')].map((r) =>
      r.getAttribute("data-layer-row")
    )
  );

const selected = () => page.evaluate(() => window.__FISH_BRIDGE__.getSelectedIds().slice().sort());

/** Drop onto a fraction of the target row's height — 0.1 is the top edge, 0.9 the bottom. */
const dragOnto = async (fromId, toId, yRatio) => {
  const height = await page.evaluate(
    (toId) =>
      document.querySelector(`[data-ui-panel="left"] [data-layer-row="${toId}"]`).getBoundingClientRect().height,
    toId
  );
  await page.dragAndDrop(
    `[data-ui-panel="left"] [data-layer-row="${fromId}"]`,
    `[data-ui-panel="left"] [data-layer-row="${toId}"]`,
    { targetPosition: { x: 40, y: Math.round(height * yRatio) } }
  );
};

// --- the control: one selected row still moves one row ---------------------
await fresh();
check("seeded order", await order(), ["n1", "n2", "n3", "n4"]);
check("panel lists front-first", await panelOrder(), ["n4", "n3", "n2", "n1"]);

await page.click('[data-ui-panel="left"] [data-layer-row="n1"]');
await settle();
await dragOnto("n1", "n3", 0.9);
await settle();
check("a single-row drag still reorders", await order(), ["n2", "n1", "n3", "n4"]);

// --- the reported case: a multi-selection reorders as one ------------------
await fresh();
check("back to the seeded order", await order(), ["n1", "n2", "n3", "n4"]);

// Panel rows run n4, n3, n2, n1 — so n3 sits above n2 and shift-clicking
// downward extends the range.
await page.click('[data-ui-panel="left"] [data-layer-row="n3"]');
await page.click('[data-ui-panel="left"] [data-layer-row="n2"]', { modifiers: ["Shift"] });
await settle();
check("both rows are selected", await selected(), ["n2", "n3"]);

// Above `n4` in a front-first list is `after` it in the array, and the two
// dragged rows land there together in document order.
await dragOnto("n3", "n4", 0.1);
await settle();
check("the whole selection moved", await order(), ["n1", "n4", "n2", "n3"]);
check("and the panel shows it", await panelOrder(), ["n3", "n2", "n4", "n1"]);

// --- a drop onto a row inside the block changes nothing --------------------
await fresh();
await page.click('[data-ui-panel="left"] [data-layer-row="n3"]');
await page.click('[data-ui-panel="left"] [data-layer-row="n2"]', { modifiers: ["Shift"] });
await settle();
await dragOnto("n3", "n2", 0.1);
await settle();
check("a drop onto one of the dragged rows is a no-op", await order(), ["n1", "n2", "n3", "n4"]);

// --- undo is one step for the whole block ----------------------------------
await fresh();
await page.click('[data-ui-panel="left"] [data-layer-row="n3"]');
await page.click('[data-ui-panel="left"] [data-layer-row="n2"]', { modifiers: ["Shift"] });
await settle();
await dragOnto("n3", "n4", 0.1);
await settle();
await page.evaluate(() => window.__FISH_BRIDGE__.undo());
await settle();
check("one undo takes back the whole block", await order(), ["n1", "n2", "n3", "n4"]);

// --- the drag image says how many rows are in flight -----------------------
// `dragAndDrop` is over before anything can look at the page, so the stack is
// read from a drag held open by hand.
const ghost = () =>
  page.evaluate(() => {
    const stack = document.querySelector("[data-layer-drag-stack]");
    if (!stack) return null;
    const cards = [...stack.querySelectorAll("[data-layer-drag-card]")].map((c) =>
      Math.round(c.getBoundingClientRect().left)
    );
    return {
      depth: Number(stack.getAttribute("data-layer-drag-stack-depth")),
      cards: cards.length,
      /** Each card steps down and right, so the lefts are strictly ordered. */
      stepped: cards.every((x, i) => i === 0 || x > cards[i - 1]),
      box: stack.getBoundingClientRect().toJSON()
    };
  });

/** Press a row, hold the drag open, and report the stack mid-flight. */
const dragHeld = async (fromId, toId, yRatio, shot) => {
  const source = await page.locator(`[data-ui-panel="left"] [data-layer-row="${fromId}"]`).boundingBox();
  const target = await page.locator(`[data-ui-panel="left"] [data-layer-row="${toId}"]`).boundingBox();
  const from = { x: source.x + 40, y: source.y + source.height / 2 };
  const to = { x: target.x + 40, y: target.y + target.height * yRatio };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  // Chromium needs real travel before a native drag starts; three pixels is the
  // threshold, and a probe that skips it measures nothing.
  await page.mouse.move(from.x + 6, from.y + 6, { steps: 3 });
  const held = await ghost();
  await page.mouse.move(to.x, to.y, { steps: 8 });
  const moved = await ghost();
  // The reader's proof: the stack and the drop line only exist while the pointer
  // is down, so the shot has to be taken mid-drag.
  if (shot) await page.screenshot({ path: shot });
  await page.mouse.up();
  await settle();
  return { held, moved };
};

await fresh();
await page.click('[data-ui-panel="left"] [data-layer-row="n2"]');
await settle();
const one = await dragHeld("n2", "n4", 0.9);
check("a single-row drag stacks nothing", one.held, null);

await fresh();
await page.click('[data-ui-panel="left"] [data-layer-row="n3"]');
await page.click('[data-ui-panel="left"] [data-layer-row="n2"]', { modifiers: ["Shift"] });
await settle();
const two = await dragHeld("n3", "n4", 0.1, ".workbuddy/artifacts/layer-drag-ghost.png");
check("a two-row drag puts one card behind the image", two.held && two.held.cards, 1);
checkThat("and the cards step down and right", two.held && two.held.stepped, two.held && two.held.cards);
checkThat(
  "the stack tracks the pointer",
  two.moved && two.held && two.moved.box.top < two.held.box.top,
  { before: two.held && two.held.box.top, after: two.moved && two.moved.box.top }
);
check("and it is gone once the drop lands", await ghost(), null);
check("the drop still reordered the block", await order(), ["n1", "n4", "n2", "n3"]);

// A bigger selection stacks deeper, up to a cap: forty rows cannot print forty
// cards behind the cursor.
await page.evaluate((els) => {
  const b = window.__FISH_BRIDGE__;
  const doc = b.getDoc();
  b.setElements(els, { canvas: { ...doc.canvas, width: 4000, height: 3000 } });
}, [rect("n1", 0), rect("n2", 100), rect("n3", 200), rect("n4", 300), rect("n5", 400)]);
await settle();
// Shift-click spans the rows BETWEEN anchor and target, so the whole set is the
// first row down to the last one up.
await page.click('[data-ui-panel="left"] [data-layer-row="n5"]');
await page.click('[data-ui-panel="left"] [data-layer-row="n1"]', { modifiers: ["Shift"] });
await settle();
check("all five rows are selected", (await selected()).length, 5);
const five = await dragHeld("n5", "n1", 0.1);
check("a five-row drag stacks three cards, and stops", five.held && five.held.cards, 3);

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed, ${failed.length} failed`);
if (failed.length) for (const f of failed) console.log(`  FAILED: ${f.name} — got ${JSON.stringify(f.actual)}, expected ${JSON.stringify(f.expected)}`);
if (errors.length) {
  console.log("page errors:");
  for (const e of errors) console.log(`  ${e}`);
}
await browser.close();
process.exit(failed.length === 0 && errors.length === 0 ? 0 : 1);
