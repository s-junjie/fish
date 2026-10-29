import { activeElements } from "./_support/doc.mjs";
import { chromium } from "playwright";
import { pathToFileURL } from "url";
import path from "path";

// The component entries that live outside the inspector panel:
//   1. right-click a definition (or an instance) offers component actions;
//   2. Reset on a pristine instance is disabled, and on a changed one clears the props;
//   3. the swap control is a searchable picker;
//   4. a variant set card expands into its members.
const html = path.resolve(process.cwd(), process.argv[2] ?? "dist/index.html");
const results = [];
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  results.push({ name, ok, actual, expected });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  -> got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`);
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
  const label = (id, content) => ({
    id: `${id}_t`,
    type: "text",
    name: "label",
    x: 8,
    y: 10,
    width: 80,
    height: 18,
    content,
    style: { fontFamily: "Inter", fontSize: 12, color: "#FFFFFF" }
  });
  const button = (id, name, content, x, set) => ({
    id,
    type: "component",
    name,
    x,
    y: 0,
    width: 100,
    height: 40,
    fills: [{ type: "solid", color: "#3B82F6" }],
    clipContent: false,
    ...(set || {}),
    children: [label(id, content)]
  });
  // A set is a real node holding its members, not a `setId` on flat siblings —
  // that flat shape is what the matrix replaced. The node is not the whole story
  // either: `ensureComponentSetNode` writes `setId` onto each member as well, and
  // `groupComponentSets` buckets on that field, so a fixture with the node but no
  // `setId` renders in the assets panel as loose cards with no expander.
  const sizeSet = {
    id: "set_size",
    type: "componentSet",
    name: "Size",
    x: 520,
    y: 0,
    width: 100,
    height: 40,
    variantGroupProperties: { size: ["Small", "Large"] },
    children: [
      button("c_size_s", "Size", "S", 520, { setId: "set_size", variantProperties: { size: "Small" } }),
      button("c_size_l", "Size", "L", 660, { setId: "set_size", variantProperties: { size: "Large" } })
    ]
  };
  bridge.setElements([
      button("c_btn", "Button", "Buy", 0, null),
      button("c_alt", "Alt", "Send", 140, null),
      sizeSet,
      { id: "inst_1", type: "instance", name: "Button", componentId: "c_btn", x: 900, y: 0, width: 100, height: 40, overrides: [] },
      // An outer definition holding an instance of the first one, plus an instance
      // of THAT: the only way to reach a nested instance's own panel.
      {
        id: "c_card",
        type: "component",
        name: "Card",
        x: 0,
        y: 200,
        width: 140,
        height: 60,
        children: [
          // Points at a set MEMBER, not a lone master: `InstanceVariantSection`
          // renders nothing at all when the master has no set behind it, so a slot
          // on `c_btn` would prove only that an empty panel is absent.
          { id: "card_slot", type: "instance", name: "Slot", componentId: "c_size_s", x: 10, y: 10, width: 100, height: 40 }
        ]
      },
      { id: "inst_card", type: "instance", name: "Card", componentId: "c_card", x: 1200, y: 200, width: 140, height: 60 }
    ], { canvas: { ...base.canvas, width: 2000, height: 1200 } });
});
await page.waitForTimeout(400);

const doc = () => page.evaluate(() => window.__FISH_BRIDGE__.getDoc());
const selected = () => page.evaluate(() => window.__FISH_BRIDGE__.getSelectedIds());
const instancesOf = async (componentId) =>
  activeElements(await doc()).filter((e) => e.type === "instance" && e.componentId === componentId).length;
const instanceById = async (id) => activeElements(await doc()).find((e) => e.id === id);

const pointOf = (id) =>
  page.evaluate((elId) => {
    const r = document.querySelector(`[data-element-id="${elId}"]`).getBoundingClientRect();
    return { x: r.left + r.width * 0.7, y: r.top + r.height * 0.6 };
  }, id);

const selectElement = async (id) => {
  const pt = await pointOf(id);
  await page.mouse.click(pt.x, pt.y);
  await page.waitForTimeout(160);
};

const openMenu = async (id) => {
  const pt = await pointOf(id);
  await page.mouse.click(pt.x, pt.y, { button: "right" });
  await page.waitForTimeout(160);
  return page.evaluate(() =>
    [...document.querySelectorAll("[data-context-item]")].map((el) => ({
      id: el.getAttribute("data-context-item"),
      disabled: el.disabled
    }))
  );
};

const menuItem = (entries, id) => entries.find((e) => e.id === id);

// --- 1. right-click a definition offers Create instance ---------------------
await selectElement("c_btn");
const componentMenu = await openMenu("c_btn");
check("a component offers Create instance", Boolean(menuItem(componentMenu, "createInstance")), true);
check(
  "a component offers no instance-only actions",
  [menuItem(componentMenu, "resetInstanceChanges"), menuItem(componentMenu, "detachInstance")].map(Boolean),
  [false, false]
);

await page.click('[data-context-item="createInstance"]');
await page.waitForTimeout(400);
check("Create instance placed one", await instancesOf("c_btn"), 2);
check("and selected it", (await selected()).length, 1);

// --- 2. right-click an instance offers its own actions ----------------------
const instanceMenu = await openMenu("inst_1");
check(
  "an instance offers reset / go to main / detach",
  ["resetInstanceChanges", "goToMainComponent", "detachInstance"].map((id) => Boolean(menuItem(instanceMenu, id))),
  [true, true, true]
);
check("an instance offers no Create instance", Boolean(menuItem(instanceMenu, "createInstance")), false);
check("reset is disabled while nothing changed", menuItem(instanceMenu, "resetInstanceChanges").disabled, true);

// --- 3. Reset clears what the user changed ----------------------------------
// The dirty state used to be a stored value in `instance.props`, edited through a
// `data-instance-prop` field. Both are gone with the named component properties,
// so the change Reset is judged on is now a LAYER override. It is committed over
// the bridge rather than by typing: what this section is about is the menu's
// enablement flipping and Reset clearing it, and the canvas text editor has no
// stable hook to drive (text editing lives in SvgElementRenderer/InstanceNode).
await selectElement("inst_1");
await page.evaluate(() => {
  const bridge = window.__FISH_BRIDGE__;
  const doc = bridge.getDoc();
  const inst = bridge.getElements().find((e) => e.id === "inst_1");
  // The label is a child of the master; the override names it by the target id
  // the instance resolves it to, which is the master's child id.
  const targetId = bridge.getElements().find((e) => e.id === "c_btn").children[0].id;
  bridge.setElements(doc.pages[0].children.map((e) =>
      e.id === "inst_1" ? { ...e, overrides: [{ targetId, property: "content", value: "Mine" }] } : e
    ));
});
await page.waitForTimeout(300);
check("the override reached the instance", (await instanceById("inst_1")).overrides, [
  { targetId: "c_btn_t", property: "content", value: "Mine" }
]);

const dirtyMenu2 = await openMenu("inst_1");
check("reset is enabled once an override is stored", menuItem(dirtyMenu2, "resetInstanceChanges").disabled, false);
await page.click('[data-context-item="resetInstanceChanges"]');
await page.waitForTimeout(400);
check("reset dropped the override", (await instanceById("inst_1")).overrides, []);

await page.evaluate(() => window.__FISH_BRIDGE__.undo());
await page.waitForTimeout(300);
check("one undo brings the override back", (await instanceById("inst_1")).overrides, [
  { targetId: "c_btn_t", property: "content", value: "Mine" }
]);
await selectElement("inst_1");
const afterUndoMenu = await openMenu("inst_1");
check(
  "and Reset is offered again",
  menuItem(afterUndoMenu, "resetInstanceChanges").disabled,
  false
);
await page.click('[data-context-item="resetInstanceChanges"]');
await page.waitForTimeout(400);
check("reset clears it once more", (await instanceById("inst_1")).overrides, []);

// --- 3b. go to main component frames the master, not just the page ----------
// The pan is what makes this check mean anything: with the viewport where the app
// left it the master is already on screen and any implementation passes. The
// instance sits at x 900 and its master at x 0, so a 700px shift leaves the one
// that gets right-clicked visible and the one being looked for off the left edge.
const areaCenter = () =>
  page.evaluate(() => {
    const container = document.querySelector('[data-canvas-root="true"]').getBoundingClientRect();
    let left = 0;
    let top = 0;
    let right = container.width;
    let bottom = container.height;
    for (const panel of document.querySelectorAll("[data-ui-panel]")) {
      const box = panel.getBoundingClientRect();
      const l = box.left - container.left;
      const r = box.right - container.left;
      const t = box.top - container.top;
      const b = box.bottom - container.top;
      if (Math.min(r, right) <= Math.max(l, left) || Math.min(b, bottom) <= Math.max(t, top)) continue;
      const edge = panel.dataset.uiPanel;
      if (edge === "left") left = Math.max(left, r);
      else if (edge === "right") right = Math.min(right, l);
      else if (edge === "dock") bottom = Math.min(bottom, t);
      else if (edge === "top") top = Math.max(top, b);
    }
    return { x: container.left + (left + right) / 2, y: container.top + (top + bottom) / 2 };
  });

const centerOf = (id) =>
  page.evaluate((elId) => {
    const el = document.querySelector(`[data-element-id="${elId}"]`);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, id);

// An untouched layer to measure the viewport by: every later section clicks
// canvas coordinates it computed from where the app left them.
const anchorBefore = await centerOf("c_alt");
await page.mouse.move(800, 500);
await page.mouse.wheel(700, 0);
await page.waitForTimeout(200);
// Culling may already have dropped the off-screen master, which is the same
// answer as "not where the canvas is pointing".
const masterBefore = await centerOf("c_btn");
check(
  "the master is off-centre before the jump",
  masterBefore === null || Math.abs(masterBefore.x - (await areaCenter()).x) > 200,
  true
);

await selectElement("inst_1");
const goToMainMenu = await openMenu("inst_1");
check("an instance offers go to main", Boolean(menuItem(goToMainMenu, "goToMainComponent")), true);
await page.click('[data-context-item="goToMainComponent"]');
await page.waitForTimeout(400);
check("go to main selected the master", await selected(), ["c_btn"]);

const masterAfter = await centerOf("c_btn");
const target = await areaCenter();
check(
  "and centred the canvas on it",
  masterAfter !== null && Math.abs(masterAfter.x - target.x) < 24 && Math.abs(masterAfter.y - target.y) < 24,
  true
);

// Put the viewport back, so the sections below click the coordinates they were
// written against.
await page.mouse.move(800, 500);
await page.mouse.wheel((await centerOf("c_alt")).x - anchorBefore.x, 0);
await page.waitForTimeout(200);

// --- 4. the swap control is searchable --------------------------------------
await selectElement("inst_1");
const swapOpened = await page.evaluate(() => {
  const open = document.querySelector("[data-swap-open]");
  if (!open) return false;
  open.click();
  return true;
});
check("the instance panel offers a swap picker", swapOpened, true);
await page.waitForSelector("[data-swap-search]");
await page.fill("[data-swap-search]", "Alt");
await page.waitForTimeout(120);
const filtered = await page.evaluate(() =>
  [...document.querySelectorAll("[data-swap-option]")].map((el) => el.getAttribute("data-swap-option"))
);
check("search narrows the candidates to the match", filtered, ["c_alt"]);

await page.click('[data-swap-option="c_alt"]');
await page.waitForTimeout(400);
check("picking one swaps the instance", (await instanceById("inst_1")).componentId, "c_alt");

// --- 5. a variant set card expands into its members -------------------------
await page.click('[data-testid="panel-tab-assets"]');
await page.waitForSelector('[data-asset-page="__doc__"]');
await page.waitForTimeout(200);
// The assets panel has its own Images / Components switch.
await page.evaluate(() => {
  const tab = [...document.querySelectorAll('[data-asset-doctabs="true"] button')].find(
    (b) => b.textContent?.trim() === "Components"
  );
  tab?.click();
});
await page.waitForTimeout(300);

const before = await page.evaluate(() => document.querySelectorAll("[data-asset-component]").length);
// The expander hangs off the SET's own entry now; under the flat model the
// attribute named one of its members, which is why this id moved to `set_size`.
const setCard = await page.$('[data-asset-variants="c_size_s"]');
check("the set card offers an expander", Boolean(setCard), true);
await page.click('[data-asset-variants="c_size_s"]');
await page.waitForTimeout(300);
const after = await page.evaluate(() => document.querySelectorAll("[data-asset-component]").length);
check("expanding shows the members as insertable cards", after - before, 2);

// --- 6. a definition can gain a variant, and a member's value can be renamed --
// `c_alt` is a lone main component, so its panel is the empty state with the ONE
// route in: adding the first axis, which promotes it to a set. That click also
// follows the selection onto the set, which is why the next button is the set's.
await page.click('[data-testid="panel-tab-layers"]');
await page.waitForTimeout(200);
await selectElement("c_alt");
await page.waitForSelector("[data-variant-property-first]");
await page.click("[data-variant-property-first]");
await page.waitForTimeout(300);
check(
  "adding the first axis put the selection on a component set",
  await page.$("[data-variant-property]") !== null,
  true
);
await page.click("[data-variant-add-button]");
await page.waitForTimeout(400);

// The new member arrives as a real `componentSet` node holding its members,
// NOT as a `variant.state` field bolted onto a flat sibling.
const afterVariant = await doc();
const newSet = activeElements(afterVariant).find((e) => e.type === "componentSet" && e.id !== "set_size");
check("adding a variant created a component set", newSet?.type, "componentSet");
check(
  "the set carries the axis the master had none of",
  Object.keys(newSet?.variantGroupProperties ?? {}).length,
  1
);
check("the master became a member of it", newSet?.children.some((c) => c.id === "c_alt"), true);
check("and a second member was duplicated for the new value", newSet?.children.length, 2);

// The existing set's axis is editable in place, and renaming the AXIS rewrites
// every member that carries it — the value rename the old flat model did.
// The MATRIX is what edits values — new ones are born here, which is why the
// per-variant panel offers a dropdown of existing values rather than free text.
// It renders for the set, so the row to select is the set's.
await page.click('[data-ui-panel="left"] [data-layer-row="set_size"]');
await page.waitForSelector('[data-variant-cell="Small"]');
await page.fill('[data-variant-cell="Small"]', "Compact");
await page.press('[data-variant-cell="Small"]', "Enter");
await page.waitForTimeout(400);
const renamed = await doc();
check(
  "renaming a value rewrites every member that shared it",
  activeElements(renamed)
    .find((e) => e.id === "set_size")
    .children.map((c) => c.variantProperties?.size)
    .sort(),
  ["Compact", "Large"]
);

// --- 7. a nested instance keeps its own panel -------------------------------
// Selected by its derived id, which is how the canvas and the layer tree address a
// clone that is not in the document at all. Note what this does NOT render: a
// nested clone is not an `instance` element, so it never reaches
// `InstanceVariantSection` — it gets `InstanceChildSection`, whose one control is
// re-pointing which component the nested layer is an instance of.
await page.evaluate(() => window.__FISH_BRIDGE__.selectElement("inst_card_card_slot"));
await page.waitForSelector('[data-testid="instance-child-section"]');
check(
  "a nested instance exposes the child panel",
  await page.$('[data-testid="instance-child-section"]') !== null,
  true
);
check(
  "with no prop editor left on it",
  await page.$("[data-nested-instance-props]") !== null,
  false
);
const nestedSwap = await page.evaluate(() => {
  const open = document.querySelector("[data-nested-instance-swap] [data-swap-open]");
  if (!open) return false;
  open.click();
  return true;
});
check("and can still be re-pointed at another component", nestedSwap, true);
await page.waitForSelector("[data-swap-search]");
// One row per component SET now, not one per member: this fixture's set is a
// single `Size` candidate whose committed member is the cell the nested instance
// already sits in, so searching the set's name has to return exactly one row.
await page.fill("[data-swap-search]", "Size");
await page.waitForTimeout(150);
const nestedFiltered = await page.evaluate(() =>
  [...document.querySelectorAll("[data-swap-option]")].map((el) => el.getAttribute("data-swap-option"))
);
check("its picker narrows to the set, as one row", nestedFiltered, ["c_size_s"]);
await page.fill("[data-swap-search]", "Alt");
await page.waitForTimeout(150);
await page.click('[data-swap-option="c_alt"]');
await page.waitForTimeout(400);
check(
  "picking one rewrites the override on the OUTER instance",
  activeElements(await doc()).find((e) => e.id === "inst_card").overrides,
  [{ targetId: "card_slot", property: "componentId", value: "c_alt" }]
);

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
console.log("pageErrors", errors.slice(0, 5));
await browser.close();
process.exit(failed.length === 0 && errors.length === 0 ? 0 : 1);
