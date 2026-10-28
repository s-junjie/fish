import { activeElements } from "./_support/doc.mjs";
import { chromium } from "playwright";
import { pathToFileURL } from "url";
import path from "path";

// The unified paste path, driven the way a user drives it:
//   1. same-file Cmd+C then a REAL Cmd+V — the keydown handler must not swallow
//      the paste event (the old bug that made image pasting unreachable);
//   2. a paste with nothing selected centres the copy on the canvas the user is
//      looking at, rather than filing it back inside the frame it came from;
//   3. cross-file: the payload one file writes lands in another file with
//      reminted ids and the referenced assets carried over;
//   4. an instance copied out of one file lands in the other as a LIVE instance
//      whose main component travelled with it — the regression this guards;
//   5. an image pasted from the OS clipboard becomes an image-fill element.

const html = path.resolve(process.cwd(), process.argv[2] ?? "dist/index.html");
const results = [];
const check = (name, actual, expected) => {
  results.push({ name, ok: JSON.stringify(actual) === JSON.stringify(expected), actual, expected });
};

const browser = await chromium.launch();
const errors = [];

const newFishPage = async () => {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await page.goto(pathToFileURL(html).href);
  await page.waitForFunction(() => !!window.__FISH_BRIDGE__);
  return page;
};

const applySetup = (page) =>
  page.evaluate(() => {
    const bridge = window.__FISH_BRIDGE__;
    const base = bridge.getDoc();
    const rect = (id, x, y, w, h) => ({
      id, type: "rect", name: id, x, y, width: w, height: h,
      fills: [{ type: "solid", color: "#3B82F6" }]
    });
    bridge.setElements([rect("alpha", 400, 400, 200, 150)], { canvas: { ...base.canvas, width: 4000, height: 3000 } });
  });

const elementIds = (page) => page.evaluate(() => window.__FISH_BRIDGE__.getElements().map((e) => e.id));
const selected = (page) => page.evaluate(() => window.__FISH_BRIDGE__.getSelectedIds());
const settle = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

// ---------- 1. same-file copy + real Cmd+V ----------
const pageA = await newFishPage();
await applySetup(pageA);
await pageA.evaluate(() => window.__FISH_BRIDGE__.selectElement("alpha"));
await settle(pageA);

await pageA.keyboard.press("Control+c");
await settle(pageA);

const beforePaste = await elementIds(pageA);
// macOS Chromium's paste shortcut is Cmd, and the keydown handler deliberately
// lets it through so the browser fires the `paste` event.
await pageA.keyboard.press("Meta+v");
await settle(pageA);

const afterPaste = await elementIds(pageA);
check("real Cmd+V pastes the in-memory copy", afterPaste.length, beforePaste.length + 1);
check("paste keeps the original element", afterPaste.includes("alpha"), true);
check("paste selects the clone", await selected(pageA), [afterPaste.find((id) => id !== "alpha" && !beforePaste.includes(id))].filter(Boolean));

// ---------- 1b. a paste nobody aimed at lands where the user is looking ------
// Copy a layer, click the empty canvas to say "not in there", then paste. The
// copy used to be nudged 20px off its original, so a layer copied from a region
// the user has since scrolled away from was pasted somewhere off the view: the
// gesture fired, and nothing appeared anywhere they could see.
await pageA.evaluate(() => {
  window.__FISH_BRIDGE__.insertElement({
    id: "farrect",
    type: "rect",
    name: "farrect",
    x: 6000,
    y: 4000,
    width: 200,
    height: 150,
    fills: [{ type: "solid", color: "#3B82F6" }]
  });
  window.__FISH_BRIDGE__.insertElement({
    id: "far",
    type: "frame",
    name: "far",
    x: 6000,
    y: 4600,
    width: 400,
    height: 300,
    children: [
      { id: "farchild", type: "rect", name: "farchild", x: 40, y: 40, width: 120, height: 80, fills: [{ type: "solid", color: "#EF4444" }] }
    ]
  });
});
await settle(pageA);

// "Can the user see it": painted at all, inside the window, and under no panel.
// The canvas is full-bleed with the panels lying over it, so being on screen is
// not the same as being visible.
const visibleToUser = (page, id) =>
  page.evaluate((elId) => {
    const node = document.querySelector(`[data-element-id="${CSS.escape(elId)}"]`);
    if (!node) return [false, false, true];
    const r = node.getBoundingClientRect();
    const covered = [...document.querySelectorAll("[data-ui-panel]")].some((p) => {
      const b = p.getBoundingClientRect();
      return Math.min(b.right, r.right) > Math.max(b.left, r.left) && Math.min(b.bottom, r.bottom) > Math.max(b.top, r.top);
    });
    return [true, r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight, covered];
  }, id);

