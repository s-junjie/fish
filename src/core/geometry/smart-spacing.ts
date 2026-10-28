import { DesignElement } from "../dsl/types";
import { Rect } from "./bounds";
import type { SmartGapHandle, SmartSelectionInfo } from "./smart-selection";

/**
 * How far apart two positions may measure and still count as the same.
 *
 * A gap is measured between rounded integer positions and then rounded itself, so
 * a row authored at a 17px gap and one authored at 18px are the same row as far as
 * anyone reading the canvas is concerned. Without a pixel of slack the pills would
 * disappear every time a tidy-up landed on a fraction, and the button that brings
 * them back would be the only thing on offer.
 */
export const EVEN_SPACING_TOLERANCE = 1;

/**
 * Whether one axis's gaps all measure the same.
 *
 * A single gap is trivially even: two elements have nothing to distribute, so the
 * pill that separates them is already the honest answer.
 */
export function gapsMatch(handles: SmartGapHandle[], axis: "x" | "y"): boolean {
  const gaps = handles.filter((h) => h.axis === axis).map((h) => h.gap);
  if (gaps.length <= 1) return true;
  return Math.max(...gaps) - Math.min(...gaps) <= EVEN_SPACING_TOLERANCE;
}

/**
 * Whether a grid's cells line up along one axis, and so which direction is ragged.
 *
 * Averaging is what the gutter HANDLES do — one pill per gutter, wherever it lands
 * — and an average hides the raggedness it was computed from: two rows whose second
 * column sits 20px apart average to a gap that exists nowhere on the canvas. A
 * column shares one x, a row shares one y; that is what makes "the gap" a number
 * at all, and it is what the gap gesture's `delta × index` assumes.
 */
export function gridAxesEven(
  matrix: (DesignElement | null)[][],
  boxOf: (el: DesignElement) => Rect
): { x: boolean; y: boolean } {
  const boxes = new Map<string, Rect>();
  const box = (el: DesignElement): Rect => {
    let r = boxes.get(el.id);
    if (!r) boxes.set(el.id, (r = boxOf(el)));
    return r;
  };
  const present = (line: (DesignElement | null)[]) => line.filter((el): el is DesignElement => !!el);
  const aligned = (values: number[]) =>
    values.length <= 1 ||
    Math.max(...values) - Math.min(...values) <= EVEN_SPACING_TOLERANCE;

  const columns = Array.from({ length: matrix[0]?.length ?? 0 }, (_, c) =>
    present(matrix.map((row) => row[c]))
  );
  return {
    x: columns.every((line) => aligned(present(line).map((el) => box(el).x))),
    y: matrix.every((row) => aligned(present(row).map((el) => box(el).y)))
  };
}

/**
 * Where each selected element has to move for one axis to become even — the
 * arithmetic behind the canvas's tidy-up button.
 *
 * The gap pills are the reason this exists. Scrubbing one shifts every element
 * after the anchor by `delta × index`, which is only "the spacing" when the axis
 * already agrees: on a row whose gaps are 20 and 60, the same drag produces 24 and
 * 72 and means nothing. So the pill is offered only once the gaps are even, and the
 * row gets there through here.
 *
 * `axis` is required for a grid, where each direction is its own button; a 1D
 * selection has only one direction and ignores it. Returns `null` for a selection
 * there is nothing to do: an auto-layout frame, whose gap is one number already.
 */
export function tidySpacing(
  info: SmartSelectionInfo,
  /** The element's box as PAINTED, in canvas space — the space `info` reports in. */
  boxOf: (el: DesignElement) => Rect,
  axis?: "x" | "y"
): Map<string, { dx: number; dy: number }> | null {
  if (info.parentFrame) return null;

  const deltas = new Map<string, { dx: number; dy: number }>();

  if (info.axis === "grid" && info.grid) {
    const wanted = axis ? [axis] : (["x", "y"] as const);
    for (const a of wanted) if (!alignGrid(info.grid.matrix, a, boxOf, deltas)) return null;
    return deltas.size > 0 ? deltas : null;
  }

  if (!spread(info.sortedElements, info.axis === "y" ? "y" : "x", boxOf, deltas)) return null;
  return deltas;
}

