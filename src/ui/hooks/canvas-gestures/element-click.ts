import type { ContainerElement, DesignDocument, DesignElement, TextElement } from "../../../core/dsl/types";
import { getActivePage, updateActivePageElements } from "../../../core/dsl/types";
import { createId } from "../../../core/id";
import { DEFAULT_FONT_FAMILY } from "../../../core/font-stack";
import {
  computeParentOrigin,
  elementWorldAABB,
  findElementById,
  findParentById,
  flattenElements,
  isContainer
} from "../../../core/geometry/tree-ops";
import { editableIds } from "../../../core/geometry/lock";
import { computeShapeDraftBounds, isCreatableTool, isSelectingTool } from "../../../core/geometry/shape-creation";
import { newTextInkAt } from "../../../core/geometry/ink-on";
import type { ToolType } from "../../../core/tools";
import { isDerivedFrom, isDerivedNode } from "../../../core/interactions/component-inventory";
import { owningInstanceId, resolvedRoute } from "../../../core/interactions/component-swap";
import {
  activeScopeFrameIds,
  collectFrameAncestry,
  enclosingMasterComponent,
  findLockedFrame,
  hasSelectedDescendant
} from "./targeting";

/** How far down `route` the selection already is; 0 is the instance itself. */
function deepestSelected(route: DesignElement[], selectedIds: Set<string>): number {
  let level = 0;
  for (let i = 0; i < route.length; i++) {
    if (selectedIds.has(route[i].id)) level = i;
  }
  return level;
}

/**
 * Where a piercing click lands: the deepest node under the cursor, stopping AT
 * a nested instance rather than inside it.
 *
 * A nested instance is a boundary of its own — the next double click is what
 * enters it — which is what keeps a click on an instance-in-an-instance from
 * landing on the innermost shape it eventually paints. Frames are not
 * boundaries, so within one master the click still reaches the node itself.
 */
function stepInto(route: DesignElement[], level: number): DesignElement {
  for (let i = level + 1; i < route.length; i++) {
    if (route[i].type === "instance" && i < route.length - 1) return route[i];
  }
  return route[route.length - 1];
}

/**
 * The mousedown handler for a painted element: it decides what a click SELECTS
 * and, when the target is a real stored node, opens the drag that can move it.
 *
 * Every rule that decides the target lives here rather than at the call site, so
 * the canvas, the layer tree and the hover preview cannot disagree about what a
 * click means. Extracted from `useCanvasGestures` (AGENTS.md §9).
 */
export interface ElementClickDeps {
  docRef: { current: DesignDocument };
  selectedIds: Set<string>;
  // Same reason as `isPanModeRef`: a node the selection change did not touch
  // keeps its old handler, so the render snapshot of `selectedIds` is stale
  // exactly when a shift-click needs it to add to the current selection.
  selectedIdsRef?: { current: Set<string> };
  setSelectedIds: (ids: Set<string>) => void;
  activeTool: ToolType;
  setActiveTool: (tool: ToolType) => void;
  // Read at event time, not render time: the memoized SVG nodes keep a stale
  // handler closure across renders where only pan state changed, so the render
  // snapshot of isPanMode cannot be trusted here (space-pan first-press bug).
  isPanModeRef: { current: boolean };
  editingPathId: string | null | undefined;
  editingPathIdRef?: { current: string | null | undefined };
  pan: { x: number; y: number };
  panRef?: { current: { x: number; y: number } };
  zoom: number;
  zoomRef?: { current: number };
  canvasContainerRef: { current: HTMLDivElement | null };
  commitSnapshot: (doc: DesignDocument) => void;
  startCanvasTextEdit: (el: TextElement) => void;
  openImageFillPanel: (el: DesignElement) => boolean;
  setShapeDraft: (draft: ReturnType<typeof computeShapeDraftBounds>) => void;
  setHoverSelectId: (id: string | null) => void;
  hoverSelectIdRef: { current: string | null };
  isDrawingShape: { current: boolean };
  shapeDrawStart: { current: { x: number; y: number } | null };
  shapeDrawCurrent: { current: { x: number; y: number } | null };
  startDragGesture: () => void;
  isDraggingElements: { current: boolean };
  dragStartMouse: { current: { x: number; y: number } };
  dragStartElements: { current: Map<string, { x: number; y: number; startOffset?: number }> };
  dragSelectionRef: { current: Set<string> };
  dragPrimary: { current: { id: string; box: { x: number; y: number; width: number; height: number } } | null };
  dragSnapExcludeRef: { current: Set<string> };
  isMarqueeActive: { current: boolean };
  marqueeBox: { current: { startX: number; startY: number; curX: number; curY: number } | null };
  onCommentAtElement?: (el: DesignElement, point: { x: number; y: number }) => void;
}

