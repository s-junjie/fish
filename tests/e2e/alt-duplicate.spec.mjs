import { chromium } from "playwright";
import { pathToFileURL } from "url";
import path from "path";

const html = path.resolve(process.cwd(), process.argv[2] ?? "dist/index.html");
const results = [];
const check = (name, actual, expected) => {
  results.push({ name, ok: JSON.stringify(actual) === JSON.stringify(expected), actual, expected });
};
const checkNear = (name, actual, expected, tol = 1) => {
  const ok = typeof actual === "number" && Math.abs(actual - expected) <= tol;
  results.push({ name, ok, actual, expected });
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

const applySetup = () =>
  page.evaluate(() => {
    const bridge = window.__FISH_BRIDGE__;
    const base = bridge.getDoc();
    const rect = (id, x, y, w, h) => ({
      id, type: "rect", name: id, x, y, width: w, height: h,
      fills: [{ type: "solid", color: "#3B82F6" }]
    });
    bridge.setElements([
        rect("alpha", 400, 400, 200, 150),
        {
          id: "stack", type: "frame", name: "stack", x: 900, y: 400, width: 400, height: 200,
          display: "flex",
          "flex-direction": "row",
          gap: 10,
          padding: 10,
          children: [rect("kid1", 10, 10, 60, 60), rect("kid2", 80, 10, 60, 60)]
        },
        { id: "pinned", ...rect("pinned", 400, 900, 200, 150), locked: true }
      ], { canvas: { ...base.canvas, width: 4000, height: 3000 } });
  });

const readView = () =>
  page.evaluate(() => {
    const svg = document.querySelector("svg.pointer-events-auto");
    const box = svg.parentElement.getBoundingClientRect();
    const m = /translate\((-?[\d.]+), (-?[\d.]+)\) scale\(([\d.]+)\)/.exec((() => { const s = document.querySelector("[data-stage-transform]"); const a = s && s.getAttribute("transform"); if (a) return a; const svg = s && s.ownerSVGElement; const t = svg ? getComputedStyle(svg).transform : ""; const m = /matrix\(([\d.eE+-]+), 0, 0, ([\d.eE+-]+), ([\d.eE+-]+), ([\d.eE+-]+)\)/.exec(t); return m ? "translate(" + m[3] + ", " + m[4] + ") scale(" + m[1] + ")" : null; })());
    return {
      pan: { x: parseFloat(m[1]), y: parseFloat(m[2]) },
      zoom: parseFloat(m[3]),
      rect: { left: box.left, top: box.top, width: box.width, height: box.height }
    };
  });
const toScreen = async (wx, wy) => {
  const v = await readView();
  return { x: v.rect.left + v.pan.x + wx * v.zoom, y: v.rect.top + v.pan.y + wy * v.zoom };
};
const getEl = (id) =>
  page.evaluate((elId) => window.__FISH_BRIDGE__.getElements().find((e) => e.id === elId), id);
const getTopLevel = () => page.evaluate(() => window.__FISH_BRIDGE__.getElements().map((e) => e.id));
const elementCount = () => page.evaluate(() => window.__FISH_BRIDGE__.getElements().length);
const selected = () => page.evaluate(() => window.__FISH_BRIDGE__.getSelectedIds());
const settle = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
// Alt/Option held across the whole gesture, the way a real user does it.
const altDrag = async (from, dx, dy) => {
  await page.keyboard.down("Alt");
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(from.x + (dx * i) / 10, from.y + (dy * i) / 10);
  await page.mouse.up();
  await page.keyboard.up("Alt");
  await settle();
};
const drag = async (from, dx, dy) => {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(from.x + (dx * i) / 10, from.y + (dy * i) / 10);
  await page.mouse.up();
  await settle();
};
// The clone an Alt+drag produced, found by "a new sibling of the source".
const cloneOf = (id) =>
  page.evaluate(
    (srcId) => {
      const els = window.__FISH_BRIDGE__.getElements();
      const srcIndex = els.findIndex((e) => e.id === srcId);
      if (srcIndex < 0) return null;
      return els[srcIndex + 1] ?? null;
    },
    id
  );

// 1. Alt+drag on a selected element: the source stays put, a copy travels, and
//    the copy is what ends up selected.
await applySetup();
await page.evaluate(() => window.__FISH_BRIDGE__.selectElement("alpha"));
await settle();
const countBefore = await elementCount();
// The canvas is not at 1:1, so the expected landing spot is derived from the live
// zoom rather than assumed — a hard-coded world offset would pass by luck.
const { zoom } = await readView();
const expectCopyX = 400 + Math.round(160 / zoom);
const expectCopyY = 400 + Math.round(90 / zoom);
await altDrag(await toScreen(500, 475), 160, 90);
check("alt+drag adds exactly one element", await elementCount(), countBefore + 1);
const source = await getEl("alpha");
check("alt+drag leaves the original in place", [source.x, source.y], [400, 400]);
const copy = await cloneOf("alpha");
check("alt+drag inserts the copy next to the original", !!copy && copy.id !== "alpha", true);
check("alt+drag copy keeps the source geometry", copy && [copy.width, copy.height], [200, 150]);
// Tolerance covers snap guides; the point is the copy moved by about the drag.
checkNear("alt+drag copy moved x", copy.x, expectCopyX, 2);
checkNear("alt+drag copy moved y", copy.y, expectCopyY, 2);
check("alt+drag selects the copy, not the original", await selected(), [copy.id]);

// 2. One undo step takes back the whole gesture, copy included.
await page.evaluate(() => window.__FISH_BRIDGE__.undo());
await settle();
check("one undo removes the copy", await elementCount(), countBefore);
const undone = await getEl("alpha");
check("one undo restores the original position", [undone.x, undone.y], [400, 400]);

// 3. Alt+click without movement is a plain select — no stray copy.
// The layer has to start OUT of the selection: on a selected layer Option is the
// subtract gesture (`element-click.ts:312`), which is the next check's subject.
await applySetup();
await page.evaluate(() => window.__FISH_BRIDGE__.selectElement(""));
await settle();
const beforeClick = await elementCount();
await page.keyboard.down("Alt");
await page.mouse.click((await toScreen(500, 475)).x, (await toScreen(500, 475)).y);
await page.keyboard.up("Alt");
await settle();
check("alt+click without movement creates nothing", await elementCount(), beforeClick);
check("alt+click without movement keeps the original", (await getEl("alpha")).x, 400);
check("alt+click without movement still selects the element", await selected(), ["alpha"]);

// The same press on the now-selected layer is the subtract gesture, not a reselect.
await page.keyboard.down("Alt");
await page.mouse.click((await toScreen(500, 475)).x, (await toScreen(500, 475)).y);
await page.keyboard.up("Alt");
await settle();
check("alt+click on a selected layer takes it out of the selection", await selected(), []);

// 4. A plain drag must not duplicate — the modifier is the whole feature.
await applySetup();
await page.evaluate(() => window.__FISH_BRIDGE__.selectElement("alpha"));
await settle();
const beforePlain = await elementCount();
await drag(await toScreen(500, 475), 120, 60);
check("plain drag creates no copy", await elementCount(), beforePlain);
check("plain drag keeps the element selected", await selected(), ["alpha"]);

// 5. A locked layer is not a duplicate source, even when it is the selection.
await applySetup();
await page.evaluate(() => window.__FISH_BRIDGE__.selectElement("pinned"));
await settle();
const beforeLocked = await elementCount();
await altDrag(await toScreen(500, 975), 100, 60);
check("alt+drag on a locked layer creates no copy", await elementCount(), beforeLocked);
const pinned = await getEl("pinned");
check("alt+drag on a locked layer does not move it", [pinned.x, pinned.y], [400, 900]);

// 6. A frame: the whole subtree is copied, and the child ids are all fresh.
await applySetup();
await page.evaluate(() => window.__FISH_BRIDGE__.selectElement("stack"));
await settle();
const beforeFrame = await getTopLevel();
await altDrag(await toScreen(1100, 500), 0, 200);
const afterFrame = await getTopLevel();
check("alt+drag on a frame adds one top-level element", afterFrame.length, beforeFrame.length + 1);
const frameCopy = await cloneOf("stack");
check("alt+drag frame copy is a distinct id", frameCopy && frameCopy.id !== "stack", true);
check("alt+drag frame copy keeps size", frameCopy && [frameCopy.width, frameCopy.height], [400, 200]);
const childIds = (frameCopy?.children ?? []).map((c) => c.id);
check("alt+drag frame copy re-mints child ids", childIds.some((id) => id === "kid1" || id === "kid2"), false);
check("alt+drag frame copy has two children", childIds.length, 2);
check("alt+drag selects the frame copy", await selected(), [frameCopy.id]);
const originalKids = (await getEl("stack")).children.map((c) => c.id);
check("alt+drag leaves the source frame's children alone", originalKids, ["kid1", "kid2"]);

// 7. Duplicating inside an auto-layout parent: the copy takes a stack slot of
//    its own rather than landing on top of its source, and the stack reflows.
await applySetup();
await page.evaluate(() => window.__FISH_BRIDGE__.selectElement("kid1"));
await settle();
await altDrag(await toScreen(1040, 430), 40, 30);
const stack = await getEl("stack");
check("alt+drag into a stack adds a child", stack.children.length, 3);
check("alt+drag into a stack keeps the source in place", stack.children[0].id, "kid1");
// Indexed off the count above, so a missing copy reports as a failed check
// instead of tearing down the whole run.
if (stack.children[2]) {
  check("alt+drag into a stack does not overlap the source", stack.children[2].x === stack.children[0].x, false);
  check("alt+drag into a stack selects the new child", await selected(), [stack.children[2].id]);
}

// 8. No "+" affordance at all. The drag is its own feedback, and a badge riding
//    the pointer announced a gesture the user had not started — while the Alt
//    distance inspector shares the very same key and had to be suppressed
//    underneath it. What the Alt key owes a grab-able layer is silence.
await applySetup();
await page.evaluate(() => window.__FISH_BRIDGE__.selectElement("alpha"));
await settle();
const badgeCount = () => page.locator("[data-duplicate-badge]").count();
const overAlpha = await toScreen(500, 475);
await page.keyboard.down("Alt");
await page.mouse.move(overAlpha.x, overAlpha.y);
await settle();
check("no duplicate badge over a selected layer", await badgeCount(), 0);
check(
  "and the distance inspector stays out of the way there",
  await page.locator("[data-measure-overlay]").count(),
  0
);
// Moving onto unselected canvas: still no badge — there is none to hide.
// The probe samples inside the <svg>'s own client rect — the container is larger
// than the painted canvas, and the properties panel sits on top of its edge.
const emptyPoint = await page.evaluate(() => {
  const r = document.querySelector("svg.pointer-events-auto").getBoundingClientRect();
  for (let fy = 0.15; fy <= 0.9; fy += 0.15) {
    for (let fx = 0.1; fx <= 0.9; fx += 0.1) {
      const x = r.left + r.width * fx;
      const y = r.top + r.height * fy;
      if (document.elementFromPoint(x, y)?.tagName?.toLowerCase() === "svg") return { x, y };
    }
  }
  return null;
});
check("found empty canvas point to hover", emptyPoint !== null, true);
if (emptyPoint) {
  await page.mouse.move(emptyPoint.x, emptyPoint.y);
  await settle();
  check("no duplicate badge over empty canvas either", await badgeCount(), 0);
}
await page.keyboard.up("Alt");
await page.mouse.move(overAlpha.x + 40, overAlpha.y);
await settle();
check("and none after releasing alt", await badgeCount(), 0);

// 9. Alt pressed HALFWAY through a drag arms the copy just like holding it from
//    the mousedown. This is what makes the pre-drag badge unnecessary: the
//    modifier is read on every frame, so it is never too late to change your
//    mind about duplicating.
await applySetup();
await page.evaluate(() => window.__FISH_BRIDGE__.selectElement("alpha"));
await settle();
const beforeLate = await elementCount();
const lateFrom = await toScreen(500, 475);
await page.mouse.move(lateFrom.x, lateFrom.y);
await page.mouse.down();
// First half of the travel with no modifier: a plain move, well past the
// threshold, so the copy is armed mid-gesture and not at the press.
for (let i = 1; i <= 5; i++) await page.mouse.move(lateFrom.x + (160 * i) / 10, lateFrom.y + (90 * i) / 10);
check("a bare first half creates nothing", await elementCount(), beforeLate);
await page.keyboard.down("Alt");
for (let i = 6; i <= 10; i++) await page.mouse.move(lateFrom.x + (160 * i) / 10, lateFrom.y + (90 * i) / 10);
await page.mouse.up();
await page.keyboard.up("Alt");
await settle();
check("alt pressed mid-drag adds exactly one element", await elementCount(), beforeLate + 1);
check("alt pressed mid-drag leaves the original in place", (await getEl("alpha")).x, 400);
const lateCopy = await cloneOf("alpha");
check("alt pressed mid-drag inserts the copy next to the original", !!lateCopy && lateCopy.id !== "alpha", true);
check("alt pressed mid-drag selects the copy", await selected(), [lateCopy?.id]);
checkNear("alt pressed mid-drag copy moved x", lateCopy?.x, 400 + Math.round(160 / zoom), 2);
checkNear("alt pressed mid-drag copy moved y", lateCopy?.y, 400 + Math.round(90 / zoom), 2);

// 10. The duplicate is PROVISIONAL for the whole gesture. Releasing Alt before
//     the mouse takes the copy back, and the original — which the mint had
//     snapped home to its start mark — carries the rest of the drag itself.
await applySetup();
await page.evaluate(() => window.__FISH_BRIDGE__.selectElement("alpha"));
await settle();
const beforeCancel = await elementCount();
const cancelFrom = await toScreen(500, 475);
await page.keyboard.down("Alt");
await page.mouse.move(cancelFrom.x, cancelFrom.y);
await page.mouse.down();
for (let i = 1; i <= 5; i++) await page.mouse.move(cancelFrom.x + (160 * i) / 10, cancelFrom.y + (90 * i) / 10);
await settle();
check("alt held mid-drag shows the copy", await elementCount(), beforeCancel + 1);
// Released WITHOUT moving: the take-back is driven by the key, not the pointer.
await page.keyboard.up("Alt");
await settle();
check("releasing alt mid-drag takes the copy back", await elementCount(), beforeCancel);
check("and the original is what the drag now moves", await selected(), ["alpha"]);
for (let i = 6; i <= 10; i++) await page.mouse.move(cancelFrom.x + (160 * i) / 10, cancelFrom.y + (90 * i) / 10);
await page.mouse.up();
await settle();
check("no copy survives the gesture", await elementCount(), beforeCancel);
checkNear("the original landed where the pointer did", (await getEl("alpha")).x, 400 + Math.round(160 / zoom), 2);

// 11. Press, release, press again inside ONE gesture: each press mints from the
//     sources, each release takes it back, and only the last state lands.
await applySetup();
await page.evaluate(() => window.__FISH_BRIDGE__.selectElement("alpha"));
await settle();
const beforeToggle = await elementCount();
const toggleFrom = await toScreen(500, 475);
await page.mouse.move(toggleFrom.x, toggleFrom.y);
await page.mouse.down();
for (let i = 1; i <= 4; i++) await page.mouse.move(toggleFrom.x + (160 * i) / 10, toggleFrom.y + (90 * i) / 10);
await page.keyboard.down("Alt");
await settle();
check("first press mints a copy", await elementCount(), beforeToggle + 1);
await page.keyboard.up("Alt");
await settle();
check("release takes it back", await elementCount(), beforeToggle);
await page.keyboard.down("Alt");
await settle();
check("a second press mints again", await elementCount(), beforeToggle + 1);
for (let i = 5; i <= 10; i++) await page.mouse.move(toggleFrom.x + (160 * i) / 10, toggleFrom.y + (90 * i) / 10);
await page.mouse.up();
await page.keyboard.up("Alt");
await settle();
check("held at the mouseup, so exactly one copy lands", await elementCount(), beforeToggle + 1);
check("the original is back on its start mark", (await getEl("alpha")).x, 400);

// 12. Releasing Alt and the mouse together still lands as a plain drag: the
//     outcome is read off the mouseup event's own modifier state, so a keyup
//     that loses the race cannot leave a copy behind.
await applySetup();
await page.evaluate(() => window.__FISH_BRIDGE__.selectElement("alpha"));
await settle();
const beforeRace = await elementCount();
const raceFrom = await toScreen(500, 475);
await page.mouse.move(raceFrom.x, raceFrom.y);
await page.mouse.down();
await page.keyboard.down("Alt");
for (let i = 1; i <= 8; i++) await page.mouse.move(raceFrom.x + (160 * i) / 10, raceFrom.y + (90 * i) / 10);
// No settle between the two: the key comes up and the button follows at once.
await page.keyboard.up("Alt");
await page.mouse.up();
await settle();
check("alt released with the mouse leaves no copy", await elementCount(), beforeRace);

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : `  -> ${JSON.stringify(r.actual)} (expected ${JSON.stringify(r.expected)})`}`);
}
console.log(`\n${results.length - failed.length}/${results.length} passed`);
console.log("pageErrors", errors.slice(0, 5));

await browser.close();
process.exit(failed.length === 0 && errors.length === 0 ? 0 : 1);
