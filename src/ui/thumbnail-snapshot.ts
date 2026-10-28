import type { DesignDocument } from "../core/dsl/types";
import { findThumbnailTargetFrame } from "../core/thumbnail-target";
import { buildThumbnailSvg, type ThumbnailArt } from "./thumbnail-svg";

/**
 * A rasterized cover, kept so the SAVE path can stay synchronous.
 *
 * `serializeSelf` writes a file inside a keystroke; decode → draw → encode is
 * three async hops and cannot live there. So the bitmap is produced ahead of the
 * save, on a debounce, and the generator only has to paste a string. A save that
 * arrives before the bitmap exists is not a reason to ship a cover-less file:
 * the SVG form of the same art is what it falls back to.
 *
 * The cache is keyed by object IDENTITY, not by a hash. Documents are updated
 * immutably, so a frame whose subtree changed is a different object, and asking
 * a deep tree "are you still equal" on every commit would cost more than the
 * snapshot it protects.
 */

// A cover is a thumbnail, not an export: 1600 on the long edge is ~2x a phone
// screen and stays legible when a file browser blows it up to a card. The encode
// quality is the app's own image policy (`WEBP_QUALITY` in `image-loader`), which
// is not importable here without dragging the whole image pipeline into the save
// path for one number.
const THUMBNAIL_MAX_EDGE = 1600;
const THUMBNAIL_QUALITY = 0.8;
// In order of preference. Both are a fraction of the raw pixels and both are
// readable by every engine that can decode a `data:` image at all.
const THUMBNAIL_FORMATS = ["image/webp", "image/avif"] as const;
// Long enough that typing does not queue fifty encodes, short enough that the
// cover is ready before the autosave that follows a pause.
const DEBOUNCE_MS = 400;

export interface ThumbnailSnapshot {
  uri: string;
  width: number;
  height: number;
}

interface CacheEntry extends ThumbnailSnapshot {
  frame: unknown;
  assets: unknown;
}

let cache: CacheEntry | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
// Encodes are chained rather than run concurrently: a second one in flight would
// only race the first into the cache with the older picture, and the chain is
// what lets a later encode run after the current one instead of being dropped.
let chain: Promise<void> = Promise.resolve();

/** The snapshot for this document, or null when it is stale or absent. */
export function cachedThumbnailSnapshot(doc: DesignDocument): ThumbnailSnapshot | null {
  if (!cache) return null;
  const frame = findThumbnailTargetFrame(doc);
  if (!frame || frame !== cache.frame) return null;
  // A re-imported bitmap changes the picture without touching the frame.
  if (doc.assets !== cache.assets) return null;
  return { uri: cache.uri, width: cache.width, height: cache.height };
}

/** Schedule a refresh; safe to call on every commit. */
export function primeThumbnailSnapshot(doc: DesignDocument): void {
  if (typeof document === "undefined") return;
  if (cachedThumbnailSnapshot(doc)) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void enqueue(doc);
  }, DEBOUNCE_MS);
}

export function resetThumbnailSnapshot(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  cache = null;
}

/** Append one encode to the chain, and answer for THAT encode. */
function enqueue(doc: DesignDocument): Promise<void> {
  const run = chain.then(() => (cachedThumbnailSnapshot(doc) ? undefined : encodeIntoCache(doc)));
  chain = run.catch(() => {});
  return run;
}

async function encodeIntoCache(doc: DesignDocument): Promise<void> {
  try {
    const art = buildThumbnailSvg(doc);
    if (!art) return;
    const uri = await rasterize(art);
    const frame = findThumbnailTargetFrame(doc);
    if (uri && frame) cache = { uri, width: art.width, height: art.height, frame, assets: doc.assets };
  } catch (err) {
    // A cover is decoration: losing one must never surface as a failed save.
    console.warn("FISH: thumbnail snapshot failed:", err);
  }
}

async function rasterize(art: ThumbnailArt): Promise<string | null> {
  const scale = Math.min(2, THUMBNAIL_MAX_EDGE / Math.max(art.width, art.height));
  const pixelWidth = Math.max(1, Math.round(art.width * scale));
  const pixelHeight = Math.max(1, Math.round(art.height * scale));

  const sized = withPixelSize(art.svg, pixelWidth, pixelHeight);
  // A Blob URL rather than a percent-encoded data URI: the artwork carries the
  // cover's bitmaps inline, so the string form would be several hundred KB of
  // escaping for a decode that reads it once.
  const url = URL.createObjectURL(new Blob([sized], { type: "image/svg+xml;charset=utf-8" }));
  try {
    const image = await decodeSvg(url);
    if (!image) return null;
    const canvas = document.createElement("canvas");
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(image, 0, 0, pixelWidth, pixelHeight);

    // No engine encodes both of the good formats: Chrome has WebP and no AVIF,
    // WebKit the reverse. Asking for a type the engine cannot produce does not
    // fail — it quietly hands back a PNG, which is bigger than the SVG this
    // replaces. So each answer is checked against what was asked for, and the
    // two are tried in turn: whichever engine saved the file wrote a format every
    // other engine can read.
    for (const type of THUMBNAIL_FORMATS) {
      const blob = await encode(canvas, type);
      if (blob && blob.type === type) return await blobToDataUri(blob);
    }

    // Last resort: JPEG, which every engine has. It has no alpha, so the canvas
    // colour goes underneath — the same colour the preview paints behind the
    // picture, which is what makes the swap invisible.
    ctx.save();
    ctx.globalCompositeOperation = "destination-over";
    ctx.fillStyle = art.background;
    ctx.fillRect(0, 0, pixelWidth, pixelHeight);
    ctx.restore();
    const jpeg = await encode(canvas, "image/jpeg");
    return jpeg && jpeg.type === "image/jpeg" ? await blobToDataUri(jpeg) : null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function encode(canvas: HTMLCanvasElement, type: string): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, THUMBNAIL_QUALITY));
}

/**
 * Load the artwork as an image.
 *
 * `decode()` is the ordered way to wait, but it rejects for reasons that do not
 * always mean the picture is unusable, so load/error is wired as the fallback
 * rather than trusting one API to be right about both.
 */
function decodeSvg(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const image = new Image();
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolve(ok ? image : null);
    };
    image.onload = () => done(true);
    image.onerror = () => done(false);
    image.src = url;
    if (typeof image.decode === "function") {
      try {
        image.decode().then(
          () => done(true),
          () => done(false)
        );
      } catch {
        // An engine that throws here still paints through `onload`.
      }
    }
  });
}

/**
 * Intrinsic size for the raster: an `<img>` has none to read off a viewBox.
 *
 * The inline `width:100%;height:100%` the preview needs is stripped here — on an
 * image, a percentage width resolves against a containing block that does not
 * exist yet, and the picture comes back empty rather than merely mis-sized.
 */
function withPixelSize(markup: string, width: number, height: number): string {
  return markup.replace(/<svg\b[^>]*>/, (tag) => {
    const attrs = tag
      .slice(4, -1)
      .replace(/\sstyle="[^"]*"/, "")
      .replace(/\swidth="[^"]*"/, "")
      .replace(/\sheight="[^"]*"/, "");
    return `<svg${attrs} width="${width}" height="${height}" style="display:block">`;
  });
}

async function blobToDataUri(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return `data:${blob.type};base64,${btoa(binary)}`;
}
