import { chromium } from "playwright";
import { pathToFileURL } from "url";
import path from "path";

// Reproduces the reported bug end-to-end: an auto-layout frame holding a nested
// frame. Dragging either the nested frame or a sibling must never let the nested
// frame's children drift out of it.
const html = path.resolve(process.cwd(), process.argv[2] ?? "dist/index.html");
const results = [];
const check = (name, ok, detail) => results.push({ name, ok: !!ok, detail });
const checkNear = (name, actual, expected, tol = 1.5) =>
  check(name, typeof actual === "number" && Math.abs(actual - expected) <= tol, `got ${actual}, want ${expected}`);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});

await page.goto(pathToFileURL(html).href);
await page.waitForFunction(() => !!window.__FISH_BRIDGE__);

const seed = () =>
  page.evaluate(() => {
    const bridge = window.__FISH_BRIDGE__;
    const base = bridge.getDoc();
    bridge.setElements([
        {
          id: "P",
          type: "frame",
          name: "P",
          x: 100,
          y: 100,
          width: 600,
          height: 200,
          fills: [{ type: "solid", color: "#1F2937" }],
          display: "flex",
          "flex-direction": "row",
          gap: 20,
          padding: 20,
          "justify-content": "flex-start",
          "align-items": "flex-start",
          children: [
            {
              id: "F",
              type: "frame",
              name: "F",
              x: 20,
              y: 20,
              width: 480,
              height: 100,
              sizing: { width: "fill", height: "fixed" },
              fills: [{ type: "solid", color: "#374151" }],
              display: "flex",
              "flex-direction": "column",
              gap: 8,
              padding: 10,
              "justify-content": "flex-start",
              "align-items": "center",
              children: [
                { id: "g1", type: "rect", name: "g1", x: 220, y: 10, width: 40, height: 20, fills: [{ type: "solid", color: "#3B82F6" }] }
              ]
            },
            { id: "R", type: "rect", name: "R", x: 520, y: 20, width: 60, height: 60, fills: [{ type: "solid", color: "#EF4444" }] }
          ]
        }
      ], { canvas: { ...base.canvas, width: 4000, height: 3000 } });
  });

const setupViewport = async () => {
  const s = await page.evaluate(() => {
    const svg = document.querySelector("svg.pointer-events-auto");
    const box = svg.parentElement.getBoundingClientRect();
    const m = /translate\((-?[\d.]+), (-?[\d.]+)\) scale\(([\d.]+)\)/.exec((() => { const s = document.querySelector("[data-stage-transform]"); const a = s && s.getAttribute("transform"); if (a) return a; const svg = s && s.ownerSVGElement; const t = svg ? getComputedStyle(svg).transform : ""; const m = /matrix\(([\d.eE+-]+), 0, 0, ([\d.eE+-]+), ([\d.eE+-]+), ([\d.eE+-]+)\)/.exec(t); return m ? "translate(" + m[3] + ", " + m[4] + ") scale(" + m[1] + ")" : null; })());
    return {
      pan: { x: parseFloat(m[1]), y: parseFloat(m[2]) },
      zoom: parseFloat(m[3]),
      rect: { left: box.left, top: box.top }
    };
  });
  const toScreen = (wx, wy) => ({
    x: s.rect.left + s.pan.x + wx * s.zoom,
    y: s.rect.top + s.pan.y + wy * s.zoom
  });
  return toScreen;
};

const settle = () =>
  page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
const getEl = (id) => page.evaluate((elId) => window.__FISH_BRIDGE__.getElements().find((e) => e.id === "P").children.find((c) => c.id === elId), id);
const getNested = (id) => page.evaluate((elId) => {
  const p = window.__FISH_BRIDGE__.getElements().find((e) => e.id === "P");
  const f = p.children.find((c) => c.id === "F");
  return f.children.find((c) => c.id === elId);
}, id);
const getParent = () => page.evaluate(() => {
  const p = window.__FISH_BRIDGE__.getElements().find((e) => e.id === "P");
  return { ...p, children: p.children.map((c) => ({ id: c.id, x: c.x, y: c.y, width: c.width, height: c.height })) };
});
const inside = (outer, inner) =>
  inner.x >= outer.x - 0.5 &&
  inner.y >= outer.y - 0.5 &&
  inner.x + inner.width <= outer.x + outer.width + 0.5 &&
  inner.y + inner.height <= outer.y + outer.height + 0.5;
// A child's coordinates live in its PARENT's space, so "inside" compares the
// child's box against the parent's SIZE, never against the parent's own x/y.
const insideLocal = (outer, inner) => inside({ x: 0, y: 0, width: outer.width, height: outer.height }, inner);

const dragWorld = async (toScreen, fromW, toW, steps = 20) => {
  const from = toScreen(fromW.x, fromW.y);
  const to = toScreen(toW.x, toW.y);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps);
  }
  await page.mouse.up();
  await settle();
};

// ---------------------------------------------------------------- scenario 1
await seed();
await settle();
let toScreen = await setupViewport();

let F = await getEl("F");
let g1 = await getNested("g1");
check("seed: nested frame sits in its flow slot at 20,20 480x100", F.x === 20 && F.y === 20 && F.width === 480 && F.height === 100, JSON.stringify(F));
checkNear("seed: grandchild centred inside it", g1.x, (F.width - g1.width) / 2);

await page.evaluate(() => window.__FISH_BRIDGE__.selectElement("F"));
await settle();
// Drag the nested frame itself, grabbing empty space inside it (not the grandchild).
// The delta is large enough that an un-cascaded grandchild would land outside the
// frame once the parent's flow snaps the frame back.
await dragWorld(toScreen, { x: 150, y: 190 }, { x: 450, y: 230 });

F = await getEl("F");
g1 = await getNested("g1");
check("dragging the nested frame snaps it back into the parent's flow", F.x === 20 && F.y === 20, JSON.stringify(F));
check("the grandchild did not escape the nested frame", insideLocal(F, g1), `F=${JSON.stringify(F)} g1=${JSON.stringify(g1)}`);
checkNear("the grandchild re-centred against the frame", g1.x, (F.width - g1.width) / 2);

// ---------------------------------------------------------------- scenario 2
await page.reload();
await page.waitForFunction(() => !!window.__FISH_BRIDGE__);
await seed();
await settle();
toScreen = await setupViewport();

await page.evaluate(() => window.__FISH_BRIDGE__.selectElement("R"));
await settle();
// Drag the sibling out of the parent frame: the nested `fill` frame must grow,
// and its own layout has to run again so the grandchild re-centres.
await dragWorld(toScreen, { x: 650, y: 150 }, { x: 650, y: 620 }, 24);

const parent = await getParent();
check("the sibling was reparented out of the frame", parent.children.map((c) => c.id).join(",") === "F", parent.children.map((c) => c.id).join(","));

F = await getEl("F");
g1 = await getNested("g1");
checkNear("the nested fill frame grew to the full content width", F.width, 560, 2);
check("the grandchild is still inside the nested frame", insideLocal(F, g1), `F=${JSON.stringify(F)} g1=${JSON.stringify(g1)}`);
checkNear("the grandchild re-centred against the new width", g1.x, (F.width - g1.width) / 2, 2);

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : `  -> ${r.detail ?? ""}`}`);
}
console.log(`\n${results.length - failed.length}/${results.length} passed`);
console.log("pageErrors", errors.slice(0, 5));

await browser.close();
process.exit(failed.length === 0 && errors.length === 0 ? 0 : 1);
