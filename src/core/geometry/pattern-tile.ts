import type { PatternPaint } from "../dsl/types";

/**
 * One derivation, two serializers.
 *
 * The canvas paints through SVG (`<pattern>` / a repeating `<linearGradient>`)
 * and every DOM surface paints through CSS (`background`). Writing those twice
 * drifts in ways a review cannot see — the swatch and the canvas disagreeing by
 * half a stripe still looks like a pattern. So the pitch, the alignment phase
 * and the stripe phase are computed here once and both serializers read them.
 */

export interface PatternBox {
  width: number;
  height: number;
}

const DEFAULT_WEIGHT = 2;
const DEFAULT_ANGLE = 45;
const MIN_WEIGHT = 0.1;

const positive = (value: number | undefined, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;

const mod = (value: number, period: number): number => ((value % period) + period) % period;

export const isStripeMotif = (motif: PatternPaint["motif"]): boolean =>
  motif === "diagonal-stripes" || motif === "crosshatch";

/** One motif cell plus its gap — the unit the stripe motifs measure against. */
export function patternPitch(paint: PatternPaint): { x: number; y: number } {
  const scale = positive(paint.scale, 1);
  const spacingX = Math.max(0, paint.spacing?.x ?? 0);
  const spacingY = Math.max(0, paint.spacing?.y ?? 0);
  const cellX = Math.max(1, (paint.tile?.width ?? 16) * scale);
  const cellY = Math.max(1, (paint.tile?.height ?? 16) * scale);
  const stepX = cellX + spacingX;
  const stepY = cellY + spacingY;
  // A checker needs two cells per axis to close its diagonal pair.
  const factor = paint.motif === "checker" ? 2 : 1;
  return { x: Math.max(1, stepX * factor), y: Math.max(1, stepY * factor) };
}

/**
 * The motifs whose tile can be offset row by row.
 *
 * Stripes have no tile to offset, and crosshatch's tile sides ARE its stripe
 * lattice — shifting it would open a seam at every tile edge.
 */
const HEX_TILE_MOTIFS = new Set<PatternPaint["motif"]>(["dots", "grid", "checker"]);

/** The second copy's offset, in cells, or null for a plain rectangular grid. */
const hexShift = (paint: PatternPaint): { x: number; y: number } | null => {
  if (!HEX_TILE_MOTIFS.has(paint.motif)) return null;
  if (paint.tileType === "horizontal-hexagonal") return { x: 0.5, y: 1 };
  if (paint.tileType === "vertical-hexagonal") return { x: 1, y: 0.5 };
  return null;
};

/**
 * The unit that actually repeats: one cell, doubled for a checker's pair, and
 * doubled again for a hexagonal offset's second row.
 */
export function patternTileSize(paint: PatternPaint): { x: number; y: number } {
  const pitch = patternPitch(paint);
  return hexShift(paint) ? { x: pitch.x * 2, y: pitch.y * 2 } : pitch;
}

/** Where the tile grid starts on the box. `start` is the box origin, `end` ends on a whole tile. */
export function patternOrigin(paint: PatternPaint, box?: PatternBox): { x: number; y: number } {
  const tile = patternTileSize(paint);
  const alignment = paint.alignment ?? "start";
  if (alignment === "start" || !box) return { x: 0, y: 0 };
  const remainderX = box.width % tile.x;
  const remainderY = box.height % tile.y;
  return alignment === "center"
    ? { x: remainderX / 2, y: remainderY / 2 }
    : { x: remainderX, y: remainderY };
}

/** The motif's stroke weight, clamped so the SVG tile's clip and the CSS band agree. */
export function patternWeight(paint: PatternPaint, period: number): number {
  const raw = typeof paint.weight === "number" && Number.isFinite(paint.weight)
    ? paint.weight
    : DEFAULT_WEIGHT;
  return Math.min(Math.max(MIN_WEIGHT, raw), Math.max(MIN_WEIGHT, period / 2));
}

const resolvedAngle = (paint: PatternPaint): number =>
  typeof paint.angle === "number" && Number.isFinite(paint.angle) ? paint.angle : DEFAULT_ANGLE;

/**
 * Distance from the origin to where CSS's gradient line starts, along the
 * gradient's own direction.
 *
 * `repeating-linear-gradient` counts its stops from that point, not from the
 * box's top-left corner, so the same stripe period lands at a different phase
 * on every box size. SVG counts from the user-space origin. Without this term
 * the two agree only by accident.
 */
export function stripePhase(box: PatternBox, angle: number): number {
  const rad = (angle * Math.PI) / 180;
  const sin = Math.sin(rad);
  const cos = Math.cos(rad);
  const lineLength = Math.abs(box.width * sin) + Math.abs(box.height * cos);
  return lineLength / 2 - (box.width / 2) * sin + (box.height / 2) * cos;
}

/** The gradient line's start point in element-local space, CSS's own convention. */
export function stripeStart(box: PatternBox, angle: number): { x: number; y: number } {
  const rad = (angle * Math.PI) / 180;
  const sin = Math.sin(rad);
  const cos = Math.cos(rad);
  const lineLength = Math.abs(box.width * sin) + Math.abs(box.height * cos);
  return {
    x: box.width / 2 - (lineLength / 2) * sin,
    y: box.height / 2 + (lineLength / 2) * cos
  };
}

export interface StripeBand {
  /** Position along the line, px from its start. 0 is the first boundary. */
  at: number;
  color: string;
}

/** Stops with both edges spelled, so CSS does not blend them into ramps. */
function bandStops(bands: StripeBand[], period: number): string {
  return bands
    .map((band, i) => `${band.color} ${round(band.at)}px ${round(bands[i + 1]?.at ?? period)}px`)
    .join(", ");
}

const round = (value: number): number => Math.round(value * 1000) / 1000;

/** The shortest spelling of a length that both serializers agree on. */
const num = (value: number): string => String(round(value));

/**
 * One period of hard-edged bands, as the exact stop list both sides paint.
 *
 * The bands are sampled at interval midpoints instead of being assembled from
 * `phase` and `width` by hand: the phase can push a band across the period
 * boundary, and a case analysis of where it lands is one sign error away from a
 * seam nobody notices until a different box size.
 */
export function stripeBands(
  phase: number,
  width: number,
  period: number,
  on: string,
  off: string
): StripeBand[] {
  const gap = Math.min(Math.max(MIN_WEIGHT, width), period);
  const cuts = new Set<number>([0, period]);
  for (let k = -2; k <= 2; k++) {
    for (const boundary of [phase + k * period, phase + gap + k * period]) {
      const value = Math.round(boundary * 1000) / 1000;
      if (value > 0.0001 && value < period - 0.0001) cuts.add(value);
    }
  }
  const sorted = [...cuts].sort((a, b) => a - b);
  const bands: StripeBand[] = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const at = sorted[i];
    const next = sorted[i + 1];
    const onBand = mod((at + next) / 2 - phase, period) < gap;
    bands.push({ at, color: onBand ? on : off });
  }
  return bands;
}

