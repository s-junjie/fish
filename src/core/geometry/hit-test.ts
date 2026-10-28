/**
 * Low-level shape hit-testing that honors node transform matrices.
 *
 * Strategy: map a *world* point into *local* node space via the node's inverse
 * world matrix and run the cheap, axis-aligned shape predicates there. This
 * keeps every shape test simple and exact for rotated elements.
 */

import type { Matrix2D } from './matrix';
import { transformPoint } from './matrix';
import type { Point } from './matrix';

/** Squared distance from `point` to the segment between `a` and `b`. */
export function distanceSquaredToSegment(point: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) {
    const ox = point.x - a.x;
    const oy = point.y - a.y;
    return ox * ox + oy * oy;
  }
  let t = ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSq;
  t = Math.max(0, Math.min(1, t));
  const ox = point.x - (a.x + t * dx);
  const oy = point.y - (a.y + t * dy);
  return ox * ox + oy * oy;
}

/** Line test with a stroke-width tolerance; honors rotation while rotating. */
export function pointOnLine(point: Point, a: Point, b: Point, worldMatrix: Matrix2D | null, tolerance = 8): boolean {
  const localA = worldMatrix ? transformPoint(worldMatrix, a) : a;
  const localB = worldMatrix ? transformPoint(worldMatrix, b) : b;
  return distanceSquaredToSegment(point, localA, localB) <= tolerance * tolerance;
}
