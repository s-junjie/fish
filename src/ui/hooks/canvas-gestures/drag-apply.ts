import {
  DesignDocument,
  DesignElement,
  getActivePage,
  updateActivePageElements
} from "../../../core/dsl/types";
import { relayoutDocumentTree, computeDropSlot, computeAppendSlot, DropSlot } from "../../../core/compile";
import { layoutOf } from "../../../core/dsl/layout-flat";
import { calculateSnapping, GuideLine } from "../../../core/geometry/snap-guides";
import { calculateVisibleViewport } from "../../../core/geometry/cull";
import { snapCandidates } from "../../../core/geometry/snap-candidates";
import { elementWorldAABB } from "../../../core/geometry/tree-ops";
import { measureSpan } from "../../../core/perf";
import { moveElementTo } from "../../../core/interactions/line-ops";
import { insertClones } from "../../../core/interactions/clipboard";
import {
  collectDescendantIds,
  computeParentOrigin,
  findElementById,
  findFrameAtPoint,
  findParentById,
  flattenElements,
  isContainer,
  mapElements,
  ownMasterId,
  removeElementFromTree
} from "../../../core/geometry/tree-ops";

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface DragOrigin {
  x: number;
  y: number;
  /** Captured for an on-path text: the offset the slide starts from. */
  startOffset?: number;
}

/**
 * Pure projection: drag delta (px) onto the path tangent at the base offset,
 * converted into a new startOffset percentage. Clamped to 0–100, one decimal.
 */
export function projectOffsetAlongTangent(
  baseOffset: number,
  dx: number,
  dy: number,
  tangentX: number,
  tangentY: number,
  totalLength: number
): number {
  const tLen = Math.hypot(tangentX, tangentY) || 1;
  const alongPx = (dx * tangentX + dy * tangentY) / tLen;
  const next = baseOffset + (alongPx / totalLength) * 100;
  return Math.max(0, Math.min(100, Math.round(next * 10) / 10));
}

/**
 * Project a drag delta onto the guide path's tangent at the drag-start offset
 * and convert it into a new startOffset percentage. The tangent is sampled at
 * the BASE offset, so the projection is absolute per frame and cannot feed back
 * into itself. Returns null when the guide path is not in the DOM.
 */
export function slideStartOffset(
  baseOffset: number,
  dx: number,
  dy: number,
  textId: string
): number | null {
  const guide = document.getElementById(`guide_path_${textId}`) as SVGPathElement | null;
  if (!guide) return null;
  let total: number;
  try {
    total = guide.getTotalLength();
  } catch {
    return null;
  }
  if (!(total > 0)) return null;
  const at = (total * Math.max(0, Math.min(100, baseOffset))) / 100;
  let from: DOMPoint;
  let to: DOMPoint;
  try {
    from = guide.getPointAtLength(Math.max(0, at - 1));
    to = guide.getPointAtLength(Math.min(total, at + 1));
  } catch {
    return null;
  }
  return projectOffsetAlongTangent(baseOffset, dx, dy, to.x - from.x, to.y - from.y, total);
}

/**
 * What a provisional Alt/Option duplicate needs in order to be taken back.
 *
 * Everything here is a snapshot of the gesture as it stood BEFORE the mint, so
 * the take-back is a restore rather than an inverse: the clones are deleted by
 * id, and the drag refs go back to the sources they were re-based away from.
 */
export interface DuplicateUndo {
  /** The clones' root ids — one per source, each the root of its own subtree. */
  cloneIds: string[];
  /** The drag's origins before the mint: the sources' own start marks. */
  origins: Map<string, DragOrigin>;
  /** The drag's selection before the mint. */
  selection: Set<string>;
  /** The drag's primary before the mint. */
  primary: { id: string; box: Box } | null;
}

/** A drag's snap candidates, with the inputs they were listed for. */
export interface SnapCandidateCache {
  dragged: ReadonlySet<string>;
  excluded: ReadonlySet<string>;
  viewportKey: string;
  list: DesignElement[];
}

