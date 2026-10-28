/**
 * Filling in the bitmaps an import could not reach.
 *
 * A page opened from disk arrives as text, so `src="assets/hero.jpg"` has no
 * base to resolve against and the picture is lost while its box survives. The
 * bytes exist on the same disk — they are just not in the file the user handed
 * over. This is the other half: match what the page asked for against the files
 * in a folder the user picks afterwards, and put the pictures back on the
 * elements that are already placed.
 *
 * Matching is by path, never by order: the folder may be the page's own
 * directory, its parent, or its `assets/` subdirectory, and a file is the right
 * one only if the page's URL is a tail of its path.
 */

import type { AssetRef, DesignDocument, DesignElement, ImagePaint } from "../dsl/types";
import { getActivePage, updateActivePageElements } from "../dsl/types";
import { findElementById, mapElements } from "../geometry/tree-ops";
import { cropFromPosition } from "../geometry/image-crop";
import { createId } from "../id";
import type { MissingAsset, MissingPaint } from "./html-types";

/** One file in the picked folder, with the path the picker gave it. */
export interface FolderFile {
  /** e.g. `demo/assets/hero.jpg` — the browser's `webkitRelativePath`. */
  path: string;
  file: File;
}

/** A missing URL whose bytes were found, already inlined. */
export interface ResolvedAsset {
  url: string;
  name: string;
  /** data URI, same shape the import's own asset pass produces. */
  uri: string;
  width: number;
  height: number;
}

/**
 * The path a page's URL names, with `.`/`..` collapsed and the query dropped.
 *
 * `undefined` for anything that is not a relative path: an absolute URL was
 * never missing for want of a folder, and a URL that climbs out of the page's
 * own directory (`../logo.png`) has no base to climb from, so no folder the
 * user picks can be shown to be the right one.
 */
