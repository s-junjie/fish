/**
 * Angular (conic) and diamond gradient geometry.
 *
 * SVG 1.1 has two paint servers and both are affine, so whether a gradient kind
 * can be drawn at all comes down to whether its parameter is an affine function
 * of position:
 *
 *   diamond   t = |dx|/a + |dy|/b   -> not affine, but PIECEWISE affine on the
 *                                      four quadrants cut by the axes through
 *                                      the centre. Exact, four pieces.
 *   angular   t = atan2(dy, dx)/2pi -> not affine on any finite partition.
 *                                      Approximated by a fan of sectors.
 *
 * Both are emitted as an SVG `<pattern>` rather than as a paint server, so the
 * renderer keeps consuming them through the ordinary `url(#grad_*)` reference.
 */

import { Paint } from "../dsl/types";
import { canonicalGradientStops, GradientStop as Stop } from "../dsl/gradient-stops";
import { parseColorAlpha, composeColorAlpha, hexToRgb, rgbToHex } from "./color-utils";

/**
 * Colour of the gradient at `offset` (%), interpolated between the two
 * neighbouring stops in RGB. Used when a click on the gradient bar inserts a
 * new stop — it should appear exactly where the gradient already was — and by
 * the diamond / conic decompositions below, which slice one ramp into pieces and
 * need the colour at each boundary.
 *
 * Offsets outside the authored range return the nearest end stop, which is what
 * makes a piece whose extent runs past the last stop clamp like Figma does.
 */
export function sampleGradientAt(stops: Stop[], offset: number): string {
  if (stops.length === 0) return "#FFFFFF";
  const sorted = [...stops].sort((a, b) => a.offset - b.offset);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (offset <= first.offset) return first.color;
  if (offset >= last.offset) return last.color;
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    if (offset >= a.offset && offset <= b.offset) {
      const t = b.offset === a.offset ? 0 : (offset - a.offset) / (b.offset - a.offset);
      const ca = parseColorAlpha(a.color);
      const cb = parseColorAlpha(b.color);
      const ra = hexToRgb(ca.hex6);
      const rb = hexToRgb(cb.hex6);
      const hex = rgbToHex(
        ra.r + (rb.r - ra.r) * t,
        ra.g + (rb.g - ra.g) * t,
        ra.b + (rb.b - ra.b) * t
      );
      return composeColorAlpha(hex, ca.alphaPct + (cb.alphaPct - ca.alphaPct) * t);
    }
  }
  return last.color;
}

/** Angle convention shared with `ellipse.startAngle`: 0 = up, growing clockwise. */
function dirFromTop(deg: number): { x: number; y: number } {
  const rad = (deg * Math.PI) / 180;
  return { x: Math.sin(rad), y: -Math.cos(rad) };
}

function stopsOf(paint: Paint): Stop[] {
  const p = paint as any;
  const stops = canonicalGradientStops(p.stops);
  if (stops && stops.length > 0) return stops;
  return [
    { color: p.from || "#3B82F6", offset: typeof p.fromOffset === "number" ? p.fromOffset : 0 },
    { color: p.to || "#1E1E1E", offset: typeof p.toOffset === "number" ? p.toOffset : 1 }
  ];
}

/**
 * The box a pattern tile must cover, in the element's local px space.
 *
 * A `<pattern>` clips to its own tile, and a centre- or outside-aligned stroke
 * paints outside the element's box — so a stroke gradient needs the tile
 * inflated by the stroke width or the gradient visibly repeats past the edge.
 * `pad` is 0 for fills.
 */
