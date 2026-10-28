import { chromium } from "playwright";
import { pathToFileURL } from "url";
import path from "node:path";

// What a drag across a frame boundary does to a text's SIZE.
//
// `sizing` is stored, not derived, so its defaults are a statement about the
// element's situation — and a drop changes the situation without re-reading the
// file. Measured on the unfixed build through a real pointer drag:
//
//   INTO the card: 1078 × 19  →  1078 × 19   (the character-count width it was
//                                             born with, straight across a 312 card)
//   OUT of it:      312 × 38.63 → 604.36 × 19.31 (the two-line paragraph became
//                                             one long line)
//
// Neither is a number the user asked for, and neither is visible as an edit: the
// document records no change of its own. So the spec drives the real gesture and
// asserts the box, the declaration, and what was painted.
const html = path.resolve(process.cwd(), process.argv[2] ?? "dist/index.html");
const results = [];
const check = (name, ok, detail = "") => {
  results.push(!!ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

const LONG =
  "Revenue grew across every region this quarter, led by the northern territory and a strong enterprise pipeline.";

const text = (id, x, y, extra = {}) => ({
  id,
  type: "text",
  name: id,
  x,
  y,
  content: LONG,
  style: { fontFamily: "Inter", fontSize: 14, color: "#FFFFFF" },
  ...extra
});

// `applyDoc` relayouts but does NOT normalize, and an un-normalized fixture is a
// trap: a text with no authored width/height paints NaN and never becomes a hit
// target, so every drag in it silently does nothing. Hence `__fish.normalize`
// before the tree reaches the page — `setElements` relayouts the same way but
// inherits the same contract.
const ELEMENTS = [
  {
    id: "card",
    type: "frame",
    name: "Card",
    x: 700,
    y: 80,
    width: 360,
    height: 300,
    fills: [{ type: "solid", color: "#222222" }],
    display: "flex",
    "flex-direction": "column",
    gap: 12,
    padding: 24,
    children: [text("t_in_card", 0, 0)]
  },
  text("t_free", 60, 700),
  // The control: the same gesture on a non-text must not touch its size, or the
  // assertions below would pass on a reconcile that fires for everything.
  { id: "box", type: "rect", name: "Box", x: 60, y: 380, width: 120, height: 60, fills: [{ type: "solid", color: "#3E63DD" }] }
];

const CARD_CONTENT_WIDTH = 360 - 48;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });

await page.goto(pathToFileURL(html).href);
await page.waitForFunction(() => !!window.__FISH_BRIDGE__ && !!window.__fish);
await page.evaluate((elements) => {
  const bridge = window.__FISH_BRIDGE__;
  const base = bridge.getDoc();
  const canvas = { ...base.canvas, width: 1920, height: 1080 };
  const norm = window.__fish.normalize({ ...base, canvas, elements: JSON.parse(JSON.stringify(elements)) })
    .document;
  const page = norm.pages.find((p) => p.id === norm.activePageId) ?? norm.pages[0];
  bridge.setElements(JSON.parse(JSON.stringify(page.children)), { canvas });
}, ELEMENTS);
await page.waitForTimeout(700);

const read = (id) =>
  page.evaluate((id) => {
    const doc = window.__FISH_BRIDGE__.getDoc();
    const els = (doc.pages.find((p) => p.id === doc.activePageId) || doc).children || [];
    let found = null;
    let parentId = null;
    const walk = (list, pid) => {
      for (const el of list) {
        if (el.id === id) { found = el; parentId = pid; return; }
        if (el.children) walk(el.children, el.id);
      }
    };
    walk(els, null);
    if (!found) return null;
    const round = (n) => (typeof n === "number" ? Math.round(n * 100) / 100 : n);
    return {
      parentId,
      width: round(found.width),
      height: round(found.height),
      sizing: found.sizing ?? null,
      content: found.content
    };
  }, id);

/** The painted foreignObject's own width/height, which is the box on screen. */
const painted = (id) =>
  page.evaluate((id) => {
    const g = document.querySelector(`[data-element-id="${id}"]`);
    const fo = g ? g.querySelector("foreignObject") : null;
    if (!fo) return null;
    const inner = fo.firstElementChild?.firstElementChild;
    return {
      w: Math.round(Number(fo.getAttribute("width")) * 100) / 100,
      h: Math.round(Number(fo.getAttribute("height")) * 100) / 100,
      innerH: inner ? Math.round(inner.getBoundingClientRect().height * 100) / 100 : null,
      lineHeight: inner ? Number(getComputedStyle(inner).lineHeight.replace("px", "")) || null : null
    };
  }, id);

