import { chromium } from "playwright";
import { pathToFileURL } from "url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Layer lock, measured in the real editor rather than asserted on markup:
//
//   1. canvas click    — a locked layer is not selectable, an identical unlocked
//                        one is (same click, opposite outcome)
//   2. canvas drag     — a locked layer does not move, its unlocked twin does
//   3. layers panel    — the padlock locks the row *and its whole subtree*, and
//                        the locked node swallows a canvas press instead of
//                        handing it to whatever is behind it
//   4. ⇧⌘L             — toggles the selection, and toggling back works while the
//                        locked layer is still selected (Figma parity)
//   5. marquee         — a box over all five layers selects only the unlocked ones
//   6. selection chrome— a locked layer keeps its box but gets no resize/rotate
//                        handle, while an unlocked one has them
//   7. row actions     — only the icon whose state is on is pinned; the other
//                        still rides the row's hover
//
// Every screen coordinate is read back from the DOM, so the spec does not depend
// on the default pan/zoom.
const html = path.resolve(process.cwd(), process.argv[2] ?? "dist/index.html");

// World (0,0) sits at the viewport's top-left corner plus the default pan, and the
// two side panels float over the canvas — the fixture keeps clear of both.
const ELEMENTS = [
  {
    id: "r_locked",
    type: "rect",
    name: "Locked Rect",
    x: 0,
    y: 60,
    width: 200,
    height: 120,
    locked: true,
    fills: [{ type: "solid", color: "#E5484D" }]
  },
  {
    id: "r_free",
    type: "rect",
    name: "Free Rect",
    x: 0,
    y: 260,
    width: 200,
    height: 120,
    fills: [{ type: "solid", color: "#30A46C" }]
  },
  {
    id: "f_locked",
    type: "frame",
    name: "Frame To Lock",
    x: 400,
    y: 60,
    width: 240,
    height: 180,
    fills: [{ type: "solid", color: "#2B2B2B" }],
    children: [
      {
        id: "c_child",
        type: "rect",
        name: "Child",
        x: 40,
        y: 60,
        width: 120,
        height: 60,
        fills: [{ type: "solid", color: "#3E63DD" }]
      }
    ]
  },
  {
    id: "r_other",
    type: "rect",
    name: "Other Rect",
    x: 400,
    y: 300,
    width: 200,
    height: 120,
    fills: [{ type: "solid", color: "#AB4ABA" }]
  },
  {
    // Off on its own: the marquee assertions only count what the box spans.
    id: "r_hidden",
    type: "rect",
    name: "Hidden Rect",
    x: 900,
    y: 700,
    width: 200,
    height: 120,
    visible: false,
    fills: [{ type: "solid", color: "#F76B15" }]
  },
  // Kept clear of the marquee box below: these three only exist to prove the lock
  // is a *barrier*. `s_locked` covers the left half of `s_back`, whose exposed
  // right half is the control that the same click still selects.
  {
    id: "s_back",
    type: "rect",
    name: "Stacked Under",
    x: 1000,
    y: 60,
    width: 200,
    height: 120,
    fills: [{ type: "solid", color: "#30A46C" }]
  },
  {
    id: "s_locked",
    type: "rect",
    name: "Stacked Locked",
    x: 1000,
    y: 60,
    width: 100,
    height: 120,
    locked: true,
    fills: [{ type: "solid", color: "#E5484D" }]
  },
  {
    id: "g_outer",
    type: "frame",
    name: "Outer Frame",
    x: 1000,
    y: 260,
    width: 240,
    height: 180,
    fills: [{ type: "solid", color: "#2B2B2B" }],
    children: [
      {
        id: "g_child",
        type: "rect",
        name: "Locked Child",
        x: 40,
        y: 60,
        width: 140,
        height: 80,
        locked: true,
        fills: [{ type: "solid", color: "#3E63DD" }]
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
  bridge.setElements(JSON.parse(JSON.stringify(elements)), { canvas: { ...base.canvas, width: 1920, height: 1080 } });
}, ELEMENTS);
await page.waitForTimeout(600);

const liveDoc = () => page.evaluate(() => JSON.parse(JSON.stringify(window.__FISH_BRIDGE__.getDoc())));
const inDoc = async (id) => {
  const doc = await liveDoc();
  const walk = (list) => {
    for (const el of list) {
      if (el.id === id) return el;
      if (el.children) {
        const hit = walk(el.children);
        if (hit) return hit;
      }
    }
    return null;
  };
  return walk(doc.pages.find((p) => p.id === doc.activePageId).children);
};
const centreOf = (id) =>
  page.evaluate((elId) => {
    const n = document.querySelector(`[data-element-id="${CSS.escape(elId)}"]`);
    if (!n) return null;
    const b = n.getBoundingClientRect();
    return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) };
  }, id);
