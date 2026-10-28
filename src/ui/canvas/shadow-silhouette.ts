import { DesignElement, Paint, RectElement } from "../../core/dsl/types";
import { cornerRadiiOf, ellipseToPathData, rectToPathData } from "../../core/geometry/shape-path";
import { parseFloodColor } from "../../core/geometry/color-utils";

/**
 * A shadow's silhouette as GEOMETRY, for the elements whose outline is known.
 *
 * `spread` used to be spelled entirely with `feMorphology`, and that primitive
 * has two problems the geometry does not: Chromium clamps one primitive's radius
 * at 256 DEVICE pixels (`CanvasDefs`), and it costs O(radius) per pixel over the
 * whole filter region — measured 2.4 s for one frame of a 231x88 pill at 1000 %
 * zoom, against 33 ms for the same chain with the primitive removed. Its kernel
 * is also a SQUARE, so a rounded shape's spread came out with square corners
 * where CSS and Figma round them off.
 *
 * The silhouette rides an `feImage` because a filter cannot reference geometry
 * in the document (`href="#id"` paints nothing in Chromium), and because that
 * image is rasterised at the DEVICE resolution — it stays crisp at any zoom.
 * Dilation is exact as `fill + stroke` with round joins: the union of discs
 * along the outline IS the Minkowski sum, so this is a true rounded spread, and
 * it holds for every path FISH draws, corner smoothing included. Erosion has no
 * such spelling, so it is exact only for a rect, a full ellipse, or a clipped
 * container's box, and null everywhere else — the caller falls back.
 *
 * Null is always safe: the caller keeps the chain it has always emitted.
 */
