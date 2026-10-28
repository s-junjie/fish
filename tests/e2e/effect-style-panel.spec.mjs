import { chromium } from "playwright";
import { pathToFileURL } from "url";
import path from "node:path";

// A bound effect style owns the element's whole effect list, exactly like a paint
// style owns its fills/strokes. The regression this guards: the Effects section
// used to render the style pill AND the raw parameter rows, so the same shadow
// appeared twice and editing the rows silently diverged from the style.
//
//   1. bound        — pill only, no `[data-effect-row]`, add-effect disabled
//   2. detach       — rows come back, effectStyleId is gone, effects survive
//   3. unbound      — rows render, add-effect enabled
//   4. UI bind path — picking a style in the library popover swaps rows for the
//                     pill and really paints the shadow (filter in the DOM)
const html = path.resolve(process.cwd(), process.argv[2] ?? "dist/index.html");

const SHADOW = {
  type: "drop-shadow",
  color: "#00000080",
  offset: { x: 0, y: 4 },
  blur: 8,
  enabled: true
};

const STYLES = [{ id: "style_fx", name: "shadow2", styleType: "effect", effects: [SHADOW] }];

const ELEMENTS = [
  {
    id: "r_bound",
    type: "rect",
    name: "Bound Rect",
    x: 0,
    y: 60,
    width: 200,
    height: 120,
    fills: [{ type: "solid", color: "#3E63DD" }],
    effectStyleId: "style_fx",
    effects: [SHADOW]
  },
  {
    id: "r_plain",
    type: "rect",
    name: "Plain Rect",
    x: 0,
    y: 260,
    width: 200,
    height: 120,
    fills: [{ type: "solid", color: "#30A46C" }],
    effects: [SHADOW]
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
  ({ styles, elements }) => {
    const bridge = window.__FISH_BRIDGE__;
    const base = bridge.getDoc();
    bridge.setElements(JSON.parse(JSON.stringify(elements)), { canvas: { ...base.canvas, width: 1920, height: 1080 }, styles });
  },
  { styles: STYLES, elements: ELEMENTS }
);
await page.waitForTimeout(600);

const select = async (id) => {
  await page.evaluate((elId) => window.__FISH_BRIDGE__.selectElement(elId), id);
  await page.waitForTimeout(300);
};

const inDoc = (id) =>
  page.evaluate((elId) => {
    const doc = window.__FISH_BRIDGE__.getDoc();
    const page_ = doc.pages.find((p) => p.id === doc.activePageId);
    const walk = (list) => {
      for (const el of list) {
        if (el.id === elId) return JSON.parse(JSON.stringify(el));
        const hit = el.children ? walk(el.children) : null;
        if (hit) return hit;
      }
      return null;
    };
    return walk(page_.children);
  }, id);

// Scoped to the inspector: the same strings also live in the styles library.
const pillInfo = () =>
  page.evaluate(() => {
    const pill = document.querySelector('[data-ui-panel="right"] [data-effect-style-pill]');
    if (!pill) return null;
    return { id: pill.getAttribute("data-effect-style-pill"), text: pill.innerText.replace(/\n/g, " | ") };
  });
const rowCount = () =>
  page.evaluate(() => document.querySelectorAll('[data-ui-panel="right"] [data-effect-row]').length);
const addButton = () =>
  page.evaluate(() => {
    const btn = [...document.querySelectorAll('[data-ui-panel="right"] button')].find((b) => {
      const t = b.getAttribute("title") || "";
      return t === "Add Effect" || t === "Managed by effect style";
    });
    return btn ? { title: btn.getAttribute("title"), disabled: btn.disabled } : null;
  });
const hasShadowFilter = (id) =>
  page.evaluate((elId) => {
    const node = document.querySelector(`[data-element-id="${CSS.escape(elId)}"]`);
    return node ? node.getAttribute("filter") || "" : null;
  }, id);
// Tolerant so an older bundle (no pill hook) reports a clean FAIL instead of
// hanging on a click that can never resolve.
const detach = async () => {
  const clicked = await page.evaluate(() => {
    const btn = document.querySelector('[data-ui-panel="right"] [data-effect-style-pill] [data-style-pill-unlink]');
    if (!btn) return false;
    btn.click();
    return true;
  });
  await page.waitForTimeout(300);
  return clicked;
};

// ---- 1. bound: the style is the only thing on screen ----------------------
await select("r_bound");
const boundPill = await pillInfo();
check("a bound style shows its pill", !!boundPill && boundPill.id === "style_fx", JSON.stringify(boundPill));
check(
  "the pill names the style and what it carries",
  !!boundPill && boundPill.text.includes("shadow2") && boundPill.text.includes("drop-shadow"),
  boundPill ? boundPill.text : "no pill"
);
check("no raw parameter rows while bound", (await rowCount()) === 0, `rows=${await rowCount()}`);
const boundAdd = await addButton();
check("adding an effect is disabled while bound", !!boundAdd && boundAdd.disabled === true, JSON.stringify(boundAdd));

// ---- 2. detach: the rows become the element's own again -------------------
check("the pill carries a detach control", await detach());
const detached = await inDoc("r_bound");
check("detach clears effectStyleId", detached.effectStyleId === undefined, `effectStyleId=${detached.effectStyleId}`);
check(
  "detach keeps the concrete effects",
  Array.isArray(detached.effects) && detached.effects.length === 1 && detached.effects[0].type === "drop-shadow",
  JSON.stringify(detached.effects)
);
check("the pill is gone after detaching", (await pillInfo()) === null);
check("the parameter rows are back", (await rowCount()) === 1, `rows=${await rowCount()}`);

// ---- 3. an unbound element with effects edits in place --------------------
await select("r_plain");
check("an unbound element shows its rows", (await rowCount()) === 1, `rows=${await rowCount()}`);
check("an unbound element shows no pill", (await pillInfo()) === null);
const plainAdd = await addButton();
check("adding an effect is enabled when unbound", !!plainAdd && plainAdd.disabled === false, JSON.stringify(plainAdd));

// ---- 4. the reported flow: pick a style from the library ------------------
await page.click('[data-ui-panel="right"] button[title="Effect Styles"]');
await page.waitForTimeout(300);
await page.click('[data-style-list-row="style_fx"]');
await page.waitForTimeout(400);
const reboundPill = await pillInfo();
check("picking a style binds it", !!reboundPill && reboundPill.id === "style_fx", JSON.stringify(reboundPill));
check("picking a style hides the rows", (await rowCount()) === 0, `rows=${await rowCount()}`);
const rebound = await inDoc("r_plain");
check("the bound element carries the style's effects", rebound.effectStyleId === "style_fx", `effectStyleId=${rebound.effectStyleId}`);
check("the bound shadow is really painted", (await hasShadowFilter("r_plain")) === "url(#filter_r_plain)", `filter=${await hasShadowFilter("r_plain")}`);

console.log(`\n${results.filter(Boolean).length}/${results.length} checks passed`);
if (errors.length) console.log(`pageErrors:\n  ${errors.join("\n  ")}`);
await browser.close();
process.exit(results.every(Boolean) && errors.length === 0 ? 0 : 1);
