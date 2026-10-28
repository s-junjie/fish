import { activeElements } from "./_support/doc.mjs";
import { chromium } from "playwright";
import { pathToFileURL } from "url";
import path from "path";

// Four structural promises, all of them about the master/instance boundary:
//   1. resizing a master reaches the instances that never sized themselves, and
//      leaves the ones the user sized alone;
//   2. Reset puts a hand-sized instance back on its master's box;
//   3. a main component cannot be nested inside another one — instances are the
//      only way to reuse a component inside a component;
//   4. a nested instance (the icon inside a button) can be swapped from the outer
//      instance, which writes a `componentId` override — but never to the
//      component it lives in, the one it already is, or the ones it shows;
//   5. promoting a frame that HOLDS a master hoists the master out and leaves an
//      instance behind, without moving the drawing a pixel.
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

const MASTER_W = 200;
const MASTER_H = 100;

const fixture = (masterW, masterH) => ({
  masterW,
  masterH
});

const applyFixture = (masterW = MASTER_W, masterH = MASTER_H) =>
  page.evaluate(
    ({ masterW: mw, masterH: mh }) => {
      const bridge = window.__FISH_BRIDGE__;
      const base = bridge.getDoc();
      const solid = (color) => [{ type: "solid", color }];
      const dot = (id, color) => ({
        id: "dot",
        type: "rect",
        name: "dot",
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        fills: solid(color)
      });
      bridge.setElements([
          {
            id: "master",
            type: "component",
            name: "MASTER",
            x: 0,
            y: 100,
            width: mw,
            height: mh,
            fills: solid("#1F2937"),
            clipContent: false,
            children: [
              {
                id: "LABEL",
                type: "text",
                name: "LABEL",
                x: 8,
                y: 8,
                width: 120,
                height: 20,
                content: "Caption",
                style: { fontFamily: "Inter", fontSize: 14, color: "#FFFFFF" }
              }
            ]
          },
          { id: "follows", type: "instance", name: "FOLLOWS", componentId: "master", x: 400, y: 100, width: mw, height: mh },
          {
            id: "pinned",
            type: "instance",
            name: "PINNED",
            componentId: "master",
            x: 800,
            y: 100,
            width: 260,
            height: 130,
            sizeOverride: true
          },
          {
            id: "outer",
            type: "component",
            name: "OUTER",
            x: 0,
            y: 400,
            width: 200,
            height: 100,
            fills: solid("#374151"),
            clipContent: false,
            children: [
              {
                id: "sub",
                type: "frame",
                name: "SUB",
                x: 10,
                y: 10,
                width: 60,
                height: 60,
                fills: solid("#111827"),
                children: []
              }
            ]
          },
          { id: "other", type: "component", name: "OTHER", x: 900, y: 400, width: 200, height: 100, fills: solid("#4B5563"), children: [] },
          { id: "icon_a", type: "component", name: "ICON_A", x: 0, y: 800, width: 24, height: 24, children: [dot("dot", "#EF4444")] },
          { id: "icon_b", type: "component", name: "ICON_B", x: 120, y: 800, width: 24, height: 24, children: [dot("dot", "#22C55E")] },
          {
            id: "card",
            type: "component",
            name: "CARD",
            x: 0,
            y: 900,
            width: 200,
            height: 80,
            fills: solid("#1F2937"),
            clipContent: false,
            children: [
              { id: "slot", type: "instance", name: "SLOT", componentId: "icon_a", x: 10, y: 10, width: 24, height: 24 }
            ]
          },
          {
            id: "cardInst",
            type: "instance",
            name: "CARD INST",
            componentId: "card",
            x: 400,
            y: 900,
            width: 200,
            height: 80
          },
          {
            id: "glass",
            type: "frame",
            name: "GLASS",
            x: 1200,
            y: 100,
            width: 240,
            height: 120,
            fills: solid("#0F172A"),
            clipContent: false,
            children: [
              {
                id: "chip",
                type: "component",
                name: "CHIP",
                x: 20,
                y: 20,
                width: 120,
                height: 48,
                fills: solid("#7C3AED"),
                clipContent: false,
                children: [
                  {
                    id: "chipLabel",
                    type: "text",
                    name: "chipLabel",
                    x: 8,
                    y: 8,
                    width: 60,
                    height: 18,
                    content: "Chip",
                    style: { fontFamily: "Inter", fontSize: 12, color: "#FFFFFF" }
                  }
                ]
              },
              {
                id: "glassBody",
                type: "rect",
                name: "glassBody",
                x: 20,
                y: 80,
                width: 200,
                height: 20,
                fills: solid("#334155")
              }
            ]
          }
        ], { canvas: { ...base.canvas, width: 4000, height: 3000 } });
    },
    fixture(masterW, masterH)
  );

