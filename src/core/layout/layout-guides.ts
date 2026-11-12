import type { DesignElement, LayoutGuide, LayoutGuideKind, PatternPaint } from "../dsl/types";

/**
 * Where a layout guide's bands land, as plain arithmetic on the frame's box.
 *
 * Deliberately NOT part of the layout pass: a guide is a ruler the author
 * measures against, so it may not move a single child, and nothing here is
 * reached from `relayoutDocumentTree` / `compile`. `bands` is the closed form
 * Figma's columns and rows panels describe; `cells` is a pitch, which is why a
 * grid guide reports a count instead of receiving one.
 */

export interface GuideBox {
  width: number;
  height: number;
}

export interface GuideRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type LayoutGuideGeometry =
  /** One rect per band — columns or rows, already inset and gutted. */
  | { kind: "bands"; rects: GuideRect[]; bandSize: number }
  /** A tiling of fixed cells. Drawn as one `<pattern>`, not as `columns × rows` rects. */
  | { kind: "cells"; columns: number; rows: number; size: number }
  /** Nothing to draw, and `check` reports it (`guide-degenerate`). */
  | { kind: "none" };

/** Figma's default for a grid nobody coloured: red at 10%. */
export const DEFAULT_GUIDE_COLOR = "#FF00001A";

const positive = (value: number | undefined, fallback = 0): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;

const alignOf = (guide: LayoutGuide): LayoutGuide["align"] => guide.align ?? "stretch";

/**
 * The bands a columns / rows guide divides its box into.
 *
 * `margin` insets the SET, not each band, and only along the axis the guide
 * measures: a column guide's margin is its left and right inset, a row guide's is
 * top and bottom. The other axis is the box — Figma's column band runs the full
 * height, and a ruler that also pulled itself in from the top would be measuring
 * a rectangle nobody asked for.
 *
 * Both sides when the set stretches (Figma's Stretch), the starting side only
 * when it does not (Figma's Left / Right / Center) — the far side is then
 * wherever the bands end, which is what "aligned to the left edge" means.
 */
export function guideGeometry(guide: LayoutGuide, box: GuideBox): LayoutGuideGeometry {
  const width = positive(box.width);
  const height = positive(box.height);
  if (width <= 0 || height <= 0) return { kind: "none" };

  if (guide.kind === "grid") {
    const size = positive(guide.size);
    if (size <= 0) return { kind: "none" };
    return { kind: "cells", columns: Math.floor(width / size), rows: Math.floor(height / size), size };
  }

  const count = Math.floor(positive(guide.count));
  if (count <= 0) return { kind: "none" };

  const margin = positive(guide.margin);
  const gutter = positive(guide.gutter);
  const horizontal = guide.kind === "columns";
  const main = horizontal ? width : height;
  const cross = horizontal ? height : width;
  const usable = main - margin * 2;
  if (usable <= 0) return { kind: "none" };

  const align = alignOf(guide);
  let band: number;
  let start: number;
  if (align === "stretch") {
    band = (usable - (count - 1) * gutter) / count;
    start = margin;
  } else {
    band = positive(horizontal ? guide.width : guide.height);
    if (band <= 0) return { kind: "none" };
    const total = count * band + (count - 1) * gutter;
    start =
      align === "start" ? margin : align === "end" ? main - margin - total : margin + (usable - total) / 2;
  }
  if (band <= 0) return { kind: "none" };

  const rects: GuideRect[] = [];
  for (let i = 0; i < count; i++) {
    const at = start + i * (band + gutter);
    rects.push(
      horizontal
        ? { x: at, y: 0, width: band, height: cross }
        : { x: 0, y: at, width: cross, height: band }
    );
  }
  return { kind: "bands", rects, bandSize: band };
}

/**
 * The same ruler, re-spoken as another kind.
 *
 * The three kinds do not share a vocabulary — `grid` has no count, `stretch` has
 * no width — so a kind change REBUILDS rather than spreads: `{ kind: "grid",
 * count: 5 }` would be a count nothing reads and a key that still saves. A column
 * or row guide starts at the defaults an author expects (a 20px gutter, no
 * inset), because the first thing they do is drag the gutter and bands that
 * start out touching read as a broken grid.
 */