export interface DragApplyContext {
  docRef: { current: DesignDocument };
  setDoc: (updater: (prev: DesignDocument) => DesignDocument) => void;
  zoom: number;
  pan: { x: number; y: number };
  currentContainerRect: () => DOMRect | null;
  setActiveGuides: (guides: GuideLine[]) => void;
  setDragOverFrameId: (id: string | null) => void;
  setDropSlot: (slot: DropSlot | null) => void;
  setSelectedIds: (ids: Set<string>) => void;
  /**
   * Non-null exactly while a copy exists in the document, so it doubles as the
   * "are we duplicating?" flag for the frame that has to decide.
   */
  duplicateUndoRef: { current: DuplicateUndo | null };
  dragStartElements: { current: Map<string, DragOrigin> };
  dragSelectionRef: { current: Set<string> };
  dragSnapExcludeRef: { current: Set<string> };
  snapCacheRef: { current: SnapCandidateCache | null };
  dragPrimary: { current: { id: string; box: Box } | null };
  dragStartMouse: { current: { x: number; y: number } };
  hasMovedBeyondThreshold: { current: boolean };
  dropSlotRef: { current: DropSlot | null };
  dropSlotParentRef: { current: string | null };
}

/**
 * One frame of a move drag: snapping, the drop slot, and the transient move.
 *
 * Extracted from `useCanvasGestures` (AGENTS.md §9) — it is the per-frame hot
 * path of element dragging, and it is the only place that needs the drag refs.
 */
