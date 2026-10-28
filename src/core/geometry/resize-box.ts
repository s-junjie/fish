import { ResizeHandleType } from "./snap-guides";

export interface ResizeBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ResolveResizeBoxInput {
  /** The drag-start box. Every frame measures from this, never from the last one. */
  start: ResizeBox;
  /** The pointer delta in the element's own (unrotated) frame. */
  localDx: number;
  localDy: number;
  handle: ResizeHandleType;
  rotation: number;
  /** The axes the layout engine owns: the drag must not write them. */
  lockW: boolean;
  lockH: boolean;
  aspectLocked: boolean;
  shiftKey: boolean;
  /**
   * Alt/Option: pin the CENTRE instead of the edge opposite the handle. Both
   * edges then travel, so one pointer delta produces twice the size change.
   *
   * Ignored under `scaleMode`, where the anchor belongs to the operation the
   * panel is showing — a transient modifier must not fight a control the user
   * set on purpose.
   */
  fromCenter: boolean;
  /**
   * A scale sets the SIZE and leaves the position to its anchor, so the west/north
   * adjustments are skipped: they exist to pin the opposite edge, which is exactly
   * the anchor's job and would otherwise fight it. The handle still decides which
   * axes move.
   */
  scaleMode: boolean;
}

/** The floor on an edge a drag may produce, in canvas pixels. */
const MIN_SIZE = 10;

const CORNERS: ResizeHandleType[] = ["tl", "tr", "br", "bl"];
const EAST: ResizeHandleType[] = ["mr", "tr", "br"];
const WEST: ResizeHandleType[] = ["ml", "tl", "bl"];
const SOUTH: ResizeHandleType[] = ["bm", "bl", "br"];
const NORTH: ResizeHandleType[] = ["tm", "tl", "tr"];

/**
 * The box a resize drag produces, from the drag-start box and the pointer.
 *
 * Two invariants the order of the arithmetic exists to hold:
 *
 * 1. **The anchored edge does not move.** A west/north drag pins the opposite
 *    edge, which means the origin shifts by however much that size changed. The
 *    ratio constraint replaces the height AFTER the pointer asks for it, so the
 *    origin has to be derived from the height that survived — derive it from the
 *    raw one and a locked `tl` / `tr` drag drifts by `lockedH - rawH`, sliding
 *    the box out from under the pointer. `bl` / `br` never showed it: their
 *    origin does not depend on the height at all.
 * 2. **Snapping and the ratio constraint are mutually exclusive**, so a caller
 *    that snaps must not also lock the ratio: the snapped width would come back
 *    and the ratio would have to reject it. `aspectActive` reports which of the
 *    two this call is, so the caller can skip its snap rather than discover the
 *    conflict by having one of them silently win.
 *
 * Alt/Option replaces invariant 1 with its mirror: the edge opposite the handle
 * is released and the CENTRE is pinned instead. That is the same arithmetic
 * about a different point — both edges travel, so the size changes by twice the
 * delta and the origin by half of it — which is why it reuses the same rotation
 * rather than a second code path. Shift composes with it untouched, because the
 * ratio constraint rewrites the height BEFORE the origin is derived, so
 * Shift+Alt is a locked resize about the centre and needs no special case.
 */
export function resolveResizeBox(input: ResolveResizeBoxInput): ResizeBox & { aspectActive: boolean } {
  const { start, handle, rotation, lockW, lockH, aspectLocked, shiftKey, scaleMode } = input;
  const rad = (rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);

  // A centre-anchored drag moves BOTH edges, so the pointer delta buys twice the
  // size — and the origin below has to travel by half of what it produced.
  const fromCenter = input.fromCenter && !scaleMode;
  const grow = fromCenter ? 2 : 1;

  let width = start.width;
  let height = start.height;

  if (!lockW) {
    if (EAST.includes(handle)) {
      width = Math.max(MIN_SIZE, Math.round(start.width + input.localDx * grow));
    } else if (WEST.includes(handle)) {
      width = Math.max(MIN_SIZE, Math.round(start.width - input.localDx * grow));
    }
  }

  if (!lockH) {
    if (SOUTH.includes(handle)) {
      height = Math.max(MIN_SIZE, Math.round(start.height + input.localDy * grow));
    } else if (NORTH.includes(handle)) {
      height = Math.max(MIN_SIZE, Math.round(start.height - input.localDy * grow));
    }
  }

  const aspect = start.width / Math.max(1, start.height);
  const aspectActive = (aspectLocked || shiftKey) && !lockW && !lockH && CORNERS.includes(handle);
  if (aspectActive) {
    height = Math.max(MIN_SIZE, Math.round(width / aspect));
  }

  let x = start.x;
  let y = start.y;
  if (scaleMode) {
    // The anchor owns the position — it is the operation's own, applied by
    // `scaleElementsToSize`, and deriving an origin here would fight it.
  } else if (fromCenter) {
    /**
     * The centre is what stays put, so the origin moves by HALF of each axis'
     * change — and along the element's own axes, which is the same rotation the
     * pinned-edge shifts below use. Derived from the size that SURVIVED the ratio
     * constraint, for the reason in the header note: a locked corner drag would
     * otherwise slide the box out from under the pointer.
     */
    const localDx = (start.width - width) / 2;
    const localDy = (start.height - height) / 2;
    x = Math.round(start.x + localDx * cos - localDy * sin);
    y = Math.round(start.y + localDx * sin + localDy * cos);
  } else {
    if (!lockW && WEST.includes(handle)) {
      const deltaW = start.width - width;
      x = Math.round(start.x + deltaW * cos);
      y = Math.round(start.y + deltaW * sin);
    }
    if (!lockH && NORTH.includes(handle)) {
      const deltaH = start.height - height;
      x = Math.round(x - deltaH * sin);
      y = Math.round(y + deltaH * cos);
    }
  }

  return { x, y, width, height, aspectActive };
}
