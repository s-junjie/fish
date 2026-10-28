import { chromium } from "playwright";
import { pathToFileURL } from "url";
import path from "path";

// The gap pill scrubs by `delta × index`, which is "the spacing" only when every
// gap already agrees — on a row at 20 and 80 the same drag produces 24 and 72 and
// means nothing. So an unevenly spaced freeform selection gets a tidy-up badge
// instead of the pills, and the pills arrive once the gaps agree.
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

const settle = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

const seed = () =>
  page.evaluate(() => {
    const bridge = window.__FISH_BRIDGE__;
    const base = bridge.getDoc();
    const rect = (id, x, y, w = 80, h = 80, color = "#111111") => ({
      id,
      type: "rect",
      name: id,
      x,
      y,
      width: w,
      height: h,
      fills: [{ type: "solid", color }]
    });
    bridge.setElements([
        // An uneven row: gutters of 20 and 140.
        rect("r1", 600, 500, 80, 80, "#111111"),
        rect("r2", 700, 500, 80, 80, "#222222"),
        rect("r3", 920, 500, 80, 80, "#333333"),
        // An already even row, far below.
        rect("e1", 600, 700),
        rect("e2", 700, 700, 80, 80, "#555555"),
        rect("e3", 800, 700, 80, 80, "#666666"),
        // A 2x2 grid whose second row's second cell is 20px off its column.
        rect("g00", 600, 200, 60, 60, "#777777"),
        rect("g01", 700, 200, 60, 60, "#888888"),
        rect("g10", 600, 300, 60, 60, "#999999"),
        rect("g11", 740, 300, 60, 60, "#AAAAAA")
      ], { canvas: { ...base.canvas, width: 4000, height: 3000 } });
  });

const gaps = (ids) =>
  page.evaluate((list) => {
    const doc = window.__FISH_BRIDGE__.getDoc();
    const pageEls = (doc.pages.find((p) => p.id === doc.activePageId) || doc).children;
    const find = (list2, id) => {
      for (const el of list2) {
        if (el.id === id) return el;
        const hit = el.children ? find(el.children, id) : null;
        if (hit) return hit;
      }
      return null;
    };
    const els = list.map((id) => find(pageEls, id)).sort((a, b) => a.x - b.x);
    return els.slice(1).map((el, i) => el.x - (els[i].x + els[i].width));
  }, ids);

