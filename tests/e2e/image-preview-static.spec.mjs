import { chromium } from "playwright";
import { pathToFileURL } from "node:url";
import path from "node:path";
import zlib from "node:zlib";

// The panel's preview is a picture of the BITMAP, not of the framing.
//
// Framing is edited on the canvas, where the crop chrome and the tile it belongs
// to are one picture at one scale; the panel's window is where the user goes to
// change the framing, so a thumbnail that re-framed itself would move under the
// very handles being dragged — a second, badly-scaled copy of the control it sits
// directly above, changing at the moment it is least useful. What the preview is
// for is answering "which picture is this row painting", and that answer does not
// move when a crop does.
//
// Measured in PIXELS, because the DOM cannot see the difference: the bounding box
// of an SVG `<image>` is the rect its ATTRIBUTES name — the whole window — so a
// bitmap re-framed inside that window reports the identical box. The window's own
// pixels are the only witness that can tell the two apart, so every "did not
// change" below is a byte-for-byte comparison of a screenshot, and the one "is
// the whole bitmap" is the ink's bounding box inside that screenshot.
const html = path.resolve(process.cwd(), process.argv[2] ?? "dist/index.html");
const results = [];
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  results.push({ name, ok: !!ok });
}

const W = 240;
const H = 240;
const NAT_W = 320;
const NAT_H = 80;
const ASPECT = NAT_W / NAT_H;

// ---- a bitmap, generated here -------------------------------------------------
//
// Four quadrants, each a saturated colour, because a flat one would hide a
// regression: `cover` and `fill` both paint the whole window, so a preview that
// re-framed between them would be pixel-identical if the bitmap were one colour.
// The window's own backdrop is the checkerboard's two greys, so "is this bitmap"
// is a saturation threshold rather than an image comparison.
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
const QUADRANTS = [
  [0x3e, 0x63, 0xdd],
  [0xe0, 0x59, 0x2a],
  [0x2f, 0xae, 0x5b],
  [0xb4, 0x3e, 0xc9]
];
function quadrantPng(w, h) {
  const raw = Buffer.alloc(h * (1 + w * 4));
  let o = 0;
  for (let y = 0; y < h; y++) {
    raw[o++] = 0;
    for (let x = 0; x < w; x++) {
      const [r, g, b] = QUADRANTS[(y < h / 2 ? 0 : 2) + (x < w / 2 ? 0 : 1)];
      raw[o++] = r;
      raw[o++] = g;
      raw[o++] = b;
      raw[o++] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
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
    id: "wide",
    name: "wide",
    width: NAT_W,
    height: NAT_H,
    uri: `data:image/png;base64,${quadrantPng(NAT_W, NAT_H).toString("base64")}`
  },
  {
    id: "tall",
    name: "tall",
    width: NAT_H,
    height: NAT_W,
    uri: `data:image/png;base64,${quadrantPng(NAT_H, NAT_W).toString("base64")}`
  }
];

const ELEMENTS = [
  {
    id: "tile",
    type: "rect",
    name: "Tile",
    x: 200,
    y: 180,
    width: W,
    height: H,
    fills: [{ type: "image", assetId: "wide", fit: "cover" }]
  }
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

// ---- a PNG reader, so a screenshot is pixels and not just bytes ---------------
//
// Only what a Playwright screenshot needs: 8-bit, non-interlaced, the four
// filters the PNG spec allows. `zlib` is already here for the bitmap above.
function decodePng(buf) {
  let o = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat = [];
  while (o + 8 <= buf.length) {
    const len = buf.readUInt32BE(o);
    const type = buf.toString("ascii", o + 4, o + 8);
    const data = buf.subarray(o + 8, o + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    o += 12 + len;
  }
  if (bitDepth !== 8) throw new Error(`unsupported bit depth ${bitDepth}`);
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`unsupported colour type ${colorType}`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);
  let p = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[p++];
    const line = raw.subarray(p, p + stride);
    p += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= channels ? prev[x - channels] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const pa = Math.abs(b - c);
        const pb = Math.abs(a - c);
        const pc = Math.abs(a + b - 2 * c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[x] = v & 0xff;
    }
  }
  return { width, height, channels, data: out };
}

/**
 * Where the BITMAP landed in the window: the box around every pixel that is not
 * the checkerboard's grey.
 */
function inkBox(img) {
  const { width, height, channels, data } = img;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * channels;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      if (Math.max(r, g, b) - Math.min(r, g, b) > 40) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return maxX < 0
    ? null
    : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1, ratio: (maxX - minX + 1) / (maxY - minY + 1) };
}

// ---- helpers ------------------------------------------------------------------
const count = (sel) => page.evaluate((q) => document.querySelectorAll(q).length, sel);
const select = async (id) => {
  await page.evaluate((elId) => window.__FISH_BRIDGE__.selectElement(elId), id);
  await page.waitForTimeout(250);
};
const fillOf = (id) =>
  page.evaluate((elId) => {
    const doc = window.__FISH_BRIDGE__.getDoc();
    const active = doc.pages.find((p) => p.id === doc.activePageId);
    let found = null;
    const walk = (list) =>
      list.forEach((e) => {
        if (e.id === elId) found = e;
        if (e.children) walk(e.children);
      });
    walk(active.children);
    return found ? found.fills[found.fills.length - 1] : null;
  }, id);
