import type { DesignElement, Paint } from "../../core/dsl/types";
import { linearLeverEndpoints } from "../../core/geometry/gradient-utils";

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
const rad = (deg: number) => (deg * Math.PI) / 180;

export interface StopAxisGeometry {
  /** Where the stop at `t` sits, in the overlay's coordinate space. */
  pointAt(t: number): { x: number; y: number };
  /** The stop offset a point corresponds to — the inverse of `pointAt`. */
  paramAt(point: { x: number; y: number }): number;
}

/**
 * Where a gradient's stops live on the canvas, per dialect.
 *
 * Every kind has ONE drawing axis its stops run along — the line, the first
 * radius, or the sweep circle — and the lever already draws that axis. Deriving
 * the positions here, once, is what lets a marker sit exactly where the paint
 * changes colour and lets a pointer be read back to the same number: two copies
 * of this geometry would drift, and the drift is invisible until a marker stops
 * tracking the pointer.
 *
 * All four are linear in PX between their two ends, which is why the inverse is
 * a projection (or, for the sweep, an angle) rather than an interpolation of
 * fractions: a radial's ellipse is defined in box fractions, but its rim is
 * drawn in px, and the marker has to sit on what is drawn.
 */
export function stopAxisOf(
  el: DesignElement,
  paint: Paint,
  origin: { x: number; y: number }
): StopAxisGeometry | null {
  const linearLike = (a: { x: number; y: number }, b: { x: number; y: number }): StopAxisGeometry => {
    const vx = b.x - a.x;
    const vy = b.y - a.y;
    const len2 = vx * vx + vy * vy;
    return {
      pointAt: (t) => ({ x: a.x + vx * t, y: a.y + vy * t }),
      paramAt: (point) =>
        len2 === 0 ? 0 : clamp01(((point.x - a.x) * vx + (point.y - a.y) * vy) / len2)
    };
  };

  if (paint.type === "linear-gradient") {
    const lever = linearLeverEndpoints(paint.angle ?? 90, el.width, el.height);
    const start = paint.start ?? { x: lever.start.x / el.width, y: lever.start.y / el.height };
    const end = paint.end ?? { x: lever.end.x / el.width, y: lever.end.y / el.height };
    return linearLike(
      { x: origin.x + start.x * el.width, y: origin.y + start.y * el.height },
      { x: origin.x + end.x * el.width, y: origin.y + end.y * el.height }
    );
  }

  const gradient =
    paint.type === "radial-gradient" || paint.type === "diamond-gradient" || paint.type === "angular-gradient"
      ? paint
      : null;
  if (!gradient) return null;

  const center = gradient.center ?? { x: 0.5, y: 0.5 };
  const cx = origin.x + center.x * el.width;
  const cy = origin.y + center.y * el.height;

  if (gradient.type === "radial-gradient") {
    const rx = gradient.rx ?? gradient.radius ?? 0.75;
    const ry = gradient.ry ?? gradient.radius ?? 0.75;
    const ang = rad(gradient.angle ?? 0);
    return linearLike(
      { x: cx, y: cy },
      { x: cx + rx * Math.cos(ang) * el.width, y: cy + ry * Math.sin(ang) * el.height }
    );
  }

  if (gradient.type === "diamond-gradient") {
    const ax = (gradient.rx ?? gradient.radius ?? 0.75) * el.width;
    const ang = rad(gradient.angle ?? 0);
    return linearLike({ x: cx, y: cy }, { x: cx + ax * Math.cos(ang), y: cy + ax * Math.sin(ang) });
  }

  // Angular: the sweep is a true circle in px, and offset 0 is where the turn
  // starts (`dirFromTop`). Its stops wrap, so t = 1 and t = 0 are one point.
  const radius = Math.min(el.width, el.height) / 2;
  const start = gradient.angle ?? 0;
  return {
    pointAt: (t) => {
      const θ = rad(start + t * 360);
      return { x: cx + radius * Math.sin(θ), y: cy - radius * Math.cos(θ) };
    },
    paramAt: (point) => {
      const deg = ((Math.atan2(point.x - cx, -(point.y - cy)) * 180) / Math.PI + 360) % 360;
      return (((deg - start) % 360) + 360) % 360 / 360;
    }
  };
}
