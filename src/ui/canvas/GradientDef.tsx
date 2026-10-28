import { Fragment } from "preact";
import type { Paint } from "../../core/dsl/types";
import {
  calcLinearGradientCoords,
  calcRadialGradientCoords,
  getGradientStops,
  isGradientPaint
} from "../../core/geometry/gradient-utils";
import {
  angularSectors,
  diamondQuadrants,
  gradientTile
} from "../../core/geometry/gradient-decomposition";
import { parseBlendFlood, parseColorAlpha } from "../../core/geometry/color-utils";

interface GradientDefProps {
  id: string;
  paint: Paint;
  /** Element box in local px — the coordinate space the pieces are drawn in. */
  width: number;
  height: number;
  /** Tile inflation: 0 for fills, the stroke width for strokes. */
  pad?: number;
  /**
   * Canvas zoom. A conic is not an SVG paint server, so it is a fan of sectors,
   * and how many it needs is a function of how big it is being DRAWN — see
   * `angularSectors`. Callers that paint at 1:1 (an export, a thumbnail) leave it
   * alone.
   */
  viewScale?: number;
}

/**
 * One gradient paint server, under whatever id the caller asks for.
 *
 * Linear and radial are native SVG. Angular and diamond are not — neither is
 * affine, and SVG has no third paint server — so each is emitted as a
 * `<pattern>` holding the pieces the decomposition in `gradient-decomposition`
 * produces: four quadrant rectangles for a diamond, a fan of sectors for a
 * conic. Keeping them behind the same `url(#id)` reference is what lets the
 * renderer, the exporter and the def-pruner stay unaware that they exist.
 */
export function GradientDef({ id, paint, width, height, pad = 0, viewScale = 1 }: GradientDefProps) {
  if (!isGradientPaint(paint)) return null;
  const w = Math.max(1, width);
  const h = Math.max(1, height);

  const stopsFor = (stops: Array<{ color: string; offset: number }>) => {
    const isBlendEncoded = paint.blendMode === "plus-lighter" || paint.blendMode === "color-burn";
    const parsed = stops.map((st) => {
      if (isBlendEncoded) {
        const { floodColor, floodOpacity } = parseBlendFlood(st.color, paint.blendMode);
        return { offset: st.offset, hex6: floodColor, opacity: floodOpacity };
      }
      const { hex6, alphaPct } = parseColorAlpha(st.color);
      return { offset: st.offset, hex6, opacity: alphaPct / 100 };
    });
    const fallbackHex = parsed.find((p) => p.opacity > 0)?.hex6;
    return parsed.map((p, i) => (
      <stop
        key={i}
        offset={`${Math.round(p.offset * 10000) / 100}%`}
        stopColor={p.opacity === 0 && fallbackHex ? fallbackHex : p.hex6}
        stopOpacity={p.opacity}
      />
    ));
  };

  if (paint.type === "linear-gradient") {
    return (
      <linearGradient id={id} {...calcLinearGradientCoords(paint, { width: w, height: h })}>
        {stopsFor(getGradientStops(paint))}
      </linearGradient>
    );
  }

  if (paint.type === "radial-gradient") {
    return (
      <radialGradient id={id} {...calcRadialGradientCoords(paint)}>
        {stopsFor(getGradientStops(paint))}
      </radialGradient>
    );
  }

  const tile = gradientTile(w, h, pad);

  if (paint.type === "diamond-gradient") {
    const { cx, cy, rotation, quadrants } = diamondQuadrants(paint, w, h, pad);
    if (quadrants.length === 0) return null;
    return (
      <pattern
        id={id}
        patternUnits="userSpaceOnUse"
        patternContentUnits="userSpaceOnUse"
        x={tile.x}
        y={tile.y}
        width={tile.width}
        height={tile.height}
      >
        {/* The quadrants are drawn axis-aligned and rotated as one: the whole
            diamond turns, and `userSpaceOnUse` carries each ramp with it. */}
        <g transform={rotation ? `rotate(${rotation} ${cx} ${cy})` : undefined}>
          {quadrants.map((q, i) => (
            <Fragment key={i}>
              <linearGradient
                id={`${id}_q${i}`}
                gradientUnits="userSpaceOnUse"
                x1={q.x1}
                y1={q.y1}
                x2={q.x2}
                y2={q.y2}
              >
                {stopsFor(q.stops)}
              </linearGradient>
              <rect
                x={q.rect.x}
                y={q.rect.y}
                width={q.rect.width}
                height={q.rect.height}
                fill={`url(#${id}_q${i})`}
              />
            </Fragment>
          ))}
        </g>
      </pattern>
    );
  }

  const sectors = angularSectors(paint, w, h, pad, viewScale);
  if (sectors.length === 0) return null;
  return (
    <pattern
      id={id}
      patternUnits="userSpaceOnUse"
      patternContentUnits="userSpaceOnUse"
      x={tile.x}
      y={tile.y}
      width={tile.width}
      height={tile.height}
    >
      {sectors.map((s, i) => (
        <Fragment key={i}>
          <linearGradient
            id={`${id}_w${i}`}
            gradientUnits="userSpaceOnUse"
            x1={s.x1}
            y1={s.y1}
            x2={s.x2}
            y2={s.y2}
          >
            {stopsFor(s.stops)}
          </linearGradient>
          <path d={s.d} fill={`url(#${id}_w${i})`} />
        </Fragment>
      ))}
    </pattern>
  );
}
