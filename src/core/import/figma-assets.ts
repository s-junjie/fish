/**
 * Figma image fills → document assets.
 *
 * Same contract as `html-assets.ts` and for the same reason: the walk is
 * synchronous and decoding is not, so every image a file references is resolved
 * BEFORE the walk starts and the walk only ever looks up an answer.
 *
 * A Figma image fill holds an `imageRef`, not bytes. The plugin's export carries
 * the bytes beside the document — as files in a zip, or inlined as data URIs in
 * the older single-`.json` packaging — so both halves matter: an import that
 * registers no asset drops the paint entirely, so a wrong step here does not
 * degrade the pictures, it deletes them.
 */

import type { AssetRef } from "../dsl/types";
import { createId } from "../id";
import { loadImageAsset } from "../interactions/image-loader";

/** Enough assets inlined for a document to stay a single portable file. */
const MAX_INLINE_IMAGES = 200;

export interface FigmaAssetStore {
  /** The asset id for an `imageRef`, or `undefined` when nothing was resolved. */
  idFor(ref: string | undefined): string | undefined;
  /** Why `idFor` said no. Empty when the ref was never attempted. */
  reason(ref: string): string;
  assets: AssetRef[];
  /** Refs deliberately not fetched, so the report can say why. */
  skipped: Array<{ ref: string; reason: string }>;
  /**
   * Refs the file referenced that resolved no bytes at all.
   *
   * Kept apart from `skipped` because the two are different failures with
   * different fixes — one is this importer's own limit, the other is an export
   * that did not carry the image — and because an empty `assets` array with a
   * non-empty `failed` is the shape of "every photograph in the design is about
   * to disappear", which must not be reportable as success.
   */
  failed: Array<{ ref: string; reason: string }>;
  /**
   * Every ref that produced an asset, and where its bytes live — the map a
   * caller saves so the same file can be imported again with nothing to hand.
   */
  uris: Record<string, string>;
}

/**
 * Walk the document for every `imageRef` a picture is carried by.
 *
 * Starts at the FILE RESPONSE rather than the document, because a response wraps
 * the tree in `{ document: { children } }` and has no `children` of its own —
 * starting at the response and descending only through `children` walks an empty
 * tree, finds no refs, and every image in the file silently loses its bytes.
 *
 * EVERY node is asked, rather than a list of types that look like they could
 * hold a picture. A bare `IMAGE` node is the rare spelling; the common one is an
 * ordinary rectangle, frame or ellipse with an `IMAGE` paint — and a `GROUP`, a
 * `BOOLEAN_OPERATION` or a `STAR` can carry one too. A whitelist of carriers is
 * one more place for a picture to go missing, and it goes missing by never being
 * asked for.
 *
 * `videoRef` is collected on the same walk and for the same reason: what travels
 * under a video's ref is its POSTER frame, which is a picture like any other, and
 * a ref this never asks for is a poster the asset store never registers — so the
 * layer would fall back to losing its clip with the bytes sitting right there in
 * the export.
 */
export function collectFigmaImageRefs(node: unknown, into: string[] = []): string[] {
  if (!node || typeof node !== "object") return into;
  const record = node as {
    document?: unknown;
    fills?: Array<{ type?: string; imageRef?: string; videoRef?: string }>;
    children?: unknown[];
  };
  for (const fill of record.fills ?? []) {
    if (fill?.type === "IMAGE" && typeof fill.imageRef === "string" && fill.imageRef) into.push(fill.imageRef);
    if (fill?.type === "VIDEO" && typeof fill.videoRef === "string" && fill.videoRef) into.push(fill.videoRef);
  }
  if (record.document) collectFigmaImageRefs(record.document, into);
  for (const child of record.children ?? []) collectFigmaImageRefs(child, into);
  return into;
}

/**
 * A store built from the data URIs an older single-`.json` export inlines.
 *
 * The same rules as the byte path, through the same builder, because "what an
 * asset is" must not have two answers: a zip carrying forty photographs and a
 * `.json` carrying the same forty as strings have to produce the same document.
 *
 * The URIs are registered VERBATIM here — this is the path for a caller that
 * already holds resolved images (a fixture, a re-import of a saved document).
 * For the two packagings the plugin writes, `useFigmaImport` unpacks the inline
 * form with `blobsFromImageFills` and takes the blob path instead, because that
 * is the path the app's image policy lives on.
 */
