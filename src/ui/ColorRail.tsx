import { JSX } from "preact";
import { useRef } from "preact/hooks";
import { toCssRgba } from "../core/geometry/color-utils";
import { SLIDER_KNOB_CLASS } from "./slider-style";
import { PAINT_SWATCH_CHECKER } from "./inspector/paint-row-style";

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

/** The alpha checkerboard: the paint swatch's, not a second copy of it. */
const CHECKERBOARD_CSS = PAINT_SWATCH_CHECKER.backgroundImage!;

export const HUE_TRACK =
  "linear-gradient(to right, #f00 0%, #ff0 17%, #0f0 33%, #0ff 50%, #00f 67%, #f0f 83%, #f00 100%)";

interface RailProps {
  name: string;
  pct: number;
  trackStyle: JSX.CSSProperties;
  onScrubStart: () => void;
  onScrub: (ratio: number) => void;
  onScrubEnd: () => void;
}

/**
 * A gradient that IS its value — hue, or opacity.
 *
 * The 12px row is the HIT AREA, not the mark: the pointer has to find a hue
 * without aiming, but the track itself is a thin line. 12px painted read as a
 * filled bar rather than a rail, so it is 6px — NOT the 3px slider line: a rail's
 * gradient is its value, and at 3px there is not enough of it left to read a hue
 * from. No border either: a 1px hairline on a 6px track eats a third of the
 * gradient, and the reference draws the track bare.
 */
export function Rail({ name, pct, trackStyle, onScrubStart, onScrub, onScrubEnd }: RailProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const dragging = useRef(false);

  const scrub = (clientX: number) => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0) return;
    onScrub(clamp01((clientX - rect.left) / rect.width));
  };

  return (
    <div
      ref={ref}
      data-rail={name}
      className="relative w-full h-3 cursor-pointer"
      onPointerDown={(e) => {
        dragging.current = true;
        e.currentTarget.setPointerCapture(e.pointerId);
        onScrubStart();
        scrub(e.clientX);
      }}
      onPointerMove={(e) => {
        if (dragging.current) scrub(e.clientX);
      }}
      onPointerUp={(e) => {
        if (!dragging.current) return;
        dragging.current = false;
        try {
          e.currentTarget.releasePointerCapture(e.pointerId);
        } catch {}
        onScrubEnd();
      }}
    >
      <div className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full" style={trackStyle} />
      <div className={SLIDER_KNOB_CLASS} style={{ left: `${pct}%` }} />
    </div>
  );
}

/** The opacity rail's track: the colour fading out over the alpha checkerboard. */
export const alphaTrackStyle = (hex6: string): JSX.CSSProperties => ({
  backgroundImage: `linear-gradient(to right, ${toCssRgba(hex6, 0)}, ${toCssRgba(hex6, 1)}), ${CHECKERBOARD_CSS}`,
  backgroundSize: `auto, ${PAINT_SWATCH_CHECKER.backgroundSize}`
});