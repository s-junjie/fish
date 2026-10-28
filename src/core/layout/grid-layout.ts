import { AutoLayout, AutoLayoutFields, ContainerElement, DesignElement, FrameElement, LayoutCell, TextElement, TrackSize } from "../dsl/types";
import { alignSelfOf, layoutOf } from "../dsl/layout-flat";
import { MAX_GRID_TRACKS } from "../dsl/normalize/auto-layout";
import { envelopeOf, placeChildAt } from "../geometry/element-bounds";
import { axisIsPinned, resolveAxis } from "../geometry/resolve-axis";
import { measureText } from "../geometry/text-measure";
import {
  ChildSizeResolver,
  childEnvelope,
  clampAxis,
  hugsAxis,
  maxFrom,
  resolveMargin,
  resolvePadding,
  round2,
  sizeForEnvelope
} from "./box";
import { resolveTextSizing, textSpec } from "./text-sizing";

/**
 * Floor for a grid cell. A cell that measures 0 still advances by the pitch,
 * so its children land on top of each other at zero size — an invisible design
 * rather than a visibly broken one.
 */
const MIN_CELL_SIZE = 1;

/** The gap between columns, which falls back to the unified `gap`. */
const columnGapOf = (layout: AutoLayout): number => layout.columnGap ?? layout.gap ?? 0;
const rowGapOf = (layout: AutoLayout): number => layout.rowGap ?? layout.gap ?? 0;

/** Column count of a grid layout, given the content-box width it has to fit in. */
export function gridColumnCount(layout: AutoLayout, contentW: number): number {
  if (layout.columnSizes && layout.columnSizes.length > 0) {
    return Math.min(MAX_GRID_TRACKS, layout.columnSizes.length);
  }
  const colGap = columnGapOf(layout);
  if ((layout.columnsMode ?? "fixed") === "auto") {
    const min = Math.max(1, layout.columnWidthMin ?? 100);
    // `columnsMode: "auto"` derives the count from the element's own width, so
    // an uncapped width yields an uncapped column count — and the masonry pass
    // allocates an array of that size and rescans it once per child. Clamp here
    // as well as in normalize: this function is exported and the width it reads
    // is not guaranteed to have been through the normalizer.
    return Math.min(MAX_GRID_TRACKS, Math.max(1, Math.floor((contentW + colGap) / (min + colGap))));
  }
  return Math.min(MAX_GRID_TRACKS, Math.max(1, Math.round(layout.columns ?? 2)));
}

export interface GridTracks {
  /** Left edge of each column, relative to the content box. */
  offsets: number[];
  sizes: number[];
}

/** A track's px width, or undefined when it is a share of the leftover. */
export function trackPx(track: TrackSize): number | undefined {
  return typeof track === "number" ? Math.max(0, track) : undefined;
}

/** A track's share of the leftover; 0 for a fixed one. */
export function trackFr(track: TrackSize): number {
  return typeof track === "number" ? 0 : Math.max(0, track.fr);
}

/**
 * A track list resolved to px: fixed tracks keep their length, `fr` tracks split
 * whatever the fixed ones and the gaps leave behind.
 *
 * `columnSizes` wins over `columns`, and the two are not interchangeable — this
 * is the only shape that can say `280px 1fr 288px`, which is three different
 * widths and no count. What a track KEEPS is decided per track rather than per
 * list: a px track is a measurement and stays one at every frame size, and only
 * an `fr` track follows the frame, which is the whole reason the ratio is stored
 * instead of the pixels it happened to resolve to.
 */
export function resolveTracks(
  tracks: TrackSize[],
  content: number,
  gap: number
): number[] {
  const list = tracks.slice(0, MAX_GRID_TRACKS);
  const fixed = list.reduce<number>((sum, t) => sum + (trackPx(t) ?? 0), 0);
  const weights = list.reduce<number>((sum, t) => sum + trackFr(t), 0);
  const leftover = Math.max(0, content - Math.max(0, list.length - 1) * gap - fixed);
  return list.map((t) => {
    const px = trackPx(t);
    if (px !== undefined) return px;
    return weights > 0 ? (leftover * trackFr(t)) / weights : 0;
  });
}

