import { chromium } from "playwright";
import { pathToFileURL } from "url";
import fs from "fs";
import path from "path";

// Two UI-level behaviours unit tests cannot reach:
//   1. switching to a page that was never opened must lay it out (P1-4)
//   2. dragging inside a stack must show the landing slot before release, and
//      land where the slot promised — also for a multi-select drag (P2-2)
//   3. the layer panel lists a stack's children in flow order, and a free
//      frame's front-first
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

const solid = "(c) => [{ type: 'solid', color: c }]";

// --- 1. multi-page ---------------------------------------------------------
await page.evaluate(() => {
  const base = window.__FISH_BRIDGE__.getDoc();
  const solid = (color) => [{ type: "solid", color }];
  // Page 2 as a script writes it: a stack whose children carry no coordinates.
  const page2 = [
    {
      id: "p2row",
      type: "frame",
      name: "Page 2 Row",
      x: 100,
      y: 100,
      width: 400,
      height: 120,
      fills: solid("#2b2b2b"),
      display: "flex",
      "flex-direction": "row",
      gap: 8,
      padding: 0,
      children: [
        { id: "p2a", type: "rect", name: "P2A", x: 0, y: 0, width: 80, height: 40, fills: solid("#e0483b") },
        { id: "p2b", type: "rect", name: "P2B", x: 0, y: 0, width: 80, height: 40, fills: solid("#3ba55d") },
        { id: "p2c", type: "rect", name: "P2C", x: 0, y: 0, width: 80, height: 40, fills: solid("#3b82f6") }
      ]
    }
  ];
  const pages = base.pages.length >= 2
    ? base.pages.map((p, i) => (i === 1 ? { ...p, children: page2 } : p))
    : [...base.pages, { id: "page_2", name: "Page 2", canvas: base.canvas, children: page2 }];
  window.__FISH_BRIDGE__.applyDoc({ ...base, pages });
});

const page2Id = await page.evaluate(() => {
  const doc = window.__FISH_BRIDGE__.getDoc();
  return doc.pages[1].id;
});
await page.click(`[data-page-id="${page2Id}"]`);
await page.waitForTimeout(120);

const page2State = await page.evaluate(() => {
  const doc = window.__FISH_BRIDGE__.getDoc();
  const p = doc.pages.find((x) => x.id === doc.activePageId) ?? doc.pages[0];
  const frame = (p.children ?? []).find((e) => e.id === "p2row");
  return { active: doc.activePageId, kids: (frame?.children ?? []).map((c) => ({ id: c.id, x: c.x, y: c.y })) };
});
check("switched to page 2", page2State.active === page2Id, page2State.active);
check(
  "page 2 was laid out on arrival (children no longer stacked at 0,0)",
  page2State.kids.length === 3 && new Set(page2State.kids.map((k) => k.x)).size === 3,
  JSON.stringify(page2State.kids)
);

// --- 2. drop slot on the canvas -------------------------------------------
await page.evaluate(() => {
  const base = window.__FISH_BRIDGE__.getDoc();
  const solid = (color) => [{ type: "solid", color }];
  const elements = [
    {
      id: "row",
      type: "frame",
      name: "Row",
      x: 100,
      y: 100,
      width: 400,
      height: 120,
      fills: solid("#2b2b2b"),
      display: "flex",
      "flex-direction": "row",
      gap: 8,
      padding: 0,
      children: [
        { id: "a", type: "rect", name: "A", x: 0, y: 0, width: 80, height: 40, fills: solid("#e0483b") },
        { id: "b", type: "rect", name: "B", x: 88, y: 0, width: 80, height: 40, fills: solid("#3ba55d") },
        { id: "c", type: "rect", name: "C", x: 176, y: 0, width: 80, height: 40, fills: solid("#3b82f6") }
      ]
    },
    {
      id: "free",
      type: "frame",
      name: "Free",
      x: 100,
      y: 300,
      width: 300,
      height: 120,
      fills: solid("#2b2b2b"),
      children: [
        { id: "under", type: "rect", name: "Under", x: 0, y: 0, width: 80, height: 40, fills: solid("#333333") },
        { id: "over", type: "rect", name: "Over", x: 20, y: 20, width: 80, height: 40, fills: solid("#999999") }
      ]
    }
  ];
  window.__FISH_BRIDGE__.setElements(elements, { activePageId: base.pages[0].id, pages: base.pages.map((p, i) => (i === 0 ? { ...p, children: elements } : p)) });
});

const boxOf = (id) =>
  page.evaluate((elId) => {
    const el = document.querySelector(`[data-element-id="${elId}"]`);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  }, id);

const orderOf = () =>
  page.evaluate(() => {
    const doc = window.__FISH_BRIDGE__.getDoc();
    const p = doc.pages.find((x) => x.id === doc.activePageId) ?? doc.pages[0];
    const frame = (p.children ?? []).find((e) => e.id === "row");
    return (frame?.children ?? []).map((c) => ({ id: c.id, x: c.x }));
  });

