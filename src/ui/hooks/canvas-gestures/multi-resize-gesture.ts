import {
  DesignDocument,
  getActivePage,
  updateActivePageElements
} from "../../../core/dsl/types";
import { relayoutDocumentTree } from "../../../core/compile";
import { calculateVisibleViewport, isElementInViewport } from "../../../core/geometry/cull";
import { calculateResizeSnapping, GuideLine, ResizeHandleType } from "../../../core/geometry/snap-guides";
import {
  collectDescendantIds,
  computeParentOrigin,
  elementWorldAABB,
  flattenElements
} from "../../../core/geometry/tree-ops";
import {
  DEFAULT_SCALE_ANCHOR,
  ScaleAnchor,
  scaleElementsToSize,
  selectionWorldBounds
} from "../../../core/interactions/scale-ops";
import { createRafCoalescer } from "../../raf";

/**
 * Resize and scale a MULTI-selection from the bounding box the canvas draws around it.
 *
 * A single layer already had a handle drag, but two or more had nothing to grab: the
 * union was drawn as a dashed outline with `pointerEvents="none"`, so the only way to
 * size a group was to type W and H. That is the shape of a missing feature rather than
 * a rough edge, and it is worst exactly where it bites — a group of layers is the one
 * thing a user most often wants to scale as a unit.
 *
 * The write is the one the Scale tool already had: `scaleElementsToSize` over the
 * whole selection, which is what the inspector's W / H and the factor field use, so a
 * group dragged on the canvas and a group sized in the panel cannot disagree. The
 * single-layer path is deliberately NOT generalised into this — it carries rotation,
 * layout-engine axis ownership, constraint re-solving and children-freezing, none of
 * which mean the same thing for a union of unrelated layers. What carries over is the
 * handle arithmetic, which is about a rectangle, and the snapping, which already takes
 * a plain box rather than an element.
 */

/** Where a plain resize grows from: the edge opposite the one being dragged. */
const ANCHOR_FROM_HANDLE: Record<ResizeHandleType, ScaleAnchor> = {
  br: { x: 0, y: 0 },
  tr: { x: 0, y: 1 },
  bl: { x: 1, y: 0 },
  tl: { x: 1, y: 1 },
  mr: { x: 0, y: 0.5 },
  ml: { x: 1, y: 0.5 },
  bm: { x: 0.5, y: 0 },
  tm: { x: 0.5, y: 1 }
};

const CORNERS: ResizeHandleType[] = ["tl", "tr", "br", "bl"];

/** The anchor Alt/Option swaps in: both edges travel, so the centre stays put. */
const CENTER_ANCHOR: ScaleAnchor = { x: 0.5, y: 0.5 };

/** A drag away from the box grows it, a drag back across it shrinks it. */
const EAST: ResizeHandleType[] = ["mr", "tr", "br"];
const WEST: ResizeHandleType[] = ["ml", "tl", "bl"];
const SOUTH: ResizeHandleType[] = ["bm", "bl", "br"];
const NORTH: ResizeHandleType[] = ["tm", "tl", "tr"];

const movesWidth = (handle: ResizeHandleType) => handle !== "tm" && handle !== "bm";
const movesHeight = (handle: ResizeHandleType) => handle !== "ml" && handle !== "mr";

const round2 = (n: number): number => Math.round(n * 100) / 100;

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The box a target size occupies when grown from `anchor` inside `start`. */
const boxFromAnchor = (
  anchor: ScaleAnchor,
  start: Box,
  width: number,
  height: number
): Box => ({
  x: round2(
    anchor.x === 0 ? start.x : anchor.x === 1 ? start.x + start.width - width : start.x + (start.width - width) / 2
  ),
  y: round2(
    anchor.y === 0 ? start.y : anchor.y === 1 ? start.y + start.height - height : start.y + (start.height - height) / 2
  ),
  width,
  height
});

export interface MultiResizeGestureContext {
  docRef: { current: DesignDocument };
  setDoc: (updater: (prev: DesignDocument) => DesignDocument) => void;
  pan: { x: number; y: number };
  zoom: number;
  startDragGesture: () => void;
  endDragGesture: () => void;
  scaleMode?: boolean;
  scaleAnchor?: ScaleAnchor;
  setActiveGuides: (guides: GuideLine[]) => void;
  currentContainerRect: () => DOMRect | null;
}