const boxOf = (id) =>
  page.evaluate((elId) => {
    const n = document.querySelector(`[data-element-id="${CSS.escape(elId)}"]`);
    if (!n) return null;
    const b = n.getBoundingClientRect();
    return { left: b.left, top: b.top, right: b.right, bottom: b.bottom };
  }, id);
const headerText = () =>
  page.evaluate(() => {
    const panel = document.querySelector('[data-ui-panel="right"]');
    const span = panel ? panel.querySelector("span") : null;
    return span ? span.textContent.trim() : null;
  });
/** The selection itself — what a click on bare canvas leaves behind. */
const selectedIds = () => page.evaluate(() => window.__FISH_BRIDGE__.getSelectedIds());
const click = async (id) => {
  const p = await centreOf(id);
  await page.mouse.click(p.x, p.y);
  await page.waitForTimeout(250);
};
/** Click inside an element at a fraction of its box — for the half of a layer the
 *  lock does not cover, which its centre cannot reach. */
const clickIn = async (id, fx, fy) => {
  const box = await boxOf(id);
  await page.mouse.click(Math.round(box.left + (box.right - box.left) * fx), Math.round(box.top + (box.bottom - box.top) * fy));
  await page.waitForTimeout(250);
};
const dragFrom = async (from, dx, dy) => {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + dx / 2, from.y + dy / 2, { steps: 5 });
  await page.mouse.move(from.x + dx, from.y + dy, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(350);
};

// ---- 0. seed sanity --------------------------------------------------------
const rendered = await page.evaluate(() => document.querySelectorAll("[data-element-id]").length);
check("all four visible fixture layers render", rendered >= 4, `rendered=${rendered}`);

// A locked layer is a click-through: the press must NOT land on it, so whatever
// is painted behind it receives the event instead. This is a DOM fact before it
// is a behaviour — `elementFromPoint` is what the browser itself would hand the
// mousedown.
const passThrough = await page.evaluate(() => {
  const n = document.querySelector('[data-element-id="r_locked"]');
  if (!n) return { inside: true, tag: "missing" };
  const b = n.getBoundingClientRect();
  const hit = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
  return { inside: n.contains(hit), tag: hit ? hit.tagName : "null" };
});
check(
  "a press over a locked layer lands on the layer behind it, not the lock",
  passThrough.inside === false,
  JSON.stringify(passThrough)
);

// ---- 1. click-through -----------------------------------------------------
await click("r_free");
check("clicking an unlocked layer selects it", (await headerText()) === "Free Rect", `header="${await headerText()}"`);

await clickIn("s_back", 0.75, 0.5);
check("the control twin painted behind the lock is selectable", (await headerText()) === "Stacked Under", `header="${await headerText()}"`);
await click("s_locked");
check(
  "clicking a locked layer selects the layer behind it",
  (await headerText()) === "Stacked Under",
  `header="${await headerText()}"`
);
await click("g_child");
check(
  "a locked child is transparent, so the press reaches whatever is behind it",
  (await headerText()) !== "Locked Child",
  `header="${await headerText()}"`
);

// ---- 2. drag --------------------------------------------------------------
// `s_locked` is stacked over the LEFT half of `s_back`, so a press inside the
// overlap now picks `s_back` — and the drag must move THAT one and leave the
// locked layer it covers completely still. This is the assertion that matters
// after the lock became a click-through: transparency must not become movability.
const lockedBefore = await inDoc("s_locked");
const underBefore = await inDoc("s_back");
const overlap = await page.evaluate(() => {
  const box = document.querySelector('[data-element-id="s_locked"]').getBoundingClientRect();
  return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) };
});
await dragFrom(overlap, 120, 40);
const lockedAfter = await inDoc("s_locked");
const underAfter = await inDoc("s_back");
check(
  "dragging across a locked layer leaves it untouched",
  lockedAfter.x === lockedBefore.x && lockedAfter.y === lockedBefore.y,
  `(${lockedBefore.x},${lockedBefore.y}) -> (${lockedAfter.x},${lockedAfter.y})`
);
check(
  "and moves the layer behind it, which is what the press actually grabbed",
  underAfter.x !== underBefore.x || underAfter.y !== underBefore.y,
  `(${underBefore.x},${underBefore.y}) -> (${underAfter.x},${underAfter.y})`
);

