import { AssetRef, DesignElement } from "../dsl/types";
import { createImageFillElement } from "../dsl/image-fill";
import { createId } from "../id";
import { externalFetch, isAbortFailure, publicProxyUrl } from "../net/external-fetch";

// 4096 is the longest edge whose square still fits Safari's 16,777,216px
// canvas-area ceiling; the cap cannot go higher without the encode going blank
// there. A square image lands exactly ON that ceiling, so there is no headroom
// above it — only below.
//
// Exported, and the tests derive from it, because this number is the app's
// policy and not a detail: it is the one place a caller may read it. Comments
// elsewhere say "the app's image policy" rather than restating the value.
export const MAX_IMAGE_EDGE = 4096;
const WEBP_QUALITY = 1.0;

export interface LoadedImageData {
  asset: AssetRef;
  element: DesignElement;
}

export function computeTargetSize(
  width: number,
  height: number,
  maxEdge = MAX_IMAGE_EDGE
): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= maxEdge) return { width, height };
  const scale = maxEdge / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale))
  };
}

/**
 * Exported because the CLI asks the same question about bytes it fetched itself:
 * a format this returns true for is one the policy leaves alone, so the CLI can
 * embed it without a browser. Restating the list there is what would let the two
 * answers diverge.
 */
export function shouldPassThrough(file: File | Blob): boolean {
  const type = (file as File).type || "";
  return type === "image/svg+xml" || type === "image/gif";
}

/**
 * Also answers "which door does this file take" — see `insertMediaFile`, which
 * routes an SVG to the vector importer instead of to this one.
 *
 * The name is the fallback because a `Blob` off the clipboard carries no type,
 * and a drag out of some browsers arrives with an empty one.
 */
export function isSvg(file: File | Blob): boolean {
  return (file as File).type === "image/svg+xml" || /\.svg$/i.test((file as File).name ?? "");
}

export async function detectModernFormat(file: File | Blob): Promise<"image/avif" | "image/webp" | null> {
  const type = (file as File).type || "";
  if (type === "image/avif") return "image/avif";
  if (type === "image/webp") return "image/webp";

  const name = (file as File).name || "";
  if (/\.avif$/i.test(name)) return "image/avif";
  if (/\.webp$/i.test(name)) return "image/webp";

  try {
    const slice = file.slice(0, 16);
    const buffer = await slice.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    if (bytes.length >= 12) {
      const ascii = (at: number, len: number) => {
        let s = "";
        for (let i = 0; i < len; i++) s += String.fromCharCode(bytes[at + i]);
        return s;
      };
      if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") return "image/webp";
      if (ascii(4, 4) === "ftyp" && (ascii(8, 4) === "avif" || ascii(8, 4) === "avis")) return "image/avif";
    }
  } catch {
    // Slicing or buffer read failure falls through
  }

  return null;
}


interface DecodedImage {
  source: CanvasImageSource & { width: number; height: number };
  width: number;
  height: number;
  close: () => void;
}

async function decodeWithElement(file: File | Blob): Promise<DecodedImage> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = "async";
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("Failed to decode image data"));
      img.src = url;
    });
    return {
      source: img,
      width: img.naturalWidth,
      height: img.naturalHeight,
      close: () => URL.revokeObjectURL(url)
    };
  } catch (err) {
    URL.revokeObjectURL(url);
    throw err;
  }
}

/**
 * `createImageBitmap` first, `<img>` second.
 *
 * The two disagree on what is decodable, and for an SVG they disagree
 * routinely: the spec requires `createImageBitmap` to reject an SVG blob that
 * has no intrinsic `width`/`height` with `InvalidStateError`, which is what
 * every icon exported by a vector editor ships. `<img>` resolves such a file
 * from its `viewBox` without complaint, so falling back turns a whole failed
 * import into a measurement.
 */
async function decodeToBitmap(file: File | Blob): Promise<DecodedImage> {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file);
      return {
        source: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        close: () => bitmap.close()
      };
    } catch (err) {
      if (!isSvg(file)) throw err;
    }
  }
  return decodeWithElement(file);
}

/**
 * The intrinsic size of an asset that is already IN the document — a `data:` or
 * `blob:` URI, not a `File`.
 *
 * Separate from `decodeToBitmap` because there is no Blob to hand it: an asset
 * imported in an earlier session, or one that arrived inside the document's JSON,
 * exists only as its URI. It answers `null` rather than a guess when the decode
 * fails or reports a zero on either axis — a pixel-solved framing derived from an
 * invented size is worse than a crop that refuses and says why (LESSONS #35).
 *
 * `naturalWidth`/`naturalHeight`, not `width`/`height`: a URI can carry an SVG
 * with a bare `viewBox`, and only the natural pair reports what it resolves to.
 */
