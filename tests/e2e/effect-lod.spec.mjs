import { chromium } from "playwright";
import { pathToFileURL } from "node:url";
import path from "node:path";

// Effects too small to resolve are not painted at all: a backdrop whose short
// edge has shrunk below 8 screen px has no blur left in it, and a shadow whose
// reach has shrunk below 2 screen px has nothing left to show. The DECISIONS are
// unit-tested against a stub root in `backdrop-lod.test.ts` / `shadow-lod.test.ts`.
//
// What no unit test in this suite can see is the link that makes those passes
// work at all: the renderer writing the marks `applyBackdropLod` / `applyShadowLod`
// query, onto the RIGHT nodes. There is no compile-time connection between a JSX
// attribute and a querySelector string, so renaming the attribute, or spreading
// the marks onto the opposite branch of a ternary, turns both passes into
// no-ops that report nothing — while every unit test stays green, because the
// stub root is built with the attribute the reader already expects.
//
// So this spec asserts the two states a real browser can tell apart: painted at
// 1:1 with the marks actually on the node, off at the rung below the floor, and
// painted again on the way back up.
//
// The two fixtures are sized so both cross their floor between the same pair of
// zoom rungs (0.1 paints, 0.05 does not): reach 28 needs zoom >= 0.0714, and a
// 100px short edge needs zoom >= 0.08. Both floors live in the modules this
// spec is testing, and both are read back here rather than assumed.

const html = path.resolve(process.cwd(), process.argv[2] ?? "dist/index.html");

/** `shadowLodMarks` on a blur-8 / offset-4 drop shadow: spread 0 + 8*3 + 4. */
const REACH = 28;
const BLUR_PANEL = 100;

