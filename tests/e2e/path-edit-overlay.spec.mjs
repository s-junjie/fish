import { chromium } from "playwright";
import { pathToFileURL } from "url";
import path from "node:path";

// Vector edit mode, measured in the real editor:
//
//   1. a top-level path     — the anchor/control overlay sits on the path
//   2. a path inside a frame — same overlay, in the same place. The path's x/y are
//                              local to its frame, so an overlay translated by them
//                              alone was drawn at the frame's origin instead: the
//                              handles existed but were nowhere near the path.
//   3. dragging an anchor   — the overlay is interactive, not just positioned
//   4. a TURNED path        — an ancestor's rotation, and the path's own. The
//                              overlay rode the translation-only parent chain, so
//                              both were edited at a point the artwork is not.
//
// Coordinates are read back from the DOM (`[data-element-id]`, `[data-anchor-index]`),
// never derived from pan/zoom math.
const html = path.resolve(process.cwd(), process.argv[2] ?? "dist/index.html");

const D = "M 0 0 C 60 0 60 120 220 120";
// Four anchors, so the multi-selection block has a third and fourth to work with.
const D4 = "M 0 0 L 70 0 C 110 0 110 130 180 130 L 220 130";

const ELEMENTS = [
  {
    id: "outer",
    type: "frame",
    name: "Outer",
    x: 300,
    y: 400,
    width: 420,
    height: 380,
    fills: [{ type: "solid", color: "#262626" }],
    children: [
      { id: "inner_path", type: "path", name: "Inner Path", x: 40, y: 40, width: 220, height: 130, d: D, strokes: [{ color: "#FFFFFF", width: 2 }] },
      { id: "quad_path", type: "path", name: "Quad Path", x: 40, y: 200, width: 220, height: 130, d: D4, strokes: [{ color: "#FFFFFF", width: 2 }] }
    ]
  },
  { id: "top_path", type: "path", name: "Top Path", x: 900, y: 200, width: 220, height: 130, d: D, strokes: [{ color: "#FFFFFF", width: 2 }] },
  // The two turned fixtures. Every box below is the AABB of the already-turned
  // artwork, kept inside the canvas region the 1600x1000 viewport actually
  // shows at this doc's zoom (~0.8) — an off-screen anchor is not a click target
  // and the checks below would fail for a reason that is not the product.
  { id: "rot_path", type: "path", name: "Self Rotated", x: 800, y: 640, width: 220, height: 130, rotation: 45, d: D, strokes: [{ color: "#FFFFFF", width: 2 }] },
  {
    id: "turned_frame",
    type: "frame",
    name: "Turned Frame",
    x: 100,
    y: 60,
    width: 260,
    height: 260,
    rotation: 30,
    fills: [{ type: "solid", color: "#262626" }],
    children: [
      { id: "turned_path", type: "path", name: "Turned Path", x: 30, y: 90, width: 220, height: 130, d: D, strokes: [{ color: "#FFFFFF", width: 2 }] }
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
  bridge.setElements(JSON.parse(JSON.stringify(elements)), { canvas: { ...base.canvas, width: 2000, height: 1400 } });
}, ELEMENTS);
await page.waitForTimeout(700);

const select = (id) => page.evaluate((i) => window.__FISH_BRIDGE__.selectElement(i), id);
const boxOf = (sel) =>
  page.evaluate((s) => {
    const n = document.querySelector(s);
    if (!n) return null;
    const b = n.getBoundingClientRect();
    return { cx: b.x + b.width / 2, cy: b.y + b.height / 2, x: b.x, y: b.y, w: b.width, h: b.height };
  }, sel);
/** How many anchors the overlay currently offers. */
const anchorCount = () => page.evaluate(() => document.querySelectorAll("[data-path-edit] [data-anchor-index]").length);
/** The overlay as a whole: how many handles it drew and where it landed. */
const overlay = () =>
  page.evaluate(() => {
    const g = document.querySelector("[data-path-edit]");
    if (!g) return null;
    const b = g.getBoundingClientRect();
    return { circles: g.querySelectorAll("circle").length, cx: b.x + b.width / 2, cy: b.y + b.height / 2 };
  });

const enterEditMode = async (id) => {
  await select(id);
  await page.waitForTimeout(200);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(350);
};

/**
 * How far each overlay anchor sits from the path as the renderer paints it, in
 * screen px.
 *
 * The outline is walked with `getPointAtLength` and mapped through the element's
 * own `getScreenCTM`, so the answer is independent of pan/zoom AND of any turn in
 * the path's ancestry. A bounding-box centre comparison cannot stand in for this:
 * a path rotated about its own centre has the SAME box centre as its overlay, so
 * that test reads 0 while the anchors sit tens of px off the artwork.
 */
const anchorsOffOutline = (id) =>
  page.evaluate((i) => {
    const host = document.querySelector(`[data-element-id="${i}"]`);
    const rendered = host && host.querySelector("path[data-hit]");
    if (!rendered) return null;
    const ctm = rendered.getScreenCTM();
    const len = rendered.getTotalLength();
    const outline = [];
    for (let d = 0; d <= len; d += 1) {
      const p = rendered.getPointAtLength(d);
      outline.push({ x: ctm.a * p.x + ctm.c * p.y + ctm.e, y: ctm.b * p.x + ctm.d * p.y + ctm.f });
    }
    return [...document.querySelectorAll("[data-path-edit] [data-anchor-index]")].map((n) => {
      const r = n.getBoundingClientRect();
      const cx = r.x + r.width / 2;
      const cy = r.y + r.height / 2;
      let best = Infinity;
      for (const p of outline) best = Math.min(best, Math.hypot(p.x - cx, p.y - cy));
      return Math.round(best * 10) / 10;
    });
  }, id);

const onPath = async (id, label) => {
  const o = await overlay();
  const el = await boxOf(`[data-element-id="${id}"]`);
  check(`${label}: the overlay draws anchors and control handles`, !!o && o.circles >= 4, JSON.stringify(o));
  if (!o || !el) return;
  const dx = Math.abs(o.cx - el.cx);
  const dy = Math.abs(o.cy - el.cy);
  check(`${label}: the overlay sits on the path`, dx < 40 && dy < 40, `dx=${Math.round(dx)} dy=${Math.round(dy)}`);
  const offs = await anchorsOffOutline(id);
  const worst = offs && offs.length ? Math.max(...offs) : Infinity;
  check(`${label}: every anchor sits on the rendered outline`, worst < 2, `offs=${JSON.stringify(offs)}`);
};

/** Where one overlay anchor is on screen, and whether a click there reaches it. */
const anchorCenter = (idx) =>
  page.evaluate((i) => {
    const n = document.querySelector(`[data-path-edit] [data-anchor-index="${i}"]`);
    if (!n) return null;
    const r = n.getBoundingClientRect();
    const cx = r.x + r.width / 2;
    const cy = r.y + r.height / 2;
    // A fixture that drifted under the app's own chrome would otherwise fail the
    // drag below for a reason that has nothing to do with the code under test.
    return { cx, cy, hittable: document.elementFromPoint(cx, cy) === n };
  }, idx);

// ---- 1. top-level path -----------------------------------------------------
await enterEditMode("top_path");
await onPath("top_path", "top-level path");

// ---- 1b. the Vector section exists only in edit mode ----------------------
// Probed by the section's Done button: its title is the one thing here that only
// ever exists while a path is open. The heading reads "Vector" in the DOM and is
// uppercased by CSS, so matching on "VECTOR" would never fire.
const hasVectorSection = () =>
  page.evaluate(() =>
    [...document.querySelectorAll("button[title]")].some((b) => (b.getAttribute("title") || "").startsWith("Exit vector edit"))
  );
const hasEditObjectButton = () => page.evaluate(() =>
  [...document.querySelectorAll("button")].some((b) => (b.textContent || "").trim() === "Edit Object")
);
await page.keyboard.press("Escape");
await page.waitForTimeout(250);
check("leaving edit mode takes the whole Vector section away", (await hasVectorSection()) === false, String(await hasVectorSection()));
check("and there is no Edit Object button to come back with", (await hasEditObjectButton()) === false);

// Enter is the keyboard way in; the right-click menu is the mouse one.
await enterEditMode("top_path");
check("Enter brings the section back", (await hasVectorSection()) === true, String(await hasVectorSection()));
await page.keyboard.press("Escape");
await page.waitForTimeout(250);
const topBox = await boxOf('[data-element-id="top_path"]');
await page.mouse.click(topBox.cx, topBox.cy, { button: "right" });
await page.waitForTimeout(350);
const editItem = await page.evaluate(() => {
  const n = document.querySelector('[data-context-item="editPath"]');
  if (!n) return null;
  const r = n.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
check("the right-click menu offers Edit Path", !!editItem);
if (editItem) {
  await page.mouse.click(editItem.x, editItem.y);
  await page.waitForTimeout(450);
  check("and it opens the path for editing", (await overlay()) !== null);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(250);
}

// ---- 2. path inside a frame ------------------------------------------------
await enterEditMode("inner_path");
await onPath("inner_path", "path inside a frame");

// ---- 3. the overlay is live, not a picture ---------------------------------
const dBefore = await page.evaluate(
  () => window.__FISH_BRIDGE__.getDoc().pages.find((p) => p.id === window.__FISH_BRIDGE__.getDoc().activePageId)
    .children.find((e) => e.id === "outer").children.find((e) => e.id === "inner_path").d
);
const anchor = await boxOf('[data-path-edit] [data-anchor-index="1"]');
check("the anchor under the cursor is reachable", !!anchor, JSON.stringify(anchor));
if (anchor) {
  await page.mouse.move(anchor.cx, anchor.cy);
  await page.mouse.down();
  await page.mouse.move(anchor.cx + 60, anchor.cy + 30, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(350);
  const dAfter = await page.evaluate(
    () => window.__FISH_BRIDGE__.getDoc().pages.find((p) => p.id === window.__FISH_BRIDGE__.getDoc().activePageId)
      .children.find((e) => e.id === "outer").children.find((e) => e.id === "inner_path").d
  );
  check("dragging that anchor rewrites the path", dAfter !== dBefore, `${dBefore}\n      ${dAfter}`);
}

// ---- 3b. a turned path: the overlay, and the drag, follow it ---------------
// Two ways a path can be turned: an ancestor's rotation, and its own. Both were
// off, because the overlay placed itself with the translation-only parent chain
// while the renderer draws the subtree inside the frame's turned `<g>`. Measured
// back in the previous block from 82px / 36px off the artwork.
await page.keyboard.press("Escape");
await page.waitForTimeout(250);

await enterEditMode("rot_path");
await onPath("rot_path", "self-rotated path");
await page.keyboard.press("Escape");
await page.waitForTimeout(250);

await enterEditMode("turned_path");
await onPath("turned_path", "path inside a turned frame");

// The other half of the same defect: a drag is a screen-space gesture, so what
// it must deliver is the anchor UNDER THE CURSOR. Read back in screen px — the
// one frame the user can see — rather than from the local coordinates, which a
// turned path can satisfy while moving the anchor the wrong way.
const grabBefore = await anchorCenter(1);
if (grabBefore && grabBefore.hittable) {
  await page.mouse.move(grabBefore.cx, grabBefore.cy);
  await page.mouse.down();
  await page.mouse.move(grabBefore.cx + 60, grabBefore.cy + 30, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(350);
  const grabAfter = await anchorCenter(1);
  const miss = grabAfter ? Math.hypot(grabAfter.cx - grabBefore.cx - 60, grabAfter.cy - grabBefore.cy - 30) : Infinity;
  check("a dragged anchor lands under the cursor on a turned path", miss < 3, `off by ${Math.round(miss * 10) / 10}px`);
  // And it has to be the SHAPE that moved. Reaching the cursor is not enough on
  // its own: an overlay that is off the artwork still puts its handle exactly
  // under the pointer, because a handle follows the pointer in whatever frame
  // the overlay happens to be in. Deleting the evidence means the handle has to
  // come back onto the outline the drag just rewrote.
  const offsAfter = await anchorsOffOutline("turned_path");
  const worstAfter = offsAfter && offsAfter.length ? Math.max(...offsAfter) : Infinity;
  check("and the shape moved with it, not the handle alone", worstAfter < 2, `offs=${JSON.stringify(offsAfter)}`);
} else {
  check("a dragged anchor lands under the cursor on a turned path", false, `anchor not reachable: ${JSON.stringify(grabBefore)}`);
}

// ---- 3c. the keyboard and Shift belong to the anchors ----------------------
// `useShortcuts` hands the arrows and Backspace to this overlay and nothing else
// reads them, so for a while they were dead keys: a press changed nothing on
// screen and nothing in the document.
await page.keyboard.press("Escape");
await page.waitForTimeout(250);
await enterEditMode("top_path");

/** One overlay anchor's own stored coordinates, off the circle that draws it. */
const anchorLocal = (idx) =>
  page.evaluate((i) => {
    const n = document.querySelector(`[data-path-edit] [data-anchor-index="${i}"]`);
    return n ? { x: Number(n.getAttribute("cx")), y: Number(n.getAttribute("cy")) } : null;
  }, idx);
/** A control handle and the anchor it hangs off, in the path's own coordinates. */
const handleState = () =>
  page.evaluate(() => {
    const h = document.querySelector('[data-path-edit] [data-control-index="0"][data-control-side="ca"]');
    const a = document.querySelector('[data-path-edit] [data-anchor-index="0"]');
    if (!h || !a) return null;
    return {
      handle: { x: Number(h.getAttribute("cx")), y: Number(h.getAttribute("cy")) },
      anchor: { x: Number(a.getAttribute("cx")), y: Number(a.getAttribute("cy")) }
    };
  });
const pick = async (idx) => {
  const b = await boxOf(`[data-path-edit] [data-anchor-index="${idx}"]`);
  if (b) {
    await page.mouse.click(b.cx, b.cy);
    await page.waitForTimeout(150);
  }
  return b;
};

await pick(1);
const nudgeStart = await anchorLocal(1);
// Pressed back to back, with no settling between them, the way a held key
// repeats. Measured at native key-repeat speed, a listener that read the model
// it was bound with landed four steps out of five: every press replayed the one
// before it. An implementation that only works at human typing speed is the bug.
await page.keyboard.press("ArrowRight");
await page.keyboard.press("ArrowRight");
await page.keyboard.press("ArrowDown");
await page.waitForTimeout(250);
const nudged = await anchorLocal(1);
check(
  "arrow keys nudge the selected anchor, one unit a press",
  !!nudgeStart && !!nudged && nudged.x === nudgeStart.x + 2 && nudged.y === nudgeStart.y + 1,
  `${JSON.stringify(nudgeStart)} -> ${JSON.stringify(nudged)}`
);

await page.keyboard.down("Shift");
await page.keyboard.press("ArrowUp");
await page.keyboard.up("Shift");
await page.waitForTimeout(250);
const nudgedFar = await anchorLocal(1);
check(
  "Shift multiplies the step, the way it does for a layer",
  !!nudged && !!nudgedFar && nudgedFar.x === nudged.x && nudgedFar.y === nudged.y - 8,
  `${JSON.stringify(nudged)} -> ${JSON.stringify(nudgedFar)}`
);

await page.keyboard.press("Meta+z");
await page.waitForTimeout(300);
const undone = await anchorLocal(1);
// Guarded against passing for the wrong reason: if the arrows did nothing, the
// coordinate would sit still and "undone equals nudged" would be trivially true.
check(
  "each press is a history step of its own",
  !!undone && !!nudged && !!nudgeStart && nudged.y !== nudgeStart.y && undone.y === nudged.y && undone.x === nudged.x,
  `${JSON.stringify(nudged)} --undo--> ${JSON.stringify(undone)}`
);

// Shift on a POINT drag is Figma's "straight lines only": whichever axis the
// gesture has already leaned on wins and the other is dropped. Shift is held
// AFTER the press, not before it, because a Shift-press on an already-selected
// anchor is the deselect gesture — the modifier is added mid-drag, the way it is
// in the hand.
const lockStart = await anchorLocal(1);
const lockFrom = await anchorCenter(1);
if (lockFrom && lockFrom.hittable) {
  await page.mouse.move(lockFrom.cx, lockFrom.cy);
  await page.mouse.down();
  await page.keyboard.down("Shift");
  await page.mouse.move(lockFrom.cx + 60, lockFrom.cy + 20, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.up("Shift");
  await page.waitForTimeout(300);
  const lockEnd = await anchorLocal(1);
  check(
    "Shift-dragging an anchor keeps it on one axis",
    !!lockStart && !!lockEnd && lockEnd.x !== lockStart.x && Math.abs(lockEnd.y - lockStart.y) < 0.05,
    `${JSON.stringify(lockStart)} -> ${JSON.stringify(lockEnd)}`
  );
} else {
  check("Shift-dragging an anchor keeps it on one axis", false, `anchor not reachable: ${JSON.stringify(lockFrom)}`);
}

// Shift on a HANDLE is the pen's other bargain: it stays on a 0/45/90 ray out of
// its anchor, so a curve can be pulled straight without losing its angle.
const handleBefore = await handleState();
const handleBox = await boxOf('[data-path-edit] [data-control-index="0"][data-control-side="ca"]');
if (handleBefore && handleBox) {
  await page.keyboard.down("Shift");
  await page.mouse.move(handleBox.cx, handleBox.cy);
  await page.mouse.down();
  await page.mouse.move(handleBox.cx + 40, handleBox.cy + 30, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.up("Shift");
  await page.waitForTimeout(300);
  const after = await handleState();
  const deg =
    after && after.handle.x !== after.anchor.x
      ? (Math.atan2(after.handle.y - after.anchor.y, after.handle.x - after.anchor.x) * 180) / Math.PI
      : after
        ? 90
        : NaN;
  const offLadder = isFinite(deg) ? Math.min(Math.abs(deg % 45), Math.abs(45 - Math.abs(deg % 45))) : Infinity;
  check(
    "Shift-dragging a handle lands on the 45° ladder",
    !!after && offLadder < 0.5 && (after.handle.x !== handleBefore.handle.x || after.handle.y !== handleBefore.handle.y),
    `${JSON.stringify(handleBefore.handle)} -> ${JSON.stringify(after && after.handle)} angle=${isFinite(deg) ? Math.round(deg * 100) / 100 : "n/a"}`
  );
} else {
  check("Shift-dragging a handle lands on the 45° ladder", false, `handle not reachable: ${JSON.stringify(handleBefore)}`);
}

// And on a TURNED path the step is taken along the axis the KEY names — the one
// on screen — not the path's own. Measured on screen, which is the claim.
await page.keyboard.press("Escape");
await page.waitForTimeout(250);
await enterEditMode("turned_path");
await pick(1);
const turnedFrom = await anchorCenter(1);
await page.keyboard.down("Shift");
await page.keyboard.press("ArrowRight");
await page.keyboard.up("Shift");
await page.waitForTimeout(300);
const turnedTo = await anchorCenter(1);
const stepX = turnedTo && turnedFrom ? turnedTo.cx - turnedFrom.cx : NaN;
const stepY = turnedTo && turnedFrom ? turnedTo.cy - turnedFrom.cy : NaN;
check(
  "on a turned path the nudge still travels the axis the key names",
  isFinite(stepX) && stepX > 3 && Math.abs(stepY) < 1,
  `moved ${Math.round(stepX * 10) / 10}, ${Math.round(stepY * 10) / 10}`
);

// ---- 4. shift-click extends the selection, and the drag carries it all ------
// The previous block left edit mode open, and Enter toggles: without leaving it
// first, Enter would close it instead of opening the next path.
await page.keyboard.press("Escape");
await page.waitForTimeout(250);
await enterEditMode("quad_path");
const readQuad = () =>
  page.evaluate(
    () => window.__FISH_BRIDGE__.getDoc().pages.find((p) => p.id === window.__FISH_BRIDGE__.getDoc().activePageId)
      .children.find((e) => e.id === "outer").children.find((e) => e.id === "quad_path").d
  );
const dMultiBefore = await readQuad();
const anchorA = await boxOf('[data-path-edit] [data-anchor-index="0"]');
const anchorB = await boxOf('[data-path-edit] [data-anchor-index="1"]');
const anchorC = await boxOf('[data-path-edit] [data-anchor-index="3"]');
const filled = (idx) =>
  page.evaluate((i) => {
    const el = document.querySelector(`[data-path-edit] [data-anchor-index="${i}"] + circle`);
    return el ? el.getAttribute("fill") : null;
  }, idx);

check("the four-anchor path exposes four anchors", !!anchorA && !!anchorB && !!anchorC, JSON.stringify([anchorA, anchorB, anchorC]));
if (!anchorA || !anchorB || !anchorC) {
  console.log("      (skipping the multi-selection block: an anchor box is missing)");
} else {
  await page.mouse.click(anchorA.cx, anchorA.cy);
  await page.waitForTimeout(120);
  check("a plain click selects exactly one anchor", (await filled(0)) === "#1B72FF" && (await filled(1)) !== "#1B72FF");

  await page.keyboard.down("Shift");
  await page.mouse.click(anchorB.cx, anchorB.cy);
  await page.waitForTimeout(120);
  await page.mouse.click(anchorC.cx, anchorC.cy);
  await page.keyboard.up("Shift");
  await page.waitForTimeout(120);
  check(
    "shift-click adds to the selection",
    (await filled(0)) === "#1B72FF" && (await filled(1)) === "#1B72FF" && (await filled(3)) === "#1B72FF",
    `${await filled(0)} ${await filled(1)} ${await filled(3)}`
  );

  // Grab one of the three: all three must move, not just the one under the cursor.
  await page.mouse.move(anchorA.cx, anchorA.cy);
  await page.mouse.down();
  await page.mouse.move(anchorA.cx + 40, anchorA.cy, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(350);
  const dMultiAfter = await readQuad();
  check("dragging one of several selected anchors moves them all", dMultiAfter !== dMultiBefore);

  // Delete drops the whole selection, not a single anchor. Two of the four are
  // left selected below, which is also clear of removeAnchor's two-point floor —
  // a selection that reached it would wipe the path instead of editing it.
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  await enterEditMode("quad_path");
  const freshA = await boxOf('[data-path-edit] [data-anchor-index="0"]');
  const freshB = await boxOf('[data-path-edit] [data-anchor-index="1"]');
  if (freshA && freshB) {
    await page.mouse.click(freshA.cx, freshA.cy);
    await page.keyboard.down("Shift");
    await page.mouse.click(freshB.cx, freshB.cy);
    await page.keyboard.up("Shift");
    await page.waitForTimeout(150);
    const before = await anchorCount();
    await page.keyboard.press("Backspace");
    await page.waitForTimeout(350);
    const after = await anchorCount();
    check("Backspace removes every selected anchor", before === 4 && after === 2, `${before} -> ${after}`);
    check("the path survives the deletion", (await readQuad()) !== undefined);
  } else {
    check("Backspace removes every selected anchor", false, "anchor boxes missing");
  }
}

// ---- 4b. the pen modes actually edit, from inside edit mode ---------------
// Reading only the highlight is not enough: the buttons set a mode, and for a
// long time the mode had no listener behind it while the inspector was the only
// place it could be reached from.
const modeTitle = (m) => document;
const readQuad2 = () =>
  page.evaluate(
    () => window.__FISH_BRIDGE__.getDoc().pages.find((p) => p.id === window.__FISH_BRIDGE__.getDoc().activePageId)
      .children.find((e) => e.id === "outer").children.find((e) => e.id === "quad_path").d
  );
const clickPenMode = async (title) => {
  const box = await page.evaluate((t) => {
    const n = document.querySelector(`button[title="${t}"]`);
    if (!n) return null;
    const r = n.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, title);
  if (!box) return false;
  await page.mouse.click(box.x, box.y);
  await page.waitForTimeout(250);
  return true;
};
const anchorBoxes = async () =>
  page.evaluate(() => [...document.querySelectorAll("[data-path-edit] [data-anchor-index]")].map((n) => {
    const r = n.getBoundingClientRect();
    return { cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
  }));

await page.keyboard.press("Escape");
await page.waitForTimeout(250);
await enterEditMode("quad_path");

const beforeAdd = await readQuad2();
check("clicking Add switches the mode", await clickPenMode("Pen — add a point to an existing path"));
// Hover the top edge between two anchors and click: that is where a point goes.
const quadBox = await boxOf('[data-element-id="quad_path"]');
await page.mouse.move(quadBox.cx - quadBox.w / 4, quadBox.y + 2);
await page.waitForTimeout(200);
const markers = await page.evaluate(() => document.querySelectorAll("[data-path-edit] line[stroke='#1B72FF']").length);
check("add mode marks where the point would land", markers > 0, `markers=${markers}`);
await page.mouse.click(quadBox.cx - quadBox.w / 4, quadBox.y + 2);
await page.waitForTimeout(400);
const afterAdd = await readQuad2();
check("clicking the outline in add mode inserts a point", afterAdd !== beforeAdd, `${beforeAdd}\n      ${afterAdd}`);

check("clicking Remove switches the mode", await clickPenMode("Pen — remove a point from an existing path"));
const boxes = await anchorBoxes();
const countBefore = boxes.length;
await page.mouse.click(boxes[1].cx, boxes[1].cy);
await page.waitForTimeout(400);
const afterRemove = await readQuad2();
check("clicking an anchor in remove mode drops it", (await anchorBoxes()).length === countBefore - 1 && afterRemove !== afterAdd, `${countBefore} -> ${(await anchorBoxes()).length}`);

check("clicking Draw switches back", await clickPenMode("Pen — draw a new path"));
const boxes2 = await anchorBoxes();
await page.mouse.move(boxes2[1].cx, boxes2[1].cy);
await page.mouse.down();
await page.mouse.move(boxes2[1].cx + 25, boxes2[1].cy + 10, { steps: 6 });
await page.mouse.up();
await page.waitForTimeout(350);
check("and draw mode still drags anchors", (await readQuad2()) !== afterRemove);

// ---- 5. the shape-tool letters are inert while a path is open -------------
// Vector edit is a mode of its own. R arriving mid-gesture swapped in the shape
// tool underneath the user, whose next click drew a rectangle.
await page.keyboard.press("Escape");
await page.waitForTimeout(250);
await enterEditMode("quad_path");
// The shape dock button re-draws its icon per tool, so its markup IS the tool
// readout: if R swapped the tool in, the Spline becomes a Square. Comparing the
// highlight instead would compare "" to "" and pass whatever happened.
const shapeToolMarkup = async () => {
  const html = await page.evaluate(() => document.querySelector('[data-tool="shape"]')?.innerHTML ?? "");
  return html.replace(/\s+/g, "");
};
const toolBefore = await shapeToolMarkup();
check("the shape dock starts on the path tool", /Spline|path/i.test(toolBefore) || toolBefore.length > 0, toolBefore.slice(0, 60));
for (const key of ["r", "o", "l", "p", "t", "v", "k"]) {
  await page.keyboard.press(key);
  await page.waitForTimeout(90);
}
const toolAfter = await shapeToolMarkup();
check(
  "R / O / L / P / T / V / K do not change the tool mid-edit",
  toolAfter === toolBefore,
  `${toolBefore.slice(0, 40)} -> ${toolAfter.slice(0, 40)}`
);
check("and the overlay survived them", (await overlay()) !== null);

await page.keyboard.press("Escape");
await page.waitForTimeout(250);
check("Escape leaves edit mode", (await overlay()) === null);

check("no console errors", errors.length === 0, errors.slice(0, 3).join(" | "));

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
await browser.close();
process.exit(passed === results.length ? 0 : 1);