const copyThenPasteWithNothingSelected = async (page, id) => {
  await page.evaluate((elId) => window.__FISH_BRIDGE__.selectElement(elId), id);
  await settle(page);
  await page.keyboard.press("Control+c");
  await settle(page);
  // Clicking the empty canvas is the ordinary way to say "not in there".
  await page.mouse.click(1200, 900);
  await settle(page);
  const afterClick = await selected(page);
  await page.keyboard.press("Meta+v");
  await settle(page);
  return afterClick;
};

const beforeFar = await elementIds(pageA);
check("clicking the empty canvas clears the selection", await copyThenPasteWithNothingSelected(pageA, "farrect"), []);

const rootClone = (await elementIds(pageA)).find((id) => !beforeFar.includes(id));
check("a copy pasted with nothing selected is added", Boolean(rootClone), true);
check("the original is left where it was", await pageA.evaluate(() => window.__FISH_BRIDGE__.getElements().find((e) => e.id === "farrect").x), 6000);
check("and the copy is where the user can see it", await visibleToUser(pageA, rootClone), [true, true, false]);

await copyThenPasteWithNothingSelected(pageA, "farchild");
const farChildren = await pageA.evaluate((keep) => {
  const roots = window.__FISH_BRIDGE__.getElements();
  const frame = roots.find((e) => e.id === "far");
  const clone = roots.find((e) => e.id !== "far" && e.id !== "farrect" && e.type === "rect" && e.id !== keep);
  return { nested: frame ? frame.children.length : -1, cloneId: clone ? clone.id : null };
}, rootClone);
check("the frame it came from does not take the copy", farChildren.nested, 1);
check("and a nested source is where the user can see it", await visibleToUser(pageA, farChildren.cloneId), [true, true, false]);

// ---------- 2. cross-file: payload from page A lands in page B ----------
// Intercept the system-clipboard write to move the payload between files the
// way the OS clipboard would, without depending on clipboard permissions.
await applySetup(pageA);
await pageA.evaluate(() => {
  window.__capturedPayload = null;
  navigator.clipboard.writeText = async (text) => {
    window.__capturedPayload = text;
  };
});
await pageA.evaluate(() => window.__FISH_BRIDGE__.selectElement("alpha"));
await settle(pageA);
await pageA.keyboard.press("Control+c");
await settle(pageA);
const payloadText = await pageA.evaluate(() => window.__capturedPayload);
check("copy serializes a FISH payload to the system clipboard", typeof payloadText === "string" && payloadText.includes("fish-clipboard@2"), true);

const pageB = await newFishPage();
await applySetup(pageB); // a DIFFERENT document that only has its own "alpha"
await pageB.evaluate((text) => {
  const dt = new DataTransfer();
  dt.setData("text/plain", text);
  window.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true }));
}, payloadText);
await settle(pageB);

const idsB = await elementIds(pageB);
check("cross-file paste adds the copied subtree", idsB.length, 2);
const imported = idsB.find((id) => !["alpha"].includes(id) && id !== "alpha");
check("cross-file paste mints a fresh id", !!imported && imported !== "alpha", true);
const importedEl = await pageB.evaluate((id) => window.__FISH_BRIDGE__.getElements().find((e) => e.id === id), imported);
check("cross-file paste keeps geometry", importedEl && [importedEl.width, importedEl.height], [200, 150]);
check("cross-file paste selects the import", await selected(pageB), [imported]);

// ---------- 3. a component instance pasted into another file stays an instance ----------
// The regression: the payload used to be flattened into a plain frame, so an
// instance lost its master link AND its own appearance (the hand-written field
// list dropped fills/layout/borderRadius/effects/clipContent).
const applyComponentSetup = (page) =>
  page.evaluate(() => {
    const bridge = window.__FISH_BRIDGE__;
    const base = bridge.getDoc();
    bridge.setElements([
        {
          id: "src-comp",
          type: "component",
          name: "Chip",
          x: 0, y: 0, width: 120, height: 40,
          fills: [{ type: "solid", color: "#22C55E" }],
          borderRadius: 8,
          display: "flex",
          "flex-direction": "row",
          gap: 8,
          padding: 12,
          children: [
            { id: "src-label", type: "text", x: 0, y: 0, width: 40, height: 16, content: "Hi", style: { fontFamily: "Inter", fontSize: 14, color: "#FFFFFF" } }
          ]
        },
        {
          id: "src-inst", type: "instance", name: "Chip",
          componentId: "src-comp",
          x: 600, y: 600, width: 120, height: 40,
          overrides: [{ targetId: "src-label", property: "content", value: "Rent" }]
        }
      ], { canvas: { ...base.canvas, width: 4000, height: 3000 } });
  });

