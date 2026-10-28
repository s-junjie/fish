import { chromium } from "playwright";
import { pathToFileURL } from "url";
import path from "path";

// Reproduces two reported regressions on an auto-layout stack that does not sit
// at the canvas origin:
//   1. the pink re-layout controls (reorder dots + gap pills) were drawn at the
//      frame's own corner instead of over the children, because the geometry came
//      from the children in the frame's local space;
//   2. the inspector's align row was live for a child of the stack even though the
//      layout owns that child's position, so aligning did nothing.
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
          id: "STACK",
          type: "frame",
          name: "Toolbar",
          // Far from the origin on purpose: a bug that reports the children's
          // local boxes only shows up here.
          x: 620,
          y: 340,
          width: 420,
          height: 160,
          fills: [{ type: "solid", color: "#F4F4F5" }],
          display: "flex",
          "flex-direction": "row",
          gap: 20,
          padding: 24,
          "justify-content": "flex-start",
          "align-items": "center",
          // `applyDoc` stores the tree verbatim — no relayout pass runs — so the
          // children carry the slots `applyFlexLayout` would give them: padding
          // 24, gap 20, centred on the 112px content height.
          children: [
            { id: "k1", type: "rect", name: "k1", x: 24, y: 50, width: 60, height: 60, fills: [{ type: "solid", color: "#111111" }] },
            { id: "k2", type: "rect", name: "k2", x: 104, y: 50, width: 60, height: 60, fills: [{ type: "solid", color: "#222222" }] },
            { id: "k3", type: "rect", name: "k3", x: 184, y: 50, width: 60, height: 60, fills: [{ type: "solid", color: "#333333" }] }
          ]
        },
        {
          id: "PLAIN",
          type: "frame",
          name: "Plain",
          x: 620,
          y: 700,
          width: 300,
          height: 200,
          fills: [{ type: "solid", color: "#FFFFFF" }],
          children: [
            { id: "p1", type: "rect", name: "p1", x: 20, y: 20, width: 60, height: 60, fills: [{ type: "solid", color: "#111111" }] },
            { id: "p2", type: "rect", name: "p2", x: 120, y: 90, width: 60, height: 60, fills: [{ type: "solid", color: "#222222" }] }
          ]
        }
      ], { canvas: { ...base.canvas, width: 4000, height: 3000 } });
  });

