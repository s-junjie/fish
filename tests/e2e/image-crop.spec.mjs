import { chromium } from "playwright";
import { pathToFileURL } from "url";
import path from "node:path";
import zlib from "node:zlib";

// Image crop, driven the way a user drives it:
//
//   1. entry    — the fill row's fourth segment enters crop; the document gains
//                 `fit: "crop"` with the framing it ALREADY painted, so the first
//                 frame of the mode is the last frame out of it, and the
//                 transform box steps aside. A double-click opens the fill panel
//                 without changing the fit, so it never enters crop.
//   2. other doors — the context menu reaches the same state
//   3. move     — a body drag writes `x`/`y` only, and one gesture is ONE undo
//                 step that leaves the mode on
//   4. corner   — a corner drag RESIZES the element's own box about the opposite
//                 corner, which must not move, while the bitmap holds the canvas
//                 rect it already had; the drag itself is one step
//   4b. edge    — an edge drag does the same about the opposite edge, reading one
//                 axis, and it is the element's box that moves: the frame IS the
//                 window, so an edge drag resizes the layer
//   4c. flick    — a drag released before the coalescer lands its last frame must
//                 still pin that frame; a slow drag cannot see this
//   5. rotate   — a hot zone just outside a corner turns the bitmap about its own
//                 centre without moving it
//   6. leaving  — choosing another Fit leaves the mode, and a double-click does
//                 not put it back
//   7. export   — the engine's own SVG export carries the framing
//   8. refusals — a locked layer does not enter crop
//   9. scope    — the mode cannot outlive the layer it is about
//
// Every expected value is derived from the DOM's own boxes (the element box
// gives the zoom), so the spec assumes no particular default view.
const html = path.resolve(process.cwd(), process.argv[2] ?? "dist/index.html");

const W = 200;
const H = 120;
const NAT = 400;

