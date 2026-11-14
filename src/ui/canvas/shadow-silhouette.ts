import { DesignElement, Paint, RectElement } from "../../core/dsl/types";
import { clipsContent, type OverflowFields } from "../../core/dsl/overflow";
import { cornerRadiiXYOf, ellipseToPathData, rectToPathData } from "../../core/geometry/shape-path";
import { parseFloodColor } from "../../core/geometry/color-utils";
import type { InstanceBox } from "../../core/interactions/instance-inherit";


export interface SilhouetteImage {
  uri: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Half of the element's own stroke that lands OUTSIDE its shape. */
function outerStrokeHalf(el: DesignElement, box?: InstanceBox | null): number | null {
  const strokes = box ? box.strokes : (el as any).strokes || [];
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
export function hasBackdropSurface(el: DesignElement, box?: InstanceBox | null): boolean {
  const effects = box ? box.effects : el.effects ?? [];
  return effects.some(
    (ef) => ef && ef.enabled !== false && (ef.type === "liquid-glass" || ef.type === "backdrop-blur")
  );
}

/** Whether the element's active fills are all non-normal blend-mode layers (e.g. iOS glass tint plates). */
export function hasBlendOnlyFills(el: DesignElement, box?: InstanceBox | null): boolean {
  if (box ? !box.fillsActive : el.fillEnabled === false) return false;
  const fills = box ? box.fills : el.fills ?? [];
  const active = fills.filter((f) => f && f.enabled !== false);
  return active.length > 0 && active.every((f) => Boolean(f.blendMode && f.blendMode !== "normal"));
}

/** Whether the element paints its interior at all. */
export function hasOwnInteriorFills(el: DesignElement, box?: InstanceBox | null): boolean {
  if (box) return box.fillsActive && box.fills.some((f) => f && f.enabled !== false);
  if (el.fillEnabled === false) return false;
  if ((el as any).fillStyleId) return false;
  return (el.fills ?? []).some((f) => f && f.enabled !== false);
}

function paintsInterior(el: DesignElement, box?: InstanceBox | null): boolean {
  if (hasBackdropSurface(el, box)) return true;
  return hasOwnInteriorFills(el, box);
}

/**
 * Whether the element's own paint is opaque wherever it covers.
 *
 * A drop shadow's strength comes from `SourceAlpha`, so a translucent fill casts
 * a proportionally weaker shadow. Geometry cannot carry that profile, so those
 * elements keep the alpha-based chain — otherwise every glass panel in the
 * document would suddenly cast a solid shadow.
 */
function paintsOpaque(el: DesignElement, box?: InstanceBox | null): boolean {
  const rawFills = box ? (box.fillsActive ? box.fills : []) : el.fills ?? [];
  const fills = rawFills.filter((f) => f && f.enabled !== false);
  if (fills.length === 0) return false;
  for (const f of fills) {
    if (f.type !== "solid") return false;
    if (f.blendMode && f.blendMode !== "normal") return false;
    if (parseFloodColor((f as { color: string }).color).floodOpacity * ((f as Paint).opacity ?? 1) < 1) return false;
  }
  const strokes = box ? box.strokes : (el as any).strokes || [];
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
function containerBox(el: DesignElement, box?: InstanceBox | null): RectElement | null {
  if (el.type === "instance") {
    if (!box) return null;
    if (!clipsContent(box as OverflowFields)) return null;
    if (!paintsInterior(el, box)) return null;
    if (!(box.width > 0) || !(box.height > 0)) return null;
    return {
      width: box.width,
      height: box.height,
      borderRadius: box.borderRadius,
      cornerSmoothing: box.cornerSmoothing,
      sizing: box.borderRadiusY !== undefined ? { borderRadiusY: box.borderRadiusY } : undefined
    } as RectElement;
  }
  const type = el.type;
  if (type !== "frame" && type !== "component" && type !== "componentSet") return null;
  if (!clipsContent(el as OverflowFields)) return null;
  if (!paintsInterior(el)) return null;
  if (!(el.width > 0) || !(el.height > 0)) return null;
  return { ...el, type: "rect", borderRadius: (el as any).borderRadius } as RectElement;
}

/** The element's outline in its own local space, or null when it has none we know. */
function outlineOf(el: DesignElement, box?: InstanceBox | null): string | null {
  if (el.type === "rect") return rectToPathData(el as RectElement) || null;
  if (el.type === "ellipse") return ellipseToPathData(el as any) || null;
  const container = containerBox(el, box);
  return container ? rectToPathData(container) || null : null;
}

/** That outline moved in or out by `shift`, exactly. Rect, full ellipse, box. */
function inflatedOutline(el: DesignElement, shift: number, box?: InstanceBox | null): string | null {
  const rectBox = el.type === "rect" ? (el as RectElement) : el.type === "ellipse" ? null : containerBox(el, box);
  if (rectBox) {
    const width = rectBox.width + shift * 2;
    const height = rectBox.height + shift * 2;
    if (!(width > 0) || !(height > 0)) return "";
    const [[tlX, trX, brX, blX], [tlY, trY, brY, blY]] = cornerRadiiXYOf(
      rectBox.borderRadius,
      rectBox.sizing?.borderRadiusY,
      rectBox.width,
      rectBox.height
    );
    return rectToPathData({
      ...rectBox,
      width,
      height,
      borderRadius: [
        Math.max(0, tlX + shift),
        Math.max(0, trX + shift),
        Math.max(0, brX + shift),
        Math.max(0, blX + shift)
      ],
      sizing:
        rectBox.sizing?.borderRadiusY !== undefined
          ? {
            ...rectBox.sizing,
            borderRadiusY: [
              Math.max(0, tlY + shift),
              Math.max(0, trY + shift),
              Math.max(0, brY + shift),
              Math.max(0, blY + shift)
            ]
          }
          : rectBox.sizing
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
  origin: { x: number; y: number },
  box?: InstanceBox | null
): SilhouetteImage | null {
  if (el.visible === false) return null;
  const half = outerStrokeHalf(el, box);
  if (half === null) return null;
  const interior = paintsInterior(el, box);
  if (!interior && !(half > 0)) return null;
  if (requireOpaque && !paintsOpaque(el, box)) return null;

  const reach = half + outlineShift;
  let body: string;
  if (reach > 0) {
    const d = outlineOf(el, box);
    if (!d) return null;
    body = `<path d="${d}" fill="${interior ? "#000000" : "none"}" stroke="#000000" stroke-width="${reach * 2
      }" stroke-linejoin="round" stroke-linecap="round"/>`;
  } else if (interior) {
    const d = inflatedOutline(el, outlineShift, box);
    if (d === null) return null;
    body = d === "" ? "" : `<path d="${d}" fill="#000000"/>`;
  } else {
    // A stroke-only element: the band thins but its centre line does not move.
    const d = outlineOf(el, box);
    if (!d) return null;
    body =
      reach === 0
        ? ""
        : `<path d="${d}" fill="none" stroke="#000000" stroke-width="${-reach * 2}" stroke-linejoin="round" stroke-linecap="round"/>`;
  }

  const placed = { x: origin.x + region.x, y: origin.y + region.y, width: region.width, height: region.height };
  return { uri: dataUri(region, body), ...placed };
}
