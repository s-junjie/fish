import type { AssetRef, DesignDocument, DesignElement } from "../dsl/types";
import { isContainer } from "../geometry/tree-query";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A paint names a bitmap only on its `image` branch; every other kind passes through. */
function remapPaint(paint: unknown, from: string, to: string): unknown {
  return isRecord(paint) && paint.assetId === from ? { ...paint, assetId: to } : paint;
}

/**
 * Point a freshly built element at an asset the document already holds.
 *
 * Every field that can name one is here: `assetId` (a video's own file),
 * `posterAssetId` (an html embed's cover), `fills[].assetId` and
 * `strokes[].paint.assetId`. A missed field is not a cosmetic miss — it leaves
 * the new element pointing at an id that was never added to `doc.assets`.
 */
function remapAssetRefs(el: DesignElement, from: string, to: string): DesignElement {
  const next = { ...el } as DesignElement;
  const loose = next as unknown as Record<string, unknown>;
  if (loose.assetId === from) loose.assetId = to;
  if (loose.posterAssetId === from) loose.posterAssetId = to;
  if (Array.isArray(loose.fills)) {
    loose.fills = (loose.fills as unknown[]).map((p) => remapPaint(p, from, to));
  }
  if (Array.isArray(loose.strokes)) {
    loose.strokes = (loose.strokes as unknown[]).map((row) => {
      if (!isRecord(row)) return row;
      const paint = remapPaint(row.paint, from, to);
      return paint === row.paint ? row : { ...row, paint };
    });
  }
  if (isContainer(next) && next.children) {
    loose.children = (next.children as DesignElement[]).map((c) => remapAssetRefs(c, from, to));
  }
  return next;
}

/** A second import of the same image reuses the row instead of adding one. */
export function dedupeAssetForInsert(
  doc: DesignDocument,
  element: DesignElement,
  asset?: AssetRef
): { element: DesignElement; asset?: AssetRef } {
  if (!asset?.uri) return { element, asset };
  const existing = doc.assets?.find((a) => a.uri === asset.uri);
  if (!existing) return { element, asset };
  return { element: remapAssetRefs(element, asset.id, existing.id) };
}
