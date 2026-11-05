import { DesignDocument, DesignElement, Paint } from "../../../core/dsl/types";
import { linearLeverEndpoints, getPaintColor, getGradientStops, isGradientPaint } from "../../../core/geometry/gradient-utils";
import { clampStopOffset, insertStopAt, roundOffset, withStops } from "../../color-panel/stop-edit";
import { stopAxisOf } from "../../canvas/gradient-stop-axis";
import type { GradientPaint } from "../../color-panel/kind-memory";
import { mirrorEndpoint, snapEndpointAngle, snapGradientAngle } from "../../../core/geometry/gradient-lever";
import { worldMatrixOf } from "../../../core/interactions/component-swap";
import { invert, transformPoint } from "../../../core/geometry/matrix";
import { writeNodeEdit } from "../../../core/interactions/instance-overrides";
import { createRafCoalescer } from "../../raf";
import { setGradientDrag, setGradientStopIndex } from "../gradient-edit";
import type { GeometryGestureContext } from "./geometry-gestures";

/**
 * `axis` is the line BODY of a linear gradient: dragging it translates both
 * endpoints, which is the one edit the two end grips cannot express — moving a
 * gradient without also rotating it meant dragging each end to the same new
 * place, twice, and never landing on the same vector.
 */
export type GradientHandle = "start" | "end" | "center" | "rimX" | "rimY" | "sweep" | "axis";

const round4 = (n: number) => Math.round(n * 10000) / 10000;
const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

type PaintStack = "fills" | "strokes";

/** The paint a row paints — a fill row owns it directly, a stroke row nests it. */
const rowPaintOf = (el: DesignElement, stack: PaintStack, index: number): Paint | undefined =>
  stack === "strokes" ? el.strokes?.[index]?.paint : el.fills?.[index];

/**
 * Writes one row's paint back, on whichever stack it lives.
 *
 * A stroke row keeps its paint in `stroke.paint` with the pre-paint `color`
 * mirror beside it, so the re-aimed paint has to be written there and the mirror
 * kept in step — or the row's swatch and its artwork would disagree about what
 * the row paints.
 */
const writeRowPaint = (
  prev: DesignDocument,
  el: DesignElement,
  stack: PaintStack,
  paintIndex: number,
  patch: (p: Paint) => Paint
): DesignDocument =>
  writeNodeEdit(prev, el.id, (item) => {
    if (stack === "strokes") {
      const strokes = item.strokes;
      const row = strokes?.[paintIndex];
      if (!strokes || !row) return item;
      const base = (row.paint ?? { type: "solid", color: row.color ?? "#FFFFFF" }) as Paint;
      const next = patch(base);
      return {
        ...item,
        strokes: strokes.map((stroke, i) =>
          i === paintIndex ? { ...stroke, paint: next, color: getPaintColor(next) } : stroke
        )
      };
    }
    const fills = item.fills;
    if (!fills || !fills[paintIndex]) return item;
    return { ...item, fills: fills.map((p, i) => (i === paintIndex ? patch(p) : p)) };
  }) ?? prev;

interface DragPoint {
  x: number;
  y: number;
  shiftKey: boolean;
  altKey: boolean;
}

/**
 * The on-canvas gradient lever: linear rotates `angle` from either end of the
 * axis; radial drags `center` with the middle dot, `angle` + `rx` with the rim
 * handle on the ellipse's first axis, and `ry` with the one on the second;
 * angular drags `center` and, with the `sweep` grip, where a full turn starts;
 * diamond reuses the centre dot and both rim grips for its own axes.
 * Every paint keeps its other keys — a drag must not restyle the layer it
 * re-aims. All math happens in the element's UNROTATED local box (the overlay
 * draws the handles inside the same rotated `<g>` the resize handles live in),
 * so the pointer is inverse-rotated before anything is derived.
 *
 * The one thing that is NOT shared is the SPACE an angle is measured in, and it
 * is not a detail: a radial's ellipse is defined in box FRACTIONS (its
 * `gradientTransform` rotates there, then the box stretches it), while the
 * angular sweep is a true circle in px (`dirFromTop`) and a diamond's quadrants
 * are rotated with `rotate(φ, c)` in px. Deriving the wrong one gives a handle
 * that only tracks the pointer on a square element.
 *
 * MODIFIERS follow the canvas' own grammar (`drag-apply.ts`, `geometry-gestures`):
 * Shift constrains the ANGLE to 15° steps and never touches the length; Alt
 * mirrors the axis about the midpoint it had when the drag began.
 */