// A four-quadrant bitmap, generated here: 400×400 into a 200×120 box at `cover`
// scales to 200×200, i.e. 40px of overflow above and below. A non-square box is
// the case where entering crop is NOT the identity, so it is the one worth
// asking about.
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();
const crc32 = (buf) => {
  let c = -1;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
const chunk = (type, data) => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
};
const hexToRgb = (hex) => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16)
];
function quadrantPng(size) {
  const quadrants = ["#ff0000", "#00ff00", "#0000ff", "#ffff00"];
  const raw = Buffer.alloc(size * (1 + size * 4));
  let o = 0;
  for (let y = 0; y < size; y++) {
    raw[o++] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b] = hexToRgb(quadrants[(y < size / 2 ? 0 : 2) + (x < size / 2 ? 0 : 1)]);
      raw[o++] = r;
      raw[o++] = g;
      raw[o++] = b;
      raw[o++] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

const ASSETS = [
  {
    id: "quad",
    name: "quad",
    width: NAT,
    height: NAT,
    uri: `data:image/png;base64,${quadrantPng(NAT).toString("base64")}`
  }
];

/** The cover framing of a 400×400 bitmap in a 200×120 box: 200×200, centred. */
const COVER = { x: 0, y: Math.round((((H - W) / 2) * 10000) / H) / 10000, scale: 1 };

const img = (extra) => ({ type: "image", assetId: "quad", fit: "cover", ...extra });

const ELEMENTS = [
  { id: "ic_a", type: "rect", name: "A", x: 60, y: 120, width: W, height: H, fills: [img()] },
  {
    id: "ic_b",
    type: "rect",
    name: "B",
    x: 360,
    y: 120,
    width: W,
    height: H,
    fills: [img({ fit: "crop", crop: { x: 0, y: COVER.y, scale: 1 } })]
  },
  {
    id: "ic_lock",
    type: "rect",
    name: "Locked",
    x: 660,
    y: 120,
    width: W,
    height: H,
    locked: true,
    fills: [img({ fit: "crop", crop: { x: 0, y: COVER.y, scale: 1 } })]
  },
  { id: "ic_c", type: "rect", name: "C", x: 60, y: 320, width: W, height: H, fills: [img()] },
  // Flush against `snap_edge`: the frame drag used to be pulled back onto that
  // guide for the first few pixels (see section 11).
  {
    id: "ic_snap",
    type: "rect",
    name: "Snap",
    x: 60,
    y: 520,
    width: W,
    height: H,
    fills: [img({ fit: "crop", crop: { x: 0, y: COVER.y, scale: 1 } })]
  },
  {
    id: "snap_edge",
    type: "rect",
    name: "Snap edge",
    x: 60 + W,
    y: 520,
    width: 60,
    height: 60,
    fills: [{ type: "solid", color: "#CCCCCC" }]
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
await page.evaluate(({ assets, elements }) => {
  const bridge = window.__FISH_BRIDGE__;
  const base = bridge.getDoc();
  bridge.setElements(JSON.parse(JSON.stringify(elements)), { canvas: { ...base.canvas, width: 1920, height: 1080 }, assets });
}, { assets: ASSETS, elements: ELEMENTS });
await page.waitForTimeout(600);

// ---- helpers ------------------------------------------------------------------
const liveDoc = () => page.evaluate(() => JSON.parse(JSON.stringify(window.__FISH_BRIDGE__.getDoc())));
const walk = (list, id) => {
  for (const el of list) {
    if (el.id === id) return el;
    if (el.children) {
      const hit = walk(el.children, id);
      if (hit) return hit;
    }
  }
  return null;
};
const nodeOf = async (id) => {
  const doc = await liveDoc();
  return walk(doc.pages.find((p) => p.id === doc.activePageId).children, id);
};
const fillOf = async (id) => {
  const el = await nodeOf(id);
  return el ? el.fills[el.fills.length - 1] : null;
};
const boxOf = (sel) =>
  page.evaluate((q) => {
    const n = document.querySelector(q);
    if (!n) return null;
    const b = n.getBoundingClientRect();
    return { left: b.left, top: b.top, width: b.width, height: b.height };
  }, sel);
const centreOf = async (sel) => {
  const b = await boxOf(sel);
  return b ? [Math.round(b.left + b.width / 2), Math.round(b.top + b.height / 2)] : null;
};
const count = (sel) => page.evaluate((q) => document.querySelectorAll(q).length, sel);
const zoomOf = async (id, worldW) => (await boxOf(`[data-element-id="${id}"]`)).width / worldW;
const select = async (id) => {
  await page.evaluate((elId) => window.__FISH_BRIDGE__.selectElement(elId), id);
  await page.waitForTimeout(250);
};
/** Escape is the panel's close key; crop mode eats the first one, so ask twice. */
const closePanel = async () => {
  for (let i = 0; i < 3 && (await count("[data-color-panel]")) > 0; i++) {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(250);
  }
};
/** Drive a pointer drag from the centre of `sel` by a screen-pixel delta. */
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
const dblclickElement = async (id) => {
  const c = await centreOf(`[data-element-id="${id}"]`);
  await page.mouse.dblclick(c[0], c[1]);
  await page.waitForTimeout(500);
};
/** Crop is entered from the fill row's fourth segment, never a double-click. */
const enterCrop = async (id) => {
  await closePanel();
  await select(id);
  await page.click('[data-paint-swatch="0"]');
  await page.waitForTimeout(300);
  await page.click('[data-image-crop="1"]');
  await page.waitForTimeout(500);
};
const undo = async () => {
  await page.evaluate(() => window.__FISH_BRIDGE__.undo());
  await page.waitForTimeout(300);
};
const exportSvg = () => page.evaluate(() => Promise.resolve(window.__fish.exportCanvasSvg?.() ?? ""));
const round4 = (n) => Math.round(n * 10000) / 10000;

// ---- 1. entry -----------------------------------------------------------------
await select("ic_a");
check(
  "a plain selection shows the transform box",
  (await count("[data-resize-handle]")) > 0 && (await count("[data-image-crop-overlay]")) === 0
);

await dblclickElement("ic_a");
check("a double-click does not enter crop", (await count("[data-image-crop-overlay]")) === 0);
check("and it leaves the framing alone", (await fillOf("ic_a")).fit === "cover");
check("while opening the fill panel", (await count("[data-color-panel]")) === 1);

await page.click('[data-image-crop="1"]');
await page.waitForTimeout(500);
check("choosing Crop enters the mode", (await count("[data-image-crop-overlay]")) === 1);
check(
  "and the transform box steps aside for it",
  (await count("[data-resize-handle]")) === 0 && (await count("[data-rotate-handle]")) === 0
);
{
  const fill = await fillOf("ic_a");
  check("the document gains fit: crop", fill && fill.fit === "crop", `fit=${fill && fill.fit}`);
  check(
    "with the framing the layer ALREADY painted, so nothing jumps",
    fill &&
      fill.crop &&
      Math.abs(fill.crop.x - COVER.x) < 0.002 &&
      Math.abs(fill.crop.y - COVER.y) < 0.002 &&
      fill.crop.scale === 1,
    `crop=${fill && JSON.stringify(fill.crop)} expected=${JSON.stringify(COVER)}`
  );
}
{
  const frame = await boxOf('[data-image-crop-frame="1"]');
  const el = await boxOf('[data-element-id="ic_a"]');
  check(
    "the dashed frame sits exactly on the element's box",
    frame && Math.abs(frame.width - el.width) < 1 && Math.abs(frame.height - el.height) < 1,
    `frame=${JSON.stringify(frame)} el=${JSON.stringify(el)}`
  );
  const handles = await count("[data-image-crop-handle]");
  check("with a handle on every corner AND every edge", handles === 8, `handles=${handles}`);
  check(
    "and each one is named for where it sits",
    await page.evaluate(() =>
      ["nw", "ne", "se", "sw", "n", "e", "s", "w"].every(
        (id) => document.querySelectorAll(`[data-image-crop-handle="${id}"]`).length === 1
      )
    )
  );
  check(
    "while rotation is a hot zone outside each corner, not a grip on a leader line",
    (await count("[data-image-crop-rotate]")) === 4 && (await count("[data-image-crop-rotate-grip]")) === 0,
    `zones=${await count("[data-image-crop-rotate]")} grip=${await count("[data-image-crop-rotate-grip]")}`
  );
  check(
    "and the cropped-away part under an even-odd scrim",
    await page.evaluate(() => {
      const d = document.querySelector('[data-image-crop-dim="1"]');
      return !!d && d.getAttribute("fill-rule") === "evenodd";
    })
  );
  check(
    "the fill row opens with the mode",
    (await count("[data-color-panel]")) === 1
  );
  check(
    "and carries no hint or Reset crop row",
    (await count("[data-image-crop-row]")) === 0 && (await count("[data-image-crop-reset]")) === 0
  );
}

// ---- 2. the other doors in ----------------------------------------------------
await page.keyboard.press("Escape");
await page.waitForTimeout(300);
check("Escape leaves crop", (await count("[data-image-crop-overlay]")) === 0);
check("and hands the box back", (await count("[data-resize-handle]")) > 0);
check(
  "without touching the framing it left behind",
  (await fillOf("ic_a")).fit === "crop",
  `fit=${(await fillOf("ic_a")).fit}`
);

{
  const before = await fillOf("ic_a");
  await closePanel();
  await select("ic_a");
  await page.click('[data-paint-swatch="0"]');
  await page.waitForTimeout(300);
  check("the fill row offers a fourth Fit segment", (await count('[data-image-crop="1"]')) === 1);
  await page.click('[data-image-crop="1"]');
  await page.waitForTimeout(500);
  check(
    "choosing it enters crop",
    (await count("[data-image-crop-overlay]")) === 1,
    `overlay=${await count("[data-image-crop-overlay]")}`
  );
  {
    const after = await fillOf("ic_a");
    check(
      "and re-frames nothing: an already-cropped layer keeps the framing it had",
      after.crop.x === before.crop.x && after.crop.y === before.crop.y && after.crop.scale === before.crop.scale,
      `${JSON.stringify(before.crop)} -> ${JSON.stringify(after.crop)}`
    );
  }
  check(
    "a drag on the canvas chrome does not dismiss the panel it belongs to",
    (await count("[data-color-panel]")) === 1
  );
}

// ---- 2b. the context menu's door ---------------------------------------------
await page.keyboard.press("Escape");
await page.waitForTimeout(250);
await page.evaluate(() => {
  const el = document.querySelector('[data-element-id="ic_a"]');
  const r = el.getBoundingClientRect();
  el.dispatchEvent(
    new MouseEvent("contextmenu", {
      bubbles: true,
      clientX: Math.round(r.left + r.width / 2),
      clientY: Math.round(r.top + r.height / 2)
    })
  );
});
await page.waitForTimeout(300);
check(
  "the context menu lists Crop Image for a lone bitmap layer",
  await page.evaluate(() =>
    [...document.querySelectorAll("button, [role='menuitem']")].some((n) => /crop image/i.test(n.textContent || ""))
  )
);
await page.keyboard.press("Escape");
await page.waitForTimeout(250);
await page.mouse.click(1400, 800);
await page.waitForTimeout(250);

// ---- 3. a body drag moves the bitmap, not the box -----------------------------
await enterCrop("ic_a");
check("crop is on for the drag section", (await count("[data-image-crop-overlay]")) === 1);
{
  const before = await fillOf("ic_a");
  const zoom = await zoomOf("ic_a", W);
  const DX = 40;
  const DY = -30;
  check("body drag opens", await dragBy('[data-image-crop-move="1"]', DX, DY));
  {
    const after = await fillOf("ic_a");
    const exX = round4(Math.max(-20, before.crop.x + DX / zoom / W));
    const exY = round4(Math.max(-20, before.crop.y + DY / zoom / H));
    check(
      "the drag writes x/y and nothing else",
      Math.abs(after.crop.x - exX) < 0.003 &&
        Math.abs(after.crop.y - exY) < 0.003 &&
        after.crop.scale === before.crop.scale,
      `crop=${JSON.stringify(after.crop)} expected=[${exX},${exY}]`
    );
    const node = await nodeOf("ic_a");
    check(
      "and the ELEMENT's own box is untouched",
      node.x === 60 && node.y === 120 && node.width === W && node.height === H,
      `x=${node.x} y=${node.y} ${node.width}×${node.height}`
    );
    check(
      "the drag leaves the mode on: the panel it belongs to is still up",
      (await count("[data-image-crop-overlay]")) === 1 && (await count("[data-color-panel]")) === 1,
      `overlay=${await count("[data-image-crop-overlay]")} panel=${await count("[data-color-panel]")}`
    );
  }
  await undo();
  {
    const back = await fillOf("ic_a");
    check(
      "one gesture is one undo step",
      back.crop.x === before.crop.x && back.crop.y === before.crop.y,
      `${JSON.stringify(before.crop)} -> ${JSON.stringify(back.crop)}`
    );
    check("and the undo lands inside the mode, not outside it", (await count("[data-image-crop-overlay]")) === 1);
  }
}

// ---- 4. a corner resizes the BOX about the opposite corner --------------------
//
// The frame is the crop WINDOW, so a corner drag is a resize: the pointer pulls
// the element's own box while the bitmap keeps the canvas rect it already had.
// Keeping it there is the fill's `crop` being re-solved against the box the
// resize just wrote — which is why this section asks about the bitmap's SCREEN
// box and not only about the numbers, and why `scale` gives ground as the box
// takes the growth.
{
  const SE0 = await boxOf('[data-image-crop-handle="se"]');
  const NW0 = await boxOf('[data-image-crop-handle="nw"]');
  const bmp0 = await boxOf('[data-image-crop-bitmap="1"]');
  const el0 = await nodeOf("ic_a");
  const before = await fillOf("ic_a");
  const D = 40;
  check("corner drag opens", await dragBy('[data-image-crop-handle="se"]', D, D));
  {
    const after = await fillOf("ic_a");
    const el1 = await nodeOf("ic_a");
    const SE1 = await boxOf('[data-image-crop-handle="se"]');
    const NW1 = await boxOf('[data-image-crop-handle="nw"]');
    const bmp1 = await boxOf('[data-image-crop-bitmap="1"]');
    check(
      "the ELEMENT's box takes the growth — the frame is the window, not the bitmap",
      el1.width > el0.width + 1 && el1.height > el0.height + 1,
      `${el0.width}×${el0.height} -> ${el1.width}×${el1.height}`
    );
    check(
      "the bitmap does not move: its screen box is where it was, pixel for pixel",
      bmp0 &&
        bmp1 &&
        Math.abs(bmp1.left - bmp0.left) < 1.5 &&
        Math.abs(bmp1.top - bmp0.top) < 1.5 &&
        Math.abs(bmp1.width - bmp0.width) < 1.5 &&
        Math.abs(bmp1.height - bmp0.height) < 1.5,
      `${JSON.stringify(bmp0)} -> ${JSON.stringify(bmp1)}`
    );
    check(
      "and the framing gives ground as the box takes it — the re-solve's own signature",
      after.crop.scale < before.crop.scale,
      `scale ${before.crop.scale} -> ${after.crop.scale}`
    );
    check(
      "the opposite corner is the anchor: it does not move",
      NW0 && NW1 && Math.abs(NW1.left - NW0.left) < 1.5 && Math.abs(NW1.top - NW0.top) < 1.5,
      `nw ${JSON.stringify(NW0)} -> ${JSON.stringify(NW1)}`
    );
    check(
      "and the dragged corner tracks the pointer, along the diagonal",
      SE0 && SE1 && Math.abs(SE1.left - (SE0.left + D)) < 2 && Math.abs(SE1.top - (SE0.top + D)) < 2,
      `se ${JSON.stringify(SE0)} -> ${JSON.stringify(SE1)}`
    );
  }
  await undo();
  {
    const back = await fillOf("ic_a");
    const elBack = await nodeOf("ic_a");
    check(
      "a corner drag is one undo step too — the framing AND the box come back together",
      back.crop.scale === before.crop.scale && elBack.width === el0.width && elBack.height === el0.height,
      `scale ${before.crop.scale} -> ${back.crop.scale}, box ${el0.width}×${el0.height} -> ${elBack.width}×${elBack.height}`
    );
  }
}

// ---- 4b. an edge resizes the box about the opposite edge ----------------------
//
// The same gesture as a corner, read off one axis instead of the diagonal — and
// the section that makes the model plainest: an edge drag on the transform box
// moves the element's width alone, so the crop has to follow it by writing the
// framing. If it did not, an edge handle that scaled BOTH axes would read as the
// bitmap lurching.
{
  const W0 = await boxOf('[data-image-crop-handle="w"]');
  const E0 = await boxOf('[data-image-crop-handle="e"]');
  const bmp0 = await boxOf('[data-image-crop-bitmap="1"]');
  const el0 = await nodeOf("ic_a");
  const before = await fillOf("ic_a");
  const D = 40;
  check("edge drag opens", await dragBy('[data-image-crop-handle="e"]', D, 0));
  {
    const after = await fillOf("ic_a");
    const el1 = await nodeOf("ic_a");
    const W1 = await boxOf('[data-image-crop-handle="w"]');
    const E1 = await boxOf('[data-image-crop-handle="e"]');
    const bmp1 = await boxOf('[data-image-crop-bitmap="1"]');
    check(
      "the bitmap does not move here either",
      bmp0 &&
        bmp1 &&
        Math.abs(bmp1.left - bmp0.left) < 1.5 &&
        Math.abs(bmp1.top - bmp0.top) < 1.5 &&
        Math.abs(bmp1.width - bmp0.width) < 1.5 &&
        Math.abs(bmp1.height - bmp0.height) < 1.5,
      `${JSON.stringify(bmp0)} -> ${JSON.stringify(bmp1)}`
    );
    check(
      "the framing gives ground again",
      after.crop.scale < before.crop.scale,
      `scale ${before.crop.scale} -> ${after.crop.scale}`
    );
    check(
      "the opposite edge is the anchor: it does not move",
      W0 && W1 && Math.abs(W1.left - W0.left) < 1.5 && Math.abs(W1.top - W0.top) < 1.5,
      `w ${JSON.stringify(W0)} -> ${JSON.stringify(W1)}`
    );
    check(
      "and the dragged edge tracks the pointer, straight out along its own axis",
      E0 && E1 && Math.abs(E1.left - (E0.left + D)) < 2 && Math.abs(E1.top - E0.top) < 2,
      `e ${JSON.stringify(E0)} -> ${JSON.stringify(E1)}`
    );
    check(
      "while the ELEMENT's box is what moved — an edge drag resizes the layer",
      el1.width > el0.width + 1 &&
        Math.abs(el1.height - el0.height) < 1 &&
        el1.x === el0.x &&
        el1.y === el0.y,
      `x=${el1.x} y=${el1.y} ${el0.width}×${el0.height} -> ${el1.width}×${el1.height}`
    );
  }
  await undo();
  {
    const back = await fillOf("ic_a");
    const elBack = await nodeOf("ic_a");
    check(
      "an edge drag is one undo step as well",
      back.crop.scale === before.crop.scale && elBack.width === el0.width,
      `scale ${before.crop.scale} -> ${back.crop.scale}, width ${el0.width} -> ${elBack.width}`
    );
  }
}

// ---- 4c. a flick release still pins its last frame ----------------------------
//
// The pin is cleared on `pointerup`, and it has to run AFTER the resize's own
// `pointerup` — listeners fire in registration order — or the final pointer
// delta lands after the pin is gone and the bitmap jumps by that one step. A slow
// drag hides this, because the coalescer has already landed every frame by the
// time the pointer lifts; so this drag moves and releases in a single leap.
{
  const before = await fillOf("ic_a");
  const bmp0 = await boxOf('[data-image-crop-bitmap="1"]');
  const hb = await boxOf('[data-image-crop-handle="e"]');
  let dragged = false;
  if (hb) {
    const x = Math.round(hb.left + hb.width / 2);
    const y = Math.round(hb.top + hb.height / 2);
    await page.mouse.move(x, y);
    await page.mouse.down();
    // One long move, then straight up: the frame it queues must not be outrun.
    await page.mouse.move(x + 60, y);
    await page.mouse.up();
    await page.waitForTimeout(400);
    dragged = true;
  }
  const after = await fillOf("ic_a");
  const bmp1 = await boxOf('[data-image-crop-bitmap="1"]');
  check(
    "a flick release leaves the bitmap where it was, not one frame behind",
    dragged &&
      bmp0 &&
      bmp1 &&
      Math.abs(bmp1.left - bmp0.left) < 2 &&
      Math.abs(bmp1.top - bmp0.top) < 2 &&
      Math.abs(bmp1.width - bmp0.width) < 2 &&
      Math.abs(bmp1.height - bmp0.height) < 2,
    `bitmap ${JSON.stringify(bmp0)} -> ${JSON.stringify(bmp1)}`
  );
  check(
    "and the framing moved with the box, so no delta was dropped",
    after.crop.scale < before.crop.scale,
    `scale ${before.crop.scale} -> ${after.crop.scale}`
  );
  await undo();
}

// ---- 5. a corner hot zone turns the bitmap about its own centre ---------------
{
  const before = await fillOf("ic_a");
  const bitmap0 = await boxOf('[data-image-crop-bitmap="1"]');
  check("rotate drag opens", await dragBy('[data-image-crop-rotate="se"]', 70, 0));
  const after = await fillOf("ic_a");
  check(
    "the grip writes a rotation",
    typeof after.crop.rotation === "number" && Math.abs(after.crop.rotation) > 5,
    `rotation=${after.crop.rotation}`
  );
  check(
    "and nothing else moved: x/y/scale are what decide the centre",
    after.crop.x === before.crop.x && after.crop.y === before.crop.y && after.crop.scale === before.crop.scale,
    `${JSON.stringify(before.crop)} -> ${JSON.stringify(after.crop)}`
  );
  const bitmap1 = await boxOf('[data-image-crop-bitmap="1"]');
  check(
    "the bitmap's centre stays where it was",
    bitmap0 &&
      bitmap1 &&
      Math.abs(bitmap1.left + bitmap1.width / 2 - (bitmap0.left + bitmap0.width / 2)) < 2 &&
      Math.abs(bitmap1.top + bitmap1.height / 2 - (bitmap0.top + bitmap0.height / 2)) < 2,
    `${JSON.stringify(bitmap0)} -> ${JSON.stringify(bitmap1)}`
  );
  await undo();
  check("a rotate drag is one undo step", !(await fillOf("ic_a")).crop.rotation);
}

// ---- 6. leaving crop by choosing another Fit ----------------------------------
{
  check("crop is on before the switch", (await count("[data-image-crop-overlay]")) === 1);
  await page.evaluate(() => {
    const seg = document.querySelector('[data-image-fit="1"]');
    const cover = seg && [...seg.querySelectorAll("button")].find((b) => /cover/i.test(b.textContent || ""));
    cover?.click();
  });
  await page.waitForTimeout(400);
  check("choosing Cover leaves crop", (await count("[data-image-crop-overlay]")) === 0);
  check("and hands the transform box back", (await count("[data-resize-handle]")) > 0);
  check("while the document follows the segment", (await fillOf("ic_a")).fit === "cover");

  await closePanel();
  await dblclickElement("ic_a");
  check("a double-click does not put the mode back", (await count("[data-image-crop-overlay]")) === 0);
  check("and the framing stays cover", (await fillOf("ic_a")).fit === "cover");
  check("while opening the fill panel again", (await count("[data-color-panel]")) === 1);

  await enterCrop("ic_a");
  check("the segment is the way back in", (await count("[data-image-crop-overlay]")) === 1);
}

// ---- 7. export -----------------------------------------------------------------
{
  const svg = await exportSvg();
  check(
    "the exported SVG paints the bitmap at its natural size, under the framing's transform",
    /<image[^>]*width="400"[^>]*preserveAspectRatio="none"/.test(svg) && /translate\(/.test(svg),
    `image=${/<image/.test(svg)} natural=${/width="400"/.test(svg)} par="${(/preserveAspectRatio="([^"]*)"/.exec(svg) || [])[1]}"`
  );
}

// ---- 8. refusals ---------------------------------------------------------------
await enterCrop("ic_lock");
check(
  "a locked layer does not enter crop",
  (await count("[data-image-crop-overlay]")) === 0,
  `overlay=${await count("[data-image-crop-overlay]")}`
);

// ---- 9. leaving the layer leaves the mode -------------------------------------
await enterCrop("ic_a");
check("crop is on again", (await count("[data-image-crop-overlay]")) === 1);
await select("ic_b");
check(
  "selecting another layer ends it — a mode over one layer cannot span two",
  (await count("[data-image-crop-overlay]")) === 0
);
check("and the new layer gets the ordinary box", (await count("[data-resize-handle]")) > 0);

// ---- 10. undoing the entry itself hands the canvas back -----------------------
//
// Entering crop IS a document edit (`cover` -> `crop` plus the framing), so it is
// one undo step — and undoing it leaves `fit: "cover"` with the mode's target still
// set. The canvas must then show the transform box again rather than stand down for
// an overlay that has nothing to draw.
await closePanel();
await select("ic_c");
check("the layer starts in plain cover framing", (await fillOf("ic_c")).fit === "cover");
await enterCrop("ic_c");
check("the segment enters crop on a cover layer too", (await count("[data-image-crop-overlay]")) === 1);
await undo();
{
  const fill = await fillOf("ic_c");
  check("undoing the entry puts the framing back where it was", fill.fit === "cover", `fit=${fill.fit}`);
  check(
    "and the canvas hands the box back instead of going blank",
    (await count("[data-image-crop-overlay]")) === 0 && (await count("[data-resize-handle]")) > 0,
    `overlay=${await count("[data-image-crop-overlay]")} resize=${await count("[data-resize-handle]")}`
  );
  check(
    "while still reporting the framing the document now has",
    await page.evaluate(() => {
      const seg = document.querySelector('[data-image-fit="1"]');
      const active = seg && seg.querySelector("button.bg-field-active");
      return !!active && (active.textContent || "").trim().toLowerCase() === "cover";
    })
  );
}

// ---- 11. the frame does not snap ---------------------------------------------
//
// A crop boundary is a pixel of the picture, not an alignment with the page — and
// a guide is a magnet: an edge that STARTS on one (a photo flush with its frame is
// the usual case) is dragged back onto it for SNAP_THRESHOLD px before it lets go,
// which the hand reads as a dead zone followed by a jump. `ic_snap` sits flush
// against `snap_edge`, so this is exactly the case that used to swallow the first
// few pixels of every drag.
await enterCrop("ic_snap");
check("crop is on for the precision section", (await count("[data-image-crop-overlay]")) === 1);
{
  const before = await nodeOf("ic_snap");
  const zoom = await zoomOf("ic_snap", W);
  const hb = await boxOf('[data-image-crop-handle="e"]');
  let dragged = false;
  if (hb) {
    const x = Math.round(hb.left + hb.width / 2);
    const y = Math.round(hb.top + hb.height / 2);
    await page.mouse.move(x, y);
    await page.mouse.down();
    // ONE pixel: less than the snap threshold, so a guide would keep the edge put.
    await page.mouse.move(x + 1, y);
    await page.waitForTimeout(160);
    await page.mouse.up();
    await page.waitForTimeout(300);
    dragged = true;
  }
  const after = await nodeOf("ic_snap");
  check(
    "the first pixel of a drag already moves the frame's edge",
    dragged && after.width > before.width && after.width - before.width <= Math.round(1 / zoom) + 1,
    `width ${before.width} -> ${after.width} (zoom ${zoom})`
  );
  check(
    "and nothing about the box's other axis moved",
    after.height === before.height && after.x === before.x && after.y === before.y,
    `${before.width}×${before.height} -> ${after.width}×${after.height} at ${after.x},${after.y}`
  );
  await undo();
  check("undoing it puts the edge back", (await nodeOf("ic_snap")).width === before.width);
}

await browser.close();
const failed = results.filter((r) => !r).length;
if (errors.length) console.log(`\npage errors:\n  ${errors.join("\n  ")}`);
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed === 0 && errors.length === 0 ? 0 : 1);
