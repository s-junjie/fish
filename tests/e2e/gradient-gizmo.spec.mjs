import { chromium } from "playwright";
import { pathToFileURL } from "url";
import path from "node:path";

// On-canvas gradient lever, measured in the real editor:
//
//   1. activation — opening a gradient fill row's color panel shows the lever AND
//      steps the transform box aside (no resize/rotate handles); a solid row's
//      panel keeps the normal box; closing the panel hands the box back
//   2. linear   — the two handles are INDEPENDENT endpoints (Figma-style): the
//      first drag materializes `start`/`end` box fractions, `angle` stays synced,
//      stops ride through, one gesture is one undo step
//   3. radial   — the centre dot drags `center`; `rimX` aims (`angle`) and sizes
//      (`rx`) the first axis; `rimY` sizes `ry` only
//   4. angular  — the sweep grip aims the start angle, and it is measured in PX
//      (the sweep is a circle there), not in box fractions like a radial's
//   5. diamond  — `rimX` aims + sizes the first axis and `rimY` sizes the second,
//      both in px, because the quadrants are rotated in px
//   6. export   — the engine's own SVG export carries the new geometry
//
// Every expected value is derived from the DOM's own boxes (the element box
// gives {zoom, pan}), so the spec does not assume a default view.
const html = path.resolve(process.cwd(), process.argv[2] ?? "dist/index.html");

const W = 200;
const H = 160;

const ELEMENTS = [
  {
    id: "gg_lin",
    type: "rect",
    name: "Linear",
    x: 60,
    y: 80,
    width: W,
    height: H,
    fills: [
      {
        type: "linear-gradient",
        from: "#000000",
        to: "#FFFFFF",
        angle: 90,
        stops: [
          { color: "#000000", offset: 0 },
          { color: "#FFFFFF", offset: 1 }
        ]
      }
    ]
  },
  {
    id: "gg_rad",
    type: "rect",
    name: "Radial",
    x: 360,
    y: 80,
    width: W,
    height: H,
    fills: [
      {
        type: "radial-gradient",
        from: "#000000",
        to: "#FFFFFF",
        center: { x: 0.2, y: 0.8 },
        radius: 0.4,
        stops: [
          { color: "#000000", offset: 0 },
          { color: "#FFFFFF", offset: 1 }
        ]
      }
    ]
  },
  {
    id: "gg_sol",
    type: "rect",
    name: "Solid",
    x: 660,
    y: 80,
    width: W,
    height: H,
    fills: [{ type: "solid", color: "#30A46C" }]
  },
  {
    id: "gg_ang",
    type: "rect",
    name: "Angular",
    x: 60,
    y: 320,
    width: W,
    height: H,
    fills: [
      {
        type: "angular-gradient",
        from: "#000000",
        to: "#FFFFFF",
        center: { x: 0.5, y: 0.5 },
        stops: [
          { color: "#000000", offset: 0 },
          { color: "#FFFFFF", offset: 1 }
        ]
      }
    ]
  },
  {
    id: "gg_dia",
    type: "rect",
    name: "Diamond",
    x: 360,
    y: 320,
    width: W,
    height: H,
    fills: [
      {
        type: "diamond-gradient",
        from: "#000000",
        to: "#FFFFFF",
        center: { x: 0.5, y: 0.5 },
        radius: 0.5,
        stops: [
          { color: "#000000", offset: 0 },
          { color: "#FFFFFF", offset: 1 }
        ]
      }
    ]
  }
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
  bridge.setElements(JSON.parse(JSON.stringify(elements)), { canvas: { ...base.canvas, width: 1920, height: 1080 } });
}, ELEMENTS);
await page.waitForTimeout(600);

const liveDoc = () => page.evaluate(() => JSON.parse(JSON.stringify(window.__FISH_BRIDGE__.getDoc())));
const topFill = async (id) => {
  const doc = await liveDoc();
  const walk = (list) => {
    for (const el of list) {
      if (el.id === id) return el;
      if (el.children) {
        const hit = walk(el.children);
        if (hit) return hit;
      }
    }
    return null;
  };
  const el = walk(doc.pages.find((p) => p.id === doc.activePageId).children);
  return el ? el.fills[el.fills.length - 1] : null;
};
const boxOf = (sel) =>
  page.evaluate((q) => {
    const n = document.querySelector(q);
    if (!n) return null;
    const b = n.getBoundingClientRect();
    return { left: b.left, top: b.top, right: b.right, bottom: b.bottom, width: b.width, height: b.height };
  }, sel);
