import {
  DesignDocument,
  DesignElement,
  ImageCrop,
  Paint,
  getActivePage
} from "../../../core/dsl/types";
import { findElementById } from "../../../core/geometry/tree-ops";
import { worldMatrixOf } from "../../../core/interactions/component-swap";
import { writeNodeEdit } from "../../../core/interactions/instance-overrides";
import { getRotateCursor } from "../../../core/geometry/transforms";
import { invert, transformPoint } from "../../../core/geometry/matrix";
import { elementAABB } from "../../../core/geometry/element-bounds";
import { transformBoundsToAABB } from "../../../core/geometry/bounds";
import {
  CropBox,
  CropCorner,
  CropHandle,
  CropNatural,
  assetNaturalSize,
  canPlaceCrop,
  clampCrop,
  cropHandleToResize,
  cropFromMove,
  cropFromRotate,
  cropPinnedToBox,
  imageCropPlacement
} from "../../../core/geometry/image-crop";
import { createRafCoalescer } from "../../raf";
import { createGeometryGestures, type GeometryGestureContext } from "./geometry-gestures";

/** Shift's rung on the rotate drag, in degrees — Figma's own 15°. */
const ROTATE_SNAP_DEGREES = 15;

/** Shift's rung applied to an absolute angle, not to the delta. */
const snapDegrees = (deg: number) => Math.round(deg / ROTATE_SNAP_DEGREES) * ROTATE_SNAP_DEGREES;

/**
 * One frame drag's reference frame, or null.
 *
 * A ref rather than a local, because `useCanvasGestures` rebuilds this factory on
 * every render and a drag spans many of them: a local would be cleared by the
 * very first frame the drag wrote. The pin is re-solved from the DRAG's snapshot
 * every frame rather than from the previous frame for the same class of reason —
 * a resize rounds its box to whole pixels, and pinning frame-to-frame would
 * compound that rounding once per pointer event.
 */
export interface CropPinFrame {
  elId: string;
  paintIndex: number;
  /** The framing as it stood at pointer-down. */
  crop: ImageCrop;
  natural: CropNatural;
  from: { box: CropBox; origin: { x: number; y: number } };
  /** The element's own rotation, which the drag does not change. */
  rotation: number;
}

interface OpenCropDrag {
  el: DesignElement;
  paintIndex: number;
  box: CropBox;
  natural: CropNatural;
  start: ImageCrop;
  /** A client point, in the box's own space: px from the element's top-left. */
  toBoxSpace: (clientX: number, clientY: number) => { x: number; y: number };
}

/**
 * Crop mode's three gestures: drag the bitmap under the window, resize the frame
 * it is seen through, and turn the bitmap.
 *
 * The frame IS the element's box, so its handles are a RESIZE — the transform
 * box's own, delegated rather than re-written, because a second resize would be
 * free to disagree with it about snapping, the 10px floor, constraints and
 * instances. What the delegation adds is one more write per frame: the fill's
 * `crop` is re-solved against the box the resize just produced, so the bitmap
 * keeps the canvas rect it already had and the drag reads as a crop rather than
 * as a scale.
 *
 * The pointer is converted into the BOX's own space before anything is derived
 * — the element's own rotation is turned back first — for the reason recorded in
 * `gradient-gesture.ts`: a handle that tracks the pointer only on an unrotated
 * layer is the bug that convention exists to prevent.
 */