export interface SilhouetteImage {
  /** `data:` URI of an SVG carrying the silhouette, in the element's local space. */
  uri: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Half of the element's own stroke that lands OUTSIDE its shape. */
function outerStrokeHalf(el: DesignElement): number | null {
  const strokes = (el as any).strokes || [];
  let half = 0;
  for (const s of strokes) {
    if (!s || s.enabled === false) continue;
    const width = Number(s.width) || 0;
    if (!(width > 0)) continue;
    // Per-side widths have no single outline to offset.
    if (s.side === "custom") return null;
    const align = s.align ?? "center";
    half = Math.max(half, align === "outside" ? width : align === "center" ? width / 2 : 0);
  }
  return half;
}

/** Whether the element carries a backdrop surface (`liquid-glass` or `backdrop-blur`). */
export function hasBackdropSurface(el: DesignElement): boolean {
  return (el.effects ?? []).some(
    (ef) => ef && ef.enabled !== false && (ef.type === "liquid-glass" || ef.type === "backdrop-blur")
  );
}

/** Whether the element's active fills are all non-normal blend-mode layers (e.g. iOS glass tint plates). */
export function hasBlendOnlyFills(el: DesignElement): boolean {
  if (el.fillEnabled === false) return false;
  const active = (el.fills ?? []).filter((f) => f && f.enabled !== false);
  return active.length > 0 && active.every((f) => Boolean(f.blendMode && f.blendMode !== "normal"));
}

/** Whether the element paints its interior at all. */
export function hasOwnInteriorFills(el: DesignElement): boolean {
  if (el.fillEnabled === false) return false;
  if ((el as any).fillStyleId) return false;
  return (el.fills ?? []).some((f) => f && f.enabled !== false);
}

function paintsInterior(el: DesignElement): boolean {
  if (hasBackdropSurface(el)) return true;
  return hasOwnInteriorFills(el);
}

/**
 * Whether the element's own paint is opaque wherever it covers.
 *
 * A drop shadow's strength comes from `SourceAlpha`, so a translucent fill casts
 * a proportionally weaker shadow. Geometry cannot carry that profile, so those
 * elements keep the alpha-based chain — otherwise every glass panel in the
 * document would suddenly cast a solid shadow.
 */
function paintsOpaque(el: DesignElement): boolean {
  const fills = (el.fills ?? []).filter((f) => f && f.enabled !== false);
  if (fills.length === 0) return false;
  for (const f of fills) {
    if (f.type !== "solid") return false;
    if (f.blendMode && f.blendMode !== "normal") return false;
    if (parseFloodColor((f as { color: string }).color).floodOpacity * ((f as Paint).opacity ?? 1) < 1) return false;
  }
  const strokes = (el as any).strokes || [];
  for (const s of strokes) {
    if (!s || s.enabled === false || !(Number(s.width) > 0)) continue;
    const paint = s.paint ?? s;
    if (paint.type && paint.type !== "solid") return false;
    if (parseFloodColor(paint.color ?? "#000000").floodOpacity * (s.opacity ?? 1) < 1) return false;
  }
  return true;
}

/**
 * A container's own shape is its box — and only a clipped, filled one IS the
 * whole silhouette, because its children are clipped to that box and its fill
 * covers it. An unclipped frame paints the union of its children, which is not
 * an outline this module knows.
 */
function containerBox(el: DesignElement): RectElement | null {
  const type = el.type;
  if (type !== "frame" && type !== "component" && type !== "componentSet") return null;
  if (!(el as { clipContent?: boolean }).clipContent) return null;
  if (!paintsInterior(el)) return null;
  if (!(el.width > 0) || !(el.height > 0)) return null;
  return { ...el, type: "rect", borderRadius: (el as any).borderRadius } as RectElement;
}

/** The element's outline in its own local space, or null when it has none we know. */
function outlineOf(el: DesignElement): string | null {
  if (el.type === "rect") return rectToPathData(el as RectElement) || null;
  if (el.type === "ellipse") return ellipseToPathData(el as any) || null;
  const box = containerBox(el);
  return box ? rectToPathData(box) || null : null;
}

/** That outline moved in or out by `shift`, exactly. Rect, full ellipse, box. */
function inflatedOutline(el: DesignElement, shift: number): string | null {
  const box = el.type === "rect" ? (el as RectElement) : el.type === "ellipse" ? null : containerBox(el);
  if (box) {
    const width = box.width + shift * 2;
    const height = box.height + shift * 2;
    if (!(width > 0) || !(height > 0)) return "";
    const [tl, tr, br, bl] = cornerRadiiOf(box.borderRadius, box.width, box.height);
    return rectToPathData({
      ...box,
      width,
      height,
      borderRadius: [tl + shift, tr + shift, br + shift, bl + shift]
    });
  }
  if (el.type !== "ellipse") return null;
  const ellipse = el as any;
  if ((ellipse.sweep ?? 360) < 360 || ellipse.innerRadius > 0) return null;
  const width = ellipse.width + shift * 2;
  const height = ellipse.height + shift * 2;
  if (!(width > 0) || !(height > 0)) return "";
  return ellipseToPathData({ ...ellipse, width, height });
}

function dataUri(box: { x: number; y: number; width: number; height: number }, body: string): string {
  const round = (n: number) => Math.round(n * 100) / 100;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${round(box.width)}" height="${round(box.height)}"` +
    ` viewBox="${round(box.x)} ${round(box.y)} ${round(box.width)} ${round(box.height)}">${body}</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/**
 * The silhouette moved in or out by `outlineShift`, in the element's local
 * units — how far the OUTLINE itself moves, before the element's own stroke is
 * added. `requireOpaque` is the drop-shadow case — see `paintsOpaque`.
 *
 * `region` is the filter's rectangle in LOCAL units (origin at the element's
 * box) and `origin` is where that box sits in the filter's own user space: the
 * renderer puts the element's translate on a child `<g>`, so the filter — which
 * is on the parent — works in the space the element's x/y are expressed in. The
 * image is built to BE the placed region, because Chromium scales an `feImage`
 * to fit the filter region whatever x/y/width/height say: a silhouette only
 * lands 1:1 when the two are the same rectangle.
 */
export function shadowSilhouette(
  el: DesignElement,
  outlineShift: number,
  requireOpaque: boolean,
  region: { x: number; y: number; width: number; height: number },
  origin: { x: number; y: number }
): SilhouetteImage | null {
  if (el.visible === false) return null;
  const half = outerStrokeHalf(el);
  if (half === null) return null;
  const interior = paintsInterior(el);
  if (!interior && !(half > 0)) return null;
  if (requireOpaque && !paintsOpaque(el)) return null;

  const reach = half + outlineShift;
  let body: string;
  if (reach > 0) {
    const d = outlineOf(el);
    if (!d) return null;
    body = `<path d="${d}" fill="${interior ? "#000000" : "none"}" stroke="#000000" stroke-width="${
      reach * 2
    }" stroke-linejoin="round" stroke-linecap="round"/>`;
  } else if (interior) {
    const d = inflatedOutline(el, outlineShift);
    if (d === null) return null;
    body = d === "" ? "" : `<path d="${d}" fill="#000000"/>`;
  } else {
    // A stroke-only element: the band thins but its centre line does not move.
    const d = outlineOf(el);
    if (!d) return null;
    body =
      reach === 0
        ? ""
        : `<path d="${d}" fill="none" stroke="#000000" stroke-width="${-reach * 2}" stroke-linejoin="round" stroke-linecap="round"/>`;
  }

  const placed = { x: origin.x + region.x, y: origin.y + region.y, width: region.width, height: region.height };
  return { uri: dataUri(region, body), ...placed };
}
