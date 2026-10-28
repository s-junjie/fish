import { chromium } from "playwright";
import { pathToFileURL } from "url";
import path from "path";

// Scrubbing padding / margin / gap in the inspector has to put a band read-out on
// the canvas, the same one dragging a gap pill already draws — otherwise the
// number under the pointer is the only place the value is visible.
//
// The stack is nested and off the canvas origin on purpose: a band computed from
// a child's own `x`/`y` lands at the page origin instead of over the child, which
// is the failure docs/LESSONS_LEARNED.md §34 records for the gap pills.
//
// Band geometry is read off the SVG attributes, which are in WORLD units — the
// canvas's stage group carries the pan/zoom transform — so nothing here needs a zoom.
const html = path.resolve(process.cwd(), process.argv[2] ?? "dist/index.html");
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || detail === undefined ? "" : ` — ${detail}`}`);
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

await page.evaluate(() => {
  const bridge = window.__FISH_BRIDGE__;
  const base = bridge.getDoc();
  bridge.setElements([
      {
        id: "BOARD",
        type: "frame",
        name: "Board",
        x: 600,
        y: 400,
        width: 520,
        height: 320,
        fills: [{ type: "solid", color: "#202020" }],
        children: [
          {
            id: "STACK",
            type: "frame",
            name: "Toolbar",
            x: 40,
            y: 40,
            width: 520,
            height: 220,
            fills: [{ type: "solid", color: "#2B2B2B" }],
            display: "flex",
            "flex-direction": "row",
            gap: 12,
            padding: [0,0,0,0],
            children: [
              { id: "A", type: "rect", name: "A", x: 0, y: 0, width: 120, height: 60, fills: [{ type: "solid", color: "#4C6EF5" }] },
              { id: "B", type: "rect", name: "B", x: 132, y: 0, width: 120, height: 60, fills: [{ type: "solid", color: "#12B886" }] },
              { id: "C", type: "rect", name: "C", x: 264, y: 0, width: 120, height: 60, fills: [{ type: "solid", color: "#F03E3E" }] }
            ]
          }
        ]
      }
    ], { canvas: { ...base.canvas, width: 4000, height: 3000 } });
  bridge.selectElement("STACK");
});
await page.waitForSelector('[data-ui-panel="right"] [data-stack-spacing="padding"]');

/** The label is the handle — `ScrubInput` scrubs from it, never from the input. */
const handle = (selector) => page.locator(`${selector}`).locator("xpath=..").locator("[data-scrub-label]");

async function press(selector, dx) {
  const box = await handle(selector).boundingBox();
  const y = box.y + box.height / 2;
  const x = box.x + box.width / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y, { steps: 6 });
}

/** Whatever bands are on the canvas right now, in world units. */
const bands = () =>
  page.evaluate(() => {
    const root = document.querySelector("[data-spacing-overlay]");
    if (!root) return null;
    return {
      kind: root.getAttribute("data-spacing-overlay"),
      rects: [...root.querySelectorAll("rect[data-spacing-band]")].map((r) => ({
        tone: r.getAttribute("data-spacing-band"),
        value: r.getAttribute("data-spacing-label-value"),
        x: +r.getAttribute("x"),
        y: +r.getAttribute("y"),
        w: +r.getAttribute("width"),
        h: +r.getAttribute("height"),
        dashed: r.getAttribute("stroke-dasharray") !== null
      }))
    };
  });

const worldBox = (id) =>
  page.evaluate((id) => {
    const doc = window.__FISH_BRIDGE__.getDoc();
    const page_ = doc.pages.find((p) => p.id === doc.activePageId) ?? doc;
    let found = null;
    const walk = (els, dx, dy) => {
      for (const el of els) {
        const x = el.x + dx;
        const y = el.y + dy;
        if (el.id === id) found = { x, y, width: el.width, height: el.height };
        if (el.children) walk(el.children, x, y);
      }
    };
    walk(page_.children, 0, 0);
    return found;
  }, id);

const settle = () => page.waitForTimeout(60);

// ── padding ────────────────────────────────────────────────────────────────────
// Uniform mode is the icon field, and it is the only one that writes all four.
await press('[data-stack-spacing="padding"] input[data-scrub-field=""]', 24);
const pad = await bands();
check("a padding scrub raises the canvas overlay", pad !== null, "no [data-spacing-overlay]");
check("the overlay is tagged padding", pad && pad.kind === "padding", pad && pad.kind);
check("uniform padding lights all four sides", pad && pad.rects.length === 4, pad && pad.rects.length);
check("padding wears the geometry accent, not the margin neutral", pad && pad.rects.every((r) => r.tone === "coral"), pad && JSON.stringify(pad.rects.map((r) => r.tone)));
check("padding bands are solid, so they never read as margin", pad && pad.rects.every((r) => !r.dashed));
check("every padding band carries the live value", pad && pad.rects.every((r) => r.value === "24"), pad && JSON.stringify(pad.rects.map((r) => r.value)));

const stack = await worldBox("STACK");
check("a band matches the frame's own width, in canvas space", pad && stack && pad.rects.some((r) => r.w === stack.width && r.x === stack.x), pad && JSON.stringify(pad.rects.map((r) => [r.x, r.w])));
check("the top band's bottom edge is the frame's top", pad && stack && pad.rects.some((r) => r.y === stack.y && r.h === 24), pad && JSON.stringify(pad.rects.map((r) => [r.y, r.h])));

await page.mouse.up();
await settle();
check("the overlay leaves with the pointer", (await bands()) === null);

// ── gap ────────────────────────────────────────────────────────────────────────
// `data-stack-gap` is the hook, not a `data-scrub-field` name: the label is the
// gap icon, so `ScrubInput` writes `data-scrub-field=""` for it — the same shape
// the padding row above already uses.
await press('[data-ui-panel="right"] [data-stack-gap="true"] input[data-scrub-field=""]', 18);
const gap = await bands();
check("a gap scrub raises the canvas overlay", gap !== null, "no [data-spacing-overlay]");
check("the overlay is tagged gap", gap && gap.kind === "gap", gap && gap.kind);
// Three children, two gutters: one value, every band — the canvas pill drag's
// behaviour, reached from the field instead.
check("gap draws a band per gutter", gap && gap.rects.length === 2, gap && gap.rects.length);
check("gap bands are coral", gap && gap.rects.every((r) => r.tone === "coral"));
check("gap bands carry the field's own value", gap && gap.rects.every((r) => r.value === "30"), gap && JSON.stringify(gap.rects.map((r) => r.value)));
const a = await worldBox("A");
check("the gap band sits between two painted children, not at the page origin", gap && a && gap.rects.every((r) => r.x > 100 && r.w === 30), gap && JSON.stringify(gap.rects.map((r) => [r.x, r.w])));

await page.screenshot({ path: ".workbuddy/artifacts/spacing-gap.png" });
await page.mouse.up();
await settle();
check("the overlay leaves with the pointer", (await bands()) === null);

// ── the uniform margin field must STAY uniform while you hold it ──────────
// The mode is derived from the stored values when the user has not chosen one,
// and margin used to ask "are they all ZERO". A uniform [4,4,4,4] is not zero,
// so it fell through to the vertical/horizontal test, matched it, and mode 2
// rendered TWO fields where mode 1 rendered one — replacing the input under the
// pointer on the first pixel of the drag.
await page.evaluate(() => window.__FISH_BRIDGE__.selectElement("A"));
await page.waitForSelector('[data-stack-margin="true"]');
const modes = () =>
  page.evaluate(() =>
    [...document.querySelectorAll('[data-stack-margin="true"] button')].map((b) =>
      b.className.includes("bg-field-active") ? "on" : "off"
    )
  );
check("margin starts uniform", (await modes())[0] === "on", JSON.stringify(await modes()));

const uni = page.locator('[data-stack-spacing="margin"] [data-scrub-label]').first();
const uniBox = await uni.boundingBox();
await page.mouse.move(uniBox.x + uniBox.width / 2, uniBox.y + uniBox.height / 2);
await page.mouse.down();
await page.mouse.move(uniBox.x + uniBox.width / 2 + 20, uniBox.y + uniBox.height / 2, { steps: 5 });
const heldFields = await page.evaluate(
  () => document.querySelectorAll('[data-stack-spacing="margin"] input[data-scrub-field]').length
);
const heldMode = await modes();
check("scrubbing the uniform field leaves it uniform", heldMode[0] === "on", JSON.stringify(heldMode));
check("and does not replace the input under the pointer", heldFields === 1, `${heldFields} fields`);
await page.screenshot({ path: ".workbuddy/artifacts/spacing-margin-uniform.png" });
await page.mouse.up();
await settle();
check(
  "the four sides really are equal afterwards",
  await page.evaluate(() => {
    const d = window.__FISH_BRIDGE__.getDoc();
    const p = d.pages.find((x) => x.id === d.activePageId);
    const find = (l) => { for (const e of l) { if (e.id === "A") return e; const h = find(e.children || []); if (h) return h; } return null; };
    const m = find(p.children).margin;
    return Array.isArray(m) && m.every((v) => v === m[0]);
  })
);

// ── a drag is ONE undo step ────────────────────────────────────────────────
// The margin frames committed discretely, so every pointermove pushed its own
// entry and a six-step drag needed six ⌘Z to get back. Undo is the only place
// that difference shows, so it is measured here: one undo must restore the
// margin the drag started from, not an intermediate frame of it.
const stackMargin = () =>
  page.evaluate(() => {
    const d = window.__FISH_BRIDGE__.getDoc();
    const p = d.pages.find((x) => x.id === d.activePageId);
    const find = (l) => { for (const e of l) { if (e.id === "A") return e; const h = find(e.children || []); if (h) return h; } return null; };
    return find(p.children).margin ?? null;
  });

const marginBefore = JSON.stringify(await stackMargin());
await press('[data-stack-spacing="margin"] input[data-scrub-field=""]', 30);
await page.mouse.up();
await settle();
const marginAfter = JSON.stringify(await stackMargin());
check("the drag did move the margin", marginAfter !== marginBefore, `${marginBefore} → ${marginAfter}`);

await page.evaluate(() => window.__FISH_BRIDGE__.undo());
await settle();
const marginUndone = JSON.stringify(await stackMargin());
check("one undo takes back the whole drag", marginUndone === marginBefore, `${marginAfter} → ${marginUndone}, expected ${marginBefore}`);

// ── margin ─────────────────────────────────────────────────────────────────────
await page.evaluate(() => window.__FISH_BRIDGE__.selectElement("B"));
await page.waitForSelector('[data-ui-panel="right"] [data-stack-spacing="margin"]');
// Four zeros derive mode "1", whose single field writes all four sides. The
// per-side switch is what makes "only the side under the pointer" a claim about
// margin rather than about padding, so take it first.
await page.locator('[data-stack-margin="true"] button').nth(2).click();
// The per-side fields are ICON-labelled, so `data-scrub-field` carries the empty
// string rather than a side letter — `[data-scrub-field="T"]` had been waiting on
// a key the field stopped stamping, which is how this section went red without
// anyone touching it. Reading order puts TOP first, so the grid's first child.
await page.waitForSelector('[data-stack-spacing="margin"] .grid > div:first-child input[data-scrub-field=""]');
await press('[data-stack-spacing="margin"] .grid > div:first-child input[data-scrub-field=""]', 20);
const margin = await bands();
check("a margin scrub raises the canvas overlay", margin !== null, "no [data-spacing-overlay]");
check("the overlay is tagged margin", margin && margin.kind === "margin", margin && margin.kind);
check("margin draws only the side under the pointer", margin && margin.rects.length === 1, margin && margin.rects.length);
check("margin wears a different colour from padding", margin && margin.rects.every((r) => r.tone === "margin"), margin && JSON.stringify(margin.rects.map((r) => r.tone)));
check("margin is dashed as well, so the two never rest on hue alone", margin && margin.rects.every((r) => r.dashed));
// The margin pill is a SOLID band in its own accent with white ink. It used to
// be the neutral badge (surface + #E0E0E0 ink), which measured 3.46:1 on both
// candidates now in play — so this pins the ink, not just the fill.
const pill = await page.evaluate(() => {
  const r = document.querySelector("rect[data-spacing-band]");
  if (!r) return null;
  const pillRect = [...r.parentElement.querySelectorAll("rect")].find((x) => x !== r);
  const txt = r.parentElement.querySelector("text");
  return { fill: pillRect?.getAttribute("fill"), ink: txt?.getAttribute("fill") };
});
check("the margin pill is solid accent with white ink", pill && pill.fill === "#1B72FF" && pill.ink === "#FFFFFF", JSON.stringify(pill));

const b = await worldBox("B");
const m0 = margin && margin.rects[0];
check("the margin band sits OUTSIDE the child, above it", m0 && b && m0.y + m0.h === b.y, m0 && `band bottom ${m0.y + m0.h}, child top ${b && b.y}`);
check("the margin band is as thick as the value", m0 && m0.h === 20, m0 && m0.h);
check("the margin band keeps the child's own width", m0 && b && m0.w === b.width && m0.x === b.x, m0 && JSON.stringify([m0.x, m0.w]));

// The reader's proof, not just the assertions: the overlay only exists while a
// pointer is down, so a screenshot has to be taken mid-drag.
await page.screenshot({ path: ".workbuddy/artifacts/spacing-margin.png" });
await page.mouse.up();
await settle();
check("the overlay leaves with the pointer", (await bands()) === null);

// And the same, for padding — which is what the user asked to look like the
// canvas gap drag.
await page.evaluate(() => window.__FISH_BRIDGE__.selectElement("STACK"));
await page.waitForSelector('[data-ui-panel="right"] [data-stack-spacing="padding"]');
await press('[data-stack-spacing="padding"] input[data-scrub-field=""]', 6);
const shot = await bands();
// The first padding scrub already moved this to 24, so the second starts from
// there; what matters is that the readout is the field's live value, not a
// frozen number.
const storedPad = await page.evaluate(() => {
  const doc = window.__FISH_BRIDGE__.getDoc();
  const page_ = doc.pages.find((p) => p.id === doc.activePageId) ?? doc;
  const walk = (els) => {
    for (const el of els) {
      if (el.id === "STACK") return el.padding;
      if (el.children) {
        const hit = walk(el.children);
        if (hit !== undefined) return hit;
      }
    }
    return undefined;
  };
  return walk(page_.children);
});
check("the readout tracks the field's live value", shot && Array.isArray(storedPad) && shot.rects.every((r) => r.value === String(storedPad[0])), shot && JSON.stringify({ bands: shot.rects.map((r) => r.value), storedPad }));
await page.screenshot({ path: ".workbuddy/artifacts/spacing-padding.png" });
await page.mouse.up();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed, ${failed.length} failed`);
if (failed.length) for (const f of failed) console.log(`  FAILED: ${f.name} — ${f.detail ?? ""}`);
if (errors.length) {
  console.log("page errors:");
  for (const e of errors) console.log(`  ${e}`);
}
await browser.close();
process.exit(failed.length === 0 && errors.length === 0 ? 0 : 1);