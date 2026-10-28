import { chromium } from "playwright";
import { pathToFileURL } from "url";
import path from "path";

// An instance paints a resolved clone of its master, while CanvasDefs emits the
// <defs> by resolving the same instance again. If those two resolutions disagree
// on an id, every gradient / filter / clip / mask the clone references silently
// points at nothing: a gradient fill paints NO shape at all, and a filter or a
// clip-path is ignored. A minted id also changes on every render, which remounts
// the whole subtree.
//
// This drives the real renderer against dist/index.html and reads pixels back.
const html = path.resolve(process.cwd(), process.argv[2] ?? "dist/index.html");
const results = [];
const check = (name, ok, detail) => results.push({ name, ok: !!ok, detail });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});

await page.goto(pathToFileURL(html).href);
await page.waitForFunction(() => !!window.__FISH_BRIDGE__);

const MASTER_X = 100;
const MASTER_Y = 100;
const DX = 500; // instance sits 500px to the right of the master

await page.evaluate(
  ({ MASTER_X, MASTER_Y }) => {
    const bridge = window.__FISH_BRIDGE__;
    const base = bridge.getDoc();
    bridge.setElements([
        {
          id: "master",
          type: "component",
          name: "Card",
          x: MASTER_X,
          y: MASTER_Y,
          width: 300,
          height: 200,
          fills: [{ type: "solid", color: "#1F2937" }],
          clipContent: false,
          display: "flex",
          "flex-direction": "column",
          gap: 8,
          padding: 12,
          children: [
            {
              id: "grad",
              type: "rect",
              name: "grad",
              x: 12,
              y: 12,
              width: 276,
              height: 60,
              fills: [
                {
                  type: "linear-gradient",
                  angle: 90,
                  stops: [
                    { offset: 0, color: "#3B82F6" },
                    { offset: 1, color: "#8B5CF6" }
                  ]
                }
              ]
            },
            {
              id: "shadowed",
              type: "rect",
              name: "shadowed",
              x: 12,
              y: 80,
              width: 276,
              height: 40,
              fills: [{ type: "solid", color: "#10B981" }],
              effects: [
                { type: "drop-shadow", color: "#000000", offset: { x: 0, y: 6 }, blur: 8, enabled: true }
              ]
            },
            {
              id: "clipped",
              type: "frame",
              name: "clipped",
              x: 12,
              y: 128,
              width: 276,
              height: 40,
              clipContent: true,
              fills: [{ type: "solid", color: "#374151" }],
              children: [
                {
                  id: "over",
                  type: "rect",
                  name: "over",
                  x: 0,
                  y: 0,
                  width: 400,
                  height: 40,
                  fills: [{ type: "solid", color: "#F59E0B" }]
                }
              ]
            }
          ]
        },
        {
          id: "inst",
          type: "instance",
          name: "Card Instance",
          componentId: "master",
          x: MASTER_X + 500,
          y: MASTER_Y,
          width: 300,
          height: 200,
          fills: [{
            type: "linear-gradient",
            angle: 0,
            stops: [{ offset: 0, color: "#EF4444" }, { offset: 1, color: "#F59E0B" }]
          }]
        }
      ], { canvas: { ...base.canvas, width: 3000, height: 2000 } });
  },
  { MASTER_X, MASTER_Y }
);

await page.waitForTimeout(600);

// ---- 1. every url(#…) in the document resolves to a real def -----------------
const refAudit = await page.evaluate(() => {
  const svg = document.querySelector("svg.pointer-events-auto");
  const defIds = new Set(Array.from(svg.querySelector("defs").querySelectorAll("[id]")).map((n) => n.id));
  const missing = [];
  for (const node of svg.querySelectorAll("*")) {
    for (const attr of ["fill", "stroke", "clip-path", "filter", "mask"]) {
      const v = node.getAttribute(attr);
      if (v && v.startsWith("url(#")) {
        const id = v.slice(5, -1);
        if (!defIds.has(id)) missing.push({ attr, id });
      }
    }
  }
  return { defCount: defIds.size, missing };
});
check(
  "every url(#…) in the rendered document resolves to a real def",
  refAudit.missing.length === 0,
  `${refAudit.missing.length} missing of ${refAudit.defCount} defs: ${JSON.stringify(refAudit.missing)}`
);

const ownGradient = await page.evaluate(() => {
  const node = document.querySelector('[data-element-id="inst"] path[fill^="url(#grad_fill_"]');
  return node?.getAttribute("fill") || null;
});
check(
  "an instance-owned gradient fill references the instance's own def",
  ownGradient === "url(#grad_fill_inst_0)",
  `paint reference: ${ownGradient}`
);