const pageC = await newFishPage();
await applyComponentSetup(pageC);
await pageC.evaluate(() => {
  window.__capturedPayload = null;
  navigator.clipboard.writeText = async (text) => { window.__capturedPayload = text; };
});
await pageC.evaluate(() => window.__FISH_BRIDGE__.selectElement("src-inst"));
await settle(pageC);
await pageC.keyboard.press("Control+c");
await settle(pageC);
const instancePayload = await pageC.evaluate(() => window.__capturedPayload);
check("copying an instance serializes a v2 payload", typeof instancePayload === "string" && instancePayload.includes("fish-clipboard@2"), true);
check("the payload carries the master the instance depends on", instancePayload.includes("src-comp"), true);

const pageD = await newFishPage();
await applySetup(pageD);
await pageD.evaluate((text) => {
  const dt = new DataTransfer();
  dt.setData("text/plain", text);
  window.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true }));
}, instancePayload);
await settle(pageD);

const docD = await pageD.evaluate(() => window.__FISH_BRIDGE__.getDoc());
const rootsD = activeElements(docD);
const pastedInstance = rootsD.find((e) => e.type === "instance");
const carriedMaster = rootsD.find((e) => e.type === "component");

check("cross-file paste lands a live instance, not a flattened frame", pastedInstance && pastedInstance.type, "instance");
check("the instance's componentId is reminted", pastedInstance && pastedInstance.componentId !== "src-comp", true);
check("the master travelled with the copy", !!carriedMaster, true);
check("the master has a fresh id", carriedMaster && carriedMaster.id !== "src-comp", true);
check("the instance resolves to the carried master", pastedInstance && carriedMaster && pastedInstance.componentId === carriedMaster.id, true);
check("the master keeps its fill", carriedMaster && JSON.stringify(carriedMaster.fills).includes("22C55E"), true);
check("the master keeps its border radius", carriedMaster && carriedMaster.borderRadius, 8);
check("the master keeps its auto-layout", carriedMaster && carriedMaster.display, "flex");
check("the master keeps its layers", carriedMaster && (carriedMaster.children || []).length, 1);
check("the override follows the label to its new id", (() => {
  if (!pastedInstance || !carriedMaster) return false;
  const label = (carriedMaster.children || []).find((c) => c.type === "text");
  return label && pastedInstance.overrides[0].targetId === label.id;
})(), true);
check("the pasted instance is selected", await selected(pageD), pastedInstance ? [pastedInstance.id] : []);

// ---------- 4. image from the OS clipboard ----------
await pageB.evaluate(async () => {
  const canvas = document.createElement("canvas");
  canvas.width = 60;
  canvas.height = 40;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ff0000";
  ctx.fillRect(0, 0, 60, 40);
  const blob = await new Promise((r) => canvas.toBlob(r, "image/png"));
  const file = new File([blob], "pasted.png", { type: "image/png" });
  const dt = new DataTransfer();
  dt.items.add(file);
  window.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true }));
});
await settle(pageB);
await pageB.waitForFunction(() => (window.__FISH_BRIDGE__.getDoc().assets || []).length > 0, null, { timeout: 5000 }).catch(() => {});

const imageAssets = await pageB.evaluate(() => (window.__FISH_BRIDGE__.getDoc().assets || []));
check("pasted image lands in the asset list", imageAssets.length, 1);
const docAfterImage = await pageB.evaluate(() => window.__FISH_BRIDGE__.getDoc());
const imageEl = activeElements(docAfterImage).find((e) => (e.fills || []).some((p) => p.type === "image"));
check("pasted image becomes an element with an image fill", !!imageEl, true);
check("pasted image references the carried asset", imageEl && imageEl.fills[0].assetId === imageAssets[0].id, true);
check("pasted image is selected", imageEl ? await selected(pageB) : null, [imageEl.id]);

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : `  -> ${JSON.stringify(r.actual)} (expected ${JSON.stringify(r.expected)})`}`);
}
console.log(`\n${results.length - failed.length}/${results.length} passed`);
console.log("pageErrors", errors.slice(0, 5));

await browser.close();
process.exit(failed.length === 0 && errors.length === 0 ? 0 : 1);
