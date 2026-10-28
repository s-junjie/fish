import { chromium } from "playwright";
import { pathToFileURL } from "node:url";
import path from "node:path";

/**
 * A layer that paints a material owns its interior for hit testing.
 *
 * The report this pins: "把 fill 关掉后无法选中那个图层" + "从图层上选中它后也无法
 * 拖动". Both are one cause, and it is not that the glass is hard to click — it is
 * that a press inside it reached the CANVAS ROOT and started a marquee:
 *
 *  1. `backdrop-filter` is applied by a `<foreignObject>` whose inner `<div>` is
 *     `pointer-events: none`. That does not make the `foreignObject` inert — the
 *     element still hit-tests its own box;
 *  2. a leaf shape with no fill deliberately hit-tests only its outline
 *     (`pointer-events: stroke`, `fill: none`), so the `foreignObject` — painted
 *     first, but the topmost thing still hittable in the interior — won;
 *  3. it has no handler, so the press bubbled to `handleCanvasMouseDown`, which
 *     for the select tool starts a zero-area MARQUEE: selection cleared, then
 *     every layer intersecting the point selected. That is the reported
 *     "两个图层绑定" — the glass panel came back WITH the layer under it, and
 *     because the gesture was a marquee and not a drag, nothing moved.
 *
 * So there are two independent fixes and this spec tests them apart:
 *  - the backdrop is decoration → `pointer-events: none` (pinned by the CORNER
 *    press: outside a rounded corner the panel must not swallow the press);
 *  - a shape that paints a backdrop owns its interior → the hit path becomes
 *    `all` (pinned by the CENTRE press: exactly one layer, the glass one).
 *
 * The controls matter as much as the assertions: a fill-less shape with NO effect
 * must stay click-through, or the "fix" would have quietly made every transparent
 * rectangle swallow its own clicks.
 */
const html = path.resolve(process.cwd(), process.argv[2] ?? "dist/index.html");
const results = [];
const pageErrors = [];
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  results.push({ name, ok });
}

const glass = (over = {}) => ({
  type: "liquid-glass",
  frost: 6,
  refraction: 70,
  depth: 19,
  dispersion: 22,
  lightAngle: -35,
  lightIntensity: 45,
  splay: 20,
  fill: 0,
  stroke: 0,
  enabled: true,
  ...over
});
const frost = (over = {}) => ({ type: "backdrop-blur", blur: 12, enabled: true, ...over });

/* 60, not 24: the corner cut of a rounded rect is `(1 - 1/√2)·r` deep, and the hit
   path carries an 8-screen-px invisible stroke band around the outline. At r = 60
   the cut is 17.6 doc px, so a press one screen px inside the box corner is
   unambiguously outside the SHAPE while still inside the BOX — which is exactly
   the region the backdrop `foreignObject` used to claim. */
const R = 60;
const PANEL = { x: 260, y: 200, width: 240, height: 160 };
const UNDER = { x: 120, y: 120, width: 480, height: 340 };

const panel = (effects, filled) => ({
  id: "top",
  type: "rect",
  name: "Top",
  x: PANEL.x,
  y: PANEL.y,
  width: PANEL.width,
  height: PANEL.height,
  borderRadius: R,
  fillEnabled: filled,
  fills: filled ? [{ type: "solid", color: "#EF4444" }] : [],
  effects
});
const under = {
  id: "under",
  type: "rect",
  name: "Under",
  x: UNDER.x,
  y: UNDER.y,
  width: UNDER.width,
  height: UNDER.height,
  fills: [{ type: "solid", color: "#3B82F6" }]
};
const leafDoc = (effects, filled) => ({
  pages: [
    {
      id: "p1",
      name: "Page 1",
      canvas: { width: 840, height: 580 },
      children: [under, panel(effects, filled)]
    }
  ],
  activePageId: "p1"
});

/* An instance resolves its own stack, so its backdrop `foreignObject` lives in
   `InstanceNode` — a second copy of the same defect. Two things about the fixture
   are load-bearing:
 *  - the master's child carries the SAME radius as the box, otherwise the clone is
     a plain rect that covers the corner cut and the case never arises;
  - the probe uses the BOTTOM-RIGHT corner. An instance paints its name above the
     top-left corner (`◇ I`), and one screen px inside that corner lands on the
     label's ink, which is `pointer-events: auto` and selects the instance — the
     check would pass without ever reaching the corner it claims to test. */