const select = async (id) => {
  await page.evaluate((elId) => window.__FISH_BRIDGE__.selectElement(elId), id);
  await page.waitForTimeout(300);
};
/** Selecting is not enough: the lever exists only while the fill row's panel is open. */
const openFillPanel = async (id, row = 0) => {
  await select(id);
  await page.click(`[data-paint-swatch="${row}"]`);
  await page.waitForTimeout(300);
};
/** The panel has no close button — Escape is how it goes away. */
const closePanel = async () => {
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
};
const dragBy = async (sel, dx, dy) => {
  const hb = await boxOf(sel);
  if (!hb) return false;
  const x = Math.round(hb.left + hb.width / 2);
  const y = Math.round(hb.top + hb.height / 2);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx / 2, y + dy / 2, { steps: 5 });
  await page.mouse.move(x + dx, y + dy, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(350);
  return true;
};
const handleCount = (sel) =>
  page.evaluate((q) => document.querySelectorAll(q).length, sel);
const exportSvg = () =>
  page.evaluate(() => Promise.resolve(window.__fish.exportCanvasSvg?.() ?? ""));

/** `{zoom, pan}` read off the element's own painted box (elements sit at fixed world x/y). */
const viewOf = async (id, worldX, worldY = 80) => {
  const b = await boxOf(`[data-element-id="${id}"]`);
  const zoom = b.width / W;
  return { zoom, panX: b.left - worldX * zoom, panY: b.top - worldY * zoom };
};
const worldOf = async (sel, id, worldX, worldY = 80) => {
  const hb = await boxOf(sel);
  const { zoom, panX, panY } = await viewOf(id, worldX, worldY);
  return {
    x: (hb.left + hb.width / 2 - panX) / zoom,
    y: (hb.top + hb.height / 2 - panY) / zoom,
    zoom
  };
};
const round4 = (n) => Math.round(n * 10000) / 10000;

// ---- 1. activation ------------------------------------------------------------
await openFillPanel("gg_lin");
check(
  "opening a gradient row shows the lever with both ends",
  (await handleCount('[data-gradient-gizmo="linear"] [data-gradient-handle]')) === 2
);
check(
  "and the transform box stands aside: no resize or rotate handles",
  (await handleCount("[data-resize-handle]")) === 0 && (await handleCount("[data-rotate-handle]")) === 0
);

await closePanel();
check(
  "closing the panel hands the box back",
  (await handleCount("[data-gradient-gizmo]")) === 0 && (await handleCount("[data-resize-handle]")) > 0
);

await openFillPanel("gg_sol");
check(
  "a solid row's panel activates no lever and keeps the box",
  (await handleCount("[data-gradient-gizmo]")) === 0 && (await handleCount("[data-resize-handle]")) > 0
);
await closePanel();

await openFillPanel("gg_rad");
check(
  "a radial row shows centre + two rim handles over the sampled ellipse",
  (await handleCount('[data-gradient-gizmo="radial"] [data-gradient-handle]')) === 3 &&
    (await page.evaluate(() => !!document.querySelector('[data-gradient-gizmo="radial"] path')))
);

// ---- 2. linear: the END handle moves independently -----------------------------
await openFillPanel("gg_lin");
const LIN_X = 60;
const end0 = await worldOf('[data-gradient-handle="end"]', "gg_lin", LIN_X);
check("the end handle sits where angle 90 puts it", Math.abs(end0.x - (LIN_X + W)) < 1 && Math.abs(end0.y - (80 + H / 2)) < 1, JSON.stringify(end0));

