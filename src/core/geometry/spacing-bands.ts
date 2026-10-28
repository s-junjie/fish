import { AutoLayout, DesignElement, FrameElement } from "../dsl/types";
import { layoutOf } from "../dsl/layout-flat";
import { elementAABB } from "./element-bounds";
import { transformBoundsToAABB, Rect } from "./bounds";
import type { Matrix2D } from "./matrix";
import { detectSmartSelection, groupFlexLines } from "./smart-selection";
import { resolvePadding } from "../layout/box";
import { inFlowChildren } from "../layout/auto-layout";
import { gridColumnTracks, gridPlacements } from "../layout/grid-layout";

/**
 * The bands the canvas draws while a spacing value is being scrubbed in the
 * inspector — padding, margin, gap.
 *
 * This is geometry only: it answers "which rectangles, and how big", and the
 * overlay answers "how do they look". Everything here is reported in CANVAS
 * space, because that is the space the overlay draws in and nothing else — a
 * child positioned inside an auto-layout frame carries a parent-local `x`, and
 * reading it raw put the whole readout at the frame's origin. `originOf` is
 * the same injection `detectSmartSelection` takes, for the same reason.
 */

export type SpacingKind = "padding" | "margin" | "gap";

/** The canvas origin an element's own `x` / `y` are relative to. */
export type OriginOf = (el: DesignElement) => { x: number; y: number };

/**
 * The same answer as a matrix, for the element's whole box.
 *
 * Optional on purpose: a caller with no document to hand keeps working exactly as
 * before, and a caller that does pass one gets boxes that land where the element
 * paints rather than where a sum of offsets says — which differ the moment any
 * ancestor is turned.
 */
export type MatrixOf = (el: DesignElement) => Matrix2D;

/** `[top, right, bottom, left]` — the shape `padding` and `margin` share. */
export type Quad = [number, number, number, number];

/**
 * Which sides ONE field writes, as indices into {@link Quad}.
 *
 * A `PadMode` of "1" writes all four, "2" writes a vertical or horizontal pair,
 * "4" writes one. Only the sides under the pointer are drawn: showing all four
 * while the user scrubs `T` would be four bands, three of which are telling them
 * nothing about the thing they are holding.
 */
export type SideSet = number[];

export interface SpacingScrub {
  /** The element whose spacing is being scrubbed — the frame for padding/gap, the child for margin. */
  elementId: string;
  kind: SpacingKind;
  /** Ignored for `gap`, which is one number between siblings rather than four around a box. */
  sides: SideSet;
  /** gap only: the axis the field pushes children along. */
  axis?: "x" | "y";
}

export interface SpacingBand {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Where the readout pill sits, in canvas space. */
  cx: number;
  cy: number;
  /** The number the field is showing, already rounded the way the inspector shows it. */
  label: string;
  /** `margin` = the margin band's own accent, outlined and dashed; `coral` = a filled wash. */
  tone: "coral" | "margin";
}

const EPS = 0.01;

function band(rect: Rect, value: number, tone: SpacingBand["tone"]): SpacingBand {
  return {
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
    cx: rect.x + rect.width / 2,
    cy: rect.y + rect.height / 2,
    label: String(Math.round(value * 100) / 100),
    tone
  };
}

const union = (a: Rect, b: Rect): Rect => {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y
  };
};

/**
 * Padding: the band between the frame's own edge and its content box.
 *
 * `sides` picks which of the four to draw. A side the user is not holding is
 * omitted entirely; a side they ARE holding is drawn even at 0, because the
 * overlay component floors it to a hairline — a band that vanishes at zero is a
 * scrub with no readout at the value most people set it to.
 */
export function paddingBands(box: Rect, pad: Quad, sides: SideSet): SpacingBand[] {
  const [pt, pr, pb, pl] = pad;
  const inner = {
    x: box.x + pl,
    y: box.y + pt,
    width: Math.max(0, box.width - pl - pr),
    height: Math.max(0, box.height - pt - pb)
  };
  const out: SpacingBand[] = [];
  if (sides.includes(0)) out.push(band({ x: box.x, y: box.y, width: box.width, height: pt }, pt, "coral"));
  if (sides.includes(1)) out.push(band({ x: inner.x + inner.width, y: inner.y, width: pr, height: inner.height }, pr, "coral"));
  if (sides.includes(2)) out.push(band({ x: inner.x, y: inner.y + inner.height, width: inner.width, height: pb }, pb, "coral"));
  if (sides.includes(3)) out.push(band({ x: box.x, y: inner.y, width: pl, height: inner.height }, pl, "coral"));
  return out;
}

/**
 * Margin: the band immediately OUTSIDE the child's own box.
 *
 * The layout pass has already placed the child after its margin, so the space
 * the margin owns is the strip between the child's edge and whatever the parent
 * put there — nothing has to be derived, it is read off the child's position.
 *
 * A NEGATIVE margin pulls the child back over its neighbour, so `y - mt` lands
 * inside the child instead of above it. That is deliberate: it draws the overlap
 * the value actually causes, and the label keeps its sign, because a band drawn
 * in the wrong direction with the right number would be worse than either.
 */
