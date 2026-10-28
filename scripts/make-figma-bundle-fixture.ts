/**
 * Write the sample export FOLDER the e2e import spec drops into the dialog.
 *
 *   node --experimental-strip-types scripts/make-figma-bundle-fixture.ts
 *
 * The spec needs a real `.zip` on disk with a real, DECODABLE image in it, and
 * decodable is the operative word: the folder path runs the app's image policy, so
 * bytes that are not an image fail there and pass through the inline path — which
 * is correct behaviour and makes a fake PNG useless as a fixture.
 *
 * Written with the app's own `buildStoredZip`, so the fixture cannot disagree with
 * the reader about what a bundle is. `tests/figma-bundle.test.ts` opens the result,
 * which is what stops it rotting.
 */

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { buildStoredZip, FISH_BUNDLE_MANIFEST } from "../src/core/import/figma-bundle.ts";
import type { FigmaFileResponse } from "../src/core/import/figma-types.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const file = JSON.parse(fs.readFileSync(path.join(root, "scripts/fixtures/figma-sample-screen.json"), "utf8")) as FigmaFileResponse;

/**
 * A real 64×64 PNG, built here rather than pasted in.
 *
 * The first version of this fixture was a base64 string written by hand, and it
 * was missing its `IEND` chunk — so `createImageBitmap` rejected it, the folder
 * path recorded the image as unreadable, and the import produced a document with
 * no pictures on it. Which is the app behaving correctly and the fixture being
 * wrong, and it is exactly the failure a checked-in blob invites: nothing about a
 * truncated PNG looks truncated. Writing the three chunks means the bytes are
 * complete by construction.
 */
function makePng(size: number): Buffer {
  const crcTable = (() => {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[i] = c >>> 0;
    }
    return table;
  })();
  const crc32 = (bytes: Buffer): number => {
    let crc = 0xffffffff;
    for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, body: Buffer): Buffer => {
    const out = Buffer.alloc(12 + body.length);
    out.writeUInt32BE(body.length, 0);
    out.write(type, 4, "ascii");
    body.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length);
    return out;
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  // One filter byte and three bytes per pixel, per scanline, in a diagonal
  // gradient — noise-like enough that a JPEG or WebP re-encode is visibly
  // smaller, which is what the e2e measures.
  const raw = Buffer.alloc(size * (1 + size * 3));
  for (let y = 0; y < size; y++) {
    const at = y * (1 + size * 3);
    raw[at] = 0;
    for (let x = 0; x < size; x++) {
      raw[at + 1 + x * 3] = (x * 4) % 256;
      raw[at + 2 + x * 3] = (y * 4) % 256;
      raw[at + 3 + x * 3] = ((x ^ y) * 7) % 256;
    }
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

const PNG_64 = makePng(64);

const images: Record<string, Uint8Array> = {};
const index: Record<string, string> = {};
const paint = (node: unknown): void => {
  const record = node as { fills?: Array<{ type?: string; imageRef?: string }>; children?: unknown[] };
  for (const fill of record.fills ?? []) {
    if (fill.type === "IMAGE" && fill.imageRef && !images[fill.imageRef]) {
      images[fill.imageRef] = new Uint8Array(PNG_64);
      index[fill.imageRef] = `assets/${fill.imageRef}.png`;
    }
  }
  for (const child of record.children ?? []) paint(child);
};
paint(rest.document);

const manifest = {
  format: "fish.figma.export",
  version: 1,
  source: { plugin: "FISH Export", api: "1.0.0", scope: "selection", exportedAt: "2026-10-10T00:00:00.000Z" },
  document: rest.document,
  images: index,
  unreadable: {}
};

const entries = [
  { path: FISH_BUNDLE_MANIFEST, bytes: new TextEncoder().encode(JSON.stringify(manifest)) },
  ...Object.entries(index).map(([ref, at]) => ({ path: at, bytes: images[ref] }))
];

const out = path.join(root, "scripts/fixtures/figma-bundle-sample.zip");
const blob = buildStoredZip(entries, new Date("2026-10-10T00:00:00Z"));
fs.writeFileSync(out, Buffer.from(await blob.arrayBuffer()));
console.log(`wrote ${path.relative(root, out)} — ${Object.keys(index).length} image(s), ${fs.statSync(out).size} bytes`);
