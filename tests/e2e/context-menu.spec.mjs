import { chromium } from "playwright";
import { pathToFileURL } from "url";
import path from "path";

// The right-click menu, the clipboard command the menu makes easy to get wrong — a
// CUT of a main component has to come back under its own id, or every instance of it
// is orphaned for good — and the one row the menu offers only for one kind of layer.
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

const rect = (id, x, y, w, h, extra = {}) => ({
  id,
  type: "rect",
  name: id,
  x,
  y,
  width: w,
  height: h,
  fills: [{ type: "solid", color: "#3B82F6" }],
  ...extra
});

const applySetup = (elements) =>
  page.evaluate((els) => {
    const bridge = window.__FISH_BRIDGE__;
    const base = bridge.getDoc();
    bridge.setElements(els, { canvas: { ...base.canvas, width: 4000, height: 3000 } });
  }, elements);

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
const findIn = (id) =>
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
      return find(window.__FISH_BRIDGE__.getElements()) ?? null;
    },
    id
  );
const rightClickWorld = async (wx, wy) => {
  const p = await toScreen(wx, wy);
  await page.mouse.click(p.x, p.y, { button: "right" });
  await settle();
};
const menuItems = () =>
  page.evaluate(() =>
    [...document.querySelectorAll("[data-context-item]")].map(
      (n) => `${n.getAttribute("data-context-item")}${n.disabled ? ":off" : ""}`
    )
  );
const clickItem = async (id) => {
  await page.click(`[data-context-item="${id}"]`);
  await settle();
};
const select = async (id) => {
  await page.evaluate((elId) => window.__FISH_BRIDGE__.selectElement(elId), id);
  await settle();
};

// ------------------------------------------------------------ the menu itself opens
// `inst1` is here to make the menu's one conditional row testable: an instance gets
// a "Detach instance" row, nothing else does, so the two menus below can be told
// apart without either layer carrying a name.
await applySetup([
  rect("a", 300, 300, 120, 80, { fills: [{ type: "solid", color: "#FF0000" }], borderRadius: 12 }),
  rect("b", 600, 300, 120, 80, { fills: [{ type: "solid", color: "#00FF00" }] }),
  {
    id: "comp1",
    type: "component",
    name: "Chip",
    x: 900,
    y: 300,
    width: 120,
    height: 80,
    children: [rect("comp1_label", 12, 20, 60, 40)]
  },
  { id: "inst1", type: "instance", name: "Chip", componentId: "comp1", x: 900, y: 500, width: 120, height: 80 }
]);
await settle();
await select("a");
check("nothing is open before a right-click", await page.locator("[data-context-menu]").count(), 0);
await rightClickWorld(360, 340);
check("right-clicking a layer opens the menu", await page.locator("[data-context-menu]").count(), 1);
const onLayer = await menuItems();
check(
  "it lists the clipboard, the properties and the structure commands, in that order",
  onLayer,
  [
    "cut",
    "copy",
    "paste:off",
    "duplicate",
    "copyAsPng",
    "copyStyle",
    "pasteStyle:off",
    "group",
    "ungroup:off",
    "flatten",
    "bringToFront",
    "sendToBack",
    "toggleMask",
    "createComponent",
    "lock",
    "delete"
  ]
);
check("paste is off with an empty clipboard", onLayer.includes("paste:off"), true);
check("paste properties is off with nothing copied", onLayer.includes("pasteStyle:off"), true);
check("a plain shape is not offered detach", onLayer.includes("detachInstance"), false);

await page.keyboard.press("Escape");
await settle();
check("escape closes the menu", await page.locator("[data-context-menu]").count(), 0);

// Empty canvas is still our menu, and with nothing selected it may only paste.
await page.evaluate(() => window.__FISH_BRIDGE__.selectElement(""));
await settle();
await rightClickWorld(200, 520);
check("empty canvas still opens the menu", await page.locator("[data-context-menu]").count(), 1);
check("and with nothing selected it offers paste only", await menuItems(), ["paste:off", "pasteStyle:off"]);
await page.keyboard.press("Escape");
await settle();

// The menu belongs to the selection, and a right-click is not a selection gesture:
// right-clicking another layer must not move the selection out from under the menu.
await select("a");
await rightClickWorld(960, 540);
check("a right-click does not change the selection", await page.evaluate(() => window.__FISH_BRIDGE__.getSelectedIds()), ["a"]);
check(
  "and the menu is still the selected layer's, not the one under the pointer",
  (await menuItems()).includes("detachInstance"),
  false
);
await page.keyboard.press("Escape");
await settle();

