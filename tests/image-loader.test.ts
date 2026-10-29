import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  MAX_IMAGE_EDGE,
  computeTargetSize,
  svgIntrinsicSize,
  parseFilenameDensity,
  parsePngDensity,
  parseJpegDensity,
  resolveDisplayDimensions,
  extractNameFromUrl,
  isImageUrl,
  embedExternalAsset,
  detectModernFormat,
  loadImageAsset
} from "../src/core/interactions/image-loader";

describe("computeTargetSize", () => {
  it("keeps images already within the max edge", () => {
    expect(computeTargetSize(800, 600, 2048)).toEqual({ width: 800, height: 600 });
    expect(computeTargetSize(2048, 2048, 2048)).toEqual({ width: 2048, height: 2048 });
    expect(computeTargetSize(1, 1, 2048)).toEqual({ width: 1, height: 1 });
  });

  it("scales down so the longest edge hits the cap", () => {
    expect(computeTargetSize(4000, 3000, 2048)).toEqual({ width: 2048, height: 1536 });
    expect(computeTargetSize(3000, 4000, 2048)).toEqual({ width: 1536, height: 2048 });
    expect(computeTargetSize(4096, 4096, 2048)).toEqual({ width: 2048, height: 2048 });
  });

  it("never collapses a dimension to zero", () => {
    expect(computeTargetSize(10000, 1, 2048)).toEqual({ width: 2048, height: 1 });
  });

  it("respects a custom max edge", () => {
    expect(computeTargetSize(1600, 900, 800)).toEqual({ width: 800, height: 450 });
  });

  it("defaults to the app's own max edge, read from MAX_IMAGE_EDGE", () => {
    expect(computeTargetSize(MAX_IMAGE_EDGE * 2, MAX_IMAGE_EDGE * 2)).toEqual({
      width: MAX_IMAGE_EDGE,
      height: MAX_IMAGE_EDGE
    });
    const wide = computeTargetSize(MAX_IMAGE_EDGE * 2, MAX_IMAGE_EDGE);
    expect(wide.width).toBe(MAX_IMAGE_EDGE);
    expect(wide.height).toBeLessThan(MAX_IMAGE_EDGE);
    expect(computeTargetSize(320, 240)).toEqual({ width: 320, height: 240 });
  });
});

describe("resolveDisplayDimensions", () => {
  it("preserves 1:1 original dimensions when density is 1", () => {
    expect(resolveDisplayDimensions(1920, 1080, 1)).toEqual({ width: 1920, height: 1080 });
    expect(resolveDisplayDimensions(800, 600)).toEqual({ width: 800, height: 600 });
    expect(resolveDisplayDimensions(24, 24)).toEqual({ width: 24, height: 24 });
  });

  it("scales dimensions for 2x and 3x Retina density", () => {
    expect(resolveDisplayDimensions(2880, 1800, 2)).toEqual({ width: 1440, height: 900 });
    expect(resolveDisplayDimensions(1170, 2532, 3)).toEqual({ width: 390, height: 844 });
  });
});

describe("parseFilenameDensity", () => {
  it("extracts @2x and @3x scaling factors from filenames", () => {
    expect(parseFilenameDensity("screenshot@2x.png")).toBe(2);
    expect(parseFilenameDensity("hero@3x.jpg")).toBe(3);
    expect(parseFilenameDensity("banner@1.5x.webp")).toBe(1.5);
    expect(parseFilenameDensity("icon@2x")).toBe(2);
  });

  it("returns null for standard names with no density suffix", () => {
    expect(parseFilenameDensity("photo.png")).toBeNull();
    expect(parseFilenameDensity("image.jpg")).toBeNull();
    expect(parseFilenameDensity(undefined)).toBeNull();
  });
});

