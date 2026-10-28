import { chromium } from "playwright";
import { pathToFileURL } from "node:url";
import path from "node:path";
import zlib from "node:zlib";

// A double click on a painted image opens its fill row on the same terms as a
// double click on a text opens its editor: only once the layer is ALREADY the
// selection when the second press arrives. An image nested in a frame therefore
// takes two double clicks — the first one reaching it at all, the second one
// opening the panel — which is the reading the nested text has always had.
//
// Both gestures used to be answered in different places: the text on the press
// (before the piercing rules run) and the image on the DOM `dblclick` (after
// them). By then the very double click that was meant to SELECT a nested image
// had already selected it, so the panel opened on the first one — and the layer
// could never be reached without it.
//
// The gesture never changes `fit`. But the panel's Fit segment reads Crop for a
// layer the DOCUMENT already frames, so an image that has been cropped gets the
// canvas chrome back with its row, while a cover image stays out of crop mode.
const html = path.resolve(process.cwd(), process.argv[2] ?? "dist/index.html");
const results = [];
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  results.push({ name, ok: !!ok });
}

const W = 200;
const H = 120;
const NAT = 64;

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
function solidPng(size) {
  const raw = Buffer.alloc(size * (1 + size * 4));
  let o = 0;
  for (let y = 0; y < size; y++) {
    raw[o++] = 0;
    for (let x = 0; x < size; x++) {
      raw[o++] = 0x3e;
      raw[o++] = 0x63;
      raw[o++] = 0xdd;
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
    id: "tile",
    name: "tile",
    width: NAT,
    height: NAT,
    uri: `data:image/png;base64,${solidPng(NAT).toString("base64")}`
  }
];

const img = () => ({ type: "image", assetId: "tile", fit: "cover" });

const ELEMENTS = [
  {
    id: "card",
    type: "frame",
    name: "Card",
    x: 80,
    y: 120,
    width: 320,
    height: 220,
    fills: [{ type: "solid", color: "#E4E4E4" }],
    children: [
      { id: "pic", type: "rect", name: "Pic", x: 60, y: 50, width: W, height: H, fills: [img()] }
    ]
  },
  { id: "loose", type: "rect", name: "Loose", x: 560, y: 180, width: W, height: H, fills: [img()] },
  { id: "cropped", type: "rect", name: "Cropped", x: 560, y: 380, width: W, height: H, fills: [img()] }
];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});

await page.goto(pathToFileURL(html).href);
await page.waitForFunction(() => !!window.__FISH_BRIDGE__);
await page.evaluate(
  ({ assets, elements }) => {
    const base = window.__FISH_BRIDGE__.getDoc();
    window.__FISH_BRIDGE__.setElements(JSON.parse(JSON.stringify(elements)), {
      canvas: { ...base.canvas, width: 1920, height: 1080 },
      assets
    });
  },
  { assets: ASSETS, elements: ELEMENTS }
);
await page.waitForTimeout(600);

// ---- helpers ------------------------------------------------------------------
const centreOf = (id) =>
  page.evaluate((elId) => {
    const n = document.querySelector(`[data-element-id="${elId}"]`);
    if (!n) return null;
    const b = n.getBoundingClientRect();
    return { cx: Math.round(b.left + b.width / 2), cy: Math.round(b.top + b.height / 2) };
  }, id);
const count = (sel) => page.evaluate((q) => document.querySelectorAll(q).length, sel);
const panel = () => count("[data-color-panel]");
const cropChrome = () => count("[data-image-crop-overlay]");
const selected = () => page.evaluate(() => window.__FISH_BRIDGE__.getSelectedIds());
const only = (ids, id) => ids.length === 1 && ids[0] === id;
const fitOf = (id) =>
  page.evaluate((elId) => {
    const doc = window.__FISH_BRIDGE__.getDoc();
    const els = doc.pages.find((p) => p.id === doc.activePageId).children;
    let found = null;
    const walk = (list) =>
      list.forEach((e) => {
        if (e.id === elId) found = e;
        if (e.children) walk(e.children);
      });
    walk(els);
    return found ? found.fills[found.fills.length - 1].fit : null;
  }, id);
const select = async (id) => {
  await page.evaluate((elId) => window.__FISH_BRIDGE__.selectElement(elId), id);
  await page.waitForTimeout(250);
};
const dbl = async (c) => {
  await page.mouse.move(c.cx, c.cy);
  await page.mouse.dblclick(c.cx, c.cy, { delay: 40 });
  await page.waitForTimeout(300);
};
/** A press on empty canvas, clear of the frame, the panels and the dock. */
const canvasSpot = await page.evaluate(() => {
  const r = document.querySelector("[data-canvas-root]").getBoundingClientRect();
  return { x: r.x + r.width * 0.5, y: r.y + r.height - 80 };
});
const deselect = async () => {
  await page.mouse.click(canvasSpot.x, canvasSpot.y);
  await page.waitForTimeout(250);
};
/** Escape closes the panel, and takes the selection with it. */
const closePanel = async () => {
  for (let i = 0; i < 3 && (await panel()) > 0; i++) {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(250);
  }
};