const freeBefore = await inDoc("r_free");
await dragFrom(await centreOf("r_free"), 120, 40);
const freeAfter = await inDoc("r_free");
check(
  "the same drag moves the unlocked twin",
  freeAfter.x !== freeBefore.x || freeAfter.y !== freeBefore.y,
  `(${freeBefore.x},${freeBefore.y}) -> (${freeAfter.x},${freeAfter.y})`
);

// ---- 3. layers panel padlock cascades -------------------------------------
const padlockTitle = (id) =>
  page.evaluate((elId) => {
    const b = document.querySelector(`[data-layer-lock="${CSS.escape(elId)}"]`);
    return b ? b.getAttribute("title") : null;
  }, id);
check("every row exposes a padlock button", (await padlockTitle("f_locked")) === "Lock layer", `title="${await padlockTitle("f_locked")}"`);
check("a locked row reads as unlockable", (await padlockTitle("r_locked")) === "Unlock layer", `title="${await padlockTitle("r_locked")}"`);

await page.click('[data-layer-lock="f_locked"]');
await page.waitForTimeout(300);
const frameLocked = await inDoc("f_locked");
const childLocked = await inDoc("c_child");
check(
  "the padlock locks the frame and cascades to its child",
  frameLocked.locked === true && childLocked.locked === true,
  `frame.locked=${frameLocked.locked} child.locked=${childLocked.locked}`
);
const childTransparent = await page.evaluate(() => {
  const n = document.querySelector('[data-element-id="c_child"]');
  if (!n) return { inside: true, tag: "missing" };
  const b = n.getBoundingClientRect();
  const hit = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
  return { inside: n.contains(hit), tag: hit ? hit.tagName : "null" };
});
check(
  "a child locked by cascade is transparent too, not just its parent",
  childTransparent.inside === false,
  JSON.stringify(childTransparent)
);
await click("c_child");
// Nothing is under the cursor that CAN be selected: the frame is locked and so
// is the child, so transparency cascades through the whole locked subtree and
// the press reaches bare canvas. That is the contract, not a gap — a locked
// region is only "blocked" where it overlaps something selectable. What the
// inspector header spells for an empty selection is not the contract; the
// selection being empty is.
check(
  "clicking inside a fully locked subtree reaches the canvas and selects nothing",
  (await selectedIds()).length === 0,
  JSON.stringify(await selectedIds())
);

await page.click('[data-layer-lock="f_locked"]');
await page.waitForTimeout(300);
const frameUnlocked = await inDoc("f_locked");
const childUnlocked = await inDoc("c_child");
check(
  "clicking it again clears the whole subtree",
  frameUnlocked.locked === undefined && childUnlocked.locked === undefined,
  `frame.locked=${frameUnlocked.locked} child.locked=${childUnlocked.locked}`
);

// ---- 4. ⇧⌘L toggle --------------------------------------------------------
await click("r_free");
await page.keyboard.press("Meta+Shift+L");
await page.waitForTimeout(300);
check("⇧⌘L locks the selection", (await inDoc("r_free")).locked === true);
await page.keyboard.press("Meta+Shift+L");
await page.waitForTimeout(300);
check(
  "⇧⌘L unlocks it again while it stays selected",
  (await inDoc("r_free")).locked === undefined,
  `locked=${(await inDoc("r_free")).locked}`
);

// ---- 5. marquee skips locked ---------------------------------------------
// The box is derived from the rendered boxes: starting 20px above/left of the
// topmost element is empty canvas by construction, so the gesture marquees
// instead of grabbing whatever is under the cursor.
const boxes = await Promise.all(["r_free", "f_locked", "r_other", "r_locked"].map(boxOf));
const marqueeStart = {
  x: Math.round(Math.min(...boxes.map((b) => b.left)) - 20),
  y: Math.round(Math.min(...boxes.map((b) => b.top)) - 20)
};
const marqueeEnd = {
  x: Math.round(Math.max(...boxes.map((b) => b.right)) + 20),
  y: Math.round(Math.max(...boxes.map((b) => b.bottom)) + 20)
};
await page.mouse.move(marqueeStart.x, marqueeStart.y);
await page.mouse.down();
await page.mouse.move(marqueeEnd.x, marqueeEnd.y, { steps: 12 });
await page.mouse.up();
await page.waitForTimeout(400);
const header = await headerText();
check("a marquee over 4 layers selects only the 3 unlocked ones", header === "3 selected", `header="${header}"`);