export function marginBands(box: Rect, m: Quad, sides: SideSet): SpacingBand[] {
  const out: SpacingBand[] = [];
  if (sides.includes(0)) out.push(band({ x: box.x, y: box.y - m[0], width: box.width, height: Math.abs(m[0]) }, m[0], "margin"));
  if (sides.includes(1)) out.push(band({ x: box.x + box.width, y: box.y, width: Math.abs(m[1]), height: box.height }, m[1], "margin"));
  if (sides.includes(2)) out.push(band({ x: box.x, y: box.y + box.height, width: box.width, height: Math.abs(m[2]) }, m[2], "margin"));
  if (sides.includes(3)) out.push(band({ x: box.x - m[3], y: box.y, width: Math.abs(m[3]), height: box.height }, m[3], "margin"));
  return out;
}

/** The box as the child PAINTS it, in canvas space. */
function worldBoxOf(child: DesignElement, originOf: OriginOf, matrixOf?: MatrixOf): Rect {
  const box = elementAABB(child);
  return matrixOf?.(child) != null
    ? transformBoundsToAABB(box, matrixOf(child))!
    : { x: box.x + originOf(child).x, y: box.y + originOf(child).y, width: box.width, height: box.height };
}

/**
 * The gap bands of a FLEX frame.
 *
 * One line of children is what the canvas's gap pills already measure, so an
 * unwrapped stack keeps reading off that detector — the same rectangles, whether
 * the gesture started in the field or on the pill. The label is the field's own
 * value, because the detector measures the empty space between two children,
 * which is the gap plus any margin the child carries.
 *
 * A WRAPPED stack is several lines, and the detector sorts the whole child list
 * along the main axis — so it pairs a child in line 1 with a child in line 2 and
 * reports a seam that does not exist. Lines are therefore measured here: bands
 * within a line for the main axis, bands between lines for the cross axis, the
 * same way a grid measures its tracks.
 */
function flexGapBands(
  frame: FrameElement,
  axis: "x" | "y",
  gap: number,
  originOf: OriginOf,
  matrixOf?: MatrixOf
): SpacingBand[] {
  const layout = layoutOf(frame)!;
  if (layout.wrap !== "wrap") {
    const info = detectSmartSelection([frame], { originOf, matrixOf });
    if (!info) return [];
    return info.handles.filter((h) => h.axis === axis).map((h) => band(h.box, gap, "coral"));
  }

  const flow = inFlowChildren(frame.children ?? []);
  if (flow.length < 2) return [];
  const boxes = flow.map((child) => worldBoxOf(child, originOf, matrixOf));
  const main = layout.direction === "column" ? "y" : "x";
  const mainStart = (b: Rect) => (main === "x" ? b.x : b.y);
  const mainEnd = (b: Rect) => (main === "x" ? b.x + b.width : b.y + b.height);
  const crossStart = (b: Rect) => (main === "x" ? b.y : b.x);
  const crossEnd = (b: Rect) => (main === "x" ? b.y + b.height : b.x + b.width);

  // A line is a run of children whose cross extents overlap, in either direction:
  // `align-items: center` leaves a short child's edge inside its line, so the
  const lines = groupFlexLines(boxes, main);

  const out: SpacingBand[] = [];
  /** A band between two boxes along the scrubbed axis, spanning their union on the other. */
  const between = (a: Rect, b: Rect, along: "main" | "cross") => {
    const m0 = along === "main" ? mainEnd(a) : Math.min(mainStart(a), mainStart(b));
    const m1 = along === "main" ? mainStart(b) : Math.max(mainEnd(a), mainEnd(b));
    const c0 = along === "main" ? Math.min(crossStart(a), crossStart(b)) : crossEnd(a);
    const c1 = along === "main" ? Math.max(crossEnd(a), crossEnd(b)) : crossStart(b);
    const thickness = along === "main" ? m1 - m0 : c1 - c0;
    if (thickness < -EPS) return;
    const rect: Rect =
      main === "x"
        ? { x: m0, y: c0, width: Math.max(0, m1 - m0), height: c1 - c0 }
        : { x: c0, y: m0, width: c1 - c0, height: Math.max(0, m1 - m0) };
    out.push(band(rect, gap, "coral"));
  };

  if (axis === main) {
    for (const line of lines) {
      const sorted = [...line].sort((a, b) => mainStart(a) - mainStart(b));
      for (let i = 0; i < sorted.length - 1; i++) between(sorted[i], sorted[i + 1], "main");
    }
    return out;
  }

  const extent = (line: Rect[]) => line.reduce((acc, b) => union(acc, b), line[0]);
  for (let i = 0; i < lines.length - 1; i++) between(extent(lines[i]), extent(lines[i + 1]), "cross");
  return out;
}