/**
 * The column tracks: either the explicit ones or an equal division.
 */
export function gridColumnTracks(layout: AutoLayout, contentW: number): GridTracks {
  const explicit = layout.columnSizes;
  const gap = columnGapOf(layout);
  if (explicit && explicit.length > 0) {
    const sizes = resolveTracks(explicit, contentW, gap);
    const offsets: number[] = [];
    let acc = 0;
    for (const size of sizes) {
      offsets.push(acc);
      acc += size + gap;
    }
    return { offsets, sizes };
  }
  const columns = gridColumnCount(layout, contentW);
  const cellW = Math.max(MIN_CELL_SIZE, (contentW - (columns - 1) * gap) / columns);
  return {
    offsets: Array.from({ length: columns }, (_, i) => i * (cellW + gap)),
    sizes: new Array(columns).fill(cellW)
  };
}

/** The width a child spanning `span` columns from `col` occupies, gaps included. */
export function gridSpanWidth(tracks: GridTracks, col: number, span: number, gap: number): number {
  const end = Math.min(tracks.sizes.length, col + Math.max(1, span));
  let width = 0;
  for (let i = col; i < end; i++) width += tracks.sizes[i];
  return Math.max(MIN_CELL_SIZE, width + Math.max(0, end - col - 1) * gap);
}

/**
 * The height a non-hugging grid gives each row: its content box split evenly,
 * the gaps taken out first.
 *
 * Exported because the inspector MATERIALISES a row track list out of the
 * division already on screen, and a second copy of this arithmetic is a second
 * answer to the same question — one the user would then see move.
 */
export function equalGridRowHeight(layout: AutoLayout, contentH: number, rows: number): number {
  const rowGap = rowGapOf(layout);
  return Math.max(MIN_CELL_SIZE, (Math.max(0, contentH) - (rows - 1) * rowGap) / rows);
}

/** Width of one grid cell. Floored so a cramped grid never paints 0px children. */
export function gridCellWidth(layout: AutoLayout, contentW: number): number {
  const tracks = gridColumnTracks(layout, contentW);
  return Math.max(MIN_CELL_SIZE, tracks.sizes[0] ?? MIN_CELL_SIZE);
}

/**
 * Row counts of a grid layout: what it renders and what its children actually
 * fill. An explicit `rows` is a minimum, so a 3x3 authoring grid holding 4
 * items keeps its third row — that row is reserved space, not a mistake, but it
 * is also the single most misread grid setting, hence the split.
 */
export function gridRowCount(
  layout: AutoLayout,
  contentW: number,
  childCount: number,
  cells?: Array<LayoutCell | undefined>
): { rows: number; used: number } {
  const columns = gridColumnCount(layout, contentW);
  const derived = Math.min(MAX_GRID_TRACKS, Math.max(1, Math.ceil(childCount / columns)));
  // `rowSizes` is an authored row count as well: a grid whose tracks were
  // measured keeps all of them, occupied or not.
  const explicitRows = Math.max(Math.round(layout.rows ?? 0), layout.rowSizes?.length ?? 0);
  const rows = explicitRows
    ? Math.min(MAX_GRID_TRACKS, Math.max(Math.max(1, explicitRows), derived))
    : derived;

  if (cells && cells.length > 0) {
    // Exact when the caller has the children: an explicit cell can put a child
    // in a row no count would predict, and a span occupies more than one.
    let lastRow = 0;
    for (const placement of gridPlacements(layout, cells, columns)) {
      lastRow = Math.max(lastRow, placement.row + placement.rowSpan - 1);
    }
    return { rows: Math.max(rows, lastRow + 1), used: Math.min(rows, cells.length === 0 ? 0 : lastRow + 1) };
  }

  const placement = layout.placement ?? "row";
  // A loop, not `Math.max(...Array.from({length: childCount}, ...))`: the spread
  // blows the argument limit past ~125k children, and the intermediate array was
  // one entry per child regardless of how few rows the grid actually has.
  let lastRow = 0;
  for (let i = 0; i < childCount; i++) {
    const row = gridCellIndex(i, columns, rows, placement).row;
    if (row > lastRow) lastRow = row;
  }
  return { rows, used: Math.min(rows, childCount === 0 ? 0 : lastRow + 1) };
}