export async function measureNaturalSize(
  uri: string
): Promise<{ width: number; height: number } | null> {
  if (!uri) return null;
  const img = new Image();
  img.decoding = "async";
  const loaded = await new Promise<boolean>((resolve) => {
    img.onload = () => resolve(true);
    img.onerror = () => resolve(false);
    img.src = uri;
  });
  if (!loaded || !img.naturalWidth || !img.naturalHeight) return null;
  return { width: img.naturalWidth, height: img.naturalHeight };
}

/**
 * Intrinsic size of an SVG, read out of the markup.
 *
 * Percentages, unit-bearing lengths and a missing `viewBox` all resolve to
 * `null` so the caller can fall through to the image decoder, which is the only
 * one that can answer for those.
 */
export function svgIntrinsicSize(text: string): { width: number; height: number } | null {
  const root = text.match(/<svg\b[^>]*>/i);
  if (!root) return null;
  const attr = (name: string): number | null => {
    const m = new RegExp(`\\b${name}\\s*=\\s*["']([-+]?[\\d.]+)(?:px)?["']`, "i").exec(root[0]);
    if (!m) return null;
    const n = Number(m[1]);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const w = attr("width");
  const h = attr("height");
  if (w !== null && h !== null) return { width: w, height: h };
  const viewBox = /\bviewBox\s*=\s*["']([^"']+)["']/i.exec(root[0]);
  if (viewBox) {
    const parts = viewBox[1].trim().split(/[\s,]+/).map(Number);
    if (parts.length === 4 && parts.every(Number.isFinite) && parts[2] > 0 && parts[3] > 0) {
      return { width: parts[2], height: parts[3] };
    }
  }
  return null;
}

/**
 * Measure a pass-through file without letting the measurement fail the import.
 *
 * An SVG is the reason this returns a fallback: its bytes are already a valid
 * data URI by the time we get here, so a decoder that refuses it is answering a
 * question the markup can answer, and the whole file must not be lost to it.
 * `FALLBACK_SIZE` is the last resort for a file neither the markup nor any
 * decoder can size — a 1×1 element would be unclickable, and an unclickable
 * import reads as "the import did nothing" just as surely as a failure does.
 */
const FALLBACK_SIZE = { width: 300, height: 200 };

async function measureIntrinsicSize(file: File | Blob): Promise<{ width: number; height: number }> {
  if (isSvg(file)) {
    try {
      const text = await file.text();
      const fromMarkup = svgIntrinsicSize(text);
      if (fromMarkup) return fromMarkup;
    } catch {
      // Fall through to the decoder; a Blob that will not read as text may still
      // decode as an image.
    }
  }
  try {
    const decoded = await decodeToBitmap(file);
    const size = { width: decoded.width, height: decoded.height };
    decoded.close();
    if (size.width > 0 && size.height > 0) return size;
  } catch {
    // Same reasoning as above: a size we cannot read is not a reason to lose the file.
  }
  return FALLBACK_SIZE;
}

async function encodeDownscaled(
  decoded: DecodedImage,
  target: { width: number; height: number }
): Promise<{ blob: Blob; width: number; height: number }> {
  const canvas = new OffscreenCanvas(target.width, target.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Failed to create canvas context");
  ctx.drawImage(decoded.source, 0, 0, target.width, target.height);

  let blob = await canvas.convertToBlob({ type: "image/webp", quality: WEBP_QUALITY });
  if (blob.type !== "image/webp") {
    blob = await canvas.convertToBlob({ type: "image/jpeg", quality: WEBP_QUALITY });
  }
  return { blob, width: target.width, height: target.height };
}

async function blobToDataUri(blob: Blob): Promise<string> {
  if (typeof FileReader !== "undefined") {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("Failed to read image file"));
      reader.onload = () => resolve(reader.result as string);
      reader.readAsDataURL(blob);
    });
  }
  const buffer = await blob.arrayBuffer();
  const b64 = Buffer.from(buffer).toString("base64");
  return `data:${blob.type || "application/octet-stream"};base64,${b64}`;
}