describe("parsePngDensity", () => {
  it("detects 144 DPI (2x Retina) from PNG pHYs chunk", () => {
    // 5669 px/m ≈ 144 DPI
    const pngBytes = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG Signature
      0x00, 0x00, 0x00, 0x09, // Length 9
      0x70, 0x48, 0x59, 0x73, // "pHYs"
      0x00, 0x00, 0x16, 0x25, // ppux: 5669
      0x00, 0x00, 0x16, 0x25, // ppuy: 5669
      0x01,                   // unit: meter
      0x00, 0x00, 0x00, 0x00  // CRC
    ]);
    expect(parsePngDensity(pngBytes)).toBe(2);
  });

  it("returns 1 for standard 72 DPI PNG", () => {
    // 2835 px/m ≈ 72 DPI
    const pngBytes = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x09,
      0x70, 0x48, 0x59, 0x73,
      0x00, 0x00, 0x0b, 0x13, // ppux: 2835
      0x00, 0x00, 0x0b, 0x13,
      0x01,
      0x00, 0x00, 0x00, 0x00
    ]);
    expect(parsePngDensity(pngBytes)).toBe(1);
  });
});

describe("parseJpegDensity", () => {
  it("detects 144 DPI (2x Retina) from JPEG JFIF header", () => {
    const jpegBytes = new Uint8Array([
      0xff, 0xd8,             // SOI
      0xff, 0xe0,             // APP0
      0x00, 0x10,             // Length 16
      0x4a, 0x46, 0x49, 0x46, 0x00, // "JFIF\0"
      0x01, 0x02,             // Version 1.2
      0x01,                   // Units: dots/inch
      0x00, 0x90,             // Xdensity: 144
      0x00, 0x90,             // Ydensity: 144
      0x00, 0x00              // Thumbnail
    ]);
    expect(parseJpegDensity(jpegBytes)).toBe(2);
  });
});

describe("extractNameFromUrl", () => {
  it("extracts clean filename from URL pathname", () => {
    expect(extractNameFromUrl("https://example.com/images/hero-banner.png")).toBe("hero-banner");
    expect(extractNameFromUrl("https://example.com/photo%201.jpg?v=123")).toBe("photo 1");
  });

  it("falls back to Image for root or empty path", () => {
    expect(extractNameFromUrl("https://example.com/")).toBe("Image");
    expect(extractNameFromUrl("not a url")).toBe("Image");
  });
});

describe("isImageUrl", () => {
  it("recognizes image URLs with standard file extensions", () => {
    expect(isImageUrl("https://example.com/picture.png")).toBe(true);
    expect(isImageUrl("http://cdn.site.com/photo.jpeg?w=800")).toBe(true);
    expect(isImageUrl("https://domain.org/vector.svg")).toBe(true);
    expect(isImageUrl("https://domain.org/animation.gif")).toBe(true);
    expect(isImageUrl("https://domain.org/modern.webp")).toBe(true);
    expect(isImageUrl("https://domain.org/modern.avif")).toBe(true);
  });

  it("recognizes image CDN and path-based URLs", () => {
    expect(isImageUrl("https://images.unsplash.com/photo-123456")).toBe(true);
    expect(isImageUrl("https://cdn.example.com/upload/image/abc")).toBe(true);
  });

  it("rejects non-image URLs and normal text", () => {
    expect(isImageUrl("https://example.com/document.pdf")).toBe(false);
    expect(isImageUrl("https://github.com/user/repo")).toBe(false);
    expect(isImageUrl("Hello world")).toBe(false);
    expect(isImageUrl("ftp://example.com/file.png")).toBe(false);
  });
});

/**
 * The importer's SVG branch exists because `createImageBitmap` must reject an
 * SVG blob with no intrinsic `width`/`height` — `InvalidStateError: The source
 * image could not be decoded.` — and that is what a bare `viewBox` produces, so
 * a measurement of the markup is the only thing standing between the user and a
 * failed import.
 */
