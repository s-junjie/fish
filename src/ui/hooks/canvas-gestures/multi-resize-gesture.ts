import { DesignDocument, DesignElement, getActivePage, updateActivePageElements } from "../../../core/dsl/types";
import { calculateVisibleViewport } from "../../../core/geometry/cull";
import { calculateResizeSnapping, GuideLine, ResizeHandleType } from "../../../core/geometry/snap-guides";
import { snapCandidates } from "../../../core/geometry/snap-candidates";
import { collectDescendantIds, flattenElements } from "../../../core/geometry/tree-ops";
import {
  ANCHOR_FROM_HANDLE,
  ScaleAnchor,
  scaleElementsByFactor,
  selectionWorldBounds,
  settleScaledDocument
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

const CORNERS: ResizeHandleType[] = ["tl", "tr", "br", "bl"];

/** Nothing beyond the dragged subtree is excluded from this gesture's magnets. */
const NO_IDS: ReadonlySet<string> = new Set();

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
    // The drag-start tree. A scale is a ratio and every number it writes is rounded
    // to two decimals, so re-applying it to the tree the last frame produced rounds
    // once per pointer event and a slow drag loses the progress entirely.
    const startElements = getActivePage(docRef.current).children;
    // The union is an axis-aligned box, so unlike a single rotated layer there is no
    // local frame to rotate the drag into. A rotated child is scaled by the ratio its
    // AABB takes, which is the same box the dashed outline promised the user.
    const ownIds = new Set<string>(selectedIds);
    for (const el of flattenElements(getActivePage(docRef.current).children)) {
      if (!selectedIds.has(el.id)) continue;
      for (const child of collectDescendantIds(el)) ownIds.add(child);
    }
    /** The gesture's magnets: listed once, re-listed only when the viewport moves. */
    let snapCache: { viewportKey: string; list: DesignElement[] } | null = null;

    const coalescer = createRafCoalescer<{ x: number; y: number; shiftKey: boolean; altKey: boolean }>((p) => {
      const dx = (p.x - startClientX) / zoom;
      const dy = (p.y - startClientY) / zoom;

      // The handle decides the anchor: a resize is a statement about the edge being
      // dragged and the opposite edge is what stays put — unless Alt/Option asks for
      // the centre instead, which releases that edge and lets both travel. Hence the
      // doubling: one pointer delta now buys two edges' worth of size. The panel's
      // anchor picker governs panel edits, which have no handle to disagree with.
      const fromCenter = p.altKey && !scaleMode;
      const grow = fromCenter ? 2 : 1;
      const anchor = fromCenter ? CENTER_ANCHOR : ANCHOR_FROM_HANDLE[handle];

      let width = start.width;
      let height = start.height;
      if (movesWidth(handle)) {
        width = Math.max(10, Math.round(start.width + grow * (EAST.includes(handle) ? dx : -dx)));
      }
      if (movesHeight(handle)) {
        height = Math.max(10, Math.round(start.height + grow * (SOUTH.includes(handle) ? dy : -dy)));
      }
      // A corner is locked to the union's ratio while Shift is held or the Scale
      // tool is on. The lock also settles the question below: a snap answers one
      // edge at a time, so letting it rewrite the width would leave the height
      // this line just derived from it — the union comes back squashed instead
      // of scaled. `resolveResizeBox` holds the same invariant on the
      // single-layer path and reports it as `aspectActive`; this is the multi
      // selection's only statement of it.
      const locked = CORNERS.includes(handle) && (p.shiftKey || Boolean(scaleMode));
      if (locked) {
        height = Math.max(10, Math.round(width / aspect));
      }

      if (!locked) {
        // Snap in CANVAS space, like the single-layer path: the union is already a
        // world-space box, so unlike a nested element it needs no parent rebase, and
        // feeding it a parent-local rect is what made that path compare a child against
        // two coordinate systems (LESSONS §34).
        const rect = currentContainerRect();
        const vp = rect ? calculateVisibleViewport(pan, zoom, rect.width, rect.height, 0) : null;
        // The same candidate set the single-layer resize and the move drag read:
        // hidden layers are not magnets, and the walk stops at the dragged roots'
        // siblings and the containers above them instead of descending into every
        // unrelated frame on the page. Listed once for the gesture — nothing in
        // the set moves while the selection is being scaled, so only the viewport
        // (a wheel can still zoom mid-drag) can invalidate it.
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
          boxFromAnchor(anchor, start, width, height),
          zoom,
          pageCanvas.width,
          pageCanvas.height,
          siblings
        );
        // Unconditional, so guides from a frame that happened to hit something do not
        // outlive the drag — they are a statement about where the pointer is now.
        setActiveGuides(snap.guides);
        if (movesWidth(handle)) width = Math.max(10, snap.width);
        if (movesHeight(handle)) height = Math.max(10, snap.height);
      } else {
        // Guides from the frame before the lock went down describe a snap this
        // frame is not taking.
        setActiveGuides([]);
      }

      setDoc((prev) => {
        const kx = start.width > 0 ? width / start.width : 1;
        const ky = start.height > 0 ? height / start.height : 1;
        // Written even at 1x: the frame before this one was already scaled from the
        // same snapshot, so skipping the commit here would leave the last frame's
        // size standing when the pointer comes back to where it started.
        const scaled = scaleElementsByFactor(startElements, selectedIds, kx, ky, anchor);
        // No `sizeOverride` on the instances here, for the same reason the
        // single-layer scale path writes none: the factor IS the size, and the
        // flag would cut the instance off from its master's next resize. It only
        // ever looked necessary because the relayout below would otherwise take
        // an instance's hugging box back — a scaled hug now measures its own
        // scaled contents, so it lands where the drag put it.
        // Settled against the document this frame produces: the store's resolver
        // describes the frame before it, so a drag that scales a master and its
        // instance would measure the instance against the master's old box.
        return settleScaledDocument(updateActivePageElements(prev, scaled));
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
      setDoc((prev) => settleScaledDocument(prev));
      endDragGesture();
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
  };

  return { handleMultiResizePointerDown };
}
