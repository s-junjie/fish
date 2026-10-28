import { RectElement, EllipseElement, PolygonElement, StarElement } from "../dsl/types";
import { closedOutlineToPathData, OutlinePoint } from "./corner-smoothing";

/** A closed ring of corners, rounded — the shared entry for every generated outline. */
const roundedRectOutline = (verts: OutlinePoint[], radius: number, smoothing: number): string =>
  closedOutlineToPathData(verts, radius, smoothing);

const round2 = (n: number): number => Math.round(n * 100) / 100;
export function cornerRadiiOf(radius: number | [number, number, number, number] | undefined, w: number, h: number): [number, number, number, number] {
  const raw = Array.isArray(radius) ? radius : [radius, radius, radius, radius];
  const max = Math.min(w, h) / 2;
  return raw.map((r) => Math.min(Math.max(0, r ?? 0), max)) as [number, number, number, number];
}

export function effectiveCornerSmoothing(
  smoothing: number | undefined,
  radius: number | [number, number, number, number] | undefined,
  w: number,
  h: number
): number {
  const s = Math.min(1, Math.max(0, smoothing ?? 0));
  if (s <= 0 || !(w > 0) || !(h > 0)) return 0;
  const [tl, tr, br, bl] = cornerRadiiOf(radius, w, h);
  const maxR = tl === tr && tr === br && br === bl ? tl : Math.max(tl, tr, br, bl);
  if (!(maxR > 0)) return 0;
  const budget = Math.min(w, h) / 2;
  const maxSmoothing = Math.max(0, budget / maxR - 1);
  return Math.min(s, maxSmoothing);
}

/** Rect outline as clockwise path data in the element's local box. */
export function rectToPathData(el: RectElement): string {
  const w = el.width;
  const h = el.height;
  if (!(w > 0) || !(h > 0)) return "";
  const [tl, tr, br, bl] = cornerRadiiOf(el.borderRadius, w, h);
  if (tl === 0 && tr === 0 && br === 0 && bl === 0) {
    return `M 0 0 H ${round2(w)} V ${round2(h)} H 0 Z`;
  }
  // Smoothing replaces the circular arc with a fuller curve. At 0 it stays an
  // `A`, so every document written before this field existed still emits the
  // exact bytes it always did — a rounding change nobody asked for.
  // When a corner's radius consumes the side (e.g. pill/stadium shapes where
  // r >= min(w, h) / 2), Figma leaves no straight-edge transition zone and
  // smoothing drops to 0, preserving circular pill ends.
  const smoothing = effectiveCornerSmoothing(el.cornerSmoothing, el.borderRadius, w, h);
  if (smoothing > 0.001) {
    return roundedRectOutline(
      [
        { x: 0, y: 0 },
        { x: w, y: 0 },
        { x: w, y: h },
        { x: 0, y: h }
      ],
      // The outline builder rounds every corner by ONE radius, and FISH allows
      // four independent ones, so a smoothed rect with mixed radii cannot go
      // through it. Uniform is the overwhelmingly common case and the only one
      // Figma's shape-wide smoothing is defined for.
      tl === tr && tr === br && br === bl ? tl : Math.max(tl, tr, br, bl),
      smoothing
    );
  }
  // Degenerate radii render as straight lines per the SVG arc spec (r=0).
  return (
    `M ${round2(tl)} 0 ` +
    `H ${round2(w - tr)} A ${round2(tr)} ${round2(tr)} 0 0 1 ${round2(w)} ${round2(tr)} ` +
    `V ${round2(h - br)} A ${round2(br)} ${round2(br)} 0 0 1 ${round2(w - br)} ${round2(h)} ` +
    `H ${round2(bl)} A ${round2(bl)} ${round2(bl)} 0 0 1 0 ${round2(h - bl)} ` +
    `V ${round2(tl)} A ${round2(tl)} ${round2(tl)} 0 0 1 ${round2(tl)} 0 Z`
  );
}
// Inspector edits mutate the live doc without passing through normalize, so the
// renderer clamps these itself instead of trusting the stored value.
const clampSweep = (v: unknown): number => {
  const n = typeof v === "number" && Number.isFinite(v) ? v : 360;
  return Math.min(360, Math.max(0, n));
};

const clampInnerRadius = (v: unknown): number => {
  const n = typeof v === "number" && Number.isFinite(v) ? v : 0;
  return Math.min(0.99, Math.max(0, n));
};

const clampAngle = (v: unknown): number => {
  const n = typeof v === "number" && Number.isFinite(v) ? v : 0;
  return Math.min(360, Math.max(0, n));
};

const clampGap = (v: unknown): number => {
  const n = typeof v === "number" && Number.isFinite(v) ? v : 0;
  return Math.min(180, Math.max(0, n));
};

/** Point on the ellipse at eccentric angle `deg`, clockwise from top centre. */
const ellipseArcPoint = (rx: number, ry: number, scale: number, deg: number) => {
  const t = (deg * Math.PI) / 180;
  return { x: rx + rx * scale * Math.sin(t), y: ry - ry * scale * Math.cos(t) };
};