export function retargetGuide(guide: LayoutGuide, kind: LayoutGuideKind, box: GuideBox): LayoutGuide {
  const colour = guide.color ? { color: guide.color } : {};
  const hidden = guide.visible === false ? { visible: false } : {};
  if (kind === "grid") return { kind, size: guide.size ?? 8, ...colour, ...hidden };

  const band = guideGeometry(guide, box);
  const size = Math.round(band.kind === "bands" ? band.bandSize : 96);
  const fixed =
    (guide.align ?? "stretch") === "stretch" ? {} : kind === "columns" ? { width: size } : { height: size };
  return {
    kind,
    count: guide.count ?? (kind === "columns" ? 5 : 3),
    align: guide.align ?? "stretch",
    gutter: guide.gutter ?? 20,
    margin: guide.margin ?? 0,
    ...fixed,
    ...colour,
    ...hidden
  };
}

/**
 * A grid guide as the pattern paint that can already draw it.
 *
 * A uniform grid is not a grid in the layout sense: it is a tiling, which is what
 * `Paint`'s `pattern` kind is, and `pattern-tile.ts` already derives that tiling
 * once for both serializers — the SVG `<pattern>` the canvas repeats and the CSS
 * background the swatches use. Reusing it means the guide cannot drift from the
 * fill that looks identical: same pitch, same weight clamp, same origin.
 *
 * `weight` is 1 because Figma's grid panel has no line-weight control; the line
 * is a hairline and the only thing the author decided is the pitch and the colour.
 */
export function guidePatternPaint(guide: LayoutGuide, zoom = 1): PatternPaint {
  return {
    type: "pattern",
    motif: "grid",
    tile: { width: positive(guide.size, 1), height: positive(guide.size, 1) },
    // A HAIRLINE, not a document length: Figma draws the grid at one screen
    // pixel whatever the zoom, so the weight is stated in screen px and divided
    // through. A fixed 1 here is 8px thick at 800%, which reads as a ruling pen.
    weight: 1 / (zoom > 0 ? zoom : 1),
    foreground: guide.color ?? DEFAULT_GUIDE_COLOR
  };
}

/**
 * The one line the inspector and the e2e rig both read, as a key rather than a
 * sentence: the panel must not own an English string, and a rig that restated
 * the wording would pass while the panel said something else.
 */
export function guideSummary(guide: LayoutGuide, box: GuideBox): { key: string; vars: Record<string, number> } {
  if (guide.kind === "grid") {
    // "8px grid", not "180 × 112 grid": the cell count is a DERIVED number that
    // changes when the frame does, so printing it makes a ruler look like it has a
    // resolution the author set. The pitch is the decision; the count is a fact
    // about the box.
    return { key: "layoutGuide.summary.grid", vars: { size: positive(guide.size, 0) } };
  }
  return {
    key: guide.kind === "columns" ? "layoutGuide.summary.columns" : "layoutGuide.summary.rows",
    vars: { count: Math.floor(positive(guide.count)) }
  };
}

/**
 * The element with this ruler on it — or with no `layoutGuides` key at all.
 *
 * Absence is the spelling of "no guides": an empty array is a decision nobody
 * made, and it round-trips as a key that reads like one. Shared with the style
 * "apply", which is a copy of the saved array onto the frame.
 */
export function withLayoutGuides(el: DesignElement, guides: readonly LayoutGuide[]): DesignElement {
  const next = { ...el } as Record<string, unknown>;
  if (guides.length === 0) delete next.layoutGuides;
  else next.layoutGuides = guides.map((guide) => ({ ...guide }));
  return next as unknown as DesignElement;
}

// ---------------------------------------------------------------------------
// snapping
// ---------------------------------------------------------------------------

export interface GuideSpan {
  position: number;
  start: number;
  end: number;
}

export interface GuideLineSet {
  vertical: GuideSpan[];
  horizontal: GuideSpan[];
}

const EMPTY_LINES: GuideLineSet = { vertical: [], horizontal: [] };

