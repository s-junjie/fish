import { ContainerElement, DesignDocument, DesignElement } from "../dsl/types";
import { updateActivePageElements } from "../dsl/document-ops";
import { getActivePage } from "../dsl/document-ops";
import { elementRotatedAABB } from "../geometry/element-bounds";
import { findElementById, isContainer, mapElements } from "../geometry/tree-ops";
import type { Rect } from "../geometry/bounds";
import { layoutOf } from "../dsl/layout-flat";

/**
 * Why "Resize to fit" cannot run on this element. Reported rather than thrown so
 * the menu can offer the item disabled with a reason.
 */
export type FrameFitRefusal = "not-a-frame" | "auto-layout" | "empty";

export const FRAME_FIT_REFUSALS: Record<FrameFitRefusal, string> = {
  "not-a-frame": "frame.resizeToFitFramesOnly",
  "auto-layout": "frame.resizeToFitAutoLayout",
  empty: "frame.resizeToFitEmpty"
};

/** `null` when the command can run; otherwise why it cannot. */
export function frameFitRefusal(el: DesignElement | null | undefined): FrameFitRefusal | null {
  if (!el || !isContainer(el)) return "not-a-frame";
  // A stack computes its own box in `applyAutoLayout`; writing a width here would
  // be overwritten by the very next layout pass, so the command is meaningless
  // rather than merely imprecise.
  if (layoutOf(el)) return "auto-layout";
  if (!el.children || el.children.length === 0) return "empty";
  return null;
}

function childrenBounds(el: ContainerElement): Rect | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const child of el.children || []) {
    const visual = elementRotatedAABB(child);
    // A child that paints nothing must not define the frame's size: an empty line
    // would otherwise collapse the frame to its own origin.
    if (visual.width === 0 && visual.height === 0) continue;
    minX = Math.min(minX, visual.x);
    minY = Math.min(minY, visual.y);
    maxX = Math.max(maxX, visual.x + visual.width);
    maxY = Math.max(maxY, visual.y + visual.height);
  }
  if (!Number.isFinite(minX)) return null;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export function resizeFrameToFit(el: DesignElement): ContainerElement | null {
  if (frameFitRefusal(el)) return null;
  const frame = el as ContainerElement;
  const bounds = childrenBounds(frame);
  if (!bounds) return null;

  const width = Math.max(1, Math.round(bounds.width));
  const height = Math.max(1, Math.round(bounds.height));
  const shiftX = Math.round(bounds.x);
  const shiftY = Math.round(bounds.y);

  const children = (frame.children || []).map((child) =>
    child.x === -shiftX && child.y === -shiftY ? child : { ...child, x: child.x - shiftX, y: child.y - shiftY }
  );
  const kids = frame.children || [];
  const unchanged =
    shiftX === 0 &&
    shiftY === 0 &&
    frame.width === width &&
    frame.height === height &&
    children.every((child, i) => child === kids[i]);
  if (unchanged) return frame;

  return {
    ...frame,
    x: frame.x + shiftX,
    y: frame.y + shiftY,
    width,
    height,
    children
  } as ContainerElement;
}

export function fitFrameInDocument(
  doc: DesignDocument,
  frameId: string
): { doc: DesignDocument; changed: boolean } {
  const target = findElementById(getActivePage(doc).children, frameId);
  if (!target) return { doc, changed: false };
  const next = resizeFrameToFit(target);
  if (!next) return { doc, changed: false };
  return {
    doc: updateActivePageElements(
      doc,
      mapElements(getActivePage(doc).children, (el) => (el.id === next.id ? next : el))
    ),
    changed: true
  };
}