describe("svgIntrinsicSize", () => {
  it("prefers explicit width and height attributes", () => {
    expect(svgIntrinsicSize('<svg width="24" height="24" viewBox="0 0 48 48"></svg>')).toEqual({
      width: 24,
      height: 24
    });
  });

  it("accepts px units and single quotes", () => {
    expect(svgIntrinsicSize("<svg width='16px' height='32px'></svg>")).toEqual({ width: 16, height: 32 });
  });

  it("falls back to the viewBox when width/height are absent", () => {
    expect(svgIntrinsicSize('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 32"><path d="M0 0"/></svg>')).toEqual({
      width: 48,
      height: 32
    });
  });

  it("accepts a comma-separated viewBox", () => {
    expect(svgIntrinsicSize('<svg viewBox="0,0,10,20"></svg>')).toEqual({ width: 10, height: 20 });
  });

  it("reads width/height off the root tag past a leading xml declaration", () => {
    expect(svgIntrinsicSize('<?xml version="1.0"?>\n<svg width="64" height="64"></svg>')).toEqual({
      width: 64,
      height: 64
    });
  });

  it("falls through to the viewBox for a length that is not in pixels", () => {
    // "100%" resolves against a containing block this document does not have, but
    // the viewBox still states the drawing's own extent — a better answer than
    // giving up, and better than 100 user units.
    expect(svgIntrinsicSize('<svg width="100%" height="100%" viewBox="0 0 8 8"></svg>')).toEqual({
      width: 8,
      height: 8
    });
    expect(svgIntrinsicSize('<svg width="2em" height="2em"></svg>')).toBeNull();
  });

  it("returns null when nothing states an extent", () => {
    expect(svgIntrinsicSize("<svg></svg>")).toBeNull();
    expect(svgIntrinsicSize("not svg at all")).toBeNull();
  });

  it("returns null for a zero-sized viewBox rather than a 0x0 element", () => {
    expect(svgIntrinsicSize('<svg viewBox="0 0 0 0"></svg>')).toBeNull();
  });
});

describe("embedExternalAsset", () => {
  let originalCreateImageBitmap: typeof globalThis.createImageBitmap;
  let originalOffscreenCanvas: typeof globalThis.OffscreenCanvas;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalCreateImageBitmap = globalThis.createImageBitmap;
    originalOffscreenCanvas = globalThis.OffscreenCanvas;
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.createImageBitmap = originalCreateImageBitmap;
    globalThis.OffscreenCanvas = originalOffscreenCanvas;
    globalThis.fetch = originalFetch;
  });

  it("returns asset unchanged if URI is not an external HTTP URL", async () => {
    const localAsset = { id: "a1", name: "local", uri: "data:image/png;base64,123", width: 100, height: 100 };
    const result = await embedExternalAsset(localAsset);
    expect(result).toBe(localAsset);
  });

  it("preserves remote AVIF format without re-encoding when within limits", async () => {
    let encodeCalled = false;
    globalThis.createImageBitmap = (async () => ({ width: 1200, height: 800, close: () => {} })) as any;
    globalThis.OffscreenCanvas = class {
      constructor() {}
      getContext() { return { drawImage: () => {} }; }
      async convertToBlob() { encodeCalled = true; return new Blob([]); }
    } as any;
    globalThis.fetch = async () => ({
      ok: true,
      blob: async () => new Blob(["fake-avif"], { type: "image/avif" })
    } as any);

    const externalAsset = { id: "a_ext", name: "photo", uri: "https://example.com/photo.avif", width: 1200, height: 800 };
    const result = await embedExternalAsset(externalAsset);

    expect(encodeCalled).toBe(false);
    expect(result.id).toBe("a_ext");
    expect(result.width).toBe(1200);
    expect(result.height).toBe(800);
    expect(result.uri).toMatch(/^data:image\/avif;base64,/);
  });

  it("downscales and converts oversized remote AVIF (> MAX_IMAGE_EDGE) to WebP", async () => {
    let encodeCalled = false;
    globalThis.createImageBitmap = (async () => ({ width: 5000, height: 3000, close: () => {} })) as any;
    globalThis.OffscreenCanvas = class {
      width = 0;
      height = 0;
      constructor(w: number, h: number) { this.width = w; this.height = h; }
      getContext() { return { drawImage: () => {} }; }
      async convertToBlob() { encodeCalled = true; return new Blob(["fake-webp"], { type: "image/webp" }); }
    } as any;
    globalThis.fetch = async () => ({
      ok: true,
      blob: async () => new Blob(["fake-avif"], { type: "image/avif" })
    } as any);

    const externalAsset = { id: "a_huge", name: "huge", uri: "https://example.com/huge.avif", width: 5000, height: 3000 };
    const result = await embedExternalAsset(externalAsset);

    expect(encodeCalled).toBe(true);
    expect(result.id).toBe("a_huge");
    expect(result.width).toBe(MAX_IMAGE_EDGE);
    expect(result.uri).toMatch(/^data:image\/webp;base64,/);
  });

  it("never hands a private address to the public proxy", async () => {
    // `wsrv.nl` is a third party. An intranet host, a dev server on loopback or a
    // signed object-store URL is not something this app may forward to one — the
    // address IS the secret. The original failure is the honest answer.
    const calls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      calls.push(String(url));
      throw new TypeError("Failed to fetch");
    }) as any;

    const asset = { id: "a_priv", name: "mock", uri: "http://localhost:3000/mockup.png", width: 10, height: 10 };
    await expect(embedExternalAsset(asset)).rejects.toThrow(/Failed to fetch/);
    expect(calls).toEqual(["http://localhost:3000/mockup.png"]);
  });

  it("reports an HTTP status instead of replaying it through the proxy", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      calls.push(String(url));
      return { ok: false, status: 404, statusText: "Not Found", blob: async () => new Blob([]) };
    }) as any;

    const asset = { id: "a_404", name: "missing", uri: "https://example.com/missing.png", width: 10, height: 10 };
    await expect(embedExternalAsset(asset)).rejects.toThrow(/Not Found/);
    expect(calls).toHaveLength(1);
  });

  it("retries a cross-origin refusal through the proxy for a public https address", async () => {
    const calls: string[] = [];
    globalThis.createImageBitmap = (async () => ({ width: 1200, height: 800, close: () => {} })) as any;
    globalThis.OffscreenCanvas = class {
      getContext() {
        return { drawImage: () => {} };
      }
      async convertToBlob() {
        return new Blob(["fake-webp"], { type: "image/webp" });
      }
    } as any;
    globalThis.fetch = (async (url: string) => {
      calls.push(String(url));
      if (calls.length === 1) throw new TypeError("Failed to fetch");
      return { ok: true, blob: async () => new Blob(["fake-avif"], { type: "image/avif" }) };
    }) as any;

    const asset = { id: "a_pub", name: "photo", uri: "https://example.com/photo.avif", width: 1200, height: 800 };
    const result = await embedExternalAsset(asset);

    expect(calls[1]).toBe(`https://wsrv.nl/?url=${encodeURIComponent("https://example.com/photo.avif")}`);
    expect(result.uri).toMatch(/^data:image\/avif;base64,/);
  });
});