export function figmaAssetStoreFromUris(
  refs: readonly string[],
  uris: Readonly<Record<string, string>>
): FigmaAssetStore {
  const builder = assetBuilder();
  for (const ref of builder.capToInlineLimit([...new Set(refs)])) {
    const uri = uris[ref];
    if (uri) builder.add(ref, uri);
    else builder.fail(ref, "the offline bundle carries no bytes for this image");
  }
  return builder.store();
}

/**
 * The inline form of a bundle's images, as bytes.
 *
 * A data URI is the only packaging a clipboard can carry — the plugin's Copy
 * button writes the single-file envelope — and it is also the one form that used
 * to skip the app's image policy: registered verbatim, a 2.6MB photograph
 * arrives in the document at 2.6MB, where the SAME photograph in a folder comes
 * back through that policy. Unpacking it here and handing the bytes to
 * `figmaAssetStoreFromBlobs` is what makes the two packagings cost the same,
 * whichever door they came through (`docs/FIGMA_IMPORT_PLAN.md` §0: how big an
 * image ends up in a document is the app's decision).
 *
 * A URI that is not a data URI at all yields nothing for that ref, which the
 * blob path then reports as an image that did not arrive — named, rather than
 * decoded into a broken paint.
 */
export function blobsFromImageFills(imageFills: Readonly<Record<string, string>>): Map<string, Blob> {
  const out = new Map<string, Blob>();
  for (const [ref, uri] of Object.entries(imageFills)) {
    const blob = blobFromDataUri(uri);
    if (blob) out.set(ref, blob);
  }
  return out;
}

