/**
 * Rectangle & bounding-box math built on top of the affine matrix module.
 *
 * These helpers work in world/absolute coordinates. The renderer uses them for
 * multi-selection unions and the hit-tester uses them to compute rotated AABBs.
 */

import type { Matrix2D, Point } from './matrix';
import { transformPoint } from './matrix';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Bounds extends Rect {}

/** The four corners of a rectangle in document orientation. */
export function getRectCorners(rect: Rect): Point[] {
  const { x, y, width: w, height: h } = rect;
  return [
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + h },
    { x, y: y + h }
  ];
}

/** The four corners after applying a matrix — useful for rotated bounds. */
export function getTransformedCorners(rect: Rect, m: Matrix2D): Point[] {
  return getRectCorners(rect).map((p) => transformPoint(m, p));
}

/** Axis-aligned bounding box that encloses the given points. */
export function boundingBoxOfPoints(points: Point[]): Rect | null {
  if (points.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** Axis-aligned bounding box of a rectangle after a matrix transform. */
export function transformBoundsToAABB(rect: Rect, m: Matrix2D): Rect | null {
  return boundingBoxOfPoints(getTransformedCorners(rect, m));
}
