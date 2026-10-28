import { DesignElement } from "../dsl/types";
import {
  isLineElement,
  LineElementLike,
  elementAABB,
  placeChildAt
} from "../geometry/element-bounds";

/**
 * Line/arrow edit operations. Every helper that changes a line's box keeps the
 * two endpoints in sync: `(x, y)` is the start, `(x + dx, y + dy)` the end,
 * and `width` / `height` are `|dx|` / `|dy|`. Moving x without adjusting the
 * derived absolute end, or resizing the box without the delta span, detaches
 * the drawn line from its selection box.
 */
export { isLineElement, elementAABB, placeChildAt };
export type { LineElementLike };

/** Absolute move: line/arrow start endpoint travels to (x, y); dx/dy unchanged. Container moves preserve child local coordinates. */
export function moveElementTo(el: DesignElement, x: number, y: number): DesignElement {
  return { ...el, x, y };
}

export function translateElement(el: DesignElement, ddx: number, ddy: number): DesignElement {
  return { ...el, x: el.x + ddx, y: el.y + ddy };
}

/** Move exactly one endpoint; the opposite endpoint and the box span follow. */
export function setLineEndpoint(
  el: LineElementLike,
  which: "start" | "end",
  px: number,
  py: number
): LineElementLike {
  if (which === "start") {
    // Moving the start: the absolute end stays fixed, so dx/dy must change.
    const absEndX = el.x + el.dx;
    const absEndY = el.y + el.dy;
    const newDx = absEndX - px;
    const newDy = absEndY - py;
    return {
      ...el,
      x: px,
      y: py,
      dx: newDx,
      dy: newDy,
      width: Math.abs(newDx),
      height: Math.abs(newDy)
    };
  }
  // Moving the end: start stays fixed, dx/dy change.
  const newDx = px - el.x;
  const newDy = py - el.y;
  return {
    ...el,
    dx: newDx,
    dy: newDy,
    width: Math.abs(newDx),
    height: Math.abs(newDy)
  };
}

/** Resize the endpoint span while preserving the segment's direction. */
export function setLineSize(el: LineElementLike, width: number, height: number): LineElementLike {
  const w = Math.max(0, Math.round(width));
  const h = Math.max(0, Math.round(height));
  const sx = el.dx >= 0 ? 1 : -1;
  const sy = el.dy >= 0 ? 1 : -1;
  return { ...el, dx: sx * w, dy: sy * h, width: w, height: h };
}

/** Mirror across a vertical (axis "h") or horizontal (axis "v") center line. */
export function mirrorElement(el: DesignElement, axis: "h" | "v", center: number): DesignElement {
  if (isLineElement(el)) {
    if (axis === "h") {
      const newX = Math.round(2 * center - el.x - el.dx);
      return { ...el, x: newX, dx: -el.dx };
    }
    const newY = Math.round(2 * center - el.y - el.dy);
    return { ...el, y: newY, dy: -el.dy };
  }
  if (axis === "h") {
    const elCx = el.x + el.width / 2;
    return {
      ...el,
      x: Math.round(center - (elCx - center) - el.width / 2),
      flipX: !el.flipX
    };
  }
  const elCy = el.y + el.height / 2;
  return {
    ...el,
    y: Math.round(center - (elCy - center) - el.height / 2),
    flipY: !el.flipY
  };
}
