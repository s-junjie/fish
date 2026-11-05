import { chromium } from "playwright";
import { pathToFileURL } from "url";
import path from "path";

/**
 * The Scale tool's CANVAS gesture.
 *
 * The unit tests pin the arithmetic; this pins the three things only a real drag
 * can show: the corner follows the pointer (the anchor is the opposite corner, not
 * the panel's picker), a corner drag is proportional to the box it started from,
 * and a slow drag lands on the same numbers as a fast one over the same travel —
 * the scale is recomputed from the drag-start tree, never from the frame before.
 */
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

const settle = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

await page.evaluate(() => {
  const bridge = window.__FISH_BRIDGE__;
  const base = bridge.getDoc();
  bridge.setElements(
    [
      {
        id: "pad",
        type: "frame",
        name: "pad",
        x: 100,
        y: 100,
        width: 200,
        height: 100,
        borderRadius: 10,
        strokes: [{ color: "#000000", width: 1 }],
        display: "flex",
        "flex-direction": "column",
        gap: 8,
        padding: 12,
        children: [
          { id: "box", type: "rect", name: "box", x: 12, y: 12, width: 176, height: 40, fills: [{ type: "solid", color: "#FFFFFF" }] },
          {
            id: "label",
            type: "text",
            name: "label",
            x: 12,
            y: 60,
            width: 176,
            height: 19,
            content: "Scale me",
            style: { fontFamily: "Inter", fontSize: 16, lineHeight: "19px", color: "#000000" }
          }
        ]
      }
    ],
    { canvas: { ...base.canvas, width: 4000, height: 3000 } }
  );
});
await settle();

const readView = () =>
  page.evaluate(() => {
    const svg = document.querySelector("svg.pointer-events-auto");
    const box = svg.parentElement.getBoundingClientRect();
    const m = /translate\((-?[\d.]+), (-?[\d.]+)\) scale\(([\d.]+)\)/.exec(
      (() => {
        const s = document.querySelector("[data-stage-transform]");
        const a = s && s.getAttribute("transform");
        if (a) return a;
        const el = s && s.ownerSVGElement;
        const t = el ? getComputedStyle(el).transform : "";
        const mm = /matrix\(([\d.eE+-]+), 0, 0, ([\d.eE+-]+), ([\d.eE+-]+), ([\d.eE+-]+)\)/.exec(t);
        return mm ? "translate(" + mm[3] + ", " + mm[4] + ") scale(" + mm[1] + ")" : null;
      })()
    );
    return { pan: { x: parseFloat(m[1]), y: parseFloat(m[2]) }, zoom: parseFloat(m[3]), rect: { left: box.left, top: box.top } };
  });
const toScreen = async (wx, wy) => {
  const v = await readView();
  return { x: v.rect.left + v.pan.x + wx * v.zoom, y: v.rect.top + v.pan.y + wy * v.zoom };
};
const readPad = () =>
  page.evaluate(() => {
    const f = window.__FISH_BRIDGE__.getElements().find((e) => e.id === "pad");
    const box = f.children.find((c) => c.id === "box");
    const label = f.children.find((c) => c.id === "label");
    return {
      x: f.x,
      y: f.y,
      w: f.width,
      h: f.height,
      radius: f.borderRadius,
      stroke: f.strokes?.[0]?.width,
      gap: f.gap,
      padding: f.padding,
      boxW: box.width,
      labelFont: label.style?.fontSize
    };
  });

await page.evaluate(() => window.__FISH_BRIDGE__.selectElement("pad"));
await settle();
await page.keyboard.press("k");
await settle();
check("the Scale tool armed", await page.locator("[data-scale-section]").count(), 1);
check("the corner handles are drawn", await page.locator('[data-resize-handle="br"]').count(), 1);

// A SLOW drag: one pointer event per animation frame, 2px at a time, so every frame
// asks for a factor within a few thousandths of 1. That is exactly the case the old
// accumulate-from-the-last-frame path rounded away — a 1px stroke stayed 1px for the
// whole gesture because `round2(1 * 1.01)` was still 1 at the resolution it kept.
const from = await toScreen(300, 200);
const to = await toScreen(500, 300);
await page.mouse.move(from.x, from.y);
await page.mouse.down();
for (let i = 1; i <= 100; i++) {
  await page.mouse.move(from.x + ((to.x - from.x) * i) / 100, from.y + ((to.y - from.y) * i) / 100);
  await settle();
}
await page.mouse.up();
await settle();

const doubled = await readPad();
// The `br` handle pins the top-left: 200x100 → 400x200, and the corner the pointer
// held is exactly where the pointer stopped.
check("the box doubled from the opposite corner", [doubled.x, doubled.y, doubled.w, doubled.h], [100, 100, 400, 200]);
check("the radius came with it", doubled.radius, 20);
check("a 1px hairline doubled, slowly", doubled.stroke, 2);
check("the gap and padding scaled", [doubled.gap, doubled.padding], [16, 24]);
check("the child's box scaled", doubled.boxW, 352);
check("and the type did", doubled.labelFont, 32);

