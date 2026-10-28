import { DesignDocument, DesignElement } from "../../../core/dsl/types";
import { getActivePage } from "../../../core/dsl/types";
import {
  findElementAtPoint,
  findElementById
} from "../../../core/geometry/tree-ops";
import { elementAABB } from "../../../core/geometry/element-bounds";
import { transformBoundsToAABB } from "../../../core/geometry/bounds";
import { worldMatrixOf } from "../../../core/interactions/component-swap";
import { computeMeasurement, MeasureResult } from "../../../core/geometry/measure-guides";
import { isCreatableTool, computeShapeDraftBounds, ShapeDraftGeometry } from "../../../core/geometry/shape-creation";
import { ToolType } from "../../../core/tools";
import { resolveSingleClickTarget } from "./targeting";
import { selectionCommonParent, selectionWorldBox } from "./selection-measure";
import type { MarqueeRect } from "../useCanvasGestures";

export interface CanvasHoverContext {
  docRef: { current: DesignDocument };
  zoom: number;
  zoomRef?: { current: number };
  pan: { x: number; y: number };
  panRef?: { current: { x: number; y: number } };
  selectedIds: Set<string>;
  primarySelected: DesignElement | null;
  activeTool: ToolType;
  editingPathId?: string | null;
  measurement: MeasureResult | null;
  updateCanvasPan: (x: number, y: number) => boolean;
  currentContainerRect: () => DOMRect | null;
  setMarqueeRect: (r: MarqueeRect | null) => void;
  setMeasurement: (m: MeasureResult | null) => void;
  setHoverSelectId: (id: string | null) => void;
  setShapeDraft: (g: ShapeDraftGeometry | null) => void;
  hoverSelectIdRef: { current: string | null };
  isMarqueeActive: { current: boolean };
  marqueeBox: { current: { startX: number; startY: number; curX: number; curY: number } | null };
  isDraggingElements: { current: boolean };
  dragStartElements: { current: Map<string, { x: number; y: number; startOffset?: number }> };
  dragCoalescerRef: { current: { push: (v: { x: number; y: number; shiftKey: boolean; altKey: boolean }) => void } | null };
  /**
   * The freshest pointer a drag frame was pushed at. A modifier press carries no
   * coordinates of its own, so the Alt handler re-runs the frame from here.
   */
  lastDragPointerRef: { current: { x: number; y: number; shiftKey: boolean } | null };
  isDrawingShape: { current: boolean };
  shapeDrawStart: { current: { x: number; y: number } | null };
  shapeDrawCurrent: { current: { x: number; y: number } | null };
}

/**
 * A pointer move over the canvas: the shape draft, the Alt affordances (distance
 * measurement, and the duplicate target it must keep quiet about), the drag
 * pump, the marquee, and the hover preview.
 *
 * Extracted from `useCanvasGestures` (AGENTS.md §9). The Alt pair is resolved
 * FIRST so a measurement can never paint over a layer that Alt+drag would copy.
 */
