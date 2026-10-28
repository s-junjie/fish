import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import {
  DesignDocument,
  DesignElement,
  PathElement,
  getActivePage,
  updateActivePageElements
} from "../../core/dsl/types";
import { EditorStore } from "../../core/store/editor-store";
import { findElementById, mapElements } from "../../core/geometry/tree-ops";
import { convertShapeToPathElement } from "../../core/geometry/path-convert";
import {
  normalizePathOrigin,
  parsePathData,
  serializePathData
} from "../../core/geometry/path-data";
import { worldShapeMatrixOf } from "../../core/interactions/component-swap";
import { transformPoint } from "../../core/geometry/matrix";

export interface VectorPathEditingDeps {
  store: EditorStore;
  docRef: { current: DesignDocument };
  commitSnapshot: (doc: DesignDocument) => void;
  selectedIds: Set<string>;
  setSelectedIds: (ids: Set<string> | ((prev: Set<string>) => Set<string>)) => void;
}

export function useVectorPathEditing(deps: VectorPathEditingDeps) {
  const { store, docRef, commitSnapshot, selectedIds, setSelectedIds } = deps;

  const [editingPathId, setEditingPathId] = useState<string | null>(null);
  // A Set, not an index: dragging one anchor while three are selected has to move
  // all four, and a single index cannot say which three.
  const [selectedAnchorIdxs, setSelectedAnchorIdxs] = useState<Set<number>>(new Set());
  const originalShapeRef = useRef<DesignElement | null>(null);
  const pathModifiedRef = useRef(false);
  const initialConvertedDRef = useRef<string | null>(null);

  // If selection moves away from the edited path, exit path edit mode cleanly.
  useEffect(() => {
    if (editingPathId && !selectedIds.has(editingPathId)) {
      exitPathEdit();
    }
  }, [selectedIds, editingPathId]);

  // If the edited element is deleted or ceases to be a path (e.g. from an undo), reset mode.
  useEffect(() => {
    if (editingPathId) {
      const cur = getActivePage(docRef.current);
      const el = findElementById(cur.children, editingPathId);
      if (!el || el.type !== "path") {
        setEditingPathId(null);
        setSelectedAnchorIdxs(new Set());
        originalShapeRef.current = null;
        pathModifiedRef.current = false;
        initialConvertedDRef.current = null;
      }
    }
  });

  const startPathEdit = (el: DesignElement) => {
    if (el.type === "path") {
      originalShapeRef.current = null;
      pathModifiedRef.current = false;
      initialConvertedDRef.current = null;
      setEditingPathId(el.id);
      setSelectedIds(new Set([el.id]));
      setSelectedAnchorIdxs(new Set());
      return;
    }

    const converted = convertShapeToPathElement(el);
    if (converted) {
      originalShapeRef.current = el;
      pathModifiedRef.current = false;
      initialConvertedDRef.current = converted.d;
      const cur = getActivePage(docRef.current);
      const nextElements = mapElements(cur.children, (item) =>
        item.id === el.id ? converted : item
      );
      // Transient conversion: unedited shapes (e.g. rect with borderRadius) are restored on exit
      // without leaving a permanent path or polluting undo history.
      store.setTransient(updateActivePageElements(docRef.current, nextElements));
      setEditingPathId(converted.id);
      setSelectedIds(new Set([converted.id]));
      setSelectedAnchorIdxs(new Set());
    }
  };

  const commitPathEdit = (newD: string) => {
    if (editingPathId) {
      pathModifiedRef.current = true;
      const cur = getActivePage(docRef.current);
      commitSnapshot(
        updateActivePageElements(
          docRef.current,
          mapElements(cur.children, (el) =>
            el.id === editingPathId ? { ...el, d: newD } : el
          )
        )
      );
    }
  };

  // Live frame during an anchor/handle drag: no undo snapshot; the whole drag
  // folds into ONE history step when the gesture ends (store.endGesture).
  const commitPathEditTransient = (newD: string) => {
    if (editingPathId) {
      pathModifiedRef.current = true;
      const cur = getActivePage(docRef.current);
      store.setTransient(
        updateActivePageElements(
          docRef.current,
          mapElements(cur.children, (el) =>
            el.id === editingPathId ? { ...el, d: newD } : el
          )
        )
      );
    }
  };

  const exitPathEdit = () => {
    if (editingPathId) {
      const cur = getActivePage(docRef.current);
      const currentEl = findElementById(cur.children, editingPathId);
      const isUnmodified =
        !pathModifiedRef.current ||
        (currentEl &&
          currentEl.type === "path" &&
          initialConvertedDRef.current !== null &&
          (currentEl as PathElement).d === initialConvertedDRef.current);

      if (originalShapeRef.current && isUnmodified) {
        store.cancelGesture();
        const orig = originalShapeRef.current;
        const nextElements = mapElements(cur.children, (item) =>
          item.id === editingPathId ? orig : item
        );
        store.setTransient(updateActivePageElements(docRef.current, nextElements));
      } else if (currentEl && currentEl.type === "path") {
        const pathEl = currentEl as PathElement;
        const parsed = parsePathData(pathEl.d);
        if (parsed && parsed.anchors.length > 0) {
          const { normalized, offsetX, offsetY, width, height } = normalizePathOrigin(parsed);
          const newD = serializePathData(normalized);
          const newX = Math.round((pathEl.x + offsetX) * 10) / 10;
          const newY = Math.round((pathEl.y + offsetY) * 10) / 10;
          const nextElements = mapElements(cur.children, (item) =>
            item.id === editingPathId
              ? {
                  ...item,
                  x: newX,
                  y: newY,
                  width: Math.max(1, width),
                  height: Math.max(1, height),
                  d: newD
                }
              : item
          );
          store.commitAndEndGesture(updateActivePageElements(docRef.current, nextElements));
        }
      }
    }
    originalShapeRef.current = null;
    pathModifiedRef.current = false;
    initialConvertedDRef.current = null;
    setEditingPathId(null);
    setSelectedAnchorIdxs(new Set());
  };

  const handleAnchorMarquee = useCallback(
    (
      box: { minX: number; minY: number; maxX: number; maxY: number },
      modifiers: { shiftKey: boolean; altKey: boolean },
      isClick: boolean
    ) => {
      if (!editingPathId) return;
      const cur = getActivePage(docRef.current);
      const el = findElementById(cur.children, editingPathId);
      if (!el || el.type !== "path") return;

      if (isClick) {
        if (!modifiers.shiftKey && !modifiers.altKey) {
          setSelectedAnchorIdxs(new Set());
        }
        return;
      }

      const parsed = parsePathData((el as PathElement).d);
      if (!parsed || parsed.anchors.length === 0) return;

      // The marquee box is in canvas space and the anchors are stored in the
      // path's own, so the comparison needs the same matrix the overlay draws
      // under — a turned path's anchors are not at origin-plus-`x`/`y`.
      const shapeMatrix = worldShapeMatrixOf(docRef.current, el);

      const enclosed = new Set<number>();
      parsed.anchors.forEach((pt, idx) => {
        const world = transformPoint(shapeMatrix, pt);
        if (
          world.x >= box.minX &&
          world.x <= box.maxX &&
          world.y >= box.minY &&
          world.y <= box.maxY
        ) {
          enclosed.add(idx);
        }
      });

      setSelectedAnchorIdxs((prev) => {
        if (modifiers.altKey) {
          const next = new Set(prev);
          for (const idx of enclosed) {
            next.delete(idx);
          }
          return next;
        }
        if (modifiers.shiftKey) {
          const next = new Set(prev);
          for (const idx of enclosed) {
            next.add(idx);
          }
          return next;
        }
        return enclosed;
      });
    },
    [editingPathId, docRef]
  );

  return {
    editingPathId,
    setEditingPathId,
    selectedAnchorIdxs,
    setSelectedAnchorIdxs,
    /** Plain click: this anchor and nothing else. */
    selectOnlyAnchor: (idx: number) => setSelectedAnchorIdxs(new Set([idx])),
    /** Shift-click: add or drop one anchor, keeping the rest. */
    toggleAnchor: (idx: number) =>
      setSelectedAnchorIdxs((prev) => {
        const next = new Set(prev);
        if (next.has(idx)) next.delete(idx);
        else next.add(idx);
        return next;
      }),
    startPathEdit,
    commitPathEdit,
    commitPathEditTransient,
    exitPathEdit,
    handleAnchorMarquee
  };
}