export interface GradientTile {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function gradientTile(width: number, height: number, pad: number): GradientTile {
  return { x: -pad, y: -pad, width: width + pad * 2, height: height + pad * 2 };
}

/* ------------------------------------------------------------------ *
 * Diamond                                                            *
 * ------------------------------------------------------------------ */

export interface DiamondQuadrant {
  /** Quadrant rectangle, local px. Oversized so a rotation cannot uncover the tile. */
  rect: { x: number; y: number; width: number; height: number };
  /** `linearGradient` endpoints, local px (`gradientUnits="userSpaceOnUse"`). */
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** Stops with offsets already remapped onto this quadrant's own extent. */
  stops: Stop[];
}

export interface DiamondGeometry {
  cx: number;
  cy: number;
  /** 0 when the diamond is axis-aligned; the `<g>` rotation otherwise. */
  rotation: number;
  quadrants: DiamondQuadrant[];
}

/**
 * Splits a diamond paint into four quadrant ramps.
 *
 * Inside a quadrant both `|dx|` and `|dy|` lose their absolute value, so
 * `t = (sx/a)·dx + (sy/b)·dy = u·(P−C)` — affine, and therefore exactly what one
 * `linearGradient` renders. Choosing the segment `P1 = C`, `P2 = C + (tMax/|u|²)·u`
 * makes the gradient's own 0..1 parameter equal `t / tMax`.
 *
 * `P2` frequently lands outside the box: the gradient axis is normal to the
 * diamond edges, which is generally not the direction of the box corner.
 */
export function diamondQuadrants(
  paint: Paint,
  width: number,
  height: number,
  pad: number
): DiamondGeometry {
  const dia = paint as Extract<Paint, { type: "diamond-gradient" }>;
  const stops = stopsOf(paint);
  const rx = dia.rx ?? dia.radius ?? 0.75;
  const ry = dia.ry ?? dia.radius ?? 0.75;
  const a = Math.max(1e-6, rx * width);
  const b = Math.max(1e-6, ry * height);
  const cx = (dia.center?.x ?? 0.5) * width;
  const cy = (dia.center?.y ?? 0.5) * height;
  const rotation = dia.angle ?? 0;

  const tile = gradientTile(width, height, pad);
  // Far enough that rotating the quadrant rects about the centre still covers
  // every corner of the tile.
  const reach = 3 * (Math.abs(tile.width) + Math.abs(tile.height)) + 1;
  // Two abutting rects leave a sub-pixel alpha seam even when their colours
  // match exactly, so each one reaches a hair into its neighbours.
  const overlap = 0.5;

  const quadrants: DiamondQuadrant[] = [];
  for (const [sx, sy] of [[1, 1], [-1, 1], [-1, -1], [1, -1]] as Array<[number, number]>) {
    const ux = sx / a;
    const uy = sy / b;
    const uLen2 = ux * ux + uy * uy;

    // Farthest tile corner in this quadrant's direction.
    const qx = sx > 0 ? tile.x + tile.width : tile.x;
    const qy = sy > 0 ? tile.y + tile.height : tile.y;
    const tMax = Math.abs(qx - cx) / a + Math.abs(qy - cy) / b;

    // A centre sitting on (or outside) the tile edge gives this quadrant no
    // area at all; emitting it would divide by a zero extent.
    const spanX = sx > 0 ? qx - cx : cx - qx;
    const spanY = sy > 0 ? qy - cy : cy - qy;
    if (spanX <= 0 || spanY <= 0 || tMax <= 0) continue;

    const rect = {
      x: sx > 0 ? cx - overlap : cx - reach,
      y: sy > 0 ? cy - overlap : cy - reach,
      width: reach + overlap,
      height: reach + overlap
    };
    const lambda = tMax / uLen2;
    quadrants.push({
      rect,
      x1: cx,
      y1: cy,
      x2: cx + lambda * ux,
      y2: cy + lambda * uy,
      stops: remapStops(stops, tMax)
    });
  }
  return { cx, cy, rotation, quadrants };
}

/**
 * Stops for one quadrant: a stop at metric `t` sits at `t / tMax` along the
 * segment, and stops past `tMax` are unreachable there — the ramp is closed with
 * the colour the gradient actually has at `tMax`, which is what Figma's
 * clamp-to-last-stop does.
 */
function remapStops(stops: Stop[], tMax: number): Stop[] {
  const out: Stop[] = [];
  for (const s of stops) {
    const t = s.offset;
    const off = t / tMax;
    if (off > 1) break;
    out.push({ color: s.color, offset: Math.round(off * 1e4) / 1e4 });
  }
  if (out.length === 0) {
    return [{ color: sampleGradientAt(stops, 0), offset: 0 }];
  }
  const last = out[out.length - 1];
  if (last.offset < 1) {
    out.push({ color: sampleGradientAt(stops, tMax), offset: 1 });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Angular                                                            *
 * ------------------------------------------------------------------ */

export interface AngularSector {
  /** Sector outline, local px: centre -> arc -> close. */
  d: string;
  /** `linearGradient` endpoints, local px — the chord across the sector. */
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  stops: Stop[];
}

/**
 * Sector count bounds. Below ~32 the chord error shows at 1x; at 2x or on large
 * artboards the boundary becomes visible, so the count scales with the RENDERED
 * pixel size rather than with the document unit. The cap is what keeps the DOM
 * from growing unbounded on a 4K export.
 */
const SECTOR_MIN = 32;
const SECTOR_MAX = 360;

export function angularSectors(
  paint: Paint,
  width: number,
  height: number,
  pad: number,
  viewScale = 1
): AngularSector[] {
  const ang = paint as Extract<Paint, { type: "angular-gradient" }>;
  const stops = stopsOf(paint);
  const cx = (ang.center?.x ?? 0.5) * width;
  const cy = (ang.center?.y ?? 0.5) * height;
  const start = ang.angle ?? 0;

  const tile = gradientTile(width, height, pad);
  const corners = [
    [tile.x, tile.y],
    [tile.x + tile.width, tile.y],
    [tile.x + tile.width, tile.y + tile.height],
    [tile.x, tile.y + tile.height]
  ];
  let radius = 0;
  for (const [qx, qy] of corners) {
    radius = Math.max(radius, Math.hypot(qx - cx, qy - cy));
  }
  if (radius <= 0) return [];

  /* The fan is a chord approximation of a conic, and its error is the chord's
     sagitta — `r·(1 − cos(step/2))`, which is a LENGTH. Picking the count from
     the element's document size alone therefore pins that length in document
     pixels: a 100px disc gets 100 sectors, which is 0.03px of sagitta at 100 %
     and 0.26px at 800 %, where each sector becomes a flat cell you can count
     around the rim. `viewScale` is the canvas zoom × devicePixelRatio — the same
     quantity the Liquid Glass bake is rasterised at, for the same reason. */
  const count = Math.max(
    SECTOR_MIN,
    Math.min(SECTOR_MAX, Math.round(Math.max(width, height) * Math.max(1, viewScale)))
  );
  const step = 360 / count;
  /* Enough extra sweep that the next sector paints over the seam: half a step,
     capped so a coarse fan does not overshoot into its neighbour's colour. A
     fixed arc length does not work here — at 360 sectors it is a tenth of a
     step, which leaves each boundary as a bare one-pixel antialiased line, and
     360 of those beat against the pixel grid into a moiré. Half a step covers
     the seam at every count. */
  const eps = Math.min(step * 0.5, 1.5);
  const axisRadius = radius * 0.6;

  const sectors: AngularSector[] = [];
  for (let i = 0; i < count; i++) {
    const t0 = i / count;
    const t1 = (i + 1) / count;
    const deg0 = start + i * step;
    const deg1 = start + (i + 1) * step;

    const p0 = dirFromTop(deg0);
    const p1 = dirFromTop(deg1 + eps);
    // Inflate the sector radius by 0.5px so neighbouring sectors paint over the
    // anti-aliasing seam. The overlap is small enough that the colour mismatch
    // (identical at the boundary, by construction) is invisible; without it the
    // AA gap shows as a faint radial line.
    const rOver = radius + 0.5;
    const ax = cx + rOver * p0.x;
    const ay = cy + rOver * p0.y;
    const bx = cx + rOver * p1.x;
    const by = cy + rOver * p1.y;
    const d =
      `M ${round(cx)} ${round(cy)} L ${round(ax)} ${round(ay)} ` +
      `A ${round(rOver)} ${round(rOver)} 0 0 1 ${round(bx)} ${round(by)} Z`;

    // The gradient axis runs radially through the sector's midpoint, not the
    // chord: a chord runs tangentially, so a ramp along it changes colour in the
    // wrong direction and the sector boundaries show as faint rays. Both
    // endpoints sit at the tile radius rather than at the sector's own ends, so
    // the ramp spans the sector's true angular range — the two ends then land on
    // exactly the colours the neighbouring sectors expect, and that continuity,
    // not the sector count, is what keeps the fan from banding.
    const mid = dirFromTop(deg0 + step / 2);
    const back = dirFromTop(deg0 + step / 2 + 180);
    sectors.push({
      d,
      x1: cx + radius * back.x,
      y1: cy + radius * back.y,
      x2: cx + radius * mid.x,
      y2: cy + radius * mid.y,
      stops: sectorStops(stops, t0, t1, i, count)
    });
  }
  return sectors;
}

/**
 * Stops for one sector. Four evenly spaced samples carry a smooth ramp; a stop
 * boundary that falls inside the sector is inserted at its exact position so a
 * hard edge stays hard instead of being smeared across the whole sector.
 */
function sectorStops(stops: Stop[], t0: number, t1: number, index: number, count: number): Stop[] {
  const at = (s: number): Stop => ({
    color: sampleGradientAt(stops, (index + s) / count),
    offset: Math.round(s * 1e4) / 1e4
  });
  const samples = [0, 1 / 3, 2 / 3, 1];
  for (const s of stops) {
    const t = s.offset;
    if (t > t0 + 1e-9 && t < t1 - 1e-9) samples.push((t - t0) * count);
  }
  samples.sort((a, b) => a - b);
  const seen = new Set<number>();
  const out: Stop[] = [];
  for (const s of samples) {
    if (s < 0 || s > 1) continue;
    const key = Math.round(s * 1e4);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(at(s));
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * CSS preview                                                        *
 * ------------------------------------------------------------------ */

/**
 * A diamond paint as layered CSS backgrounds — the same four-quadrant split, in
 * CSS. Returns one `background-image` layer per quadrant; the caller pairs each
 * with its own `background-position` / `background-size`.
 *
 * CSS re-derives a gradient's extent from the box it is sized to, and that box's
 * centre is a *corner* of the quadrant rather than the gradient's centre, so a
 * stop's authored offset has to be remapped onto the segment CSS actually draws
 * (`tA`..`tB`, read back by evaluating the metric at its two endpoints). The
 * direction is exact either way; this is what puts the colours in the right
 * places.
 */
export function diamondCssLayers(
  paint: Paint,
  width: number,
  height: number
): string[] {
  const dia = paint as Extract<Paint, { type: "diamond-gradient" }>;
  const stops = stopsOf(paint);
  const rx = dia.rx ?? dia.radius ?? 0.75;
  const ry = dia.ry ?? dia.radius ?? 0.75;
  const a = Math.max(1e-6, rx * width);
  const b = Math.max(1e-6, ry * height);
  const cx = (dia.center?.x ?? 0.5) * width;
  const cy = (dia.center?.y ?? 0.5) * height;
  const resolver = (c: string) => c;

  const layers: string[] = [];
  for (const [sx, sy] of [[1, 1], [-1, 1], [-1, -1], [1, -1]] as Array<[number, number]>) {
    const x0 = sx > 0 ? cx : 0;
    const x1 = sx > 0 ? width : cx;
    const y0 = sy > 0 ? cy : 0;
    const y1 = sy > 0 ? height : cy;
    const bw = x1 - x0;
    const bh = y1 - y0;
    if (bw <= 0 || bh <= 0) continue;

    // Metric covector in px space; the screen direction of steepest ascent.
    const ux = sx / a;
    const uy = sy / b;
    const uLen = Math.hypot(ux, uy);
    const nx = ux / uLen;
    const ny = uy / uLen;
    const lineLength = Math.abs(bw * nx) + Math.abs(bh * ny);
    if (lineLength <= 0) continue;

    const midX = x0 + bw / 2;
    const midY = y0 + bh / 2;
    const tA = ux * (midX - (lineLength / 2) * nx - cx) + uy * (midY - (lineLength / 2) * ny - cy);
    const tB = ux * (midX + (lineLength / 2) * nx - cx) + uy * (midY + (lineLength / 2) * ny - cy);
    const span = tB - tA;
    if (Math.abs(span) < 1e-9) continue;

    const cssAngle = ((Math.atan2(nx, -ny) * 180) / Math.PI + 360) % 360;
    const remapped: Array<{ color: string; offset: number }> = [];
    for (const s of stops) {
      const off = (s.offset - tA) / span;
      if (off < 0 || off > 1) continue;
      remapped.push({ color: s.color, offset: Math.round(off * 1e4) / 1e4 });
    }
    if (remapped.length === 0) continue;
    if (remapped[0].offset > 0) {
      remapped.unshift({ color: sampleGradientAt(stops, tA), offset: 0 });
    }
    if (remapped[remapped.length - 1].offset < 1) {
      remapped.push({ color: sampleGradientAt(stops, tB), offset: 1 });
    }
    const stopStr = remapped
      .map((s) => `${resolver(s.color)} ${Math.round(s.offset * 10000) / 100}%`)
      .join(", ");

    const posX = Math.round((x0 / width) * 1e4) / 1e2;
    const posY = Math.round((y0 / height) * 1e4) / 1e2;
    const sizeX = Math.round((bw / width) * 1e4) / 1e2;
    const sizeY = Math.round((bh / height) * 1e4) / 1e2;
    layers.push(
      `linear-gradient(${Math.round(cssAngle * 1e2) / 1e2}deg, ${stopStr}) ` +
        `${posX}% ${posY}% / ${sizeX}% ${sizeY}% no-repeat`
    );
  }
  return layers;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
