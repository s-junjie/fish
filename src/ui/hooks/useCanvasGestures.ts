import { useState, useRef, useEffect } from "preact/hooks";
import { getActivePage } from "../../core/dsl/types";
import { DesignDocument, DesignElement, TextElement, ContainerElement, Paint, updateActivePageElements } from "../../core/dsl/types";
import { applyAutoLayout, relayoutDocumentTree, sortChildrenByLayoutOrder, applyDropSlot, DropSlot } from "../../core/compile";
import { layoutOf } from "../../core/dsl/layout-flat";
import { GuideLine } from "../../core/geometry/snap-guides";
import { elementAABB } from "../../core/geometry/element-bounds";
import type { ReparentRefusal } from "../../core/geometry/tree-ops";
import { t } from "../../i18n";
import { ToolType } from "../../core/tools";
import { createRafCoalescer } from "../raf";
import { measureSpan } from "../../core/perf";
import { findElementById, mapElements, isContainer, findParentById, reparentOnCanvasDrop } from "../../core/geometry/tree-ops";
import { MeasureResult } from "../../core/geometry/measure-guides";
import {
  isCreatableTool,
  computeShapeDraftBounds,
  getDefaultShapeBounds,
  isSelectingTool,
  ShapeDraftGeometry
} from "../../core/geometry/shape-creation";
import { ScaleAnchor, DEFAULT_SCALE_ANCHOR } from "../../core/interactions/scale-ops";
import { createElementClick } from "./canvas-gestures/element-click";
import { createGeometryGestures } from "./canvas-gestures/geometry-gestures";
import { createGradientGesture } from "./canvas-gestures/gradient-gesture";
import { createImageCropGesture, type CropPinFrame } from "./canvas-gestures/image-crop-gesture";
import { requestImagePaintOpen } from "./image-paint-open";
import { setImageCropTarget } from "./image-crop-edit";
import { createMultiResizeGesture } from "./canvas-gestures/multi-resize-gesture";
import { createDragApply, DuplicateUndo, type SnapCandidateCache } from "./canvas-gestures/drag-apply";
import { createCanvasHover } from "./canvas-gestures/canvas-hover";
import { commitCreatedShape } from "./canvas-gestures/shape-creation";

interface UseCanvasGesturesOptions {
  docRef: { current: DesignDocument };
  setDoc: (updater: (prev: DesignDocument) => DesignDocument) => void;
  selectedIds: Set<string>;
  setSelectedIds: (ids: Set<string>) => void;
  primarySelected: DesignElement | null;
  activeTool: ToolType;
  setActiveTool: (tool: ToolType) => void;
  zoom: number;
  pan: { x: number; y: number };
  isPanMode: boolean;
  /** Live pan-mode snapshot for memoized node handlers (see element-click). */
  isPanModeRef: { current: boolean };
  startCanvasPan: (x: number, y: number) => void;
  updateCanvasPan: (x: number, y: number) => boolean;
  endCanvasPan: () => void;
  canvasContainerRef: { current: HTMLDivElement | null };
  startDragGesture: () => void;
  endDragGesture: () => void;
  commitSnapshot: (doc: DesignDocument) => void;
  setHintMessage: (msg: string) => void;
  startCanvasTextEdit: (el: TextElement) => void;
  editingPathId?: string | null;
  scaleAnchor?: ScaleAnchor;
  onAnchorMarquee?: (
    box: { minX: number; minY: number; maxX: number; maxY: number },
    modifiers: { shiftKey: boolean; altKey: boolean },
    isClick: boolean
  ) => void;
  onCommentAtElement?: (el: DesignElement, point: { x: number; y: number }) => void;
  onCommentAtCanvas?: (point: { x: number; y: number }) => void;
}

/**
 * The Scale tool is `select` with a different resize, so the switch lives here
 * rather than in a second tool identity: everything that asks "is this the scale
 * tool?" must get the same answer as the resize handler's.
 */
const isScalingTool = (tool: ToolType): boolean => tool === "scale";

/**
 * The rubber band, and what pressing it would do.
 *
 * `subtract` travels with the box rather than being read at the release, because
 * Option can go down halfway through a drag and the user needs to see that the box
 * they are drawing has changed its mind. A band that kept painting itself the
 * colour of a plain selection while the gesture underneath became a subtraction is
 * a lie for as long as the drag lasts.
 */