const ELEMENTS = [
  {
    id: "lod_shadow",
    type: "rect",
    name: "Shadowed Rect",
    x: 0,
    y: 0,
    width: 200,
    height: 120,
    fills: [{ type: "solid", color: "#3E63DD" }],
    effects: [{ type: "drop-shadow", color: "#00000080", offset: { x: 0, y: 4 }, blur: 8, enabled: true }]
  },
  {
    id: "lod_blur",
    type: "rect",
    name: "Frosted Panel",
    x: 260,
    y: 0,
    width: BLUR_PANEL,
    height: BLUR_PANEL,
    fills: [{ type: "solid", color: "#30A46C" }],
    effects: [{ type: "backdrop-blur", blur: 12, enabled: true }]
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
await page.evaluate(
  (elements) => {
    const bridge = window.__FISH_BRIDGE__;
    const base = bridge.getDoc();
    bridge.setElements(JSON.parse(JSON.stringify(elements)), { canvas: { ...base.canvas, width: 1920, height: 1080 } });
  },
  ELEMENTS
);
await page.waitForTimeout(600);

/**
 * Everything both claims are read from, in one round trip per state.
 *
 * `filter` and the backdrop chain are read off the AUTHORED state, not the
 * computed one, because the pass writes `filter="none"` / `backdrop-filter:
 * none` — asserting the computed value alone cannot tell "the pass turned it
 * off" from "the renderer never wrote it".
 */
const readState = () =>
  page.evaluate(() => {
    const node = (id) => document.querySelector(`[data-element-id="${CSS.escape(id)}"]`);
    const shadow = node("lod_shadow");
    const panel = node("lod_blur");
    const div = panel?.querySelector("foreignObject > div");
    return {
      shadowFilter: shadow?.getAttribute("filter") ?? null,
      shadowChain: shadow?.getAttribute("data-shadow-chain") ?? null,
      shadowReach: shadow?.getAttribute("data-shadow-reach") ?? null,
      backdropDiv: !!div,
      backdropChain: div?.getAttribute("data-backdrop-chain") ?? null,
      backdropComputed: div ? getComputedStyle(div).backdropFilter : null,
      rendered: document.querySelectorAll("[data-element-id]").length
    };
  });

/** `{zoom}` from a layer whose document width is known. */
const zoomNow = () =>
  page.evaluate((w) => {
    const el = document.querySelector('[data-element-id="lod_shadow"]');
    return el ? el.getBoundingClientRect().width / w : null;
  }, 200);

const idle = () => page.waitForTimeout(400);

// `+`/`-` walk Figma's ladder, so the rung below the floors is a known number of
// presses rather than a scroll that lands wherever physics puts it. Bare, because
// Shift+digit is the zoom family (`useShortcuts.ts:414`) and Shift+`-` reaches
// nothing at all.
const pressRung = async (times) => {
  for (let i = 0; i < times; i++) {
    await page.keyboard.press("-");
    await idle();
  }
};

// ---- 1. at 1:1 both are painted, and both carry the marks the passes read ---
await page.keyboard.press("Shift+0");
await idle();
const zoomAtOne = await zoomNow();
const painted = await readState();

check("seed: 1:1 is 1:1", zoomAtOne !== null && Math.abs(zoomAtOne - 1) < 1e-6, `zoom=${zoomAtOne}`);
check("both fixtures render", painted.rendered === 2, `rendered=${painted.rendered}`);
check(
  "the shadowed rect carries the mark applyShadowLod queries",
  painted.shadowChain === "url(#filter_lod_shadow)",
  `data-shadow-chain=${painted.shadowChain}`
);
check(
  "and the reach it projects it by",
  painted.shadowReach === String(REACH),
  `data-shadow-reach=${painted.shadowReach} expected=${REACH}`
);
check("the shadow is painted at 1:1", painted.shadowFilter === "url(#filter_lod_shadow)", `filter=${painted.shadowFilter}`);
check("the frosted panel has a backdrop div", painted.backdropDiv, "no foreignObject > div");
// `cssBlurFilter` halves the radius: CSS `blur()` takes a standard deviation,
// Figma authors a radius (`css-encode.test.ts:13` pins the pair).
const BLUR_CSS = `blur(${12 / 2}px)`;
check(
  "and it carries the mark applyBackdropLod queries",
  painted.backdropChain === BLUR_CSS,
  `data-backdrop-chain=${painted.backdropChain}`
);
check(
  "the backdrop is painted at 1:1",
  painted.backdropComputed !== "none" && painted.backdropComputed !== "",
  `backdrop-filter=${painted.backdropComputed}`
);

// ---- 2. below both floors, neither is painted ------------------------------
// The marks must SURVIVE the pass — the pass owns `filter`, the renderer owns
// the mark — or the restore below would have nothing to put back.
await pressRung(4);
const zoomAtFloor = await zoomNow();
const dropped = await readState();

check("4 presses of - land on the 0.05 rung", Math.abs(zoomAtFloor - 0.05) < 1e-6, `zoom=${zoomAtFloor}`);
check("the shadow is not painted below its floor", dropped.shadowFilter === "none", `filter=${dropped.shadowFilter}`);
check("the backdrop is not painted below its floor", dropped.backdropComputed === "none", `backdrop-filter=${dropped.backdropComputed}`);
check("the mark survives so the restore has something to put back", dropped.shadowChain === "url(#filter_lod_shadow)", `data-shadow-chain=${dropped.shadowChain}`);

// ---- 3. back up: both come back -------------------------------------------
await page.keyboard.press("Shift+0");
await idle();
const restored = await readState();

check("the shadow is restored at 1:1", restored.shadowFilter === "url(#filter_lod_shadow)", `filter=${restored.shadowFilter}`);
check(
  "the backdrop is restored at 1:1",
  restored.backdropComputed !== "none" && restored.backdropComputed !== "",
  `backdrop-filter=${restored.backdropComputed}`
);

console.log(`\n${results.filter(Boolean).length}/${results.length} checks passed`);
console.log("pageErrors", errors.slice(0, 5));

await browser.close();
process.exit(results.every(Boolean) && errors.length === 0 ? 0 : 1);