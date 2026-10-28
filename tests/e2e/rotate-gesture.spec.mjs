import { chromium } from "playwright";
import { pathToFileURL } from "url";
import path from "path";

// The rotate gesture measures the pointer's angle around the pivot the renderer
// rotates around, and those have to be the same point. A child of a frame is drawn
// at its parent's offset, so measuring around the child's own local coordinates put
// the pivot on the parent's origin and the delta came out with the OPPOSITE sign —
// every element inside a frame (which is every element inside a stack) turned the
// wrong way when dragged. The handle is located through the DOM rather than
// recomputed here, so this spec cannot drift away from the overlay's own maths.
const html = path.resolve(process.cwd(), process.argv[2] ?? "dist/index.html");
const results = [];
const check = (name, actual, expected) =>
  results.push({ name, ok: JSON.stringify(actual) === JSON.stringify(expected), actual, expected });
// Rotation is stored clockwise and wrapped into 0..360, so 309 means -51: the sign
// has to be read from the shortest turn, not from the stored number.
const shortestTurn = (deg) =>
  deg === null || deg === undefined ? null : ((deg + 180) % 360 + 360) % 360 - 180;
const checkSign = (name, actual, expectedSign) =>
  results.push({ name, ok: Math.sign(shortestTurn(actual) ?? 0) === expectedSign, actual, expected: expectedSign });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});

await page.goto(pathToFileURL(html).href);
await page.waitForFunction(() => !!window.__FISH_BRIDGE__);

const plain = (id, x, y, w, h) => ({
  id,
  type: "rect",
  name: id,
  x,
  y,
  width: w,
  height: h,
  fills: [{ type: "solid", color: "#3B82F6" }]
});

const frame = (id, x, y, w, h, extra = {}) => ({
  id,
  type: "frame",
  name: id,
  x,
  y,
  width: w,
  height: h,
  fills: [{ type: "solid", color: "#1F1F1F" }],
  children: [],
  ...extra
});

const applySetup = (elements) =>
  page.evaluate((els) => {
    const bridge = window.__FISH_BRIDGE__;
    const base = bridge.getDoc();
    bridge.setElements(els, { canvas: { ...base.canvas, width: 4000, height: 3000 } });
  }, elements);

const settle = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
const readNode = (id) =>
  page.evaluate(
    (elId) => {
      const find = (list) => {
        for (const el of list) {
          if (el.id === elId) return el;
          const hit = find(el.children || []);
          if (hit) return hit;
        }
        return null;
      };
      const el = find(window.__FISH_BRIDGE__.getElements());
      return el ? { rotation: el.rotation ?? null, x: el.x, y: el.y } : null;
    },
    id
  );

/** Where the element PAINTS: the envelope its own turn makes it cover. */
const readEnvelope = (id) =>
  page.evaluate(
    (elId) => {
      const find = (list) => {
        for (const el of list) {
          if (el.id === elId) return el;
          const hit = find(el.children || []);
          if (hit) return hit;
        }
        return null;
      };
      const el = find(window.__FISH_BRIDGE__.getElements());
      if (!el) return null;
      const rad = ((el.rotation || 0) * Math.PI) / 180;
      const c = Math.abs(Math.cos(rad));
      const s = Math.abs(Math.sin(rad));
      const w = el.width * c + el.height * s;
      const h = el.width * s + el.height * c;
      const round = (v) => Math.round(v * 100) / 100;
      return [round(el.x + (el.width - w) / 2), round(el.y + (el.height - h) / 2), round(w), round(h)];
    },
    id
  );

/** Swing the top-right rotate hot zone by a screen delta. Clockwise is positive. */
const swingTopRight = async (dx, dy, { shift = false } = {}) => {
  const box = await page.locator('[data-rotate-handle="tr"]').boundingBox();
  if (!box) return false;
  const from = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  if (shift) await page.keyboard.down("Shift");
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) await page.mouse.move(from.x + (dx * i) / 12, from.y + (dy * i) / 12);
  await page.mouse.up();
  if (shift) await page.keyboard.up("Shift");
  await settle();
  return true;
};

const select = async (id) => {
  await page.evaluate((elId) => window.__FISH_BRIDGE__.selectElement(elId), id);
  await settle();
};

// ------------------------------------------------------------------ inside a stack
await applySetup([
  frame("S", 400, 300, 300, 300, {
    display: "flex",
    "flex-direction": "column",
    gap: 0,
    padding: 0,
    children: [plain("c1", 0, 0, 100, 100), plain("c2", 0, 100, 100, 100)]
  })
]);
await settle();
await select("c1");
check("a stack child offers a rotate zone", await swingTopRight(60, 30), true);
const child = await readNode("c1");
checkSign("dragging the top-right zone clockwise rotates clockwise", child.rotation, 1);
// A turn makes the box cover a wider envelope, and it is the ENVELOPE that holds
// the slot now: the stored box is pushed back by half the difference, so it is
// the artwork's place in the stack that has to survive the gesture, not the
// stored corner's.
check("and the child keeps its place in the stack", (await readEnvelope("c1")).slice(0, 2), [0, 0]);

