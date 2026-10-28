import { activeElements } from "./_support/doc.mjs";
import { chromium } from "playwright";
import { pathToFileURL } from "url";
import path from "path";

// The master↔instance contract, driven the way a user drives it:
//   1. a master resized from the inspector reaches its instances, not only a
//      master resized by dragging it on the canvas;
//   2. an instance carries its master's name, with no "Instance" suffix —
//      including the copy a duplicate or a paste leaves behind;
//   3. clip is overridable, on a nested instance and on any layer inside one;
//   4. a layer inside an instance has a lock and an eye in the layer tree, and
//      Delete hides it instead of refusing with a warning;
//   5. a click on an instance-in-an-instance lands on the nested instance, not
//      on the innermost shape it paints — and the selection box is drawn where
//      that shape actually is, however deep it sits.
const html = path.resolve(process.cwd(), process.argv[2] ?? "dist/index.html");
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  (${detail})`}`);
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

const fixture = () =>
  page.evaluate(() => {
    const bridge = window.__FISH_BRIDGE__;
    const base = bridge.getDoc();
    const solid = (color) => [{ type: "solid", color }];
    bridge.setElements([
        {
          id: "icon",
          type: "component",
          name: "ICON",
          x: 0,
          y: 600,
          width: 24,
          height: 24,
          children: [{ id: "dot", type: "rect", name: "dot", x: 0, y: 0, width: 24, height: 24, fills: solid("#EF4444") }]
        },
        {
          id: "card",
          type: "component",
          name: "CARD",
          x: 0,
          y: 200,
          width: 200,
          height: 80,
          fills: solid("#1F2937"),
          clipContent: false,
          children: [
            { id: "slot", type: "instance", name: "ICON", componentId: "icon", x: 10, y: 10, width: 24, height: 24 },
            {
              id: "label",
              type: "text",
              name: "label",
              x: 60,
              y: 30,
              width: 100,
              height: 20,
              content: "Card",
              style: { fontFamily: "Inter", fontSize: 14, color: "#FFFFFF" }
            }
          ]
        },
        { id: "cardInst", type: "instance", name: "CARD", componentId: "card", x: 400, y: 200, width: 200, height: 80 }
      ], { canvas: { ...base.canvas, width: 4000, height: 3000 } });
  });

