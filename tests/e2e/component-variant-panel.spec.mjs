import { activeElements } from "./_support/doc.mjs";
import { chromium } from "playwright";
import { pathToFileURL } from "url";
import path from "path";

// The variant panel, graded on what the audit found broken:
//   1. editing one variant's value rewrites THAT member only — it used to rename
//      every member sharing the value and drop the old value from the set;
//   2. the "+ Add variant" / "Remove variant" / "+ Add property" controls are
//      mounted, not dead code;
//   3. a component SET offers no fill/stroke/effects/size it cannot honour;
//   4. "Go to main component" on a nested instance leads to ITS master;
//   5. a `True/False` axis is a switch, and switching it re-points the instance.
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
  const member = (id, setId, name, coords, x, content) => ({
    id,
    type: "component",
    name,
    x,
    y: 0,
    width: 100,
    height: 40,
    fills: [{ type: "solid", color: "#3B82F6" }],
    setId,
    variantProperties: coords,
    children: [label(id, content)]
  });
  const sizeSet = {
    id: "set_size",
    type: "componentSet",
    name: "Size",
    x: 0,
    y: 200,
    width: 200,
    height: 40,
    variantGroupProperties: { size: ["Small", "Large"] },
    children: [
      member("c_size_s", "set_size", "size=Small", { size: "Small" }, 0, "S"),
      member("c_size_l", "set_size", "size=Large", { size: "Large" }, 140, "L")
    ]
  };
  const toggleSet = {
    id: "set_toggle",
    type: "componentSet",
    name: "Toggle",
    x: 0,
    y: 400,
    width: 200,
    height: 40,
    variantGroupProperties: { Disabled: ["True", "False"] },
    children: [
      member("c_on", "set_toggle", "Disabled=True", { Disabled: "True" }, 0, "On"),
      member("c_off", "set_toggle", "Disabled=False", { Disabled: "False" }, 140, "Off")
    ]
  };
  bridge.setElements(
    [
      sizeSet,
      toggleSet,
      // A card whose slot is an instance of a set MEMBER: the only way to reach a
      // nested instance's own master.
      {
        id: "c_card",
        type: "component",
        name: "Card",
        x: 0,
        y: 600,
        width: 140,
        height: 60,
        children: [{ id: "card_slot", type: "instance", name: "Slot", componentId: "c_size_s", x: 10, y: 10, width: 100, height: 40 }]
      },
      { id: "inst_card", type: "instance", name: "Card", componentId: "c_card", x: 900, y: 600, width: 140, height: 60 },
      { id: "inst_toggle", type: "instance", name: "Toggle", componentId: "c_on", x: 900, y: 400, width: 100, height: 40 }
    ],
    { canvas: { ...base.canvas, width: 2000, height: 1200 } }
  );
});
await page.waitForTimeout(400);

const doc = () => page.evaluate(() => window.__FISH_BRIDGE__.getDoc());
const selected = () => page.evaluate(() => window.__FISH_BRIDGE__.getSelectedIds());
const setNode = async (id) => activeElements(await doc()).find((el) => el.id === id);
const row = (id) => `[data-ui-panel="left"] [data-layer-row="${id}"]`;
const panelText = () => page.evaluate(() => document.querySelector('[data-ui-panel="right"]')?.innerText || "");
const selectRow = async (id) => {
  await page.click(row(id));
  await page.waitForTimeout(200);
};

// --- 1. editing one member's value leaves the rest of the set alone ----------
await selectRow("c_size_s");
await page.waitForSelector('[data-variant-cell="Small"]');
await page.fill('[data-variant-cell="Small"]', "Compact");
await page.press('[data-variant-cell="Small"]', "Enter");
await page.waitForTimeout(400);
const afterValue = await setNode("set_size");
check(
  "only the edited member's coordinate changed",
  afterValue.children.map((c) => c.variantProperties.size),
  ["Compact", "Large"]
);
check(
  "the new value is offerable on the set, and the untouched one is still there",
  ["Compact", "Large"].every((v) => Object.values(afterValue.variantGroupProperties).flat().includes(v)),
  true
);

// --- 1b. the value left behind by that edit can be cleaned up ---------------
await selectRow("set_size");
await page.waitForSelector('[data-variant-cell="Small"]');
const removedValue = await page.evaluate(() => {
  const input = document.querySelector('[data-variant-cell="Small"]');
  const trash = input?.closest("div")?.querySelector('button[title^="Remove"]');
  if (!trash) return false;
  trash.click();
  return true;
});
check("the unused value row offers its own trash", removedValue, true);
await page.waitForTimeout(400);
check(
  "and the leftover value is gone from the table",
  Object.values((await setNode("set_size")).variantGroupProperties).flat().includes("Small"),
  false
);