const doc = () => page.evaluate(() => window.__FISH_BRIDGE__.getDoc());
const el = async (id) => activeElements(await doc()).find((e) => e.id === id);
const selected = () => page.evaluate(() => window.__FISH_BRIDGE__.getSelectedIds());
const centerOf = (selector) =>
  page.evaluate((sel) => {
    const g = document.querySelector(sel);
    if (!g) throw new Error(`${sel} is not rendered`);
    const r = g.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, selector);
const highlighted = (id) =>
  page.evaluate((elId) => {
    const g = document.querySelector(`[data-element-id="${elId}"]`);
    return !!g?.querySelector('rect[data-overlay="true"]');
  }, id);
const panelRow = (id) => `[data-ui-panel="left"] [data-layer-row="${id}"]`;
const hintShown = (re) => page.evaluate((src) => new RegExp(src, "i").test(document.body.innerText), re);
// A hint lives for `hintTimeout(msg)` — 4s at the floor, longer for a long
// message — so "it cleared itself" is a poll against the DOM, never a fixed
// sleep. A sleep here is the test guessing a number the product owns.
const hintCleared = async (re, budgetMs = 12000) => {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (!(await hintShown(re))) return true;
    await page.waitForTimeout(100);
  }
  return false;
};

// --- 1. a resized master reaches its instances -------------------------------
await applyFixture();
await page.waitForTimeout(300);

await applyFixture(320, 240);
await page.waitForTimeout(300);
let follows = await el("follows");
let pinned = await el("pinned");
let master = await el("master");
check("an instance that never set its size follows a resized master", follows.width === 320 && follows.height === 240, `${follows.width}x${follows.height}`);
check("an instance the user sized keeps its own box", pinned.width === 260 && pinned.height === 130, `${pinned.width}x${pinned.height}`);
check("the master itself took the new size", master.width === 320 && master.height === 240, `${master.width}x${master.height}`);

const rendered = await page.evaluate(() => {
  const box = (id) => {
    const r = document.querySelector(`[data-element-id="${id}"]`)?.getBoundingClientRect();
    return r ? { w: Math.round(r.width), h: Math.round(r.height) } : null;
  };
  return { master: box("master"), follows: box("follows") };
});
check(
  "the instance paints at the master's new size",
  rendered.follows && rendered.master && rendered.follows.w === rendered.master.w,
  JSON.stringify(rendered)
);

// The gesture path: dragging the master's right edge resizes it, and the
// instances that follow must move with it.
await applyFixture();
await page.waitForTimeout(300);
await page.evaluate(() => window.__FISH_BRIDGE__.selectElement("master"));
await page.waitForTimeout(200);
const handle = await centerOf('[data-resize-handle="mr"]');
await page.mouse.move(handle.x, handle.y);
await page.mouse.down();
await page.mouse.move(handle.x + 120, handle.y, { steps: 10 });
await page.mouse.up();
await page.waitForTimeout(300);
master = await el("master");
follows = await el("follows");
pinned = await el("pinned");
check("dragging the master's edge actually resized it", master.width > MASTER_W, `master ${master.width}`);
check("the follower took the dragged size", follows.width === master.width, `master ${master.width} vs follows ${follows.width}`);
check("the pinned instance stayed put through the drag", pinned.width === 260, `pinned ${pinned.width}`);