await applySetup([
  frame("S", 400, 300, 300, 300, {
    display: "flex",
    "flex-direction": "column",
    gap: 0,
    padding: 0,
    children: [plain("c1", 0, 0, 100, 100)]
  })
]);
await settle();
await select("c1");
check("the counter-gesture finds the handle too", await swingTopRight(-60, -30), true);
checkSign("dragging it the other way turns the other way", (await readNode("c1")).rotation, -1);

// ------------------------------------------------------------- inside a plain frame
await applySetup([
  frame("F", 500, 400, 300, 300, { children: [plain("a", 40, 40, 120, 80)] })
]);
await settle();
await select("a");
check("a plain-frame child offers a rotate zone", await swingTopRight(60, 30), true);
const nested = await readNode("a");
checkSign("a child of a plain frame turns the right way too", nested.rotation, 1);
check("and its local position is untouched", [nested.x, nested.y], [40, 40]);

// --------------------------------------------------------------- top-level element
await applySetup([plain("loose", 700, 500, 120, 80)]);
await settle();
await select("loose");
check("a top-level element offers a rotate zone", await swingTopRight(60, 30), true);
checkSign("a top-level element is unchanged by the fix", (await readNode("loose")).rotation, 1);

// ------------------------------------------------------- shift snaps to 15 degrees
await applySetup([
  frame("S", 400, 300, 300, 300, {
    display: "flex",
    "flex-direction": "column",
    gap: 0,
    padding: 0,
    children: [plain("c1", 0, 0, 100, 100)]
  })
]);
await settle();
await select("c1");
check("the shift gesture finds the handle too", await swingTopRight(60, 30, { shift: true }), true);
check("shift snaps a nested rotation to 15°", (await readNode("c1")).rotation % 15, 0);


// ---------------------------------------- a turned child takes room in the stack
const row = (children, extra = {}) =>
  frame("S", 200, 200, 600, 300, {
    display: "flex",
    "flex-direction": "row",
    gap: 20,
    padding: 0,
    children,
    ...extra
  });
const turned = (id, w, h, rotation) =>
  ({ ...plain(id, 0, 0, w, h), rotation });

await applySetup([row([plain("c1", 0, 0, 100, 40), plain("c2", 0, 0, 100, 40), plain("c3", 0, 0, 100, 40)])]);
await settle();
check("an unturned row spaces the three children 120 apart", (await readNode("c3")).x, 240);

// The 100x40 box turned a quarter covers 40 across and 100 down, so the row
// reserves 40 for it and the stored box moves back to put the envelope on the slot.
await applySetup([row([plain("c1", 0, 0, 100, 40), turned("c2", 100, 40, 90), plain("c3", 0, 0, 100, 40)])]);
await settle();
check("a quarter-turned child makes the next one 60px earlier", (await readNode("c3")).x, 180);
check("and its envelope sits on the slot", await readEnvelope("c2"), [120, 0, 40, 100]);

// The same thing through the real gesture, where the angle is whatever the drag
// produced: the observable symptom is that the row reflowed at all. The row
// follows the children's COVER — c3 sits one gap after c2's rotated envelope —
// and a turned box covers more across than its stored box, so the row is wider
// than the untilted 240 by exactly the envelope's growth.
await applySetup([row([plain("c1", 0, 0, 100, 40), plain("c2", 0, 0, 100, 40), plain("c3", 0, 0, 100, 40)])]);
await settle();
await select("c2");
await swingTopRight(50, 80);
const reflowed = (await readNode("c3")).x;
check("turning a stack child by hand reflows its siblings", reflowed !== 240, true);
const turnedEnvelope = await readEnvelope("c2");
check(
  "and the row is exactly as wide as the children cover",
  Math.round(reflowed - (turnedEnvelope[0] + turnedEnvelope[2] + 20)),
  0
);

// A line turns about its ORIGIN, so it paints the turned SEGMENT rather than the
// turned box: this one covers 70.71x70.71 while the document stores a 0x100 box.
const seg = (id, dx, dy, rotation) => ({
  id,
  type: "line",
  name: id,
  x: 0,
  y: 0,
  dx,
  dy,
  width: Math.abs(dx),
  height: Math.abs(dy),
  rotation,
  strokes: [{ color: "#000000", width: 2 }]
});

await applySetup([row([plain("c1", 0, 0, 100, 40), seg("c2", 0, 100, 45), plain("c3", 0, 0, 100, 40)])]);
await settle();
check("a turned line reserves its segment, not its stored box", (await readNode("c3")).x, 210.71);
// The envelope hangs 70.71 to the LEFT of the anchor, so the anchor has to sit that
// far right of its slot at 120 for the artwork to land on the slot.
check("and the anchor is pushed back onto the slot", (await readNode("c2")).x, 190.71);

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : `  -> ${JSON.stringify(r.actual)} (expected ${JSON.stringify(r.expected)})`}`);
}
console.log(`\n${results.length - failed.length}/${results.length} passed`);
console.log("pageErrors", errors.slice(0, 5));

await browser.close();
process.exit(failed.length === 0 && errors.length === 0 ? 0 : 1);