export function createGradientGesture(ctx: GeometryGestureContext) {
  const { docRef, setDoc, pan, zoom, canvasContainerRef, startDragGesture, endDragGesture } = ctx;

  const handleGradientHandlePointerDown = (
    e: PointerEvent,
    el: DesignElement,
    paintIndex: number,
    which: GradientHandle,
    stack: "fills" | "strokes" = "fills"
  ) => {
    if (e.button !== 0) return;
    if (el.locked) return;
    e.stopPropagation();
    e.preventDefault();
    // No derived-node refusal: the lever writes `fills`, which IS overridable, so
    // `writeNodeEdit` lands the re-aimed paint on the instance that owns the
    // clone. Refusing it made the gradient of a card's inner panel reachable only
    // from the main component.
    const container = canvasContainerRef.current;
    if (!container) return;

    // The pointer is brought into the element's own UNROTATED box through the
    // FULL world matrix — its own turn and every ancestor's — because that is the
    // space the overlay draws these handles in. Turning back by `el.rotation`
    // alone left the pointer in a space that is already turned when the element
    // sits inside a turned frame, so the handle the user grabbed and the paint
    // the drag wrote drifted apart by however far the frame had carried it.
    const toLocal = invert(worldMatrixOf(docRef.current, el));
    // A degenerate chain cannot be turned back, so there is nothing to aim.
    if (!toLocal) return;
    const centerX = el.x + el.width / 2;
    const centerY = el.y + el.height / 2;
    // rimY drags along the ellipse's second axis, so the rotation it measures
    // against is frozen at pointer-down: the drag never rotates, only scales.
    const startPaint = (stack === "strokes"
      ? el.strokes?.[paintIndex]?.paint ?? {}
      : el.fills?.[paintIndex] ?? {}) as {
      type?: Paint["type"];
      angle?: number;
      center?: { x: number; y: number };
      start?: { x: number; y: number };
      end?: { x: number; y: number };
    };
    const paintType = startPaint.type;
    const startAngle = ((startPaint.angle ?? 0) * Math.PI) / 180;
    // The rim handles ride the GRADIENT's centre, which is not the box centre —
    // the fraction offsets below must be measured from the paint's centre.
    const centerFraction = { x: startPaint.center?.x ?? 0.5, y: startPaint.center?.y ?? 0.5 };
    // That same centre in local px, as an offset from the box centre: the px
    // branch below reads the pointer in this-space, not in fractions.
    const pxCenterDx = (centerFraction.x - 0.5) * el.width;
    const pxCenterDy = (centerFraction.y - 0.5) * el.height;

    // The linear axis as it was when the drag began. Frozen on purpose: the
    // opposite end is the anchor of every rotation in this drag, and Alt mirrors
    // about this midpoint, so re-reading it each frame would make the anchor
    // chase the edit it is supposed to hold still.
    const lever0 = linearLeverEndpoints(startPaint.angle ?? 90, el.width, el.height);
    const start0 = startPaint.start ?? {
      x: round4(lever0.start.x / el.width),
      y: round4(lever0.start.y / el.height)
    };
    const end0 = startPaint.end ?? {
      x: round4(lever0.end.x / el.width),
      y: round4(lever0.end.y / el.height)
    };
    const mid0 = { x: (start0.x + end0.x) / 2, y: (start0.y + end0.y) / 2 };

    const applyPaint = (prev: DesignDocument, patch: (p: Paint) => Paint): DesignDocument =>
      writeRowPaint(prev, el, stack, paintIndex, patch);

    // The axis body carries two gestures at once — CLICK adds a stop, DRAG
    // translates the gradient — so its drag starts on the first movement past a
    // threshold, not on the press. A press that never moves is a click, and the
    // panel's ramp has taught everyone that a click there adds a colour.
    const origCursor = document.body.style.cursor;
    const isAxis = which === "axis";
    let axisDragging = false;
    let lastPointer = { x: e.clientX, y: e.clientY };
    if (!isAxis) {
      document.body.style.cursor = "grabbing";
      startDragGesture();
    }

    const rect = container.getBoundingClientRect();
    const toLocalPoint = (clientX: number, clientY: number) =>
      transformPoint(toLocal, {
        x: (clientX - rect.left - pan.x) / zoom,
        y: (clientY - rect.top - pan.y) / zoom
      });
    // The axis body has no parametric definition to read the pointer against —
    // what it needs is the DISTANCE travelled since the press.
    const localAtDown = toLocalPoint(e.clientX, e.clientY);
    const boxSize = { width: el.width, height: el.height };

    const coalescer = createRafCoalescer<DragPoint>((p) => {
      if (isAxis && !axisDragging) return;
      const local = toLocalPoint(p.x, p.y);
      const lx = local.x - centerX;
      const ly = local.y - centerY;
      // The readout rides the pointer in the same space the overlay draws the
      // lever in — no second projection, so the badge cannot drift from the grip.
      setGradientDrag({ elId: el.id, paintIndex, handle: which, x: local.x, y: local.y });
      // Pointer offset from the box centre, in box fractions — the space the
      // radial's geometry lives in.
      const fx = lx / el.width;
      const fy = ly / el.height;
      // …and the same offset from the PAINT's centre in px, for the two kinds
      // whose angle is measured there (see the header).
      const gx = lx - pxCenterDx;
      const gy = ly - pxCenterDy;

      if (which === "axis") {
        const dfx = (local.x - localAtDown.x) / el.width;
        const dfy = (local.y - localAtDown.y) / el.height;
        const start = { x: round4(start0.x + dfx), y: round4(start0.y + dfy) };
        const end = { x: round4(end0.x + dfx), y: round4(end0.y + dfy) };
        // `angle` is invariant under translation, so it is left exactly as it
        // was: rewriting it from the moved pair would only add rounding noise.
        setDoc((prev) => applyPaint(prev, (paint) => ({ ...paint, start, end })));
        return;
      }

      if (which === "start" || which === "end") {
        // First drag materializes the symmetric axis as explicit points (the
        // `angle` shorthand has no independent ends), then the dragged handle
        // tracks the pointer directly — Figma's model. Values may leave the
        // box: the gradient line is legal outside 0..1. `angle` rides along
        // synced so the inspector scrub and the axis can never disagree.
        const fixedEnd = which === "start" ? end0 : start0;
        let moved = { x: round4(0.5 + fx), y: round4(0.5 + fy) };
        // Alt holds the axis symmetric: the pointer aims one half and the other
        // is its mirror, so snapping has to be measured from the midpoint the
        // mirror is taken about — measuring from the (now moving) far end would
        // make the snap fight the mirror.
        const anchor = p.altKey ? mid0 : fixedEnd;
        if (p.shiftKey) moved = snapEndpointAngle(anchor, moved, boxSize);
        const start = p.altKey && which === "end" ? mirrorEndpoint(mid0, moved) : null;
        const end = p.altKey && which === "start" ? mirrorEndpoint(mid0, moved) : null;
        const nextStart = which === "start" ? moved : start ?? start0;
        const nextEnd = which === "end" ? moved : end ?? end0;
        // px, not fractions: `angle` is CSS's, measured in the box's own
        // space, so the delta has to be in one uniform unit before the
        // inverse — a fraction delta returns the normalised-box angle.
        const dx = (nextEnd.x - nextStart.x) * el.width;
        const dy = (nextEnd.y - nextStart.y) * el.height;
        const angle = Math.round(((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360) % 360;
        setDoc((prev) => applyPaint(prev, (paint) => ({ ...paint, start: nextStart, end: nextEnd, angle })));
        return;
      }

      if (which === "center") {
        const center = { x: round4(clamp01(0.5 + fx)), y: round4(clamp01(0.5 + fy)) };
        setDoc((prev) => applyPaint(prev, (paint) => ({ ...paint, center })));
        return;
      }

      if (which === "sweep") {
        // Where a full turn starts, degrees clockwise from top: the inverse of
        // the renderer's `dirFromTop` = (sin θ, −cos θ), so θ = atan2(dx, −dy).
        const raw = Math.round(((Math.atan2(gx, -gy) * 180) / Math.PI + 360) % 360) % 360;
        const angle = p.shiftKey ? snapGradientAngle(raw) : raw;
        setDoc((prev) => applyPaint(prev, (paint) => ({ ...paint, angle })));
        return;
      }

      if (which === "rimX") {
        // The first-axis handle is Figma's rotation grip: it points at the
        // pointer AND stretches to it, so one drag aims and sizes the axis.
        if (paintType === "diamond-gradient") {
          // A diamond's semi-axes are `rx·W` / `ry·H` px and its rotation is a
          // px-space `rotate(φ, c)` about the centre, so both the angle and the
          // axis length come straight out of the px offset.
          const raw = Math.round(((Math.atan2(gy, gx) * 180) / Math.PI + 360) % 360) % 360;
          const angle = p.shiftKey ? snapGradientAngle(raw) : raw;
          const rx = round4(Math.hypot(gx, gy) / el.width);
          setDoc((prev) => applyPaint(prev, (paint) => ({ ...paint, angle, rx })));
          return;
        }
        // Radial: measured from the gradient's own centre, in fractions.
        const dx = 0.5 + fx - centerFraction.x;
        const dy = 0.5 + fy - centerFraction.y;
        const raw = Math.round(((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360) % 360;
        const angle = p.shiftKey ? snapGradientAngle(raw) : raw;
        const rx = round4(Math.hypot(dx, dy));
        setDoc((prev) => applyPaint(prev, (paint) => ({ ...paint, angle, rx })));
        return;
      }

      // Second axis. `ux`/`uy` is the first axis' direction — for a diamond the
      // same vector, but in px, so the projection has to be too.
      const ux = -Math.sin(startAngle);
      const uy = Math.cos(startAngle);
      const ry =
        paintType === "diamond-gradient"
          ? round4(Math.max(0, (gx * ux + gy * uy) / el.height))
          : round4(Math.max(0, (0.5 + fx - centerFraction.x) * ux + (0.5 + fy - centerFraction.y) * uy));
      setDoc((prev) => applyPaint(prev, (paint) => ({ ...paint, ry })));
    });

    const onPointerMove = (moveEvt: PointerEvent) => {
      lastPointer = { x: moveEvt.clientX, y: moveEvt.clientY };
      if (isAxis && !axisDragging) {
        if (Math.hypot(moveEvt.clientX - e.clientX, moveEvt.clientY - e.clientY) < 3) return;
        axisDragging = true;
        document.body.style.cursor = "grabbing";
        startDragGesture();
      }
      coalescer.push({
        x: moveEvt.clientX,
        y: moveEvt.clientY,
        shiftKey: moveEvt.shiftKey,
        altKey: moveEvt.altKey
      });
    };

    const stopListening = () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerCancel);
    };

    const onPointerUp = () => {
      coalescer.flush();
      stopListening();
      document.body.style.cursor = origCursor;
      setGradientDrag(null);
      if (isAxis && !axisDragging) {
        // A click on the axis adds a stop where it landed — the canvas' version
        // of clicking the panel's ramp. Dropping a stop is not an edit worth an
        // undo step of its own: it is one write, so it is one entry.
        const paint = rowPaintOf(el, stack, paintIndex);
        if (paint && isGradientPaint(paint)) {
          const axis = stopAxisOf(el, paint, { x: el.x, y: el.y });
          const local = toLocalPoint(lastPointer.x, lastPointer.y);
          if (axis) handleGradientStopAddAt(el, paintIndex, axis.paramAt(local), stack);
        }
        return;
      }
      if (isAxis) axisDragging = false;
      endDragGesture();
    };

    /**
     * A cancelled pointer — window blur, a trackpad gesture, the browser taking
     * the pointer back — ends the drag where it stands, but it is NOT a click:
     * the axis must not drop a stop at a position nobody released on, so the
     * branch above has no counterpart here. The pending frame is dropped rather
     * than flushed for the same reason: nobody ever saw it.
     *
     * Without this listener the gesture stayed open and `document.body.style
     * .cursor` kept saying "grabbing" for the rest of the session — the knob's
     * own `pointercancel` listener only released the knob's hover state.
     */
    const onPointerCancel = () => {
      stopListening();
      document.body.style.cursor = origCursor;
      setGradientDrag(null);
      if (isAxis) axisDragging = false;
      endDragGesture();
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerCancel);
  };

  const localPoint = (el: DesignElement, clientX: number, clientY: number) => {
    const container = canvasContainerRef.current;
    if (!container) return null;
    const toLocal = invert(worldMatrixOf(docRef.current, el));
    if (!toLocal) return null;
    const rect = container.getBoundingClientRect();
    return transformPoint(toLocal, {
      x: (clientX - rect.left - pan.x) / zoom,
      y: (clientY - rect.top - pan.y) / zoom
    });
  };

  /**
   * Drag a stop along the axis it lives on.
   *
   * All four dialects have one — the line, the first radius, or the sweep
   * circle — and `stopAxisOf` is the only place that knows which. Clamping reads
   * the ramp as it was at pointerdown: the neighbours do not move during this
   * drag, and re-reading a stop that is being clamped against itself would
   * freeze it at its own edge.
   */
  const handleGradientStopPointerDown = (
    e: PointerEvent,
    el: DesignElement,
    paintIndex: number,
    stopIndex: number,
    stack: PaintStack = "fills"
  ) => {
    if (e.button !== 0 || el.locked) return;
    e.stopPropagation();
    e.preventDefault();
    setGradientStopIndex(stopIndex);
    const paint = rowPaintOf(el, stack, paintIndex);
    if (!paint || !isGradientPaint(paint)) return;
    const axis = stopAxisOf(el, paint, { x: el.x, y: el.y });
    if (!axis) return;
    const stops0 = getGradientStops(paint);
    if (!stops0[stopIndex]) return;

    const origCursor = document.body.style.cursor;
    document.body.style.cursor = "grabbing";
    startDragGesture();
    const coalescer = createRafCoalescer<{ x: number; y: number }>((p) => {
      const local = localPoint(el, p.x, p.y);
      if (!local) return;
      const offset = clampStopOffset(stops0, stopIndex, roundOffset(axis.paramAt(local)));
      const next = stops0.map((stop, i) => (i === stopIndex ? { ...stop, offset } : stop));
      setDoc((prev) =>
        writeRowPaint(prev, el, stack, paintIndex, (live) => withStops(live as GradientPaint, next))
      );
    });

    const onPointerMove = (moveEvt: PointerEvent) =>
      coalescer.push({ x: moveEvt.clientX, y: moveEvt.clientY });
    const stopListening = () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerCancel);
    };
    const onPointerUp = () => {
      coalescer.flush();
      stopListening();
      document.body.style.cursor = origCursor;
      endDragGesture();
    };
    // Same reason as the handle drag above: a cancelled pointer must still put
    // the body cursor back and close the undo entry the press opened.
    const onPointerCancel = () => {
      stopListening();
      document.body.style.cursor = origCursor;
      endDragGesture();
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerCancel);
  };

  /** Insert a stop at an exact offset — the visible add grip's whole gesture. */
  const handleGradientStopAddAt = (
    el: DesignElement,
    paintIndex: number,
    offset: number,
    stack: PaintStack = "fills"
  ) => {
    if (el.locked) return;
    const paint = rowPaintOf(el, stack, paintIndex);
    if (!paint || !isGradientPaint(paint)) return;
    const { stops, index } = insertStopAt(getGradientStops(paint), roundOffset(offset));
    setDoc((prev) =>
      writeRowPaint(prev, el, stack, paintIndex, (live) => withStops(live as GradientPaint, stops))
    );
    setGradientStopIndex(index);
  };

  /** A double-click on the axis adds a stop where the pointer landed. */
  const handleGradientStopInsert = (
    e: PointerEvent,
    el: DesignElement,
    paintIndex: number,
    stack: PaintStack = "fills"
  ) => {
    if (el.locked) return;
    e.stopPropagation();
    e.preventDefault();
    const paint = rowPaintOf(el, stack, paintIndex);
    if (!paint || !isGradientPaint(paint)) return;
    const local = localPoint(el, e.clientX, e.clientY);
    if (!local) return;
    const axis = stopAxisOf(el, paint, { x: el.x, y: el.y });
    if (!axis) return;
    handleGradientStopAddAt(el, paintIndex, axis.paramAt(local), stack);
  };

  /**
   * Delete the stop, never the layer.
   *
   * Returns `true` whenever the key was consumed — including when the ramp has
   * only two stops left, where the honest answer is "nothing to remove" rather
   * than letting the key fall through to the editor's delete.
   */
  const handleGradientStopDelete = (
    el: DesignElement,
    paintIndex: number,
    stopIndex: number,
    stack: PaintStack = "fills"
  ): boolean => {
    const paint = rowPaintOf(el, stack, paintIndex);
    if (!paint || !isGradientPaint(paint)) return false;
    const stops = getGradientStops(paint);
    if (stops.length <= 2) return true;
    setDoc((prev) =>
      writeRowPaint(prev, el, stack, paintIndex, (live) =>
        withStops(
          live as GradientPaint,
          stops.filter((_, i) => i !== stopIndex)
        )
      )
    );
    setGradientStopIndex(Math.max(0, stopIndex - 1));
    return true;
  };

  return {
    handleGradientHandlePointerDown,
    handleGradientStopPointerDown,
    handleGradientStopInsert,
    handleGradientStopDelete
  };
}