/**
 * Ellipse outline. A full turn is emitted as two half arcs because an arc whose
 * start and end coincide is dropped by the SVG spec. A partial sweep is closed
 * (wedge to the centre, or a ring when `innerRadius` is set), so fills and
 * strokes both describe the same silhouette. `gap` trims both ends of the sweep,
 * which is what lets stacked ellipses show a seam between segments.
 */
export function ellipseToPathData(el: EllipseElement): string {
  const rx = el.width / 2;
  const ry = el.height / 2;
  if (!(rx > 0) || !(ry > 0)) return "";

  const gap = clampGap(el.gap);
  const start = clampAngle(el.startAngle) + gap / 2;
  const span = clampSweep(el.sweep) - gap;
  const inner = clampInnerRadius(el.innerRadius);
  if (span <= 0) return "";

  if (span >= 360 && inner <= 0) {
    return `M ${round2(rx)} 0 A ${round2(rx)} ${round2(ry)} 0 1 1 ${round2(rx)} ${round2(ry * 2)} A ${round2(rx)} ${round2(ry)} 0 1 1 ${round2(rx)} 0 Z`;
  }

  const largeArc = span > 180 ? 1 : 0;
  const irx = rx * inner;
  const iry = ry * inner;
  const outerStart = ellipseArcPoint(rx, ry, 1, start);

  if (inner <= 0) {
    const end = ellipseArcPoint(rx, ry, 1, start + span);
    return `M ${round2(outerStart.x)} ${round2(outerStart.y)} A ${round2(rx)} ${round2(ry)} 0 ${largeArc} 1 ${round2(end.x)} ${round2(end.y)} L ${round2(rx)} ${round2(ry)} Z`;
  }

  if (span >= 360) {
    // The inner loop runs counter-clockwise so the default nonzero fill-rule
    // carves the hole instead of filling it.
    return [
      `M ${round2(rx)} 0`,
      `A ${round2(rx)} ${round2(ry)} 0 1 1 ${round2(rx)} ${round2(ry * 2)}`,
      `A ${round2(rx)} ${round2(ry)} 0 1 1 ${round2(rx)} 0`,
      `M ${round2(rx + irx)} ${round2(ry)}`,
      `A ${round2(irx)} ${round2(iry)} 0 1 0 ${round2(rx - irx)} ${round2(ry)}`,
      `A ${round2(irx)} ${round2(iry)} 0 1 0 ${round2(rx + irx)} ${round2(ry)}`,
      "Z"
    ].join(" ");
  }

  const outerEnd = ellipseArcPoint(rx, ry, 1, start + span);
  const innerEnd = ellipseArcPoint(rx, ry, inner, start + span);
  const innerStart = ellipseArcPoint(rx, ry, inner, start);
  return [
    `M ${round2(outerStart.x)} ${round2(outerStart.y)}`,
    `A ${round2(rx)} ${round2(ry)} 0 ${largeArc} 1 ${round2(outerEnd.x)} ${round2(outerEnd.y)}`,
    `L ${round2(innerEnd.x)} ${round2(innerEnd.y)}`,
    `A ${round2(irx)} ${round2(iry)} 0 ${largeArc} 0 ${round2(innerStart.x)} ${round2(innerStart.y)}`,
    "Z"
  ].join(" ");
}

/**
 * Regular polygon inscribed in the local box, first vertex at top center.
 *
 * `cornerRadius` and `cornerSmoothing` are Figma's two corner controls, read
 * here off the shared outline builder rather than reimplemented.
 */
export function polygonToPathData(el: PolygonElement): string {
  const sides = Math.min(24, Math.max(3, Math.round(el.sides ?? 5)));
  const rx = el.width / 2;
  const ry = el.height / 2;
  if (!(rx > 0) || !(ry > 0)) return "";
  const verts: OutlinePoint[] = [];
  for (let i = 0; i < sides; i++) {
    const angle = -Math.PI / 2 + (2 * Math.PI * i) / sides;
    verts.push({ x: rx + rx * Math.cos(angle), y: ry + ry * Math.sin(angle) });
  }
  return closedOutlineToPathData(verts, el.cornerRadius ?? 0, el.cornerSmoothing ?? 0);
}

/**
 * Regular star inscribed in the local box, first point at top center. Alternating
 * vertices step between the outer radius and `innerRadius`, so `points` spikes
 * cost `points * 2` vertices.
 */
export function starToPathData(el: StarElement): string {
  const points = Math.min(24, Math.max(3, Math.round(el.points ?? 5)));
  const inner = Math.min(0.99, Math.max(0, el.innerRadius ?? 0.382));
  const smoothing = Math.min(1, Math.max(0, el.cornerSmoothing ?? 0));

  const rx = el.width / 2;
  const ry = el.height / 2;
  if (!(rx > 0) || !(ry > 0)) return "";
  const verts: OutlinePoint[] = [];
  for (let i = 0; i < points * 2; i++) {
    const radius = i % 2 === 0 ? 1 : inner;
    const angle = -Math.PI / 2 + (Math.PI * i) / points;
    verts.push({ x: rx + rx * radius * Math.cos(angle), y: ry + ry * radius * Math.sin(angle) });
  }
  return closedOutlineToPathData(verts, el.cornerRadius ?? 0, smoothing);
}
