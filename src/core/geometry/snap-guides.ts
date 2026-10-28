import { DesignElement } from "../dsl/types";
import { elementAABB } from "./element-bounds";

export interface GuideLine {
  orientation: "horizontal" | "vertical";
  position: number;
  start: number;
  end: number;
}

export interface SnapResult {
  snappedX: number;
  snappedY: number;
  guides: GuideLine[];
}

const SNAP_THRESHOLD = 6;

export type ResizeHandleType = "tl" | "tr" | "br" | "bl" | "tm" | "bm" | "ml" | "mr";

interface SnapCandidate {
  pos: number;
  start: number;
  end: number;
}

/**
 * Resize snapping: unlike a drag (the whole box moves), only the edges the
 * handle controls may snap — the anchored edges must stay put, otherwise
 * stretching toward a sibling's opposite edge would look like a move.
 */
export function calculateResizeSnapping(
  handle: ResizeHandleType,
  bounds: { x: number; y: number; width: number; height: number },
  canvasWidth?: number,
  canvasHeight?: number,
  siblingElements: DesignElement[] = []
): { x: number; y: number; width: number; height: number; guides: GuideLine[] } {
  let x = bounds.x;
  let y = bounds.y;
  let width = bounds.width;
  let height = bounds.height;
  const guides: GuideLine[] = [];

  const vCandidates: SnapCandidate[] = [];
  const hCandidates: SnapCandidate[] = [];

  if (canvasWidth !== undefined && canvasWidth > 0 && canvasHeight !== undefined && canvasHeight > 0) {
    vCandidates.push(
      { pos: 0, start: 0, end: canvasHeight },
      { pos: canvasWidth / 2, start: 0, end: canvasHeight },
      { pos: canvasWidth, start: 0, end: canvasHeight }
    );
    hCandidates.push(
      { pos: 0, start: 0, end: canvasWidth },
      { pos: canvasHeight / 2, start: 0, end: canvasWidth },
      { pos: canvasHeight, start: 0, end: canvasWidth }
    );
  }

  for (const el of siblingElements) {
    const s = elementAABB(el);
    const vStart = Math.min(y, s.y);
    const vEnd = Math.max(y + height, s.y + s.height);
    const hStart = Math.min(x, s.x);
    const hEnd = Math.max(x + width, s.x + s.width);
    vCandidates.push(
      { pos: s.x, start: vStart, end: vEnd },
      { pos: s.x + s.width / 2, start: vStart, end: vEnd },
      { pos: s.x + s.width, start: vStart, end: vEnd }
    );
    hCandidates.push(
      { pos: s.y, start: hStart, end: hEnd },
      { pos: s.y + s.height / 2, start: hStart, end: hEnd },
      { pos: s.y + s.height, start: hStart, end: hEnd }
    );
  }

  const snapEdge = (value: number, candidates: SnapCandidate[]): SnapCandidate | null => {
    let best: SnapCandidate | null = null;
    for (const c of candidates) {
      const d = Math.abs(value - c.pos);
      if (d <= SNAP_THRESHOLD && (!best || d < Math.abs(value - best.pos))) best = c;
    }
    return best;
  };

  const movesLeft = handle === "ml" || handle === "tl" || handle === "bl";
  const movesRight = handle === "mr" || handle === "tr" || handle === "br";
  const movesTop = handle === "tm" || handle === "tl" || handle === "tr";
  const movesBottom = handle === "bm" || handle === "bl" || handle === "br";

  if (movesLeft) {
    const hit = snapEdge(x, vCandidates);
    if (hit) {
      const right = x + width;
      x = hit.pos;
      width = Math.max(1, right - hit.pos);
      guides.push({ orientation: "vertical", position: hit.pos, start: hit.start, end: hit.end });
    }
  } else if (movesRight) {
    const hit = snapEdge(x + width, vCandidates);
    if (hit) {
      width = hit.pos - x;
      guides.push({ orientation: "vertical", position: hit.pos, start: hit.start, end: hit.end });
    }
  }

  if (movesTop) {
    const hit = snapEdge(y, hCandidates);
    if (hit) {
      const bottom = y + height;
      y = hit.pos;
      height = Math.max(1, bottom - hit.pos);
      guides.push({ orientation: "horizontal", position: hit.pos, start: hit.start, end: hit.end });
    }
  } else if (movesBottom) {
    const hit = snapEdge(y + height, hCandidates);
    if (hit) {
      height = hit.pos - y;
      guides.push({ orientation: "horizontal", position: hit.pos, start: hit.start, end: hit.end });
    }
  }

  return { x, y, width, height, guides };
}

