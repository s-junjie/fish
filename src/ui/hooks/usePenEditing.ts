import { useCallback, useMemo, useState } from "preact/hooks";
import {
  DesignDocument,
  Page,
  PathElement,
  getActivePage,
  updateActivePageElements
} from "../../core/dsl/types";
import { createId } from "../../core/id";
import { DEFAULT_STROKE_COLOR } from "../../core/dsl/defaults";
import { nextPenMode, PenMode, ToolType } from "../../core/tools";
import { worldShapeMatrixOf } from "../../core/interactions/component-swap";
import { flattenElements, mapElements } from "../../core/geometry/tree-ops";
import { t } from "../../i18n";
import type { PenTarget } from "../canvas/PenNodeOverlay";

export interface PenDraft {
  x: number;
  y: number;
  width: number;
  height: number;
  d: string;
}

export interface UsePenEditingOptions {
  docRef: { current: DesignDocument };
  doc: DesignDocument;
  activePage: Page;
  commitSnapshot: (doc: DesignDocument) => void;
  setSelectedIds: (ids: Set<string>) => void;
  setEditingPathId: (id: string | null) => void;
  setSelectedAnchorIdxs: (idxs: Set<number>) => void;
  setActiveTool: (tool: ToolType) => void;
  showHint: (msg: string) => void;
}

/**
 * The pen: which of its three modes is live, the path it just drew, and every
 * path it may edit.
 *
 * The mode resets to `draw` on leaving the tool, so the next `P` always starts a
 * new path rather than editing whichever shape is under the cursor — the mode is
 * a gesture, not a preference.
 */
export function usePenEditing({
  docRef,
  doc,
  activePage,
  commitSnapshot,
  setSelectedIds,
  setEditingPathId,
  setSelectedAnchorIdxs,
  setActiveTool,
  showHint
}: UsePenEditingOptions) {
  const [penMode, setPenMode] = useState<PenMode>("draw");

  const finishDraft = useCallback(
    (data: PenDraft) => {
      const newPath: PathElement = {
        id: createId("path"),
        type: "path",
        name: "Vector Path",
        x: data.x,
        y: data.y,
        width: data.width,
        height: data.height,
        d: data.d,
        strokes: [{ color: DEFAULT_STROKE_COLOR, width: 2 }]
      };
      const cur = getActivePage(docRef.current);
      commitSnapshot(updateActivePageElements(docRef.current, [...cur.children, newPath]));
      setSelectedIds(new Set([newPath.id]));
      setEditingPathId(newPath.id);
      setSelectedAnchorIdxs(new Set());
      setActiveTool("select");
    },
    [commitSnapshot, docRef, setActiveTool, setEditingPathId, setSelectedAnchorIdxs, setSelectedIds]
  );

  const cancelDraft = useCallback(() => {
    setPenMode("draw");
    setActiveTool("select");
  }, [setActiveTool]);

  const cycleMode = useCallback(
    (wasActive: boolean) => {
      if (!wasActive) {
        setPenMode("draw");
        return;
      }
      setPenMode((prev: PenMode) => {
        const next = nextPenMode(prev);
        showHint(t(`pen.mode${next.charAt(0).toUpperCase()}${next.slice(1)}`));
        return next;
      });
    },
    [showHint]
  );

  const editPath = useCallback(
    (id: string, newD: string) => {
      const cur = getActivePage(docRef.current);
      commitSnapshot(
        updateActivePageElements(
          docRef.current,
          mapElements(cur.children, (el) => (el.id === id ? { ...el, d: newD } : el))
        )
      );
    },
    [commitSnapshot, docRef]
  );

  /**
   * Every path the pen may edit, with its geometry placed on the canvas.
   *
   * Flattened and filtered once per render rather than hit-tested through the
   * tree on every mousemove: the overlay compares against all of them, so this is
   * the hot path and walking nested frames per pointer event would not keep up.
   *
   * `doc` is the dependency, not `docRef.current`: a ref is not a value React can
   * compare, so listing it only silences the reviewer. Everything the matrices
   * are derived from hangs off the document — the walk reads the whole tree,
   * masters on other pages included — so `doc` changing is the only signal there
   * is to recompute on.
   */
  const targets = useMemo<PenTarget[]>(
    () =>
      flattenElements(activePage.children)
        .filter((el): el is PathElement => el.type === "path" && el.visible !== false && !el.locked)
        .map((element) => ({ element, matrix: worldShapeMatrixOf(docRef.current, element) })),
    [doc, activePage]
  );

  return {
    penMode,
    setPenMode,
    cycleMode,
    finishDraft,
    cancelDraft,
    editPath,
    targets
  };
}
