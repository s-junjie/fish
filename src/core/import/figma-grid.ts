/**
 * Figma `layoutMode: "GRID"` → the DSL's grid layout.
 *
 * A separate leaf module for the same reason `figma-paint.ts` and `figma-text.ts`
 * are: Figma's GRID is a THIRD auto-layout mode with its own cell model, its own
 * per-track sizing and its own child-placement fields, and folding it into the
 * flex branch of `figma-node.ts` is what produced the "laid out confidently and
 * wrongly" container this importer used to emit for every grid frame.
 *
 * THE FAITHFULNESS RULE, and the reason this is not "just" a field mapping. The
 * DSL's `{ fr }` track is a BARE share of the leftover, while both doors describe
 * tracks the way CSS does. Writing a ratio where the engine will resolve it
 * differently is the single largest source of `verifyImport` downgrades in this
 * importer — the measured box is the ground truth, and a ratio is only kept when
 * it REPRODUCES that measurement (`docs/LESSONS_LEARNED.md` §137, and the same
 * guard the HTML importer applies in its `trackPlan`). Everything that cannot be
 * expressed is reported through `gaps`, never guessed at.
 *
 * Field spellings are verified against BOTH official surfaces: the Figma REST
 * OpenAPI (`TypeLayoutGrid`) and the plugin API's `GridLayoutMixin` /
 * `AutoLayoutChildrenMixin`. They agree on every field read here EXCEPT
 * per-track sizing, which REST publishes only as a CSS string
 * (`gridColumnsSizing`) and the plugin publishes as structured arrays
 * (`gridColumnSizes`); both are accepted.
 */

import type { AutoLayout, LayoutCell, TrackSize } from "../dsl/types";
import { resolveTracks } from "../layout/grid-layout";
import { parseTrackList, type TrackList } from "./html-layout";
import type { FigmaGap, FigmaGridTrack, FigmaNode } from "./figma-types";

/** Horizontal / vertical alignment of a grid child within its cell. */
const CHILD_ALIGN: Record<string, NonNullable<AutoLayout["cellAlign"]>> = {
  MIN: "start",
  CENTER: "center",
  MAX: "end"
};

/**
 * How far a computed track may differ from Figma's own and still be trusted.
 *
 * 0.5px, the same tolerance the HTML importer's `trackPlan` uses and well inside
 * `verifyImport`'s 1px downgrade tolerance: a track list that lands inside it
 * cannot cause a downgrade, so accepting it is free, and one that lands outside
 * it is not worth keeping for the sake of being "dynamic".
 */
const TRACK_TOLERANCE = 0.5;

const round2 = (n: number): number => Math.round(n * 100) / 100;

const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

/**
 * The plugin's per-track sizing → the DSL's `TrackSize[]`.
 *
 * `FLEX` is the DSL's `{ fr }` and `FIXED` is its px; `HUG` sizes a track to its
 * content and has no spelling in the DSL's track model (which is px or a bare
 * share), so it forces the whole list down to measurements rather than being
 * guessed at. Returns undefined when there is nothing usable, so the caller
 * falls back to a count.
 *
 * A `FLEX` track's `value` is its WEIGHT — the plugin typings call it
 * "equivalent to the CSS `fr` unit" — so `2fr` is `{ fr: 2 }` and not `{ fr: 1 }`.
 * Reading every flex track as a share of one collapses a 1:2 column ratio into a
 * 1:1 one, which the engine then resolves to a different grid than Figma drew
 * and `verifyImport` reports as a downgrade with nothing to point at.
 */
function pluginTracks(tracks: FigmaGridTrack[] | undefined): TrackSize[] | undefined {
  if (!Array.isArray(tracks) || tracks.length === 0) return undefined;
  const out: TrackSize[] = [];
  for (const track of tracks) {
    if (!track || typeof track !== "object") return undefined;
    if (track.type === "FLEX") out.push({ fr: Math.max(0, num(track.value) ?? 1) });
    else if (track.type === "FIXED") out.push(Math.max(0, num(track.value) ?? 0));
    else return undefined; // HUG, or something new — measurements instead.
  }
  return out;
}

/**
 * Figma's authored tracks, from whichever door supplied them.
 *
 * The CSS string is parsed with the HTML importer's own reader so `repeat(N, …)`
 * and every track keyword Figma emits mean here exactly what they mean there —
 * a second parser would be a second answer to "what does `1fr 2fr 300px` mean".
 */
function declaredTracks(
  css: string | undefined,
  plugin: FigmaGridTrack[] | undefined
): { tracks?: TrackSize[]; autoFit?: { min: number } } | undefined {
  const structured = pluginTracks(plugin);
  if (structured) return { tracks: structured };
  return parseTrackList(css) as TrackList | undefined;
}