export function gridCellIndex(
  i: number,
  columns: number,
  rows: number,
  placement: AutoLayout["placement"]
): { col: number; row: number } {
  if (placement === "column") {
    return { row: i % rows, col: Math.floor(i / rows) };
  }
  return { col: i % columns, row: Math.floor(i / columns) };
}

export interface GridPlacement {
  col: number;
  row: number;
  colSpan: number;
  rowSpan: number;
  /** An explicit `layoutCell` decided this, so flow leaves it out of its own walk. */
  explicit: boolean;
}

/**
 * Where each child lands in the grid, explicit placements first.
 *
 * `layoutCell` is what a grid needs and a cell index cannot say: a field that
 * spans two columns, a sidebar pinned to column 1 for the whole height. The
 * children that say nothing are still FLOWED, and they flow around the occupied
 * cells — which is CSS's sparse auto-placement, and the reason this is a
 * placement pass rather than another index formula.
 *
 * The walk is bounded by rows: a child that only states a column may have to
 * look past every remaining row for the first free slot, and an unbounded scan
 * of that shape is how a layout pass hangs.
 */
export function gridPlacements(
  layout: AutoLayout,
  cells: Array<LayoutCell | undefined>,
  columns: number
): GridPlacement[] {
  const flow: NonNullable<AutoLayout["placement"]> = layout.placement ?? "row";
  const cols = Math.max(1, columns);

  let maxRowSpan = 1;
  for (const cell of cells) maxRowSpan = Math.max(maxRowSpan, Math.min(MAX_GRID_TRACKS, Math.max(1, Math.round(cell?.rowSpan ?? 1))));

  // Enough rows for every child to have a row of its own, plus room for the
  // spans: past that an auto child is being asked to fit somewhere it cannot.
  const base = Math.max(1, Math.round(layout.rows ?? 0), Math.ceil(cells.length / cols));
  const rowBound = Math.min(MAX_GRID_TRACKS, base + cells.length + maxRowSpan);
  // Column-major flow strides by a row count; `rows` if authored, otherwise the
  // rows the children need. Row-major needs no stride at all.
  const rowStride = flow === "column" ? Math.max(1, Math.round(layout.rows ?? 0), base) : 1;
  const slotAt = (i: number) =>
    flow === "column"
      ? { col: Math.floor(i / rowStride), row: i % rowStride }
      : { col: i % cols, row: Math.floor(i / cols) };

  const taken = new Set<number>();
  const key = (row: number, col: number) => row * MAX_GRID_TRACKS + col;
  const free = (col: number, row: number, colSpan: number, rowSpan: number): boolean => {
    if (col + colSpan > cols || row + rowSpan > rowBound) return false;
    for (let r = row; r < row + rowSpan; r++) {
      for (let c = col; c < col + colSpan; c++) {
        if (taken.has(key(r, c))) return false;
      }
    }
    return true;
  };

  const out: GridPlacement[] = [];
  let cursor = 0;

  for (const cell of cells) {
    const colSpan = Math.min(cols, Math.max(1, Math.round(cell?.columnSpan ?? 1)));
    const rowSpan = Math.min(MAX_GRID_TRACKS, Math.max(1, Math.round(cell?.rowSpan ?? 1)));
    const wantCol = cell?.column === undefined ? undefined : Math.max(0, Math.min(cols - colSpan, Math.round(cell.column) - 1));
    const wantRow = cell?.row === undefined ? undefined : Math.max(0, Math.round(cell.row) - 1);
    const explicit = wantCol !== undefined || wantRow !== undefined;

    let placed: GridPlacement | undefined;
    // A constrained child scans from the top because the constraint decides
    // where it may go; an unconstrained one starts where flow left off, which is
    // what keeps the walk linear.
    const start = explicit ? 0 : cursor;
    for (let i = start; i < (rowBound + 1) * (cols + 1); i++) {
      const slot = slotAt(i);
      if (slot.row >= rowBound) break;
      if (slot.col >= cols) continue;
      if (wantCol !== undefined && slot.col !== wantCol) continue;
      if (wantRow !== undefined && slot.row !== wantRow) continue;
      if (!free(slot.col, slot.row, colSpan, rowSpan)) continue;
      placed = { col: slot.col, row: slot.row, colSpan, rowSpan, explicit };
      if (!explicit) cursor = i + 1;
      break;
    }

    // Nothing fit within the bound, which only happens when explicit spans have
    // boxed the flow in; the child still gets a slot rather than disappearing.
    if (!placed) {
      const row = Math.min(rowBound - 1, out.reduce((max, p) => Math.max(max, p.row + p.rowSpan), 0));
      placed = { col: wantCol ?? 0, row: Math.max(0, row), colSpan, rowSpan, explicit };
    }

    for (let r = placed.row; r < placed.row + placed.rowSpan; r++) {
      for (let c = placed.col; c < placed.col + placed.colSpan; c++) taken.add(key(r, c));
    }
    out.push(placed);
  }

  return out;
}

