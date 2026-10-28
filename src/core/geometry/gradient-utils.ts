import { DesignElement, RectElement, EllipseElement, PolygonElement, StarElement, PathElement, Paint } from "../dsl/types";
import { canonicalGradientStops, GradientStop } from "../dsl/gradient-stops";
import { rectToPathData, ellipseToPathData, polygonToPathData, starToPathData } from "../compile";
import { parseColorAlpha } from "./color-utils";
import { isContainer } from "./tree-ops";
import { diamondCssLayers } from "./gradient-decomposition";
import { patternCssBackground } from "./pattern-tile";

/**
 * How long a CSS gradient line is: `|W·sin θ| + |H·cos θ|`.
 *
 * NOT the box's longer edge and not the diagonal — those agree with it only for
 * an axis-aligned angle, or for 45° on a square. `180deg` on a 200×20 box runs
 * 20px, so a stop written as 10px is the midpoint. A px stop position is a
 * fraction of THIS, which is why one wrong length looks right across most of a
 * page and wrong exactly where a px stop was written.
 */
export function linearGradientLineLength(width: number, height: number, angle: number): number {
  const rad = (angle * Math.PI) / 180;
  return Math.abs(width * Math.sin(rad)) + Math.abs(height * Math.cos(rad));
}

/**
 * A `linear-gradient`'s endpoints as objectBoundingBox percentages.
 *
 * The angle is CSS's: 0° points at top-centre and grows clockwise, measured in
 * the box's own px space — so on a 200×100 box `45` is a geometrically 45° line
 * 212px long, not a line across the normalised unit square. An explicit
 * `start`/`end` pair wins and is read as box fractions (Figma's model), where
 * the angle is not consulted at all.
 *
 * Only the box's ASPECT matters, not its size, since the result is a
 * percentage: a caller without a box gets the square one, which is exact for
 * every axis-aligned angle and wrong only for a diagonal.
 */
export function calcLinearGradientCoords(
  paint: Paint,
  box?: { width: number; height: number }
): { x1: string; y1: string; x2: string; y2: string } {
  const lin = paint as Extract<Paint, { type: "linear-gradient" }>;
  const pct = (fraction: number): string => `${Math.round(fraction * 10000) / 100}%`;
  const pctOfBox = (percent: number): string => `${Math.round(percent * 100) / 100}%`;
  if (lin.start && lin.end) {
    return {
      x1: pct(lin.start.x),
      y1: pct(lin.start.y),
      x2: pct(lin.end.x),
      y2: pct(lin.end.y)
    };
  }
  const angle = typeof lin.angle === "number" ? lin.angle : 0;
  const w = Math.abs(box?.width ?? 0);
  const h = Math.abs(box?.height ?? 0);
  const ratio = w > 0 && h > 0 ? h / w : 1;
  const rad = (angle * Math.PI) / 180;
  const sin = Math.sin(rad);
  const cos = Math.cos(rad);
  // Half the gradient line, as a percentage of each axis: the line is
  // `|sin| + ratio·|cos|` times the width, and `|sin|/ratio + |cos|` the height.
  const halfX = 50 * sin * (Math.abs(sin) + ratio * Math.abs(cos));
  const halfY = 50 * cos * (Math.abs(sin) / ratio + Math.abs(cos));
  return {
    x1: pctOfBox(50 - halfX),
    y1: pctOfBox(50 + halfY),
    x2: pctOfBox(50 + halfX),
    y2: pctOfBox(50 - halfY)
  };
}

export function isGradientPaint(paint?: Paint | null): paint is Extract<
  Paint,
  { type: "linear-gradient" | "radial-gradient" | "angular-gradient" | "diamond-gradient" }
> {
  const t = paint?.type;
  return (
    t === "linear-gradient" ||
    t === "radial-gradient" ||
    t === "angular-gradient" ||
    t === "diamond-gradient"
  );
}

export function getPaintColor(paint?: Paint): string {
  if (!paint) return "#3B82F6";
  if (paint.type === "solid") return paint.color;
  if (paint.type === "pattern") return paint.foreground;
  if (isGradientPaint(paint)) return paint.from;
  return "#3B82F6";
}

