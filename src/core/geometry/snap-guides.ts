import { DesignElement } from "../dsl/types";
import { elementAABB } from "./element-bounds";
import type { GuideLineSet } from "../layout/layout-guides";

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

/**
 * The magnet's reach under the hand, in SCREEN pixels.
 *
 * Every comparison below is in document units, so it is divided by the caller's
 * zoom before use. A constant in document units grows with the zoom instead:
 * at 2000% a 6-unit magnet reaches 120 screen px, which makes an edge
 * impossible to place near a sibling — the drag is swallowed by the guide long
 * before the pointer gets where the user is aiming.
 */
export const SNAP_REACH_PX = 6;

const snapReach = (zoom: number): number => SNAP_REACH_PX / (zoom > 0 ? zoom : 1);

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
  zoom: number,
  canvasWidth?: number,
  canvasHeight?: number,
  siblingElements: DesignElement[] = [],
  guideLines?: GuideLineSet
): { x: number; y: number; width: number; height: number; guides: GuideLine[] } {
  let x = bounds.x;
  let y = bounds.y;
  let width = bounds.width;
  let height = bounds.height;
  const guides: GuideLine[] = [];
  const reach = snapReach(zoom);

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

  if (guideLines) {
    for (const span of guideLines.vertical) {
      vCandidates.push({ pos: span.position, start: span.start, end: span.end });
    }
    for (const span of guideLines.horizontal) {
      hCandidates.push({ pos: span.position, start: span.start, end: span.end });
    }
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
      if (d <= reach && (!best || d < Math.abs(value - best.pos))) best = c;
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

interface AxisCandidate {
  /** Where the target lands on this axis if this candidate wins. */
  delta: number;
  /** The guide line the candidate draws, and the span it covers. */
  position: number;
  start: number;
  end: number;
}

/**
 * Move snapping: the NEAREST candidate on each axis wins, and only guides
 * collinear with the winning delta are drawn.
 *
 * The loop this replaced let every candidate within reach overwrite the result,
 * so the last sibling listed won over the truly nearest one and a single drag
 * could light up several guides on different X coordinates while the element
 * sat on none of them. Collecting per axis and taking the minimum `|delta|`
 * gives one answer per axis; the collinear filter keeps the guides honest.
 */
export function calculateSnapping(
  draggingBounds: { x: number; y: number; width: number; height: number },
  zoom: number,
  canvasWidth?: number,
  canvasHeight?: number,
  siblingElements: DesignElement[] = [],
  guideLines?: GuideLineSet
): SnapResult {
  const reach = snapReach(zoom);
  const targetLeft = draggingBounds.x;
  const targetTop = draggingBounds.y;
  const targetRight = targetLeft + draggingBounds.width;
  const targetBottom = targetTop + draggingBounds.height;
  const targetCenterX = targetLeft + draggingBounds.width / 2;
  const targetCenterY = targetTop + draggingBounds.height / 2;

  const xCandidates: AxisCandidate[] = [];
  const yCandidates: AxisCandidate[] = [];

  if (canvasWidth !== undefined && canvasWidth > 0 && canvasHeight !== undefined && canvasHeight > 0) {
    const centerX = canvasWidth / 2;
    const centerY = canvasHeight / 2;
    xCandidates.push(
      { delta: centerX - targetCenterX, position: centerX, start: 0, end: canvasHeight },
      { delta: -targetLeft, position: 0, start: 0, end: canvasHeight },
      { delta: canvasWidth - targetRight, position: canvasWidth, start: 0, end: canvasHeight }
    );
    yCandidates.push(
      { delta: centerY - targetCenterY, position: centerY, start: 0, end: canvasWidth },
      { delta: -targetTop, position: 0, start: 0, end: canvasWidth },
      { delta: canvasHeight - targetBottom, position: canvasHeight, start: 0, end: canvasWidth }
    );
  }

  for (const el of siblingElements) {
    const sib = elementAABB(el);
    const sibRight = sib.x + sib.width;
    const sibBottom = sib.y + sib.height;
    const gxStart = Math.min(targetTop, sib.y);
    const gxEnd = Math.max(targetBottom, sibBottom);
    const gyStart = Math.min(targetLeft, sib.x);
    const gyEnd = Math.max(targetRight, sibRight);
    // Edge-to-edge alignment plus the abutment that touches the sibling's
    // opposite edge.
    for (const c of [
      { delta: sib.x - targetLeft, position: sib.x },
      { delta: sib.x + sib.width / 2 - targetCenterX, position: sib.x + sib.width / 2 },
      { delta: sibRight - targetRight, position: sibRight },
      { delta: sib.x - targetRight, position: sib.x },
      { delta: sibRight - targetLeft, position: sibRight }
    ]) {
      xCandidates.push({ ...c, start: gxStart, end: gxEnd });
    }
    for (const c of [
      { delta: sib.y - targetTop, position: sib.y },
      { delta: sib.y + sib.height / 2 - targetCenterY, position: sib.y + sib.height / 2 },
      { delta: sibBottom - targetBottom, position: sibBottom },
      { delta: sib.y - targetBottom, position: sib.y },
      { delta: sibBottom - targetTop, position: sibBottom }
    ]) {
      yCandidates.push({ ...c, start: gyStart, end: gyEnd });
    }
  }

  /**
   * A guide edge takes any of the box's three lines, the same way a sibling's
   * edge does: aligning the LEFT of a card to a column line, its CENTRE, or its
   * RIGHT are three different intents and all three are worth a magnet. The span
   * is the guide's own drawn extent, so the line that appears is the band edge
   * the author can actually see.
   */
  if (guideLines) {
    for (const span of guideLines.vertical) {
      for (const delta of [span.position - targetLeft, span.position - targetCenterX, span.position - targetRight]) {
        xCandidates.push({ delta, position: span.position, start: span.start, end: span.end });
      }
    }
    for (const span of guideLines.horizontal) {
      for (const delta of [span.position - targetTop, span.position - targetCenterY, span.position - targetBottom]) {
        yCandidates.push({ delta, position: span.position, start: span.start, end: span.end });
      }
    }
  }

  const resolveAxis = (
    candidates: AxisCandidate[],
    base: number,
    orientation: GuideLine["orientation"]
  ): { value: number; guides: GuideLine[] } => {
    let bestDelta: number | null = null;
    for (const c of candidates) {
      const d = Math.abs(c.delta);
      if (d <= reach && (bestDelta === null || d < Math.abs(bestDelta))) bestDelta = c.delta;
    }
    if (bestDelta === null) return { value: base, guides: [] };
    const merged = new Map<number, GuideLine>();
    for (const c of candidates) {
      if (Math.abs(c.delta - bestDelta) >= 1e-3) continue;
      const existing = merged.get(c.position);
      if (existing) {
        existing.start = Math.min(existing.start, c.start);
        existing.end = Math.max(existing.end, c.end);
      } else {
        merged.set(c.position, { orientation, position: c.position, start: c.start, end: c.end });
      }
    }
    return { value: base + bestDelta, guides: [...merged.values()] };
  };

  const x = resolveAxis(xCandidates, targetLeft, "vertical");
  const y = resolveAxis(yCandidates, targetTop, "horizontal");
  return { snappedX: x.value, snappedY: y.value, guides: [...x.guides, ...y.guides] };
}
