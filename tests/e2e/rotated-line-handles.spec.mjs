import { chromium } from "playwright";
import { pathToFileURL } from "url";
import path from "node:path";

// A rotated LINE's two endpoint dots are the whole selection chrome for a line
// (Figma parity — no box, no rotate corners), so when they are placed in canvas
// space instead of the element's own frame there is nothing left that touches
// the line: the dots sit on the un-rotated endpoints, level with each other,
// while the segment runs diagonally between them.
//
// The probe measures each dot against the RENDERED segment rather than against
// coordinates it recomputes — the handles are in the element's local frame
// inside a rotated group, so only a composed screen position answers "is the
// handle on the line", and recomputing that here would test this file.
const html = path.resolve(process.cwd(), process.argv[2] ?? "dist/index.html");

const results = [];
const check = (name, ok, detail = "") => {
  results.push(!!ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `\n      ${detail}` : ""}`);
};

// `width`/`height` are `|dx|`/`|dy|` on a line and normalize normally writes
// them; the bridge applies a document verbatim, so they are stated here rather
// than left for the builder to fill in.
const LINE = { id: "rl_line", type: "line", name: "Ruler", x: 200, y: 300, dx: 240, dy: 0, width: 240, height: 0 };
const RECT = { id: "rl_rect", type: "rect", name: "Box", x: 700, y: 300, width: 240, height: 140, borderRadius: 24 };
const ROT = 37;

const ELEMENTS = [
  { ...LINE, rotation: ROT, strokes: [{ width: 8, color: "#111111" }] },
  { ...RECT, rotation: ROT, fillEnabled: false, strokes: [{ width: 8, color: "#111111" }] }
];

const settle = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

const select = async (id) => {
  await page.evaluate((elementId) => window.__FISH_BRIDGE__.selectElement(elementId), id);
  await settle();
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
await settle();

await select(LINE.id);

const probe = await page.evaluate(
  ({ lineId }) => {
    // A node's own local point, in screen pixels, through whatever transform
    // chain it is actually mounted under.
    const toScreen = (node, x, y) => {
      const m = node.getScreenCTM();
      return { x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f };
    };
    const group = document.querySelector(`g[data-element-id="${lineId}"]`);
    const painted = [...group.querySelectorAll("line")].find((l) => l.getAttribute("stroke") === "#111111");
    // The endpoint dots are the only circles carrying the crosshair cursor; the
    // panel has other <circle> chrome a bare selector would pick up.
    const dots = [...document.querySelectorAll('circle[style*="crosshair"]')];
    return {
      ends: [toScreen(painted, +painted.getAttribute("x1"), +painted.getAttribute("y1")), toScreen(painted, +painted.getAttribute("x2"), +painted.getAttribute("y2"))],
      dots: dots.map((d) => toScreen(d, +d.getAttribute("cx"), +d.getAttribute("cy")))
    };
  },
  { lineId: LINE.id }
);

const near = (p, q, tol = 1) => Math.abs(p.x - q.x) < tol && Math.abs(p.y - q.y) < tol;
const dist = (p, q) => Math.hypot(p.x - q.x, p.y - q.y);

/** The line's painted endpoints and its two handles, all in screen pixels. */
const painted = () =>
  page.evaluate((lineId) => {
    const toScreen = (node, x, y) => {
      const m = node.getScreenCTM();
      return { x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f };
    };
    const group = document.querySelector(`g[data-element-id="${lineId}"]`);
    const stroke = [...group.querySelectorAll("line")].find((l) => l.getAttribute("stroke") === "#111111");
    const dots = [...document.querySelectorAll('circle[style*="crosshair"]')];
    return {
      start: toScreen(stroke, +stroke.getAttribute("x1"), +stroke.getAttribute("y1")),
      end: toScreen(stroke, +stroke.getAttribute("x2"), +stroke.getAttribute("y2")),
      dot0: toScreen(dots[0], +dots[0].getAttribute("cx"), +dots[0].getAttribute("cy")),
      dot1: toScreen(dots[1], +dots[1].getAttribute("cx"), +dots[1].getAttribute("cy"))
    };
  }, LINE.id);

check("a rotated line shows exactly its two endpoint dots", probe.dots.length === 2, JSON.stringify(probe.dots));
check(
  "each dot is painted on the segment's own end",
  probe.dots.length === 2 && near(probe.dots[0], probe.ends[0]) && near(probe.dots[1], probe.ends[1]),
  `dots ${JSON.stringify(probe.dots)}\n      ends ${JSON.stringify(probe.ends)}`
);
check(
  "and the two are NOT level with each other, which is what the un-rotated box gives",
  probe.dots.length === 2 && Math.abs(probe.dots[0].y - probe.dots[1].y) > 4,
  `y = ${probe.dots.map((d) => Math.round(d.y)).join(", ")}`
);

// --- a shape, whose box must ride the same shared transform ---------------
await select(RECT.id);
const boxTransform = await page.evaluate((rot) => {
  const found = [...document.querySelectorAll("g[transform]")]
    .map((g) => g.getAttribute("transform"))
    .filter((t) => t && t.startsWith(`rotate(${rot} `));
  return found.length > 0 ? found[0] : null;
}, ROT);
check("the shape box carries the same rotation", typeof boxTransform === "string", String(boxTransform));

// --- dragging the END -----------------------------------------------------
// The reported defect. `dx`/`dy` live in the element's own frame and, under a
// box-centre pivot, that frame is re-based by the very `dx` the drag changes —
// so writing the far end swung the near one as well. Pivoting a line on its
// ORIGIN removes the coupling: `x`/`y` cannot move, so the start endpoint is
// pinned and only the dragged one answers the pointer.
await select(LINE.id);
const before = await painted();

const drag = async (which, dx, dy) => {
  const box = await page.locator('circle[style*="crosshair"]').nth(which).boundingBox();
  const from = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(from.x + (dx * i) / 10, from.y + (dy * i) / 10);
  await page.mouse.up();
  await settle();
  return { x: from.x + dx, y: from.y + dy };
};

const endTarget = await drag(1, -50, 60);
const afterEnd = await painted();

check(
  "dragging the far end leaves the near end exactly where it was",
  near(afterEnd.start, before.start, 0.5),
  `was ${JSON.stringify(before.start)}, now ${JSON.stringify(afterEnd.start)}`
);
check(
  "and the dragged end lands under the pointer",
  near(afterEnd.end, endTarget, 1),
  `pointer ${JSON.stringify(endTarget)}, endpoint ${JSON.stringify(afterEnd.end)}`
);
check("the handle is still on the segment", near(afterEnd.dot1, afterEnd.end, 0.5), `dot ${JSON.stringify(afterEnd.dot1)} end ${JSON.stringify(afterEnd.end)}`);

// --- dragging the near end ------------------------------------------------
// The other end follows here, and that is not the same bug: the near end IS the
// pivot, so it is placed rather than reached through the rotation, and the line
// re-bases onto it. What must hold is that the handle you grabbed is under the
// cursor and stays on the segment.
const startTarget = await drag(0, 60, 90);
const afterStart = await painted();

check(
  "dragging the near end puts it under the pointer",
  near(afterStart.start, startTarget, 1),
  `pointer ${JSON.stringify(startTarget)}, endpoint ${JSON.stringify(afterStart.start)}`
);
check("and its handle rides with it", near(afterStart.dot0, afterStart.start, 0.5), `dot ${JSON.stringify(afterStart.dot0)} end ${JSON.stringify(afterStart.start)}`);
check(
  "and the line kept its length and angle through the move",
  Math.abs(dist(afterStart.start, afterStart.end) - dist(afterEnd.start, afterEnd.end)) < 1.5,
  `${dist(afterEnd.start, afterEnd.end).toFixed(1)} -> ${dist(afterStart.start, afterStart.end).toFixed(1)}`
);

check("no page errors", errors.length === 0, errors.join(" | "));

await browser.close();
const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(passed === results.length ? 0 : 1);