const boxOf = (id) =>
  page.evaluate((id) => {
    const el = document.querySelector(`[data-element-id="${id}"]`);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { cx: r.x + r.width / 2, cy: r.y + r.height / 2, y: r.y, h: r.height };
  }, id);

const drag = async (fromId, to) => {
  const b = await boxOf(fromId);
  if (!b) return false;
  await page.mouse.move(b.cx, b.cy);
  await page.mouse.down();
  await page.mouse.move(b.cx + 8, b.cy + 8, { steps: 4 });
  await page.mouse.move(to[0], to[1], { steps: 18 });
  await page.mouse.up();
  await page.waitForTimeout(350);
  return true;
};

// ---------------------------------------------------------------- into the card
const cardBox = await boxOf("card");
const freeBefore = await read("t_free");
check(
  "before the drag the text is a canvas-level single line, 1078 wide",
  freeBefore.parentId === null && freeBefore.width > 1000 && freeBefore.height < 25,
  JSON.stringify(freeBefore)
);

await drag("t_free", [cardBox.cx, cardBox.y + 40]);
const freeAfter = await read("t_free");
const freePainted = await painted("t_free");

check("the drop landed it in the card", freeAfter.parentId === "card", `parent ${freeAfter.parentId}`);
check(
  "it gained the hug default on both axes",
  freeAfter.sizing?.width === "fit-content" && freeAfter.sizing?.height === "fit-content",
  JSON.stringify(freeAfter.sizing)
);
check(
  "it wraps to the card's content box instead of overflowing it",
  freeAfter.width === CARD_CONTENT_WIDTH,
  `${freeAfter.width} vs ${CARD_CONTENT_WIDTH}`
);
check(
  "and it is more than one line tall now",
  freeAfter.height > 30,
  `${freeAfter.height}`
);
check(
  "the painted box agrees with the model",
  freePainted.w === CARD_CONTENT_WIDTH && freePainted.h === freeAfter.height,
  JSON.stringify(freePainted)
);
check("the content survived the drop", freeAfter.content === LONG);

// ----------------------------------------------------------------- out of it
const inCardBefore = await read("t_in_card");
check(
  "the text in the card is the wrapped two-line paragraph to begin with",
  inCardBefore.parentId === "card" && inCardBefore.width === CARD_CONTENT_WIDTH && inCardBefore.height > 30,
  JSON.stringify(inCardBefore)
);

await drag("t_in_card", [1150, 720]);
const inCardAfter = await read("t_in_card");
const inCardPainted = await painted("t_in_card");

check("it left the card", inCardAfter.parentId === null, `parent ${inCardAfter.parentId}`);
check(
  "the hug declaration was dropped, so nothing re-measures it unbounded",
  inCardAfter.sizing === null || inCardAfter.sizing === undefined,
  JSON.stringify(inCardAfter.sizing)
);
check(
  "it kept the box it was dropped with",
  inCardAfter.width === inCardBefore.width && inCardAfter.height === inCardBefore.height,
  `${inCardAfter.width} × ${inCardAfter.height}, was ${inCardBefore.width} × ${inCardBefore.height}`
);
check(
  "the painted box kept it too",
  inCardPainted.w === inCardBefore.width && inCardPainted.h === inCardBefore.height,
  JSON.stringify(inCardPainted)
);
check("the content survived the drag out", inCardAfter.content === LONG);

// ------------------------------------------------------------------- control
// The control: the same gesture on a non-text must not INVENT a hug declaration,
// or the assertions above would pass on a reconcile that fires for everything.
// Its width follows the column's stretch exactly as the card's own child does
// (312 = content width); what must not happen is a `sizing` entry or a touched
// height.
const boxBefore = await read("box");
await drag("box", [cardBox.cx, cardBox.y + 40]);
const boxAfter = await read("box");
check(
  "control — the dropped rect takes the column's stretch, not a hug declaration",
  boxAfter.parentId === "card" &&
    boxAfter.width === CARD_CONTENT_WIDTH &&
    boxAfter.height === boxBefore.height,
  `${boxAfter.width} × ${boxAfter.height}, was ${boxBefore.width} × ${boxBefore.height}`
);
check(
  "control — and no sizing declaration was invented for it",
  boxAfter.sizing === null || boxAfter.sizing === undefined,
  JSON.stringify(boxAfter.sizing)
);

// ------------------------------------------------------- the layer panel path
const panelDropped = await page.evaluate(() => {
  const row = document.querySelector('[data-layer-row="box"]');
  const target = document.querySelector('[data-layer-row="card"]');
  return Boolean(row && target);
});
check("the layer panel has both rows to drop between", panelDropped);

console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
if (errors.length) {
  console.log("pageErrors:", errors.slice(0, 5));
}
await browser.close();
process.exit(results.every(Boolean) && errors.length === 0 ? 0 : 1);
