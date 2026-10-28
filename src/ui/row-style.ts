/**
 * The row: one horizontal band of controls that share a baseline.
 *
 * These five flex spells were written inline about seventy times across the
 * inspector, the panels and the toolbars — `flex items-center gap-2` alone 33
 * times. Terser mangles a reference to a module constant down to a one- or
 * two-character identifier, so every inline spelling was the same bytes paid
 * for again; naming them here is also what makes a spacing change a one-line
 * edit instead of a seventy-file one.
 *
 * The two SPREAD spellings differ by `gap-2` and nothing else, and the
 * difference is load-bearing: the inspector section headers want the gap, the
 * panel headers do not. They stay two constants rather than one with an
 * argument, because a caller that has to think about which spread it wants is
 * a caller that will pick wrong.
 */

/** The default row: `gap-2`. */
export const ROW_CLASS = "flex items-center gap-2";

/** A row of icon-sized controls: `gap-1.5`. */
export const ROW_TIGHT_CLASS = "flex items-center gap-1.5";

/** The densest row — icon buttons in toolbars and field rows: `gap-1`. */
export const ROW_DENSE_CLASS = "flex items-center gap-1";

/** A header row spread to both edges, no gap: panel headers. */
export const ROW_SPREAD_CLASS = "flex items-center justify-between";

/** A header row spread to both edges with `gap-2`: inspector section headers. */
export const ROW_SPREAD_GAP_CLASS = "flex items-center justify-between gap-2";