const pic = await centreOf("pic");
const loose = await centreOf("loose");
const cropped = await centreOf("cropped");

// ------------------------------------------- an image nested in a frame (card)
await deselect();
await dbl(pic);
check("nested: a double click selects the image", only(await selected(), "pic"), JSON.stringify(await selected()));
check("nested: that double click does NOT open the fill panel", (await panel()) === 0, `panel=${await panel()}`);

await dbl(pic);
check("nested: the next double click opens the fill panel", (await panel()) === 1, `panel=${await panel()}`);
check("and the image is still what is selected", only(await selected(), "pic"), JSON.stringify(await selected()));

// ------------------------------------------------- a canvas-level image
await closePanel();
await deselect();
await dbl(loose);
check(
  "control — a canvas-level image still opens on the FIRST double click",
  (await panel()) === 1 && only(await selected(), "loose"),
  JSON.stringify({ panel: await panel(), selected: await selected() })
);

// --------------------------------- and from nothing selected it is select-then-open
await closePanel();
await deselect();
await dbl(pic);
check(
  "nested: after closing, a double click selects only again",
  (await panel()) === 0 && only(await selected(), "pic"),
  JSON.stringify({ panel: await panel(), selected: await selected() })
);

// ------------------------------------- an image the user has already cropped
//
// The panel's Fit segment reads Crop for such a layer, because the DOCUMENT is
// in crop framing. A canvas that then shows no crop handles is describing a mode
// that is not on, so re-opening the row hands the chrome back — without writing
// a new framing, which would be an undo step for a gesture that edited nothing.
await closePanel();
await deselect();
await select("cropped");
await page.click('[data-paint-swatch="0"]');
await page.waitForTimeout(300);
await page.click('[data-image-crop="1"]');
await page.waitForTimeout(500);
check("setup: choosing Crop puts the layer in crop framing", (await fitOf("cropped")) === "crop", `fit=${await fitOf("cropped")}`);
check("setup: and the canvas shows the crop chrome", (await cropChrome()) === 1, `overlay=${await cropChrome()}`);

await closePanel();
await deselect();
check("leaving the mode keeps the framing the document gained", (await fitOf("cropped")) === "crop", `fit=${await fitOf("cropped")}`);
check("and takes the canvas chrome with it", (await cropChrome()) === 0, `overlay=${await cropChrome()}`);

await dbl(cropped);
check("a cropped image: the double click opens the fill panel", (await panel()) === 1, `panel=${await panel()}`);
check(
  "and hands back the crop chrome the panel reports",
  (await cropChrome()) === 1,
  `overlay=${await cropChrome()}`
);
check("without writing a new framing", (await fitOf("cropped")) === "crop", `fit=${await fitOf("cropped")}`);

// ------------------------------------------- the row's own door, not a double click
//
// A single click on the swatch opens the same panel, and the panel reports Crop
// either way. The chrome is a property of that row being OPEN — a canvas with no
// handles under a panel reading Crop is describing a mode that is not on — so
// the second door has to hand it over too, without a commit.
await closePanel();
await deselect();
check("setup: closing the panel took the crop chrome with it", (await cropChrome()) === 0, `overlay=${await cropChrome()}`);
await select("cropped");
await page.click('[data-paint-swatch="0"]');
await page.waitForTimeout(400);
check(
  "the row's own swatch opens the panel and its crop chrome together",
  (await panel()) === 1 && (await cropChrome()) === 1,
  JSON.stringify({ panel: await panel(), overlay: await cropChrome() })
);
check("still without writing a framing", (await fitOf("cropped")) === "crop", `fit=${await fitOf("cropped")}`);

// Escape is still the way out of the mode while the row stays up: re-arming it
// on every render would turn that key into a no-op.
await page.keyboard.press("Escape");
await page.waitForTimeout(300);
check(
  "Escape leaves the mode and leaves the row open",
  (await cropChrome()) === 0 && (await panel()) === 1,
  JSON.stringify({ overlay: await cropChrome(), panel: await panel() })
);


await closePanel();
await deselect();
await dbl(loose);
check(
  "control — a cover image opens the panel and stays out of crop mode",
  (await panel()) === 1 && (await cropChrome()) === 0,
  JSON.stringify({ panel: await panel(), overlay: await cropChrome() })
);
check("and its framing is the one it already had", (await fitOf("loose")) === "cover", `fit=${await fitOf("loose")}`);

const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} passed`);
if (errors.length) console.log("pageErrors", errors);
await browser.close();
process.exit(passed === results.length && errors.length === 0 ? 0 : 1);