const shapePathCache = new WeakMap<DesignElement, string>();

export function getShapeLocalPath(el: DesignElement): string {
  const cached = shapePathCache.get(el);
  if (cached !== undefined) return cached;
  const d = buildShapeLocalPath(el);
  shapePathCache.set(el, d);
  return d;
}

function buildShapeLocalPath(el: DesignElement): string {
  if (el.type === "rect" || el.type === "video" || el.type === "html") {
    return rectToPathData({
      ...el,
      type: "rect",
      borderRadius: (el as any).borderRadius
    } as RectElement);
  }
  if (el.type === "ellipse") {
    return ellipseToPathData(el as EllipseElement);
  }
  if (el.type === "polygon") {
    return polygonToPathData(el as PolygonElement);
  }
  if (el.type === "star") {
    return starToPathData(el as StarElement);
  }
  if (el.type === "path") {
    return (el as PathElement).d || "";
  }
  if (isContainer(el)) {
    return rectToPathData({
      ...el,
      type: "rect",
      borderRadius: (el as any).borderRadius
    } as RectElement);
  }
  return "";
}


export function getGradientStops(paint: Paint): GradientStop[] {
  if (!isGradientPaint(paint)) return [];
  const p = paint as any;
  const stops = canonicalGradientStops(p.stops);
  if (stops) return stops;
  return [
    { color: p.from || "#3B82F6", offset: typeof p.fromOffset === "number" ? p.fromOffset : 0 },
    { color: p.to || (paint.type === "linear-gradient" ? "#8B5CF6" : "#1E1E1E"), offset: typeof p.toOffset === "number" ? p.toOffset : 1 }
  ];
}

export { sampleGradientAt } from "./gradient-decomposition";

export interface PaintLayerCss {
  background: string;
  opacity: number;
}

export function paintStackLayers(
  paints: readonly Paint[] | undefined,
  imageUri?: (paint: Paint) => string | undefined,
  box?: { width: number; height: number }
): PaintLayerCss[] {
  const layers: PaintLayerCss[] = [];
  for (const p of paints || []) {
    if (!p || p.enabled === false) continue;
    const explicitAlpha = typeof p.opacity === "number" ? p.opacity : undefined;
    if (p.type === "solid") {
      const parsed = parseColorAlpha(p.color);
      layers.push({
        background: parsed.hex6,
        opacity: explicitAlpha ?? parsed.alphaPct / 100
      });
    } else if (isGradientPaint(p)) {
      layers.push({ background: buildCssGradient(p), opacity: explicitAlpha ?? 1 });
    } else if (p.type === "image") {
      const uri = imageUri?.(p);
      if (uri) layers.push({ background: `url("${uri}") center / cover no-repeat`, opacity: explicitAlpha ?? 1 });
    } else if (p.type === "pattern") {
      layers.push({ background: patternCssBackground(p, box), opacity: explicitAlpha ?? 1 });
    }
  }
  return layers;
}

export function calcRadialGradientCoords(paint: Paint): {
  cx: string;
  cy: string;
  r: string;
  gradientTransform?: string;
} {
  const radial = paint as Extract<Paint, { type: "radial-gradient" }>;
  const pct = (n: number): string => `${Math.round(n * 10000) / 100}%`;
  const num = (n: number): number => Math.round(n * 10000) / 10000;
  const rx = radial.rx ?? radial.radius ?? 0.75;
  const ry = radial.ry ?? radial.radius ?? 0.75;
  const angle = radial.angle ?? 0;
  const base = {
    cx: pct(radial.center?.x ?? 0.5),
    cy: pct(radial.center?.y ?? 0.5)
  };
  if (rx === ry && angle === 0) {
    return { ...base, r: pct(rx) };
  }

  const cx = num(radial.center?.x ?? 0.5);
  const cy = num(radial.center?.y ?? 0.5);
  return {
    ...base,
    r: "50%",
    gradientTransform: `translate(${cx} ${cy}) rotate(${angle}) scale(${num(rx * 2)} ${num(ry * 2)}) translate(-0.5 -0.5)`
  };
}