/**
 * Figma's own rendered extent for each track, read off its children — the
 * measurement the authored tracks are CHECKED against, and the fallback written
 * when they do not reproduce it.
 *
 * Children are walked in track order with the grid's own gap, so a track's
 * extent is the child that begins it. Anything that cannot be attributed that
 * way — a child spanning several tracks, one out of document order, an
 * absolutely-positioned child — makes the whole measurement `undefined` rather
 * than a guess, and the caller's authored-track path takes over. Declining is
 * always safe: a wrong track list is a container `verifyImport` downgrades, and a
 * missing one is a grid that still lays out from what Figma authored.
 */
function measuredTracks(
  children: FigmaNode[],
  count: number,
  axis: "x" | "y",
  gap: number
): number[] | undefined {
  if (children.length < count || count <= 0) return undefined;
  const boxes = children
    .map((child) => child.absoluteBoundingBox)
    .filter((b): b is NonNullable<typeof b> => Boolean(b));
  if (boxes.length !== children.length) return undefined;

  const along = (b: NonNullable<FigmaNode["absoluteBoundingBox"]>): number => (axis === "x" ? b.x : b.y);
  const across = (b: NonNullable<FigmaNode["absoluteBoundingBox"]>): number => (axis === "x" ? b.width : b.height);
  const sorted = [...boxes].sort((a, b) => along(a) - along(b));

  const sizes: number[] = [];
  let cursor = along(sorted[0]);
  for (const box of sorted) {
    // A child that does not begin exactly where the previous track ended means
    // something this walk does not model (a span, a gap, an empty track).
    if (Math.abs(along(box) - cursor) > TRACK_TOLERANCE) return undefined;
    sizes.push(across(box));
    cursor = along(box) + across(box) + gap;
  }
  return sizes.length === count ? sizes : undefined;
}

/**
 * The track list for one axis: the authored ratios where they reproduce what
 * Figma rendered, the rendered measurements where they do not, and a bare COUNT
 * where the tracks happen to be equal — which is the only case a count describes.
 *
 * This is the whole faithfulness rule in one function, and it is the same bargain
 * `trackPlan` makes in the HTML importer. `resolveTracks` is run exactly as the
 * layout pass will run it, and the result is compared to Figma's own track
 * extents. Inside the tolerance the authored tracks are kept — so the grid still
 * redistributes when a designer drags the frame wider — and outside it the
 * measurements are written instead, because a ratio the engine resolves
 * differently is a container `verifyImport` will downgrade and the designer will
 * see moved.
 *
 * THE MEASUREMENT IS NOT OPTIONAL. Figma's grid tracks size to their CONTENT by
 * default, so two 100px cards in a 300px frame are two 100px columns, not the
 * 142px each a count of 2 equal-divides to. Writing the count is the one thing
 * guaranteed to be wrong for a content-sized grid, and it is silently wrong:
 * every cell lands off by the leftover, which `verifyImport` then reports as a
 * downgrade nobody can act on. So a measurement, when there is one, is written.
 */
function planTracks(
  declared: { tracks?: TrackSize[] } | undefined,
  measured: number[] | undefined,
  content: number,
  gap: number,
  count: number
): { sizes?: TrackSize[]; count?: number } {
  const tracks = declared?.tracks;
  const usable = count > 0 && measured !== undefined && measured.length === count;

  // Nothing to check the authored tracks against. That is not evidence they are
  // wrong — it is an absence of evidence — and Figma's own `gridColumnsSizing` /
  // `gridColumnSizes` beats a bare count, which the engine would equal-divide
  // into something Figma never drew. Only a grid with NEITHER falls to a count.
  if (!usable) {
    if (tracks && tracks.length > 0) return { sizes: tracks.map((t) => (typeof t === "number" ? round2(t) : t)) };
    return count > 0 ? { count } : {};
  }

  // A count is only worth storing when the engine's even division of it already
  // matches what Figma rendered — otherwise the count is the wrong answer.
  const even = Math.abs(Math.max(0, (content - Math.max(0, count - 1) * gap) / count) - (measured[0] ?? -1));
  if (even <= TRACK_TOLERANCE) return { count };

  if (tracks && tracks.length === measured.length) {
    const resolved = resolveTracks(tracks, content, gap);
    if (resolved.every((size, i) => Math.abs(size - measured[i]) <= TRACK_TOLERANCE)) {
      return { sizes: tracks.map((t) => (typeof t === "number" ? round2(t) : t)) };
    }
  }
  return { sizes: measured.map(round2) };
}

/** A `HUG` track anywhere in a per-track list — which the DSL cannot spell. */
function hasHugTrack(tracks: FigmaGridTrack[] | undefined): boolean {
  return Array.isArray(tracks) && tracks.some((t) => t?.type === "HUG");
}

/**
 * Figma's grid → the DSL's `mode: "grid"`, or `undefined` when the frame is not
 * a grid. Anything read here the DSL cannot express is reported to `gaps`.
 */