/**
 * The gap bands of a GRID frame.
 *
 * `detectSmartSelection` only knows a flex frame (it was written for the pill
 * drag), so the grid's two axes are derived from the placements the layout pass
 * already computed: the band sits between the last cell of track N and the first
 * cell of track N+1, and spans the union of both tracks so it reads as a seam
 * across the whole grid rather than a sliver between two boxes.
 *
 * Edges are read from span-1 children only. A child that covers two tracks has
 * no edge inside the gap by definition, and letting it set the boundary produced
 * a band with a negative width — so a track whose cells all span is simply not
 * reported, rather than reported wrong.
 */
function gridGapBands(
  frame: FrameElement,
  axis: "x" | "y",
  gap: number,
  originOf: OriginOf,
  matrixOf?: MatrixOf
): SpacingBand[] {
  const layout = layoutOf(frame)!;
  const flow = inFlowChildren(frame.children ?? []);
  if (flow.length < 2) return [];
  const [, pr, , pl] = resolvePadding(layout.padding);
  const contentW = Math.max(0, frame.width - pl - pr);
  const columns = gridColumnTracks(layout, contentW).sizes.length;
  const placements = gridPlacements(layout, flow.map((c) => c["grid-area"]), columns);

  const cells = flow.map((child, i) => {
    const world = worldBoxOf(child, originOf, matrixOf);
    return {
      span: axis === "x" ? placements[i].colSpan : placements[i].rowSpan,
      index: axis === "x" ? placements[i].col : placements[i].row,
      start: axis === "x" ? world.x : world.y,
      end: axis === "x" ? world.x + world.width : world.y + world.height,
      box: world
    };
  });

  const byTrack = new Map<number, typeof cells>();
  for (const cell of cells) {
    const list = byTrack.get(cell.index) ?? [];
    list.push(cell);
    byTrack.set(cell.index, list);
  }

  const edgeOf = (list: typeof cells, side: "start" | "end") => {
    const span1 = list.filter((c) => c.span === 1);
    if (span1.length === 0) return null;
    return side === "start"
      ? Math.min(...span1.map((c) => c.start))
      : Math.max(...span1.map((c) => c.end));
  };

  const out: SpacingBand[] = [];
  for (const index of [...byTrack.keys()].sort((a, b) => a - b)) {
    const here = byTrack.get(index)!;
    const next = byTrack.get(index + 1);
    if (!next) continue;
    const a = edgeOf(here, "end");
    const b = edgeOf(next, "start");
    if (a === null || b === null || b - a < -EPS) continue;
    const cross = here.concat(next).reduce((acc, c) => union(acc, c.box), here[0].box);
    const rect: Rect = axis === "x"
      ? { x: a, y: cross.y, width: b - a, height: cross.height }
      : { x: cross.x, y: a, width: cross.width, height: b - a };
    out.push(band(rect, gap, "coral"));
  }
  return out;
}

/**
 * Every band for one scrub, in canvas space. The single entry point the overlay
 * calls; each branch is a pure function over the element and the descriptor.
 */
export function spacingBands(
  scrub: SpacingScrub,
  el: DesignElement,
  originOf: OriginOf,
  matrixOf?: MatrixOf
): SpacingBand[] {
  const local = elementAABB(el);
  // The element's box where it PAINTS. A translation alone cannot place a box
  // inside a TURNED ancestor — the renderer draws the element there, not where
  // its `x`/`y` summed with an offset says — so the matrix answers this whenever
  // the caller has one.
  const box: Rect =
    matrixOf?.(el) != null
      ? transformBoundsToAABB(local, matrixOf(el))!
      : { x: local.x + originOf(el).x, y: local.y + originOf(el).y, width: local.width, height: local.height };

  if (scrub.kind === "margin") {
    return marginBands(box, resolveQuad(el.margin), scrub.sides);
  }

  if (el.type !== "frame" || !layoutOf(el)) return [];
  if (scrub.kind === "padding") {
    return paddingBands(box, resolveQuad(layoutOf(el)!.padding), scrub.sides);
  }

  const layout = layoutOf(el)!;
  if (layout.mode === "grid") {
    const axis = scrub.axis ?? "x";
    return gridGapBands(el, axis, gapOf(layout, axis), originOf, matrixOf);
  }
  // A flex frame has one gap along the main axis and, once it wraps, a second
  // between lines — the same two numbers the inspector's two fields hold.
  const isRow = layout.direction !== "column";
  const axis = scrub.axis ?? (isRow ? "x" : "y");
  return flexGapBands(el, axis, gapOf(layout, axis), originOf, matrixOf);
}

/** The gap the field for `axis` holds: its own override first, the uniform `gap` after. */
function gapOf(layout: AutoLayout, axis: "x" | "y"): number {
  return (axis === "x" ? layout.columnGap : layout.rowGap) ?? layout.gap ?? 0;
}

function resolveQuad(raw: unknown): Quad {
  if (Array.isArray(raw) && raw.length === 4) return [raw[0] ?? 0, raw[1] ?? 0, raw[2] ?? 0, raw[3] ?? 0];
  const v = typeof raw === "number" ? raw : 0;
  return [v, v, v, v];
}