export type PatternSvgShape =
  | { kind: "rect"; x: number; y: number; width: number; height: number; fill: string; rotate?: number }
  | { kind: "circle"; cx: number; cy: number; r: number; fill: string };

export interface PatternSvgGradient {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  stops: { offset: number; color: string }[];
}

export type PatternSvgPaint =
  /** One tile the browser repeats. */
  | { kind: "tile"; width: number; height: number; x: number; y: number; background?: string; shapes: PatternSvgShape[] }
  /** A single repeating gradient — arbitrary angles, no tile to seam. */
  | { kind: "stripes"; gradient: PatternSvgGradient };

const offColor = (paint: PatternPaint): string => paint.background ?? "transparent";

export function patternSvgPaint(paint: PatternPaint, box: PatternBox): PatternSvgPaint {
  const pitch = patternPitch(paint);
  const origin = patternOrigin(paint, box);
  const foreground = paint.foreground;

  if (paint.motif === "diagonal-stripes") {
    const angle = resolvedAngle(paint);
    const period = pitch.x;
    const width = patternWeight(paint, period);
    // A bare gradient fills the box, so there is no tile to align: the phase is
    // read straight off the box, exactly as CSS reads it.
    const phase = mod(stripePhase(box, angle), period);
    const start = stripeStart(box, angle);
    const rad = (angle * Math.PI) / 180;
    const dirX = Math.sin(rad);
    const dirY = -Math.cos(rad);
    const bands = stripeBands(phase, width, period, foreground, offColor(paint));
    const stops: { offset: number; color: string }[] = [];
    bands.forEach((band, i) => {
      // Both edges spelled, or SVG ramps between the bands and the fill reads as
      // a soft gradient where CSS paints a hard edge.
      stops.push({ offset: band.at / period, color: band.color });
      stops.push({ offset: (bands[i + 1]?.at ?? period) / period, color: band.color });
    });
    return {
      kind: "stripes",
      gradient: {
        x1: start.x,
        y1: start.y,
        x2: start.x + period * dirX,
        y2: start.y + period * dirY,
        stops
      }
    };
  }

  if (paint.motif === "crosshatch") return { kind: "tile", ...crosshatchTile(paint, pitch, origin) };

  return { kind: "tile", ...motifTile(paint, pitch, origin) };
}