/** Memoised on the page array. A drag replaces that array every frame, so the
 *  caller that drags caches per gesture instead (see `drag-apply`); a shape being
 *  drawn leaves the page alone, and there this hit rate is 100%. */
const lineCache = new WeakMap<object, { frameId: string; lines: GuideLineSet }>();

/**
 * Every guide EDGE on the page, in world coordinates, as snap targets.
 *
 * A turned frame's guides are deliberately absent: they are real rulers, but not
 * axis-aligned ones, and this mechanism snaps on X and Y only — feeding them in
 * would snap to lines the author cannot see.
 *
 * A `grid`'s pitch IS here, and it does quantise a drag: at 8px with a 6px magnet
 * every position is within reach of a line, which is exactly "snap to an 8pt
 * grid". That is the author's own decision when they put the grid on the frame —
 * withhold it and the ruler they are aligning to does nothing.
 */
export function guideSnapLines(page: readonly DesignElement[], frameId?: string): GuideLineSet {
  // Only the frame that owns the gesture contributes: a ruler on the artboard
  // next door is a different drawing, and pulling a card onto it is the one thing
  // a guide must never do.
  if (!frameId) return EMPTY_LINES;
  const cached = lineCache.get(page);
  if (cached && cached.frameId === frameId) return cached.lines;

  const lines: GuideLineSet = { vertical: [], horizontal: [] };
  const walk = (list: readonly DesignElement[], ox: number, oy: number) => {
    for (const el of list) {
      if (el.visible === false) continue;
      const turned = typeof el.rotation === "number" && Math.abs(el.rotation) > 0.01;
      if (turned) continue;
      const x = ox + (el.x ?? 0);
      const y = oy + (el.y ?? 0);
      const guides = el.id === frameId ? (el as { layoutGuides?: LayoutGuide[] }).layoutGuides : undefined;
      if (Array.isArray(guides)) {
        for (const guide of guides) {
          if (guide.visible === false) continue;
          const width = el.width ?? 0;
          const height = el.height ?? 0;
          const geometry = guideGeometry(guide, { width, height });
          if (geometry.kind === "cells") {
            for (let i = 0; i <= geometry.columns; i++) {
              lines.vertical.push({ position: x + i * geometry.size, start: y, end: y + height });
            }
            for (let j = 0; j <= geometry.rows; j++) {
              lines.horizontal.push({ position: y + j * geometry.size, start: x, end: x + width });
            }
            continue;
          }
          if (geometry.kind !== "bands") continue;
          for (const rect of geometry.rects) {
            if (guide.kind === "columns") {
              lines.vertical.push(
                { position: x + rect.x, start: y, end: y + height },
                { position: x + rect.x + rect.width, start: y, end: y + height }
              );
            } else {
              lines.horizontal.push(
                { position: y + rect.y, start: x, end: x + width },
                { position: y + rect.y + rect.height, start: x, end: x + width }
              );
            }
          }
        }
      }
      const children = (el as { children?: DesignElement[] }).children;
      if (Array.isArray(children)) walk(children, x, y);
    }
  };
  walk(page, 0, 0);

  lineCache.set(page, { frameId, lines });
  return lines;
}

const nearest = (spans: readonly GuideSpan[], value: number, reach: number): number | null => {
  let best: number | null = null;
  for (const span of spans) {
    const delta = Math.abs(span.position - value);
    if (delta <= reach && (best === null || delta < Math.abs(best - value))) best = span.position;
  }
  return best;
};

/**
 * A pointer position pulled onto the nearest guide edge, per axis.
 *
 * This is what makes a NEW shape land on the ruler: the draft is computed from
 * two points, and snapping the moving one puts that corner exactly on the line
 * while the anchor point stays where the author pressed.
 */
export function snapPointToGuides(
  lines: GuideLineSet,
  point: { x: number; y: number },
  reach: number
): { x: number; y: number } {
  const x = nearest(lines.vertical, point.x, reach);
  const y = nearest(lines.horizontal, point.y, reach);
  return { x: x ?? point.x, y: y ?? point.y };
}