const settle = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
/** Open an alignment field and press one of its rows — it is a menu, not a `<select>`. */
const pickAlignment = async (attr, value) => {
  await page.click(`[${attr}]`);
  await page.click(`[data-align-option="${value}"]`);
  await settle();
};
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
  return (wx, wy) => ({ x: s.rect.left + s.pan.x + wx * s.zoom, y: s.rect.top + s.pan.y + wy * s.zoom });
};
/** Screen-space centre of the element's own painted shape. */
const paintedCenter = (id) =>
  page.evaluate((elId) => {
    const g = document.querySelector(`[data-element-id="${elId}"]`);
    if (!g) return null;
    const shape = [...g.querySelectorAll("path, rect, ellipse, polygon, foreignObject")].find(
      (n) => n.closest("[data-element-id]") === g && !(n.tagName === "path" && n.getAttribute("pointer-events") === "all")
    );
    if (!shape) return null;
    const r = shape.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, id);
const controlCenter = (attr, id) =>
  page.evaluate(
    ([a, v]) => {
      const n = document.querySelector(`[${a}="${v}"]`);
      if (!n) return null;
      const r = n.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    },
    [attr, id]
  );
const alignRow = () =>
  page.evaluate(() => {
    const row = document.querySelector('[data-align-row="true"]');
    if (!row) return null;
    const buttons = [...row.querySelectorAll("button")];
    return { count: buttons.length, allDisabled: buttons.every((b) => b.disabled), title: buttons[0]?.getAttribute("title") };
  });

// ---------------------------------------------------------------- pink controls
await seed();
await settle();
const toScreen = await setupViewport();

await page.evaluate(() => window.__FISH_BRIDGE__.selectElement("STACK"));
await settle();
// The controls only render while the pointer is inside the selection box.
const hover = toScreen(620 + 210, 340 + 80);
await page.mouse.move(hover.x, hover.y);
await settle();

const dotCount = await page.evaluate(() => document.querySelectorAll("[data-smart-dot]").length);
const gapCount = await page.evaluate(() => document.querySelectorAll("[data-smart-gap]").length);
check("one reorder dot per stack child", dotCount === 3, `got ${dotCount}`);
check("one gap pill per gap", gapCount === 2, `got ${gapCount}`);

// The controls are only meaningful over children that are actually spread out, so
// the seed has to be a laid-out row — otherwise every dot lands on one point and
// the assertions below pass without proving anything.
{
  const a = await paintedCenter("k1");
  const c = await paintedCenter("k3");
  const pitch = 80; // 60 wide + gap 20
  const zoom = await page.evaluate(() =>
    parseFloat(/scale\(([\d.]+)\)/.exec((() => { const s = document.querySelector("[data-stage-transform]"); const a = s && s.getAttribute("transform"); if (a) return a; const svg = s && s.ownerSVGElement; const t = svg ? getComputedStyle(svg).transform : ""; const m = /matrix\(([\d.eE+-]+), 0, 0, ([\d.eE+-]+), ([\d.eE+-]+), ([\d.eE+-]+)\)/.exec(t); return m ? "translate(" + m[3] + ", " + m[4] + ") scale(" + m[1] + ")" : null; })())[1])
  );
  checkNear("the stack is laid out (children spread across the row)", c.x - a.x, 2 * pitch * zoom, 1.5);
}

for (const id of ["k1", "k2", "k3"]) {
  const dot = await controlCenter("data-smart-dot", id);
  const paint = await paintedCenter(id);
  check(`dot for ${id} exists`, !!dot, JSON.stringify(dot));
  check(`dot for ${id} sits on the child`, !!dot && !!paint && Math.abs(dot.x - paint.x) <= 1 && Math.abs(dot.y - paint.y) <= 1,
    `dot ${JSON.stringify(dot)} vs painted ${JSON.stringify(paint)}`);
}
{
  const pill = await controlCenter("data-smart-gap", "frame_gap_0");
  const a = await paintedCenter("k1");
  const b = await paintedCenter("k2");
  check("gap pill sits between the two children", !!pill && !!a && !!b && pill.x > a.x && pill.x < b.x && Math.abs(pill.y - a.y) <= 1,
    `pill ${JSON.stringify(pill)} between ${JSON.stringify(a)} and ${JSON.stringify(b)}`);
}

// The controls must be draggable where they are drawn: grabbing the pill that is
// on screen has to be the pill the overlay hit-tested.
{
  const pill = await controlCenter("data-smart-gap", "frame_gap_0");
  await page.mouse.move(pill.x, pill.y);
  await page.mouse.down();
  await page.mouse.move(pill.x + 40, pill.y, { steps: 8 });
  await page.mouse.up();
  await settle();
  const gap = await page.evaluate(() => {
    const stack = window.__FISH_BRIDGE__.getElements().find((e) => e.id === "STACK");
    return stack.gap;
  });
  const zoom = await page.evaluate(() => {
    const svg = document.querySelector("svg.pointer-events-auto");
    return parseFloat(/scale\(([\d.]+)\)/.exec((() => { const s = document.querySelector("[data-stage-transform]"); const a = s && s.getAttribute("transform"); if (a) return a; const svg = s && s.ownerSVGElement; const t = svg ? getComputedStyle(svg).transform : ""; const m = /matrix\(([\d.eE+-]+), 0, 0, ([\d.eE+-]+), ([\d.eE+-]+), ([\d.eE+-]+)\)/.exec(t); return m ? "translate(" + m[3] + ", " + m[4] + ") scale(" + m[1] + ")" : null; })())[1]);
  });
  checkNear("dragging the drawn pill changes the gap", gap, 20 + Math.round(40 / zoom), 2);
}

// ---------------------------------------------------------------- align buttons
for (const [id, wantDisabled] of [["k1", true], ["STACK", false], ["p1", false]]) {
  await page.evaluate((i) => window.__FISH_BRIDGE__.selectElement(i), id);
  await settle();
  const row = await alignRow();
  check(`align row renders for ${id}`, !!row && row.count === 6, JSON.stringify(row));
  check(`align row is ${wantDisabled ? "disabled" : "live"} for ${id}`, !!row && row.allDisabled === wantDisabled,
    JSON.stringify(row));
}
{
  await page.evaluate(() => window.__FISH_BRIDGE__.selectElement("k1"));
  await settle();
  const row = await alignRow();
  check("a disabled align button explains itself", !!row && /auto layout/i.test(row.title || ""), JSON.stringify(row));
}

// ------------------------------------------------------------- space-evenly
// The engine has resolved `space-evenly` all along; the Distribute menu was the
// only place it did not exist, which is the same as not having it. A mode with no
// control is the version of this feature nobody can use, so the menu entry AND the
// geometry it produces are both asserted here.
//
// The expectation is the DEFINITION, not a snapshot — and the definition is
// Chromium's: measured on a bare 372-content flex row with three 60px children,
// `column-gap: 20` gave space-between 0 / space-around 25.33 / space-evenly 38 in
// the leading gap, and 96 / 70.67 / 58 between the children. That is
// `free = content − items − gaps`, with the outer gap = free/(n+1) for evenly and
// free/(2n) for around. (Read the gap back from the document rather than assuming
// 20: an earlier check in this file drags the gap pill.)
{
  await page.evaluate(() => window.__FISH_BRIDGE__.selectElement("STACK"));
  await settle();

  // The menu is read open: the option rows carry the drawings, so a closed
  // field can only ever show the value in force.
  await page.click("[data-stack-justify]");
  const options = await page.evaluate(() =>
    [...document.querySelectorAll("[data-align-option]")].map((o) => o.dataset.alignOption)
  );
  await page.keyboard.press("Escape");
  await settle();
  check(
    "the Distribute menu offers every mode the engine resolves",
    ["start", "center", "end", "space-between", "space-around", "space-evenly"].every((v) =>
      options.includes(v)
    ),
    JSON.stringify(options)
  );

  const leadingGap = () =>
    page.evaluate(() => {
      const find = (list, id) => {
        for (const el of list) {
          if (el.id === id) return el;
          const hit = el.children ? find(el.children, id) : null;
          if (hit) return hit;
        }
        return null;
      };
      const doc = window.__FISH_BRIDGE__.getDoc();
      const page = doc.pages.find((p) => p.id === doc.activePageId);
      const els = (page && page.children) || [];
      const stack = find(els, "STACK");
      const kids = ["k1", "k2", "k3"].map((id) => find(els, id));
      const pad = stack.padding;
      const padLeft = Array.isArray(pad) ? pad[3] : pad ?? 0;
      const round = (n) => Math.round(n * 100) / 100;
      return {
        justify: stack["justify-content"],
        gap: stack.gap,
        left: round(kids[0].x - padLeft),
        inner: [round(kids[1].x - (kids[0].x + kids[0].width))],
        xs: kids.map((k) => round(k.x)),
        contentWidth: stack.width - padLeft * 2,
        itemWidth: kids[0].width,
        count: kids.length
      };
    });

  const even = await (async () => {
    await pickAlignment("data-stack-justify", "space-evenly");
    await settle();
    return leadingGap();
  })();

  const free = even.contentWidth - even.count * even.itemWidth - (even.count - 1) * even.gap;
  const expectEven = Math.round((free / (even.count + 1)) * 100) / 100;

  check("choosing it is written to the document", even.justify === "space-evenly", even.justify);
  check(
    `space-evenly splits the free space into n+1 equal outer gaps (${expectEven})`,
    Math.abs(even.left - expectEven) <= 0.5,
    JSON.stringify(even)
  );
  check(
    "and the gap between children is the document's gap plus that share",
    Math.abs(even.inner[0] - (even.gap + expectEven)) <= 0.5,
    JSON.stringify(even)
  );

  const around = await (async () => {
    await pickAlignment("data-stack-justify", "space-around");
    await settle();
    return leadingGap();
  })();
  const between = await (async () => {
    await pickAlignment("data-stack-justify", "space-between");
    await settle();
    return leadingGap();
  })();

  check(
    "the three modes are three different distributions, in the order CSS defines",
    between.left === 0 && around.left > 0 && even.left > around.left,
    `between ${between.left} < around ${around.left} < evenly ${even.left}`
  );
}

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : `  -> ${r.detail ?? ""}`}`);
}
console.log(`\n${results.length - failed.length}/${results.length} passed`);
console.log("pageErrors", errors.slice(0, 5));

await browser.close();
process.exit(failed.length === 0 && errors.length === 0 ? 0 : 1);
