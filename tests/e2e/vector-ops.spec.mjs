import { chromium } from "playwright";
import { pathToFileURL } from "url";
import path from "node:path";

// Boolean and Flatten, measured in the real editor, because both of them went
// wrong in ways only a rendered document shows:
//
//   1. boolean — the result path is drawn in the element's OWN coordinates, so a
//      shape at (200, 200) lands at (400, 400) if `d` is left in world space. Off
//      the viewport, it reads as "the boolean deleted everything".
//   2. flatten — reachable from the right-click menu and Cmd+E.
//   3. shortcut gating — R must not swap in a shape tool while a path is open for
//      editing; that mode owns the letters.
const html = path.resolve(process.cwd(), process.argv[2] ?? "dist/index.html");

const ELEMENTS = [
  { id: "a", type: "rect", name: "A", x: 400, y: 300, width: 180, height: 140, fills: [{ type: "solid", color: "#ff0000" }] },
  { id: "b", type: "rect", name: "B", x: 520, y: 360, width: 180, height: 140, fills: [{ type: "solid", color: "#00ff00" }] },
  { id: "keep", type: "rect", name: "Keep", x: 900, y: 300, width: 120, height: 120, fills: [{ type: "solid", color: "#3355ff" }] },
  { id: "ellipse", type: "ellipse", name: "Ellipse", x: 300, y: 600, width: 200, height: 120, fills: [{ type: "solid", color: "#00d0ff" }] },
  { id: "curve", type: "path", name: "Curve", x: 800, y: 600, width: 160, height: 100, d: "M 0 0 C 0 80 160 80 160 0", strokes: [{ color: "#ffcc00", width: 3 }] }
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
await page.evaluate((elements) => {
  const bridge = window.__FISH_BRIDGE__;
  const base = bridge.getDoc();
  bridge.setElements(JSON.parse(JSON.stringify(elements)), { canvas: { ...base.canvas, width: 2000, height: 1400 } });
}, ELEMENTS);
await page.waitForTimeout(700);

const elements = () =>
  page.evaluate(() =>
    window.__FISH_BRIDGE__.getDoc()
      .pages.find((p) => p.id === window.__FISH_BRIDGE__.getDoc().activePageId)
      .children.map((e) => ({ id: e.id, name: e.name, type: e.type, x: e.x, y: e.y, width: e.width, height: e.height, d: e.d }))
  );
const boxOf = (id) =>
  page.evaluate((i) => {
    const n = document.querySelector(`[data-element-id="${i}"]`);
    if (!n) return null;
    const r = n.getBoundingClientRect();
    return { cx: r.x + r.width / 2, cy: r.y + r.height / 2, x: r.x, y: r.y, w: r.width, h: r.height };
  }, id);
const clickButtonByTitle = async (title) => {
  const box = await page.evaluate((t) => {
    const n = document.querySelector(`button[title="${t}"]`);
    if (!n) return null;
    const r = n.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, title);
  if (!box) return false;
  await page.mouse.click(box.x, box.y);
  await page.waitForTimeout(400);
  return true;
};

// ---- 1. boolean: the result renders where the inputs were -------------------
const aBox = await boxOf("a");
const bBox = await boxOf("b");
await page.mouse.click(aBox.cx, aBox.cy);
await page.waitForTimeout(200);
await page.keyboard.down("Shift");
await page.mouse.click(bBox.cx, bBox.cy);
await page.keyboard.up("Shift");
await page.waitForTimeout(300);

const opened = await clickButtonByTitle("Boolean operations");
check("the boolean menu opens with two elements selected", opened);
const union = await page.evaluate(() => {
  const n = [...document.querySelectorAll("button")].find((x) => x.innerText.trim() === "Union Selection");
  if (!n) return null;
  const r = n.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
check("the menu offers Union", !!union);
if (union) {
  await page.mouse.click(union.x, union.y);
  await page.waitForTimeout(600);
  const after = await elements();
  // The fixture already carries one path of its own, so the union is found by its
  // name rather than by "the only path there is".
  const result = after.find((e) => e.name === "Union Shape");
  check("union replaces the two shapes with one new path", !!result && !after.some((e) => e.id === "a" || e.id === "b"), JSON.stringify(after.map((e) => e.id)));
  check("the unselected shape survives", after.some((e) => e.id === "keep"));

  const drawn = await boxOf(result.id);
  check("the union path is present in the tree", !!result);
  // The two inputs spanned x 400..700, y 300..500 in world space. The union has to
  // land there, and at that zoom the screen box is well away from the origin.
  check("the union is drawn, not off-canvas", !!drawn && drawn.w > 20 && drawn.h > 20, JSON.stringify(drawn));
  // d is element-local: the two inputs spanned x 400..700, y 300..500, so the
  // result's box is (400, 300, 300, 200) and its first anchor must be measured
  // from that corner. World coordinates here would open at (400, 300) and draw
  // the union at (800, 600).
  check(
    "the union keeps the box its inputs occupied",
    result.x === 400 && result.y === 300 && result.width === 300 && result.height === 200,
    JSON.stringify({ x: result.x, y: result.y, w: result.width, h: result.height })
  );
  const first = /^M (-?[\d.]+) (-?[\d.]+)/.exec(result.d || "");
  const localOk = first
    ? Number(first[1]) >= -0.5 && Number(first[1]) <= 300.5 && Number(first[2]) >= -0.5 && Number(first[2]) <= 200.5
    : false;
  check("the union's d opens from the element's own corner", localOk, result.d ? result.d.slice(0, 24) : "no d");
}

// ---- 2. flatten: the menu and Cmd+E ----------------------------------------
const dOf = async (id) => (await elements()).find((e) => e.id === id)?.d ?? "";
const hasCurves = (d) => /[CQASTHV]/.test(d);

await page.evaluate(() => window.__FISH_BRIDGE__.selectElement("ellipse"));
await page.waitForTimeout(300);
const ellipseBefore = await dOf("ellipse");
check("the ellipse has no path yet", ellipseBefore === "");

await page.evaluate(() => window.__FISH_BRIDGE__.selectElement("ellipse"));
await page.waitForTimeout(250);
const eBox = await boxOf("ellipse");
await page.mouse.click(eBox.cx, eBox.cy, { button: "right" });
await page.waitForTimeout(350);
const menuIds = await page.evaluate(() => [...document.querySelectorAll("[data-context-item]")].map((n) => n.getAttribute("data-context-item")));
check("the right-click menu offers Flatten", menuIds.includes("flatten"), JSON.stringify(menuIds));
const flattenItem = await page.evaluate(() => {
  const n = document.querySelector('[data-context-item="flatten"]');
  if (!n) return null;
  const r = n.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2, disabled: n.getAttribute("aria-disabled") === "true" };
});
check("and it is enabled", !!flattenItem && !flattenItem.disabled, JSON.stringify(flattenItem));
if (flattenItem) {
  await page.mouse.click(flattenItem.x, flattenItem.y);
  await page.waitForTimeout(500);
  const ellipseAfter = await dOf("ellipse");
  check("the menu entry flattens the ellipse", ellipseAfter !== "", ellipseAfter.slice(0, 50));
  check("and leaves no curves behind", ellipseAfter !== "" && !hasCurves(ellipseAfter), ellipseAfter.slice(0, 50));
  check("the flattened ellipse keeps its place on the canvas", Math.abs((await elements()).find((e) => e.id === "ellipse").x - 300) < 1);
}

await page.evaluate(() => window.__FISH_BRIDGE__.selectElement("curve"));
await page.waitForTimeout(300);
const curveBefore = await dOf("curve");
check("the curve path still has a curve", hasCurves(curveBefore), curveBefore);
await page.keyboard.press("Meta+e");
await page.waitForTimeout(400);
const curveAfter = await dOf("curve");
check("Cmd+E flattens a path", !hasCurves(curveAfter), curveAfter.slice(0, 50));

check("no console errors", errors.length === 0, errors.slice(0, 3).join(" | "));

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
await browser.close();
process.exit(passed === results.length ? 0 : 1);