/** `data:<mime>;base64,<b64>` (or the URL-encoded spelling) → bytes with a type. */
function blobFromDataUri(uri: string): Blob | null {
  const match = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(uri);
  if (!match) return null;
  const [, mime, isBase64, body] = match;
  if (!isBase64) return new Blob([decodeURIComponent(body)], { type: mime });
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

/**
 * A store built from raw image bytes, put through the app's image policy first.
 *
 * This is the difference between a 99MB export and a document anyone can open.
 * Figma's plugin hands over what the designer uploaded — a real export carried 38
 * photographs totalling 99.6MB, the largest a single 2.6MB — while every other way
 * into FISH's library goes through `loadImageAsset` and its image policy. The
 * Figma door was the one path that skipped it, and nothing said so.
 *
 * The policy is applied HERE, in the app, rather than in the plugin: how large an
 * image ends up in a document is the app's decision, and a plugin that resized on
 * its own would be making it (`docs/FIGMA_IMPORT_PLAN.md` §0).
 *
 * A failure is per-image rather than fatal. One unreadable photograph must not
 * cost the other thirty-seven, and the one that failed is named.
 */
export async function figmaAssetStoreFromBlobs(
  refs: readonly string[],
  images: ReadonlyMap<string, Blob>,
  onProgress?: (done: number, total: number) => void
): Promise<FigmaAssetStore> {
  const builder = assetBuilder();
  const inlinable = builder.capToInlineLimit([...new Set(refs)]);

  // A POOL, NOT A `Promise.all`.
  //
  // A decoded bitmap is four bytes per pixel, so a 3000×2000 photograph is ~24MB
  // the moment it is decoded — and 38 of them at once, which is what awaiting all
  // of them in parallel means, is close to a gigabyte of bitmaps competing for one
  // tab. Four at a time keeps the peak at what a few pictures cost and lets each
  // one's `close()` actually return memory before the next one allocates.
  //
  // It is also what makes the progress honest: with a pool, "12 of 38" means
  // twelve are DONE, rather than twelve have been started.
  interface Settled {
    ref: string;
    asset: AssetRef | null;
    reason: string | null;
  }
  const settled: Settled[] = [];
  const queue = [...inlinable];
  const workers = Array.from({ length: Math.min(IMAGE_POOL, queue.length) }, async () => {
    for (;;) {
      const ref = queue.shift();
      if (!ref) return;
      const blob = images.get(ref);
      if (!blob) {
        settled.push({ ref, asset: null, reason: "the export carries no bytes for this image" });
      } else {
        try {
          settled.push({ ref, asset: await loadImageAsset(blob, assetNameFor(ref)), reason: null });
        } catch {
          settled.push({ ref, asset: null, reason: "these bytes are not an image this could read" });
        }
      }
      onProgress?.(inlinable.length - queue.length, inlinable.length);
    }
  });
  await Promise.all(workers);

  // Registration order follows the document's, not completion order, so two runs
  // of the same file produce the same assets in the same order.
  const byRef = new Map(settled.map((entry) => [entry.ref, entry]));
  for (const ref of inlinable) {
    const entry = byRef.get(ref);
    if (!entry) continue;
    if (entry.asset) builder.put(ref, entry.asset);
    else builder.fail(ref, entry.reason ?? "this image could not be read");
  }
  return builder.store();
}

/** How many images are decoded at once. See the pool above for why not all of them. */
const IMAGE_POOL = 4;

/** A readable asset name, because the ref is a hash and the layer panel shows this. */
function assetNameFor(ref: string): string {
  return `figma-image-${ref.slice(0, 8)}`;
}

/**
 * The one place an asset is minted, named and counted.
 *
 * The plugin's export arrives two ways — a zip of bytes, or a `.json` with the
 * images inlined — and everything AFTER that has to agree, or the same file
 * imports into two different documents depending on which packaging it came in.
 */
function assetBuilder() {
  const assets: AssetRef[] = [];
  const idByRef = new Map<string, string>();
  const reasons = new Map<string, string>();
  const skipped: Array<{ ref: string; reason: string }> = [];
  const failed: Array<{ ref: string; reason: string }> = [];
  const uris: Record<string, string> = {};

  return {
    /**
     * The bytes are inlined so a `.fish.html` opened offline still shows its
     * photographs. Past this many, the remaining layers keep their box and lose
     * their paint — a gap the report names — rather than silently growing a file
     * nobody can open. Applied to a bundle too: where the bytes came from does
     * not change how big the document they would become.
     */
    capToInlineLimit(unique: string[]): string[] {
      for (const ref of unique.slice(MAX_INLINE_IMAGES)) {
        skipped.push({ ref, reason: `past the ${MAX_INLINE_IMAGES}-image inline limit` });
        reasons.set(ref, "past the inline limit");
      }
      return unique.slice(0, MAX_INLINE_IMAGES);
    },
    /**
     * A data URI the export inlined, as an asset.
     *
     * Registering rather than pushing is the point: `uris`, the id lookup and the
     * asset list are one map, and an asset that skipped them would paint as a
     * broken image with nothing in the report to explain it.
     */
    add(ref: string, uri: string): void {
      const id = createId("asset");
      idByRef.set(ref, id);
      assets.push({ id, name: `figma-image-${assets.length + 1}.png`, uri });
      uris[ref] = uri;
    },
    /**
     * An asset that has already been made, rather than made here.
     *
     * The blob path runs the app's image policy BEFORE it gets here, so this one
     * takes a finished `AssetRef` and registers it — policy included.
     */
    put(ref: string, asset: AssetRef): void {
      idByRef.set(ref, asset.id);
      assets.push(asset);
      uris[ref] = asset.uri;
    },

    fail(ref: string, reason: string): void {
      reasons.set(ref, reason);
      failed.push({ ref, reason });
    },
    store(): FigmaAssetStore {
      return {
        idFor: (ref) => (ref ? idByRef.get(ref) : undefined),
        reason: (ref) => reasons.get(ref) ?? "",
        assets,
        skipped,
        failed,
        uris
      };
    }
  };
}

/** A store that resolved nothing, for a caller that handed over no bytes at all. */
export function emptyFigmaAssetStore(): FigmaAssetStore {
  return { idFor: () => undefined, reason: () => "", assets: [], skipped: [], failed: [], uris: {} };
}