const doc = () => page.evaluate(() => window.__FISH_BRIDGE__.getDoc());
const el = async (id) => activeElements(await doc()).find((e) => e.id === id);
const selected = () => page.evaluate(() => window.__FISH_BRIDGE__.getSelectedIds());
// Escape now walks up one container, so a setup that needs TRUE emptiness clears
// through the bridge instead of assuming one press is a reset.
const clearSelection = () => page.evaluate(() => window.__FISH_BRIDGE__.selectElements([]));
const centerOf = (sel) =>
  page.evaluate((s) => {
    const g = document.querySelector(s);
    if (!g) throw new Error(`${s} is not rendered`);
    const r = g.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, sel);
const rectOf = (sel) =>
  page.evaluate((s) => {
    const g = document.querySelector(s);
    if (!g) return null;
    const r = g.getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  }, sel);
const hintShown = (re) => page.evaluate((src) => new RegExp(src, "i").test(document.body.innerText), re);
const sizeField = (axis) =>
  page.evaluate((a) => {
    const inputs = Array.from(document.querySelectorAll("[data-scrub-field]"));
    const found = inputs.find((inp) => inp.parentElement?.querySelector("span")?.textContent === a);
    return found ? inputs.indexOf(found) : -1;
  }, axis);

await fixture();
await page.waitForTimeout(400);

// --- 1. a master resized from the inspector reaches its instances ------------
await page.evaluate(() => window.__FISH_BRIDGE__.selectElement("card"));
await page.waitForTimeout(150);
const wIndex = await sizeField("W");
const hIndex = await sizeField("H");
const setSize = async (index, value) => {
  const field = page.locator("[data-scrub-field]").nth(index);
  await field.click();
  await field.fill(String(value));
  await field.press("Enter");
  await page.waitForTimeout(150);
};
await setSize(wIndex, 320);
const afterW = await el("cardInst");
check("a width typed on the master reaches the instance", afterW.width === 320, `instance ${afterW.width}`);
await setSize(hIndex, 140);
const afterH = await el("cardInst");
check("and so does a height typed afterwards", afterH.height === 140, `instance ${afterH.height}`);
check("the instance kept the first axis too", afterH.width === 320, `instance ${afterH.width}`);

// --- 2. an instance is named after its master -------------------------------
await fixture();
await page.waitForTimeout(300);
await page.evaluate(() => window.__FISH_BRIDGE__.selectElement("cardInst"));
await page.waitForTimeout(150);
await page.keyboard.down("Meta");
await page.keyboard.press("d");
await page.keyboard.up("Meta");
await page.waitForTimeout(250);
const duplicated = activeElements(await doc()).filter((e) => e.id !== "cardInst" && e.componentId === "card");
check(
  "a duplicated instance keeps its master's name",
  duplicated.length === 1 && duplicated[0].name === "CARD",
  JSON.stringify(duplicated.map((e) => e.name))
);

// --- 3. clip is overridable -------------------------------------------------
await fixture();
await page.waitForTimeout(300);
await page.evaluate(() => window.__FISH_BRIDGE__.selectElement("cardInst_slot"));
await page.waitForTimeout(250);
const clipBox = await page.$('[data-check-row="clip-content"]');
check("a nested instance offers the clip switch", !!clipBox, 'no [data-check-row="clip-content"]');
if (clipBox) {
  // The hook is on the `sr-only` input, which is a 1px box UNDER its own label —
  // clicking its centre hit the visible 14px chip drawn on top of it and timed out
  // on "intercepts pointer events". Click the label instead: that is what a user
  // clicks, and label activation is what flips the checkbox.
  await page.locator('label:has([data-check-row="clip-content"])').click();
  await page.waitForTimeout(200);
  const overrides = JSON.stringify((await el("cardInst")).overrides || []);
  check("toggling clip writes an override on the instance", overrides.includes("clipContent") && overrides.includes("true"), overrides);
  const masterClip = (await el("card")).clipContent;
  check("the master is left alone", !masterClip, `master clipContent=${masterClip}`);
}

// --- 4. lock, hide and Delete inside an instance ----------------------------
await fixture();
await page.waitForTimeout(300);
const rowOf = (id) => `[data-ui-panel="left"] [data-layer-row="${id}"]`;
if (!(await page.$(rowOf("cardInst_slot")))) {
  await page.locator(`${rowOf("cardInst")} button`).first().click();
  await page.waitForTimeout(250);
}
const eye = await page.$('[data-ui-panel="left"] [data-layer-eye="cardInst_slot"]');
const lock = await page.$('[data-ui-panel="left"] [data-layer-lock="cardInst_slot"]');
check("a nested instance row has both switches", !!eye && !!lock, `eye=${!!eye} lock=${!!lock}`);
await eye.click();
await page.waitForTimeout(200);
let overrides = JSON.stringify((await el("cardInst")).overrides || []);
check("the eye hides the layer in this instance", overrides.includes('"property":"visible","value":false'), overrides);
await eye.click();
await page.waitForTimeout(200);
overrides = JSON.stringify((await el("cardInst")).overrides || []);
check("and shows it again", overrides.includes('"property":"visible","value":true'), overrides);
await lock.click();
await page.waitForTimeout(200);
overrides = JSON.stringify((await el("cardInst")).overrides || []);
check("the padlock locks it in this instance", overrides.includes('"property":"locked","value":true'), overrides);

await clearSelection();
await page.click(rowOf("cardInst_slot"));
await page.waitForTimeout(200);
await page.keyboard.press("Backspace");
await page.waitForTimeout(250);
overrides = JSON.stringify((await el("cardInst")).overrides || []);
check("Delete hides a layer inside an instance", overrides.includes('"property":"visible","value":false'), overrides);
check("Delete raises no warning", !(await hintShown("main component to change")), "warning shown");
check("the layer is still in the master", Boolean((await el("card")).children.find((c) => c.id === "slot")), "master lost it");

// --- 5. a click on an instance-in-an-instance -------------------------------
await fixture();
await page.waitForTimeout(300);
const dotCenter = await centerOf('[data-element-id="cardInst_slot_dot"]');
await clearSelection();
await page.mouse.click(dotCenter.x, dotCenter.y);
await page.waitForTimeout(200);
check("a plain click selects the outer instance", (await selected()).join() === "cardInst", (await selected()).join());

await page.mouse.dblclick(dotCenter.x, dotCenter.y);
await page.waitForTimeout(250);
check("a double click stops at the nested instance", (await selected()).join() === "cardInst_slot", (await selected()).join());

await page.mouse.dblclick(dotCenter.x, dotCenter.y);
await page.waitForTimeout(250);
check("the next double click enters it", (await selected()).join() === "cardInst_slot_dot", (await selected()).join());

// The selection box has to sit on the painted node: a deep clone's offsets live
// in the resolution, and the outermost instance alone is not its origin.
const painted = await rectOf('[data-element-id="cardInst_slot_dot"]');
const box = await rectOf("[data-transform-locked]");
const near = (a, b) => Math.abs(a - b) <= 2;
check(
  "the selection box is drawn where the deep node is painted",
  painted && box && near(painted.x, box.x) && near(painted.y, box.y) && near(painted.width, box.width),
  JSON.stringify({ painted, box })
);

// Delete hides it at any depth: the override travels as a path, and the outer
// instance hands the tail to the nested one when that one resolves.
await page.evaluate(() => document.activeElement?.blur());
await page.keyboard.press("Delete");
await page.waitForTimeout(250);
const deepOverrides = JSON.stringify((await el("cardInst")).overrides || []);
check(
  "Delete hides a node two crossings down",
  deepOverrides.includes('"targetId":"slot/dot"') && deepOverrides.includes('"property":"visible","value":false'),
  deepOverrides
);
check("Delete on a deep node raises no warning", !(await hintShown("main component to change")), "warning shown");
check("the hidden node stops being painted", !(await rectOf('[data-element-id="cardInst_slot_dot"]')), "still painted");
check("its nested instance is still painted", Boolean(await rectOf('[data-element-id="cardInst_slot"]')), "gone");

check("no page errors", errors.length === 0, JSON.stringify(errors));

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
console.log(`pageErrors ${JSON.stringify(errors)}`);
await browser.close();
if (failed > 0) process.exit(1);