// --- 2. Reset puts the box back ---------------------------------------------
await page.evaluate(() => window.__FISH_BRIDGE__.selectElement("pinned"));
await page.waitForTimeout(200);
await page.click('button[title^="Reset Overrides"]');
await page.waitForTimeout(300);
pinned = await el("pinned");
master = await el("master");
check(
  "Reset restores the master's box",
  pinned.width === master.width && pinned.height === master.height,
  `master ${master.width}x${master.height} vs pinned ${pinned.width}x${pinned.height}`
);
check("Reset drops the hand-set flag", pinned.sizeOverride === undefined, `sizeOverride=${pinned.sizeOverride}`);

// --- 3. no master inside a master -------------------------------------------
await applyFixture();
await page.waitForTimeout(300);
await page.evaluate(() => window.__FISH_BRIDGE__.selectElement("other"));
await page.waitForTimeout(200);
const otherCenter = await centerOf('[data-element-id="other"]');
const outerCenter = await centerOf('[data-element-id="outer"]');
await page.mouse.move(otherCenter.x, otherCenter.y);
await page.mouse.down();
await page.mouse.move(outerCenter.x, outerCenter.y, { steps: 12 });
await page.waitForTimeout(120);
check("another master never highlights as a drop target", !(await highlighted("outer")));
await page.mouse.up();
await page.waitForTimeout(250);

let outer = await el("outer");
check("dropping a master on a master does not nest it", !(outer.children || []).some((c) => c.id === "other"), JSON.stringify((outer.children || []).map((c) => c.id)));
check("the refused master is still a top-level element", Boolean(await el("other")));
check("the canvas refusal is announced", await hintShown("nested inside another"));

await page.dragAndDrop(panelRow("other"), panelRow("outer"));
await page.waitForTimeout(250);
outer = await el("outer");
check("the layer-tree drop is refused too", !(outer.children || []).some((c) => c.id === "other"), JSON.stringify((outer.children || []).map((c) => c.id)));

// Turning a layer that lives inside a master into another master is the same
// rule seen from the other side (⌥⌘K / the inspector button). The refused drag
// left `other` parked on top of `outer`, so reset the scene first.
await applyFixture();
await page.waitForTimeout(300);
const subPt = await centerOf('[data-element-id="sub"]');
await page.mouse.dblclick(subPt.x, subPt.y);
await page.waitForTimeout(300);
const subSelection = (await selected()).join();
check("a double click reaches a layer inside a master", subSelection === "sub", subSelection);
const createButton = await page.evaluate(() => {
  const titles = [...document.querySelectorAll('[data-ui-panel="right"] button')].map((b) => b.getAttribute("title") || "");
  const b = document.querySelector('[data-ui-panel="right"] button[title^="A main component cannot"]');
  return { found: !!b, disabled: b?.disabled, nested: titles.filter((t) => /main component/i.test(t)) };
});
check("the create-component button is disabled there", createButton.found && createButton.disabled, JSON.stringify(createButton));
const beforeShortcut = JSON.stringify(activeElements(await doc()).map((e) => e.type));
await page.keyboard.down("Meta");
await page.keyboard.press("Alt+k");
await page.keyboard.up("Meta");
await page.waitForTimeout(250);
check("⌥⌘K inside a master creates nothing", JSON.stringify(activeElements(await doc()).map((e) => e.type)) === beforeShortcut);

// --- 4. the nested instance can be swapped ----------------------------------
await applyFixture();
await page.waitForTimeout(300);

// A double click inside the instance stops AT the nested instance rather than
// falling through to the icon's own content — a nested instance is a boundary of
// its own, and the next double click is what enters it. Selecting the innermost
// shape in one go is what made an instance-in-an-instance unusable.
const nested = await centerOf('[data-element-id="cardInst_slot"]');
await page.mouse.dblclick(nested.x, nested.y);
await page.waitForTimeout(300);
const drilled = (await selected()).join();
check("a double click drills into the nested instance", drilled === "cardInst_slot", drilled);

