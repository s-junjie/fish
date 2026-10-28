import { useRef } from "preact/hooks";
import { t } from "../i18n";
import { SLIDER_KNOB_CLASS } from "./slider-style";
import { MIXED_LABEL } from "./inspector/mixed";

interface SliderRowProps {
  label: string;
  /** Slider units, always -100..100. */
  value: number;
  onChange: (value: number) => void;
  onDragStart?: () => void;
  onDragEnd?: () => void;
  /** Double-clicking the label returns this row to neutral. */
  onReset?: () => void;
  /**
   * The slider position that means "no effect": the fill grows out of it and a
   * drag near it snaps onto it. The centre by default; an axis with no negative
   * half hands in an end instead, so the whole track is the effect.
   */
  neutralAt?: number;
  /**
   * The selection disagrees on this axis, so there is no position to sit at.
   *
   * The knob parks at the neutral — the one value that is not a claim about the
   * others — and the row dims. Dragging still works and resolves it: the drag is
   * a delta from wherever it started, which is the edit that makes them agree.
   */
  mixed?: boolean;
  title?: string;
  dataSlider?: string;
}

const MIN = -100;
const MAX = 100;
/** Slider units either side of the neutral that snap onto it, so it is reachable by hand. */
export const SNAP_TO_NEUTRAL = 6;

/** Neutral is the value users come back to most, so make it easy to land on. */
export function snapToNeutral(raw: number, neutral: number): number {
  return Math.abs(raw - neutral) <= SNAP_TO_NEUTRAL ? neutral : raw;
}

export function SliderRow({
  label,
  value,
  onChange,
  onDragStart,
  onDragEnd,
  onReset,
  neutralAt = 0,
  mixed = false,
  title,
  dataSlider
}: SliderRowProps) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const dragging = useRef(false);

  const valueAt = (clientX: number) => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return value;
    const pct = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return snapToNeutral(Math.round(MIN + pct * (MAX - MIN)), neutralAt);
  };

  const pct = ((Math.min(MAX, Math.max(MIN, value)) - MIN) / (MAX - MIN)) * 100;
  const neutralPct = ((Math.min(MAX, Math.max(MIN, neutralAt)) - MIN) / (MAX - MIN)) * 100;
  const fillLeft = Math.min(neutralPct, pct);
  const fillWidth = Math.abs(pct - neutralPct);

  // The geometry is the drafting-instrument reading, not the pill one: a 6px
  // track sitting in a recessed well, a 6px amber fill that grows OUT of the
  // neutral, and an 11px SQUARE knob. The earlier 4px pill track with a 14px
  // round knob was soft in a way that read as a consumer control; the square
  // knob is what makes it an instrument.
  //
  // The 8px box is the HIT AREA and the 6px line is the MARK — the pointer still
  // has to find a neutral without aiming, and the line is centred inside the box,
  // so the box's own rect (which is what the pointer math reads) is unchanged by
  // the mark being thinner than the box.
  return (
    <div className={`space-y-1${mixed ? " opacity-50" : ""}`} data-slider={dataSlider} data-mixed={mixed ? "true" : undefined}>
      <span
        className="block truncate text-unit text-ink-dim select-none hover:text-ink transition-colors duration-micro ease-snap"
        title={onReset ? `${title ?? label} — ${t("adjust.resetHint")}` : title ?? label}
        onDblClick={onReset}
      >
        {label}
      </span>

      <div className="px-[7px]">
        <div
          ref={trackRef}
          data-slider-track={dataSlider}
          className="relative w-full h-2 cursor-ew-resize touch-none"
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            dragging.current = true;
            onDragStart?.();
            (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
            onChange(valueAt(e.clientX));
          }}
          onPointerMove={(e) => {
            if (!dragging.current) return;
            onChange(valueAt(e.clientX));
          }}
          onPointerUp={(e) => {
            if (!dragging.current) return;
            dragging.current = false;
            try {
              (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
            } catch {}
            onDragEnd?.();
          }}
        >
          {/* No inset hairline: a 1px ring eats a third of a thin track's
              colour, which is the same reason the colour panel's rail carries
              none. The `inset` fill IS the well.
              `h-1.5`, not 3px: a slider and a colour rail are the same gesture
              — grab a handle, drag a value — and drawn at two thicknesses they
              read as two different instruments. 6px matches the rail (and
              DESIGN.md's own colour rail), and at 6px the amber fill is finally
              readable as a FILL rather than as a hairline someone dropped. */}
          <div className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-[1px] bg-inset">
            {/* The neutral marker. A one-way axis has its neutral on an end, where
                the track's own end already says the same thing. */}
            {neutralPct > 0 && neutralPct < 100 && (
              <div
                data-slider-neutral={dataSlider}
                className="absolute inset-y-0 w-px bg-rule-strong"
                style={{ left: `${neutralPct}%` }}
              />
            )}
            <div
              data-slider-fill={dataSlider}
              className="absolute inset-y-0 rounded-[1px] bg-brand"
              style={{ left: `${fillLeft}%`, width: `${fillWidth}%` }}
            />
          </div>
          <div
            data-slider-knob={dataSlider}
            className={SLIDER_KNOB_CLASS}
            style={{ left: `${pct}%` }}
          />
        </div>
      </div>
    </div>
  );
}
