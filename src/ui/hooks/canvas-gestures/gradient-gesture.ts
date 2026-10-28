import { DesignDocument, DesignElement, Paint } from "../../../core/dsl/types";
import { linearLeverEndpoints } from "../../../core/geometry/gradient-utils";
import { worldMatrixOf } from "../../../core/interactions/component-swap";
import { invert, transformPoint } from "../../../core/geometry/matrix";
import { writeNodeEdit } from "../../../core/interactions/instance-overrides";
import { createRafCoalescer } from "../../raf";
import type { GeometryGestureContext } from "./geometry-gestures";

export type GradientHandle = "start" | "end" | "center" | "rimX" | "rimY" | "sweep";

const round4 = (n: number) => Math.round(n * 10000) / 10000;
const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

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
 */
export function createGradientGesture(ctx: GeometryGestureContext) {
  const { docRef, setDoc, pan, zoom, canvasContainerRef, startDragGesture, endDragGesture } = ctx;

  const handleGradientHandlePointerDown = (
    e: PointerEvent,
    el: DesignElement,
    paintIndex: number,
    which: GradientHandle
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
    const startPaint = (el.fills?.[paintIndex] ?? {}) as {
      type?: Paint["type"];
      angle?: number;
      center?: { x: number; y: number };
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

    const applyPaint = (prev: DesignDocument, patch: (p: Paint) => Paint): DesignDocument =>
      writeNodeEdit(prev, el.id, (item) => {
        const fills = item.fills;
        if (!fills || !fills[paintIndex]) return item;
        return { ...item, fills: fills.map((p, i) => (i === paintIndex ? patch(p) : p)) };
      }) ?? prev;

    startDragGesture();

    const rect = container.getBoundingClientRect();
    const coalescer = createRafCoalescer<{ x: number; y: number }>((p) => {
      const worldX = (p.x - rect.left - pan.x) / zoom;
      const worldY = (p.y - rect.top - pan.y) / zoom;
      const local = transformPoint(toLocal, { x: worldX, y: worldY });
      const lx = local.x - centerX;
      const ly = local.y - centerY;
      // Pointer offset from the box centre, in box fractions — the space the
      // radial's geometry lives in.
      const fx = lx / el.width;
      const fy = ly / el.height;
      // …and the same offset from the PAINT's centre in px, for the two kinds
      // whose angle is measured there (see the header).
      const gx = lx - pxCenterDx;
      const gy = ly - pxCenterDy;

      if (which === "start" || which === "end") {
        // First drag materializes the symmetric axis as explicit points (the
        // `angle` shorthand has no independent ends), then the dragged handle
        // tracks the pointer directly — Figma's model. Values may leave the
        // box: the gradient line is legal outside 0..1. `angle` rides along
        // synced so the inspector scrub and the axis can never disagree.
        setDoc((prev) =>
          applyPaint(prev, (paint) => {
            const p = paint as Extract<Paint, { type: "linear-gradient" }>;
            const lever = linearLeverEndpoints(p.angle ?? 90, el.width, el.height);
            const start = p.start ?? { x: round4(lever.start.x / el.width), y: round4(lever.start.y / el.height) };
            const end = p.end ?? { x: round4(lever.end.x / el.width), y: round4(lever.end.y / el.height) };
            const moved = { x: round4(0.5 + fx), y: round4(0.5 + fy) };
            const nextStart = which === "start" ? moved : start;
            const nextEnd = which === "end" ? moved : end;
            // px, not fractions: `angle` is CSS's, measured in the box's own
            // space, so the delta has to be in one uniform unit before the
            // inverse — a fraction delta returns the normalised-box angle.
            const dx = (nextEnd.x - nextStart.x) * el.width;
            const dy = (nextEnd.y - nextStart.y) * el.height;
            const angle = Math.round(((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360) % 360;
            return { ...paint, start: nextStart, end: nextEnd, angle };
          })
        );
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
        const angle = Math.round(((Math.atan2(gx, -gy) * 180) / Math.PI + 360) % 360) % 360;
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
          const angle = Math.round(((Math.atan2(gy, gx) * 180) / Math.PI + 360) % 360) % 360;
          const rx = round4(Math.hypot(gx, gy) / el.width);
          setDoc((prev) => applyPaint(prev, (paint) => ({ ...paint, angle, rx })));
          return;
        }
        // Radial: measured from the gradient's own centre, in fractions.
        const dx = 0.5 + fx - centerFraction.x;
        const dy = 0.5 + fy - centerFraction.y;
        const angle = Math.round(((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360) % 360;
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

  return { handleGradientHandlePointerDown };
}