// Detach instance is the menu's only conditional row: it appears for an instance and
// nothing else, because it is the one command whose subject — this layer is a link,
// not a definition — is a property of the layer rather than of the selection.
await select("inst1");
await rightClickWorld(960, 540);
check("selecting an instance offers detach", (await menuItems()).includes("detachInstance"), true);
await clickItem("detachInstance");
const detached = await findIn("inst1");
check("detaching from the menu turned the instance into a frame", detached.type, "frame");
check("keeping the id the instance had", detached.id, "inst1");
// Detaching a subtree is only worth anything if the nodes are editable afterwards,
// without clone markers that would refuse gestures.
check("and the children it hands over are real nodes, not derived clones", detached.children.map((c) => c.__instanceId ?? null), [null]);

// The Layers panel opens the same menu, under the same rule: the row under the
// pointer is not what the commands act on.
await select("a");
await page.locator('[data-layer-id="b"]').click({ button: "right" });
await settle();
check("right-clicking a layer row opens the menu", await page.locator("[data-context-menu]").count(), 1);
check("and it does not select the row", await page.evaluate(() => window.__FISH_BRIDGE__.getSelectedIds()), ["a"]);
await page.keyboard.press("Escape");
await settle();

// ---------------------------------------------------------- copy / paste properties
await select("a");
await rightClickWorld(360, 340);
await clickItem("copyStyle");
check("the menu closes after a command", await page.locator("[data-context-menu]").count(), 0);
await select("b");
await rightClickWorld(660, 340);
check("paste properties is on once something is copied", (await menuItems()).includes("pasteStyle"), true);
await clickItem("pasteStyle");

const painted = await findIn("b");
check("pasted properties carry the fill", painted.fills, [{ type: "solid", color: "#FF0000" }]);
check("pasted properties carry the corner radius", painted.borderRadius, 12);
check("pasted properties leave the geometry alone", [painted.x, painted.y, painted.width, painted.height], [600, 300, 120, 80]);

// The same pair from the keyboard, which is where Figma puts them. The event is
// dispatched with the CHARACTER macOS produces for Option+C ("ç") rather than the
// plain letter: matching `e.key` there is matching a character the keyboard layout
// invented, which is why these shortcuts used to do nothing at all on a Mac.
await applySetup([
  rect("a", 300, 300, 120, 80, { fills: [{ type: "solid", color: "#FF0000" }], borderRadius: 12 }),
  rect("b", 600, 300, 120, 80, { fills: [{ type: "solid", color: "#00FF00" }] }),
  rect("c", 900, 300, 120, 80, { fills: [{ type: "solid", color: "#0000FF" }] })
]);
await settle();
await select("a");
await select("a");
// What the page really receives for ⌥⌘C / ⌥⌘V on a US layout.
const pressOptionCmd = (letter, dead) =>
  page.evaluate(
    ({ l, k }) => window.dispatchEvent(
      new KeyboardEvent("keydown", { key: k, code: `Key${l}`, metaKey: true, altKey: true, bubbles: true, cancelable: true })
    ),
    { l: letter, k: dead }
  );
await pressOptionCmd("C", "\u00e7"); // ç
await settle();
await select("c");
await pressOptionCmd("V", "\u221a"); // √
await settle();
check("the ⌥⌘C / ⌥⌘V shortcuts work with the characters macOS sends", (await findIn("c")).fills, [
  { type: "solid", color: "#FF0000" }
]);
check("and the corner radius came with it", (await findIn("c")).borderRadius, 12);

// A locked layer is not hit-testable on the canvas (a lock protects against
// accidental edits), so its menu comes from the Layers panel — and the structural
// commands on it are exactly the edits a lock forbids, so they grey out.
await applySetup([rect("a", 300, 300, 120, 80), rect("locked", 600, 300, 120, 80, { locked: true })]);
await settle();
await select("locked");
await page.locator('[data-layer-id="locked"]').click({ button: "right" });
await settle();
const onLocked = await menuItems();
check("a locked layer still gets a menu", onLocked.includes("copy"), true);
check("copy stays available on it", onLocked.includes("copy:off"), false);
check("cut is off on a locked layer", onLocked.includes("cut:off"), true);
check("delete is off on a locked layer", onLocked.includes("delete:off"), true);
// The label is a leaf inside the row: `textContent` of the row concatenates the
// shortcut hint onto it (LESSONS §30).
check(
  "the lock command offers the unlock",
  (await page.locator('[data-context-item="lock"] span').first().textContent()).trim(),
  "Unlock"
);
await page.keyboard.press("Escape");
await settle();