export interface MarqueeRect {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Option is down: the box REMOVES what it encloses. */
  subtract: boolean;
}

/** `selection` minus everything in `remove`, as a new Set — the two are disjoint by construction. */
const without = (selection: Set<string>, remove: Set<string>): Set<string> => {
  if (remove.size === 0) return new Set(selection);
  const next = new Set(selection);
  for (const id of remove) next.delete(id);
  return next;
};

/** `selection` plus everything in `add`, as a new Set. */
const with_ = (selection: Set<string>, add: Set<string>): Set<string> => {
  if (add.size === 0) return new Set(selection);
  return new Set([...selection, ...add]);
};

export function useCanvasGestures({
  docRef,
  setDoc,
  selectedIds,
  setSelectedIds,
  primarySelected,
  activeTool,
  setActiveTool,
  zoom,
  pan,
  isPanMode,
  isPanModeRef,
  startCanvasPan,
  updateCanvasPan,
  endCanvasPan,
  canvasContainerRef,
  startDragGesture,
  endDragGesture,
  commitSnapshot,
  setHintMessage,
  startCanvasTextEdit,
  editingPathId,
  scaleAnchor = DEFAULT_SCALE_ANCHOR,
  onAnchorMarquee,
  onCommentAtElement,
  onCommentAtCanvas
}: UseCanvasGesturesOptions) {
  const [dragOverFrameId, setDragOverFrameId] = useState<string | null>(null);
  const [dropSlot, setDropSlot] = useState<DropSlot | null>(null);
  const [activeGuides, setActiveGuides] = useState<GuideLine[]>([]);
  const [marqueeRect, setMarqueeRect] = useState<MarqueeRect | null>(null);
  const [measurement, setMeasurement] = useState<MeasureResult | null>(null);
  const [shapeDraft, setShapeDraft] = useState<ShapeDraftGeometry | null>(null);
  const [hoverSelectId, setHoverSelectId] = useState<string | null>(null);
  const hoverSelectIdRef = useRef<string | null>(null);
  // Mirrored for the same reason `isPanModeRef` is: a memoized node's handler can
  // be a render behind, and a selection is read by a click, not by a render.
  const selectedIdsRef = useRef(selectedIds);
  selectedIdsRef.current = selectedIds;
  const panRef = useRef(pan);
  panRef.current = pan;
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const editingPathIdRef = useRef(editingPathId);
  editingPathIdRef.current = editingPathId;

  const isDraggingElements = useRef(false);
  const hasMovedBeyondThreshold = useRef(false);
  const isMarqueeActive = useRef(false);
  /**
   * The selection as it stood when the marquee STARTED.
   *
   * Read at the mouseup it would be empty: the press that opens a marquee clears
   * the selection (a box is a new answer), so an Option marquee read its own
   * starting line and subtracted from nothing — which the `size > 0` guard then
   * turned into a plain replace, which is how "Option+marquee" silently became a
   * no-op modifier. The subtraction is against the selection the user drew the box
   * around, so that is what has to be kept.
   */
  const marqueeStartSelection = useRef<Set<string>>(new Set());
  const marqueeBox = useRef<{ startX: number; startY: number; curX: number; curY: number } | null>(null);
  const dragStartMouse = useRef({ x: 0, y: 0 });
  const dragStartElements = useRef<Map<string, { x: number; y: number; startOffset?: number }>>(new Map());
  const dragPrimary = useRef<{ id: string; box: { x: number; y: number; width: number; height: number } } | null>(null);
  // The ids the in-flight drag actually moves. An Alt/Option drag swaps this to
  // the ids of the clones it just minted, which is why the per-frame move and
  // the mouseup commit read the ref instead of the render's `selectedIds`.
  const dragSelectionRef = useRef<Set<string>>(new Set());
  // Ids the drag must not snap against: the subtrees an Alt/Option drag cloned
  // from, which sit exactly on top of the copies it is moving.
  const dragSnapExcludeRef = useRef<Set<string>>(new Set());
  /**
   * The drag's snap candidates, held for the gesture rather than the frame.
   *
   * Listing them walks the whole page twice, and both walks are keyed on the
   * page array the drag rebuilds every frame. Nothing but the dragged elements
   * moves until the drop commits, so the list stands until its two input sets
   * (compared by identity) or the viewport change.
   */
  const snapCacheRef = useRef<SnapCandidateCache | null>(null);
  /**
   * A provisional Alt/Option duplicate, and the way back from it.
   *
   * Non-null exactly while a copy exists in the document, so it doubles as the
   * "are we duplicating?" flag: the copy is created when the key goes down and
   * deleted when it comes up, and it only survives to the mouseup if the key is
   * still held there.
   */
  const duplicateUndoRef = useRef<DuplicateUndo | null>(null);
  /**
   * The freshest pointer a drag frame was pushed at. A bare modifier press has no
   * pointer event of its own, so the Alt handler re-runs the drag from here —
   * otherwise pressing Option, or releasing it to call the copy off, would go
   * unnoticed until the pointer moved again.
   */
  const lastDragPointerRef = useRef<{ x: number; y: number; shiftKey: boolean } | null>(null);
  // The slot the drop will use. Kept in a ref as well as state because the
  // mouseup handler has to commit exactly what the indicator last showed.
  const dropSlotRef = useRef<DropSlot | null>(null);
  const dropSlotParentRef = useRef<string | null>(null);

  const isDrawingShape = useRef(false);
  const shapeDrawStart = useRef<{ x: number; y: number } | null>(null);
  const shapeDrawCurrent = useRef<{ x: number; y: number } | null>(null);

  // Drag moves are collapsed to one document commit per frame; the coalescer
  // outlives renders, so it dispatches through a ref holding the latest closure.
  // `altKey` is part of the payload because the duplicate is decided per frame,
  // not once at mousedown.
  const dragApplyRef = useRef<(clientX: number, clientY: number, shiftKey: boolean, altKey: boolean) => void>(() => { });
  const dragCoalescerRef = useRef<ReturnType<
    typeof createRafCoalescer<{ x: number; y: number; shiftKey: boolean; altKey: boolean }>
  > | null>(null);
  if (!dragCoalescerRef.current) {
    dragCoalescerRef.current = createRafCoalescer<{ x: number; y: number; shiftKey: boolean; altKey: boolean }>((v) =>
      measureSpan("fish.dragFrame", () => dragApplyRef.current(v.x, v.y, v.shiftKey, v.altKey))
    );
  }

  // Re-applies one drag frame on a bare Alt press/release. Written as a ref
  // because the handler below is registered once and must not close over a stale
  // gesture; `applyDragFrame` is rebuilt every render.
  const revertDuplicatesRef = useRef<() => boolean>(() => false);

  // The container rect is stable for the duration of a gesture, so it is read
  // once on mousedown; re-reading it per move forces a synchronous layout flush
  // on every input event.
  const containerRectRef = useRef<DOMRect | null>(null);
  const measureContainer = () => {
    const container = canvasContainerRef.current;
    if (!container) return null;
    const rect = container.getBoundingClientRect();
    containerRectRef.current = rect;
    return rect;
  };
  const currentContainerRect = () => containerRectRef.current ?? measureContainer();

  /**
   * Alt/Option during an element drag, handled on the KEY rather than on the
   * pointer.
   *
   * A modifier press is not a pointer event, so a user who presses Option and
   * holds the mouse still — or releases it to call the duplicate off — would get
   * no feedback until they moved again. Both directions re-run a single drag
   * frame at the last known pointer, which is where the mint and the take-back
   * both live.
   *
   * The coalescer is flushed FIRST: a pointermove that landed in the same frame
   * as the key event is still queued, and letting it apply afterwards would
   * re-mint the copy we were just asked to take back.
   */
  useEffect(() => {
    const handleAltChange = (e: KeyboardEvent) => {
      if (e.key !== "Alt" || e.repeat) return;
      if (!e.altKey) setMeasurement(null);
      if (!isDraggingElements.current || !hasMovedBeyondThreshold.current) return;
      const pointer = lastDragPointerRef.current;
      if (!pointer) return;
      dragCoalescerRef.current?.flush();
      dragApplyRef.current(pointer.x, pointer.y, pointer.shiftKey, e.altKey);
    };
    window.addEventListener("keydown", handleAltChange);
    window.addEventListener("keyup", handleAltChange);
    return () => {
      window.removeEventListener("keydown", handleAltChange);
      window.removeEventListener("keyup", handleAltChange);
    };
  }, []);

  // Dynamic Shift / Alt / Escape handling during active shape drawing
  useEffect(() => {
    const handleKeyChange = (e: KeyboardEvent) => {
      if (e.isComposing || (e as any).keyCode === 229) return;
      if (e.key === "Escape" && isDrawingShape.current) {
        isDrawingShape.current = false;
        shapeDrawStart.current = null;
        shapeDrawCurrent.current = null;
        setShapeDraft(null);
        setDragOverFrameId(null);
        return;
      }
      if (
        isDrawingShape.current &&
        shapeDrawStart.current &&
        shapeDrawCurrent.current &&
        isCreatableTool(activeTool)
      ) {
        const draft = computeShapeDraftBounds(
          activeTool,
          shapeDrawStart.current,
          shapeDrawCurrent.current,
          { shiftKey: e.shiftKey, altKey: e.altKey }
        );
        setShapeDraft(draft);
      }
    };
    window.addEventListener("keydown", handleKeyChange);
    window.addEventListener("keyup", handleKeyChange);
    return () => {
      window.removeEventListener("keydown", handleKeyChange);
      window.removeEventListener("keyup", handleKeyChange);
    };
  }, [activeTool]);

  // Global mouse up for element dragging & marquee selection
  const handleGlobalMouseUp = (e: MouseEvent) => {
      if (isDraggingElements.current) {
        dragCoalescerRef.current?.flush();
        /**
         * The duplicate is provisional until the button comes up, and this is
         * where it is settled — from the event's OWN modifier state, not from
         * whatever the last frame happened to see. A keyup landing in the same
         * instant as the mouseup can lose the race to the key handler, so the
         * gesture's outcome is decided here.
         *
         * The drag is re-applied straight after, because taking the copy back
         * must not also take back the move: the original has to end up under the
         * pointer, not on the start mark the mint restored it to.
         */
        if (!e.altKey && revertDuplicatesRef.current()) {
          dragApplyRef.current(e.clientX, e.clientY, e.shiftKey, false);
        }
        const draggedIds = dragSelectionRef.current;
        let currentElements = getActivePage(docRef.current).children;
        let structuralChange = false;

        // Only reparent if pointer actually dragged beyond threshold
        if (hasMovedBeyondThreshold.current) {
          let refused: ReparentRefusal | null = null;
          for (const id of draggedIds) {
            const res = reparentOnCanvasDrop(currentElements, id);
            if (res.reparented) {
              currentElements = res.elements;
              structuralChange = true;
            }
            // A refused drop keeps the position it was dragged to — only the
            // nesting is rejected, and a refusal nobody can see is the same
            // silent no-op the gesture work set out to remove (§5.3).
            if (res.refused) refused = res.refused;
          }
          if (refused === "instance-in-own-master") setHintMessage(t("component.selfNestingInstance"));
          else if (refused === "component-in-component") setHintMessage(t("component.nestedMaster"));
          else if (refused === "variant-out-of-set") setHintMessage(t("component.variantOutOfSet"));
        }

        // Reorder inside the container the drag stayed in. The slot was chosen
        // while dragging and is committed as-is, which also makes a multi-select
        // drag reorder: every selected sibling moves to the slot together.
        if (!structuralChange) {
          const movedAny = Array.from(draggedIds).some((id) => {
            const nowEl = findElementById(currentElements, id);
            const origin = dragStartElements.current?.get(id);
            return !!nowEl && !!origin && Math.hypot(nowEl.x - origin.x, nowEl.y - origin.y) > 2;
          });
          const slot = dropSlotRef.current;
          const slotParent = dropSlotParentRef.current
            ? findElementById(currentElements, dropSlotParentRef.current)
            : null;
          // Fall back to the container of the first selected element: the slot
          // is only known while the pointer is being tracked.
          const fallbackParent = slotParent ?? (() => {
            for (const id of draggedIds) {
              const p = findParentById(currentElements, id);
              if (p && layoutOf(p)) return p;
            }
            return null;
          })();
          const parentFrame = fallbackParent && isContainer(fallbackParent) ? fallbackParent : null;

          if (movedAny && parentFrame && layoutOf(parentFrame)) {
            const children = parentFrame.children ?? [];
            // Only in-flow children take part in an order change — a child that
            // left the flow is not arranged by the stack, so touching its index
            // would shuffle its z-order while the drag is meant to move it.
            const moving = children.filter((c) => draggedIds.has(c.id) && c.position !== "absolute");
            if (moving.length > 0 && moving.length < children.length) {
              let nextChildren: DesignElement[];
              if (slot && slotParent) {
                // Commit exactly the slot that was on screen.
                nextChildren = applyDropSlot(parentFrame, draggedIds, slot.index);
              } else {
                // No pointer-driven slot (a programmatic move): fall back to the
                // canonical reading order of the boxes as they now sit.
                nextChildren = sortChildrenByLayoutOrder({ ...parentFrame, children } as ContainerElement);
              }
              currentElements = mapElements(currentElements, (e) =>
                e.id === parentFrame.id ? ({ ...parentFrame, children: nextChildren } as DesignElement) : e
              );
              structuralChange = true;
            }
          }
        }

        if (structuralChange) {
          // The whole tree, not just the frames this drop touched: a nested frame
          // that is re-placed (or resized by `fill`) needs its own layout pass to
          // run afterwards, otherwise its children keep the previous box's offsets.
          const nextDoc = updateActivePageElements(docRef.current, relayoutDocumentTree(currentElements));
          setDoc(() => nextDoc);
        }

        setDragOverFrameId(null);
        setDropSlot(null);
        dropSlotRef.current = null;
        dropSlotParentRef.current = null;
        endDragGesture();
      }

      endCanvasPan();
      isDraggingElements.current = false;
      hasMovedBeyondThreshold.current = false;
      dragPrimary.current = null;
      // A duplicate only ever lives inside one gesture, and the pointer that
      // drove it is meaningless to the next one. The snap list goes with them:
      // it holds boxes read from the tree this gesture was mutating, and only a
      // fresh listing can be trusted to describe the tree the next one starts on.
      duplicateUndoRef.current = null;
      lastDragPointerRef.current = null;
      snapCacheRef.current = null;
      setActiveGuides([]);

      if (isMarqueeActive.current && marqueeBox.current) {
        isMarqueeActive.current = false;
        const box = marqueeBox.current;
        const minX = Math.min(box.startX, box.curX);
        const maxX = Math.max(box.startX, box.curX);
        const minY = Math.min(box.startY, box.curY);
        const maxY = Math.max(box.startY, box.curY);

        // A press that never moved is a CLICK on the canvas, not a marquee, and
        // the two must not resolve alike. The containment test below is strict
        // (`box.x < maxX && box.x + box.width > minX`), so at zero width and zero
        // height it collapses to "this element's AABB contains the point" — and
        // then a single click on empty canvas selects every unlocked layer
        // stacked under the cursor, which is the exact bug LESSONS §75 recorded
        // against locked layers swallowing the press. It is reachable again now
        // that a locked layer is DOM-transparent: the press passes through the
        // lock, misses every hit target behind it, and lands here.
        //
        // The threshold is in SCREEN pixels (marquee math is in world units, so
        // it is scaled by zoom) and small on purpose: enough to absorb the
        // sub-pixel jitter of a real click, far short of any drag a user means.
        const currentZoom = zoomRef.current;
        const dragPx = Math.max(maxX - minX, maxY - minY) * currentZoom;
        if (editingPathIdRef.current) {
          marqueeBox.current = null;
          setMarqueeRect(null);
          onAnchorMarquee?.(
            { minX, minY, maxX, maxY },
            { shiftKey: e.shiftKey, altKey: e.altKey },
            dragPx < 3
          );
          return;
        }
        if (dragPx < 3) {
          marqueeBox.current = null;
          setMarqueeRect(null);
        } else {
          const enclosed = new Set<string>();
          for (const el of getActivePage(docRef.current).children) {
            // A locked layer is not selectable on the canvas, marquee included: the
            // gesture that follows a marquee would drag it.
            if (el.locked) continue;
            const box = elementAABB(el);
            if (
              box.x < maxX &&
              box.x + box.width > minX &&
              box.y < maxY &&
              box.y + box.height > minY
            ) {
              enclosed.add(el.id);
            }
          }
/**
           * Three verbs for one box, from the two modifiers the press already
           * reads for its duplicate and axis-lock:
           *
           *  - plain — the box IS the answer. Replaces, which is what a marquee has
           *    always done and what every other tool expects from a rubber band.
           *  - Shift — ADD what the box encloses. It was the one combination that
           *    did nothing different: the press skipped the clear (so the old
           *    selection survived) and the release still replaced, so Shift made a
           *    marquee behave exactly like a plain one.
           *  - Option — SUBTRACT, the same word Option+click uses on a layer.
           *
           * Option wins when both are held: it is the stronger "take this out", and
           * a Shift+Option box that added would have no reading that is neither.
           */
          const start = marqueeStartSelection.current;
          const next = e.altKey && start.size > 0
            ? without(start, enclosed)
            : e.shiftKey
              ? with_(start, enclosed)
              : enclosed;
          setSelectedIds(next);
          marqueeBox.current = null;
          setMarqueeRect(null);
        }
      }
      if (isDrawingShape.current && shapeDrawStart.current && isCreatableTool(activeTool)) {
        const container = canvasContainerRef.current;
        let cur = shapeDrawCurrent.current || shapeDrawStart.current;
        if (container && typeof e.clientX === "number" && typeof e.clientY === "number") {
          const rect = container.getBoundingClientRect();
          const worldX = Math.round(((e.clientX - rect.left) - panRef.current.x) / zoomRef.current);
          const worldY = Math.round(((e.clientY - rect.top) - panRef.current.y) / zoomRef.current);
          cur = { x: worldX, y: worldY };
        }
        const start = shapeDrawStart.current;
        isDrawingShape.current = false;
        shapeDrawStart.current = null;
        shapeDrawCurrent.current = null;
        setShapeDraft(null);
        setDragOverFrameId(null);

        const dist = Math.hypot(cur.x - start.x, cur.y - start.y);
        const finalGeom = dist >= 3
          ? computeShapeDraftBounds(activeTool, start, cur, { shiftKey: Boolean(e.shiftKey), altKey: Boolean(e.altKey) })
          : getDefaultShapeBounds(activeTool, start);

        commitCreatedShape({
          finalGeom,
          dist,
          docRef,
          commitSnapshot,
          setSelectedIds,
          setActiveTool,
          startCanvasTextEdit
        });
      }
      containerRectRef.current = null;
    };

  const mouseUpRef = useRef<(e: MouseEvent) => void>(() => {});
  mouseUpRef.current = handleGlobalMouseUp;

  useEffect(() => {
    const handleUp = (e: MouseEvent) => mouseUpRef.current(e);
    window.addEventListener("mouseup", handleUp);
    return () => window.removeEventListener("mouseup", handleUp);
  }, []);

  const handleCanvasMouseDown = (e: MouseEvent) => {
    if (hoverSelectIdRef.current) {
      hoverSelectIdRef.current = null;
      setHoverSelectId(null);
    }
    if (isPanMode || e.button === 1 || (e as any).spaceKey) {
      if (e.button === 1) e.preventDefault();
      startCanvasPan(e.clientX, e.clientY);
      return;
    }

    // Everything below is a primary-button gesture: draw a shape, marquee, deselect.
    // A right press belongs to the context menu, and the marquee branch in
    // particular deselects first — so a plain right-click on a layer used to empty
    // the selection and then re-select whatever the degenerate box happened to
    // contain. The element click handler bails on `button !== 0` for the same
    // reason and lets the press reach here (LESSONS §16), which means THIS is
    // where the bail-out has to be: the comment above describing a guard that was
    // not in the code is how a right-click emptied the selection while the code
    // read as though it could not.
    if (e.button !== 0) return;
    if (editingPathIdRef.current) {
      const rect = measureContainer();
      if (!rect) return;
      const worldX = Math.round(((e.clientX - rect.left) - panRef.current.x) / zoomRef.current);
      const worldY = Math.round(((e.clientY - rect.top) - panRef.current.y) / zoomRef.current);

      isMarqueeActive.current = true;
      marqueeBox.current = { startX: worldX, startY: worldY, curX: worldX, curY: worldY };
      return;
    }

    if (activeTool === "comment") {
      const rect = measureContainer();
      if (!rect) return;
      const worldX = Math.round(((e.clientX - rect.left) - panRef.current.x) / zoomRef.current);
      const worldY = Math.round(((e.clientY - rect.top) - panRef.current.y) / zoomRef.current);
      onCommentAtCanvas?.({ x: worldX, y: worldY });
      return;
    }

    if (isCreatableTool(activeTool)) {
      const rect = measureContainer();
      if (!rect) return;
      const worldX = Math.round(((e.clientX - rect.left) - panRef.current.x) / zoomRef.current);
      const worldY = Math.round(((e.clientY - rect.top) - panRef.current.y) / zoomRef.current);

      isDrawingShape.current = true;
      shapeDrawStart.current = { x: worldX, y: worldY };
      shapeDrawCurrent.current = { x: worldX, y: worldY };
      const draft = computeShapeDraftBounds(
        activeTool,
        shapeDrawStart.current,
        shapeDrawCurrent.current,
        { shiftKey: e.shiftKey, altKey: e.altKey }
      );
      setShapeDraft(draft);
      return;
    }

    if (isSelectingTool(activeTool)) {
      const rect = measureContainer();
      if (!rect) return;
      const worldX = Math.round(((e.clientX - rect.left) - panRef.current.x) / zoomRef.current);
      const worldY = Math.round(((e.clientY - rect.top) - panRef.current.y) / zoomRef.current);

      isMarqueeActive.current = true;
      marqueeBox.current = { startX: worldX, startY: worldY, curX: worldX, curY: worldY };
      marqueeStartSelection.current = new Set(selectedIdsRef.current);
      // A box is a new answer, so the press clears what was there — but not when a
      // modifier is making the box an EDIT to the selection. Clearing under Shift
      // or Option meant the layers being added to, or subtracted from, blinked out
      // for the whole drag: the user was subtracting from a selection they could
      // not see, which is the one state where a subtractive gesture is unusable.
      if (!e.shiftKey && !e.altKey) {
        setSelectedIds(new Set());
      }
    }
  };

  const { handleCanvasMouseMove } = createCanvasHover({
    docRef,
    zoom,
    zoomRef,
    pan,
    panRef,
    selectedIds,
    primarySelected,
    activeTool,
    editingPathId,
    measurement,
    updateCanvasPan,
    currentContainerRect,
    setMarqueeRect,
    setMeasurement,
    setHoverSelectId,
    setShapeDraft,
    hoverSelectIdRef,
    isMarqueeActive,
    marqueeBox,
    isDraggingElements,
    dragStartElements,
    dragCoalescerRef,
    lastDragPointerRef,
    isDrawingShape,
    shapeDrawStart,
    shapeDrawCurrent
  });

  const handleCanvasClick = () => {
    if (isPanMode) return;
    if (activeTool === "text-on-path") {
      setHintMessage("Click on any shape or path on the canvas to bind text to it.");
      setTimeout(() => setHintMessage(""), 3500);
      return;
    }
  };

  /**
   * What a canvas double-click does to an image fill: open the top-most bitmap's
   * row — the one the user is looking at — and hand the canvas the crop chrome
   * when that row is ALREADY in crop framing.
   *
   * `fit` is never changed, so this is a way into the fill panel and not a way
   * out of the framing the layer paints; but a panel whose Fit segment reads
   * Crop over a canvas showing no crop handles is describing a mode that is not
   * on. Re-entering that mode commits nothing: an image carrying a crop framing
   * already has everything the mode needs, so the gesture is chrome only and
   * must not cost an undo step (`beginImageCrop` would).
   */
  const openImageFillPanel = (el: DesignElement): boolean => {
    const fills = (el.fills ?? []) as Paint[];
    for (let i = fills.length - 1; i >= 0; i--) {
      const fill = fills[i];
      if (fill.type !== "image") continue;
      if (fill.fit === "crop") setImageCropTarget({ elId: el.id, paintIndex: i });
      requestImagePaintOpen(el.id, i);
      return true;
    }
    return false;
  };

  const rawElementMouseDown = createElementClick({
    docRef,
    selectedIds,
    selectedIdsRef,
    setSelectedIds,
    activeTool,
    setActiveTool,
    isPanModeRef,
    editingPathId,
    editingPathIdRef,
    pan,
    panRef,
    zoom,
    zoomRef,
    canvasContainerRef,
    commitSnapshot,
    startCanvasTextEdit,
    openImageFillPanel,
    setShapeDraft,
    setHoverSelectId,
    hoverSelectIdRef,
    isDrawingShape,
    shapeDrawStart,
    shapeDrawCurrent,
    startDragGesture,
    isDraggingElements,
    dragStartMouse,
    dragStartElements,
    dragSelectionRef,
    dragPrimary,
    dragSnapExcludeRef,
    isMarqueeActive,
    marqueeBox,
    onCommentAtElement
  });

  /**
   * A press on a layer is always the canvas's own gesture now.
   *
   * It used to branch on an "active embed": a live frame owned the pointer, so
   * a press on it was dropped and a press anywhere else first left the frame.
   * Nothing takes the pointer from the canvas any more — present mode is a
   * different host with no gestures at all — so there is nothing to leave, and
   * the press goes straight through to selection and drag.
   */
  const handleElementMouseDown = rawElementMouseDown;

  const {
    handleLineEndpointPointerDown,
    handleResizePointerDown,
    handleRotatePointerDown,
    handleRadiusPointerDown,
    handleStartOffsetPointerDown
  } = createGeometryGestures({
    docRef,
    setDoc,
    pan,
    zoom,
    canvasContainerRef,
    startDragGesture,
    endDragGesture,
    scaleMode: isScalingTool(activeTool),
    scaleAnchor,
    setHintMessage,
    currentContainerRect,
    setActiveGuides: (guides) => setActiveGuides(guides)
  });

  const { handleGradientHandlePointerDown } = createGradientGesture({
    docRef,
    setDoc,
    pan,
    zoom,
    canvasContainerRef,
    startDragGesture,
    endDragGesture,
    setHintMessage,
    currentContainerRect,
    setActiveGuides: (guides) => setActiveGuides(guides)
  });

  /**
   * The frame drag in flight, for the crop gesture to re-pin the bitmap against.
   *
   * A ref rather than state because it must not render, and here rather than
   * inside the factory because this hook rebuilds that factory on every render
   * while a drag spans many of them (see `CropPinFrame`).
   */
  const cropFramePinRef = useRef<CropPinFrame | null>(null);

  const {
    handleCropMovePointerDown,
    handleCropHandlePointerDown,
    handleCropRotatePointerDown
  } = createImageCropGesture({
    docRef,
    setDoc,
    pan,
    zoom,
    canvasContainerRef,
    startDragGesture,
    endDragGesture,
    setHintMessage,
    currentContainerRect,
    setActiveGuides: (guides) => setActiveGuides(guides),
    framePinRef: cropFramePinRef
  });

  const { handleMultiResizePointerDown } = createMultiResizeGesture({
    docRef,
    setDoc,
    pan,
    zoom,
    startDragGesture,
    endDragGesture,
    scaleMode: isScalingTool(activeTool),
    scaleAnchor,
    currentContainerRect,
    setActiveGuides: (guides) => setActiveGuides(guides)
  });

  const { applyDragFrame, revertDragDuplicates } = createDragApply({
    docRef,
    setDoc,
    zoom,
    pan,
    currentContainerRect,
    setActiveGuides: (guides) => setActiveGuides(guides),
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
  });
  dragApplyRef.current = applyDragFrame;
  revertDuplicatesRef.current = revertDragDuplicates;

  return {
    dragOverFrameId,
    dropSlot,
    activeGuides,
    marqueeRect,
    shapeDraft,
    measurement,
    hoverSelectId,
    handleCanvasMouseDown,
    handleCanvasMouseMove,
    handleCanvasClick,
    handleElementMouseDown,
    handleResizePointerDown,
    handleMultiResizePointerDown,
    handleRotatePointerDown,
    handleLineEndpointPointerDown,
    handleRadiusPointerDown,
    handleStartOffsetPointerDown,
    handleGradientHandlePointerDown,
    handleCropMovePointerDown,
    handleCropHandlePointerDown,
    handleCropRotatePointerDown
  };
}