export function createImageCropGesture(
  ctx: GeometryGestureContext & { framePinRef: { current: CropPinFrame | null } }
) {
  const {
    docRef,
    setDoc,
    pan,
    zoom,
    canvasContainerRef,
    startDragGesture,
    endDragGesture,
    framePinRef
  } = ctx;

  /** Write a new framing into one fill row, by id — the only crop write there is. */
  const applyCrop = (
    prev: DesignDocument,
    elId: string,
    paintIndex: number,
    next: ImageCrop
  ): DesignDocument =>
    writeNodeEdit(prev, elId, (item) => {
      const fills = item.fills;
      if (!fills || !fills[paintIndex]) return item;
      return {
        ...item,
        fills: fills.map((p, i) =>
          i === paintIndex && p.type === "image" ? { ...p, fit: "crop", crop: next } : p
        )
      };
    }) ?? prev;

  const sameCrop = (a: ImageCrop, b: ImageCrop): boolean =>
    a.x === b.x && a.y === b.y && a.scale === b.scale && (a.rotation ?? 0) === (b.rotation ?? 0);

  /**
   * Re-solve the pinned row against the box the resize just wrote.
   *
   * It runs AFTER the resize's own updater rather than instead of it: the
   * geometry is the resize's business and the framing is this one's, so the two
   * meet in the document rather than in each other's solver. Returning the doc
   * untouched when the numbers come out identical is what keeps a frame that did
   * not move — and the relayout the resize runs on release — from re-rendering
   * the canvas for nothing.
   */
  const pinCropIn = (doc: DesignDocument, pin: CropPinFrame): DesignDocument => {
    const el = findElementById(getActivePage(doc).children, pin.elId);
    if (!el) return doc;
    const paint = (el.fills ?? [])[pin.paintIndex] as Paint | undefined;
    if (!paint || paint.type !== "image") return doc;
    // Same reason as the frame that armed the pin: the destination box is where
    // the element PAINTS, and a turned ancestor has moved that from the stored
    // `x`/`y`.
    const worldBox = transformBoundsToAABB(elementAABB(el), worldMatrixOf(doc, el))!;
    const next = cropPinnedToBox({
      crop: pin.crop,
      natural: pin.natural,
      from: pin.from,
      to: {
        box: { width: el.width, height: el.height },
        origin: { x: worldBox.x, y: worldBox.y }
      },
      rotation: pin.rotation
    });
    if (paint.crop && sameCrop(paint.crop, next)) return doc;
    return applyCrop(doc, pin.elId, pin.paintIndex, next);
  };

  /**
   * The transform box's own resize, re-created against a `setDoc` that re-pins
   * the bitmap after every frame it writes.
   *
   * A second instance of the factory rather than a second implementation:
   * `createGeometryGestures` builds closures and holds no state of its own, so
   * the two instances differ in exactly one thing — what happens to the document
   * after a frame lands. The alternative, teaching the resize about crop, would
   * put a feature the transform box has no opinion about inside the transform
   * box's own handler.
   */
  const resize = createGeometryGestures({
    ...ctx,
    // A crop frame does not snap. The box here is a window over a bitmap, so its
    // edges are a boundary inside the picture rather than an alignment with the
    // page — and a guide is a MAGNET: an edge that starts on one (a photo that
    // fills its frame, which is the usual case) is dragged back onto it for
    // `SNAP_THRESHOLD` px before it lets go, which the hand reads as a dead zone
    // and then a jump. Cropping has no use for the alignment it buys.
    snapEnabled: false,
    setDoc: (updater) =>
      ctx.setDoc((prev) => {
        const next = updater(prev);
        const pin = framePinRef.current;
        return pin ? pinCropIn(next, pin) : next;
      })
  });

  /**
   * Everything a crop drag needs before it may open, or null.
   *
   * The refusals are ordered like every other geometry handle's — button, lock,
   * propagation — because `e.stopPropagation()` must not happen for a press the
   * canvas still owns (LESSONS #16/#34). A resolved clone is NOT refused: the crop
   * lives on `fills`, which an instance can own. A row whose bitmap has no
   * recorded natural size refuses quietly: the panel already gates that case with
   * a named reason, so a second message on every pointerdown would be noise on
   * top of it.
   */
  const openDrag = (e: PointerEvent, el: DesignElement, paintIndex: number): OpenCropDrag | null => {
    if (e.button !== 0) return null;
    if (el.locked) return null;
    e.stopPropagation();
    e.preventDefault();
    // A crop is a statement about the element's `fills`, which is overridable, so
    // a resolved clone can carry one — `applyCrop` writes through the instance.
    const container = canvasContainerRef.current;
    if (!container) return null;

    const paint = (el.fills ?? [])[paintIndex] as Paint | undefined;
    if (!paint || paint.type !== "image" || paint.fit !== "crop" || !paint.crop) return null;
    const natural = assetNaturalSize((docRef.current.assets ?? []).find((a) => a.id === paint.assetId));
    const box: CropBox = { width: el.width, height: el.height };
    if (!natural || !canPlaceCrop(box, natural)) return null;

    // The pointer comes in canvas space and the crop is written in the element's own
    // box, so it has to be carried back through the FULL world matrix — its own
    // turn and every ancestor's. Turning back by `el.rotation` alone left it in a
    // space already turned whenever the element sat inside a turned frame, and the
    // crop followed a point the user was not pointing at.
    const toLocal = invert(worldMatrixOf(docRef.current, el));
    if (!toLocal) return null;
    // One rect for the whole gesture: re-reading it per move forces a synchronous
    // layout flush on every pointer event (LESSONS #6).
    const rect = container.getBoundingClientRect();

    return {
      el,
      paintIndex,
      box,
      natural,
      start: paint.crop,
      toBoxSpace: (clientX, clientY) => {
        const worldPx = (clientX - rect.left - pan.x) / zoom;
        const worldPy = (clientY - rect.top - pan.y) / zoom;
        const local = transformPoint(toLocal, { x: worldPx, y: worldPy });
        // Box space is measured from the element's own origin.
        return { x: local.x - el.x, y: local.y - el.y };
      }
    };
  };

  /**
   * Run one crop drag to completion.
   *
   * The whole gesture is ONE history entry — `startDragGesture` / `endDragGesture`
   * bracket it and every frame is a transient write — and Escape puts back the
   * framing the drag started from, through the same write path, so the store sees
   * a document identical to its own snapshot and records nothing. That is
   * `cancelGesture` without a cancel channel: this gesture is the only one that
   * has something to put back, and it already holds it.
   */
  const runDrag = (
    open: OpenCropDrag,
    frame: (pointer: { x: number; y: number }, open: OpenCropDrag, shiftKey: boolean) => ImageCrop | null,
    onDone?: () => void
  ) => {
    const { el, paintIndex, start } = open;
    startDragGesture();
    let cancelled = false;

    const coalescer = createRafCoalescer<{ x: number; y: number; shiftKey: boolean }>((p) => {
      if (cancelled) return;
      const next = frame(open.toBoxSpace(p.x, p.y), open, p.shiftKey);
      if (!next) return;
      setDoc((prev) => applyCrop(prev, el.id, paintIndex, next));
    });

    const finish = () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("keydown", onKeyDown);
      endDragGesture();
      onDone?.();
    };

    const onPointerMove = (moveEvt: PointerEvent) => {
      coalescer.push({ x: moveEvt.clientX, y: moveEvt.clientY, shiftKey: moveEvt.shiftKey });
    };

    const onKeyDown = (keyEvt: KeyboardEvent) => {
      if (keyEvt.key !== "Escape") return;
      cancelled = true;
      // Drop any frame still queued: it was computed against the framing we are
      // about to put back, so letting it land afterwards would undo the undo.
      coalescer.flush();
      setDoc((prev) => applyCrop(prev, el.id, paintIndex, start));
      finish();
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", finish);
    window.addEventListener("keydown", onKeyDown);
  };

  const handleCropMovePointerDown = (e: PointerEvent, el: DesignElement, paintIndex: number) => {
    const open = openDrag(e, el, paintIndex);
    if (!open) return;
    // The origin is the pointer's own landing point, so the drag stays absolute:
    // releasing the offset clamp at an edge resumes from the edge instead of
    // running away by however far the pointer travelled past it.
    const from = open.toBoxSpace(e.clientX, e.clientY);
    runDrag(open, (pointer) => cropFromMove(open.start, open.box, pointer.x - from.x, pointer.y - from.y));
  };

  /**
   * One drag for all eight frame handles.
   *
   * A corner and an edge differ only in the one row `resolveResizeBox` reads —
   * which axes the pointer moves and which edge stays put — so they are the same
   * call, and the crop overlay gets the transform box's behaviour by construction
   * rather than by imitation.
   *
   * The pin is armed before the delegate runs, because the delegate writes its
   * first frame from a window listener rather than from this call: the state has
   * to be in place before the first pointer event, not after the press returns.
   */
  const handleCropHandlePointerDown = (
    e: PointerEvent,
    el: DesignElement,
    paintIndex: number,
    handle: CropHandle
  ) => {
    const open = openDrag(e, el, paintIndex);
    if (!open) return;
    // The pin re-frames the bitmap after every write the resize path makes. Its
    // `from` is where the element's box sits on the canvas, which a TURNED
    // ancestor has moved — so it is read through the same matrix the overlay
    // draws with rather than by adding an offset.
    const worldBox = transformBoundsToAABB(elementAABB(el), worldMatrixOf(docRef.current, el))!;
    framePinRef.current = {
      elId: el.id,
      paintIndex,
      crop: open.start,
      natural: open.natural,
      from: { box: open.box, origin: { x: worldBox.x, y: worldBox.y } },
      rotation: el.rotation || 0
    };
    // The delegate first, and only then the clear: its own `pointerup` flushes the
    // last frame of the drag through the pinned `setDoc`, and listeners fire in
    // registration order — so a clear registered ahead of it would drop the pin
    // before that write and leave the final pointer delta uncompensated. Bubble
    // phase for the same reason: capture would run it before the delegate's.
    resize.handleResizePointerDown(e, cropHandleToResize(handle), el);
    window.addEventListener(
      "pointerup",
      () => {
        framePinRef.current = null;
      },
      { once: true }
    );
  };

  /**
   * Rotation, with the canvas's own interaction: the zone sits just outside a
   * corner and there is nothing drawn in it, so the CURSOR is the entire
   * affordance. That is why it is re-drawn every frame rather than set once —
   * it has to keep pointing the way the bitmap would turn, which is also what
   * tells a user with a turned bitmap that this corner still turns it.
   */
  const handleCropRotatePointerDown = (
    e: PointerEvent,
    el: DesignElement,
    paintIndex: number,
    _corner: CropCorner,
    baseAngle: number
  ) => {
    const open = openDrag(e, el, paintIndex);
    if (!open) return;
    const placement = imageCropPlacement(open.box, open.natural, open.start);
    if (!placement) return;
    // The bitmap turns about the centre that `x`/`y`/`scale` alone decide, so a
    // turn can never move it and the offset never has to be re-solved.
    const center = { x: placement.centerX, y: placement.centerY };
    const from = open.toBoxSpace(e.clientX, e.clientY);

    const bodyCursor = document.body.style.cursor;
    const cursorAt = (rotation: number) => getRotateCursor(rotation + baseAngle);
    document.body.style.cursor = cursorAt(open.start.rotation ?? 0);

    runDrag(
      open,
      (pointer, _open, shiftKey) => {
        const next = cropFromRotate(open.start, center, from, pointer);
        const turned = shiftKey ? clampCrop({ ...next, rotation: snapDegrees(next.rotation ?? 0) }) : next;
        document.body.style.cursor = cursorAt(turned.rotation ?? 0);
        return turned;
      },
      () => {
        document.body.style.cursor = bodyCursor;
      }
    );
  };

  return { handleCropMovePointerDown, handleCropHandlePointerDown, handleCropRotatePointerDown };
}