const DX = 60;
const DY = 40;
check("end drag opens", await dragBy('[data-gradient-handle="end"]', DX, DY));
{
  const paint = await topFill("gg_lin");
  const exEnd = { x: round4((end0.x + DX / end0.zoom - LIN_X) / W), y: round4((end0.y + DY / end0.zoom - 80) / H) };
  check(
    "end drag materializes the endpoint where the pointer landed",
    paint && paint.end && Math.abs(paint.end.x - exEnd.x) < 0.001 && Math.abs(paint.end.y - exEnd.y) < 0.001,
    `end=${paint && JSON.stringify(paint.end)} expected=${JSON.stringify(exEnd)}`
  );
  check(
    "and the start end stays put",
    paint && paint.start && paint.start.x === 0 && paint.start.y === 0.5,
    paint && JSON.stringify(paint.start)
  );
  // The endpoints are normalized per AXIS, so the angle only exists in user space:
  // taking `atan2` of the normalized deltas measures a square that this box is not.
  const expectedAngle = Math.round(
    (((Math.atan2(exEnd.x * W, -(exEnd.y - 0.5) * H) * 180) / Math.PI + 360) % 360) % 360
  );
  check(
    "angle rides along, derived from the new axis",
    paint && Math.abs(paint.angle - expectedAngle) <= 1,
    `angle=${paint && paint.angle} expected=${expectedAngle}`
  );
  check(
    "and the stops ride through untouched",
    paint && paint.stops.length === 2 && paint.stops[0].color === "#000000" && paint.stops[1].color === "#FFFFFF",
    paint && JSON.stringify(paint.stops)
  );
  check(
    "dragging the lever keeps the panel open",
    (await page.evaluate(() => !!document.querySelector("[data-color-panel]")))
  );
  const svg = await exportSvg();
  check(
    "the exported SVG carries the off-axis endpoint",
    svg.includes(`x2="${Math.round(exEnd.x * 10000) / 100}%"`),
    `searched x2="${Math.round(exEnd.x * 10000) / 100}%"`
  );
}

await page.evaluate(() => window.__FISH_BRIDGE__.undo());
{
  const paint = await topFill("gg_lin");
  check(
    "one gesture is one undo step: back to the symmetric angle form",
    paint && paint.angle === 90 && !paint.start && !paint.end,
    `angle=${paint && paint.angle} start=${paint && JSON.stringify(paint.start)}`
  );
}

// ---- 3. linear: the START handle moves too -------------------------------------
const start0 = await worldOf('[data-gradient-handle="start"]', "gg_lin", LIN_X);
check("start drag opens", await dragBy('[data-gradient-handle="start"]', DX, DY));
{
  const paint = await topFill("gg_lin");
  const exStart = { x: round4((start0.x + DX / start0.zoom - LIN_X) / W), y: round4((start0.y + DY / start0.zoom - 80) / H) };
  check(
    "start drag moves only the start point",
    paint && paint.start && Math.abs(paint.start.x - exStart.x) < 0.001 && Math.abs(paint.start.y - exStart.y) < 0.001 &&
      paint.end && paint.end.x === 1 && paint.end.y === 0.5,
    `start=${paint && JSON.stringify(paint.start)}`
  );
}
await page.evaluate(() => window.__FISH_BRIDGE__.undo());

// ---- 4. radial: the centre dot drags center ------------------------------------
await openFillPanel("gg_rad");
const RAD_X = 360;
const c0 = await worldOf('[data-gradient-handle="center"]', "gg_rad", RAD_X);
const CDX = 50;
const CDY = -30;
check("centre drag opens", await dragBy('[data-gradient-handle="center"]', CDX, CDY));
{
  const paint = await topFill("gg_rad");
  const exX = round4(Math.max(0, Math.min(1, (0.2 * W + CDX / c0.zoom) / W)));
  const exY = round4(Math.max(0, Math.min(1, (0.8 * H + CDY / c0.zoom) / H)));
  check(
    "centre drag moves the centre, clamped to the box",
    paint && Math.abs(paint.center.x - exX) < 0.01 && Math.abs(paint.center.y - exY) < 0.01,
    `center=${paint && JSON.stringify(paint.center)} expected=[${exX},${exY}]`
  );
}

