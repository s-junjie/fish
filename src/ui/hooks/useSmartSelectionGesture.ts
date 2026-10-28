import { useRef, useState } from "preact/hooks";
import { getActivePage } from "../../core/dsl/types";
import { DesignDocument, updateActivePageElements } from "../../core/dsl/types";
import { SmartSelectionInfo, SmartDotHandle } from "../../core/geometry/smart-selection";
import { mapElements, isContainer } from "../../core/geometry/tree-ops";
import { applyAutoLayout } from "../../core/compile";
import { layoutOf, withLayout } from "../../core/dsl/layout-flat";
import { elementAABB } from "../../core/geometry/element-bounds";
import { worldMatrixOf } from "../../core/interactions/component-swap";
import { transformBoundsToAABB } from "../../core/geometry/bounds";
import { tidySpacing } from "../../core/geometry/smart-spacing";
import { landingPlan, placeAt } from "./smart-drag-plan";

interface UseSmartSelectionGestureOptions {
  docRef: { current: DesignDocument };
  setDoc: (updater: (prev: DesignDocument) => DesignDocument) => void;
  commitSnapshot: (doc: DesignDocument) => void;
  selectedIds: Set<string>;
  setSelectedIds: (ids: Set<string>) => void;
  zoom: number;
  smartSelection?: SmartSelectionInfo | null;
  startDragGesture: () => void;
  endDragGesture: () => void;
}

type SmartDragMode = "none" | "gap" | "dot";

