/**
 * What the live canvas points an `<image>` at while the layer is small on screen.
 *
 * A document stores its bitmaps inline, so `asset.uri` is the pixels at full
 * resolution — 4800×1186 of them for a layer that may cover 200×120 screen px.
 * Skia samples every one of those texels per tile, which is where a zoom's
 * raster time goes. So a layer covering no more device pixels than
 * `PROXY_MAX_EDGE` is painted from a bake of that size instead.
 *
 * The bake is handed over as a `blob:` handle, because that is the only way to
 * point at bytes that exist nowhere in the document. Nothing else is converted:
 * a layer large enough to need its own resolution keeps the document's `data:`
 * URI, so no bitmap is ever held twice.
 *
 * `restoreSourceUris` is the other half: an export clones the live SVG, so a
 * handle has to become the document's own URI again before that markup leaves
 * the tab.
 */

import type { AssetRef } from "../dsl/types";

/** Long edge of the bake, in device pixels. */
const PROXY_MAX_EDGE = 512;
/** Sources at or under this edge are already cheap to sample; no bake is made. */
const PROXY_SOURCE_MIN_EDGE = 1024;
const MAX_ENTRIES = 256;

interface Entry {
  source: string;
  proxy: string | null;
  pending: boolean;
}

const entries = new Map<string, Entry>();
const sources = new Map<string, string>();
const listeners = new Set<() => void>();
let pendingNotify = false;

/** Told when a bake becomes available, so the canvas can pick it up. */
export function onRenderUriReady(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify() {
  if (pendingNotify || listeners.size === 0) return;
  pendingNotify = true;
  // Trailing, not a microtask: a document opens with a hundred bitmaps, and each
  // one settling must not rebuild every `<defs>` it happens to belong to.
  setTimeout(() => {
    pendingNotify = false;
    for (const listener of listeners) listener();
  }, 40);
}

function usable(): boolean {
  return (
    typeof URL !== "undefined" &&
    typeof URL.createObjectURL === "function" &&
    typeof createImageBitmap === "function" &&
    typeof OffscreenCanvas !== "undefined" &&
    typeof fetch === "function"
  );
}

/** The `data:` URI a handle stands for, for the export clone. */
export function sourceUriFor(uri: string): string {
  return sources.get(uri) ?? uri;
}

function entryFor(uri: string): Entry {
  const existing = entries.get(uri);
  if (existing) return existing;
  if (entries.size >= MAX_ENTRIES) {
    const oldest = entries.keys().next().value;
    if (oldest !== undefined) {
      const drop = entries.get(oldest);
      entries.delete(oldest);
      if (drop?.proxy) {
        sources.delete(drop.proxy);
        try {
          URL.revokeObjectURL(drop.proxy);
        } catch {
          // A handle the engine already released.
        }
      }
    }
  }
  const entry: Entry = { source: uri, proxy: null, pending: false };
  entries.set(uri, entry);
  return entry;
}

function idle(run: () => void): void {
  const ric = (globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => void })
    .requestIdleCallback;
  if (ric) ric(run, { timeout: 2000 });
  else setTimeout(run, 0);
}

async function bake(entry: Entry): Promise<void> {
  const response = await fetch(entry.source);
  if (!response.ok) return;
  const bitmap = await createImageBitmap(await response.blob());
  try {
    const edge = Math.max(bitmap.width, bitmap.height);
    if (edge <= PROXY_SOURCE_MIN_EDGE) return;
    const scale = PROXY_MAX_EDGE / edge;
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(bitmap, 0, 0, width, height);
    const out = await canvas.convertToBlob({ type: "image/webp", quality: 0.82 });
    const handle = URL.createObjectURL(out);
    sources.set(handle, entry.source);
    entry.proxy = handle;
  } finally {
    bitmap.close?.();
  }
}

function ensureProxy(entry: Entry): void {
  if (entry.proxy || entry.pending) return;
  entry.pending = true;
  idle(() => {
    void (async () => {
      try {
        await bake(entry);
      } catch {
        // A picture that cannot be decoded is painted from its data URI.
      } finally {
        entry.pending = false;
        notify();
      }
    })();
  });
}

/**
 * The URI to paint an asset with, given how many device pixels it will cover.
 *
 * The document's own URI until a bake exists: the first frame of a session is
 * never slower than it was before this module existed, and the swap lands on the
 * next paint after the bake is ready.
 */
export function imageRenderUri(
  asset: Pick<AssetRef, "uri" | "width" | "height">,
  deviceWidth: number,
  deviceHeight: number
): string {
  const uri = asset.uri;
  if (!uri || !uri.startsWith("data:")) return uri;
  const naturalEdge = Math.max(asset.width ?? 0, asset.height ?? 0);
  const displayed = Math.max(deviceWidth, deviceHeight);
  if (naturalEdge <= PROXY_SOURCE_MIN_EDGE || !(displayed > 0) || displayed > PROXY_MAX_EDGE) return uri;
  if (!usable()) return uri;
  const entry = entryFor(uri);
  ensureProxy(entry);
  return entry.proxy ?? uri;
}

/**
 * Give an export clone the document's own URIs back.
 *
 * Called on the clone before anything serializes or rasterizes it: a `blob:`
 * handle is meaningless outside this tab, and an SVG-as-`<img>` decode cannot
 * resolve one at all.
 */
export function restoreSourceUris(root: ParentNode): void {
  const images = root.querySelectorAll("image, feImage");
  for (let i = 0; i < images.length; i++) {
    const el = images[i];
    for (const attr of ["href", "xlink:href"]) {
      const value = el.getAttribute(attr);
      if (!value || !value.startsWith("blob:")) continue;
      el.setAttribute(attr, sourceUriFor(value));
    }
  }
}

/** Drop every handle. Test hook, and the seam a new document can reuse. */
export function resetRenderUris(): void {
  for (const entry of entries.values()) {
    if (!entry.proxy) continue;
    sources.delete(entry.proxy);
    try {
      URL.revokeObjectURL(entry.proxy);
    } catch {
      // already gone
    }
  }
  entries.clear();
}
