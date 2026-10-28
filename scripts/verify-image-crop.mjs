/**
 * Verifies image crop in a real browser, against the real build.
 *
 *   node scripts/verify-image-crop.mjs [dist/index.html]
 *
 * The check is end-to-end on purpose: a fixture document goes through the same
 * path a user's file does (normalize → CanvasDefs → the `<pattern>` tile), and
 * the pixels are read back off the screen. Asserting the geometry in isolation
 * would pass while the renderer painted something else.
 *
 * The bitmap is a four-quadrant PNG generated here, so the visible SOURCE region
 * is readable from the colour at a sample point — which is what makes "drag to
 * where you want and you see that part of the bitmap" a testable claim rather
 * than a description.
 *
 * Run `npm run build` first.
 */

import { loadPlaywright } from "./lib/playwright-loader.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

const RED = "#ff0000";
const GREEN = "#00ff00";
const BLUE = "#0000ff";
const YELLOW = "#ffff00";
const BACKDROP = "#00ffff";

const target = process.argv[2] ?? "dist/index.html";
if (!fs.existsSync(target)) {
  console.error(`no shell at ${target} — run \`npm run build\` first.`);
  process.exit(2);
}

// ---------------------------------------------------------------------------
// a four-quadrant PNG, so a sample point names the source region it came from
// ---------------------------------------------------------------------------

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

/** A PNG whose four quadrants are the four colours above. */
function quadrantPng(size) {
  const quadrants = [RED, GREEN, BLUE, YELLOW];
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
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

/** A PNG that is red on its left half and green on its right. */
function splitPng(width, height) {
  const raw = Buffer.alloc(height * (1 + width * 4));
  let o = 0;
  for (let y = 0; y < height; y++) {
    raw[o++] = 0;
    for (let x = 0; x < width; x++) {
      const [r, g, b] = hexToRgb(x < width / 2 ? RED : GREEN);
      raw[o++] = r;
      raw[o++] = g;
      raw[o++] = b;
      raw[o++] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

// ---------------------------------------------------------------------------
// the fixture: one 200×200 box per case, stacked down the artboard
// ---------------------------------------------------------------------------

const BOX = 200;
/** Where a sample point sits inside a case's box, relative to its top-left. */
const p = (x, y, want) => ({ x, y, want });

const CASES = [
  {
    id: "whole",
    crop: { x: 0, y: 0, scale: 1 },
    note: "scale 1 shows the entire source",
    samples: [p(50, 50, RED), p(150, 50, GREEN), p(50, 150, BLUE), p(150, 150, YELLOW)]
  },
  {
    id: "quarter",
    crop: { x: 0, y: 0, scale: 2 },
    note: "scale 2 crops to the top-left quadrant",
    samples: [p(50, 50, RED), p(150, 50, RED), p(50, 150, RED), p(150, 150, RED)]
  },
  {
    id: "middle",
    crop: { x: -0.5, y: -0.5, scale: 2 },
    note: "an offset picks the middle of the source",
    samples: [p(50, 50, RED), p(150, 50, GREEN), p(50, 150, BLUE), p(150, 150, YELLOW)]
  },
  {
    id: "shrunk",
    crop: { x: 0, y: 0, scale: 0.25 },
    note: "below scale 1 the backdrop shows through",
    samples: [p(10, 10, RED), p(150, 150, BACKDROP)]
  },
  {
    id: "turned",
    asset: "split",
    crop: { x: -0.5, y: 0, scale: 1, rotation: 90 },
    note: "rotation turns the source's x axis onto the box's y axis",
    box: { width: 200, height: 200 },
    samples: [p(20, 50, RED), p(20, 150, GREEN), p(180, 50, RED), p(180, 150, GREEN)]
  },
  {
    id: "turned_scaled",
    crop: { x: 0, y: 0, scale: 1, rotation: 90 },
    note: "…and about the PAINTED centre, where a 400px bitmap is painted at 200",
    // A 400×400 bitmap in a 200×150 box is painted at `cover` = 0.5, i.e. 200×200
    // — the case where the bitmap's natural centre and its painted centre are two
    // different points. Naming the natural one turns the bitmap about a corner it
    // does not have there, and the whole square leaves the box: every sample below
    // would read the backdrop.
    box: { width: 200, height: 150 },
    samples: [p(50, 50, BLUE), p(150, 50, RED), p(50, 100, YELLOW), p(150, 100, GREEN)]
  },
  {
    id: "upright",
    asset: "split",
    crop: { x: -0.5, y: 0, scale: 1 },
    note: "…and without rotation the same source splits the other way",
    box: { width: 200, height: 200 },
    samples: [p(50, 20, RED), p(150, 20, GREEN), p(50, 180, RED), p(150, 180, GREEN)]
  }
];

const GAP = 40;
const canvas = {
  width: BOX + GAP * 2,
  height: BOX * CASES.length + GAP * (CASES.length + 1),
  background: { type: "solid", color: BACKDROP }
};

const assetBase = { name: "quad", width: 400, height: 400 };
const assets = [
  { id: "quad", ...assetBase, uri: `data:image/png;base64,${quadrantPng(400).toString("base64")}` },
  {
    id: "split",
    name: "split",
    width: 400,
    height: 200,
    uri: `data:image/png;base64,${splitPng(400, 200).toString("base64")}`
  }
];

const elements = CASES.map((c, i) => {
  const box = c.box ?? { width: BOX, height: BOX };
  return {
    id: c.id,
    type: "rect",
    name: c.id,
    x: GAP,
    y: GAP + i * (BOX + GAP),
    width: box.width,
    height: box.height,
    fills: [
      {
        type: "image",
        assetId: c.asset ?? "quad",
        fit: "crop",
        crop: c.crop
      }
    ]
  };
});

const doc = {
  docId: "crop_probe",
  version: "0.1",
  name: "Image Crop Probe",
  canvas,
  assets,
  pages: [{ id: "page_1", name: "Page 1", canvas, children: elements }],
  activePageId: "page_1",
  elements
};

const shellHtml = fs.readFileSync(target, "utf-8");
const docRe = /<script\s+id=["']design-doc["'][^>]*>([\s\S]*?)<\/script>/i;
if (!docRe.test(shellHtml)) {
  console.error(`${target} has no #design-doc block`);
  process.exit(2);
}
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "fish-crop-"));
const fixture = path.join(workDir, "index.html");
fs.writeFileSync(
  fixture,
  shellHtml.replace(
    docRe,
    () =>
      `<script id="design-doc" type="application/json">\n${JSON.stringify(doc).replace(/</g, "\\u003c")}\n  </script>`
  )
);

// ---------------------------------------------------------------------------

const { chromium } = await loadPlaywright();
const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: Math.max(canvas.width, 900), height: Math.max(canvas.height, 600) }
});
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (msg) => {
  if (msg.type() === "error") errors.push(msg.text());
});