// ---- 5b. a CLICK on a locked layer over empty canvas deselects -------------
// The regression that the click-through makes reachable. A press that misses
// every hit target behind the lock reaches the canvas container and opens a
// marquee whose box is one point across. The containment test is strict, so at
// zero width it degrades to "this AABB contains the point" and would select
// everything stacked under the cursor — the §75 symptom, one level down.
// A bare click must read as a click on empty canvas: deselect, select nothing.
await page.click('[data-layer-row="r_free"]');
await page.waitForTimeout(250);
await click("r_locked");
// The same contract from the other side: a locked layer over bare canvas lets
// the press through, so nothing is selected — and no degenerate marquee from a
// click that was never a drag.
check(
  "clicking a locked layer over empty canvas selects nothing (no degenerate marquee)",
  (await selectedIds()).length === 0,
  JSON.stringify(await selectedIds())
);

// ---- 6. panel selection of a locked layer keeps the box, not the handles --
const handleCount = () =>
  page.evaluate(() => document.querySelectorAll("svg [data-resize-handle], svg [data-rotate-handle]").length);
await page.click('[data-layer-row="r_locked"]');
await page.waitForTimeout(300);
const lockedHeader = await headerText();
check("a locked layer is selectable from the Layers Panel", lockedHeader === "Locked Rect", `header="${lockedHeader}"`);
check("its selection box exposes no resize/rotate handle", (await handleCount()) === 0);
await page.click('[data-layer-row="r_free"]');
await page.waitForTimeout(300);
const freeHandles = await handleCount();
check("an unlocked selection does expose handles", freeHandles > 0, `handles=${freeHandles}`);

// ---- 7. only the icon of an active state is pinned ------------------------
// Read as computed opacity: the row reveal is a CSS transition, so this is what
// the user actually sees, not a class-string guess.
const AWAY = { x: 1200, y: 200 };
const rowCentreY = (id) =>
  page.evaluate((rowId) => {
    const row = document.querySelector(`[data-layer-row="${CSS.escape(rowId)}"]`);
    if (!row) return null;
    const b = row.getBoundingClientRect();
    return Math.round(b.top + b.height / 2);
  }, id);
const iconOpacity = (id) =>
  page.evaluate((elId) => {
    const read = (sel) => {
      const n = document.querySelector(sel);
      return n ? Number(getComputedStyle(n).opacity).toFixed(2) : "missing";
    };
    return {
      lock: read(`[data-layer-lock="${CSS.escape(elId)}"]`),
      eye: read(`[data-layer-eye="${CSS.escape(elId)}"]`)
    };
  }, id);
const opacityIs = async (id, lock, eye) => JSON.stringify(await iconOpacity(id)) === JSON.stringify({ lock, eye });

await page.mouse.move(AWAY.x, AWAY.y);
await page.waitForTimeout(400);
check("an idle row hides both icons", await opacityIs("r_free", "0.00", "0.00"), JSON.stringify(await iconOpacity("r_free")));
await page.mouse.move(120, await rowCentreY("r_free"));
await page.waitForTimeout(400);
check("hovering an idle row reveals both icons", await opacityIs("r_free", "1.00", "1.00"), JSON.stringify(await iconOpacity("r_free")));

await page.mouse.move(AWAY.x, AWAY.y);
await page.waitForTimeout(400);
check(
  "a locked row pins the padlock and leaves the eye to hover",
  await opacityIs("r_locked", "1.00", "0.00"),
  JSON.stringify(await iconOpacity("r_locked"))
);
check(
  "a hidden row pins the eye and leaves the padlock to hover",
  await opacityIs("r_hidden", "0.00", "1.00"),
  JSON.stringify(await iconOpacity("r_hidden"))
);
await page.mouse.move(120, await rowCentreY("r_locked"));
await page.waitForTimeout(400);
check(
  "hovering a locked row still reveals the eye",
  await opacityIs("r_locked", "1.00", "1.00"),
  JSON.stringify(await iconOpacity("r_locked"))
);

// ---- 8. a visual snapshot of the states, for eyeballing the row chrome ----
await page.mouse.move(AWAY.x, AWAY.y);
await page.waitForTimeout(200);
const shotDir = fs.mkdtempSync(path.join(os.tmpdir(), "fish-lock-spec-"));
const shot = path.join(shotDir, "layer-panel-lock.png");
await page.screenshot({ path: shot, clip: { x: 0, y: 0, width: 320, height: 560 } });
console.log(`screenshot: ${shot}`);

check("no console errors", errors.length === 0, errors.slice(0, 3).join(" | "));

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
await browser.close();
process.exit(passed === results.length ? 0 : 1);