/** The preview window, as the browser painted it. */
const shot = () => page.locator("[data-color-panel] [data-image-preview]").screenshot();
const boxOf = (sel) =>
  page.evaluate((q) => {
    const n = document.querySelector(q);
    if (!n) return null;
    const b = n.getBoundingClientRect();
    return { left: b.left, top: b.top, width: b.width, height: b.height };
  }, sel);
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
/** A Fit segment, by the label it shows. */
const chooseFit = async (label) => {
  await page.evaluate((want) => {
    const seg = document.querySelector('[data-image-fit="1"]');
    const hit = seg && [...seg.querySelectorAll("button")].find((b) => new RegExp(want, "i").test(b.textContent || ""));
    hit?.click();
  }, label);
  await page.waitForTimeout(400);
};
const closePanel = async () => {
  for (let i = 0; i < 3 && (await count("[data-color-panel]")) > 0; i++) {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(250);
  }
};

// ---- the panel, on a cover layer ----------------------------------------------
await select("tile");
await page.click('[data-paint-swatch="0"]');
await page.waitForTimeout(400);
check("the fill panel is open", (await count("[data-color-panel]")) === 1, `panel=${await count("[data-color-panel]")}`);

const base = await shot();
const baseInk = inkBox(decodePng(base));
check("and previews the bitmap", !!baseInk, JSON.stringify(baseInk));

// The row's own swatch is the other thumbnail in this panel, and `background`
// defaults to `auto` size at `0 0` — so a bare `url(uri)` painted the bitmap's
// first 14 source pixels (a corner of sky), not a picture of it. The quadrant
// bitmap is the control: a corner crop is one flat colour, a thumbnail carries
// all four.
{
  const swatch = await page.locator('[data-paint-row="0"] [data-paint-swatch="0"]').screenshot();
  const img = decodePng(swatch);
  const seen = new Set();
  for (let y = 2; y < img.height - 2; y++) {
    for (let x = 2; x < img.width - 2; x++) {
      const i = (y * img.width + x) * img.channels;
      QUADRANTS.forEach(([r, g, b], n) => {
        if (Math.abs(img.data[i] - r) + Math.abs(img.data[i + 1] - g) + Math.abs(img.data[i + 2] - b) < 90) {
          seen.add(n);
        }
      });
    }
  }
  check(
    "the fill row's swatch is a thumbnail of the bitmap, not its top-left corner",
    seen.size === QUADRANTS.length,
    `quadrants=${[...seen].sort().join(",")} of ${QUADRANTS.length} (${img.width}x${img.height})`
  );
}

check(
  "the preview is the WHOLE bitmap, at the bitmap's own aspect — not the element's",
  !!baseInk && Math.abs(baseInk.ratio - ASPECT) < 0.08,
  `ink=${baseInk && baseInk.ratio.toFixed(3)} bitmap=${ASPECT} element=${(W / H).toFixed(3)}`
);

// ---- every mode the Fit segments can name -------------------------------------
for (const label of ["contain", "fill", "cover"]) {
  await chooseFit(label);
  const now = await shot();
  const fill = await fillOf("tile");
  check(`choosing ${label} moves the framing`, fill && fill.fit === label, `fit=${fill && fill.fit}`);
  check(`and the preview does not move with it`, base.equals(now));
}

// ---- and the mode that is edited on the canvas --------------------------------
await page.click('[data-image-crop="1"]');
await page.waitForTimeout(500);
check("choosing Crop enters the mode", (await count("[data-image-crop-overlay]")) === 1);
check(
  "with the framing the document now carries",
  (await fillOf("tile")).fit === "crop",
  `fit=${(await fillOf("tile")).fit}`
);
check("the preview does not enter it with the layer", base.equals(await shot()));

const before = await fillOf("tile");
await dragBy('[data-image-crop-handle="e"]', 60, 0);
const after = await fillOf("tile");
check(
  "a crop drag changes the framing",
  JSON.stringify(before.crop) !== JSON.stringify(after.crop),
  `${JSON.stringify(before.crop)} -> ${JSON.stringify(after.crop)}`
);
check("and the preview holds still through the drag", base.equals(await shot()));

await chooseFit("cover");
check("leaving crop hands the transform box back", (await count("[data-image-crop-overlay]")) === 0);
check("and the preview never moved at all", base.equals(await shot()));

// ---- control: a different bitmap is what DOES move it -------------------------
//
// Without this the section above would also pass for a preview that is simply
// frozen — a picture of the first bitmap, painted once and never again.
await page.selectOption('[data-image-asset="1"] select', "tall");
await page.waitForTimeout(400);
{
  const now = await shot();
  const ink = inkBox(decodePng(now));
  check("a different bitmap is repointed", (await fillOf("tile")).assetId === "tall");
  check(
    "and the preview changes with it — it is the bitmap that is being shown",
    !!ink && !base.equals(now) && Math.abs(ink.ratio - 1 / ASPECT) < 0.08,
    `ink=${ink && ink.ratio.toFixed(3)}`
  );
}

await closePanel();
const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} passed`);
if (errors.length) console.log("pageErrors", errors);
await browser.close();
process.exit(passed === results.length && errors.length === 0 ? 0 : 1);
