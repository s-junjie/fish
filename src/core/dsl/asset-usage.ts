import { getActivePage } from "./types";
import type { DesignDocument, DesignElement, Page } from "./types";

/** A document's element trees, whichever shape it arrived in. */
export function pageRoots(doc: DesignDocument): DesignElement[] {
  return doc.pages?.length
    ? doc.pages.flatMap((page) => page.children ?? [])
    : getActivePage(doc).children ?? [];
}

/**
 * The counting walk, over any subtree that names assets.
 *
 * `doc.styles[]` is part of the document, not decoration: a `PaintStyle.paints`
 * or a `StrokeStyle.strokes[].paint` is the same image paint an element holds, so
 * a layer bound to that style names the asset nowhere in the tree. Missing it
 * deleted the bytes under a live style — the one outcome this scan exists to
 * prevent. (There is no `doc.components` to scan: masters are `type:"component"`
 * nodes inside `pages[]`, and `normalize` drops any other top-level key.)
 */
function countInto(root: unknown, counts: Map<string, number>, seen: WeakSet<object>): void {
  const note = (id: string) => counts.set(id, (counts.get(id) ?? 0) + 1);
  const visit = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    if (seen.has(value as object)) return;
    seen.add(value as object);
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if ((key === "assetId" || key === "posterAssetId") && typeof child === "string") note(child);
      else visit(child);
    }
    // An instance override names the asset as `{ property: "assetId", value }` —
    // the id is in `value`, and the key that would have found it is the property.
    const property = (value as { property?: unknown }).property;
    const overridden = (value as { value?: unknown }).value;
    if ((property === "assetId" || property === "posterAssetId") && typeof overridden === "string") {
      note(overridden);
    }
  };
  visit(root);
}

/**
 * Per-page counts, cached on the page object.
 *
 * The scan is a full walk of a page's tree — 1,841 elements on the measured file
 * — and `doc` is replaced on every commit while its pages are not. Editing an
 * empty page therefore re-walked the page beside it on every frame, and returned
 * a new Map each time, which broke the layer panel's memo by identity.
 */
const pageCountCache = new WeakMap<Page, Map<string, number>>();

function pageCounts(page: Page): Map<string, number> {
  const hit = pageCountCache.get(page);
  if (hit) return hit;
  const counts = new Map<string, number>();
  const seen = new WeakSet<object>();
  countInto(page.children, counts, seen);
  countInto(page.canvas, counts, seen);
  pageCountCache.set(page, counts);
  return counts;
}

/**
 * How many places point at each asset, at any depth.
 *
 * Deliberately a scan of the whole document rather than a list of the places an
 * image paint can live: an override, a video poster, a page background and a
 * paint this build has not heard of all name an asset the same way, and
 * over-counting a reference only means an asset is kept.
 */
export function assetUsageCounts(doc: DesignDocument): Map<string, number> {
  const counts = new Map<string, number>();
  const pages = doc.pages ?? [];
  if (pages.length > 0) {
    for (const page of pages) {
      for (const [id, n] of pageCounts(page)) counts.set(id, (counts.get(id) ?? 0) + n);
    }
  } else {
    // A document normalizes to at least one page, but a hand-built one need not.
    countInto(getActivePage(doc).children, counts, new WeakSet<object>());
  }
  // A background is a paint like any other and sits outside every element tree.
  const seen = new WeakSet<object>();
  countInto(doc.canvas, counts, seen);
  countInto(doc.styles, counts, seen);
  return reuseCountsIfEqual(counts);
}

/**
 * Hand back the previous Map when every count still matches.
 *
 * Consumers compare `assetUsage` by identity, and it is one of the fields
 * `layerPanelPropsEqual` checks before it ever gets to the tree — a fresh Map
 * per commit makes the panel re-render on a keystroke that moved nothing.
 */
let lastCounts: Map<string, number> | null = null;

function reuseCountsIfEqual(next: Map<string, number>): Map<string, number> {
  const prev = lastCounts;
  if (prev && prev.size === next.size) {
    let same = true;
    for (const [id, n] of next) {
      if (prev.get(id) !== n) {
        same = false;
        break;
      }
    }
    if (same) return prev;
  }
  lastCounts = next;
  return next;
}

/** Every asset id the document still points at, at any depth. */
export function referencedAssetIds(doc: DesignDocument): Set<string> {
  return new Set(assetUsageCounts(doc).keys());
}

/** The document's own assets that nothing in it points at any more. */
export function unusedAssetIds(doc: DesignDocument): string[] {
  const counts = assetUsageCounts(doc);
  return (doc.assets ?? []).map((asset) => asset.id).filter((id) => !counts.has(id));
}