await page.mouse.dblclick(nested.x, nested.y);
await page.waitForTimeout(300);
const drilledDeep = (await selected()).join();
check("the next double click enters the nested instance", drilledDeep === "cardInst_slot_dot", drilledDeep);
const deepStrip = await page.evaluate(() => {
  const el = document.querySelector("[data-testid=\"instance-child-section\"]");
  return {
    swap: !!document.querySelector("[data-nested-instance-swap]"),
    editable: !!el?.querySelector("[data-instance-child-overridable]")
  };
});
// Two crossings down is addressable too — the override travels as a path and the
// outer instance hands it to the nested one — so the strip offers the controls
// rather than the read-only notice.
check("the deep copy is editable, not read-only", !deepStrip.swap && deepStrip.editable, JSON.stringify(deepStrip));

// The nested instance itself is selected from the layer tree, which is where it
// is reachable by id.
const rowOf = (id) => `[data-ui-panel="left"] [data-layer-row="${id}"]`;
// Drilling in already opened the instance's rows (the selection is revealed), so
// only click the twisty when the row is genuinely hidden.
if (!(await page.$(rowOf("cardInst_slot")))) {
  await page.locator(`${rowOf("cardInst")} button`).first().click();
  await page.waitForTimeout(250);
}
await page.click(rowOf("cardInst_slot"));
await page.waitForTimeout(300);
const nestedSelection = (await selected()).join();
check("the layer tree selects the nested instance", nestedSelection === "cardInst_slot", nestedSelection);

// The swap control is a searchable picker: a button that shows the current master
// and opens a list. Opening it is what makes the candidates readable.
const swapBefore = await page.evaluate(() => {
  const box = document.querySelector("[data-nested-instance-swap]");
  const open = box?.querySelector("[data-swap-open]");
  return {
    found: !!box,
    showsCurrent: (open?.textContent || "").includes("ICON_A"),
    opened: !!open && (open.click(), true),
    strip: !!document.querySelector('[data-testid="instance-child-section"]'),
    text: (document.querySelector('[data-ui-panel="right"]')?.innerText || "").slice(0, 200).replace(/\n/g, " | ")
  };
});
await page.waitForTimeout(200);
check("the nested instance offers a swap control", swapBefore.found && swapBefore.opened, JSON.stringify(swapBefore));
check("the swap control shows the nested instance's master", swapBefore.showsCurrent, JSON.stringify(swapBefore));

// The instance's own family is offered but locked: itself (nothing to do), the
// component it lives in (it would become its own ancestor), and whatever it
// already shows. Unrelated components stay selectable.
const optionState = await page.evaluate(() =>
  [...document.querySelectorAll("[data-nested-instance-swap] [data-swap-option]")].map((el) => ({
    value: el.getAttribute("data-swap-option"),
    disabled: el.disabled
  }))
);
const locked = Object.fromEntries(optionState.map((o) => [o.value, o.disabled]));
check("the component the instance lives in is locked", locked.card === true, JSON.stringify(optionState));
check("the instance's own master is locked", locked.icon_a === true, JSON.stringify(optionState));
check("an unrelated component is still selectable", locked.icon_b === false, JSON.stringify(optionState));

// The group holds the hit-area shape first (fill="transparent"), so ask for the
// painted colours rather than the first shape.
const dotFill = () =>
  page.evaluate(() => {
    const g = document.querySelector('[data-element-id="cardInst_slot_dot"]');
    if (!g) return [];
    return [...g.querySelectorAll("rect, path")]
      .map((n) => n.getAttribute("fill"))
      .filter((f) => f && f !== "transparent" && f !== "none");
  });
check("the nested instance paints its own master's content", (await dotFill()).includes("#EF4444"), JSON.stringify(await dotFill()));

await page.click('[data-nested-instance-swap] [data-swap-option="icon_b"]');
await page.waitForTimeout(350);
const cardInst = await el("cardInst");
check(
  "swapping writes a componentId override on the outer instance",
  JSON.stringify(cardInst.overrides) === JSON.stringify([{ targetId: "slot", property: "componentId", value: "icon_b" }]),
  JSON.stringify(cardInst.overrides)
);
check("the nested instance repaints with the new master", (await dotFill()).includes("#22C55E"), JSON.stringify(await dotFill()));

