import {
  ContainerElement,
  DesignDocument,
  DesignElement,
  PathElement,
  RectElement,
  getActivePage,
  updateActivePageElements
} from "../../../core/dsl/types";
import { relayoutDocumentTree, resizeStackWithPins } from "../../../core/compile";
import { layoutOf } from "../../../core/dsl/layout-flat";
import { calculateVisibleViewport } from "../../../core/geometry/cull";
import { snapCandidates } from "../../../core/geometry/snap-candidates";
import { calculateResizeSnapping, GuideLine } from "../../../core/geometry/snap-guides";
import { getRotateCursor } from "../../../core/geometry/transforms";
import { resolveResizeBox } from "../../../core/geometry/resize-box";
import type { ResizeHandleType } from "../../../core/geometry/snap-guides";
import { isLineElement, elementAABB } from "../../../core/geometry/element-bounds";
import { transformBoundsToAABB } from "../../../core/geometry/bounds";
import { containerSizesAxis, modifierResizesOwnBox, resolveAxis, withAxisMode } from "../../../core/geometry/resolve-axis";
import { isAspectLocked as elementIsAspectLocked } from "../../../core/geometry/aspect-lock";
import { scaleElementsToSize, scalableAxes, ScaleAnchor, DEFAULT_SCALE_ANCHOR } from "../../../core/interactions/scale-ops";
import { resizeContainerWithConstraints } from "../../../core/geometry/constraints";
import { setLineEndpoint } from "../../../core/interactions/line-ops";
import { worldMatrixOf, worldOriginOf } from "../../../core/interactions/component-swap";
import { elementPivot, toElementLocal } from "../../../core/geometry/transforms";
import { transformPoint, invert } from "../../../core/geometry/matrix";
import { isDerivedNode } from "../../../core/interactions/component-inventory";
import { writeNodeEdit } from "../../../core/interactions/instance-overrides";
import { parsePathData, serializePathData, scalePathData } from "../../../core/geometry/path-data";
import {
  collectDescendantIds,
  computeParentOrigin,
  findElementById,
  findParentById,
  isContainer,
  mapElements
} from "../../../core/geometry/tree-ops";
import { createRafCoalescer } from "../../raf";
import { t } from "../../../i18n";

const NO_IDS: ReadonlySet<string> = new Set();

export interface GeometryGestureContext {
  docRef: { current: DesignDocument };
  setDoc: (updater: (prev: DesignDocument) => DesignDocument) => void;
  pan: { x: number; y: number };
  zoom: number;
  canvasContainerRef: { current: HTMLDivElement | null };
  startDragGesture: () => void;
  endDragGesture: () => void;
  scaleMode?: boolean;
  scaleAnchor?: ScaleAnchor;
  /**
   * Whether a resize may be pulled onto a guide. On by default; the crop frame
   * turns it off, because the box there is a window over a bitmap and the
   * boundary the user is aiming at is a pixel of the picture, not an alignment.
   */
  snapEnabled?: boolean;
  setHintMessage: (msg: string) => void;
  currentContainerRect: () => DOMRect | null;
  setActiveGuides: (guides: GuideLine[]) => void;
}

/**
 * Pin an instance's box to the size the user just dragged onto it.
 *
 * `sizeOverride` alone stops the MASTER's box from flowing in, but an instance
 * keeps its own `sizing` declaration and that outranks the override (see
 * `resolveInstanceContent`), so a hugging instance would shrug the drag off on
 * the next relayout. Clearing the declaration is what turns the drag into a
 * durable pin — the same thing choosing Fixed in the size menu does, reached by
 * the same gesture, so the two can never disagree about what an instance is.
 */
function pinInstanceBox(el: DesignElement): DesignElement {
  if (el.type !== "instance") return el;
  const { sizing: _sizing, ...rest } = el;
  return { ...rest, sizing: undefined, sizeOverride: true } as DesignElement;
}

