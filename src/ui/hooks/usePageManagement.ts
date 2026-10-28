import { useCallback } from "preact/hooks";
import {
  DesignDocument,
  Page,
  getActivePage,
  updateActivePage
} from "../../core/dsl/types";
import { isLaidOut, relayoutDocumentTree as relayoutDocument } from "../../core/compile";
import { createId } from "../../core/id";
import { duplicatePage } from "../../core/interactions/page-ops";

interface UsePageManagementOptions {
  docRef: { current: DesignDocument };
  setDoc: (doc: DesignDocument) => void;
  commitSnapshot: (doc: DesignDocument) => void;
  setSelectedIds: (ids: Set<string>) => void;
  /** The viewport to remember per page, so a switch restores what the user had. */
  viewportRef: { current: { x: number; y: number; zoom: number } };
  setPan: (pan: { x: number; y: number }) => void;
  setZoom: (zoom: number) => void;
  /** Editing a layer on a page you just left would write to the wrong tree. */
  onLeaveLayer: () => void;
}

/**
 * Switching and creating pages.
 *
 * One subsystem, one place for the rule every branch repeats: a page's tree
 * lives in its own `children`, and a page that has never been opened still
 * carries the coordinates its author wrote — so the first visit to it reflows,
 * or a programmatically authored page is a pile of elements at (0, 0).
 */
export function usePageManagement({
  docRef,
  setDoc,
  commitSnapshot,
  setSelectedIds,
  viewportRef,
  setPan,
  setZoom,
  onLeaveLayer
}: UsePageManagementOptions) {
  const handleSelectPage = useCallback((pageId: string) => {
    if (pageId === docRef.current.activePageId) return;
    const withVp = updateActivePage(docRef.current, (p) => ({
      metadata: { ...(p.metadata || {}), viewport: viewportRef.current }
    }));
    const target = withVp.pages.find((p) => p.id === pageId) || withVp.pages[0];
    // Only the active page is laid out on load, so a page that has never been
    // opened still carries the coordinates its author wrote — for a page written
    // by a script that is a pile of elements at (0,0). Reflow it on the way in —
    // unless it is the very tree a previous visit laid out, which the layout
    // module can answer in O(1) and which costs 2.7 ms to ask again.
    const targetElements = isLaidOut(target.children)
      ? target.children
      : relayoutDocument(target.children);
    const nextDoc: DesignDocument = {
      ...withVp,
      pages: withVp.pages.map((p) => (p.id === target.id ? { ...p, children: targetElements } : p)),
      activePageId: target.id
    };
    setDoc(nextDoc);
    setSelectedIds(new Set());
    onLeaveLayer();

    if (target.metadata?.viewport) {
      const vp = target.metadata.viewport;
      setPan({ x: vp.x, y: vp.y });
      setZoom(vp.zoom);
    }
  }, []);

  const handleAddPage = useCallback(() => {
    const curDoc = docRef.current;
    const newIdx = curDoc.pages.length + 1;
    const newPage: Page = {
      id: createId("page"),
      name: `Page ${newIdx}`,
      // A new page inherits the page the user is looking at, not the
      // document-level fallback canvas.
      canvas: { ...(getActivePage(curDoc).canvas || curDoc.canvas) },
      children: []
    };
    const nextDoc: DesignDocument = {
      ...curDoc,
      pages: [...curDoc.pages, newPage],
      activePageId: newPage.id
    };
    commitSnapshot(nextDoc);
    setSelectedIds(new Set());
  }, [commitSnapshot]);

  const handleRenamePage = useCallback((pageId: string, newName: string) => {
    const nextDoc: DesignDocument = {
      ...docRef.current,
      pages: docRef.current.pages.map((p) => (p.id === pageId ? { ...p, name: newName } : p))
    };
    commitSnapshot(nextDoc);
  }, [commitSnapshot]);

  const handleDeletePage = useCallback((pageId: string) => {
    const curDoc = docRef.current;
    if (curDoc.pages.length <= 1) return;
    const remaining = curDoc.pages.filter((p) => p.id !== pageId);
    const nextActiveId = curDoc.activePageId === pageId ? remaining[0].id : curDoc.activePageId;
    const nextActive = remaining.find((p) => p.id === nextActiveId) || remaining[0];
    const nextDoc: DesignDocument = {
      ...curDoc,
      pages: remaining,
      activePageId: nextActiveId
    };
    commitSnapshot(nextDoc);
    setSelectedIds(new Set());
  }, [commitSnapshot]);

  const handleDuplicatePage = useCallback((pageId: string) => {
    const curDoc = docRef.current;
    const target = curDoc.pages.find((p) => p.id === pageId);
    if (!target) return;
    // Ids are document-wide, and `findMasterComponent` scans every page, so a
    // verbatim copy made each duplicate a shadow master and rebound nothing.
    const newPage = duplicatePage(target);
    const idx = curDoc.pages.findIndex((p) => p.id === pageId);
    const nextPages = [...curDoc.pages];
    nextPages.splice(idx + 1, 0, newPage);
    const nextDoc: DesignDocument = {
      ...curDoc,
      pages: nextPages,
      activePageId: newPage.id
    };
    commitSnapshot(nextDoc);
    setSelectedIds(new Set());
  }, [commitSnapshot]);

  return {
    selectPage: handleSelectPage,
    addPage: handleAddPage,
    renamePage: handleRenamePage,
    deletePage: handleDeletePage,
    duplicatePage: handleDuplicatePage
  };
}
