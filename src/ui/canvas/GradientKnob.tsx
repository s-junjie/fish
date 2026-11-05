import { useEffect, useState } from "preact/hooks";
import { CANVAS_ON_SELECT, CANVAS_SELECT } from "./canvas-colors";
import type { GradientHandle } from "../hooks/canvas-gestures/gradient-gesture";

/**
 * One grip on the gradient lever.
 *
 * Constant SCREEN size, unlike the artwork: a knob is a pointer target, not a
 * mark in the drawing, so every dimension here is divided by `zoom` by the
 * caller and passed in already in the overlay's own units.
 *
 * The hover and drag states exist because the lever's geometry is otherwise
 * silent: a 10px disc on a photograph offers no confirmation that it has been
 * grabbed. Hover grows the mark and draws a white halo; a press pins it one step
 * larger until the pointer is released anywhere on the page — the gesture listens
 * on `window`, so a local `pointerup` would never arrive.
 */
export interface GradientKnobProps {
  handle: GradientHandle;
  cx: number;
  cy: number;
  /** Half-width of the mark, in the overlay's units. */
  radius: number;
  shape: "circle" | "square";
  fill: string;
  /** Transparent target around the mark — the only part the pointer must hit. */
  hitRadius: number;
  strokeWidth: number;
  cursor: string;
  onPointerDown: (e: PointerEvent) => void;
  /** Native tooltip: the lever has no labels, and a grip that explains itself on
   *  hover is cheaper to discover than one that has to be tried. */
  title?: string;
  label?: string;
}

const HOVER_SCALE = 1.2;
const ACTIVE_SCALE = 1.3;

export function GradientKnob({
  handle,
  cx,
  cy,
  radius,
  shape,
  fill,
  hitRadius,
  strokeWidth,
  cursor,
  onPointerDown,
  title,
  label
}: GradientKnobProps) {
  const [hovered, setHovered] = useState(false);
  const [active, setActive] = useState(false);

  useEffect(() => {
    if (!active) return;
    const release = () => setActive(false);
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
    return () => {
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", release);
    };
  }, [active]);

  const scale = active ? ACTIVE_SCALE : hovered ? HOVER_SCALE : 1;
  const r = radius * scale;
  const halo = hovered || active;

  return (
    <g
      data-gradient-handle={handle}
      data-gradient-hover={hovered ? "true" : undefined}
      data-gradient-active={active ? "true" : undefined}
      style={{ cursor: active ? "grabbing" : cursor }}
      aria-label={label ?? title}
      onPointerOver={() => setHovered(true)}
      onPointerOut={() => setHovered(false)}
      onPointerDown={(e: PointerEvent) => {
        if (e.button !== 0) return;
        setActive(true);
        onPointerDown(e);
      }}
    >
      {title ? <title>{title}</title> : null}
      <circle cx={cx} cy={cy} r={hitRadius} fill="transparent" />
      {halo ? (
        <circle
          cx={cx}
          cy={cy}
          r={r + strokeWidth * 2}
          fill="none"
          stroke={CANVAS_ON_SELECT}
          strokeWidth={strokeWidth}
          opacity={0.85}
          pointerEvents="none"
        />
      ) : null}
      {shape === "circle" ? (
        <circle
          cx={cx}
          cy={cy}
          r={r}
          fill={fill}
          stroke={CANVAS_SELECT}
          strokeWidth={strokeWidth}
          pointerEvents="none"
        />
      ) : (
        <rect
          x={cx - r}
          y={cy - r}
          width={r * 2}
          height={r * 2}
          rx={1}
          fill={fill}
          stroke={CANVAS_SELECT}
          strokeWidth={strokeWidth}
          pointerEvents="none"
        />
      )}
    </g>
  );
}

/**
 * The cursor for a grip that only sizes ONE axis.
 *
 * A double-headed arrow has to point along the axis the drag will change, and a
 * radial's second axis is perpendicular to the one its angle names — so the
 * answer is the resize arrow nearest `angle + 90`, bucketed to 45° because the
 * cursor is a picture, not a measurement.
 */
export function perpendicularResizeCursor(angleDeg: number): string {
  const a = (((angleDeg + 90) % 180) + 180) % 180;
  if (a < 22.5 || a >= 157.5) return "ns-resize";
  if (a < 67.5) return "nesw-resize";
  if (a < 112.5) return "ew-resize";
  return "nwse-resize";
}