/** One cell's shapes, in the cell's own coordinates. */
function motifShapes(paint: PatternPaint, pitch: { x: number; y: number }): PatternSvgShape[] {
  const foreground = paint.foreground;

  if (paint.motif === "dots") {
    // `weight` is a diameter, so the radius is half of it; the clamp is twice
    // the cell so a dot can just touch its neighbours.
    const radius = patternWeight(paint, Math.min(pitch.x, pitch.y) * 2) / 2;
    return [{ kind: "circle", cx: pitch.x / 2, cy: pitch.y / 2, r: radius, fill: foreground }];
  }

  if (paint.motif === "grid") {
    const width = patternWeight(paint, Math.min(pitch.x, pitch.y));
    return [
      { kind: "rect", x: 0, y: 0, width, height: pitch.y, fill: foreground },
      { kind: "rect", x: 0, y: 0, width: pitch.x, height: width, fill: foreground }
    ];
  }

  // The pair CSS's `conic-gradient` paints first: top-right and bottom-left.
  const cellX = pitch.x / 2;
  const cellY = pitch.y / 2;
  return [
    { kind: "rect", x: cellX, y: 0, width: cellX, height: cellY, fill: foreground },
    { kind: "rect", x: 0, y: cellY, width: cellX, height: cellY, fill: foreground }
  ];
}

const shiftShape = (shape: PatternSvgShape, dx: number, dy: number): PatternSvgShape =>
  shape.kind === "circle"
    ? { ...shape, cx: shape.cx + dx, cy: shape.cy + dy }
    : { ...shape, x: shape.x + dx, y: shape.y + dy };

/**
 * The tile a browser repeats, with the hexagonal second copy beside the first.
 *
 * CSS's `background-repeat` is a rectangular grid and cannot stagger alternate
 * rows, so the offset lives in the tile: width × 2 and height × 2, the same cell
 * drawn once and once more half a cell along.
 */
function motifTile(
  paint: PatternPaint,
  pitch: { x: number; y: number },
  origin: { x: number; y: number }
): Omit<Extract<PatternSvgPaint, { kind: "tile" }>, "kind"> {
  const base = motifShapes(paint, pitch);
  const shift = hexShift(paint);
  if (!shift) {
    return {
      width: pitch.x,
      height: pitch.y,
      x: origin.x,
      y: origin.y,
      ...(paint.background ? { background: paint.background } : {}),
      shapes: base
    };
  }
  const dx = pitch.x * shift.x;
  const dy = pitch.y * shift.y;
  return {
    width: pitch.x * 2,
    height: pitch.y * 2,
    x: origin.x,
    y: origin.y,
    ...(paint.background ? { background: paint.background } : {}),
    shapes: [...base, ...base.map((shape) => shiftShape(shape, dx, dy))]
  };
}

/**
 * A tile as a standalone SVG — the form CSS needs for the layouts its gradients
 * cannot express: a staggered repeat, and crosshatch's two families.
 *
 * `encodeURIComponent` is load-bearing: a `#` in a colour would end the URI at
 * the fragment, and the quotes in the attributes would close `url("…")`.
 */