export function topGradientPaint(
  fills?: readonly Paint[]
): { paint: Paint; index: number } | null {
  if (!fills) return null;
  for (let i = fills.length - 1; i >= 0; i--) {
    const p = fills[i];
    if (p && p.enabled !== false && isGradientPaint(p)) {
      return { paint: p, index: i };
    }
  }
  return null;
}

/**
 * The CSS angle a direction points along.
 *
 * The vector must be in ONE uniform space — px, not box fractions. A fraction
 * pair is the same direction scaled per-axis, and reading its `atan2` returns
 * the angle the gradient had in the normalised box, which on a non-square box
 * is not the angle CSS would draw.
 */
export function linearAngleFromVector(fx: number, fy: number): number {
  const deg = (Math.atan2(fx, -fy) * 180) / Math.PI;
  return (deg + 360) % 360;
}

/**
 * Where the on-canvas lever sits: the gradient line the renderer will paint,
 * in element-local px.
 *
 * Same length as CSS's (`|W·sin| + |H·cos|`), so the handle lands on the corner
 * a 45° gradient actually starts at, and dragging it back through
 * `linearAngleFromVector` returns the angle it was given on any box.
 */
export function linearLeverEndpoints(
  angle: number,
  width: number,
  height: number
): { start: { x: number; y: number }; end: { x: number; y: number } } {
  const rad = (angle * Math.PI) / 180;
  const ux = Math.sin(rad);
  const uy = -Math.cos(rad);
  const half = linearGradientLineLength(width, height, angle) / 2;
  return {
    start: { x: width / 2 - ux * half, y: height / 2 - uy * half },
    end: { x: width / 2 + ux * half, y: height / 2 + uy * half }
  };
}

export function buildGradientBarCss(paint: Paint): string {
  if (!isGradientPaint(paint)) {
    return buildCssGradient(paint);
  }
  const stopStr = [...getGradientStops(paint)]
    .sort((a, b) => a.offset - b.offset)
    .map((s) => `${s.color} ${Math.round(s.offset * 10000) / 100}%`)
    .join(", ");
  return `linear-gradient(90deg, ${stopStr})`;
}

export function buildCssGradient(
  paint: Paint,
  box?: { width: number; height: number }
): string {
  const stops = getGradientStops(paint);
  if (stops.length === 0) return "none";
  const stopStr = [...stops]
    .sort((a, b) => a.offset - b.offset)
    .map((s) => `${s.color} ${Math.round(s.offset * 10000) / 100}%`)
    .join(", ");
  if (paint.type === "linear-gradient") {
    const angle = typeof (paint as any).angle === "number" ? (paint as any).angle : 90;
    return `linear-gradient(${angle}deg, ${stopStr})`;
  }
  if (paint.type === "radial-gradient") {
    const radial = paint as Extract<Paint, { type: "radial-gradient" }>;
    const rx = radial.rx ?? radial.radius ?? 0.75;
    const ry = radial.ry ?? radial.radius ?? 0.75;
    const size = `${Math.round(rx * 10000) / 100}% ${Math.round(ry * 10000) / 100}%`;
    const at = `${Math.round((radial.center?.x ?? 0.5) * 10000) / 100}% ${Math.round(
      (radial.center?.y ?? 0.5) * 10000
    ) / 100}%`;
    return `radial-gradient(${size} at ${at}, ${stopStr})`;
  }
  if (paint.type === "angular-gradient") {
    const ang = paint as Extract<Paint, { type: "angular-gradient" }>;
    const from = typeof ang.angle === "number" ? ang.angle : 0;
    const at = `${Math.round((ang.center?.x ?? 0.5) * 10000) / 100}% ${Math.round(
      (ang.center?.y ?? 0.5) * 10000
    ) / 100}%`;
    return `conic-gradient(from ${Math.round(from * 100) / 100}deg at ${at}, ${stopStr})`;
  }
  if (paint.type === "diamond-gradient") {
    const layers = diamondCssLayers(paint, box?.width ?? 100, box?.height ?? 100);
    if (layers.length === 0) return "none";
    return layers.join(", ");
  }
  return "none";
}