export function resolveDisplayDimensions(
  naturalW: number,
  naturalH: number,
  density = 1
): { width: number; height: number } {
  const d = density > 0 ? density : 1;
  const width = Math.max(1, Math.round(naturalW / d));
  const height = Math.max(1, Math.round(naturalH / d));
  return { width, height };
}

export function parseFilenameDensity(filename?: string): number | null {
  if (!filename) return null;
  const match = /@([1-9](?:\.\d+)?)x(?:\.[a-zA-Z0-9]+)?$/i.exec(filename);
  if (match) {
    const scale = parseFloat(match[1]);
    return Number.isFinite(scale) && scale > 0 ? scale : null;
  }
  return null;
}

export function parsePngDensity(buffer: ArrayBuffer | Uint8Array): number | null {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (
    bytes.length < 8 ||
    bytes[0] !== 0x89 ||
    bytes[1] !== 0x50 ||
    bytes[2] !== 0x4e ||
    bytes[3] !== 0x47 ||
    bytes[4] !== 0x0d ||
    bytes[5] !== 0x0a ||
    bytes[6] !== 0x1a ||
    bytes[7] !== 0x0a
  ) {
    return null;
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(
      bytes[offset + 4],
      bytes[offset + 5],
      bytes[offset + 6],
      bytes[offset + 7]
    );

    if (type === "pHYs" && length >= 9 && offset + 8 + 9 <= bytes.length) {
      const ppux = view.getUint32(offset + 8);
      const unit = bytes[offset + 16];
      if (unit === 1 && ppux > 0) {
        const dpi = ppux * 0.0254;
        const scale = dpi / 72;
        return scale >= 1.2 ? Math.round(scale * 10) / 10 : 1;
      }
      return 1;
    }

    if (type === "IDAT" || type === "IEND") {
      break;
    }

    offset += 12 + length;
  }
  return null;
}

export function parseJpegDensity(buffer: ArrayBuffer | Uint8Array): number | null {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return null;
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) break;
    const marker = bytes[offset + 1];
    if (marker === 0xda || marker === 0xd9) break;
    if (marker === 0x00 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const segLen = view.getUint16(offset + 2);
    if (offset + 2 + segLen > bytes.length) break;

    if (marker === 0xe0 && segLen >= 16) {
      const jfif = String.fromCharCode(
        bytes[offset + 4],
        bytes[offset + 5],
        bytes[offset + 6],
        bytes[offset + 7],
        bytes[offset + 8]
      );
      if (jfif === "JFIF\0") {
        const units = bytes[offset + 11];
        const xDensity = view.getUint16(offset + 12);
        if (xDensity > 0) {
          const dpi = units === 2 ? xDensity * 2.54 : units === 1 ? xDensity : 0;
          if (dpi >= 130) {
            return Math.round((dpi / 72) * 10) / 10;
          }
        }
      }
    }

    if (marker === 0xe1 && segLen >= 14) {
      const exif = String.fromCharCode(
        bytes[offset + 4],
        bytes[offset + 5],
        bytes[offset + 6],
        bytes[offset + 7],
        bytes[offset + 8],
        bytes[offset + 9]
      );
      if (exif === "Exif\0\0") {
        const tiffStart = offset + 10;
        const littleEndian = bytes[tiffStart] === 0x49 && bytes[tiffStart + 1] === 0x49;
        const ifdOffset = view.getUint32(tiffStart + 4, littleEndian);
        const ifdStart = tiffStart + ifdOffset;
        if (ifdStart + 2 <= bytes.length) {
          const tagCount = view.getUint16(ifdStart, littleEndian);
          let xRes: number | null = null;
          let resUnit = 2;
          for (let i = 0; i < tagCount && ifdStart + 2 + (i + 1) * 12 <= bytes.length; i++) {
            const entry = ifdStart + 2 + i * 12;
            const tag = view.getUint16(entry, littleEndian);
            if (tag === 0x011a) {
              const valOffset = tiffStart + view.getUint32(entry + 8, littleEndian);
              if (valOffset + 8 <= bytes.length) {
                const num = view.getUint32(valOffset, littleEndian);
                const den = view.getUint32(valOffset + 4, littleEndian);
                if (den > 0) xRes = num / den;
              }
            } else if (tag === 0x0128) {
              resUnit = view.getUint16(entry + 8, littleEndian);
            }
          }
          if (xRes !== null && xRes > 0) {
            const dpi = resUnit === 3 ? xRes * 2.54 : xRes;
            if (dpi >= 130) {
              return Math.round((dpi / 72) * 10) / 10;
            }
          }
        }
      }
    }

    offset += 2 + segLen;
  }
  return null;
}

