/**
 * The brand's cell, and the 3×3 of them that makes the mark.
 *
 * One square whose corner is 1/18 of its side — the ratio the sea's own cells use,
 * and the size the i's dot has in the wordmark. Nine of them, the middle one lit.
 *
 * This is the master. `scripts/sync-brand.mjs` copies it into the product and writes
 * the site's inline mark out of it, so nothing else in either repo holds these numbers.
 * That script reads this file as text — keep the values on the plain `key: number`
 * form below.
 */
export const MARK = {
  /** Side of one cell, in the 64-unit box. */
  cell: 10,
  /** Corner radius: 1/18 of the side. */
  rx: 0.556,
  /** Space between two cells. */
  gap: 7.5,
  /** Where the top-left cell starts, so the 3×3 sits centred in the box. */
  origin: 9.5,
  /** The box these numbers are expressed in. */
  box: 64
} as const;

const pitch = MARK.cell + MARK.gap;

/** The nine cells, in reading order, with the centre flagged. */
export const MARK_CELLS = [0, 1, 2].flatMap((row) =>
  [0, 1, 2].map((col) => ({
    x: MARK.origin + col * pitch,
    y: MARK.origin + row * pitch,
    lit: row === 1 && col === 1
  }))
);
