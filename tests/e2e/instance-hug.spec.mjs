import { chromium } from "playwright";
import { pathToFileURL } from "url";
import path from "path";

// An instance of a hugging master is itself a hugging element, and the two ways of
// saying so — the size menu and the Cmd+drag pin — must not contradict each other.
//
// The bug this pins: the size menu refused `fit-content` on an instance
// (`canFitContent` listed only frame/component/text), so an instance of a
// `fit-content` master had no way to SAY it was hugging, and its declaration was
// never written. Fixing the menu is only half the job: once the instance really
// does hug, the canvas drag on that axis has to keep working, or the feature ships
// a new dead end. Cmd+drag is the escape, and the selection overlay has to draw
// the handle for it — which is what `modifierResizesOwnBox` exists to guarantee.
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

const CHILD_W = 220;
const CHILD_H = 60;

// A row stack with one 220-wide child: `fit-content` on the width hugs to exactly
// that, with no padding or gap to make the number something you have to compute.
// Flat CSS keys, not the pre-P2 nested object: `fish.schema.json` refuses
// `layout: { mode, direction }`, and a frame with no `display` is not a layout
// parent at all — so `fit-content` had nothing to resolve against.
const STACK = { display: "flex", "flex-direction": "row", gap: 0, padding: 0 };
const applySetup = (masterSizing, instanceSizing, instanceExtra = {}) =>
  page.evaluate(
    ({ ms, is, ie, cw, ch, stack }) => {
      const bridge = window.__FISH_BRIDGE__;
      const base = bridge.getDoc();
      bridge.setElements([
          {
            id: "M",
            type: "component",
            name: "M",
            x: 200,
            y: 200,
            width: 300,
            height: ch,
            fills: [{ type: "solid", color: "#1F2937" }],
            clipContent: false,
            sizing: ms,
            ...stack,
            children: [
              {
                id: "k",
                type: "rect",
                name: "k",
                x: 0,
                y: 0,
                width: cw,
                height: ch,
                fills: [{ type: "solid", color: "#3B82F6" }]
              }
            ]
          },
          {
            id: "I",
            type: "instance",
            name: "I",
            componentId: "M",
            x: 900,
            y: 200,
            width: 300,
            height: ch,
            sizing: is,
            ...ie
          }
        ], { canvas: { ...base.canvas, width: 4000, height: 3000 } });
    },
    { ms: masterSizing, is: instanceSizing, ie: instanceExtra, cw: CHILD_W, ch: CHILD_H, stack: STACK }
  );

const readView = () =>
  page.evaluate(() => {
    const svg = document.querySelector("svg.pointer-events-auto");
    const box = svg.parentElement.getBoundingClientRect();
    const m = /translate\((-?[\d.]+), (-?[\d.]+)\) scale\(([\d.]+)\)/.exec((() => { const s = document.querySelector("[data-stage-transform]"); const a = s && s.getAttribute("transform"); if (a) return a; const svg = s && s.ownerSVGElement; const t = svg ? getComputedStyle(svg).transform : ""; const m = /matrix\(([\d.eE+-]+), 0, 0, ([\d.eE+-]+), ([\d.eE+-]+), ([\d.eE+-]+)\)/.exec(t); return m ? "translate(" + m[3] + ", " + m[4] + ") scale(" + m[1] + ")" : null; })());
    return {
      pan: { x: parseFloat(m[1]), y: parseFloat(m[2]) },
      zoom: parseFloat(m[3]),
      rect: { left: box.left, top: box.top }
    };
  });
const toScreen = async (wx, wy) => {
  const v = await readView();
  return { x: v.rect.left + v.pan.x + wx * v.zoom, y: v.rect.top + v.pan.y + wy * v.zoom };
};
const settle = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
const read = (id) =>
  page.evaluate(
    (elId) => {
      const e = window.__FISH_BRIDGE__.getElements().find((n) => n.id === elId);
      return {
        width: e.width,
        height: e.height,
        sizing: e.sizing ?? null,
        sizeOverride: e.sizeOverride ?? false
      };
    },
    id
  );
const dragWorld = async (from, dx, dy, modifiers = []) => {
  for (const m of modifiers) await page.keyboard.down(m);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(from.x + (dx * i) / 10, from.y + (dy * i) / 10);
  await page.mouse.up();
  for (const m of modifiers) await page.keyboard.up(m);
  await settle();
};

// ------------------------------------------- a hugging master makes a hugging instance
await applySetup({ width: "fit-content" }, { width: "fit-content" });
await settle();
const hug = await read("I");
check("the master hugs to its content", (await read("M")).width, CHILD_W);
check("the instance hugs the same content", hug.width, CHILD_W);
check("the instance carries the hug as its own declaration", hug.sizing, { width: "fit-content" });

await page.evaluate(() => window.__FISH_BRIDGE__.selectElement("I"));
await settle();

// The width handle belongs to the engine, so it is hidden until the modifier is
// held — exactly as it is on a hugging frame. The overlay and the drag handler
// read one predicate, so this count and the drag below cannot disagree.
check("a hugging instance hides its width handle", await page.locator('[data-resize-handle="mr"]').count(), 0);
await page.keyboard.down("Meta");
await settle();
check("holding cmd offers it", await page.locator('[data-resize-handle="mr"]').count(), 1);
check("and the selection says it is in frame-resize mode", await page.locator('[data-frame-resize="true"]').count(), 1);
await page.keyboard.up("Meta");
await settle();
check("releasing cmd takes it away again", await page.locator('[data-resize-handle="mr"]').count(), 0);

// ------------------------------------------- cmd+drag pins it, and the pin holds
const handle = await toScreen(900 + hug.width, 200 + hug.height / 2);
await dragWorld(handle, Math.round(180 * (await readView()).zoom), 0, ["Meta"]);
const pinned = await read("I");
check("cmd+drag gives a hugging instance the size the drag asked for", pinned.width, hug.width + 180);
check("the drag beat the hug it would otherwise get back", pinned.width === CHILD_W, false);
check("and the pin dropped the hug declaration", pinned.sizing, null);
check("and marked the box as the instance's own", pinned.sizeOverride, true);

// A relayout is the thing that would take a merely-stored width back, since the
// instance still resolves its content from the master. Wait for one to land, then
// read both halves: the number AND the declaration that would undo it.
await settle();
await page.waitForTimeout(200);
const afterRelayout = await read("I");
check("the pin survives a relayout", afterRelayout.width, hug.width + 180);
check("and its declaration is still dropped, so the menu agrees with the canvas", afterRelayout.sizing, null);

console.log(JSON.stringify(results, null, 1));
if (errors.length) {
  console.log("pageErrors", JSON.stringify(errors, null, 1));
  process.exitCode = 1;
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  for (const f of failed) console.log(`FAILED ${f.name}: got ${JSON.stringify(f.actual)} want ${JSON.stringify(f.expected)}`);
  process.exitCode = 1;
}
await browser.close();