function tileDataUri(tile: Omit<Extract<PatternSvgPaint, { kind: "tile" }>, "kind">): string {
  const body = tile.shapes
    .map((shape) =>
      shape.kind === "circle"
        ? `<circle cx="${num(shape.cx)}" cy="${num(shape.cy)}" r="${num(shape.r)}" fill="${shape.fill}"/>`
        : `<rect x="${num(shape.x)}" y="${num(shape.y)}" width="${num(shape.width)}" height="${num(shape.height)}" fill="${shape.fill}"${
            shape.rotate !== undefined ? ` transform="rotate(${num(shape.rotate)})"` : ""
          }/>`
    )
    .join("");
  const background = tile.background
    ? `<rect width="${num(tile.width)}" height="${num(tile.height)}" fill="${tile.background}"/>`
    : "";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${num(tile.width)}" height="${num(tile.height)}" viewBox="0 0 ${num(tile.width)} ${num(tile.height)}">${background}${body}</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

/**
 * Crosshatch has to be a tile: one SVG paint server cannot hold two gradients,
 * and CSS's pair of `repeating-linear-gradient`s would paint the background
 * twice.
 *
 * A tile only closes if its sides are whole multiples of the stripe lattice —
 * `period / |sin θ|` across, `period / |cos θ|` down — so those ARE its sides,
 * not a free choice. At 45° that is `period · √2` square.
 */
function crosshatchTile(
  paint: PatternPaint,
  pitch: { x: number; y: number },
  origin: { x: number; y: number }
): Omit<Extract<PatternSvgPaint, { kind: "tile" }>, "kind"> {
  const angle = resolvedAngle(paint);
  const rad = (angle * Math.PI) / 180;
  const sin = Math.abs(Math.sin(rad));
  const cos = Math.abs(Math.cos(rad));
  const period = pitch.x;
  const weight = patternWeight(paint, period);
  // A tile closes only when its sides are whole multiples of the stripe
  // lattice — `period / |sin θ|` across, `period / |cos θ|` down — so those ARE
  // its sides, not a free choice. At 45° that is `period · √2` square.
  const tileWidth = Math.max(1, period / Math.max(sin, 1e-3));
  const tileHeight = Math.max(1, period / Math.max(cos, 1e-3));
  const span = Math.max(tileWidth, tileHeight) * 2;
  const shapes: PatternSvgShape[] = [];

  for (const direction of [1, -1]) {
    const dirAngle = angle * direction;
    // A band boundary always lands on the tile origin, and `y_local` runs
    // against the gradient axis — so the band that starts at the origin sits
    // just BELOW each multiple, by exactly one weight.
    const steps = Math.ceil((span * 2) / period) + 2;
    for (let k = -steps; k <= steps; k++) {
      shapes.push({
        kind: "rect",
        x: -span,
        y: k * period - weight,
        width: span * 2,
        height: weight,
        fill: paint.foreground,
        rotate: dirAngle
      });
    }
  }

  return {
    width: tileWidth,
    height: tileHeight,
    x: origin.x,
    y: origin.y,
    ...(paint.background ? { background: paint.background } : {}),
    shapes
  };
}

/**
 * The paint's CSS form, sized and positioned so it covers the element exactly
 * like the SVG def does. One string, because `paintStackLayers` gives a paint
 * one background layer and a CSS layer carries its own size and position.
 */
export function patternCssBackground(paint: PatternPaint, box?: PatternBox): string {
  const pitch = patternPitch(paint);
  const origin = patternOrigin(paint, box);
  const foreground = paint.foreground;
  const off = offColor(paint);

  if (paint.motif === "diagonal-stripes") {
    const angle = resolvedAngle(paint);
    const period = pitch.x;
    const width = patternWeight(paint, period);
    const bands = stripeBands(box ? mod(stripePhase(box, angle), period) : 0, width, period, foreground, off);
    return `repeating-linear-gradient(${angle}deg, ${bandStops(bands, period)})`;
  }

  // The hexagonal layouts are the one thing a CSS gradient cannot say: alternate
  // rows share a pitch but not a phase. The doubled tile has to be a picture, so
  // it ships as an inline SVG — the same tile the `<pattern>` def paints, encoded.
  if (hexShift(paint)) {
    const tile = motifTile(paint, pitch, origin);
    return `${tileDataUri(tile)} ${num(origin.x)}px ${num(origin.y)}px / ${num(tile.width)}px ${num(tile.height)}px repeat`;
  }

  if (paint.motif === "dots") {
    // `weight` is a diameter, so the radius is half of it; the clamp is twice
    // the cell so a dot can just touch its neighbours.
    const radius = patternWeight(paint, Math.min(pitch.x, pitch.y) * 2) / 2;
    const layer = `radial-gradient(circle at 50% 50%, ${foreground} 0 ${radius}px, ${off} ${radius}px)`;
    return `${layer} ${origin.x}px ${origin.y}px / ${pitch.x}px ${pitch.y}px repeat`;
  }

  if (paint.motif === "grid") {
    const width = patternWeight(paint, Math.min(pitch.x, pitch.y));
    const vertical = `linear-gradient(90deg, ${foreground} 0 ${width}px, ${off} ${width}px)`;
    const horizontal = `linear-gradient(180deg, ${foreground} 0 ${width}px, ${off} ${width}px)`;
    return `${vertical} ${origin.x}px 0 / ${pitch.x}px 100% repeat-x, ${horizontal} 0 ${origin.y}px / 100% ${pitch.y}px repeat-y`;
  }

  if (paint.motif === "checker") {
    const layer = `conic-gradient(${foreground} 0 25%, ${off} 0 50%, ${foreground} 0 75%, ${off} 0)`;
    return `${layer} ${origin.x}px ${origin.y}px / ${pitch.x}px ${pitch.y}px repeat`;
  }

  // Crosshatch is two gradient families in one tile. Two `repeating-linear-gradient`
  // layers come out a weight out of step — each family's phase is measured along
  // its own axis — so the swatch would show a denser lattice than the canvas. It
  // ships the same tile instead, and the two cannot disagree.
  const tile = crosshatchTile(paint, pitch, origin);
  return `${tileDataUri(tile)} ${num(origin.x)}px ${num(origin.y)}px / ${num(tile.width)}px ${num(tile.height)}px repeat`;
}