// Selecting from the canvas promotes the click to the top-level frame, so the
// selection is set through the bridge before the drag.
const selectOnly = (id) => page.evaluate((elId) => window.__FISH_BRIDGE__.selectElement(elId), id);

const dragTo = async (fromId, toId, where) => {
  await selectOnly(fromId);
  const from = await boxOf(fromId);
  const to = await boxOf(toId);
  const tx = where === "before" ? to.x + 4 : to.x + to.width - 4;
  const ty = to.y + to.height / 2;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(tx, ty, { steps: 12 });
  await page.waitForTimeout(120);
  const slots = await page.locator("[data-drop-slot]").count();
  await page.mouse.up();
  await page.waitForTimeout(120);
  return slots;
};

const slotsBefore = await dragTo("c", "a", "before");
check("a landing slot is drawn while dragging", slotsBefore === 1, `slots=${slotsBefore}`);
let order = await orderOf();
check(
  "dropping on the near half of A puts C first",
  order.map((k) => k.id).join() === "c,a,b",
  JSON.stringify(order)
);
check(
  "and the stack re-flowed to match",
  // Children are stored in the PARENT'S local space: the first slot is 0, and
  // the frame's own x (100) is not part of a child's number.
  order.map((k) => k.x).join() === "0,88,176",
  JSON.stringify(order)
);

const slotsAfter = await dragTo("c", "b", "after");
check("the slot also shows for a drop at the far edge", slotsAfter === 1, `slots=${slotsAfter}`);
order = await orderOf();
check(
  "dropping past B puts C last",
  order.map((k) => k.id).join() === "a,b,c",
  JSON.stringify(order)
);

// --- 3. multi-select drag reorders too ------------------------------------
// Two children at once: the layer tree selects without promoting to the frame.
const childVisible = await page.locator('[data-layer-row="b"]').count();
if (!childVisible) {
  await page.click('[data-layer-row="row"] button');
  await page.waitForSelector('[data-layer-row="b"]');
}
const selectedIdsNow = async () => {
  // The bridge is re-registered in an effect, so read it after the render.
  await page.waitForTimeout(120);
  return page.evaluate(() => window.__FISH_BRIDGE__.getSelectedIds());
};
await page.click('[data-layer-row="a"]');
await page.click('[data-layer-row="b"]', { modifiers: ["Shift"] });
const twoSelected = await selectedIdsNow();
check("two children selected", twoSelected.length === 2, JSON.stringify(twoSelected));

const bBox = await boxOf("b");
const cBox = await boxOf("c");
// The smart-selection overlay puts a drag dot in the middle of a hovered child,
// so the grab happens near its corner — pressing the centre would drive that
// dot instead of the element.
await page.mouse.move(bBox.x + 4, bBox.y + 4);
await page.waitForTimeout(200);
await page.mouse.down();
await page.mouse.move(cBox.x + cBox.width - 4, cBox.y + cBox.height / 2, { steps: 8 });
await page.waitForTimeout(200);
const multiSlots = await page.locator("[data-drop-slot]").count();
await page.mouse.up();
await page.waitForTimeout(250);
check("a multi-select drag shows a slot too", multiSlots === 1, `slots=${multiSlots}`);
order = await orderOf();
check(
  "a multi-select drag moves every selected child to the slot",
  order.map((k) => k.id).join() === "c,a,b",
  JSON.stringify(order)
);

// --- 4. the layer panel lists a stack in flow order -------------------------
// `row` is a stack, so its rows read left-to-right the way the canvas stacks
// them. `free` has no layout, so its rows read front-first, the way they paint.
const rowsUnder = (frameId) =>
  page.evaluate(
    (id) =>
      // The frame's own row lives inside its container too, so it has to go.
      [...document.querySelectorAll(`[data-layer-id="${id}"] [data-layer-row]`)]
        .map((r) => r.getAttribute("data-layer-row"))
        .filter((rowId) => rowId !== id),
    frameId
  );

const stackRows = await rowsUnder("row");
check(
  "a stack's rows are listed in flow order",
  stackRows.join() === "c,a,b",
  JSON.stringify(stackRows)
);
const freeRows = await rowsUnder("free");
check(
  "a free frame's rows are still listed front-first",
  freeRows.join() === "over,under",
  JSON.stringify(freeRows)
);

fs.mkdirSync(".workbuddy-ai/artifacts", { recursive: true });
await page.screenshot({ path: ".workbuddy-ai/artifacts/layout-p1p2.png" });

await browser.close();

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? `  (${r.detail})` : ""}`);
}
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (errors.length) console.log("pageErrors", errors.slice(0, 5));
process.exit(failed.length ? 1 : 0);
