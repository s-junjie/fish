import type { GradientStop } from "../../core/dsl/types";
import { linearAngleFromVector, sampleGradientAt } from "../../core/geometry/gradient-utils";
import type { GradientPaint } from "./kind-memory";

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

const round4 = (n: number) => Math.round(n * 10000) / 10000;

/** A stop's offset at the precision the bar and the field show. */
export const roundOffset = (ratio: number) => Math.round(clamp01(ratio) * 1000) / 1000;

/**
 * Stops, sorted, with `from`/`to` written in the same move.
 *
 * Every reader of a gradient paint — renderer, export, swatch — reads the
 * endpoint pair, so a stop edit that left them stale repainted the layer from
 * the old colours.
 */
export function withStops(paint: GradientPaint, stops: GradientStop[]): GradientPaint {
  const sorted = [...stops].sort((a, b) => a.offset - b.offset);
  const last = sorted.length - 1;
  return {
    ...paint,
    stops: sorted,
    from: sorted[0].color,
    to: sorted[last].color,
    fromOffset: sorted[0].offset,
    toOffset: sorted[last].offset
  };
}

/** A stop that stops following its token but keeps the colour it is showing. */
export function detachedStop(stop: GradientStop): GradientStop {
  const { tokenId: _tokenId, ...rest } = stop;
  return rest;
}

/** A stop may not cross its neighbours: the ramp's order is its geometry. */
export function clampStopOffset(stops: GradientStop[], index: number, offset: number): number {
  const low = index > 0 ? stops[index - 1].offset : 0;
  const high = index < stops.length - 1 ? stops[index + 1].offset : 1;
  return Math.max(low, Math.min(high, offset));
}

/** Splits the ramp at `offset` with the colour the ramp already has there. */
export function insertStopAt(
  stops: GradientStop[],
  offset: number
): { stops: GradientStop[]; index: number } {
  const index = stops.filter((s) => s.offset <= offset).length;
  return {
    index,
    stops: [...stops.slice(0, index), { color: sampleGradientAt(stops, offset), offset }, ...stops.slice(index)]
  };
}

/**
 * Re-aims a gradient at `angle`.
 *
 * With independent endpoints the axis is rotated about its MIDPOINT, so the
 * scrub re-aims the line it shows instead of silently flattening the paint to
 * the symmetric form.
 */
export function rotateAxisToAngle(paint: GradientPaint, angle: number): GradientPaint {
  if (paint.type !== "linear-gradient" || !paint.start || !paint.end) {
    return { ...paint, angle };
  }
  const { start, end } = paint;
  const current = linearAngleFromVector(end.x - start.x, end.y - start.y);
  const rad = ((angle - current) * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const mx = (start.x + end.x) / 2;
  const my = (start.y + end.y) / 2;
  const rot = (pt: { x: number; y: number }) => ({
    x: round4(mx + (pt.x - mx) * cos - (pt.y - my) * sin),
    y: round4(my + (pt.x - mx) * sin + (pt.y - my) * cos)
  });
  return { ...paint, angle, start: rot(start), end: rot(end) };
}