/**
 * The three geometry handles — resize, rotate and the two line endpoints — plus
 * the corner-radius handle.
 *
 * The geometry ones refuse a derived node (a resolved instance child) before
 * opening anything: it has no stored geometry, so the write-back by id would
 * silently do nothing. The corner radius is not geometry and does NOT refuse one:
 * it is an overridable paint decision, written through the instance.
 */
export function createGeometryGestures(ctx: GeometryGestureContext) {
  const {
    docRef,
    setDoc,
    pan,
    zoom,
    canvasContainerRef,
    startDragGesture,
    endDragGesture,
    scaleMode = false,
    scaleAnchor = DEFAULT_SCALE_ANCHOR,
    snapEnabled = true,
    setHintMessage,
    currentContainerRect,
    setActiveGuides
  } = ctx;

  const handleLineEndpointPointerDown = (
    e: PointerEvent,
    el: DesignElement,
    which: "start" | "end"
  ) => {
    if (e.button !== 0) return;
    if (el.locked) return;
    e.stopPropagation();
    e.preventDefault();
    if (isDerivedNode(el)) {
      setHintMessage(t("component.derivedChildLocked"));
      return;
    }
    startDragGesture();

    const container = canvasContainerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();

    const coalescer = createRafCoalescer<{ x: number; y: number }>((p) => {
      const worldX = (p.x - rect.left - pan.x) / zoom;
      const worldY = (p.y - rect.top - pan.y) / zoom;
      // `dx`/`dy` are the segment in the element's OWN frame and `rotation`
      // turns it, so the pointer has to be turned back before it can be written
      // into that frame. Without this a dragged endpoint jumped to where the
      // pointer was in canvas space, which on a rotated line is nowhere near it.
      const parent = worldOriginOf(docRef.current, el);
      const turn = elementPivot(el);
      const cx = parent.x + turn.x;
      const cy = parent.y + turn.y;
      // WHICH end is being dragged decides whether the pointer has to be turned
      // at all. A line pivots on its start, so the start is the pivot: dragging
      // it is a plain move and the pointer is already in the right frame, while
      // the end is only reached through the rotation. Turning both was how the
      // two ends swapped places — the start landed somewhere the pointer had
      // never been.
      const point = which === "start" ? { x: worldX, y: worldY } : toElementLocal(worldX, worldY, el, cx, cy);
      const px = Math.round(point.x - parent.x);
      const py = Math.round(point.y - parent.y);
      setDoc((prev) => {
        const nextDoc = updateActivePageElements(
          prev,
          mapElements(getActivePage(prev).children, (item) => {
            if (item.id !== el.id || !isLineElement(item)) return item;
            // The near end IS the pivot, so it is PLACED rather than reached
            // through the rotation. `setLineEndpoint` pins the far end's LOCAL
            // coordinate, and moving the pivot re-bases that frame under it —
            // so dragging the near end the other way shortened the line by
            // exactly the distance the near end travelled.
            if (which === "start") return { ...item, x: px, y: py };
            return setLineEndpoint(item, which, px, py);
          })
        );
        return nextDoc;
      });
    });

    const onPointerMove = (moveEvt: PointerEvent) => {
      coalescer.push({ x: moveEvt.clientX, y: moveEvt.clientY });
    };

    const onPointerUp = () => {
      coalescer.flush();
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      endDragGesture();
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
  };

  const handleRadiusPointerDown = (
    e: PointerEvent,
    el: DesignElement
  ) => {
    if (e.button !== 0) return;
    if (el.locked) return;
    e.stopPropagation();
    e.preventDefault();
    // A corner radius is an OVERRIDE, not geometry: it cannot move a child, so
    // the handle is offered inside an instance too — which is the only place a
    // card's corner is normally edited. `writeNodeEdit` picks the route.
    if (el.type !== "rect") return;
    startDragGesture();

    const startClientX = e.clientX;
    const startClientY = e.clientY;
    const base = Array.isArray(el.borderRadius)
      ? el.borderRadius
      : ([el.borderRadius ?? 0, el.borderRadius ?? 0, el.borderRadius ?? 0, el.borderRadius ?? 0] as [number, number, number, number]);
    const startRadius = base[0];
    const rotRad = ((el.rotation || 0) * Math.PI) / 180;
    const cos = Math.cos(rotRad);
    const sin = Math.sin(rotRad);
    const maxR = Math.min(el.width, el.height) / 2;

    const coalescer = createRafCoalescer<{ x: number; y: number; altKey: boolean }>((p) => {
      const screenDx = (p.x - startClientX) / zoom;
      const screenDy = (p.y - startClientY) / zoom;
      const localDx = screenDx * cos + screenDy * sin;
      const localDy = -screenDx * sin + screenDy * cos;
      const next = Math.max(0, Math.min(maxR, Math.round((startRadius + (localDx + localDy) / 2) * 100) / 100));
      // Figma parity: a plain drag retunes all four corners together; Alt keeps
      // the other three at their stored values and retunes this corner only.
      const radius: number | [number, number, number, number] = p.altKey
        ? [next, base[1], base[2], base[3]]
        : next;

      setDoc((prev) => {
        const nextDoc = writeNodeEdit(prev, el.id, (item) =>
          item.type === "rect" ? { ...(item as RectElement), borderRadius: radius } : item
        );
        return nextDoc ?? prev;
      });
    });

    const onPointerMove = (moveEvt: PointerEvent) => {
      coalescer.push({ x: moveEvt.clientX, y: moveEvt.clientY, altKey: moveEvt.altKey });
    };

    const onPointerUp = () => {
      coalescer.flush();
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      endDragGesture();
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
  };

  // Figma parity: the blue handle on a text-on-path layer drags the run's start
  // point along the guide path. The pointer is projected onto the path (nearest
  // of 256 samples — visually exact at any zoom), so the offset is absolute per
  // frame and cannot feed back into itself.
  const handleStartOffsetPointerDown = (e: PointerEvent, el: DesignElement) => {
    if (e.button !== 0) return;
    if (el.locked) return;
    if (el.type !== "text" || !el.onPath?.pathId) return;
    e.stopPropagation();
    e.preventDefault();
    if (isDerivedNode(el)) {
      setHintMessage(t("component.derivedChildLocked"));
      return;
    }
    const guide = document.getElementById(`guide_path_${el.id}`) as SVGPathElement | null;
    if (!guide) return;
    let total = 0;
    try {
      total = guide.getTotalLength();
    } catch {
      return;
    }
    if (!(total > 0)) return;

    const container = canvasContainerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const parentOrigin = computeParentOrigin(getActivePage(docRef.current).children, el.id);
    const target = findElementById(getActivePage(docRef.current).children, el.onPath.pathId);

    startDragGesture();

    const SAMPLES = 256;
    const project = (worldX: number, worldY: number): number => {
      // Guide-path coordinates live in the text's parent space: the defs path
      // bakes `translate(target.x, target.y)` and the <text> sits in its own
      // parent <g>, so the pointer must land in that same space.
      const localX = worldX - parentOrigin.x - (target ? target.x : 0);
      const localY = worldY - parentOrigin.y - (target ? target.y : 0);
      let bestLen = 0;
      let bestDist = Infinity;
      for (let i = 0; i <= SAMPLES; i++) {
        const len = (total * i) / SAMPLES;
        let p: DOMPoint;
        try {
          p = guide.getPointAtLength(len);
        } catch {
          return Number(el.onPath?.startOffset ?? 0);
        }
        const d = (p.x - localX) ** 2 + (p.y - localY) ** 2;
        if (d < bestDist) {
          bestDist = d;
          bestLen = len;
        }
      }
      return Math.max(0, Math.min(100, (bestLen / total) * 100));
    };

    const coalescer = createRafCoalescer<{ x: number; y: number }>((p) => {
      const worldX = (p.x - rect.left - pan.x) / zoom;
      const worldY = (p.y - rect.top - pan.y) / zoom;
      const next = Math.round(project(worldX, worldY) * 10) / 10;
      setDoc((prev) =>
        updateActivePageElements(
          prev,
          mapElements(getActivePage(prev).children, (item) =>
            item.id === el.id && item.type === "text" && item.onPath
              ? { ...item, onPath: { ...item.onPath, startOffset: next } }
              : item
          )
        )
      );
    });

    const onPointerMove = (moveEvt: PointerEvent) => {
      coalescer.push({ x: moveEvt.clientX, y: moveEvt.clientY });
    };

    const onPointerUp = () => {
      coalescer.flush();
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      endDragGesture();
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
  };

  const handleResizePointerDown = (e: PointerEvent, handle: ResizeHandleType, el: DesignElement) => {
    if (e.button !== 0) return;
    if (el.locked) return;
    e.stopPropagation();
    e.preventDefault();
    // Handles are not drawn for a derived node, so this is a safety net: refuse
    // loudly instead of opening a gesture that writes nowhere (§5.3).
    if (isDerivedNode(el)) {
      setHintMessage(t("component.derivedChildLocked"));
      return;
    }

    const sizingParent = findParentById(getActivePage(docRef.current).children, el.id);
    // Cmd/Ctrl + drag on a frame resizes the FRAME. Figma's rule, and the reason
    // it needs a modifier at all: the same drag without it is free to hand the
    // resize on to what is inside, and a frame has no opinion about that. It also
    // unlocks the axes the layout engine owns — a hugging frame has no usable
    // handle without the modifier, which is precisely the frame you most want to
    // pull a size onto. `modifierResizesOwnBox` is the shared rule, so the handle
    // this drag needs is exactly the one the selection overlay draws.
    const frameOnly = (e.metaKey || e.ctrlKey) && modifierResizesOwnBox(el);
    const wEngineOwned = resolveAxis(el, sizingParent, "width") !== "fixed";
    const hEngineOwned = resolveAxis(el, sizingParent, "height") !== "fixed";
    const pinnedW = frameOnly && wEngineOwned;
    const pinnedH = frameOnly && hEngineOwned;
    // The Scale tool writes a FACTOR, not a box, so an instance's axes are its own
    // even where a hug would make a plain resize refuse them — `scalableAxes` is
    // the same rule the panel applies, so a handle the overlay draws and the drag
    // it opens cannot disagree about whether there is anything to pull.
    const scaleAxes = scaleMode ? scalableAxes(el, sizingParent) : null;
    const lockW = scaleAxes ? !scaleAxes.x : !frameOnly && wEngineOwned;
    const lockH = scaleAxes ? !scaleAxes.y : !frameOnly && hEngineOwned;
    if (lockW && lockH) return;

    startDragGesture();

    const startX = el.x;
    const startY = el.y;
    const startW = el.width;
    const startH = el.height;
    // Every constraint pass below measures from this snapshot, never from the box
    // the previous animation frame left behind.
    const fromSize = { width: startW, height: startH };
    const startPath = el.type === "path" ? parsePathData((el as PathElement).d) : null;
    const startClientX = e.clientX;
    const startClientY = e.clientY;
    // The pointer arrives in canvas space and every number below is in the
    // element's own unrotated box, so the delta is carried back through the FULL
    // world matrix — its own turn and every ancestor's. Turning back by
    // `el.rotation` alone left the delta in a space that is already turned inside
    // a turned frame, so the box resized along an axis the user was not dragging
    // and the handle left the cursor.
    const toLocal = invert(worldMatrixOf(docRef.current, el));
    // A degenerate chain cannot be turned back, so there is no delta to apply.
    if (!toLocal) return;
    // The proportion lock is the element's own, read at pointer-down: a session
    // flag would apply whichever layer was locked last to this one.
    const aspectLocked = elementIsAspectLocked(el);

    /**
     * Cmd/Ctrl + drag freezes the children ON SCREEN, not in the frame.
     *
     * Each child is recorded by where it sits on the canvas, and every frame of the
     * drag re-bases that position against the frame's new origin. So a west-edge
     * drag grows the distance between the frame's left edge and its children
     * instead of carrying them along with the edge — which is the whole difference
     * between "resize the frame" and "resize the frame and everything in it".
     *
     * A stack is exempt: it places its own children, so the layout pass owns those
     * coordinates and the freeze would be undone by the relayout on release. It
     * gets the pin below instead, and its start-aligned children stay put anyway.
     */
    const frozenChildren: Map<string, { canvasX: number; canvasY: number }> | null =
      frameOnly && isContainer(el) && !layoutOf(el) && (el.children || []).length > 0
        ? (() => {
          const frameWorld = transformBoundsToAABB(elementAABB(el), worldMatrixOf(docRef.current, el))!;
          return new Map(
            (el.children || []).map((child) => [
              child.id,
              // Where the child sits on the canvas, read through the same chain
              // the renderer draws with: a TURNED frame has carried every child
              // with it, so recording `child.x + an offset` froze the children at
              // the positions they had before the frame was turned and the drag
              // walked them there.
              {
                canvasX: child.x + frameWorld.x,
                canvasY: child.y + frameWorld.y
              }
            ])
          );
        })()
        : null;

    // The element and everything it owns are never snap targets for its own
    // resize. Built once for the gesture so the snapshot below can key on it.
    const ownIds = new Set([el.id, ...(isContainer(el) ? collectDescendantIds(el) : [])]);
    /** The gesture's snap candidates: same reasoning as the move drag. */
    let snapCache: { viewportKey: string; list: DesignElement[] } | null = null;

    const coalescer = createRafCoalescer<{ x: number; y: number; shiftKey: boolean; altKey: boolean }>((p) => {
      const screenDx = (p.x - startClientX) / zoom;
      const screenDy = (p.y - startClientY) / zoom;

      // Two points through the same map rather than a raw angle: the delta is
      // what has to come back, and going through the matrix keeps the origin the
      // element sits at out of it — a chain of pure turns and flips, which is all
      // a delta needs.
      const a = transformPoint(toLocal, { x: 0, y: 0 });
      const b = transformPoint(toLocal, { x: screenDx, y: screenDy });
      const localDx = b.x - a.x;
      const localDy = b.y - a.y;

      const box = resolveResizeBox({
        start: { x: startX, y: startY, width: startW, height: startH },
        localDx,
        localDy,
        handle,
        rotation: el.rotation || 0,
        lockW,
        lockH,
        aspectLocked,
        shiftKey: p.shiftKey,
        // Alt/Option pins the centre, and it is read per frame like Shift, so it
        // can be pressed or released halfway through the drag. Shift composes
        // with it: the ratio constraint runs before the origin is derived.
        fromCenter: p.altKey,
        scaleMode
      });
      const { aspectActive } = box;
      let newX = box.x;
      let newY = box.y;
      let newW = box.width;
      let newH = box.height;

      // A snap would hand back a width the ratio constraint then has to reject, so
      // the ratio path opts out of snapping entirely; the crop frame opts out
      // because its edge is a crop boundary (see `snapEnabled`). Its guides must
      // still be cleared: pressing Shift mid-drag would otherwise leave the
      // previous frame's guides drawn, which is a statement about a pointer
      // position that no longer applies.
      const snapping = !aspectActive && snapEnabled;
      if (!snapping) setActiveGuides([]);
      if (snapping) {
        const rect = currentContainerRect();
        const vp = rect ? calculateVisibleViewport(pan, zoom, rect.width, rect.height, 0) : null;
        /**
         * Snap in CANVAS space, not in the element's own.
         *
         * A child's `x` / `y` are parent-local (LESSONS §4.2) while the page
         * canvas and the guides are canvas-space, so feeding the local rect to
         * `calculateResizeSnapping` compared a nested element against two
         * different coordinate systems. The parent frame arrived in the
         * candidate list like any other layer and was therefore measured from the
         * wrong origin — which is why resizing inside a frame snapped to other
         * frames and the page but never to the frame the element was in. The
         * drag path has always rebased here (LESSONS §34); the resize path did
         * not, and it is the only snap that could not see its own parent.
         *
         * LEFT translation-only on purpose, and that is a limit rather than an
         * oversight: the snap runs on the element's box in canvas space and
         * writes the result back by subtracting that same offset. Under a TURNED
         * ancestor a canvas box does not map back to a local one by subtraction at
         * all — the painted shape is not axis-aligned, and there is no local box
         * whose AABB is the rectangle the snap just adjusted. Measuring the
         * candidates through the matrix while re-basing the element by
         * translation would put the two in different coordinate systems, which is
         * worse than being uniformly approximate. Making this exact means
         * snapping the element's own edges rather than its bounding box, and that
         * is a different feature.
         */
        const parentOrigin = computeParentOrigin(getActivePage(docRef.current).children, el.id);
        // Listed once for the gesture: every frame walks and caches the whole
        // page twice to answer a question only the viewport can change.
        const vpKey = vp ? `${vp.x}|${vp.y}|${vp.width}|${vp.height}` : "";
        const siblings =
          snapCache && snapCache.viewportKey === vpKey
            ? snapCache.list
            : (() => {
                const list = snapCandidates(getActivePage(docRef.current).children, ownIds, NO_IDS, vp);
                snapCache = { viewportKey: vpKey, list };
                return list;
              })();
        const pageCanvas = getActivePage(docRef.current).canvas;
        const snap = calculateResizeSnapping(
          handle,
          {
            x: newX + parentOrigin.x,
            y: newY + parentOrigin.y,
            width: newW,
            height: newH
          },
          pageCanvas.width,
          pageCanvas.height,
          siblings
        );
        // Unconditional, so the guides from the last frame that happened to hit
        // something do not outlive the drag: they are a statement about where the
        // pointer is now, and a stale one is a lie.
        setActiveGuides(snap.guides);
        if (!lockW) {
          newX = snap.x - parentOrigin.x;
          newW = snap.width;
        }
        if (!lockH) {
          newY = snap.y - parentOrigin.y;
          newH = snap.height;
        }
      }

      if (scaleMode) {
        /**
         * The Scale tool, from the drag-start box rather than the last frame.
         *
         * A scale is a RATIO, so every frame is recomputed from the same snapshot
         * the way a constraint pass is (LESSONS §45): accumulating frame-to-frame
         * would round once per event, so a slow drag would end at a different size
         * than a fast one over the same travel. Delegating to the one scale
         * implementation is also what keeps the toolbar tool, the inspector's
         * W / H and the factor field from disagreeing about what a scale touches.
         */
        setDoc((prev) => {
          const scaled = scaleElementsToSize(
            getActivePage(prev).children,
            new Set([el.id]),
            { width: newW, height: newH },
            scaleAnchor
          );
          if (scaled === getActivePage(prev).children) return prev;
          // No pin on this path, deliberately. A scale already writes the size
          // down — as the factor on the instance and as the box it produces — and
          // `sizeOverride` would say the user hand-sized this instance, after
          // which `propagateMasterSize` stops bringing it the master's next
          // resize. `pinInstanceBox` is the RESIZE gesture's answer, because a
          // resize carries no factor for the instance to follow.
          return updateActivePageElements(prev, relayoutDocumentTree(scaled));
        });
        return;
      }

      setDoc((prev) => {
        const nextElements = mapElements(getActivePage(prev).children, (item) => {
          if (item.id === el.id) {
            let updated: DesignElement = { ...item, x: newX, y: newY, width: newW, height: newH };
            // The number this drag just wrote only survives the relayout below if
            // the element claims it: a grid cell — and `align-self: stretch` in a
            // stack — decides the size of any axis the child left unsaid, and the
            // pass writes the cell back over the number. Pinning is the one thing
            // the parent cannot take back, so an axis the container owns gets one.
            if (!lockW && newW !== startW && containerSizesAxis(item, sizingParent, "width")) {
              updated = withAxisMode(updated, "width", "fixed");
            }
            if (!lockH && newH !== startH && containerSizesAxis(item, sizingParent, "height")) {
              updated = withAxisMode(updated, "height", "fixed");
            }
            // Sizing an instance by hand detaches its box from the master's, so a
            // later master resize must leave it alone.
            updated = pinInstanceBox(updated);
            if (startPath && item.type === "path") {
              const sx = newW / Math.max(1, startW);
              const sy = newH / Math.max(1, startH);
              const scaled = scalePathData(startPath, sx, sy);
              updated = { ...updated, d: serializePathData(scaled) } as PathElement;
            }
            if (frameOnly && isContainer(item)) {
              // The engine owned a hugging axis; the user just dragged a size onto
              // it, so the frame carries that size from now on. Pinning is the
              // only way to honour the drag at all — a relayout would take it back.
              if (pinnedW) updated = withAxisMode(updated, "width", "fixed");
              if (pinnedH) updated = withAxisMode(updated, "height", "fixed");
              if (layoutOf(item)) {
                // A stack places its own children; its start-aligned ones stay put
                // in the new box, the rest reflow, and the ones that left the flow
                // follow the box by their constraints.
                updated = resizeStackWithPins(updated, el as ContainerElement, fromSize, { width: newW, height: newH });
              } else if (frozenChildren && item.children) {
                // Re-base each child against the frame's NEW origin, so it holds
                // its canvas position. The local coordinates it ends up with are
                // the new distances to the edges — which is what its constraint
                // resumes from, so nothing snaps on release.
                const parentOrigin = computeParentOrigin(getActivePage(prev).children, el.id);
                const originX = parentOrigin.x + newX;
                const originY = parentOrigin.y + newY;
                updated = {
                  ...updated,
                  children: item.children.map((child) => {
                    const frozen = frozenChildren.get(child.id);
                    if (!frozen) return child;
                    const x = Math.round(frozen.canvasX - originX);
                    const y = Math.round(frozen.canvasY - originY);
                    return x === child.x && y === child.y ? child : { ...child, x, y };
                  })
                } as DesignElement;
              }
            } else if (isContainer(item) && layoutOf(item)) {
              updated = resizeStackWithPins(updated, el as ContainerElement, fromSize, { width: newW, height: newH });
            } else if (isContainer(item)) {
              // Distance-based constraints must be measured from the ORIGINAL
              // child positions (`el`, the drag-start snapshot), not the live
              // tree: prev-frame children are already constraint-adjusted, and
              // re-measuring them against drag-start bounds accumulates drift.
              const constrained = resizeContainerWithConstraints(
                el as ContainerElement,
                fromSize,
                { width: newW, height: newH }
              );
              if (constrained.children) {
                updated = { ...updated, children: constrained.children } as DesignElement;
              }
            }
            return updated;
          }
          return item;
        });
        // The full two-pass relayout, not one bottom-up pass. `resizeStackWithPins`
        // above freshens the frame's own children, but a pass that runs children
        // before parents still lays out anything two levels down against the width
        // it had before this frame: the boxes in between move and their contents
        // stand still until release. Cost is a second walk with the same
        // identity-preserving early returns, and the multi-resize path already
        // pays it per frame.
        return updateActivePageElements(prev, relayoutDocumentTree(nextElements));
      });
    });

    const onPointerMove = (moveEvt: PointerEvent) => {
      coalescer.push({
        x: moveEvt.clientX,
        y: moveEvt.clientY,
        shiftKey: moveEvt.shiftKey,
        altKey: moveEvt.altKey
      });
    };

    const onPointerUp = () => {
      coalescer.flush();
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      // The last frame already ran this pass; it stays as the settle step, so a
      // dropped final frame cannot leave the document one pointer position behind.
      setDoc((prev) => {
        const nextDoc = updateActivePageElements(
          prev,
          relayoutDocumentTree(getActivePage(prev).children)
        );
        return nextDoc;
      });
      endDragGesture();
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
  };

  const handleRotatePointerDown = (
    e: PointerEvent,
    _corner: "tl" | "tr" | "br" | "bl",
    el: DesignElement,
    cornerBaseAngle: number
  ) => {
    if (e.button !== 0) return;
    if (el.locked) return;
    e.stopPropagation();
    e.preventDefault();
    if (isDerivedNode(el)) {
      setHintMessage(t("component.derivedChildLocked"));
      return;
    }
    startDragGesture();

    const container = canvasContainerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();

    // The pivot has to be the point the RENDERER turns the element around, read
    // in canvas space because the pointer arrives there — and the renderer turns
    // it about the centre its whole ancestor chain puts there. Using the local
    // `el.x`/`el.y` put the pivot on the parent's origin for anything nested,
    // and the gesture then measured the angle around the wrong point: the delta
    // came out with the opposite sign, so a nested element (any stack child)
    // turned the wrong way.
    //
    // The world MATRIX, not `worldOriginOf`'s translation, because the handle
    // this gesture is measuring against is drawn through the same matrix. On a
    // child of a turned frame the two are a box-width apart, so a translation
    // here would swing the layer around a point the user never grabbed.
    const center = transformPoint(worldMatrixOf(docRef.current, el), elementPivot(el));
    const centerX = center.x;
    const centerY = center.y;
    const startRotation = el.rotation || 0;

    const startWorldX = (e.clientX - rect.left - pan.x) / zoom;
    const startWorldY = (e.clientY - rect.top - pan.y) / zoom;
    const startAngle = Math.atan2(startWorldY - centerY, startWorldX - centerX);

    const initialCursorAngle = startRotation + cornerBaseAngle;
    const origCursor = document.body.style.cursor;
    document.body.style.cursor = getRotateCursor(initialCursorAngle);

    const coalescer = createRafCoalescer<{ x: number; y: number; shiftKey: boolean }>((p) => {
      const curWorldX = (p.x - rect.left - pan.x) / zoom;
      const curWorldY = (p.y - rect.top - pan.y) / zoom;
      const curAngle = Math.atan2(curWorldY - centerY, curWorldX - centerX);
      let deltaDeg = Math.round(((curAngle - startAngle) * 180) / Math.PI);

      if (p.shiftKey) {
        const rawDeg = startRotation + deltaDeg;
        const snapped = Math.round(rawDeg / 15) * 15;
        deltaDeg = snapped - startRotation;
      }

      const nextRotation = (startRotation + deltaDeg + 360) % 360;
      document.body.style.cursor = getRotateCursor(initialCursorAngle + deltaDeg);

      setDoc((prev) => {
        // A turn changes how much room the element covers, so the stack holding
        // it has to be re-run for the neighbours to make way — the resize
        // gesture does the same for the same reason. `updateActivePageElements`
        // here is the plain DSL one, which swaps the array and stops, so the
        // relayout is this gesture's to call.
        const turned = mapElements(getActivePage(prev).children, (item) =>
          item.id === el.id ? { ...item, rotation: nextRotation } : item
        );
        return updateActivePageElements(prev, relayoutDocumentTree(turned));
      });
    });

    const onPointerMove = (moveEvt: PointerEvent) => {
      coalescer.push({ x: moveEvt.clientX, y: moveEvt.clientY, shiftKey: moveEvt.shiftKey });
    };

    const onPointerUp = () => {
      coalescer.flush();
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      document.body.style.cursor = origCursor;
      endDragGesture();
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
  };
  return { handleLineEndpointPointerDown, handleResizePointerDown, handleRotatePointerDown, handleRadiusPointerDown, handleStartOffsetPointerDown };
}