// ------------------------------------------- cutting a main component keeps it alive
await applySetup([
  {
    id: "comp1",
    type: "component",
    name: "Button",
    x: 300,
    y: 600,
    width: 200,
    height: 80,
    children: [rect("comp1_label", 20, 20, 120, 40, { fills: [{ type: "solid", color: "#FFFFFF" }] })]
  },
  { id: "inst1", type: "instance", name: "Button", componentId: "comp1", x: 700, y: 600, width: 200, height: 80 }
]);
await settle();
check("the instance paints its master", await page.locator('[data-element-id="inst1_comp1_label"]').count(), 1);

await select("comp1");
await rightClickWorld(400, 640);
await clickItem("cut");
check("the cut removed the master from the document", await findIn("comp1"), null);
// The definition is only in the clipboard for the seconds between the cut and the
// paste, and an instance has no children of its own — so the renderer falls back to
// the last known definition instead of blanking the layer.
check("the instance keeps painting its master through the cut", await page.locator('[data-element-id="inst1_comp1_label"]').count(), 1);
check("and never shows the missing-master placeholder", await page.locator('rect[fill="rgba(239, 68, 68, 0.08)"]').count(), 0);

// Paste it back with nothing selected: a cut is a move, so the master returns
// under its own id and the instance heals.
await page.keyboard.press("Meta+V");
await settle();
const back = await findIn("comp1");
check("the paste brings the master back", Boolean(back), true);
check("with the id every instance links to", back.id, "comp1");
check("at the position it was cut from", [back.x, back.y], [300, 600]);
check("the instance paints its master again", await page.locator('[data-element-id="inst1_comp1_label"]').count(), 1);
check("and the placeholder is gone", await page.locator('rect[fill="rgba(239, 68, 68, 0.08)"]').count(), 0);

// A second paste of the same cut can no longer be verbatim — the ids are taken by
// the first paste — so it falls back to a copy, which is Figma's answer for pasting
// a main component: an instance of it, never a second definition.
await page.keyboard.press("Meta+V");
await settle();
const afterRepeat = await page.evaluate(() => {
  const els = window.__FISH_BRIDGE__.getElements();
  return {
    masters: els.filter((e) => e.type === "component").length,
    instances: els.filter((e) => e.type === "instance").map((e) => ({ id: e.id, componentId: e.componentId }))
  };
});
check("a repeat paste does not mint a second main component", afterRepeat.masters, 1);
check("it pastes an instance of the master instead", afterRepeat.instances.length, 2);
check("pointing at the master that is there", afterRepeat.instances[1].componentId, "comp1");
check("and the document still has one id per node", await page.evaluate(() => {
  const ids = [];
  const walk = (list) => list.forEach((el) => { ids.push(el.id); walk(el.children || []); });
  walk(window.__FISH_BRIDGE__.getElements());
  return new Set(ids).size === ids.length;
}), true);

// Deleting a master is the same tolerance, said out loud: the instances render the
// last known definition for this session, and the hint is what tells the user so.
await applySetup([
  {
    id: "comp1",
    type: "component",
    name: "Button",
    x: 300,
    y: 600,
    width: 200,
    height: 80,
    children: [rect("comp1_label", 20, 20, 120, 40)]
  },
  { id: "inst1", type: "instance", name: "Button", componentId: "comp1", x: 700, y: 600, width: 200, height: 80 }
]);
await settle();
await select("comp1");
await page.keyboard.press("Backspace");
await settle();
check(
  "deleting a live master says the instances kept their last known definition",
  await page.locator("text=/last known definition/").count() > 0,
  true
);
check("and the instances really still paint", await page.locator('[data-element-id="inst1_comp1_label"]').count(), 1);

// ------------------------------- a layer INSIDE an instance is still a selection
// It is painted but never stored, so the menu looked for it in the document tree,
// found nothing, and collapsed to the two rows that do not read the selection at
// all. The rows that READ the layer the canvas painted stay on; the rows that write
// back by id have nowhere to put an edit and grey out. This section replaces the
// document, so it runs last.
await applySetup([
  {
    id: "comp1",
    type: "component",
    name: "Chip",
    x: 300,
    y: 600,
    width: 200,
    height: 80,
    children: [rect("comp1_label", 20, 20, 120, 40, { borderRadius: 8 })]
  },
  { id: "inst1", type: "instance", name: "Chip", componentId: "comp1", x: 700, y: 600, width: 200, height: 80 }
]);
await settle();
check("the instance paints the child it projects", await page.locator('[data-element-id="inst1_comp1_label"]').count(), 1);