// --- 2. add / remove variant are mounted and work ----------------------------
// Back onto a member: the matrix has its own "+" per column, and what this
// grades is the per-variant panel's pair of controls.
await selectRow("c_size_s");
check("the per-variant panel offers + Add variant", (await page.$("[data-variant-add-next]")) !== null, true);
check("the per-variant panel offers Remove variant", (await page.$("[data-variant-remove]")) !== null, true);
await page.click("[data-variant-add-next]");
await page.waitForTimeout(400);
check("adding a variant added a member", (await setNode("set_size")).children.length, 3);
await page.waitForSelector("[data-variant-remove]");
await page.click("[data-variant-remove]");
await page.waitForTimeout(400);
check("removing it took the member away again", (await setNode("set_size")).children.length, 2);

// --- 3. a set can gain a second axis ----------------------------------------
await selectRow("set_size");
check("the set panel offers + Add property", (await page.$("[data-variant-add-property]")) !== null, true);
await page.click("[data-variant-add-property]");
await page.waitForTimeout(400);
check(
  "the set now has a second property",
  Object.keys((await setNode("set_size")).variantGroupProperties).length,
  2
);

// --- 4. a set offers no paint or size it cannot honour ----------------------
const setPanel = await panelText();
check("a set shows no size fields", (await page.$('[data-inspector-section="size"]')) !== null, false);
check("a set shows no fill stack", (await page.$('[data-paint-stack="fill"]')) !== null, false);
check("a set shows no stroke section", setPanel.toLowerCase().includes("stroke"), false);
check("a set shows no effects section", setPanel.toLowerCase().includes("effects"), false);

// --- 5. go to main on a NESTED instance leads to that instance's master -----
await page.evaluate(() => window.__FISH_BRIDGE__.selectElement("inst_card_card_slot"));
await page.waitForSelector('[data-testid="instance-child-section"]');
await page.click('[data-testid="instance-child-section"] button[title="Go to Main Component"]');
await page.waitForTimeout(400);
check("go to main selected the nested instance's own master", [...(await selected())], ["c_size_s"]);

// --- 6. a boolean axis is a switch ------------------------------------------
await page.evaluate(() => window.__FISH_BRIDGE__.selectElement("inst_toggle"));
await page.waitForSelector('[data-variant-switch="Disabled"]');
await page.click('[data-variant-switch="Disabled"]');
await page.waitForTimeout(400);
check("flipping the switch re-pointed the instance", (await setNode("inst_toggle")).componentId, "c_off");

// --- 7. a standalone component offers the canvas "+" too --------------------
// The command already promoted a lone component to a set; the button was gated on
// `setId`, so the one case the comment named was the one case it never reached.
await page.evaluate(() => window.__FISH_BRIDGE__.selectElement("c_card"));
await page.waitForTimeout(250);
check(
  "a standalone component shows + Add variant on its box",
  (await page.$('[data-canvas-add-variant="c_card"]')) !== null,
  true
);

// --- 8. an Alt-drop that cannot swap does not fall through to insert --------
const altDrop = (componentId, instanceId) =>
  page.evaluate(
    ({ cid, iid }) => {
      const el = document.querySelector(`[data-element-id="${iid}"]`);
      const root = document.querySelector('[data-canvas-root="true"]');
      if (!el || !root) return false;
      const r = el.getBoundingClientRect();
      const dt = new DataTransfer();
      dt.setData("application/x-fish-asset", JSON.stringify({ componentId: cid }));
      root.dispatchEvent(
        new DragEvent("drop", {
          bubbles: true,
          cancelable: true,
          dataTransfer: dt,
          altKey: true,
          clientX: r.left + r.width / 2,
          clientY: r.top + r.height / 2
        })
      );
      return true;
    },
    { cid: componentId, iid: instanceId }
  );

const elementCount = async () => activeElements(await doc()).length;
const before = await elementCount();
check("the Alt-drop had an instance to land on", await altDrop("c_off", "inst_toggle"), true);
await page.waitForTimeout(400);
check(
  "an Alt-drop of the component already there adds nothing",
  await elementCount(),
  before
);
check(
  "and leaves the instance pointing where it was",
  (await setNode("inst_toggle")).componentId,
  "c_off"
);

await altDrop("c_on", "inst_toggle");
await page.waitForTimeout(400);
check("an Alt-drop of another component swaps in place", await elementCount(), before);
check("the instance now projects that component", (await setNode("inst_toggle")).componentId, "c_on");

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
console.log("pageErrors", errors.slice(0, 5));
await browser.close();
process.exit(failed.length === 0 && errors.length === 0 ? 0 : 1);