export function createDragApply(ctx: DragApplyContext) {
  const {
    docRef,
    setDoc,
    zoom,
    pan,
    currentContainerRect,
    setActiveGuides,
    setDragOverFrameId,
    setDropSlot,
    setSelectedIds,
    duplicateUndoRef,
    dragStartElements,
    dragSelectionRef,
    dragSnapExcludeRef,
    snapCacheRef,
    dragPrimary,
    dragStartMouse,
    hasMovedBeyondThreshold,
    dropSlotRef,
    dropSlotParentRef
  } = ctx;

  /**
   * Alt/Option drag: mint the copies and re-base the running gesture onto them.
   * The originals stay where the gesture found them and become snap-exempt —
   * they sit exactly on top of the clone being dragged, so leaving them in the
   * candidate set would glue the copy to its own source.
   *
   * Must run before the frame's snapping, drop-slot and commit read the gesture
   * state, because all three have to address the clone rather than the source.
   * The write goes through `setDoc` (transient) so it folds into the single undo
   * step `startDragGesture` froze at mousedown.
   *
   * The sources are read off `dragStartElements`, which is the drag's own map of
   * what it is moving — the same set an Alt press at mousedown would have armed.
   * Guarded by the caller, not here: `duplicateUndoRef` being non-null means a
   * copy already exists, and minting a second one would clone the clones.
   */
  const materializeDragDuplicates = () => {
    const sourceIds = [...dragStartElements.current.keys()];
    if (sourceIds.length === 0) return;

    const before = getActivePage(docRef.current).children;

    /**
     * The sources go back where the gesture found them, and the clones are
     * minted on top of those restored positions.
     *
     * Option is read on every frame, so this can run long after the pointer
     * started moving — and by then the sources have been dragged part of the
     * way. Cloning them where they currently stand would split the travel
     * between original and copy and leave the original off its start mark, i.e.
     * a late Option would give a different result from an early one. This unwind
     * is what makes the two identical: the original snaps back to its start and
     * the copy takes over from exactly there, which is the state an
     * Option-from-mousedown gesture is already in when it crosses the threshold.
     */
    const restored = mapElements(before, (el) => {
      const origin = dragStartElements.current.get(el.id);
      if (!origin) return el;
      if (el.type === "text" && el.onPath?.pathId && origin.startOffset !== undefined) {
        return { ...el, onPath: { ...el.onPath, startOffset: origin.startOffset } };
      }
      return moveElementTo(el, origin.x, origin.y);
    });

    const sources: DesignElement[] = [];
    for (const id of sourceIds) {
      const source = findElementById(restored, id);
      if (source) sources.push(source);
    }
    if (sources.length === 0) return;

    const { elements, newIds, rootIdBySource } = insertClones(restored, sources, { x: 0, y: 0 });
    // A clone spliced into an auto-layout parent has to take its stack slot
    // before anything measures it, or the drag picks it up from a stale offset.
    const needsStackSlot = newIds.some((id) => Boolean(layoutOf(findParentById(elements, id))));
    const laidOut = needsStackSlot ? relayoutDocumentTree(elements) : elements;
    setDoc((prev) => {
      const nextDoc = updateActivePageElements(prev, laidOut);
      return nextDoc;
    });

    const after = getActivePage(docRef.current).children;
    const cloneIds = new Set<string>();
    const cloneOrigins = new Map<string, DragOrigin>();
    for (const cloneId of rootIdBySource.values()) {
      const clone = findElementById(after, cloneId);
      if (!clone) continue;
      cloneIds.add(cloneId);
      cloneOrigins.set(cloneId, { x: clone.x, y: clone.y });
    }
    if (cloneIds.size === 0) return;

    // The way back is recorded BEFORE the drag refs are re-based onto the clones:
    // `dragStartElements` at this instant is the sources' own map, which is
    // exactly what the drag has to go back to.
    duplicateUndoRef.current = {
      cloneIds: [...cloneIds],
      origins: new Map(dragStartElements.current),
      selection: new Set(dragSelectionRef.current),
      primary: dragPrimary.current
    };

    // The copies stand exactly on the sources' restored marks, so the drag's
    // per-frame move lands them where the pointer is — unless a stack parent
    // re-slotted them, which is why the origins are re-read rather than assumed.
    dragStartElements.current = cloneOrigins;
    dragSelectionRef.current = cloneIds;
    dragSnapExcludeRef.current = new Set(
      sources.flatMap((source) => [source.id, ...collectDescendantIds(source)])
    );
    setSelectedIds(cloneIds);

    const primaryCloneId = dragPrimary.current
      ? rootIdBySource.get(dragPrimary.current.id)
      : undefined;
    const nextPrimary = primaryCloneId ? findElementById(after, primaryCloneId) : null;
    if (nextPrimary) {
      const parentOrigin = computeParentOrigin(after, nextPrimary.id);
      dragPrimary.current = {
        id: nextPrimary.id,
        box: elementWorldAABB(nextPrimary, parentOrigin.x, parentOrigin.y)
      };
    } else {
      dragPrimary.current = null;
    }
  };

  /**
   * Take a provisional duplicate back: delete the clones and re-base the drag
   * onto the sources they were minted from — which are still standing on their
   * start marks, because the mint is what put them back there.
   *
   * The drag itself is untouched: the caller re-applies one frame afterwards, so
   * the original ends up where the pointer is rather than on the mark it was
   * restored to. Returns whether there was anything to take back, which is the
   * caller's cue to re-apply.
   */
  const revertDragDuplicates = (): boolean => {
    const undo = duplicateUndoRef.current;
    if (!undo) return false;
    duplicateUndoRef.current = null;

    let stripped = getActivePage(docRef.current).children;
    let restacked = false;
    for (const id of undo.cloneIds) {
      // A clone spliced into an auto-layout parent took a slot of its own, so
      // deleting it has to run the stack again or the gap stays open.
      if (layoutOf(findParentById(stripped, id))) restacked = true;
      stripped = removeElementFromTree(stripped, id)[0];
    }
    setDoc((prev) =>
      updateActivePageElements(prev, restacked ? relayoutDocumentTree(stripped) : stripped)
    );

    dragStartElements.current = undo.origins;
    dragSelectionRef.current = undo.selection;
    dragSnapExcludeRef.current = new Set<string>();
    dragPrimary.current = undo.primary;
    setSelectedIds(undo.selection);
    return true;
  };

  const applyDragFrame = (clientX: number, clientY: number, shiftKey: boolean, altKey: boolean) => {
    const screenDist = Math.hypot(clientX - dragStartMouse.current.x, clientY - dragStartMouse.current.y);
    if (!hasMovedBeyondThreshold.current) {
      if (screenDist < 3) return;
      hasMovedBeyondThreshold.current = true;
    }

    /**
     * Alt/Option is asked on EVERY frame, not once at mousedown, and the
     * duplicate it arms is PROVISIONAL for the whole gesture: the copy exists
     * while the key is down and is taken back the moment it comes up, so a drag
     * only lands as a duplicate if the key is still held when the button is
     * released. Both directions live here because this is the only place that
     * knows the key and the pointer at the same instant — the key handler in
     * `useCanvasGestures` simply re-runs one frame on the bare key event.
     */
    if (altKey) {
      if (!duplicateUndoRef.current) materializeDragDuplicates();
    } else {
      revertDragDuplicates();
    }

    let totalDx = Math.round((clientX - dragStartMouse.current.x) / zoom);
    let totalDy = Math.round((clientY - dragStartMouse.current.y) / zoom);

    /**
     * Shift constrains the move to ONE axis — and only that axis.
     *
     * The dominant axis is chosen from the raw pointer delta, before any snap has
     * spoken, so a guide cannot influence which axis gets locked. The locked axis
     * is then held at exactly zero, which is the whole constraint: an element
     * dragged on a horizontal line never wanders vertically.
     *
     * Snapping is NOT skipped. Snapping ON the locked axis is the whole reason to
     * constrain: the point of shift-drag is to slide a layer along a line until it
     * clicks into alignment, and dropping the guides takes that away. Only the
     * free axis's snap result is discarded, because a zero delta has no position
     * to snap to — an earlier version skipped the snap entirely, which made
     * shift-drag strictly less capable than a plain drag.
     */
    const lockX = shiftKey && Math.abs(totalDx) < Math.abs(totalDy);
    const lockY = shiftKey && !lockX;
    if (lockX) totalDx = 0;
    if (lockY) totalDy = 0;

    const primary = dragPrimary.current;
    if (primary) {
      const startBox = primary.box;
      const rect = currentContainerRect();
      const draggedIds = dragSelectionRef.current;
      const pageCanvas = getActivePage(docRef.current).canvas;
      {
        const vp = rect ? calculateVisibleViewport(pan, zoom, rect.width, rect.height, 0) : null;
        const snapExcluded = dragSnapExcludeRef.current;
        /**
         * The candidates are re-listed only when the gesture's inputs change.
         *
         * Listing them costs two whole-page walks — `flattenElements` and the
         * parent-origin map — both keyed on the page array, which the drag
         * replaces on every frame because the dragged element moved. Nothing
         * ELSE moves during a drag (a restack happens on the drop, in a commit),
         * so the list is the same frame after frame; the dragged set and the
         * excluded set are compared by identity, which is how an Alt-duplicate
         * and its revert invalidate it, and the viewport is part of the key
         * because a wheel can still zoom mid-drag.
         */
        const vpKey = vp ? `${vp.x}|${vp.y}|${vp.width}|${vp.height}` : "";
        const cached = snapCacheRef.current;
        const reusable =
          cached &&
          cached.dragged === draggedIds &&
          cached.excluded === snapExcluded &&
          cached.viewportKey === vpKey;
        const siblings = reusable
          ? cached.list
          : measureSpan("fish.snapCandidates", () => {
              const list = snapCandidates(getActivePage(docRef.current).children, draggedIds, snapExcluded, vp);
              snapCacheRef.current = { dragged: draggedIds, excluded: snapExcluded, viewportKey: vpKey, list };
              return list;
            });
        const snap = calculateSnapping(
          { x: startBox.x + totalDx, y: startBox.y + totalDy, width: startBox.width, height: startBox.height },
          pageCanvas.width,
          pageCanvas.height,
          siblings
        );
        // Only the free axis may be moved by a guide; the locked one keeps the
        // exact start position. A `vertical` guide is a VERTICAL LINE and so marks
        // an X alignment — keeping the other orientation would leave a guide drawn
        // along an axis the element is provably not sitting on.
        if (lockX) {
          totalDy = Math.round(snap.snappedY - startBox.y);
          setActiveGuides(snap.guides.filter((g) => g.orientation === "horizontal"));
        } else if (lockY) {
          totalDx = Math.round(snap.snappedX - startBox.x);
          setActiveGuides(snap.guides.filter((g) => g.orientation === "vertical"));
        } else {
          totalDx = Math.round(snap.snappedX - startBox.x);
          totalDy = Math.round(snap.snappedY - startBox.y);
          setActiveGuides(snap.guides);
        }
      }

      const curCx = startBox.x + totalDx + startBox.width / 2;
      const curCy = startBox.y + totalDy + startBox.height / 2;
      // Neither forbidden destination may light up — the drop into it is refused on
      // mouse up, so promising it here would be a lie. Excluding an id hides its
      // whole subtree, which is exactly the extent of the structural rules
      // (`reparentRefusal`).
      //
      // A component set is excluded from a variant's targets for the same reason a
      // component is: the drop is refused, because a variant's landing parent has
      // to be the set it already belongs to.
      const draggedEl = findElementById(getActivePage(docRef.current).children, primary.id);
      const forbidden =
        draggedEl?.type === "component"
          ? flattenElements(getActivePage(docRef.current).children)
              .filter((el) => el.type === "component" || el.type === "componentSet")
              .map((el) => el.id)
          : [ownMasterId(draggedEl)].filter((id): id is string => Boolean(id));
      const target = findFrameAtPoint(getActivePage(docRef.current).children, curCx, curCy, [primary.id, ...forbidden]);
      const parentId = findParentById(getActivePage(docRef.current).children, primary.id)?.id ?? null;
      // Figma parity: the frame the element already lives in never highlights;
      // only a genuinely new container flashes as a drop target (including a
      // target frame for a top-level frame being dragged in).
      const nextHighlight = target && target.id !== parentId ? target.id : null;
      setDragOverFrameId(nextHighlight);

      if (rect) {
        const worldX = ((clientX - rect.left) - pan.x) / zoom;
        const worldY = ((clientY - rect.top) - pan.y) / zoom;
        const targetId = nextHighlight ?? parentId;
        const container = targetId ? findElementById(getActivePage(docRef.current).children, targetId) : null;
        // A child that left the flow is not arranged by the stack, so a slot in
        // that stack is meaningless: reordering it would only change its z-order
        // while the drag itself moves it. The drop indicator stays off.
        const draggedIsFree = Array.from(draggedIds).some(
          (id) => findElementById(getActivePage(docRef.current).children, id)?.position === "absolute"
        );
        if (container && isContainer(container) && layoutOf(container) && !draggedIsFree) {
          const parentOrigin = computeParentOrigin(getActivePage(docRef.current).children, container.id);
          const containerWorldOrigin = { x: parentOrigin.x + container.x, y: parentOrigin.y + container.y };
          const slot = nextHighlight && nextHighlight !== parentId
            ? computeAppendSlot(container, draggedIds, containerWorldOrigin)
            : computeDropSlot(container, draggedIds, { x: worldX, y: worldY }, containerWorldOrigin);
          dropSlotRef.current = slot;
          dropSlotParentRef.current = container.id;
          setDropSlot(slot);
        } else if (dropSlotRef.current) {
          dropSlotRef.current = null;
          dropSlotParentRef.current = null;
          setDropSlot(null);
        }
      }
    }

    setDoc((prev) => {
      const nextDoc = updateActivePageElements(
        prev,
        mapElements(getActivePage(prev).children, (el) => {
          const origin = dragStartElements.current.get(el.id);
          if (origin) {
            // Figma parity: dragging a text-on-path slides the run along its
            // path; the stored box is renderer-owned (measured glyphs), so a
            // plain translate would be invisible.
            if (el.type === "text" && el.onPath?.pathId && origin.startOffset !== undefined) {
              const next = slideStartOffset(origin.startOffset, totalDx, totalDy, el.id);
              return next === null ? el : { ...el, onPath: { ...el.onPath, startOffset: next } };
            }
            return moveElementTo(el, origin.x + totalDx, origin.y + totalDy);
          }
          return el;
        })
      );
      return nextDoc;
    });
  };
  return { materializeDragDuplicates, revertDragDuplicates, applyDragFrame };
}