// ---- 5. radial: rimX aims (angle) and sizes (rx) the first axis -----------------
const before = await topFill("gg_rad");
const rimX0 = await worldOf('[data-gradient-handle="rimX"]', "gg_rad", RAD_X);
const RDX = -20;
const RDY = -30;
check("rimX drag opens", await dragBy('[data-gradient-handle="rimX"]', RDX, RDY));
{
  const paint = await topFill("gg_rad");
  const dfx = (rimX0.x + RDX / rimX0.zoom - (RAD_X + before.center.x * W)) / W;
  const dfy = (rimX0.y + RDY / rimX0.zoom - (80 + before.center.y * H)) / H;
  const expectedAngle = Math.round(((Math.atan2(dfy, dfx) * 180) / Math.PI + 360) % 360) % 360;
  const expectedRx = round4(Math.hypot(dfx, dfy));
  check(
    "rimX drag aims the axis and sizes rx",
    paint && Math.abs(paint.angle - expectedAngle) <= 2 && Math.abs(paint.rx - expectedRx) < 0.01,
    `angle=${paint && paint.angle}/${expectedAngle} rx=${paint && paint.rx}/${expectedRx}`
  );
  const svg = await exportSvg();
  check(
    "the exported SVG rotates the radial via gradientTransform",
    svg.includes("gradientTransform")
  );
}

// ---- 6. radial: rimY sizes ry without touching the angle ------------------------
const mid = await topFill("gg_rad");
const rimY0 = await worldOf('[data-gradient-handle="rimY"]', "gg_rad", RAD_X);
check("rimY drag opens", await dragBy('[data-gradient-handle="rimY"]', 0, 40));
{
  const paint = await topFill("gg_rad");
  const a = (mid.angle * Math.PI) / 180;
  const fx = (rimY0.x - (RAD_X + mid.center.x * W)) / W;
  const fy = (rimY0.y + 50 - (80 + mid.center.y * H)) / H;
  const expectedRy = round4(Math.max(0, fx * -Math.sin(a) + fy * Math.cos(a)));
  check(
    "rimY drag sizes the second axis",
    paint && Math.abs(paint.ry - expectedRy) < 0.02,
    `ry=${paint && paint.ry}/${expectedRy}`
  );
  check(
    "and leaves the first axis alone",
    paint && Math.abs(paint.angle - mid.angle) <= 1 && Math.abs(paint.rx - mid.rx) < 0.001,
    `angle=${paint && paint.angle}/${mid.angle} rx=${paint && paint.rx}/${mid.rx}`
  );
}

// ---- 7. angular: the sweep grip aims where a turn starts -----------------------
//
// The sweep is a true circle in PX (`dirFromTop`), so every angle here is
// derived in px. The fraction-space value is computed alongside it on purpose:
// on this 200×160 box the two differ, which is what makes the assertion able to
// tell a correct implementation from the radial's fraction-space formula.
const ANG_X = 60;
const ANG_Y = 320;
const ANG_CX = ANG_X + W / 2;
const ANG_CY = ANG_Y + H / 2;

await openFillPanel("gg_ang");
check(
  "an angular row shows the centre dot and the sweep grip",
  (await handleCount('[data-gradient-gizmo="angular"] [data-gradient-handle]')) === 2,
  `handles=${await handleCount('[data-gradient-gizmo="angular"] [data-gradient-handle]')}`
);
const sweep0 = await worldOf('[data-gradient-handle="sweep"]', "gg_ang", ANG_X, ANG_Y);
check(
  "and angle 0 puts the sweep grip straight above the centre",
  Math.abs(sweep0.x - ANG_CX) < 1 && sweep0.y < ANG_CY - 10,
  JSON.stringify(sweep0)
);

const SDX = 50;
const SDY = 38;
check("sweep drag opens", await dragBy('[data-gradient-handle="sweep"]', SDX, SDY));
{
  const paint = await topFill("gg_ang");
  const px = { x: sweep0.x + SDX / sweep0.zoom - ANG_CX, y: sweep0.y + SDY / sweep0.zoom - ANG_CY };
  const pxAngle = Math.round(((Math.atan2(px.x, -px.y) * 180) / Math.PI + 360) % 360) % 360;
  const fracAngle = Math.round(((Math.atan2(px.x / W, -px.y / H) * 180) / Math.PI + 360) % 360) % 360;
  check(
    "sweep drag writes the start angle, in px",
    paint && Math.abs(paint.angle - pxAngle) <= 1,
    `angle=${paint && paint.angle} px=${pxAngle} frac=${fracAngle}`
  );
  check(
    "and the px and fraction answers really differ here, so the check has teeth",
    Math.abs(pxAngle - fracAngle) > 3,
    `px=${pxAngle} frac=${fracAngle}`
  );
  check(
    "the drag leaves the centre alone",
    paint && paint.center && Math.abs(paint.center.x - 0.5) < 0.01 && Math.abs(paint.center.y - 0.5) < 0.01,
    paint && JSON.stringify(paint.center)
  );
}
await page.evaluate(() => window.__FISH_BRIDGE__.undo());