export function normalizeRelative(url: string): string | undefined {
  let value = url.trim();
  if (!value || value.startsWith("//") || value.startsWith("#")) return undefined;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return undefined;
  value = value.split("#")[0].split("?")[0];
  try {
    value = decodeURIComponent(value);
  } catch {
    // A percent sign that is not an escape: match it as written.
  }
  const parts: string[] = [];
  for (const segment of value.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (parts.length === 0) return undefined;
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return parts.length > 0 ? parts.join("/") : undefined;
}

/** Every file in the folder, keyed by its normalized path. */
export function indexFolder(files: readonly FolderFile[]): Map<string, File> {
  const index = new Map<string, File>();
  for (const entry of files) {
    const key = normalizeRelative(entry.path);
    if (key && !index.has(key)) index.set(key, entry.file);
  }
  return index;
}

/**
 * The file that satisfies `url`, or `undefined`.
 *
 * Three passes, each weaker than the last, because the user picks a folder
 * without being told which one: the page's own directory, a directory above it
 * (the URL is then a tail of the path), and finally a bare filename — the last
 * only when exactly one file in the folder carries it.
 *
 * Every pass declines a TIE rather than picking one: two `assets/hero.jpg` in
 * different branches of the tree is a guess, and a wrong photo is worse than an
 * empty box the user can see is empty.
 */
export function matchAsset(url: string, index: Map<string, File>): File | undefined {
  const key = normalizeRelative(url);
  if (!key) return undefined;

  const exact = index.get(key);
  if (exact) return exact;

  let shallow: { depth: number; file: File } | null = null;
  let tied = false;
  for (const [path, file] of index) {
    if (!path.endsWith(`/${key}`)) continue;
    const depth = path.split("/").length;
    if (!shallow || depth < shallow.depth) {
      shallow = { depth, file };
      tied = false;
    } else if (depth === shallow.depth) {
      tied = true;
    }
  }
  if (shallow && !tied) return shallow.file;

  const base = key.slice(key.lastIndexOf("/") + 1);
  let byName: File | undefined;
  for (const [path, file] of index) {
    if (path.slice(path.lastIndexOf("/") + 1) !== base) continue;
    if (byName) return undefined;
    byName = file;
  }
  return byName;
}

/**
 * One file from the picked folder, inlined and measured.
 *
 * The size is the bitmap's own, because the import solved its crop framing
 * against exactly that number: a `cover` framing computed from a wrong natural
 * size is a photo framed on nothing in particular.
 */
export async function readFolderImage(
  file: File
): Promise<{ uri: string; width: number; height: number } | null> {
  const uri = await new Promise<string | null>((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : null);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
  if (!uri) return null;
  const size = await measure(uri);
  return { uri, width: size.width, height: size.height };
}

async function measure(uri: string): Promise<{ width: number; height: number }> {
  try {
    const bitmap = await createImageBitmap(await (await fetch(uri)).blob());
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return size;
  } catch {
    // A format `createImageBitmap` will not decode still has an `<img>` answer.
    return new Promise((resolve) => {
      const image = new Image();
      image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
      image.onerror = () => resolve({ width: 0, height: 0 });
      image.src = uri;
    });
  }
}

/**
 * Put the pictures back on the elements that are waiting for them.
 *
 * The paint was solved during the import, so attaching is mostly an id and an
 * asset. Elements the user has since deleted are skipped, and a URL with no
 * bytes stays on the missing list rather than being silently forgotten.
 */
export function attachMissingAssets(
  doc: DesignDocument,
  missing: readonly MissingAsset[],
  resolved: readonly ResolvedAsset[]
): { doc: DesignDocument; attached: number; remaining: MissingAsset[] } {
  const byUrl = new Map(resolved.map((asset) => [asset.url, asset]));
  const assets: AssetRef[] = [...(doc.assets ?? [])];
  const idByUrl = new Map<string, string>();
  const paintsByElement = new Map<string, ImagePaint[]>();
  const remaining: MissingAsset[] = [];
  const children = getActivePage(doc).children;
  let attached = 0;

  for (const entry of missing) {
    const bytes = byUrl.get(entry.url);
    const target = bytes ? findElementById(children, entry.elementId) : null;
    if (!bytes || !target) {
      remaining.push(entry);
      continue;
    }
    let assetId = idByUrl.get(entry.url);
    if (!assetId) {
      assetId = createId("asset");
      idByUrl.set(entry.url, assetId);
      assets.push({
        id: assetId,
        name: bytes.name,
        uri: bytes.uri,
        width: Math.round(bytes.width) || undefined,
        height: Math.round(bytes.height) || undefined
      } as AssetRef);
    }
    const paint: ImagePaint = { type: "image", assetId, ...solveCrop(entry, bytes, target) };
    const list = paintsByElement.get(entry.elementId);
    if (list) list.push(paint);
    else paintsByElement.set(entry.elementId, [paint]);
    attached += 1;
  }

  if (paintsByElement.size === 0) return { doc, attached: 0, remaining };

  const next = mapElements(children, (el: DesignElement) => {
    const add = paintsByElement.get(el.id);
    if (!add) return el;
    return { ...el, fills: [...(el.fills ?? []), ...add] } as DesignElement;
  });

  return {
    doc: { ...updateActivePageElements(doc, next), assets },
    attached,
    remaining
  };
}

/**
 * The framing, now that the bitmap's own size is known.
 *
 * `object-position` is a fraction of the overflow, so the import could only keep
 * it: the box belongs to the element and the size to the folder, and this is the
 * one moment both are in hand.
 */
function solveCrop(entry: MissingAsset, bytes: ResolvedAsset, target: DesignElement): MissingPaint {
  const { paint, position } = entry;
  if (!position || paint.fit === "fill" || bytes.width <= 0 || bytes.height <= 0) return paint;
  return {
    fit: "crop",
    crop: cropFromPosition({
      box: { width: target.width, height: target.height },
      natural: { width: bytes.width, height: bytes.height },
      position,
      fit: paint.fit === "contain" ? "contain" : "cover"
    })
  };
}