// ---- 2. the instance paints what the master paints --------------------------
const sample = (points) =>
  page.evaluate(async ({ points, DX }) => {
    const svg = document.querySelector("svg.pointer-events-auto");
    const clone = svg.cloneNode(true);
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    const img = new Image();
    await new Promise((res, rej) => {
      img.onload = res;
      img.onerror = rej;
      img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(new XMLSerializer().serializeToString(clone));
    });
    const canvas = document.createElement("canvas");
    canvas.width = svg.clientWidth || 1600;
    canvas.height = svg.clientHeight || 1000;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const m = /translate\((-?[\d.]+), (-?[\d.]+)\) scale\(([\d.]+)\)/.exec((() => { const s = document.querySelector("[data-stage-transform]"); const a = s && s.getAttribute("transform"); if (a) return a; const svg = s && s.ownerSVGElement; const t = svg ? getComputedStyle(svg).transform : ""; const m = /matrix\(([\d.eE+-]+), 0, 0, ([\d.eE+-]+), ([\d.eE+-]+), ([\d.eE+-]+)\)/.exec(t); return m ? "translate(" + m[3] + ", " + m[4] + ") scale(" + m[1] + ")" : null; })());
    const pan = { x: parseFloat(m[1]), y: parseFloat(m[2]) };
    const zoom = parseFloat(m[3]);
    const at = (wx, wy) => {
      const d = ctx.getImageData(Math.round(pan.x + wx * zoom), Math.round(pan.y + wy * zoom), 1, 1).data;
      return `rgb(${d[0]},${d[1]},${d[2]})`;
    };
    const out = {};
    for (const [name, x, y] of points) {
      out[name] = at(x, y);
      out[`${name}_inst`] = at(x + DX, y);
    }
    return out;
  }, { points, DX });

const px = await sample([
  ["grad", MASTER_X + 150, MASTER_Y + 42],
  ["shadowBand", MASTER_X + 150, MASTER_Y + 124],
  ["clipFrameFill", MASTER_X + 150, MASTER_Y + 148],
  ["clipOverflow", MASTER_X + 316, MASTER_Y + 148],
  ["empty", MASTER_X + 450, MASTER_Y + 250],
  ["background", MASTER_X + 296, MASTER_Y + 190]
]);
console.log("pixels:", JSON.stringify(px, null, 1));

const AMBER = "rgb(245,158,11)";

check(
  "a gradient-filled child inside the instance paints (was invisible)",
  px.grad === px.grad_inst && px.grad !== px.background && px.grad !== px.background_inst,
  `master ${px.grad} vs instance ${px.grad_inst}`
);
check(
  "a drop-shadow inside the instance paints",
  px.shadowBand !== px.background && px.shadowBand_inst !== px.background_inst,
  `master ${px.shadowBand} (bg ${px.background}) vs instance ${px.shadowBand_inst} (bg ${px.background_inst})`
);
check(
  "a clipped nested frame inside the instance still shows its own fill",
  px.clipFrameFill === px.clipFrameFill_inst,
  `master ${px.clipFrameFill} vs instance ${px.clipFrameFill_inst}`
);
check(
  "a clipped nested frame inside the instance still clips its overflowing child",
  px.clipOverflow === px.empty && px.clipOverflow_inst === px.empty_inst && px.clipOverflow_inst !== AMBER,
  `overflow master ${px.clipOverflow} / instance ${px.clipOverflow_inst} vs empty ${px.empty}/${px.empty_inst} (unclipped would be ${AMBER})`
);

// ---- 3. the clone ids survive a re-render -----------------------------------
// Clone ids are the rendered ids that are NOT document elements: the instance
// itself is a real element, everything inside it is resolved at render time.
const cloneIds = () =>
  page.evaluate(() => {
    const known = new Set();
    const walk = (els) => els.forEach((e) => { known.add(e.id); if (e.children) walk(e.children); });
    walk(window.__FISH_BRIDGE__.getElements());
    return Array.from(document.querySelectorAll("svg.pointer-events-auto [data-element-id]"))
      .map((n) => n.getAttribute("data-element-id"))
      .filter((id) => id && !known.has(id));
  });
const before = await cloneIds();
await page.evaluate(() => {
  const bridge = window.__FISH_BRIDGE__;
  const d = bridge.getDoc();
  bridge.applyDoc({ ...d, canvas: { ...d.canvas, background: { type: "solid", color: "#0B0B0B" } } });
});
await page.waitForTimeout(400);
const after = await cloneIds();
check(
  "instance clone ids are stable across an unrelated re-render",
  before.length >= 4 && before.length === after.length && before.every((id) => after.includes(id)),
  `${before.length} before, ${after.length} after, ${before.filter((id) => after.includes(id)).length} stable — ${JSON.stringify(before)}`
);

console.log("\n--- results ---");
for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}\n      ${r.detail}`);
console.log("page errors:", errors.length ? errors : "none");

await browser.close();
process.exit(results.every((r) => r.ok) ? 0 : 1);