await select("inst1_comp1_label");
await rightClickWorld(200, 520);
const insideInstance = await menuItems();
check(
  "an instance's child gets the whole command set, not the paste-only menu",
  insideInstance.length >= 14,
  true
);
check("copy is on for it", insideInstance.includes("copy:off"), false);
check("copy as PNG is on for it", insideInstance.includes("copyAsPng:off"), false);
check("copy properties is on for it", insideInstance.includes("copyStyle:off"), false);
check("tracing it back to the master is on for it", insideInstance.includes("goToMainComponent"), true);
check("and it is not offered as a new main component", insideInstance.includes("createComponent"), false);
// Each of these writes back by id with NO instance route at all, so the row is
// greyed rather than offered and doing nothing. Lock and Delete are deliberately
// NOT among them: both are expressible as an override on the instance, and the
// panel's own padlock and Delete key have always written them that way.
for (const id of ["cut", "duplicate", "group", "ungroup", "bringToFront", "sendToBack"]) {
  check(`nothing offers ${id} on a layer the instance places`, insideInstance.includes(`${id}:off`), true);
}
check(
  "no row that writes into the tree is left switched on",
  insideInstance
    .filter((row) => !row.endsWith(":off"))
    .filter(
      (id) =>
        !["copy", "copyAsPng", "copyStyle", "paste", "pasteStyle", "goToMainComponent", "lock", "delete"].includes(id)
    ),
  []
);

const overrideFor = (property) =>
  page.evaluate((prop) => {
    const inst = window.__FISH_BRIDGE__.getElements().find((e) => e.id === "inst1");
    const ov = (inst.overrides ?? []).find((o) => o.property === prop);
    return ov ? [ov.targetId, ov.property, ov.value] : null;
  }, property);

// Lock has to agree with the layer panel's padlock, which has always locked a
// projected layer by writing the lock onto the instance.
await select("inst1_comp1_label");
await rightClickWorld(200, 520);
check("lock is on for it", (await menuItems()).includes("lock:off"), false);
await clickItem("lock");
check("locking one writes the lock onto the instance", await overrideFor("locked"), ["comp1_label", "locked", true]);
await rightClickWorld(200, 520);
check(
  "and the row now offers to release it",
  (await page.locator('[data-context-item="lock"] span').first().textContent()).trim(),
  "Unlock"
);
await clickItem("lock");
check("the second click releases it instead of locking again", await overrideFor("locked"), [
  "comp1_label",
  "locked",
  false
]);

// Paste properties, which is the pair that works in BOTH directions across the
// instance boundary: the source is an ordinary layer, the target is one only the
// canvas paints. `src` and `dst` are different sizes from the master's child so the
// copy assertions further down cannot pick them up by accident.
await applySetup([
  rect("src", 300, 900, 88, 24, { fills: [{ type: "solid", color: "#F97316" }], opacity: 0.4 }),
  rect("dst", 500, 900, 64, 20, { fills: [{ type: "solid", color: "#10B981" }] }),
  {
    id: "comp1",
    type: "component",
    name: "Chip",
    x: 300,
    y: 600,
    width: 200,
    height: 80,
    children: [rect("comp1_label", 20, 20, 120, 40, { borderRadius: 8 })]
  },
  { id: "inst1", type: "instance", name: "Chip", componentId: "comp1", x: 700, y: 600, width: 200, height: 80 }
]);
await settle();

await select("src");
await rightClickWorld(320, 910);
await clickItem("copyStyle");

await select("inst1_comp1_label");
await rightClickWorld(200, 520);
check("paste properties is on for a layer the instance places", (await menuItems()).includes("pasteStyle:off"), false);
await clickItem("pasteStyle");
check("it lands as a fill on the instance", await overrideFor("fills"), [
  "comp1_label",
  "fills",
  [{ type: "solid", color: "#F97316" }]
]);
check("and so does the opacity that came with it", await overrideFor("opacity"), [
  "comp1_label",
  "opacity",
  0.4
]);
// The write went to the instance, not to the definition: every other instance of
// this master — and the master itself — keeps the paint it had.
check(
  "the master's own child keeps its fill",
  await page.evaluate(() => {
    const master = window.__FISH_BRIDGE__.getElements().find((e) => e.id === "comp1");
    return master.children[0].fills;
  }),
  [{ type: "solid", color: "#3B82F6" }]
);
const projectedPaint = await page.evaluate(() => {
  const host = document.querySelector('[data-element-id="inst1_comp1_label"]');
  if (!host) return null;
  // The first `<path>` in the group is the hit-area ghost — `data-hit` marks it and
  // its fill is `transparent` on purpose — so the paint is the one without it.
  const paint = host.querySelector("path:not([data-hit])");
  return {
    fill: paint ? getComputedStyle(paint).fill : null,
    opacity: host.getAttribute("opacity")
  };
});
check("the canvas repaints it in the source's colour", projectedPaint.fill, "rgb(249, 115, 22)");
check("and carries the pasted opacity", projectedPaint.opacity, "0.4");