// ---- 8. diamond: the two axis grips size and aim it ----------------------------
const DIA_X = 360;
const DIA_Y = 320;
const DIA_CX = DIA_X + W / 2;
const DIA_CY = DIA_Y + H / 2;

await openFillPanel("gg_dia");
check(
  "a diamond row shows centre + one grip per axis",
  (await handleCount('[data-gradient-gizmo="diamond"] [data-gradient-handle]')) === 3
);
check(
  "over a dashed outline of the diamond itself",
  await page.evaluate(() => {
    const p = document.querySelector('[data-gradient-gizmo="diamond"] path');
    return !!p && (p.getAttribute("stroke-dasharray") || "").length > 0;
  })
);
const dia0 = await worldOf('[data-gradient-handle="rimX"]', "gg_dia", DIA_X, DIA_Y);
check(
  "radius 0.5 / angle 0 puts the first grip on the box's right edge",
  Math.abs(dia0.x - (DIA_X + W)) < 1 && Math.abs(dia0.y - DIA_CY) < 1,
  JSON.stringify(dia0)
);

// Aim and size in one drag, the way a radial's first axis works — but the
// answer is px, because the quadrants are rotated with `rotate(φ, c)` in px.
const DDX = -18;
const DDY = -34;
check("diamond rimX drag opens", await dragBy('[data-gradient-handle="rimX"]', DDX, DDY));
{
  const paint = await topFill("gg_dia");
  const gx = dia0.x + DDX / dia0.zoom - DIA_CX;
  const gy = dia0.y + DDY / dia0.zoom - DIA_CY;
  const expectedAngle = Math.round(((Math.atan2(gy, gx) * 180) / Math.PI + 360) % 360) % 360;
  const expectedRx = round4(Math.hypot(gx, gy) / W);
  check(
    "rimX aims the axis and sizes rx",
    paint && Math.abs(paint.angle - expectedAngle) <= 1 && Math.abs(paint.rx - expectedRx) < 0.01,
    `angle=${paint && paint.angle}/${expectedAngle} rx=${paint && paint.rx}/${expectedRx}`
  );
}

// ---- 9. diamond: rimY sizes the second axis, in px -----------------------------
const midDia = await topFill("gg_dia");
const diaY0 = await worldOf('[data-gradient-handle="rimY"]', "gg_dia", DIA_X, DIA_Y);
const DDY2 = 50;
check("diamond rimY drag opens", await dragBy('[data-gradient-handle="rimY"]', 0, DDY2));
{
  const paint = await topFill("gg_dia");
  const a = (midDia.angle * Math.PI) / 180;
  const gx = diaY0.x - DIA_CX;
  const gy = diaY0.y + DDY2 / diaY0.zoom - DIA_CY;
  const expectedRy = round4(Math.max(0, (gx * -Math.sin(a) + gy * Math.cos(a)) / H));
  check(
    "rimY sizes the second axis from the px projection",
    paint && Math.abs(paint.ry - expectedRy) < 0.02,
    `ry=${paint && paint.ry}/${expectedRy}`
  );
  check(
    "and leaves the aimed first axis alone",
    paint && Math.abs(paint.angle - midDia.angle) <= 1 && Math.abs(paint.rx - midDia.rx) < 0.001,
    `angle=${paint && paint.angle}/${midDia.angle} rx=${paint && paint.rx}/${midDia.rx}`
  );
  const svg = await exportSvg();
  check("the exported SVG carries the diamond's own geometry", svg.includes("pattern"));
}

await browser.close();
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed === 0 && errors.length === 0 ? 0 : 1);