export function createCanvasHover(ctx: CanvasHoverContext) {
  const {
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
  } = ctx;

  const currentPan = panRef?.current ?? pan;
  const currentZoom = zoomRef?.current ?? zoom;

  /**
   * Would an Alt/Option drag starting here grab the layer under the pointer —
   * i.e. is it unlocked and already in the selection?
   *
   * Alt reads two ways off one hover: over such a layer it arms the duplicate,
   * anywhere else it is the distance inspector. Only one of the two may speak,
   * and the duplicate side now says nothing at all — a "+" riding the pointer
   * announced a gesture the user had not started, and Option pressed mid-drag
   * duplicates anyway, so the badge was advertising nothing they needed. What
   * is left of the question is the silence it imposes on the measurement.
   */
  const altOverDuplicateTarget = (clientX: number, clientY: number): boolean => {
    if (isDraggingElements.current || activeTool !== "select" || editingPathId) return false;
    const rect = currentContainerRect();
    if (!rect) return false;
    const worldX = Math.round(((clientX - rect.left) - currentPan.x) / currentZoom);
    const worldY = Math.round(((clientY - rect.top) - currentPan.y) / currentZoom);
    const hit = findElementAtPoint(getActivePage(docRef.current).children, worldX, worldY);
    const targetId = hit
      ? resolveSingleClickTarget(docRef.current, getActivePage(docRef.current).children, hit, selectedIds)
      : null;
    const target = targetId ? findElementById(getActivePage(docRef.current).children, targetId) : null;
    return Boolean(target && !target.locked && selectedIds.has(target.id));
  };

  const handleCanvasMouseMove = (e: MouseEvent) => {
    if (isDrawingShape.current && shapeDrawStart.current && isCreatableTool(activeTool)) {
      const rect = currentContainerRect();
      if (!rect) return;
      const worldX = Math.round(((e.clientX - rect.left) - currentPan.x) / currentZoom);
      const worldY = Math.round(((e.clientY - rect.top) - currentPan.y) / currentZoom);

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

    if (updateCanvasPan(e.clientX, e.clientY)) {
      return;
    }

    if (isDraggingElements.current && dragStartElements.current.size > 0) {
      // `altKey` rides with every frame. Option pressed halfway through a drag
      // has to arm the copy exactly like holding it from the mousedown, and the
      // frame that mints the clones is the first one that reports the key.
      lastDragPointerRef.current = { x: e.clientX, y: e.clientY, shiftKey: e.shiftKey };
      dragCoalescerRef.current?.push({ x: e.clientX, y: e.clientY, shiftKey: e.shiftKey, altKey: e.altKey });
      return;
    } else if (isMarqueeActive.current && marqueeBox.current) {
      const rect = currentContainerRect();
      if (!rect) return;
      const worldX = Math.round(((e.clientX - rect.left) - currentPan.x) / currentZoom);
      const worldY = Math.round(((e.clientY - rect.top) - currentPan.y) / currentZoom);

      marqueeBox.current.curX = worldX;
      marqueeBox.current.curY = worldY;

      const minX = Math.min(marqueeBox.current.startX, worldX);
      const maxX = Math.max(marqueeBox.current.startX, worldX);
      const minY = Math.min(marqueeBox.current.startY, worldY);
      const maxY = Math.max(marqueeBox.current.startY, worldY);

      setMarqueeRect({ x: minX, y: minY, width: maxX - minX, height: maxY - minY, subtract: !!e.altKey });
    } else if (e.altKey && !altOverDuplicateTarget(e.clientX, e.clientY) && primarySelected && selectedIds.size > 0) {
      // Figma parity: Alt/Option hovering inspects distances. The selection is ONE
      // object — a multi-selection measures from the box the chrome frames around
      // all of it, to whatever the pointer is on.
      const rect = currentContainerRect();
      if (rect) {
        const doc = docRef.current;
        const children = getActivePage(doc).children;
        const worldX = Math.round(((e.clientX - rect.left) - currentPan.x) / currentZoom);
        const worldY = Math.round(((e.clientY - rect.top) - currentPan.y) / currentZoom);

        // Every member is excluded, so the pointer passing over the selection
        // reads what lies BENEATH it — the same answer a single selected layer
        // gives — instead of measuring the selection against itself.
        const hovered = findElementAtPoint(children, worldX, worldY, { excludeIds: selectedIds });
        // The box the renderer paints, own turn and ancestors' included: the same
        // matrix the selection chrome frames the artwork with.
        const worldBoxOf = (el: DesignElement) =>
          transformBoundsToAABB(elementAABB(el), worldMatrixOf(doc, el))!;

        const refBox = selectionWorldBox(doc, selectedIds, primarySelected);
        const parent = selectionCommonParent(children, selectedIds);

        if (!refBox) {
          setMeasurement(null);
        } else if (hovered) {
          setMeasurement(computeMeasurement(refBox, worldBoxOf(hovered), parent?.id === hovered.id));
        } else if (parent) {
          // Empty canvas: the padding the selection keeps inside the frame holding it.
          setMeasurement(computeMeasurement(refBox, worldBoxOf(parent), true));
        } else {
          setMeasurement(null);
        }
      }
    } else if (!e.altKey && measurement) {
      setMeasurement(null);
    } else if (!e.altKey && activeTool === "select" && !editingPathId) {
      // Hover preview: outline what a click would select.
      // - Plain hover: the frame-gating-aware single-click target.
      // - Cmd/Ctrl + hover: the exact pierce target (what Cmd/Ctrl-click
      //   selects), so the would-be-selected element is highlighted too.
      // A locked layer is DOM-transparent, so the click lands on whatever is
      // painted beneath it — which is why the probe SKIPS locked layers
      // (`includeLocked` left at its default) rather than reporting one and
      // previewing nothing. Asking for locked layers here and then blanking on
      // them previewed the lock, not the selection the click actually makes.
      const rect = currentContainerRect();
      if (rect) {
        const worldX = Math.round(((e.clientX - rect.left) - currentPan.x) / currentZoom);
        const worldY = Math.round(((e.clientY - rect.top) - currentPan.y) / currentZoom);
        const hit = findElementAtPoint(getActivePage(docRef.current).children, worldX, worldY);
        const pierce = e.metaKey || e.ctrlKey;
        const nextId = !hit
          ? null
          : pierce
            ? hit.id
            : resolveSingleClickTarget(docRef.current, getActivePage(docRef.current).children, hit, selectedIds);
        if (nextId !== hoverSelectIdRef.current) {
          hoverSelectIdRef.current = nextId;
          setHoverSelectId(nextId);
        }
      }
    }
  };
  return { handleCanvasMouseMove };
}