export interface GridRowGeometry {
  /** Row tracks the grid has, reserved-but-empty ones included. */
  rows: number;
  /** How many of those rows something actually landed in. */
  usedRows: number;
  heights: number[];
  /** Each row's top edge from the content box, so `topOffsets[r]` + `heights[r]` is its bottom. */
  topOffsets: number[];
}

/**
 * The row track list, resolved the way `applyGridLayout` resolves it.
 *
 * Exported, and called by the pass itself, because a grid's rows are not a rule
 * anyone can restate: a hugging frame derives each row from the children that
 * landed in it, `rowSizes` resolves `fr` shares against the height there is, and
 * everything else divides evenly. A preview (or anything else) that recomputed
 * them its own way would draw rows the canvas is not using, which is worse than
 * drawing none — the reader takes the preview as the structure.
 */
export function gridRowGeometry(
  frameEl: ContainerElement,
  layout: AutoLayout,
  children: DesignElement[],
  placements: GridPlacement[],
  resolveChild?: ChildSizeResolver
): GridRowGeometry {
  const [pt, , pb] = resolvePadding(layout.padding);
  const rowGap = rowGapOf(layout);
  const reachedRows = placements.reduce((max, p) => Math.max(max, p.row + p.rowSpan), 0);
  const authoredRows = Math.max(Math.round(layout.rows ?? 0), layout.rowSizes?.length ?? 0);
  const rows = Math.min(MAX_GRID_TRACKS, Math.max(1, reachedRows, authoredRows));

  const heights: number[] = new Array(rows).fill(0);
  const sizedRows = layout.rowSizes;
  if (sizedRows && sizedRows.length >= rows) {
    // The same resolution the columns get, against the height the rows have to
    // fill: px rows are measurements and keep their length, `fr` rows share the
    // rest. This is why a `48px 1fr 26px` chrome bar comes back as three
    // different rows — and why dragging the frame taller grows the middle one.
    const resolved = resolveTracks(sizedRows, Math.max(0, frameEl.height - pt - pb), rowGap);
    for (let r = 0; r < rows; r++) heights[r] = resolved[r] ?? 0;
  } else if (hugsAxis(frameEl, "height")) {
    children.forEach((child, i) => {
      const { row, rowSpan } = placements[i];
      const m = resolveMargin(child.margin);
      // A row is as tall as the outer box that lands in it — read the same way
      // the hug width reads its width, for the same reason.
      const outer = Math.max(0, m.top + childEnvelope(child, resolveChild).height + m.bottom);
      const last = Math.max(row, Math.min(rows - 1, row + rowSpan - 1));
      if (rowSpan === 1) {
        heights[row] = Math.max(heights[row], outer);
        return;
      }
      // A spanning child cannot say which of its rows should grow, so it grows
      // the LAST one: the span as a whole has to fit it, and every row before
      // that keeps whatever the single-row children asked for.
      let have = (rowSpan - 1) * rowGap;
      for (let r = row; r <= last; r++) have += heights[r];
      if (have < outer) heights[last] += outer - have;
    });
  } else {
    const cellH = equalGridRowHeight(layout, Math.max(0, frameEl.height - pt - pb), rows);
    for (let r = 0; r < rows; r++) heights[r] = cellH;
  }

  const topOffsets: number[] = [];
  let acc = 0;
  for (let r = 0; r < rows; r++) {
    topOffsets.push(acc);
    acc += heights[r] + rowGap;
  }
  return { rows, usedRows: Math.max(0, Math.min(rows, reachedRows)), heights, topOffsets };
}