const MASTER = {
  id: "M",
  type: "component",
  name: "M",
  x: 100,
  y: 100,
  width: PANEL.width,
  height: PANEL.height,
  borderRadius: R,
  clipContent: false,
  fills: [{ type: "solid", color: "#111827" }],
  children: [
    {
      id: "M_k",
      type: "rect",
      name: "M_k",
      x: 0,
      y: 0,
      width: PANEL.width,
      height: PANEL.height,
      borderRadius: R,
      fills: [{ type: "solid", color: "#111827" }]
    }
  ]
};
const instanceDoc = (effects) => ({
  pages: [
    {
      id: "p1",
      name: "Page 1",
      canvas: { width: 840, height: 580 },
      children: [
        under,
        MASTER,
        {
          id: "I",
          type: "instance",
          name: "I",
          componentId: "M",
          x: PANEL.x,
          y: PANEL.y,
          width: PANEL.width,
          height: PANEL.height,
          borderRadius: R,
          effects
        }
      ]
    }
  ],
  activePageId: "p1"
});

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.on("pageerror", (e) => pageErrors.push(String(e)));
page.on("console", (m) => {
  if (m.type() === "error") pageErrors.push(m.text());
});
await page.goto(pathToFileURL(html).href);
await page.waitForFunction(() => !!window.__FISH_BRIDGE__ && !!window.__fish);

async function seed(doc) {
  await page.evaluate(async (d) => {
    window.__FISH_BRIDGE__.applyDoc(window.__fish.normalize(d).document);
    await new Promise((r) =>
      requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 90)))
    );
  }, doc);
  await page.evaluate(() => window.__FISH_BRIDGE__.selectElement(""));
  await page.waitForTimeout(60);
}

const selected = () => page.evaluate(() => window.__FISH_BRIDGE__.getSelectedIds().sort());

/** The centre of a painted node, in screen px, read from the DOM. */
const centreOf = (id) =>
  page.evaluate((elId) => {
    const b = document.querySelector(`[data-element-id="${elId}"]`).getBoundingClientRect();
    return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
  }, id);

/** One screen px inside the node's top-left box corner — inside the box, outside
    the rounded shape. */
const cornerOf = (id, which = "tl") =>
  page.evaluate(
    ({ elId, w }) => {
      const b = document.querySelector(`[data-element-id="${elId}"]`).getBoundingClientRect();
      const d = 1.5;
      return w === "br"
        ? { x: b.right - d, y: b.bottom - d }
        : { x: b.left + d, y: b.top + d };
    },
    { elId: id, w: which }
  );

/** What the renderer would hit there, and whose group it belongs to. */
const targetAt = (id, where) =>
  page.evaluate(
    ({ elId, w }) => {
      const b = document.querySelector(`[data-element-id="${elId}"]`).getBoundingClientRect();
      const d = 1.5;
      const p =
        w === "corner"
          ? { x: b.left + d, y: b.top + d }
          : w === "corner-br"
          ? { x: b.right - d, y: b.bottom - d }
          : { x: b.left + b.width / 2, y: b.top + b.height / 2 };
      const el = document.elementFromPoint(p.x, p.y);
      return {
        tag: el?.tagName ?? null,
        owner: el?.closest?.("[data-element-id]")?.getAttribute("data-element-id") ?? "(none)",
        isHitPath: el?.getAttribute?.("data-hit") === "true",
        pointerEvents: el ? getComputedStyle(el).pointerEvents : null
      };
    },
    { elId: id, w: where }
  );

async function press(p) {
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(90);
}

/* ------------------------------------------------------ 1. glass, no fill */

await seed(leafDoc([glass()], false));
const centreHit = await targetAt("top", "centre");
check(
  "a press in a fill-less glass layer lands on the layer's own hit path",
  centreHit.isHitPath && centreHit.owner === "top",
  `<${centreHit.tag}> owner=${centreHit.owner} data-hit=${centreHit.isHitPath} pointer-events=${centreHit.pointerEvents}`
);
await press(await centreOf("top"));
check(
  "clicking a fill-less glass layer selects it — and only it",
  JSON.stringify(await selected()) === JSON.stringify(["top"]),
  `selected [${(await selected()).join(", ")}]`
);

