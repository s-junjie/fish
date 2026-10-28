import { Rect } from "./bounds";

/**
 * Two boxes share a row when their vertical extents overlap by more than half of
 * the SHORTER one.
 *
 * The half-of-the-shorter test is the only one that scales with the artwork. A
 * fixed pixel tolerance fails in both directions — 40px means one row for a deck
 * of 2000px boards and a thousand rows for a deck of 24px ones — and "do the tops
 * match" is worse than either, because hand-placed artboards are never aligned
 * to the pixel and a 4px difference reorders an entire deck.
 */
function sharesRow(anchor: Rect, other: Rect): boolean {
  const overlap = Math.min(anchor.y + anchor.height, other.y + other.height) - Math.max(anchor.y, other.y);
  if (overlap <= 0) return false;
  return overlap * 2 > Math.min(anchor.height, other.height);
}

/**
 * Boxes in reading order: rows top to bottom, and within a row left to right.
 *
 * This is a position, not a list. A deck of artboards is laid out on a canvas, so
 * the order a presenter means is the one a reader's eye takes across the page —
 * and it is not the order anything stores. `elements[]` is paint order, the layer
 * panel is `elements[]` reversed, and both disagree with the canvas the moment
 * anything is moved.
 *
 * Rows are found by a sweep over the boxes sorted by `y`, each row anchored on
 * its own first box. Anchoring on the growing band instead would let a chain of
 * pairwise overlaps walk a whole deck into one row: A overlapping B, B
 * overlapping C, A nowhere near C.
 */
export function readingOrder<T>(items: readonly T[], boxOf: (item: T) => Rect): T[] {
  const byTop = [...items].sort((a, b) => boxOf(a).y - boxOf(b).y || boxOf(a).x - boxOf(b).x);
  const rows: T[][] = [];
  for (const item of byTop) {
    const row = rows[rows.length - 1];
    if (row && sharesRow(boxOf(row[0]), boxOf(item))) row.push(item);
    else rows.push([item]);
  }
  return rows.flatMap((row) => [...row].sort((a, b) => boxOf(a).x - boxOf(b).x));
}