await page.goto("file://" + fixture + "?view=canvas", { waitUntil: "load" });
await page.waitForSelector('[data-element-id="whole"]', { timeout: 60000 });
await page.waitForTimeout(1500);

/** Where each case's box landed, and what its pattern actually paints. */
const layout = await page.evaluate((ids) => {
  const out = { boxes: {}, images: {}, backdrop: null };
  for (const id of ids) {
    const g = document.querySelector(`g[data-element-id="${id}"]`);
    const rect = g?.getBoundingClientRect();
    out.boxes[id] = rect
      ? { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }
      : null;
    const image = g?.parentElement?.querySelector(`#pat_${id}_0 image`) ?? document.querySelector(`#pat_${id}_0 image`);
    out.images[id] = image
      ? {
          width: image.getAttribute("width"),
          height: image.getAttribute("height"),
          transform: image.getAttribute("transform"),
          preserveAspectRatio: image.getAttribute("preserveAspectRatio")
        }
      : null;
  }
  const art = document.querySelector("svg");
  out.backdrop = art ? art.getAttribute("width") + "x" + art.getAttribute("height") : null;
  return out;
}, CASES.map((c) => c.id));

const shot = await page.screenshot({ clip: { x: 0, y: 0, width: canvas.width, height: canvas.height } });
const pixels = await page.evaluate(
  async ({ base64, samples }) => {
    const img = new Image();
    await new Promise((res, rej) => {
      img.onload = res;
      img.onerror = () => rej(new Error("screenshot decode failed"));
      img.src = "data:image/png;base64," + base64;
    });
    const c = document.createElement("canvas");
    c.width = img.width;
    c.height = img.height;
    const ctx = c.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, c.width, c.height).data;
    const at = (x, y) => {
      const i = (Math.round(y) * c.width + Math.round(x)) * 4;
      return "#" + [data[i], data[i + 1], data[i + 2]].map((v) => v.toString(16).padStart(2, "0")).join("");
    };
    return samples.map(({ id, x, y }) => at(x, y));
  },
  {
    base64: shot.toString("base64"),
    samples: CASES.flatMap((c) =>
      c.samples.map((s) => {
        const box = layout.boxes[c.id];
        return { id: c.id, x: box.x + s.x, y: box.y + s.y };
      })
    )
  }
);

await browser.close();

// ---------------------------------------------------------------------------

let failed = 0;
const check = (ok, label) => {
  if (!ok) failed++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}`);
};

console.log(`shell ${target}  artboard ${layout.backdrop}  ${CASES.length} cases\n`);
if (errors.length) console.log(`page errors:\n  ${errors.join("\n  ")}\n`);

let cursor = 0;
for (const c of CASES) {
  console.log(`${c.id} — ${c.note}`);
  const image = layout.images[c.id];
  check(!!image, "the pattern paints a bitmap");
  if (image) {
    check(image.preserveAspectRatio === "none", `preserveAspectRatio=${image.preserveAspectRatio}`);
    const rotated = (c.crop.rotation ?? 0) !== 0;
    check(
      rotated ? /rotate\(/.test(image.transform ?? "") : !/rotate\(/.test(image.transform ?? ""),
      `transform=${image.transform}`
    );
    check(image.width === "400" && image.height === String(c.asset === "split" ? 200 : 400), "painted at natural size");
  }
  for (const s of c.samples) {
    const got = pixels[cursor++];
    check(got === s.want, `at (${s.x},${s.y}) ${got} wanted ${s.want}`);
  }
  console.log("");
}

console.log(failed === 0 ? `PASS — ${pixels.length} colour samples` : `FAIL — ${failed} check(s) wrong`);
process.exit(failed === 0 ? 0 : 1);
