import { CANVAS_BADGE_INK, CANVAS_BADGE_RIDGE, CANVAS_BADGE_SURFACE } from "./canvas-colors";

/**
 * The number that follows the pointer while a gradient grip is dragged.
 *
 * A badge rather than a caption on the panel because the eyes are on the grip:
 * the colour panel can be under the pointer or on another screen edge, and a
 * value you have to look away to read arrives after the drag is already wrong.
 * It is drawn in the overlay's units (everything divided by `zoom`) so it keeps
 * the same screen size at every magnification, and it never takes the pointer —
 * the drag it describes is still in flight.
 */
export interface GradientHudProps {
  x: number;
  y: number;
  text: string;
  zoom: number;
  /** The element's box, so the badge can flip instead of leaving the layer. */
  box?: { width: number; height: number };
}

const FONT_SIZE = 11;
/** Advance of 11px monospace, plus the degree sign's extra room. */
const CHAR_ADVANCE = 6.9;

export function GradientHud({ x, y, text, zoom, box }: GradientHudProps) {
  const padX = 6 / zoom;
  const height = 20 / zoom;
  const width = (text.length * CHAR_ADVANCE) / zoom + padX * 2;
  const gap = 14 / zoom;
  let left = x + gap;
  let top = y + gap * 0.85;
  if (box && left + width > box.width) left = x - gap - width;
  if (box && top + height > box.height) top = y - gap * 0.85 - height;
  return (
    <g data-gradient-readout={text} pointerEvents="none">
      <rect
        x={left}
        y={top}
        width={width}
        height={height}
        rx={4 / zoom}
        fill={CANVAS_BADGE_SURFACE}
        stroke={CANVAS_BADGE_RIDGE}
        strokeWidth={1 / zoom}
      />
      <text
        x={left + width / 2}
        y={top + height / 2}
        textAnchor="middle"
        dominantBaseline="central"
        fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
        fontSize={FONT_SIZE / zoom}
        fill={CANVAS_BADGE_INK}
      >
        {text}
      </text>
    </g>
  );
}
