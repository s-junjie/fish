import { Rect } from "./bounds";

export interface MeasureLine {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  distance: number;
  axis: "x" | "y";
  // Where to position the numeric pill
  labelX: number;
  labelY: number;
}

export interface MeasureResult {
  lines: MeasureLine[];
  targetBox: Rect;
  referenceBox: Rect;
  isParent: boolean;
}

/**
 * Computes Figma-style measurement lines between a reference element bounding box
 * and a target element bounding box.
 */
export function computeMeasurement(
  refBox: Rect,
  targetBox: Rect,
  isTargetParent = false
): MeasureResult {
  const lines: MeasureLine[] = [];

  const refLeft = refBox.x;
  const refRight = refBox.x + refBox.width;
  const refTop = refBox.y;
  const refBottom = refBox.y + refBox.height;
  const refMidX = refBox.x + refBox.width / 2;
  const refMidY = refBox.y + refBox.height / 2;

  const targetLeft = targetBox.x;
  const targetRight = targetBox.x + targetBox.width;
  const targetTop = targetBox.y;
  const targetBottom = targetBox.y + targetBox.height;

  // Case 1: Target contains reference (e.g. parent frame)
  const isContained =
    targetLeft <= refLeft &&
    targetRight >= refRight &&
    targetTop <= refTop &&
    targetBottom >= refBottom;

  if (isTargetParent || isContained) {
    // Top distance
    const topDist = Math.round(refTop - targetTop);
    if (topDist > 0) {
      lines.push({
        x1: refMidX,
        y1: targetTop,
        x2: refMidX,
        y2: refTop,
        distance: topDist,
        axis: "y",
        labelX: refMidX,
        labelY: (targetTop + refTop) / 2
      });
    }

    // Bottom distance
    const btmDist = Math.round(targetBottom - refBottom);
    if (btmDist > 0) {
      lines.push({
        x1: refMidX,
        y1: refBottom,
        x2: refMidX,
        y2: targetBottom,
        distance: btmDist,
        axis: "y",
        labelX: refMidX,
        labelY: (refBottom + targetBottom) / 2
      });
    }

    // Left distance
    const leftDist = Math.round(refLeft - targetLeft);
    if (leftDist > 0) {
      lines.push({
        x1: targetLeft,
        y1: refMidY,
        x2: refLeft,
        y2: refMidY,
        distance: leftDist,
        axis: "x",
        labelX: (targetLeft + refLeft) / 2,
        labelY: refMidY
      });
    }

    // Right distance
    const rightDist = Math.round(targetRight - refRight);
    if (rightDist > 0) {
      lines.push({
        x1: refRight,
        y1: refMidY,
        x2: targetRight,
        y2: refMidY,
        distance: rightDist,
        axis: "x",
        labelX: (refRight + targetRight) / 2,
        labelY: refMidY
      });
    }

    return { lines, targetBox, referenceBox: refBox, isParent: true };
  }

  // Case 2: Sibling or disjoint elements
  // Horizontal relation: left of, right of, or overlapping horizontally
  const refIsLeft = refRight <= targetLeft;
  const refIsRight = refLeft >= targetRight;
  const horizOverlap = !refIsLeft && !refIsRight;

  // Vertical relation: above, below, or overlapping vertically
  const refIsAbove = refBottom <= targetTop;
  const refIsBelow = refTop >= targetBottom;
  const vertOverlap = !refIsAbove && !refIsBelow;

  // Compute common overlapping midpoint, or fallback to center
  const commonY = horizOverlap
    ? (Math.max(refTop, targetTop) + Math.min(refBottom, targetBottom)) / 2
    : refMidY;
  const commonX = vertOverlap
    ? (Math.max(refLeft, targetLeft) + Math.min(refRight, targetRight)) / 2
    : refMidX;

  // Horizontal gap line
  if (refIsLeft) {
    const dist = Math.round(targetLeft - refRight);
    lines.push({
      x1: refRight,
      y1: commonY,
      x2: targetLeft,
      y2: commonY,
      distance: dist,
      axis: "x",
      labelX: (refRight + targetLeft) / 2,
      labelY: commonY
    });
  } else if (refIsRight) {
    const dist = Math.round(refLeft - targetRight);
    lines.push({
      x1: targetRight,
      y1: commonY,
      x2: refLeft,
      y2: commonY,
      distance: dist,
      axis: "x",
      labelX: (targetRight + refLeft) / 2,
      labelY: commonY
    });
  }

  // Vertical gap line
  if (refIsAbove) {
    const dist = Math.round(targetTop - refBottom);
    lines.push({
      x1: commonX,
      y1: refBottom,
      x2: commonX,
      y2: targetTop,
      distance: dist,
      axis: "y",
      labelX: commonX,
      labelY: (refBottom + targetTop) / 2
    });
  } else if (refIsBelow) {
    const dist = Math.round(refTop - targetBottom);
    lines.push({
      x1: commonX,
      y1: targetBottom,
      x2: commonX,
      y2: refTop,
      distance: dist,
      axis: "y",
      labelX: commonX,
      labelY: (targetBottom + refTop) / 2
    });
  }

  return { lines, targetBox, referenceBox: refBox, isParent: false };
}