export async function extractImageDensity(file: File | Blob, filename?: string): Promise<number> {
  const name = filename || (file instanceof File ? file.name : undefined);
  const fromName = parseFilenameDensity(name);
  if (fromName !== null) return fromName;

  try {
    const slice = file.slice(0, 65536);
    const buffer = await slice.arrayBuffer();
    const fromPng = parsePngDensity(buffer);
    if (fromPng !== null) return fromPng;
    const fromJpeg = parseJpegDensity(buffer);
    if (fromJpeg !== null) return fromJpeg;
  } catch {
    // Decoding failure falls back to 1x.
  }
  return 1;
}

/**
 * The app's ONE image policy — `MAX_IMAGE_EDGE`, `WEBP_QUALITY` — as an asset.
 *
 * Split out of `loadImageFromFile` because there is more than one caller that
 * wants the policy without an element — the Figma importer resolves `imageRef`s
 * to assets and never places anything. That it had to be reached for is the point:
 * the Figma import path was writing documents full of 2.6MB originals while the
 * rest of the app quietly enforced a limit, and nothing anywhere said so.
 */
export async function loadImageAsset(file: File | Blob, defaultName = "Image"): Promise<AssetRef> {
  let dataUri: string;
  let naturalW: number;
  let naturalH: number;
  let assetW: number;
  let assetH: number;

  const rawName = (file as File).name || defaultName;

  if (shouldPassThrough(file)) {
    dataUri = await blobToDataUri(file);
    const measured = await measureIntrinsicSize(file);
    naturalW = measured.width;
    naturalH = measured.height;
    assetW = naturalW;
    assetH = naturalH;
  } else {
    const decoded = await decodeToBitmap(file);
    try {
      naturalW = decoded.width;
      naturalH = decoded.height;
      const target = computeTargetSize(naturalW, naturalH);
      const isWithinLimits = target.width === naturalW && target.height === naturalH;
      const modernMime = isWithinLimits ? await detectModernFormat(file) : null;

      if (modernMime) {
        const blobToUse = (file as File).type === modernMime ? file : new Blob([file], { type: modernMime });
        dataUri = await blobToDataUri(blobToUse);
        assetW = naturalW;
        assetH = naturalH;
      } else {
        const { blob, width, height } = await encodeDownscaled(decoded, target);
        dataUri = await blobToDataUri(blob);
        assetW = width;
        assetH = height;
      }
    } finally {
      decoded.close();
    }
  }

  const assetId = createId("asset");
  const name = (file as File).name ? (file as File).name.replace(/\.[^/.]+$/, "") : defaultName;

  return { id: assetId, name, uri: dataUri, width: assetW, height: assetH };
}

export async function loadImageFromFile(
  file: File | Blob,
  worldX: number,
  worldY: number,
  defaultName = "Image",
  densityOverride?: number
): Promise<LoadedImageData> {
  const asset = await loadImageAsset(file, defaultName);
  const density =
    densityOverride && densityOverride > 0
      ? densityOverride
      : await extractImageDensity(file, (file as File).name || defaultName);
  const { width, height } = resolveDisplayDimensions(asset.width ?? 0, asset.height ?? 0, density);
  const { id: assetId, name } = asset;

  const element = createImageFillElement({
    name,
    x: worldX,
    y: worldY,
    width,
    height,
    assetId,
    fit: "cover"
  });

  return { asset, element };
}

export function extractNameFromUrl(url: string): string {
  try {
    const pathname = new URL(url).pathname;
    const segments = pathname.split("/").filter(Boolean);
    if (segments.length > 0) {
      const last = segments[segments.length - 1];
      const clean = decodeURIComponent(last).replace(/\.[^/.]+$/, "");
      if (clean) return clean;
    }
  } catch {
    // Ignore URL parse failure.
  }
  return "Image";
}

