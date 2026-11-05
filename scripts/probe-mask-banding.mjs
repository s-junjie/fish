// Gradients dither; gradient MASKS did not. Renders the same shallow ramp twice —
// once as a fill, once as an alpha mask — and measures the flat runs along it.
//
//   node scripts/probe-mask-banding.mjs
//
// The export is transparent where the artboard is, and a mask multiplies ALPHA, so
// the row is measured after compositing over the page background: reading RGB off
// the raw PNG shows the art's colour whatever the coverage did. A dithered row
// changes value every pixel or two; an un-dithered one steps once per 8-bit level,
// which on a shallow ramp is a flat band tens of pixels wide.
//
// Run from the repo root; needs `dist/index.html`.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";

const BACKGROUND = "#161618";

const doc = {
  version: "0.1",
  name: "mask banding probe",
  canvas: { width: 520, height: 320, background: { type: "solid", color: BACKGROUND } },
  pages: [
    {
      id: "page_1",
      name: "Page 1",
      children: [
        {
          id: "fill_alpha",
          type: "rect",
          x: 40, y: 40, width: 400, height: 100, name: "fill-alpha-ramp",
          fills: [{ type: "linear-gradient", from: "#E8E7E3C4", to: "#E8E7E3B8", angle: 90 }]
        },
        {
          id: "mask_frame",
          type: "frame",
          x: 40, y: 160, width: 400, height: 100, name: "mask-alpha-ramp",
          children: [
            {
              id: "mask_shape",
              type: "rect",
              x: 0, y: 0, width: 400, height: 100, name: "mask",
              isMask: true,
              fills: [{ type: "linear-gradient", from: "#FFFFFFC4", to: "#FFFFFFB8", angle: 90 }]
            },
            {
              id: "masked_art",
              type: "rect",
              x: 0, y: 0, width: 400, height: 100, name: "art",
              fills: [{ type: "solid", color: "#E8E7E3" }]
            }
          ]
        }
      ]
    }
  ],
  activePageId: "page_1"
};

const work = fs.mkdtempSync(path.join(os.tmpdir(), "fish-banding-"));
const docPath = path.join(work, "banding.fish.json");
fs.writeFileSync(docPath, JSON.stringify(doc, null, 2));

for (const scale of [1, 2]) {
  execFileSync(
    "node",
    ["scripts/headless-render.mjs", docPath, "-o", path.join(work, `banding@${scale}x.png`), "--scale", String(scale)],
    { stdio: "ignore" }
  );
}

fs.writeFileSync(
  path.join(work, "measure.html"),
  `<!doctype html><meta charset="utf-8">
<img id="a" src="banding@1x.png"><img id="b" src="banding@2x.png">
<script>
const BACKGROUND = "${BACKGROUND}";
window.__measure = async () => {
  const out = [];
  for (const [scale, id] of [[1, "a"], [2, "b"]]) {
    const img = document.getElementById(id);
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const ctx = c.getContext("2d");
    ctx.fillStyle = BACKGROUND;
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(img, 0, 0);
    for (const [label, y0] of [["fill-alpha-ramp", 40], ["mask-alpha-ramp", 160]]) {
      const y = Math.round((y0 + 50) * scale);
      const data = ctx.getImageData(40 * scale, y, 400 * scale, 1).data;
      const runs = [];
      let start = 0;
      for (let x = 1; x < 400 * scale; x++) {
        if (data[x * 4] !== data[(x - 1) * 4]) { runs.push(x - start); start = x; }
      }
      runs.push(400 * scale - start);
      out.push({
        scale,
        label,
        valueChanges: runs.length - 1,
        medianRunPx: runs.sort((p, q) => p - q)[runs.length >> 1],
        longestRunPx: Math.max(...runs),
        levels: new Set(Array.from({ length: 400 * scale }, (_, i) => data[i * 4])).size
      });
    }
  }
  return out;
};
</script>`
);

const browser = await chromium.launch({ args: ["--allow-file-access-from-files"] });
const page = await browser.newPage();
await page.goto(`file://${work}/measure.html`);
const rows = await page.evaluate(() => window.__measure());
console.table(rows);
await browser.close();
console.log("images:", work);
