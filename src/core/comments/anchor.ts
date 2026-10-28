import { CommentTarget } from "./types";

export interface ElementBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function computeRelativeOffset(
  canvasPoint: { x: number; y: number },
  elementBounds: ElementBounds
): { u: number; v: number } {
  const w = elementBounds.width > 0 ? elementBounds.width : 1;
  const h = elementBounds.height > 0 ? elementBounds.height : 1;
  const u = Math.max(0, Math.min(1, (canvasPoint.x - elementBounds.x) / w));
  const v = Math.max(0, Math.min(1, (canvasPoint.y - elementBounds.y) / h));
  return { u, v };
}

export interface ResolvedCommentPoint {
  x: number;
  y: number;
  isOrphan: boolean;
}

export function resolveCommentCanvasPoint(
  target: CommentTarget,
  findElement: (elementId: string) => ElementBounds | undefined
): ResolvedCommentPoint {
  if (target.elementId) {
    const el = findElement(target.elementId);
    if (el) {
      if (target.relativeOffset) {
        return {
          x: el.x + target.relativeOffset.u * el.width,
          y: el.y + target.relativeOffset.v * el.height,
          isOrphan: false
        };
      }
      return { x: el.x, y: el.y, isOrphan: false };
    }
    return { x: target.canvasPoint.x, y: target.canvasPoint.y, isOrphan: true };
  }
  return { x: target.canvasPoint.x, y: target.canvasPoint.y, isOrphan: false };
}

export function canvasToViewportPoint(
  point: { x: number; y: number },
  viewport: { panX: number; panY: number; zoom: number }
): { x: number; y: number } {
  return {
    x: point.x * viewport.zoom + viewport.panX,
    y: point.y * viewport.zoom + viewport.panY
  };
}
