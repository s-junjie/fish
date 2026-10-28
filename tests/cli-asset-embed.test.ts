import { describe, it, expect } from "vitest";
import { dataUriBytes, dataUriMime, embedImageBytes, formatBytes, sniffMime } from "../src/core/cli/image-embed";
import { shouldPassThrough } from "../src/core/interactions/image-loader";

/**
 * The CLI's asset embedder has two halves: a Node half that types bytes and
 * fetches them, and a browser half that applies the app's image policy. Only the
 * Node half and the decision that selects it are covered here — the browser half
 * launches Chrome, which is `scripts/run-e2e.mjs` territory, not this suite's.
 *
 * The decision is the part worth pinning: it is what keeps the CLI from growing a
 * second set of image numbers. If `shouldPassThrough` ever learns a format, the
 * CLI must take the browser-free path for it automatically, without an edit here.
 */

function bytes(...parts: (number[] | string)[]): Uint8Array {
  const out: number[] = [];
  for (const part of parts) {
    if (typeof part === "string") for (let i = 0; i < part.length; i++) out.push(part.charCodeAt(i));
    else out.push(...part);
  }
  return new Uint8Array(out);
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_MAGIC = [0xff, 0xd8, 0xff, 0xe0];

function gifHeader(width: number, height: number): Uint8Array {
  const out = bytes("GIF89a", [0, 0, 0, 0]);
  out[6] = width & 0xff;
  out[7] = (width >> 8) & 0xff;
  out[8] = height & 0xff;
  out[9] = (height >> 8) & 0xff;
  return out;
}

describe("sniffMime", () => {
  it("reads each family from its magic bytes", () => {
    expect(sniffMime(bytes(JPEG_MAGIC))).toBe("image/jpeg");
    expect(sniffMime(bytes(PNG_MAGIC))).toBe("image/png");
    expect(sniffMime(bytes("RIFF", [0, 0, 0, 0], "WEBP"))).toBe("image/webp");
    expect(sniffMime(bytes("GIF87a"))).toBe("image/gif");
    expect(sniffMime(bytes("GIF89a"))).toBe("image/gif");
    expect(sniffMime(bytes("BM", [0, 0]))).toBe("image/bmp");
    expect(sniffMime(bytes([0, 0, 0, 0], "ftyp", "avif"))).toBe("image/avif");
  });

  it("recognises SVG through an XML declaration and a UTF-8 BOM", () => {
    expect(sniffMime(bytes('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBe("image/svg+xml");
    expect(sniffMime(bytes('<?xml version="1.0"?><svg viewBox="0 0 1 1"></svg>'))).toBe("image/svg+xml");
    expect(sniffMime(bytes([0xef, 0xbb, 0xbf], '<svg viewBox="0 0 1 1"></svg>'))).toBe("image/svg+xml");
  });

  it("answers null rather than guessing, so the caller can fall back to a header", () => {
    expect(sniffMime(bytes("just some text"))).toBeNull();
    expect(sniffMime(bytes([0xff]))).toBeNull();
    expect(sniffMime(new Uint8Array(0))).toBeNull();
    // A truncated header must not half-match.
    expect(sniffMime(bytes([0x89, 0x50]))).toBeNull();
  });
});

describe("data URI accounting", () => {
  it("counts decoded bytes, padding included", () => {
    expect(dataUriBytes("data:image/png;base64,AAAA")).toBe(3);
    expect(dataUriBytes("data:image/png;base64,AAA=")).toBe(2);
    expect(dataUriBytes("data:image/png;base64,AA==")).toBe(1);
    expect(dataUriBytes("data:image/png;base64,")).toBe(0);
  });

  it("counts a non-base64 payload by its length, and a URL not at all", () => {
    expect(dataUriBytes("data:text/plain,hello")).toBe(5);
    expect(dataUriBytes("https://example.com/a.png")).toBeNull();
  });

  it("reads back the type the policy chose, not the one that went in", () => {
    expect(dataUriMime("data:image/webp;base64,UklGRg==")).toBe("image/webp");
    expect(dataUriMime("data:image/svg+xml;base64,PHN2Zy8+")).toBe("image/svg+xml");
    expect(dataUriMime("data:image/svg+xml,<svg/>")).toBe("image/svg+xml");
    expect(dataUriMime("https://example.com/a.png")).toBeNull();
  });

  it("formats sizes at the unit boundaries", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1024 * 1024)).toBe("1.00 MB");
  });
});

describe("browser-free path", () => {
  it("takes exactly the formats the app's own policy passes through", () => {
    for (const mime of ["image/svg+xml", "image/gif"]) {
      expect(shouldPassThrough({ type: mime } as Blob), `${mime} should pass through`).toBe(true);
    }
    for (const mime of ["image/jpeg", "image/png", "image/webp", "image/avif", "image/bmp", ""]) {
      expect(shouldPassThrough({ type: mime } as Blob), `${mime} should be re-encoded`).toBe(false);
    }
  });

  it("embeds an SVG in Node, byte for byte, sized from its markup", async () => {
    const svg = bytes('<svg xmlns="http://www.w3.org/2000/svg" width="12" height="34"><rect/></svg>');
    const asset = await embedImageBytes(svg, null, "icon");
    expect(asset.mime).toBe("image/svg+xml");
    expect(asset.width).toBe(12);
    expect(asset.height).toBe(34);
    expect(asset.bytes).toBe(svg.length);
    expect(dataUriMime(asset.uri)).toBe("image/svg+xml");
  });

  it("types an SVG from its bytes even when the caller declares something else", async () => {
    const svg = bytes('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"></svg>');
    const asset = await embedImageBytes(svg, "application/octet-stream", "icon");
    expect(asset.mime).toBe("image/svg+xml");
  });

  it("sizes a GIF from its header, which is what a decoder reports for it", async () => {
    const asset = await embedImageBytes(gifHeader(320, 240), null, "anim");
    expect(asset.mime).toBe("image/gif");
    expect(asset.width).toBe(320);
    expect(asset.height).toBe(240);
  });
});
