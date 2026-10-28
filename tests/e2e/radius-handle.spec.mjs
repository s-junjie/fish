import { chromium } from "playwright";
import { pathToFileURL } from "url";
import path from "node:path";

// Corner-radius handle, measured in the real editor:
//
//   1. chrome      — a selected rect grows one dot tucked inside its top-left
//                    corner; an ellipse grows none
//   2. drag        — dragging the dot retunes the radius, clamped to min(w,h)/2,
//                    and one gesture is exactly one undo step
//   3. uniform     — a plain drag retunes all four corners (number radius)
//   4. alt-drag    — Alt keeps the other three corners and retunes this one only
//
// Every screen coordinate is read back from the DOM, so the spec does not depend
// on the default pan/zoom.
const html = path.resolve(process.cwd(), process.argv[2] ?? "dist/index.html");

const ELEMENTS = [
  {
    id: "rh_a",
    type: "rect",
    name: "Radius A",
    x: 60,
    y: 80,
    width: 200,
    height: 160,
    fills: [{ type: "solid", color: "#30A46C" }]
  },
  {
    id: "rh_b",
    type: "rect",
    name: "Radius B",
    x: 360,
    y: 80,
    width: 200,
    height: 160,
    borderRadius: 20,
    fills: [{ type: "solid", color: "#3E63DD" }]
  },
  {
    id: "rh_e",
    type: "ellipse",
    name: "No Radius Dot",
    x: 660,
    y: 80,
    width: 200,
    height: 160,
    fills: [{ type: "solid", color: "#F76B15" }]
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
const boxOf = (sel) =>
  page.evaluate((q) => {
    const n = document.querySelector(q);
    if (!n) return null;
    const b = n.getBoundingClientRect();
    return { left: b.left, top: b.top, right: b.right, bottom: b.bottom, width: b.width, height: b.height };
  }, sel);
const select = async (id) => {
  await page.evaluate((elId) => window.__FISH_BRIDGE__.selectElement(elId), id);
  await page.waitForTimeout(400);
};
const dragHandle = async (dx, dy, alt = false) => {
  const hb = await boxOf('[data-radius-handle="tl"]');
  if (!hb) return false;
  const x = Math.round(hb.left + hb.width / 2);
  const y = Math.round(hb.top + hb.height / 2);
  await page.mouse.move(x, y);
  await page.mouse.down();
  if (alt) await page.keyboard.down("Alt");
  await page.mouse.move(x + dx / 2, y + dy / 2, { steps: 5 });
  await page.mouse.move(x + dx, y + dy, { steps: 5 });
  if (alt) await page.keyboard.up("Alt");
  await page.mouse.up();
  await page.waitForTimeout(350);
  return true;
};

// ---- 1. chrome ---------------------------------------------------------------
await select("rh_a");
const dotRect = await boxOf('[data-radius-handle="tl"]');
const elBox = await boxOf('[data-element-id="rh_a"]');
const zoom = elBox ? elBox.width / 200 : 1;
check("a selected rect shows one radius handle", dotRect !== null);

if (dotRect && elBox) {
  const insetWorld = (dotRect.left + dotRect.width / 2 - elBox.left) / zoom;
  check(
    "the dot sits inside the top-left corner",
    insetWorld > 1 && insetWorld < 20 && dotRect.bottom > elBox.top,
    `inset=${insetWorld.toFixed(1)}`
  );
}

await select("rh_e");
await page.waitForTimeout(300);
const ellipseDots = await page.evaluate(() => document.querySelectorAll('[data-radius-handle="tl"]').length);
check("an ellipse shows no radius handle", ellipseDots === 0, `count=${ellipseDots}`);

// ---- 2. drag + clamp + undo ----------------------------------------------------
await select("rh_a");
check("drag opens (handle present)", await dragHandle(48, 48));
let a = await inDoc("rh_a");
check(
  "dragging the dot retunes the radius",
  a && a.borderRadius === 48 / zoom,
  `borderRadius=${a && a.borderRadius} expected=${48 / zoom}`
);

check("a far drag clamps to min(w,h)/2", await dragHandle(600, 600));
a = await inDoc("rh_a");
check("clamped at 80", a && a.borderRadius === 80, `borderRadius=${a && a.borderRadius}`);

await page.evaluate(() => window.__FISH_BRIDGE__.undo());
a = await inDoc("rh_a");
check("one gesture is one undo step", a && a.borderRadius === 48 / zoom, `borderRadius=${a && a.borderRadius}`);

// ---- 3. plain drag on a rounded rect retunes all four corners -------------------
await select("rh_b");
check("drag opens on rounded rect", await dragHandle(24, 24));
const b = await inDoc("rh_b");
check(
  "plain drag sets a uniform radius",
  b && typeof b.borderRadius === "number" && Math.abs(b.borderRadius - (20 + 24 / zoom)) < 0.5,
  `borderRadius=${b && JSON.stringify(b.borderRadius)} expected=${20 + 24 / zoom}`
);

// ---- 4. alt-drag retunes only the top-left corner -------------------------------
check("alt-drag opens", await dragHandle(16, 16, true));
const b2 = await inDoc("rh_b");
const expectTl = 50 + 16 / zoom;
check(
  "alt-drag keeps the other three corners",
  b2 && Array.isArray(b2.borderRadius) &&
    Math.abs(b2.borderRadius[0] - expectTl) < 0.5 &&
    b2.borderRadius[1] === 50 && b2.borderRadius[2] === 50 && b2.borderRadius[3] === 50,
  `borderRadius=${b2 && JSON.stringify(b2.borderRadius)} expected=[${expectTl},50,50,50]`
);

await browser.close();
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed === 0 && errors.length === 0 ? 0 : 1);