describe("detectModernFormat", () => {
  it("identifies AVIF and WebP from MIME type", async () => {
    expect(await detectModernFormat(new Blob([], { type: "image/avif" }))).toBe("image/avif");
    expect(await detectModernFormat(new Blob([], { type: "image/webp" }))).toBe("image/webp");
  });

  it("identifies AVIF and WebP from filename extension", async () => {
    expect(await detectModernFormat(new File([], "photo.avif"))).toBe("image/avif");
    expect(await detectModernFormat(new File([], "banner.webp"))).toBe("image/webp");
    expect(await detectModernFormat(new File([], "UPPER.AVIF"))).toBe("image/avif");
    expect(await detectModernFormat(new File([], "UPPER.WEBP"))).toBe("image/webp");
  });

  it("identifies AVIF and WebP from magic bytes when MIME and filename are absent", async () => {
    const webpBytes = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, // "RIFF"
      0x00, 0x00, 0x00, 0x00,
      0x57, 0x45, 0x42, 0x50  // "WEBP"
    ]);
    expect(await detectModernFormat(new Blob([webpBytes]))).toBe("image/webp");

    const avifBytes = new Uint8Array([
      0x00, 0x00, 0x00, 0x1c,
      0x66, 0x74, 0x79, 0x70, // "ftyp"
      0x61, 0x76, 0x69, 0x66  // "avif"
    ]);
    expect(await detectModernFormat(new Blob([avifBytes]))).toBe("image/avif");
  });

  it("returns null for non-modern or legacy formats", async () => {
    expect(await detectModernFormat(new Blob([], { type: "image/png" }))).toBeNull();
    expect(await detectModernFormat(new Blob([], { type: "image/jpeg" }))).toBeNull();
    expect(await detectModernFormat(new Blob([], { type: "image/gif" }))).toBeNull();
    expect(await detectModernFormat(new File([], "photo.png"))).toBeNull();
    expect(await detectModernFormat(new File([], "photo.jpg"))).toBeNull();
    expect(await detectModernFormat(new Blob([new Uint8Array([1, 2, 3])]))).toBeNull();
  });
});