export function mapFigmaGridLayout(node: FigmaNode, gaps?: FigmaGap[]): AutoLayout | undefined {
  if (node.layoutMode !== "GRID") return undefined;
  const report = (property: string, value?: string): void => {
    gaps?.push({ id: node.id, name: node.name || node.type, property, value });
  };

  const columnGap = num(node.gridColumnGap) ?? 0;
  const rowGap = num(node.gridRowGap) ?? 0;
  const layout: AutoLayout = {
    mode: "grid",
    padding: [node.paddingTop ?? 0, node.paddingRight ?? 0, node.paddingBottom ?? 0, node.paddingLeft ?? 0]
  };
  if (columnGap > 0) layout.columnGap = columnGap;
  if (rowGap > 0) layout.rowGap = rowGap;

  const box = node.absoluteBoundingBox;
  const contentW = box ? Math.max(0, box.width - (node.paddingLeft ?? 0) - (node.paddingRight ?? 0)) : 0;
  const contentH = box ? Math.max(0, box.height - (node.paddingTop ?? 0) - (node.paddingBottom ?? 0)) : 0;
  const children = (node.children ?? []).filter((child) => child.visible !== false);

  const declaredCols = declaredTracks(node.gridColumnsSizing, node.gridColumnSizes);
  const colCount = Math.round(num(node.gridColumnCount) ?? declaredCols?.tracks?.length ?? 0);
  const colPlan = planTracks(
    declaredCols,
    measuredTracks(children, colCount, "x", columnGap),
    contentW,
    columnGap,
    colCount
  );
  if (colPlan.sizes) layout.columnSizes = colPlan.sizes;
  else if (colPlan.count !== undefined) layout.columns = Math.max(1, colPlan.count);

  const declaredRows = declaredTracks(node.gridRowsSizing, node.gridRowSizes);
  const rowCountRaw = num(node.gridRowCount) ?? declaredRows?.tracks?.length;
  const rowCount = rowCountRaw === undefined ? undefined : Math.round(rowCountRaw);
  const rowPlan = planTracks(
    declaredRows,
    rowCount === undefined ? undefined : measuredTracks(children, rowCount, "y", rowGap),
    contentH,
    rowGap,
    rowCount ?? 0
  );
  if (rowPlan.sizes) layout.rowSizes = rowPlan.sizes;
  else if (rowPlan.count !== undefined) layout.rows = Math.max(1, rowPlan.count);

  // `cellAlign` is the DSL's ONE field for BOTH axes and its default is
  // `stretch`. Figma's grid children keep their authored (fixed) size by
  // default, so leaving `stretch` in place would stretch every child to its cell
  // and make `verifyImport` downgrade the container — `boxDelta` compares SIZE,
  // not only position. Every child's own `gridChildHorizontalAlign` /
  // `gridChildVerticalAlign` rides on the CHILD (see `mapFigmaGridChild`), and
  // the container only centres when every child asks to be centred.
  const centred =
    children.length > 0 &&
    children.every(
      (child) =>
        CHILD_ALIGN[child.gridChildHorizontalAlign ?? ""] === "center" &&
        CHILD_ALIGN[child.gridChildVerticalAlign ?? ""] === "center"
    );
  layout.cellAlign = centred ? "center" : "start";

  // The DSL's track model is px or a bare `{ fr }` share; Figma's `HUG` track,
  // which sizes to its content, has no spelling here. Name it, so a HUG grid is
  // a known gap rather than a silently stretched one.
  if (hasHugTrack(node.gridRowSizes) || hasHugTrack(node.gridColumnSizes)) {
    report("grid:track:HUG", "a HUG grid track sizes to its content, which has no DSL track spelling");
  }
  return layout;
}

/**
 * A grid child's own placement → the DSL's `layoutCell`.
 *
 * Figma's `gridColumnAnchorIndex` / `gridRowAnchorIndex` are 0-BASED; the DSL's
 * `layoutCell.column` / `.row` are 1-BASED (CSS line numbers). Index 0 is Figma's
 * "flow me" default and is left ABSENT in the DSL, which auto-places a child with
 * no cell exactly the same way — so a plain flowed grid carries no cell at all.
 */
export function mapFigmaGridChild(node: FigmaNode): { layoutCell?: LayoutCell } | undefined {
  const column = num(node.gridColumnAnchorIndex);
  const row = num(node.gridRowAnchorIndex);
  const columnSpan = num(node.gridColumnSpan);
  const rowSpan = num(node.gridRowSpan);
  if (column === undefined && row === undefined && columnSpan === undefined && rowSpan === undefined) {
    return undefined;
  }
  const cell: LayoutCell = {};
  if (column !== undefined && column > 0) cell.column = Math.round(column) + 1;
  if (row !== undefined && row > 0) cell.row = Math.round(row) + 1;
  if (columnSpan !== undefined && columnSpan > 1) cell.columnSpan = Math.max(1, Math.round(columnSpan));
  if (rowSpan !== undefined && rowSpan > 1) cell.rowSpan = Math.max(1, Math.round(rowSpan));
  return Object.keys(cell).length > 0 ? { layoutCell: cell } : undefined;
}