/**
 * Multi-selection geometry: unions that respect node rotation.
 *
 * A union box must enclose every selected element after each one's rotation is
 * applied. We compute it from the transformed corners of each node's bounds, so
 * the marquee/overlay always fully covers rotated elements.
 */

import type { Matrix2D } from './matrix';
import { transformPoint } from './matrix';
import type { Point } from './matrix';
import type { Rect } from './bounds';

export interface TransformedNodeBounds {
  bounds: Rect;
  worldTransform: Matrix2D;
}

/** The four world-space corners of a node (rotation applied). */
export function getNodeWorldCorners(node: TransformedNodeBounds): Point[] {
  const { x, y, width: w, height: h } = node.bounds;
  const corners: Point[] = [
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + h },
    { x, y: y + h }
  ];
  return corners.map((p) => transformPoint(node.worldTransform, p));
}