export interface GridCellRect {
  /** 0-based track indices, matching `layoutCell`'s 1-based numbering minus one. */
  column: number;
  row: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * How many cells `gridCellRects` will describe before it gives up and answers
 * none. 256 tracks per axis is the engine's own ceiling, so the worst case is
 * 65k rects — furniture nobody reads, at a DOM node each.
 */
export const MAX_GRID_CELL_RECTS = 240;

/**
 * Every cell the grid would place a child into, in the frame's LOCAL space —
 * padding included, so this is the same coordinate space the children carry.
 *
 * Read through `gridRowGeometry` rather than by restating the row rule, so the
 * preview and the layout cannot disagree about where a row starts. Masonry
 * returns none: its rows are whatever the shortest column happens to be at each
 * step, and there is no fixed grid there to preview. A grid past `limit` returns
 * none for the same reason a preview would be useless at that size — better no
 * structure claim than a wrong or unreadable one.
 */
export function gridCellRects(frameEl: ContainerElement, limit = MAX_GRID_CELL_RECTS): GridCellRect[] {
  const layout = layoutOf(frameEl as AutoLayoutFields);
  if (!layout || layout.mode !== "grid" || layout.masonry === true) return [];
  const [pt, pr, , pl] = resolvePadding(layout.padding);
  const tracks = gridColumnTracks(layout, Math.max(0, frameEl.width - pl - pr));
  const children = frameEl.children ?? [];
  const placements = gridPlacements(
    layout,
    children.map((child) => child["grid-area"]),
    tracks.sizes.length
  );
  const { heights, topOffsets } = gridRowGeometry(frameEl, layout, children, placements);
  if (tracks.sizes.length * heights.length > limit) return [];

  const cells: GridCellRect[] = [];
  for (let r = 0; r < heights.length; r++) {
    for (let c = 0; c < tracks.sizes.length; c++) {
      cells.push({
        column: c,
        row: r,
        x: pl + tracks.offsets[c],
        y: pt + topOffsets[r],
        width: tracks.sizes[c],
        height: heights[r]
      });
    }
  }
  return cells;
}

/**
 * Framer-style grid: children flow into equal-width cells in `placement`
 * order. Cell width divides the content box minus gaps; rows are either
 * explicit (`layout.rows`, a minimum) or derived from the child count. When
 * the frame hugs, row heights collapse to the tallest child per row and the
 * frame height shrinks to fit; `sizing.width: fit-content` likewise collapses
 * the width to the widest child (except with `columnsMode: "auto"`, where the
 * column count itself depends on the width).
 */
export function applyGridLayout(
  frameEl: FrameElement,
  rawChildren: DesignElement[],
  resolveChild?: ChildSizeResolver
): FrameElement {
  const layout = layoutOf(frameEl)!;
  const [pt, pr, pb, pl] = resolvePadding(layout.padding);
  const columnsMode = layout.columnsMode ?? "fixed";
  const colGap = layout.columnGap ?? layout.gap ?? 0;
  const rowGap = layout.rowGap ?? layout.gap ?? 0;
  const cellAlign = layout.cellAlign ?? "stretch";

  const hugHeight = hugsAxis(frameEl, "height");
  // A hugging width is derived from the children, which in turn need a width to
  // wrap against — with `columnsMode: "auto"` the column count is derived from
  // the width too, so there is nothing left to anchor it. Explicit columns can
  // hug; auto columns keep the authored width.
  const hugWidth = hugsAxis(frameEl, "width") && columnsMode !== "auto";

  const authoredContentW = Math.max(0, frameEl.width - pl - pr);
  // Explicit tracks are measurements, not a rule: a hugging frame must not
  // re-derive them from its children, or the grid an import reproduced would
  // rearrange itself the first time it was touched.
  const explicitTracks = Boolean(layout.columnSizes && layout.columnSizes.length > 0);
  let tracks = gridColumnTracks(layout, authoredContentW);
  const columns = tracks.sizes.length;
  const masonry = layout.masonry === true;

  // Placement comes before measurement: a child spanning two columns is
  // measured against the width of the span, not of one cell, and the row
  // heights below need to know which rows each child occupies.
  const placements = gridPlacements(layout, rawChildren.map((child) => child["grid-area"]), columns);
  const cellWidthAt = (i: number): number =>
    gridSpanWidth(tracks, placements[i].col, placements[i].colSpan, colGap);

  // Text children are measured against the cell they land in, so the row heights
  // below see a real wrapped height instead of the authored box. A hugging width
  // is being recomputed by this pass, so it cannot be the wrap limit either.
  const measured = rawChildren.map((child, i) =>
    child.type === "text" ? resolveTextSizing(child, hugWidth ? Infinity : cellWidthAt(i)) : child
  );

  if (hugWidth && !explicitTracks) {
    // Same rule as flex: the widest child decides the axis that is being
    // recomputed, and every column shares it so the grid stays regular. A
    // child's margin is part of what it occupies, so it is part of that width.
    // The width is read through `childEnvelope` because this is where the size
    // is DERIVED, not where it is written down: an extent summed from a bounded
    // child, from an instance painting wider than the box the document stores
    // for it, or from a turned one painting an envelope the document does not
    // store, has to add up the extent that child will really be given
    // (LESSON 138). Clamping at placement alone would size the frame to a child
    // that is then drawn narrower than the space it was measured against.
    const widest = measured.reduce((max, child) => {
      const m = resolveMargin(child.margin);
      const e = childEnvelope(child, resolveChild);
      return Math.max(max, e.width + m.left + m.right);
    }, MIN_CELL_SIZE);
    const offsets: number[] = [];
    let acc = 0;
    for (let i = 0; i < columns; i++) {
      offsets.push(acc);
      acc += widest + colGap;
    }
    tracks = { offsets, sizes: new Array(columns).fill(widest) };
  }

  // The cell decides a stretched child's painted width, and that decision is only
  // final once the tracks are. Measuring the wrapped height before that measured
  // the text against a box it never gets: a fixed-width label stretched to the
  // cell came out as tall as if it were still narrow, which doubled the row.
  const children = measured.map((child, i) => {
    if (child.type !== "text") return child;
    const m = resolveMargin(child.margin);
    const mode = resolveAxis(child, frameEl, "width");
    const stretched =
      mode === "fill" || (cellAlign === "stretch" && mode === "fixed" && !axisIsPinned(child, "width"));
    const paintedWidth = stretched ? Math.max(0, cellWidthAt(i) - m.left - m.right) : child.width;
    if (paintedWidth === child.width) return child;
    const height = measureText(child.content, textSpec(child.style, (child as TextElement).spans), paintedWidth).height;
    return height === child.height ? child : { ...child, height };
  });

  if (masonry) {
    return applyMasonryLayout(frameEl, children, {
      columns,
      cellW: tracks.sizes[0] ?? MIN_CELL_SIZE,
      colGap,
      rowGap,
      pt,
      pb,
      pl,
      pr,
      cellAlign,
      hugWidth
    });
  }

  // Rows are what the placements actually reach, with an authored `rows` /
  // `rowSizes` kept as a floor — a reserved empty row is a decision, not a
  // mistake. `rows` used to be derived from the child count, which is the same
  // number only while flow is the only thing placing children.
  const { rows, usedRows, heights: rowHeights, topOffsets: rowTopOffsets } = gridRowGeometry(
    frameEl,
    layout,
    children,
    placements,
    resolveChild
  );

  const laidOutChildren = children.map((child, i) => {
    const { col, row, colSpan, rowSpan } = placements[i];
    const x0 = pl + tracks.offsets[col];
    const lastRow = Math.max(row, Math.min(rows - 1, row + rowSpan - 1));
    const cellW = gridSpanWidth(tracks, col, colSpan, colGap);
    let rowH = Math.max(0, lastRow - row) * rowGap;
    for (let r = row; r <= lastRow; r++) rowH += rowHeights[r];
    const y0 = pt + rowTopOffsets[row];

    // `stretch` means "fill the cell", and it fills what the child left unsaid —
    // an ABSENT axis is `auto` in the CSS sense, which is exactly what a cell
    // decides. `fill` is the declaration whose meaning here IS the cell, so it
    // stretches regardless of `cellAlign`; `fit-content` / `max-content` keep
    // their own answer; and `"fixed"` is the one that says "my number is the
    // size", so a child that wrote it down keeps it whatever the cell aligns to.
    // That is what lets a resize survive: the pass used to write the cell back
    // over the number, which left `fixed` unselectable and undraggable.
    //
    // A child may also state its own cell alignment, which replaces the
    // container's for that child alone — the same override the flex pass reads.
    const align = alignSelfOf(child) ?? cellAlign;
    const m = resolveMargin(child.margin);
    // The cell minus the child's own margins is what it is actually placed in,
    // so a stretched child fills that and an aligned one centres within it.
    const innerW = Math.max(0, cellW - m.left - m.right);
    const innerH = Math.max(0, rowH - m.top - m.bottom);
    const childWidthMode = resolveAxis(child, frameEl, "width");
    const childHeightMode = resolveAxis(child, frameEl, "height");
    const stretchW =
      childWidthMode === "fill" || (align === "stretch" && childWidthMode === "fixed" && !axisIsPinned(child, "width"));
    const stretchH =
      childHeightMode === "fill" || (align === "stretch" && childHeightMode === "fixed" && !axisIsPinned(child, "height"));
    // A stretched child fills the cell with its ENVELOPE, so the size it is
    // given is that solved — at an unturned child the plain subtraction it was.
    const baseW = clampAxis(child, "width", child.width);
    const baseH = clampAxis(child, "height", child.height);
    const w = stretchW
      ? clampAxis(child, "width", sizeForEnvelope(child, innerW, baseH, baseW))
      : baseW;
    const h = stretchH
      ? clampAxis(child, "height", sizeForEnvelope(child, innerH, w, baseH))
      : baseH;
    const env = envelopeOf(child, w, h);
    // Alignment spaces the ENVELOPE inside the cell, because the envelope is what
    // the cell has to hold.
    let x = x0 + m.left;
    let y = y0 + m.top;
    if (align === "center") {
      x = x0 + m.left + (innerW - env.width) / 2;
      y = y0 + m.top + (innerH - env.height) / 2;
    } else if (align === "end") {
      x = x0 + m.left + innerW - env.width;
      y = y0 + m.top + innerH - env.height;
    }
    // ...and the slot above is where the ENVELOPE goes, so the anchor the document
    // stores is pushed back to it.
    return placeChildAt(child, x - env.left, y - env.top, Math.max(0, w), Math.max(0, h));
  });

  let finalWidth = frameEl.width;
  let finalHeight = frameEl.height;
  if (hugWidth) {
    const spanned = Math.max(0, columns - 1) * colGap;
    finalWidth = round2(
      clampAxis(frameEl, "width", tracks.sizes.reduce((total, size) => total + size, 0) + spanned + pl + pr)
    );
  }
  if (hugHeight) {
    // Only rows something landed in count: an unoccupied row has no height of
    // its own and must not add a row gap either.
    finalHeight = round2(
      clampAxis(
        frameEl,
        "height",
        rowHeights.slice(0, usedRows).reduce((a, h) => a + h, 0) +
          Math.max(0, usedRows - 1) * rowGap +
          pt +
          pb
      )
    );
  }

  return {
    ...frameEl,
    width: finalWidth,
    height: finalHeight,
    children: laidOutChildren
  };
}

/**
 * Masonry: each child keeps its own height and lands in the currently
 * shortest column. Frame hug height equals the tallest column.
 */
function applyMasonryLayout(
  frameEl: FrameElement,
  children: DesignElement[],
  opts: {
    columns: number;
    cellW: number;
    colGap: number;
    rowGap: number;
    pt: number;
    pb: number;
    pl: number;
    pr: number;
    cellAlign: AutoLayout["cellAlign"];
    hugWidth: boolean;
  }
): FrameElement {
  const { columns, cellW, colGap, rowGap, pt, pb, pl, pr, cellAlign, hugWidth } = opts;
  const columnBottoms = new Array(columns).fill(0);

  const laidOutChildren = children.map((child) => {
    let col = 0;
    for (let c = 1; c < columns; c++) {
      if (columnBottoms[c] < columnBottoms[col] - 1e-6) col = c;
    }
    const align = alignSelfOf(child) ?? cellAlign;
    const m = resolveMargin(child.margin);
    const innerW = Math.max(0, cellW - m.left - m.right);
    const stretchW =
      resolveAxis(child, frameEl, "width") === "fill" ||
      (align === "stretch" && resolveAxis(child, frameEl, "width") === "fixed" && !axisIsPinned(child, "width"));
    const baseW = clampAxis(child, "width", child.width);
    const baseH = clampAxis(child, "height", child.height);
    const w = stretchW
      ? clampAxis(child, "width", sizeForEnvelope(child, innerW, baseH, baseW))
      : baseW;
    const env = envelopeOf(child, w, baseH);
    let x = pl + col * (cellW + colGap) + m.left;
    if (align === "center") x += (innerW - env.width) / 2;
    else if (align === "end") x += innerW - env.width;
    // A masonry column stacks OUTER boxes: the margin and the envelope a turned
    // child paints are both what the next item clears.
    const y = pt + columnBottoms[col] + m.top;
    columnBottoms[col] += m.top + env.height + m.bottom + rowGap;

    return placeChildAt(child, x - env.left, y - env.top, Math.max(0, w), Math.max(0, baseH));
  });

  const tallest = maxFrom(columnBottoms, 0) - rowGap;
  const finalHeight = hugsAxis(frameEl, "height")
    ? round2(clampAxis(frameEl, "height", Math.max(0, tallest) + pt + pb))
    : frameEl.height;
  const finalWidth = hugWidth
    ? round2(clampAxis(frameEl, "width", columns * cellW + Math.max(0, columns - 1) * colGap + pl + pr))
    : frameEl.width;

  return { ...frameEl, width: finalWidth, height: finalHeight, children: laidOutChildren };
}
