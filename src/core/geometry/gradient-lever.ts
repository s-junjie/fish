export interface LeverPoint {
  x: number;
  y: number;
}

export interface LeverBox {
  width: number;
  height: number;
}

/** The increment a Shift-held angle lands on. */
export const GRADIENT_ANGLE_STEP = 15;

const round4 = (n: number) => Math.round(n * 10000) / 10000;

/**
 * The CSS angle turned to the nearest step: 0° points up, growing clockwise.
 *
 * Only the ANGLE snaps, never the length — a user holding Shift is aiming the
 * axis, and quietly shortening it would be a second edit they did not ask for.
 */
export function snapGradientAngle(angle: number, step: number = GRADIENT_ANGLE_STEP): number {
  const turned = Math.round((((angle % 360) + 360) % 360) / step) * step;
  return ((turned % 360) + 360) % 360;
}

/**
 * The endpoint that keeps the axis' length but lands on a snapped angle.
 *
 * The two ends live in box FRACTIONS, so the vector has to be read in px before
 * an angle means anything: a fraction delta measures the normalised unit square,
 * and on a 200×100 box that is not the angle the renderer paints.
 */
export function snapEndpointAngle(
  start: LeverPoint,
  end: LeverPoint,
  box: LeverBox,
  step: number = GRADIENT_ANGLE_STEP
): LeverPoint {
  const dx = (end.x - start.x) * box.width;
  const dy = (end.y - start.y) * box.height;
  const length = Math.hypot(dx, dy);
  if (length === 0) return end;
  const angle = ((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360;
  const rad = (snapGradientAngle(angle, step) * Math.PI) / 180;
  return {
    x: round4(start.x + (Math.sin(rad) * length) / box.width),
    y: round4(start.y - (Math.cos(rad) * length) / box.height)
  };
}

/** The opposite end, held symmetric about the axis midpoint the drag began at. */
export function mirrorEndpoint(mid: LeverPoint, end: LeverPoint): LeverPoint {
  return { x: round4(mid.x * 2 - end.x), y: round4(mid.y * 2 - end.y) };
}