export function calculateSnapping(
  draggingBounds: { x: number; y: number; width: number; height: number },
  canvasWidth?: number,
  canvasHeight?: number,
  siblingElements: DesignElement[] = []
): SnapResult {
  let snappedX = draggingBounds.x;
  let snappedY = draggingBounds.y;
  const guides: GuideLine[] = [];

  const targetLeft = draggingBounds.x;
  const targetRight = draggingBounds.x + draggingBounds.width;
  const targetCenterX = draggingBounds.x + draggingBounds.width / 2;

  const targetTop = draggingBounds.y;
  const targetBottom = draggingBounds.y + draggingBounds.height;
  const targetCenterY = draggingBounds.y + draggingBounds.height / 2;

  // 1. Canvas Center & Edges (if canvas bounds are defined)
  if (canvasWidth !== undefined && canvasWidth > 0 && canvasHeight !== undefined && canvasHeight > 0) {
    const canvasCenterX = canvasWidth / 2;
    if (Math.abs(targetCenterX - canvasCenterX) <= SNAP_THRESHOLD) {
      snappedX = canvasCenterX - draggingBounds.width / 2;
      guides.push({ orientation: "vertical", position: canvasCenterX, start: 0, end: canvasHeight });
    } else if (Math.abs(targetLeft - 0) <= SNAP_THRESHOLD) {
      snappedX = 0;
      guides.push({ orientation: "vertical", position: 0, start: 0, end: canvasHeight });
    } else if (Math.abs(targetRight - canvasWidth) <= SNAP_THRESHOLD) {
      snappedX = canvasWidth - draggingBounds.width;
      guides.push({ orientation: "vertical", position: canvasWidth, start: 0, end: canvasHeight });
    }

    const canvasCenterY = canvasHeight / 2;
    if (Math.abs(targetCenterY - canvasCenterY) <= SNAP_THRESHOLD) {
      snappedY = canvasCenterY - draggingBounds.height / 2;
      guides.push({ orientation: "horizontal", position: canvasCenterY, start: 0, end: canvasWidth });
    } else if (Math.abs(targetTop - 0) <= SNAP_THRESHOLD) {
      snappedY = 0;
      guides.push({ orientation: "horizontal", position: 0, start: 0, end: canvasWidth });
    } else if (Math.abs(targetBottom - canvasHeight) <= SNAP_THRESHOLD) {
      snappedY = canvasHeight - draggingBounds.height;
      guides.push({ orientation: "horizontal", position: canvasHeight, start: 0, end: canvasWidth });
    }
  }

  // 2. Sibling elements
  for (const el of siblingElements) {
    const sib = elementAABB(el);
    const siblingCenterX = sib.x + sib.width / 2;
    const siblingCenterY = sib.y + sib.height / 2;

    // Vertical guides (matching X coordinates)
    if (Math.abs(targetLeft - sib.x) <= SNAP_THRESHOLD) {
      snappedX = sib.x;
      guides.push({
        orientation: "vertical",
        position: sib.x,
        start: Math.min(targetTop, sib.y),
        end: Math.max(targetBottom, sib.y + sib.height)
      });
    } else if (Math.abs(targetRight - (sib.x + sib.width)) <= SNAP_THRESHOLD) {
      snappedX = sib.x + sib.width - draggingBounds.width;
      guides.push({
        orientation: "vertical",
        position: sib.x + sib.width,
        start: Math.min(targetTop, sib.y),
        end: Math.max(targetBottom, sib.y + sib.height)
      });
    } else if (Math.abs(targetCenterX - siblingCenterX) <= SNAP_THRESHOLD) {
      snappedX = siblingCenterX - draggingBounds.width / 2;
      guides.push({
        orientation: "vertical",
        position: siblingCenterX,
        start: Math.min(targetTop, sib.y),
        end: Math.max(targetBottom, sib.y + sib.height)
      });
    }

    // Horizontal guides (matching Y coordinates)
    if (Math.abs(targetTop - sib.y) <= SNAP_THRESHOLD) {
      snappedY = sib.y;
      guides.push({
        orientation: "horizontal",
        position: sib.y,
        start: Math.min(targetLeft, sib.x),
        end: Math.max(targetRight, sib.x + sib.width)
      });
    } else if (Math.abs(targetBottom - (sib.y + sib.height)) <= SNAP_THRESHOLD) {
      snappedY = sib.y + sib.height - draggingBounds.height;
      guides.push({
        orientation: "horizontal",
        position: sib.y + sib.height,
        start: Math.min(targetLeft, sib.x),
        end: Math.max(targetRight, sib.x + sib.width)
      });
    } else if (Math.abs(targetCenterY - siblingCenterY) <= SNAP_THRESHOLD) {
      snappedY = siblingCenterY - draggingBounds.height / 2;
      guides.push({
        orientation: "horizontal",
        position: siblingCenterY,
        start: Math.min(targetLeft, sib.x),
        end: Math.max(targetRight, sib.x + sib.width)
      });
    }
  }

  return { snappedX, snappedY, guides };
}