const cornerHit = await targetAt("top", "corner");
check(
  "the backdrop is inert: outside the rounded corner the press is NOT the panel's",
  cornerHit.owner !== "top",
  `<${cornerHit.tag}> owner=${cornerHit.owner} pointer-events=${cornerHit.pointerEvents}`
);
await seed(leafDoc([glass()], false));
await press(await cornerOf("top"));
check(
  "a press in the corner cut reaches the layer under it, and sweeps nothing else",
  JSON.stringify(await selected()) === JSON.stringify(["under"]),
  `selected [${(await selected()).join(", ")}] — a marquee here would return under AND top`
);

/* -------------------------------------- 2. select from the panel, then drag */

await seed(leafDoc([glass()], false));
const pickedRow = await page.evaluate(() => {
  const row = document.querySelector('[data-ui-panel="left"] [data-layer-row="top"]');
  if (!row) return false;
  row.click();
  return true;
});
await page.waitForTimeout(120);
const picked = await selected();
check(
  "the layer panel can select the fill-less glass layer",
  pickedRow && JSON.stringify(picked) === JSON.stringify(["top"]),
  pickedRow ? `selected [${picked.join(", ")}]` : "no [data-layer-row=top] in the left panel"
);

/* Drag in DOCUMENT space: the canvas opens zoom-to-fit, so one screen px is not
   one doc px. Derive the factor from the painted box rather than assuming it. */
const zoom = await page.evaluate(() => {
  const b = document.querySelector('[data-element-id="top"]').getBoundingClientRect();
  return b.width / 240;
});
const from = await centreOf("top");
const before = await page.evaluate(() => window.__fish.measure("top").x);
await page.mouse.move(from.x, from.y);
await page.mouse.down();
await page.mouse.move(from.x + 40, from.y, { steps: 5 });
await page.mouse.move(from.x + 80, from.y, { steps: 5 });
await page.mouse.up();
await page.waitForTimeout(140);
const after = await page.evaluate(() => window.__fish.measure("top").x);
check(
  "and it drags from its interior once selected there",
  Math.abs(after - before - 80 / zoom) <= 2,
  `x ${before} -> ${after} (moved ${(after - before).toFixed(1)}, expected ${(80 / zoom).toFixed(1)} at zoom ${zoom.toFixed(3)})`
);

/* -------------------------------------------------------- 3. the controls */

await seed(leafDoc(undefined, false));
await press(await centreOf("top"));
check(
  "control: a fill-less shape with NO effect is still click-through",
  JSON.stringify(await selected()) === JSON.stringify(["under"]),
  `selected [${(await selected()).join(", ")}]`
);

await seed(leafDoc([glass()], true));
await press(await centreOf("top"));
check(
  "control: a FILLED glass layer still selects itself",
  JSON.stringify(await selected()) === JSON.stringify(["top"]),
  `selected [${(await selected()).join(", ")}]`
);

await seed(leafDoc([frost()], false));
await press(await centreOf("top"));
check(
  "a backdrop-blur panel with no fill owns its interior too",
  JSON.stringify(await selected()) === JSON.stringify(["top"]),
  `selected [${(await selected()).join(", ")}]`
);

/* ------------------------------------------------------- 4. the instance */

await seed(instanceDoc([frost()]));
const instCentre = await targetAt("I", "centre");
check(
  "a press in an instance's middle stays inside the instance",
  instCentre.owner === "I" || instCentre.owner.startsWith("I_"),
  `<${instCentre.tag}> owner=${instCentre.owner} data-hit=${instCentre.isHitPath}`
);
const instCorner = await targetAt("I", "corner-br");
check(
  "its backdrop is inert: the bottom-right corner cut is not the instance's",
  !(instCorner.owner === "I" || instCorner.owner.startsWith("I_")),
  `<${instCorner.tag}> owner=${instCorner.owner} pointer-events=${instCorner.pointerEvents}`
);
await seed(instanceDoc([frost()]));
await press(await cornerOf("I", "br"));
check(
  "so a press in the instance's corner cut takes the layer under it, and only it",
  JSON.stringify(await selected()) === JSON.stringify(["under"]),
  `selected [${(await selected()).join(", ")}]`
);

/* --------------------------------------------------------------- verdict */

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
if (pageErrors.length) console.log(`pageErrors:\n${pageErrors.join("\n")}`);
await browser.close();
process.exit(failed.length === 0 && pageErrors.length === 0 ? 0 : 1);