/**
 * Equalise the gaps along one axis of a 1D row or column, in place in `deltas`,
 * and report whether there was anything to distribute.
 *
 * The head is pinned and the gaps are the MEAN of the ones already there, which
 * is what keeps the trailing edge where it was: the box total and the gap total
 * are both preserved, so the span cannot change. Only the layout axis moves —
 * tidying a row must not straighten it.
 *
 * The cursor accumulates in fractions and only each delta is rounded, so three
 * boxes at a 100.5px mean gap do not drift a pixel per step — which is the whole
 * reason a tidy-up has to be able to land on even again.
 */
function spread(
  ordered: DesignElement[],
  axis: "x" | "y",
  boxOf: (el: DesignElement) => Rect,
  deltas: Map<string, { dx: number; dy: number }>
): boolean {
  if (ordered.length < 3) return false;
  const boxes = ordered.map(boxOf);
  const lead = (b: Rect) => (axis === "x" ? b.x : b.y);
  const size = (b: Rect) => (axis === "x" ? b.width : b.height);
  const gap = (a: Rect, b: Rect) => lead(b) - (lead(a) + size(a));

  let totalGap = 0;
  for (let i = 0; i < boxes.length - 1; i++) totalGap += gap(boxes[i], boxes[i + 1]);
  const meanGap = totalGap / (boxes.length - 1);

  let cursor = lead(boxes[0]);
  for (let i = 1; i < boxes.length; i++) {
    cursor += size(boxes[i - 1]) + meanGap;
    const shift = Math.round(cursor - lead(boxes[i]));
    add(deltas, ordered[i].id, axis, shift);
  }
  return true;
}

/**
 * Bring a grid's columns (or its rows) onto one line.
 *
 * Spreading gaps would be the wrong primitive here: a grid cell's gap depends on
 * every other cell's height, so equalising the seams one row at a time is not a
 * thing that can be done pairwise. Alignment is what the gutter pills actually
 * assume — one column, one x — and once the cells share a line the seams in a row
 * are equal by construction. It also has no minimum size, where a two-column grid
 * has nothing to spread but plenty to align.
 */
function alignGrid(
  matrix: (DesignElement | null)[][],
  axis: "x" | "y",
  boxOf: (el: DesignElement) => Rect,
  deltas: Map<string, { dx: number; dy: number }>
): boolean {
  const lines =
    axis === "x"
      ? Array.from({ length: matrix[0]?.length ?? 0 }, (_, c) => matrix.map((row) => row[c]))
      : matrix;

  let moved = false;
  for (const line of lines) {
    const cells = line.filter((el): el is DesignElement => !!el);
    if (cells.length < 2) continue;
    const lead = (el: DesignElement) => {
      const b = boxOf(el);
      return axis === "x" ? b.x : b.y;
    };
    const anchor = lead(cells[0]);
    for (const el of cells.slice(1)) {
      const shift = Math.round(anchor - lead(el));
      if (shift === 0) continue;
      add(deltas, el.id, axis, shift);
      moved = true;
    }
  }
  return moved;
}

/**
 * Accumulate a shift on one axis.
 *
 * Absent means "pinned", so a pinned head writes nothing: the two directions of a
 * grid are two passes over one map, and a row head that had already been shifted
 * along the row would lose that shift to a `{dx: 0}` written here.
 */
function add(
  deltas: Map<string, { dx: number; dy: number }>,
  id: string,
  axis: "x" | "y",
  shift: number
) {
  const prev = deltas.get(id) ?? { dx: 0, dy: 0 };
  deltas.set(id, axis === "x" ? { dx: prev.dx + shift, dy: prev.dy } : { dx: prev.dx, dy: prev.dy + shift });
}