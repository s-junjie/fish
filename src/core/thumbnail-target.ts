import type { DesignDocument, DesignElement, FrameElement } from "./dsl/types";
import { getActivePage } from "./dsl/types";

function searchFrame(elements: readonly DesignElement[], predicate: (el: FrameElement) => boolean): FrameElement | null {
  for (const el of elements) {
    if (el.type === "frame") {
      if (predicate(el)) return el;
      if (Array.isArray(el.children)) {
        const found = searchFrame(el.children, predicate);
        if (found) return found;
      }
    }
  }
  return null;
}

/**
 * Locate the frame designated as document thumbnail:
 * 1. Explicitly designated by doc.thumbnailNodeId
 * 2. Explicitly marked with isThumbnail
 * 3. Fallback: the first frame in Page 1 (or active page/elements)
 */
export function findThumbnailTargetFrame(doc: DesignDocument): FrameElement | null {
  const pages = doc.pages && doc.pages.length > 0 ? doc.pages : [{ id: "page_default", name: "Page 1", children: getActivePage(doc).children ?? [], canvas: doc.canvas }];

  if (doc.thumbnailNodeId) {
    const targetId = doc.thumbnailNodeId;
    for (const page of pages) {
      const found = searchFrame(page.children ?? [], (f) => f.id === targetId);
      if (found) return found;
    }
  }

  for (const page of pages) {
    const found = searchFrame(page.children ?? [], (f) => f.isThumbnail === true);
    if (found) return found;
  }

  const firstPage = pages[0];
  const firstElements = firstPage.children ?? [];
  for (const el of firstElements) {
    if (el.type === "frame") return el;
  }

  return null;
}