export function createElementClick(deps: ElementClickDeps) {
  const {
    docRef,
    selectedIds: renderedSelectedIds,
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
  } = deps;

  return (e: MouseEvent, el: DesignElement) => {
    const selectedIds = selectedIdsRef?.current ?? renderedSelectedIds;
    if (hoverSelectIdRef.current) {
      hoverSelectIdRef.current = null;
      setHoverSelectId(null);
    }
    // Only the primary button selects or drags; a middle press must fall through
    // to the container so it pans instead of grabbing whatever is underneath.
    if (e.button !== 0) return;
    if (isPanModeRef.current) return;

    if (activeTool === "comment") {
      e.stopPropagation();
      const container = canvasContainerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const currentPan = panRef?.current ?? pan;
      const currentZoom = zoomRef?.current ?? zoom;
      const worldX = Math.round(((e.clientX - rect.left) - currentPan.x) / currentZoom);
      const worldY = Math.round(((e.clientY - rect.top) - currentPan.y) / currentZoom);
      onCommentAtElement?.(el, { x: worldX, y: worldY });
      return;
    }
    // A locked layer never reaches here: `[data-locked]` makes the whole subtree
    // pointer-transparent in CSS, so the press resolves to whatever is painted
    // behind the lock and this handler is called for THAT element instead. The
    // lock is enforced where the hit-test is, not here — the browser tests the
    // real painted geometry (path interiors, strokes, nested transforms, clip
    // paths), which an AABB re-derivation in JS cannot reproduce. A press that
    // finds nothing behind the lock reaches the canvas container instead, which
    // is an ordinary click on empty canvas and deselects.
    if (el.locked) {
      e.stopPropagation();
      return;
    }
    const currentEditingPathId = editingPathIdRef?.current !== undefined ? editingPathIdRef.current : editingPathId;
    const currentPan = panRef?.current ?? pan;
    const currentZoom = zoomRef?.current ?? zoom;

    if (currentEditingPathId) {
      e.stopPropagation();
      const container = canvasContainerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const worldX = Math.round(((e.clientX - rect.left) - currentPan.x) / currentZoom);
      const worldY = Math.round(((e.clientY - rect.top) - currentPan.y) / currentZoom);

      isMarqueeActive.current = true;
      marqueeBox.current = { startX: worldX, startY: worldY, curX: worldX, curY: worldY };
      return;
    }

    if (isCreatableTool(activeTool)) {
      e.stopPropagation();
      const container = canvasContainerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const worldX = Math.round(((e.clientX - rect.left) - currentPan.x) / currentZoom);
      const worldY = Math.round(((e.clientY - rect.top) - currentPan.y) / currentZoom);

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

    if (!isSelectingTool(activeTool) && activeTool !== "text-on-path") {
      return;
    }

    e.stopPropagation();

    if (activeTool === "text-on-path") {
      const pathOrigin = computeParentOrigin(getActivePage(docRef.current).children, el.id);
      const pathBox = elementWorldAABB(el, pathOrigin.x, pathOrigin.y);
      const ink = newTextInkAt(docRef.current, {
        x: pathBox.x + pathBox.width / 2,
        y: pathBox.y + pathBox.height / 2
      });
      const newText: TextElement = {
        id: createId("text"),
        type: "text",
        name: `Text on ${el.name || el.type}`,
        x: el.x,
        y: el.y,
        width: Math.max(200, el.width),
        height: 48,
        content: "Text on Path",
        fills: [{ type: "solid", color: ink }],
        style: {
          fontSize: 24,
          fontFamily: DEFAULT_FONT_FAMILY,
          fontWeight: 400,
          color: ink
        },
        onPath: {
          pathId: el.id,
          startOffset: 0
        }
      };
      commitSnapshot(
        updateActivePageElements(docRef.current, [...getActivePage(docRef.current).children, newText])
      );
      setSelectedIds(new Set([newText.id]));
      setActiveTool("select");
      // Figma parity: click the path, then type immediately — the on-canvas
      // editor drives the textPath live.
      startCanvasTextEdit(newText);
      return;
    }

    const elements = getActivePage(docRef.current).children;

    // A double click edits a text in place — but only one that is already the
    // selection when the second press arrives. A double click on a text nested
    // in a frame spends its first press selecting the frame and its second one
    // drilling in, so entering the editor there would make the text impossible
    // to SELECT: every attempt to reach it opened the caret. The next double
    // click is the one that edits, which is the Figma reading of the gesture.
    // A top-level text is selected by its FIRST press, so it still edits on the
    // first double click.
    if (
      el.type === "text" &&
      (e.detail ?? 0) >= 2 &&
      !e.metaKey &&
      !e.ctrlKey &&
      selectedIds.has(el.id)
    ) {
      startCanvasTextEdit(el as TextElement);
      return;
    }

    // When an instance's rendered child node is clicked, target the instance itself
    // unless the user is explicitly piercing with Cmd/Ctrl or double-clicking
    // inside the instance.
    const ownerId = owningInstanceId(docRef.current, el);
    const instanceEl = ownerId ? findElementById(elements, ownerId) : null;
    if (ownerId && instanceEl) {
      // How far into the instance the selection already is, measured on the route
      // from the instance down to the node under the cursor. It has to be a ROUTE
      // and not a tree walk: a derived frame is missing from the tree, so every
      // depth rule below measures nothing on it.
      const route = isDerivedNode(el) ? resolvedRoute(docRef.current, el.id) : null;
      const level = route ? deepestSelected(route, selectedIds) : 0;
      // "Already inside this instance" has to count as well, not just "the
      // instance itself is selected" — otherwise the next double click falls back
      // to selecting the instance and a nested frame's children are unreachable.
      const insideInstance = Array.from(selectedIds).some((id) => isDerivedFrom(ownerId, id));
      const exactPierce = e.metaKey || e.ctrlKey;
      const pierceInstance = exactPierce || (insideInstance && (e.detail ?? 0) >= 2);
      if (route && (pierceInstance || level > 0)) {
        // A resolved clone is selected only — it has no stored geometry, so there
        // is no drag to begin. Cmd/Ctrl takes exactly what is under the cursor;
        // a double click steps in, and a plain
        // click while we are already inside holds that depth instead of bouncing
        // back out to the instance.
        const target = pierceInstance ? stepInto(route, level) : route[level];
        setSelectedIds(
          e.shiftKey ? new Set([...selectedIds, target.id]) : new Set([target.id])
        );
        return;
      }
      if (!pierceInstance) {
        el = instanceEl;
      }
    }

    // A double click opens a painted image's fill row on the same terms as the
    // text editor above: only when the layer is ALREADY the selection as the
    // second press arrives, so a nested image takes two double clicks — the
    // first one selecting it — exactly like a nested text. Deciding it here,
    // ahead of the piercing rules below, is what makes that true; on the
    // `dblclick` event the pierce has already run, so the panel used to open on
    // the very gesture that was meant to select. A container is skipped because
    // its double click is the gesture that drills into its children.
    if (
      (e.detail ?? 0) >= 2 &&
      !e.metaKey &&
      !e.ctrlKey &&
      !isContainer(el) &&
      selectedIds.size === 1 &&
      selectedIds.has(el.id) &&
      openImageFillPanel(el)
    ) {
      return;
    }

    const isFrameEl = isContainer(el);

    // Select `target` (replacing selection unless shift-toggling) and begin a
    // drag so the element can be moved. `keepExisting` keeps the current
    // selection untouched (used when a selected frame swallows a click to move
    // itself rather than re-selecting).
    const applySelectionAndBeginDrag = (target: DesignElement, keepExisting = false) => {
      let nextSelection: Set<string>;
      /**
       * Shift and Option each mean two different things here, and which one is not
       * known until the pointer moves: additive/subtractive SELECTION on a click,
       * and a constrained DUPLICATING drag.
       *
       * Toggling on pointerdown made shift+drag impossible — a press on an
       * already-selected layer removed it from the selection, and a drag needs the
       * layer IN the selection to move it, so nothing moved at all. Option has the
       * same shape for a different reason: `dragStartElements` IS the set an Option
       * drag clones, so the layer has to still be in the box when the pointer
       * clears the threshold. So both removals are deferred to a press that turns
       * out to be a click, and both drags keep the layer.
       *
       * Option wins over Shift when both are held: it is the stronger "take this
       * out" signal, and a Shift+Option+click that ADDED would have no way to say
       * what it meant.
       *
       * Option only subtracts FROM something. On a layer that is not selected there
       * is nothing to take it out of, so the press is an ordinary select — leaving
       * the selection empty would mean the one gesture that adds also empties,
       * which is not a thing a modifier can quietly do.
       */
      const subtract = !keepExisting && e.altKey && !e.shiftKey && selectedIds.has(target.id);
      const deferredRemoval = !keepExisting && subtract && selectedIds.has(target.id);
      if (keepExisting || subtract) {
        // Option keeps whatever is selected so a drag can still duplicate it.
        nextSelection = new Set(selectedIds);
      } else if (e.shiftKey) {
        // Add, never remove: the removal is deferred to a press that turns out to
        // be a click (see above), so a shift+drag still has its layer in the box.
        nextSelection = new Set(selectedIds);
        if (!nextSelection.has(target.id)) nextSelection.add(target.id);
      } else {
        if (!selectedIds.has(target.id)) nextSelection = new Set([target.id]);
        else nextSelection = new Set(selectedIds);
      }
      if (!keepExisting) setSelectedIds(nextSelection);

      if (deferredRemoval) {
        /**
         * A click, not a drag: apply the removal the modifier meant.
         *
         * "Was it a click" is answered by comparing the two pointer positions,
         * NOT by reading `isDraggingElements`. That flag is set for every press on
         * a selected layer and cleared by the window's own mouseup listener, which
         * is registered earlier than this one and runs first — so a listener that
         * checked it here always saw `true` and never removed anything. Shift+click
         * to drop a layer had been silently dead for exactly that long; the
         * distance between the press and the release cannot go stale like a flag
         * another handler owns.
         */
        const onUp = (up: MouseEvent) => {
          window.removeEventListener("mouseup", onUp, true);
          const start = dragStartMouse.current;
          if (start && Math.hypot(up.clientX - start.x, up.clientY - start.y) > 3) return;
          if (editableIds(elements, nextSelection).size === 0) return;
          const without = new Set(selectedIds);
          without.delete(target.id);
          setSelectedIds(without);
        };
        window.addEventListener("mouseup", onUp, true);
      }

      // Selecting a derived node is the point — it is how you reach an instance's
      // internals — but it has no stored geometry, so a drag would move nothing.
      // Select, and do not open a gesture.
      if (isDerivedNode(target)) return;

      if (isSelectingTool(activeTool) && nextSelection.has(target.id)) {
        startDragGesture();
        isDraggingElements.current = true;
        dragStartMouse.current = { x: e.clientX, y: e.clientY };
        const origins = new Map<string, { x: number; y: number; startOffset?: number }>();
        // Dragging moves everything selected, so a locked layer picked from the
        // Layers Panel has to be filtered out here, not only at the grab point.
        const movable = editableIds(elements, nextSelection);
        const topLevelSelected = Array.from(movable).filter((id) => {
          let curr = findParentById(elements, id);
          while (curr) {
            if (movable.has(curr.id)) return false;
            curr = findParentById(elements, curr.id);
          }
          return true;
        });
        for (const id of topLevelSelected) {
          const item = findElementById(elements, id);
          if (item) {
            origins.set(item.id, {
              x: item.x,
              y: item.y,
              startOffset: (item as TextElement).onPath?.startOffset
            });
          }
        }
        dragStartElements.current = origins;
        dragSelectionRef.current = new Set(nextSelection);
        dragSnapExcludeRef.current = new Set();
        // No Alt/Option is read here, on purpose. `dragStartElements` IS the set
        // an Alt press would clone, and the key may arrive at any point in the
        // gesture — so the duplicate is decided per frame in `applyDragFrame`,
        // which is also where a late Option unwinds to the marks recorded above.
        // Nothing is minted until the pointer clears the threshold, so an
        // Alt+click that never moves is still a plain select.

        const flat = flattenElements(elements);
        const newPrimary = flat.find((f) => nextSelection.has(f.id));
        if (newPrimary) {
          const parentOrigin = computeParentOrigin(elements, newPrimary.id);
          const worldBox = elementWorldAABB(newPrimary, parentOrigin.x, parentOrigin.y);
          dragPrimary.current = { id: newPrimary.id, box: worldBox };
        } else {
          dragPrimary.current = null;
        }
      }
    };

    // Cmd/Ctrl: pierce to the exact clicked element, bypassing frame gating.
    if (e.metaKey || e.ctrlKey) {
      applySelectionAndBeginDrag(el);
      return;
    }

    // A master component is opaque to plain clicks — but only while we are outside
    // it. The barrier is what makes a single click land on the master (moving it
    // when it is already selected) instead of on its guts, and a double click is
    // what enters. It has to lift once something inside is selected, or the
    // selection is trapped: every further click bounced back to the master, so a
    // sibling could never be reached and only the one node you drilled into was
    // ever editable.
    const masterComponent = enclosingMasterComponent(elements, el);
    const insideMaster =
      masterComponent !== null &&
      hasSelectedDescendant(elements, selectedIds, masterComponent.id);
    if (masterComponent && !insideMaster) {
      if ((e.detail ?? 0) >= 2) {
        applySelectionAndBeginDrag(el);
      } else {
        applySelectionAndBeginDrag(masterComponent, selectedIds.has(masterComponent.id));
      }
      return;
    }

    // A leaf nested inside a frame is gated by that frame: a plain single
    // click can never select it directly (only Cmd/Ctrl pierces). When the
    // enclosing frame is not yet selected, the click is promoted to that frame;
    // once the frame is selected, a single click moves it and a double click
    // pierces in to the leaf.
    const elParentFrame = findParentById(elements, el.id);
    const elParentIsFrame = elParentFrame && isContainer(elParentFrame);

    // Active scope: the frame(s) that contain a currently-selected element.
    // Inside the scope, the frame itself and any of its direct children — leaf
    // shapes OR sibling sub-frames — are directly single-click selectable. This
    // unifies frame/element behavior in both directions (a selected frame lets
    // you click a sibling shape, and a selected shape lets you click a sibling
    // frame). Checked via the clicked element's own parent frame so it applies
    // symmetrically to both leaves and frames.
    const scopeFrameIds = activeScopeFrameIds(elements, selectedIds);
    const inActiveScope =
      (elParentIsFrame && scopeFrameIds.has(elParentFrame.id)) || scopeFrameIds.has(el.id);
    if (inActiveScope) {
      applySelectionAndBeginDrag(el);
      return;
    }

    const pierceLeaf = !isFrameEl && elParentIsFrame && selectedIds.has(elParentFrame.id);

    let target: DesignElement = el;
    if (!isFrameEl && elParentFrame && !pierceLeaf) target = elParentFrame;

    const targetIsFrame = isContainer(target);
    const targetAncestry = collectFrameAncestry(elements, target.id);
    const targetDepth = targetIsFrame ? targetAncestry.length + 1 : 0;

    // Depth 1 frame behaves like a normal selectable frame.
    if (targetIsFrame && targetDepth === 1) {
      if (selectedIds.has(target.id) && (e.detail ?? 0) < 2) {
        applySelectionAndBeginDrag(target, true); // move the already-selected frame
      } else {
        applySelectionAndBeginDrag(target); // select (and begin drag so it can move)
      }
      return;
    }

    // Double click on a leaf whose enclosing frame is already selected pierces
    // in to that leaf.
    if ((e.detail ?? 0) >= 2 && pierceLeaf) {
      applySelectionAndBeginDrag(el);
      return;
    }

    // A selected ancestor frame swallows single clicks to move itself (this
    // includes top-level frames — clicking anywhere inside a selected frame
    // moves it rather than selecting the interior); double clicks pierce in.
    let lockedFrame = findLockedFrame(targetAncestry, selectedIds);
    if (targetIsFrame && targetDepth >= 2 && selectedIds.has(target.id)) lockedFrame = target as ContainerElement;
    if (lockedFrame && (e.detail ?? 0) < 2) {
      applySelectionAndBeginDrag(lockedFrame, true); // move the locked frame
      return;
    }

    if (!targetIsFrame) {
      applySelectionAndBeginDrag(target); // top-level leaf, directly selectable
      return;
    }

    if (targetDepth === 2) {
      applySelectionAndBeginDrag(target);
      return;
    }

    // Depth >= 3, single click: select the immediate parent (the next double
    // click commits this deeper frame).
    if ((e.detail ?? 0) < 2) {
      const parent = findParentById(elements, target.id);
      if (parent && isContainer(parent)) applySelectionAndBeginDrag(parent);
      return;
    }

    // Depth >= 3, double click: depth >= 4 requires the parent already selected.
    if (targetDepth >= 4) {
      const parent = findParentById(elements, target.id);
      if (!parent || !selectedIds.has(parent.id)) return;
    }
    applySelectionAndBeginDrag(target);
    return;
  };
}