export function useSmartSelectionGesture({
  docRef,
  setDoc,
  commitSnapshot,
  selectedIds,
  setSelectedIds,
  zoom,
  smartSelection,
  startDragGesture,
  endDragGesture
}: UseSmartSelectionGestureOptions) {
  const activeSelectedIdsRef = useRef<Set<string>>(selectedIds);
  activeSelectedIdsRef.current = selectedIds;
  const smartSelectionRef = useRef<SmartSelectionInfo | null | undefined>(smartSelection);
  smartSelectionRef.current = smartSelection;

  const [smartDragMode, setSmartDragMode] = useState<SmartDragMode>("none");
  const [swapDropBox, setSwapDropBox] = useState<{ x: number; y: number; width: number; height: number } | null>(null);

  /**
   * Gap Drag Handler: Supports 1D Linear Stack (X or Y), Auto-Layout Frame gap, and 2D Grid (Col Gap & Row Gap).
   */
  const handleGapDragStart = (e: any, handleId: string) => {
    e.stopPropagation();
    e.preventDefault();
    const info = smartSelectionRef.current;
    if (!info) return;

    const handle = info.handles.find((h) => h.id === handleId);
    if (!handle) return;

    startDragGesture();
    setSmartDragMode("gap");
    const preservedIds = new Set(activeSelectedIdsRef.current);
    const startClientX = e.clientX;
    const startClientY = e.clientY;

    // Case 1: Auto-Layout Frame gap adjustment
    if (info.parentFrame) {
      const frameId = info.parentFrame.id;
      const initialGap = layoutOf(info.parentFrame)?.gap ?? 0;

      const onPointerMove = (evt: PointerEvent) => {
        const deltaScreen = handle.axis === "x" ? (evt.clientX - startClientX) : (evt.clientY - startClientY);
        const deltaWorld = Math.round(deltaScreen / zoom);
        const nextGap = Math.max(0, initialGap + deltaWorld);

        setDoc((prev) => {
          const nextDoc = updateActivePageElements(
            prev,
            mapElements(getActivePage(prev).children, (el) => {
              if (el.id === frameId && isContainer(el)) {
                const current = layoutOf(el);
                if (current) {
                  const updated = withLayout(el, { ...current, gap: nextGap });
                  return applyAutoLayout(updated);
                }
              }
              return el;
            })
          );
          return nextDoc;
        });
      };

      const onPointerUp = () => {
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", onPointerUp);
        setSmartDragMode("none");
        setSelectedIds(preservedIds);
        endDragGesture();
      };

      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);
      return;
    }

    // Case 2: 2D Grid Gap Drag (grid_gap_col_X or grid_gap_row_Y)
    if (info.axis === "grid" && info.grid) {
      const grid = info.grid;
      const isColGap = handle.axis === "x";
      const initialPositions = new Map<string, { x: number; y: number }>();
      for (const el of info.sortedElements) {
        initialPositions.set(el.id, { x: el.x, y: el.y });
      }

      const onPointerMove = (evt: PointerEvent) => {
        const deltaScreen = isColGap ? (evt.clientX - startClientX) : (evt.clientY - startClientY);
        const deltaWorld = Math.round(deltaScreen / zoom);

        setDoc((prev) => {
          const nextDoc = updateActivePageElements(
            prev,
            mapElements(getActivePage(prev).children, (el) => {
              // Find element's row and col
              for (let r = 0; r < grid.rows; r++) {
                for (let c = 0; c < grid.cols; c++) {
                  const cell = grid.matrix[r][c];
                  if (cell && cell.id === el.id) {
                    const orig = initialPositions.get(el.id);
                    if (!orig) return el;
                    const shift = deltaWorld * (isColGap ? c : r);
                    return placeAt(el, isColGap ? orig.x + shift : orig.x, isColGap ? orig.y : orig.y + shift);
                  }
                }
              }
              return el;
            })
          );
          return nextDoc;
        });
      };

      const onPointerUp = () => {
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", onPointerUp);
        setSmartDragMode("none");
        setSelectedIds(preservedIds);
        endDragGesture();
      };

      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);
      return;
    }

    // Case 3: 1D Linear Stack Gap Drag
    const initialPositions = new Map<string, { x: number; y: number }>();
    for (const el of info.sortedElements) {
      initialPositions.set(el.id, { x: el.x, y: el.y });
    }

    const onPointerMove = (evt: PointerEvent) => {
      const deltaScreen = handle.axis === "x" ? (evt.clientX - startClientX) : (evt.clientY - startClientY);
      const deltaWorld = Math.round(deltaScreen / zoom);

      setDoc((prev) => {
        const nextDoc = updateActivePageElements(
          prev,
          mapElements(getActivePage(prev).children, (el) => {
            const idx = info.sortedElements.findIndex((s) => s.id === el.id);
            if (idx > 0) {
              const orig = initialPositions.get(el.id);
              if (orig) {
                const shift = deltaWorld * idx;
                return placeAt(
                  el,
                  handle.axis === "x" ? orig.x + shift : orig.x,
                  handle.axis === "x" ? orig.y : orig.y + shift
                );
              }
            }
            return el;
          })
        );
        return nextDoc;
      });
    };

    const onPointerUp = () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      setSmartDragMode("none");
      setSelectedIds(preservedIds);
      endDragGesture();
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
  };

  /**
   * Tidy Up: one press, one undo step. Equalising the gaps is a decision, not a
   * drag — the pill takes over the moment it has landed, so there is no gesture to
   * accumulate a transient document for, and a snapshot is what makes ⌘Z answer it.
   */
  const handleTidySpacing = (axis: "x" | "y") => {
    const info = smartSelectionRef.current;
    if (!info || info.gapsEven || !info.unevenAxes.includes(axis)) return;

    const deltas = tidySpacing(
      info,
      (el) => transformBoundsToAABB(elementAABB(el), worldMatrixOf(docRef.current, el))!,
      axis
    );
    if (!deltas || deltas.size === 0) return;

    commitSnapshot(
      updateActivePageElements(
        docRef.current,
        mapElements(getActivePage(docRef.current).children, (el) => {
          const d = deltas.get(el.id);
          if (!d || (d.dx === 0 && d.dy === 0)) return el;
          return placeAt(el, el.x + d.dx, el.y + d.dy);
        })
      )
    );
  };

  /**
   * Dot Reorder / Swap Handler: Allows dragging the center pink dot to swap with target element.
   */
  const handleDotDragStart = (e: any, dot: SmartDotHandle) => {
    e.stopPropagation();
    e.preventDefault();
    const info = smartSelectionRef.current;
    if (!info) return;

    const sourceEl = info.sortedElements.find((el) => el.id === dot.elementId);
    if (!sourceEl) return;

    startDragGesture();
    setSmartDragMode("dot");
    const preservedIds = new Set(activeSelectedIdsRef.current);
    const startClientX = e.clientX;
    const startClientY = e.clientY;
    const origSourceX = sourceEl.x;
    const origSourceY = sourceEl.y;
    // The landing box marks a slot, but it is drawn at the size of the element
    // being dragged into it — not the size of whatever occupies the slot today.
    const sourceBox = elementAABB(sourceEl);

    // Track targets and positions
    const sortedEls = info.sortedElements;
    const elementPositions = new Map<string, { x: number; y: number }>();
    for (const el of sortedEls) {
      elementPositions.set(el.id, { x: el.x, y: el.y });
    }

    // Slot boundaries from ORIGINAL centers: a target is reached by crossing
    // the midpoint between adjacent slots, not by approaching its tiny center.
    // For a 1D row/column only the layout-axis displacement matters, so a small
    // target never needs a pixel-perfect drop.
    const sourceIndex = dot.index;
    const sameAxisDots = [...info.dots].sort((a, b) => a.index - b.index);
    const lineCenters =
      info.axis === "x" ? sameAxisDots.map((d) => d.x) : info.axis === "y" ? sameAxisDots.map((d) => d.y) : [];
    const rowCenters: number[] = [];
    const colCenters: number[] = [];
    if (info.axis === "grid" && info.grid) {
      for (let r = 0; r < info.grid.rows; r++) {
        const rDots = sameAxisDots.filter((d) => d.row === r);
        rowCenters.push(rDots.length ? rDots.reduce((s, d) => s + d.y, 0) / rDots.length : 0);
      }
      for (let c = 0; c < info.grid.cols; c++) {
        const cDots = sameAxisDots.filter((d) => d.col === c);
        colCenters.push(cDots.length ? cDots.reduce((s, d) => s + d.x, 0) / cDots.length : 0);
      }
    }
    const slotFromPointer = (centers: number[], pointer: number): number => {
      let slot = centers.length - 1;
      for (let i = 0; i < centers.length - 1; i++) {
        if (pointer < (centers[i] + centers[i + 1]) / 2) {
          slot = i;
          break;
        }
      }
      return slot;
    };

    let currentTargetId: string | null = null;
    let targetIndex: number | null = null;

    const onPointerMove = (evt: PointerEvent) => {
      const deltaWorldX = Math.round((evt.clientX - startClientX) / zoom);
      const deltaWorldY = Math.round((evt.clientY - startClientY) / zoom);
      const curSourceCenterX = dot.x + deltaWorldX;
      const curSourceCenterY = dot.y + deltaWorldY;

      // Determine the superseded slot purely from pointer position along the
      // layout axis; no proximity circle around the target's center.
      let targetId: string | null = null;
      if (info.axis === "grid" && info.grid) {
        targetIndex = null;
        const tr = slotFromPointer(rowCenters, curSourceCenterY);
        const tc = slotFromPointer(colCenters, curSourceCenterX);
        const cell = info.dots.find((d) => d.row === tr && d.col === tc);
        if (cell) targetId = cell.elementId;
      } else {
        const pointer = info.axis === "x" ? curSourceCenterX : curSourceCenterY;
        const slot = slotFromPointer(lineCenters, pointer);
        targetIndex = slot !== sourceIndex ? slot : null;
        if (slot !== sourceIndex) {
          const occupant = info.dots.find((d) => d.index === slot);
          if (occupant) targetId = occupant.elementId;
        }
      }
      currentTargetId = targetId && targetId !== dot.elementId ? targetId : null;

      const targetDot = currentTargetId ? info.dots.find((d) => d.elementId === currentTargetId) : undefined;
      const targetEl = targetDot ? sortedEls.find((el) => el.id === targetDot.elementId) : null;
      const origTargetPos = targetEl ? elementPositions.get(targetEl.id) : null;
      /**
       * Where the dragged element will actually LAND, not where the slot it is
       * over happens to be today.
       *
       * The preview used to be the target's box wearing the source's size, and the
       * settle then re-flowed the row from its gap sequence — which puts a wide
       * element somewhere else entirely, by exactly the difference between the two
       * elements' sizes. The dashed box promised a position and the release
       * delivered another, and nothing on screen could explain the gap because
       * the gap was not a mistake in either place: it was the preview describing
       * a DIFFERENT operation from the one the release performs.
       *
       * So the preview now runs the same arithmetic the settle will, and every
       * path answers it the same way — including the auto-layout frame, whose
       * child positions come out of the layout engine rather than a slot, and
       * which is therefore asked rather than approximated.
       */
      const plan = sourceEl
        ? landingPlan(info, sortedEls, elementPositions, sourceEl, targetIndex, origTargetPos ?? undefined)
        : null;
      const landing = plan?.get(dot.elementId) ?? null;
      if (landing) {
        // The box is drawn on the canvas, so it needs the SOURCE's chain: it is the
        // source that lands there, and two layers can share a stored x while
        // painting a long way apart.
        const box = transformBoundsToAABB(
          elementAABB({ ...sourceEl, x: landing.x, y: landing.y }),
          worldMatrixOf(docRef.current, sourceEl)
        )!;
        setSwapDropBox({ x: box.x, y: box.y, width: box.width, height: box.height });
      } else {
        setSwapDropBox(null);
      }

      setDoc((prev) => {
        const nextDoc = updateActivePageElements(
          prev,
          mapElements(getActivePage(prev).children, (el) => {
            if (el.id === dot.elementId) {
              return placeAt(el, origSourceX + deltaWorldX, origSourceY + deltaWorldY);
            }
            // Everything the gesture moves PASSIVELY goes exactly where the settle
            // will put it — same plan, same arithmetic. The dragged element is the
            // one exception, and only because it is still under the pointer: it
            // rides the cursor and snaps home on release.
            const landed = plan?.get(el.id);
            if (landed) return placeAt(el, landed.x, landed.y);
            const orig = elementPositions.get(el.id);
            if (orig) return placeAt(el, orig.x, orig.y);
            return el;
          })
        );
        return nextDoc;
      });
    };

    const onPointerUp = () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      setSmartDragMode("none");
      setSwapDropBox(null);

      // Settle swap
      if (currentTargetId && currentTargetId !== dot.elementId) {
        const targetEl = sortedEls.find((el) => el.id === currentTargetId);
        const origTargetPos = elementPositions.get(currentTargetId);

        if (targetEl && origTargetPos && sourceEl) {
          /**
           * The settle, from the SAME plan the live preview drew.
           *
           * Every branch used to re-derive its own arithmetic — the preview here and
           * a re-flow there — which is how the two came to describe different moves.
           * `landingPlan` is asked once more, with the target the release actually
           * settled on, and written verbatim.
           */
          const settled = landingPlan(
            info,
            sortedEls,
            elementPositions,
            sourceEl,
            targetIndex,
            origTargetPos
          );
          if (settled) {
            setDoc((prev) =>
              updateActivePageElements(
                prev,
                mapElements(getActivePage(prev).children, (el) => {
                  const next = settled.get(el.id);
                  return next ? placeAt(el, next.x, next.y) : el;
                })
              )
            );
          }
        }
      } else {
        // Revert to original positions
        setDoc((prev) => {
          const nextDoc = updateActivePageElements(
            prev,
            mapElements(getActivePage(prev).children, (el) => {
              const orig = elementPositions.get(el.id);
              if (orig) {
                return placeAt(el, orig.x, orig.y);
              }
              return el;
            })
          );
          return nextDoc;
        });
      }

      setSelectedIds(preservedIds);
      endDragGesture();
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
  };

  return {
    isSmartDragActive: smartDragMode !== "none",
    isGapDragActive: smartDragMode === "gap",
    swapDropBox,
    handleGapDragStart,
    handleTidySpacing,
    handleDotDragStart
  };
}