export function createMultiResizeGesture(ctx: MultiResizeGestureContext) {
  const {
    docRef,
    setDoc,
    pan,
    zoom,
    startDragGesture,
    endDragGesture,
    scaleMode,
    scaleAnchor,
    setActiveGuides,
    currentContainerRect
  } = ctx;

  const handleMultiResizePointerDown = (
    e: PointerEvent,
    handle: ResizeHandleType,
    selectedIds: Set<string>
  ) => {
    if (e.button !== 0) return;
    if (selectedIds.size < 2) return;
    const start = selectionWorldBounds(getActivePage(docRef.current).children, selectedIds);
    // An empty or degenerate union has no rectangle to steer, and a group of only
    // locked layers has nothing that will move — refuse before opening a gesture
    // that can only ever look busy.
    if (!start || start.width <= 0 || start.height <= 0) return;
    e.stopPropagation();
    e.preventDefault();
    startDragGesture();

    const startClientX = e.clientX;
    const startClientY = e.clientY;
    const aspect = start.width / Math.max(1, start.height);
    // The union is an axis-aligned box, so unlike a single rotated layer there is no
    // local frame to rotate the drag into. A rotated child is scaled by the ratio its
    // AABB takes, which is the same box the dashed outline promised the user.
    const ownIds = new Set<string>(selectedIds);
    for (const el of flattenElements(getActivePage(docRef.current).children)) {
      if (!selectedIds.has(el.id)) continue;
      for (const child of collectDescendantIds(el)) ownIds.add(child);
    }

    const coalescer = createRafCoalescer<{ x: number; y: number; shiftKey: boolean; altKey: boolean }>((p) => {
      const dx = (p.x - startClientX) / zoom;
      const dy = (p.y - startClientY) / zoom;

      // Under the Scale tool the anchor is a property of the operation the panel is
      // showing, so it wins here exactly as it does for one layer. Everywhere else the
      // handle decides, because a plain resize is a statement about the edge being
      // dragged and the opposite edge is what stays put — unless Alt/Option asks for
      // the centre instead, which releases that edge and lets both travel. Hence the
      // doubling: one pointer delta now buys two edges' worth of size.
      const fromCenter = p.altKey && !scaleMode;
      const grow = fromCenter ? 2 : 1;
      const anchor = scaleMode
        ? scaleAnchor ?? DEFAULT_SCALE_ANCHOR
        : fromCenter
          ? CENTER_ANCHOR
          : ANCHOR_FROM_HANDLE[handle];

      let width = start.width;
      let height = start.height;
      if (movesWidth(handle)) {
        width = Math.max(10, Math.round(start.width + grow * (EAST.includes(handle) ? dx : -dx)));
      }
      if (movesHeight(handle)) {
        height = Math.max(10, Math.round(start.height + grow * (SOUTH.includes(handle) ? dy : -dy)));
      }
      if (CORNERS.includes(handle) && p.shiftKey) {
        height = Math.max(10, Math.round(width / aspect));
      }

      // Snap in CANVAS space, like the single-layer path: the union is already a
      // world-space box, so unlike a nested element it needs no parent rebase, and
      // feeding it a parent-local rect is what made that path compare a child against
      // two coordinate systems (LESSONS §34).
      const rect = currentContainerRect();
      const vp = rect ? calculateVisibleViewport(pan, zoom, rect.width, rect.height, 0) : null;
      const siblings = flattenElements(getActivePage(docRef.current).children)
        .filter((item) => {
          if (ownIds.has(item.id)) return false;
          const origin = computeParentOrigin(getActivePage(docRef.current).children, item.id);
          const worldBox = elementWorldAABB(item, origin.x, origin.y);
          if (vp && !isElementInViewport(worldBox, vp)) return false;
          return true;
        })
        .map((item) => {
          const origin = computeParentOrigin(getActivePage(docRef.current).children, item.id);
          return { ...item, ...elementWorldAABB(item, origin.x, origin.y) };
        });
      const pageCanvas = getActivePage(docRef.current).canvas;
      const snap = calculateResizeSnapping(
        handle,
        boxFromAnchor(anchor, start, width, height),
        pageCanvas.width,
        pageCanvas.height,
        siblings
      );
      // Unconditional, so guides from a frame that happened to hit something do not
      // outlive the drag — they are a statement about where the pointer is now.
      setActiveGuides(snap.guides);
      if (movesWidth(handle)) width = Math.max(10, snap.width);
      if (movesHeight(handle)) height = Math.max(10, snap.height);

      setDoc((prev) => {
        const scaled = scaleElementsToSize(getActivePage(prev).children, selectedIds, { width, height }, anchor);
        if (scaled === getActivePage(prev).children) return prev;
        // No `sizeOverride` on the instances here, for the same reason the
        // single-layer scale path writes none: the factor IS the size, and the
        // flag would cut the instance off from its master's next resize. It only
        // ever looked necessary because the relayout below would otherwise take
        // an instance's hugging box back — a scaled hug now measures its own
        // scaled contents, so it lands where the drag put it.
        return updateActivePageElements(prev, relayoutDocumentTree(scaled));
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
      setDoc((prev) =>
        updateActivePageElements(prev, relayoutDocumentTree(getActivePage(prev).children))
      );
      endDragGesture();
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
  };

  return { handleMultiResizePointerDown };
}