// A corner is a SCALE, so the aspect holds even when the pointer only travels on one
// axis: drag the `br` corner 200 WORLD px to the right (the canvas may be zoomed, so
// the screen distance is read from the view transform) and the height follows the
// box's own ratio instead of staying put.
const flatFrom = await toScreen(500, 300);
const flatTo = await toScreen(700, 300);
await page.mouse.move(flatFrom.x, flatFrom.y);
await page.mouse.down();
for (let i = 1; i <= 20; i++) {
  await page.mouse.move(flatFrom.x + ((flatTo.x - flatFrom.x) * i) / 20, flatFrom.y);
  await settle();
}
await page.mouse.up();
await settle();
const sideways = await readPad();
check("a horizontal corner drag keeps the aspect", [sideways.w, sideways.h], [600, 300]);
check("and its top-left is still pinned", [sideways.x, sideways.y], [100, 100]);

// The layer the old rule refused outright: an Auto Width text has no `fixed` axis,
// so it drew no handles and the panel answered `engine-sized`. It is the layer most
// often scaled by hand, so the handles and the factor field have to reach it.
await page.evaluate(() => {
  const bridge = window.__FISH_BRIDGE__;
  bridge.setElements([
    {
      id: "auto",
      type: "text",
      name: "auto",
      x: 200,
      y: 600,
      width: 120,
      height: 19,
      content: "Auto width",
      sizing: { width: "fit-content", height: "fit-content" },
      style: { fontFamily: "Inter", fontSize: 16, lineHeight: "19px", color: "#000000" }
    }
  ]);
});
await settle();
await page.evaluate(() => window.__FISH_BRIDGE__.selectElement("auto"));
await settle();
check("an Auto Width text draws its corner handles", await page.locator('[data-resize-handle="br"]').count(), 1);
check("and is not refused by the panel", await page.locator("[data-scale-derived]").count(), 0);

await page.locator('[data-scale-factor-menu="true"]').click();
await settle();
await page.locator('[data-scale-preset-option="2"]').click();
await settle();
const autoFont = await page.evaluate(() => {
  const t = window.__FISH_BRIDGE__.getElements().find((e) => e.id === "auto");
  return t.style?.fontSize;
});
check("so its type can be scaled from the panel", autoFont, 32);

// A `fill` width belongs to the parent, so it reads back 1x however far the other
// axis travelled. The panel divided by that axis, so a 2x scale put "1x" back in
// the field the instant it landed — and the preset tick went with it, over a box
// whose type and height had plainly doubled.
await page.evaluate(() => {
  window.__FISH_BRIDGE__.setElements([
    {
      id: "stack",
      type: "frame",
      name: "stack",
      x: 100,
      y: 900,
      width: 300,
      height: 200,
      display: "flex",
      "flex-direction": "column",
      gap: 0,
      padding: 0,
      children: [
        {
          id: "filling",
          type: "text",
          name: "filling",
          x: 0,
          y: 0,
          width: 300,
          height: 19,
          content: "Fills the row",
          sizing: { width: "fill", height: "fit-content" },
          style: { fontFamily: "Inter", fontSize: 16, lineHeight: "19px", color: "#000000" }
        }
      ]
    }
  ]);
});
await settle();
await page.evaluate(() => window.__FISH_BRIDGE__.selectElement("filling"));
await settle();
check("the Scale tool is still armed on the new selection", await page.locator("[data-scale-section]").count(), 1);

await page.locator('[data-scale-factor-menu="true"]').click();
await settle();
await page.locator('[data-scale-preset-option="2"]').click();
await settle();
const filling = await page.evaluate(() => {
  const t = window.__FISH_BRIDGE__.getElements()[0].children.find((c) => c.id === "filling");
  return { w: t.width, h: t.height, font: t.style?.fontSize };
});
check("a fill width is still the parent's", filling.w, 300);
check("while the type and the height double", [filling.font, filling.h], [32, 38]);
check(
  "the factor field reports the axis that did move",
  await page.locator("[data-scale-factor] input").inputValue(),
  "2"
);
await page.locator('[data-scale-factor-menu="true"]').click();
await settle();
check("and the preset is ticked", await page.locator('[data-scale-preset-option="2"] svg').count(), 1);
await page.locator('[data-scale-factor-menu="true"]').click();
await settle();

check("no page errors", errors, []);

let failed = 0;
for (const r of results) {
  if (!r.ok) {
    failed++;
    console.log(`FAIL  ${r.name}  -> ${JSON.stringify(r.actual)} (expected ${JSON.stringify(r.expected)})`);
  } else {
    console.log(`PASS  ${r.name}`);
  }
}
console.log(`\n${results.length - failed}/${results.length} passed`);
await browser.close();
process.exit(failed === 0 ? 0 : 1);