// --- 5. promoting a frame that holds a master --------------------------------
await applyFixture();
await page.waitForTimeout(300);

const boxOf = (selector) =>
  page.evaluate((sel) => {
    const g = document.querySelector(sel);
    if (!g) return null;
    const r = g.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  }, selector);

const glassChildrenBefore = ((await el("glass")).children || []).map((c) => `${c.id}:${c.type}`).join();
const chipLabelBefore = await boxOf('[data-element-id="chipLabel"]');
check(
  "the frame starts out holding the master",
  glassChildrenBefore === "chip:component,glassBody:rect",
  glassChildrenBefore
);

await page.evaluate(() => window.__FISH_BRIDGE__.selectElement("glass"));
await page.waitForTimeout(200);
await page.keyboard.down("Meta");
await page.keyboard.press("Alt+k");
await page.keyboard.up("Meta");
await page.waitForTimeout(400);

const glass = await el("glass");
const pageEls = activeElements(await doc());
check("the frame became a component", glass.type === "component", glass.type);
check("the master was hoisted out to the page", pageEls.some((e) => e.id === "chip"));
check(
  "no component is left inside the new component",
  !(glass.children || []).some((c) => c.type === "component"),
  JSON.stringify((glass.children || []).map((c) => `${c.id}:${c.type}`))
);

const placedInst = (glass.children || [])[0];
check(
  "an instance of the master took its slot, with its box",
  placedInst?.type === "instance" &&
    placedInst.componentId === "chip" &&
    placedInst.x === 20 &&
    placedInst.y === 20 &&
    placedInst.width === 120 &&
    placedInst.height === 48,
  JSON.stringify(placedInst)
);
check("the other child stayed put", (glass.children || [])[1]?.id === "glassBody", JSON.stringify((glass.children || []).map((c) => c.id)));
check(
  "the hoisted master kept its content",
  (((await el("chip")).children) || []).map((c) => c.id).join() === "chipLabel",
  JSON.stringify(((await el("chip")).children || []).map((c) => c.id))
);

// The pixel proof: what the instance now paints sits exactly where the master's
// own layer was, while the master itself has moved aside.
const chipLabelAfter = await boxOf(
  `[data-element-id^="${placedInst.id}"][data-element-id$="_chipLabel"]`
);
const masterLabelAfter = await boxOf('[data-element-id="chipLabel"]');
check(
  "the drawing did not move: the clone paints where the master's layer was",
  chipLabelBefore && JSON.stringify(chipLabelBefore) === JSON.stringify(chipLabelAfter),
  `${JSON.stringify(chipLabelBefore)} vs ${JSON.stringify(chipLabelAfter)}`
);
check(
  "the master itself moved beside the component",
  masterLabelAfter && masterLabelAfter.x > chipLabelBefore.x,
  `${JSON.stringify(masterLabelAfter)} vs ${JSON.stringify(chipLabelBefore)}`
);
check("the promotion is announced", await hintShown("Main component moved outside"));

// The inspector button is the other call site of the same op, and it reports the
// move through its own path. Wait out the first toast so this cannot pass on it.
check("the notice clears itself", await hintCleared("Main component moved outside"));
await page.evaluate(() => window.__FISH_BRIDGE__.undo());
await page.waitForTimeout(400);
await page.evaluate(() => window.__FISH_BRIDGE__.selectElement("glass"));
await page.waitForTimeout(250);
const buttonBefore = (await el("glass")).type;
await page.click('[data-ui-panel="right"] button[title^="Create Component"]');
await page.waitForTimeout(400);
check(
  "the inspector button promotes the same frame",
  buttonBefore === "frame" && (await el("glass")).type === "component",
  `before=${buttonBefore} after=${(await el("glass")).type}`
);
check("the button path reports the move too", await hintShown("Main component moved outside"));

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
console.log("pageErrors", errors.slice(0, 5));

await browser.close();
process.exit(failed.length === 0 && errors.length === 0 ? 0 : 1);