const overlay = (selector) => page.evaluate((s) => document.querySelectorAll(s).length, selector);
const centreOf = (selector) =>
  page.evaluate((s) => {
    const n = document.querySelector(s);
    if (!n) return null;
    const r = n.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, selector);

await seed();
await settle();

const toScreen = await page.evaluate(() => {
  const host = document.querySelector("svg.pointer-events-auto").parentElement.getBoundingClientRect();
  const stage = document.querySelector("[data-stage-transform]");
  const raw = stage?.getAttribute("transform") ||
    (() => {
      const t = stage?.ownerSVGElement ? getComputedStyle(stage.ownerSVGElement).transform : "";
      const m = /matrix\(([\d.eE+-]+), 0, 0, ([\d.eE+-]+), ([\d.eE+-]+), ([\d.eE+-]+)\)/.exec(t);
      return m ? `translate(${m[3]}, ${m[4]}) scale(${m[1]})` : "";
    })();
  const m = /translate\((-?[\d.]+), (-?[\d.]+)\) scale\(([\d.]+)\)/.exec(raw) || [];
  return {
    left: host.left,
    top: host.top,
    pan: { x: parseFloat(m[1] || "0"), y: parseFloat(m[2] || "0") },
    zoom: parseFloat(m[3] || "1")
  };
});
const screen = (wx, wy) => ({
  x: toScreen.left + toScreen.pan.x + wx * toScreen.zoom,
  y: toScreen.top + toScreen.pan.y + wy * toScreen.zoom
});

// ------------------------------------------------------------------ uneven row
await page.evaluate(() => window.__FISH_BRIDGE__.selectElements(["r1", "r2", "r3"]));
await settle();
// The affordances only render while the pointer is inside the selection box.
await page.mouse.move(screen(640, 540).x, screen(640, 540).y);
await settle();

check("an uneven row offers no gap pills", (await overlay("[data-smart-gap]")) === 0, `${await overlay("[data-smart-gap]")}`);
check("nor the reorder dots — the row chrome is one set for one state", (await overlay("[data-smart-dot]")) === 0, `${await overlay("[data-smart-dot]")}`);
check("and offers the tidy-up badge instead", (await overlay("[data-smart-tidy]")) === 1, `${await overlay("[data-smart-tidy]")}`);

{
  const before = await gaps(["r1", "r2", "r3"]);
  const badge = await centreOf('[data-smart-tidy="x"]');
  check("the badge is reachable inside the hover gate", !!badge, JSON.stringify(badge));
  // A corner badge: clear of the box's right edge, and bottom-aligned with it.
  {
    const rect = await page.evaluate(() => {
      const r = document.querySelector('[data-smart-tidy="x"] rect').getBoundingClientRect();
      return { left: r.left, bottom: r.bottom };
    });
    // The row runs world x 600..1000 and y 500..580.
    const boxRight = screen(1000, 540).x;
    const boxBottom = screen(1000, 580).y;
    check(
      "the badge hangs off the bottom-right corner, outside the box",
      rect.left >= boxRight + 1 && rect.bottom <= boxBottom + 1,
      `${JSON.stringify(rect)} vs box right ${boxRight} bottom ${boxBottom}`
    );
  }
  // Figma's mark: a rounded badge carrying three bars along the axis being evened.
  const mark = await page.evaluate(() => {
    const g = document.querySelector('[data-smart-tidy="x"]');
    if (!g) return null;
    const bg = g.querySelector("rect").getBoundingClientRect();
    const bars = [...g.querySelectorAll("rect")].slice(1);
    return {
      square: Math.abs(bg.width - bg.height) < 1,
      bars: bars.length,
      upright: bars.every((b) => b.getBoundingClientRect().height > b.getBoundingClientRect().width)
    };
  });
  check("it is a rounded square with three upright bars", !!mark && mark.square && mark.bars === 3 && mark.upright, JSON.stringify(mark));

  // Hovering must not repaint it: the mark means "these gaps are not equal", and a
  // badge that swaps to white ink stops looking like the thing it offers.
  const resting = await page.evaluate(() =>
    document.querySelector('[data-smart-tidy="x"] rect').getAttribute("fill")
  );
  await page.mouse.move(badge.x, badge.y);
  await settle();
  const hovered = await page.evaluate(() =>
    document.querySelector('[data-smart-tidy="x"] rect').getAttribute("fill")
  );
  check("hovering leaves the mark alone", resting === hovered && hovered !== "#FFFFFF", `${resting} → ${hovered}`);

  await page.mouse.down();
  await page.mouse.up();
  await settle();

  const after = await gaps(["r1", "r2", "r3"]);
  check(
    "one press equalises the gutters",
    after.length === 2 && Math.abs(after[0] - after[1]) <= 1,
    `${JSON.stringify(before)} → ${JSON.stringify(after)}`
  );
  check(
    "the row's outer edges do not move",
    after[0] + after[1] === before[0] + before[1],
    `${JSON.stringify(before)} → ${JSON.stringify(after)}`
  );
  check("the tidy-up badge has done its job", (await overlay("[data-smart-tidy]")) === 0);
  // The badge sat outside the box, and the gate it widened shrinks back the moment
  // it is gone — so the pointer has to come back over the selection, which is
  // exactly what it would take to use the pills anyway.
  await page.mouse.move(screen(640, 540).x, screen(640, 540).y);
  await settle();
  check("and the pills are there now", (await overlay("[data-smart-gap]")) === 2, `${await overlay("[data-smart-gap]")}`);
  check("along with the reorder dots they went out with", (await overlay("[data-smart-dot]")) === 3, `${await overlay("[data-smart-dot]")}`);

  // One press is one decision, so it is one undo step. Measured right here, while
  // the tidy-up it reverses is the last thing that happened.
  await page.evaluate(() => window.__FISH_BRIDGE__.undo());
  await settle();
  check("one undo takes the whole tidy-up back", JSON.stringify(await gaps(["r1", "r2", "r3"])) === JSON.stringify(before),
    `${JSON.stringify(after)} → ${JSON.stringify(await gaps(["r1", "r2", "r3"]))}, want ${JSON.stringify(before)}`);
}

// ----------------------------------------------------------------------- grid
// A grid's two directions are two separate questions, so it gets a badge each —
// and each badge fixes its own direction, not both at once.
{
  await page.evaluate(() => window.__FISH_BRIDGE__.selectElements(["g00", "g01", "g10", "g11"]));
  await settle();
  await page.mouse.move(screen(630, 230).x, screen(630, 230).y);
  await settle();

  check("a ragged grid offers only the direction that is ragged", (await overlay("[data-smart-tidy]")) === 1, `${await overlay("[data-smart-tidy]")}`);
  check("and it is the horizontal one", (await overlay('[data-smart-tidy="x"]')) === 1);

  const badge = await centreOf('[data-smart-tidy="x"]');
  await page.mouse.move(badge.x, badge.y);
  await settle();
  await page.mouse.down();
  await page.mouse.up();
  await settle();

  const xs = await page.evaluate(() => {
    const doc = window.__FISH_BRIDGE__.getDoc();
    const pageEls = (doc.pages.find((p) => p.id === doc.activePageId) || doc).children;
    return ["g00", "g01", "g10", "g11"].map((id) => pageEls.find((e) => e.id === id).x);
  });
  check("one press lines the columns up", xs[0] === xs[2] && xs[1] === xs[3], JSON.stringify(xs));
  await page.mouse.move(screen(630, 230).x, screen(630, 230).y);
  await settle();
  check("and the grid's gutter pills arrive", (await overlay("[data-smart-gap]")) === 2, `${await overlay("[data-smart-gap]")}`);
}

// -------------------------------------------------------------------- even row
await page.evaluate(() => window.__FISH_BRIDGE__.selectElements(["e1", "e2", "e3"]));
await settle();
await page.mouse.move(screen(640, 740).x, screen(640, 740).y);
await settle();

check("an even row shows its pills straight away", (await overlay("[data-smart-gap]")) === 2, `${await overlay("[data-smart-gap]")}`);
check("with its reorder dots", (await overlay("[data-smart-dot]")) === 3, `${await overlay("[data-smart-dot]")}`);
check("and no tidy-up badge", (await overlay("[data-smart-tidy]")) === 0);

// ------------------------------------------------------------- reorder by dot
// (the fixture builder is hoisted so the passive-element probe below can re-seed)
const seedRow = () =>
  page.evaluate(() => {
    const bridge = window.__FISH_BRIDGE__;
    const base = bridge.getDoc();
    const r = (id, x, w) => ({ id, type: "rect", name: id, x, y: 200, width: w, height: 80, fills: [{ type: "solid", color: "#8899AA" }] });
    bridge.setElements([r("n1", 600, 40), r("n2", 660, 100), r("n3", 780, 40)], { canvas: { ...base.canvas, width: 4000, height: 3000 } });
  });

// A reorder is a reorder: the row comes out of the gesture with the gaps it went
// in with. Exchanging coordinates is only safe when every element is the same
// width, and this row is deliberately not that — a coordinate swap of a narrow
// and a wide box leaves them overlapping, and the pills disappear with the
// spacing they were drawn to describe.
{
  await seedRow();
  await settle();
  await page.evaluate(() => window.__FISH_BRIDGE__.selectElements(["n1", "n2", "n3"]));
  await settle();

  const before = await gaps(["n1", "n2", "n3"]);
  check("the uneven-width row is evenly spaced to begin with", before[0] === before[1], JSON.stringify(before));

  // The row chrome only renders while the pointer is inside the selection.
  await page.mouse.move(screen(620, 240).x, screen(620, 240).y);
  await settle();
  // Both centres are read up front: the row chrome stands down for the duration of
  // the gesture it belongs to, so the far dot is gone by the time the pointer
  // needs it.
  const dot = await centreOf('[data-smart-dot="n1"]');
  const far = await centreOf('[data-smart-dot="n3"]');
  await page.mouse.move(dot.x, dot.y);
  await settle();
  await page.mouse.down();
  // Past the far dot's centre: the slot is chosen by crossing the MIDPOINT
  // between adjacent slots, so stopping on the centre leaves the source where it
  // started.
  await page.mouse.move(far.x + 60, far.y, { steps: 10 });
  await settle();

  // Read MID-gesture: the dashed box is a PROMISE about where the release will put
  // the element, and it is gone by the time the mouse comes up. It used to show
  // the target slot wearing the dragged element's size, while the settle re-flowed
  // the row — so a wide element was promised one place and delivered another, by
  // exactly the difference between the two sizes.
  const promised = await page.evaluate(() => {
    const n = document.querySelector("[data-smart-drop-box]");
    return n ? { x: +n.getAttribute("x"), y: +n.getAttribute("y"), w: +n.getAttribute("width") } : null;
  });

  await page.mouse.up();
  await settle();

  const after = await gaps(["n1", "n2", "n3"]);
  check("dragging a reorder dot across the row keeps the spacing", after[0] === after[1], `${JSON.stringify(before)} → ${JSON.stringify(after)}`);
  const order = await page.evaluate(() => {
    const d = window.__FISH_BRIDGE__.getDoc();
    const els = (d.pages.find((p) => p.id === d.activePageId) || d).children;
    return ["n1", "n2", "n3"].map((id) => ({ id, x: els.find((e) => e.id === id).x, w: els.find((e) => e.id === id).width })).sort((a, b) => a.x - b.x);
  });
  check("and the narrow box really did move to the far slot", order[0].id === "n2" && order[2].id === "n1", JSON.stringify(order));
  check("the pills survive the swap", (await overlay("[data-smart-gap]")) === 2, `${await overlay("[data-smart-gap]")}`);

  // ...and the promise was kept. Read against the DOCUMENT rather than a painted
  // box: the overlay is gone by now, and the element's stored x is what the
  // release wrote.
  const landed = await page.evaluate(() => {
    const d = window.__FISH_BRIDGE__.getDoc();
    const els = (d.pages.find((p) => p.id === d.activePageId) || d).children;
    return els.find((e) => e.id === "n1");
  });
  check(
    "and the drop box promised where it actually landed",
    !!promised && !!landed && promised.x === landed.x && promised.w === landed.width && promised.y === landed.y,
    `${JSON.stringify(promised)} vs ${JSON.stringify(landed && { x: landed.x, y: landed.y, w: landed.width })}`
  );
}

// The dragged element was only half of it. The elements that move BECAUSE of it
// are written by the same preview, and were being slid to the dragged element's
// original slot while the settle re-flowed the row — so they sat one way on screen
// and landed another. Read them mid-gesture, because the preview only exists then.
{
  await seedRow();
  await settle();
  await page.evaluate(() => window.__FISH_BRIDGE__.selectElements(["n1", "n2", "n3"]));
  await settle();
  await page.mouse.move(screen(620, 240).x, screen(620, 240).y);
  await settle();

  // The NARROW element onto the far slot. It is the discriminating case: the old
  // preview slid `n3` into `n1`'s abandoned slot (x 600), while the settle re-flows
  // the row and puts it at 780 — the whole width of `n2` apart.
  const narrow = await centreOf('[data-smart-dot="n1"]');
  const far = await centreOf('[data-smart-dot="n3"]');
  await page.mouse.move(narrow.x, narrow.y);
  await settle();
  await page.mouse.down();
  await page.mouse.move(far.x + 60, far.y, { steps: 10 });
  await settle();

  const readLive = () =>
    page.evaluate(() => {
      const d = window.__FISH_BRIDGE__.getDoc();
      const els = (d.pages.find((p) => p.id === d.activePageId) || d).children;
      return Object.fromEntries(["n1", "n2", "n3"].map((id) => [id, els.find((e) => e.id === id).x]));
    });
  const live = await readLive();
  await page.mouse.up();
  await settle();
  const settled = await readLive();

  // n1 is the one riding the pointer, so it is expected to differ mid-drag.
  check(
    "the passive elements sit where the release will leave them",
    live.n2 === settled.n2 && live.n3 === settled.n3,
    `mid-drag ${JSON.stringify(live)} vs settled ${JSON.stringify(settled)}`
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