export function isImageUrl(text: string): boolean {
  const trimmed = text.trim();
  if (!/^https?:\/\/[^\s$.?#].[^\s]*$/i.test(trimmed)) {
    return false;
  }
  return (
    /\.(png|jpe?g|webp|svg|gif|avif|bmp|ico)(\?.*)?$/i.test(trimmed) ||
    /(images\.|img\.|photos\.|upload|asset|\/image\/|\/images\/|\/photo\/|\/photos\/)/i.test(trimmed)
  );
}

export async function loadImageFromUrl(
  url: string,
  worldX = 0,
  worldY = 0,
  defaultName?: string,
  signal?: AbortSignal
): Promise<LoadedImageData> {
  const cleanUrl = url.trim();
  if (!cleanUrl) {
    throw new Error("URL is empty");
  }
  if (signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }

  return new Promise<LoadedImageData>((resolve, reject) => {
    const img = new Image();
    img.decoding = "async";
    img.crossOrigin = "anonymous";

    const onAbort = () => {
      img.src = "";
      reject(new DOMException("Aborted", "AbortError"));
    };

    signal?.addEventListener("abort", onAbort, { once: true });

    img.onload = () => {
      signal?.removeEventListener("abort", onAbort);
      const naturalW = img.naturalWidth || 400;
      const naturalH = img.naturalHeight || 300;
      const name = defaultName || extractNameFromUrl(cleanUrl);
      const density = parseFilenameDensity(cleanUrl) || 1;
      const { width, height } = resolveDisplayDimensions(naturalW, naturalH, density);
      const assetId = createId("asset");
      const asset: AssetRef = {
        id: assetId,
        name,
        uri: cleanUrl,
        width: naturalW,
        height: naturalH
      };
      const element = createImageFillElement({
        name,
        x: worldX,
        y: worldY,
        width,
        height,
        assetId,
        fit: "cover"
      });
      resolve({ asset, element });
    };
    img.onerror = () => {
      if (signal?.aborted) return;
      const imgFallback = new Image();
      const onAbortFallback = () => {
        imgFallback.src = "";
        reject(new DOMException("Aborted", "AbortError"));
      };
      signal?.addEventListener("abort", onAbortFallback, { once: true });

      imgFallback.onload = () => {
        signal?.removeEventListener("abort", onAbortFallback);
        const naturalW = imgFallback.naturalWidth || 400;
        const naturalH = imgFallback.naturalHeight || 300;
        const name = defaultName || extractNameFromUrl(cleanUrl);
        const density = parseFilenameDensity(cleanUrl) || 1;
        const { width, height } = resolveDisplayDimensions(naturalW, naturalH, density);
        const assetId = createId("asset");
        const asset: AssetRef = {
          id: assetId,
          name,
          uri: cleanUrl,
          width: naturalW,
          height: naturalH
        };
        const element = createImageFillElement({
          name,
          x: worldX,
          y: worldY,
          width,
          height,
          assetId,
          fit: "cover"
        });
        resolve({ asset, element });
      };
      imgFallback.onerror = () => {
        signal?.removeEventListener("abort", onAbortFallback);
        reject(new Error("Failed to load image from URL"));
      };
      imgFallback.src = cleanUrl;
    };
    img.src = cleanUrl;
  });
}

export async function embedExternalAsset(asset: AssetRef): Promise<AssetRef> {
  const url = asset.uri?.trim() || "";
  if (!url || (!url.startsWith("http://") && !url.startsWith("https://"))) {
    return asset;
  }

  // CORS is the only failure that retrying somewhere else can fix. An HTTP
  // status is the server's answer and a timeout is the network's, and neither
  // gets better through a third party — so a 404 is reported as a 404 instead
  // of being replayed through the proxy, and a timeout is not retried at all.
  let response: Response | null = null;
  let directError: unknown;
  try {
    response = await externalFetch(url);
  } catch (err) {
    if (isAbortFailure(err)) throw err;
    directError = err;
  }
  if (!response) {
    // `null` means this address carries something private — an intranet host, a
    // signed query string, plain http. Sending it to a public proxy would leak
    // exactly what it was addressing, so the original failure is the answer.
    const proxyUrl = publicProxyUrl(url);
    if (!proxyUrl) throw directError;
    response = await externalFetch(proxyUrl);
  }
  if (!response.ok) {
    throw new Error(`Failed to fetch image: ${response.statusText}`);
  }
  const blob = await response.blob();
  const rawPath = url.split("?")[0];
  const urlFilename = rawPath.split("/").pop() || "";
  const filename = urlFilename.includes(".") ? urlFilename : asset.name || "image";
  const file = new File([blob], filename, { type: blob.type });

  const embedded = await loadImageAsset(file, asset.name || "image");
  return {
    ...asset,
    uri: embedded.uri,
    width: embedded.width,
    height: embedded.height
  };
}