describe("loadImageAsset modern format pass-through", () => {
  let originalCreateImageBitmap: typeof globalThis.createImageBitmap;
  let originalOffscreenCanvas: typeof globalThis.OffscreenCanvas;

  beforeEach(() => {
    originalCreateImageBitmap = globalThis.createImageBitmap;
    originalOffscreenCanvas = globalThis.OffscreenCanvas;
  });

  afterEach(() => {
    globalThis.createImageBitmap = originalCreateImageBitmap;
    globalThis.OffscreenCanvas = originalOffscreenCanvas;
  });

  function setupMockImageEnvironment(dimensions: { width: number; height: number }) {
    let encodeDownscaledCalled = false;

    globalThis.createImageBitmap = (async () => ({
      width: dimensions.width,
      height: dimensions.height,
      close: () => {}
    })) as any;

    globalThis.OffscreenCanvas = class {
      width: number;
      height: number;
      constructor(w: number, h: number) {
        this.width = w;
        this.height = h;
      }
      getContext() {
        return {
          drawImage: () => {}
        };
      }
      async convertToBlob({ type }: { type: string }) {
        encodeDownscaledCalled = true;
        return new Blob(["mock-webp-data"], { type: type || "image/webp" });
      }
    } as any;

    return {
      wasEncodeCalled: () => encodeDownscaledCalled
    };
  }

  it("skips re-encoding for AVIF images within size limits", async () => {
    const mock = setupMockImageEnvironment({ width: 1200, height: 800 });
    const file = new File(["avif-content"], "test.avif", { type: "image/avif" });

    const asset = await loadImageAsset(file);

    expect(mock.wasEncodeCalled()).toBe(false);
    expect(asset.width).toBe(1200);
    expect(asset.height).toBe(800);
    expect(asset.uri).toMatch(/^data:image\/avif;base64,/);
  });

  it("skips re-encoding for WebP images within size limits", async () => {
    const mock = setupMockImageEnvironment({ width: 800, height: 600 });
    const file = new File(["webp-content"], "test.webp", { type: "image/webp" });

    const asset = await loadImageAsset(file);

    expect(mock.wasEncodeCalled()).toBe(false);
    expect(asset.width).toBe(800);
    expect(asset.height).toBe(600);
    expect(asset.uri).toMatch(/^data:image\/webp;base64,/);
  });

  it("downscales and re-encodes oversized AVIF images (> MAX_IMAGE_EDGE) as WebP", async () => {
    const mock = setupMockImageEnvironment({ width: 5000, height: 3000 });
    const file = new File(["avif-content"], "huge.avif", { type: "image/avif" });

    const asset = await loadImageAsset(file);

    expect(mock.wasEncodeCalled()).toBe(true);
    expect(asset.width).toBe(MAX_IMAGE_EDGE);
    expect(asset.height).toBe(Math.round((3000 * MAX_IMAGE_EDGE) / 5000));
    expect(asset.uri).toMatch(/^data:image\/webp;base64,/);
  });

  it("re-encodes legacy formats (e.g. PNG) as WebP even when within size limits", async () => {
    const mock = setupMockImageEnvironment({ width: 800, height: 600 });
    const file = new File(["png-content"], "test.png", { type: "image/png" });

    const asset = await loadImageAsset(file);

    expect(mock.wasEncodeCalled()).toBe(true);
    expect(asset.width).toBe(800);
    expect(asset.height).toBe(600);
    expect(asset.uri).toMatch(/^data:image\/webp;base64,/);
  });
});


