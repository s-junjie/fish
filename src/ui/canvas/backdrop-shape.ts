import type { JSX } from "preact";
import type { CornerRadius, DesignElement } from "../../core/dsl/types";
import { effectiveCornerSmoothing, formatCssCornerRadius } from "../../core/geometry/shape-path";
import { isContainer } from "../../core/geometry/tree-ops";

/**
 * The shape clip for a backdrop-filter `<div>` inside a `foreignObject`.
 *
 * Under an ancestor SVG `clip-path` (any frame whose `overflow` clips), Chromium's
 * backdrop-filter compositor reduces every clip on the backdrop — CSS
 * `clip-path: path()`, `ellipse()`, or an SVG `clipPath` wrapper — to its
 * bounding box, painting the frosted backdrop as a dark rectangle around a
 * curved shape. `border-radius` is the one clip it keeps, so every shape that
 * can be spelled as one (ellipses, rects without corner smoothing) uses it, and
 * only the rest fall back to `clip-path: path()`.
 */
export function backdropShapeStyle(
  el: DesignElement,
  width: number,
  height: number,
  pathD: string,
  borderRadius?: CornerRadius,
  cornerSmoothing?: number,
  borderRadiusY?: CornerRadius
): JSX.CSSProperties {
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  if (el.type === "ellipse") {
    const e = el as { sweep?: number; innerRadius?: number; gap?: number };
    if ((e.sweep ?? 360) >= 360 && !e.innerRadius && !e.gap) return { borderRadius: "50%" };
  }
  if (el.type === "rect" || el.type === "instance" || isContainer(el)) {
    const radius = borderRadius ?? (el as { borderRadius?: CornerRadius }).borderRadius;
    const radiusY = borderRadiusY ?? (el.sizing?.borderRadiusY as CornerRadius | undefined);
    const smoothing = cornerSmoothing ?? (el as { cornerSmoothing?: number }).cornerSmoothing;
    if (radiusY !== undefined || effectiveCornerSmoothing(smoothing, radius, w, h) <= 0) {
      return { borderRadius: formatCssCornerRadius(radius, radiusY, w, h) };
    }
  }
  const d = pathD || `M0,0 H${w} V${h} H0 Z`;
  return { clipPath: `path('${d}')` };
}