// Copying properties back OUT of an instance reads the layer the canvas painted —
// including the override the paste above just wrote — which is what makes the pair
// symmetric rather than one-way. `dst` is a third colour so the write is visible.
await select("inst1_comp1_label");
await rightClickWorld(200, 520);
await clickItem("copyStyle");
await select("dst");
await rightClickWorld(520, 910);
await clickItem("pasteStyle");
check("and copies back out of the instance", await page.evaluate(() => {
  const el = window.__FISH_BRIDGE__.getElements().find((e) => e.id === "dst");
  return { fills: el.fills, opacity: el.opacity };
}), { fills: [{ type: "solid", color: "#F97316" }], opacity: 0.4 });

// Copying one carries the layer the canvas painted: a real node, at the master
// child's own size (120x40 — the instance's own subtree is 200x80 with no children
// to copy at all), not the page origin.
//
// The POSITION is no longer readable here: `cb9886a` made a paste with nothing
// selected land on the centre of the view, so a copy's source coordinates are
// normalized away on the way out. Asserting the painted spot would now be
// asserting the drop rule, not the copy.
await select("inst1_comp1_label");
await rightClickWorld(200, 520);
await clickItem("copy");
await page.evaluate(() => window.__FISH_BRIDGE__.selectElement(""));
await page.keyboard.press("Meta+V");
await settle();
const pastedChild = await page.evaluate(() => {
  const els = window.__FISH_BRIDGE__.getElements();
  return els
    .filter((e) => e.type === "rect" && e.width === 120 && e.height === 40)
    .map((e) => ({ x: e.x, y: e.y, radius: e.borderRadius, derived: e.__instanceId ?? null }));
});
check(
  "the copy is a node of its own, not filed at the page origin",
  pastedChild.length === 1 && !(pastedChild[0].x === 0 && pastedChild[0].y === 0),
  true
);
check("it kept the master's corner radius", pastedChild[0]?.radius, 8);
check("and it is a real node, not a clone that refuses every edit", pastedChild[0]?.derived, null);
check("the instance still paints its own child", await page.locator('[data-element-id="inst1_comp1_label"]').count(), 1);
check(
  "and no second instance was minted",
  await page.evaluate(() => window.__FISH_BRIDGE__.getElements().filter((e) => e.type === "instance").length),
  1
);

// The panel opens the same menu under the identical rule. Selecting the derived row
// is what reveals it — the panel expands the instance projecting it — so no twisty
// has to be found first.
await select("inst1_comp1_label");
await settle();
await page.locator('[data-layer-id="inst1_comp1_label"]').click({ button: "right" });
await settle();
check("the layer-panel row offers copy too", (await menuItems()).includes("copy:off"), false);
await page.keyboard.press("Escape");
await settle();

// Delete is the other write an instance can express, so it stays on: the layer is
// hidden inside this instance as an override, while the master and every other
// instance keep it. The rule the menu applies is "the tree has nowhere to put the
// write", not "the layer is inside an instance".
await select("inst1_comp1_label");
await rightClickWorld(200, 520);
check("delete is on for it", (await menuItems()).includes("delete:off"), false);
await clickItem("delete");
check("deleting one hides it inside this instance only", await overrideFor("visible"), [
  "comp1_label",
  "visible",
  false
]);
check("and the canvas stops painting it", await page.locator('[data-element-id="inst1_comp1_label"]').count(), 0);
check(
  "while the master still carries it",
  await page.evaluate(() => {
    const master = window.__FISH_BRIDGE__.getElements().find((e) => e.id === "comp1");
    return (master.children ?? []).map((c) => c.id);
  }),
  ["comp1_label"]
);

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : `  -> ${JSON.stringify(r.actual)} (expected ${JSON.stringify(r.expected)})`}`);
}
console.log(`\n${results.length - failed.length}/${results.length} passed`);
console.log("pageErrors", errors.slice(0, 5));

await browser.close();
process.exit(failed.length === 0 && errors.length === 0 ? 0 : 1);
