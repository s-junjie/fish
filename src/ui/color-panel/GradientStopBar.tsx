import { useRef } from "preact/hooks";
import type { GradientStop } from "../../core/dsl/types";
import { buildGradientBarCss } from "../../core/geometry/gradient-utils";
import { t } from "../../i18n";
import { Button } from "../Button";
import { ScrubInput } from "../ScrubInput";
import { SUB_LABEL_CLASS } from "../label-tier";
import { DARK_RING_STRONG_CLASS } from "../ring-style";
import { CANVAS_SELECT } from "../canvas/canvas-colors";
import { clampStopOffset, flipGradient, insertStopAt, pickStopAtOffset, rotateAxisToAngle, rotateGradient, roundOffset } from "./stop-edit";
import { ROW_DENSE_CLASS, ROW_SPREAD_CLASS, ROW_TIGHT_CLASS } from "../row-style";
import type { GradientPaint } from "./kind-memory";
import { FlipHorizontal, Minus, RotateCw, Tag } from "lucide-react";
import { TokenTag } from "../TokenTag";

/**
 * The two rings a gradient stop wears — the selected one and the swatch
 * hairline. The selected ring is the canvas' own selection blue rather than the
 * `#3B82F6` that used to sit here: that value was Tailwind's blue-500, five
 * percent off the blue drawn on the grip one surface away, so the panel and the
 * canvas each named "chosen" with a different colour.
 */
const ACTIVE_STOP_RING = CANVAS_SELECT;
const STOP_RING = "#ffffff";

interface GradientStopBarProps {
  paint: GradientPaint;
  stops: GradientStop[];
  stopIndex: number;
  onStopsChange: (stops: GradientStop[], discrete?: boolean) => void;
  onSelectStop: (index: number) => void;
  /** Any edit that rewrites the whole paint — the angle scrub, flip, rotate, a preset. */
  onPaintChange: (paint: GradientPaint) => void;
  /** The colour token the selected stop follows, when it follows one. */
  stopToken?: { id: string; name: string } | null;
  /** Omitted when the panel has no document to read tokens from. */
  onOpenTokenPicker?: (anchor: HTMLElement) => void;
  onDetachToken?: () => void;
  onGestureStart?: () => void;
  onGestureEnd?: () => void;
}

/**
 * The stop ramp, its selected stop's fields, and the angle — the whole gradient
 * half of the panel. It owns the drag state because nothing outside needs it:
 * the panel only sees the stops that come out.
 */
export function GradientStopBar({
  paint,
  stops,
  stopIndex,
  onStopsChange,
  onSelectStop,
  onPaintChange,
  stopToken,
  onOpenTokenPicker,
  onDetachToken,
  onGestureStart,
  onGestureEnd
}: GradientStopBarProps) {
  const barRef = useRef<HTMLDivElement | null>(null);
  const draggingStop = useRef<number | null>(null);

  const scrubStop = (clientX: number) => {
    const el = barRef.current;
    const index = draggingStop.current;
    if (!el || index === null || !stops[index]) return;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0) return;
    const offset = clampStopOffset(stops, index, roundOffset((clientX - rect.left) / rect.width));
    onStopsChange(stops.map((s, i) => (i === index ? { ...s, offset } : s)));
  };

  const barPointerDown = (e: PointerEvent) => {
    const el = barRef.current;
    if (!el) return;
    el.setPointerCapture(e.pointerId);
    onGestureStart?.();
    const handle = (e.target as HTMLElement)?.closest?.("[data-stop-index]") as HTMLElement | null;
    if (handle) {
      const index = Number(handle.dataset.stopIndex);
      // Two stops may legally share an offset — `clampStopOffset` lets one pass
      // through another — and two marks on one point are one target, so the
      // lower one used to own its pixel forever. Pressing the selected twin
      // again cycles to the next stop at that offset.
      const picked = pickStopAtOffset(stops, index, stopIndex);
      onSelectStop(picked);
      draggingStop.current = picked;
      return;
    }
    const rect = el.getBoundingClientRect();
    if (rect.width === 0) return;
    const inserted = insertStopAt(stops, roundOffset((e.clientX - rect.left) / rect.width));
    onSelectStop(inserted.index);
    draggingStop.current = inserted.index;
    onStopsChange(inserted.stops);
  };

  const angle = paint.angle ?? (paint.type === "linear-gradient" ? 90 : 0);

  const removeStop = (index: number) => {
    if (stops.length <= 2) return;
    onStopsChange(stops.filter((_, i) => i !== index), true);
    onSelectStop(Math.max(0, index - 1));
  };

  const nudgeStop = (index: number, offset: number) => {
    const clamped = clampStopOffset(stops, index, roundOffset(offset));
    onStopsChange(stops.map((s, i) => (i === index ? { ...s, offset: clamped } : s)), true);
  };

  /**
   * The ramp is a control, not a picture.
   *
   * Every mark is a `slider` in the tab order, so a stop can be selected,
   * nudged by 1% (10% with Shift), taken to either end, and deleted without a
   * pointer — which is the only way to place a stop at exactly 37% twice.
   */
  const onStopKeyDown = (e: KeyboardEvent, index: number) => {
    if (e.isComposing || (e as any).keyCode === 229) return;
    const stop = stops[index];
    if (!stop) return;
    const step = e.shiftKey ? 0.1 : 0.01;
    if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
      e.preventDefault();
      e.stopPropagation();
      nudgeStop(index, stop.offset - step);
      return;
    }
    if (e.key === "ArrowRight" || e.key === "ArrowUp") {
      e.preventDefault();
      e.stopPropagation();
      nudgeStop(index, stop.offset + step);
      return;
    }
    if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      e.stopPropagation();
      nudgeStop(index, e.key === "Home" ? 0 : 1);
      return;
    }
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      e.stopPropagation();
      removeStop(index);
    }
  };

  return (
    <div className="space-y-2 pb-2 border-b border-rule-strong" data-gradient-stop-bar="1">
      <div
        ref={barRef}
        data-gradient-bar="1"
        role="group"
        aria-label={t("paint.stopBar")}
        title={t("paint.addStopHint")}
        className="relative w-full h-6 rounded-ctl border border-rule-strong cursor-copy"
        style={{ background: buildGradientBarCss(paint) }}
        onPointerDown={barPointerDown}
        onPointerMove={(e) => {
          if (draggingStop.current !== null) scrubStop(e.clientX);
        }}
        onPointerUp={(e) => {
          if (draggingStop.current === null) return;
          draggingStop.current = null;
          try {
            e.currentTarget.releasePointerCapture(e.pointerId);
          } catch { }
          onGestureEnd?.();
        }}
      >
        {stops.map((stop, i) => {
            return (
              <div
                key={i}
                data-stop-index={i}
                data-stop-offset={String(stop.offset)}
                title={`${Math.round(stop.offset * 100)}%`}
                role="slider"
                tabIndex={0}
                aria-orientation="horizontal"
                aria-label={`${t("paint.stop")} ${i + 1}/${stops.length}`}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(stop.offset * 100)}
                aria-valuetext={`${Math.round(stop.offset * 100)}%`}
                onFocus={() => onSelectStop(i)}
                onPointerDown={(e) => {
                  // The ramp captures the pointer, which takes the browser's own
                  // focus step with it — so a click selected the stop but left
                  // the keyboard where it was, and Delete then reached the
                  // editor instead of the stop.
                  (e.currentTarget as HTMLElement).focus?.({ preventScroll: true });
                }}
                onKeyDown={(e: KeyboardEvent) => onStopKeyDown(e, i)}
                className="absolute top-0 bottom-0 w-4 -ml-2 cursor-ew-resize outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-canvas-select"
                style={{ left: `${stop.offset * 100}%`, zIndex: i === stopIndex ? 2 : 1 }}
              >
                <div
                  className={`absolute top-1/2 left-1/2 w-3.5 h-3.5 -mt-[7px] -ml-[7px] rounded-full border-2 ${DARK_RING_STRONG_CLASS}`}
                  style={{
                    background: stop.color,
                    borderColor: i === stopIndex ? ACTIVE_STOP_RING : STOP_RING
                  }}
                />
              </div>
            );
          })}
      </div>

      <div className="flex items-center justify-between gap-1.5">
        {stopToken ? (
          <TokenTag
            name={stopToken.name}
            title={stopToken.name}
            onClick={(e) => onOpenTokenPicker?.(e.currentTarget as HTMLElement)}
            onDblClick={(e) => {
              e.stopPropagation();
              onDetachToken?.();
            }}
            onDetach={onDetachToken}
            tagProps={{ "data-stop-token-bind": String(stopIndex) }}
            detachProps={{ "data-stop-token-detach": stopToken.id }}
            className="max-w-[130px]"
          />
        ) : onOpenTokenPicker ? (
          <button
            type="button"
            data-stop-token-bind={stopIndex}
            onClick={(e) => onOpenTokenPicker(e.currentTarget)}
            title={t("tokens.bind")}
            aria-label={t("tokens.bind")}
            className={`${SUB_LABEL_CLASS} group flex min-w-0 items-center gap-1 text-left cursor-pointer hover:text-ink`}
          >
            <span className="truncate">
              {`${t("paint.stop")} ${stopIndex + 1}/${stops.length}`}
            </span>
            <Tag
              size={10}
              className="shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity duration-base ease-snap"
            />
          </button>
        ) : (
          <span className={`${SUB_LABEL_CLASS} shrink-0`}>
            {t("paint.stop")} {stopIndex + 1}/{stops.length}
          </span>
        )}
        <div className={ROW_TIGHT_CLASS}>
          <div className="w-16 shrink-0">
            <ScrubInput
              label="%"
              value={Math.round((stops[stopIndex]?.offset ?? 0) * 100)}
              min={0}
              max={100}
              onChange={(pct) => {
                if (!stops[stopIndex]) return;
                const offset = clampStopOffset(stops, stopIndex, pct / 100);
                onStopsChange(stops.map((s, i) => (i === stopIndex ? { ...s, offset } : s)));
              }}
              onDragStart={onGestureStart}
              onDragEnd={onGestureEnd}
            />
          </div>
          {stops.length > 2 && (
            <Button
              variant="danger"
              size="icon"
              type="button"
              onClick={() => removeStop(stopIndex)}
              title={t("paint.removeStop")}
            >
              <Minus size={12} />
            </Button>
          )}
        </div>
      </div>

      {/* Every gradient has an `angle` — the linear axis, the radial's ellipse
          rotation, where a sweep starts, which way a diamond points — so the
          field is not linear-only. It has to be, or two kinds are reachable only
          by dragging a handle. */}
      <div className={ROW_SPREAD_CLASS}>
        <span className={SUB_LABEL_CLASS}>{t("paint.angle")}</span>
        <div className={ROW_DENSE_CLASS}>
          <div className="w-20 shrink-0">
            <ScrubInput
              label="∠"
              value={Math.round(angle)}
              min={0}
              max={360}
              onChange={(next) => onPaintChange(rotateAxisToAngle(paint, next))}
              onDragStart={onGestureStart}
              onDragEnd={onGestureEnd}
            />
          </div>
          {/* The two edits the ramp cannot express: reading it backwards, and a
              quarter turn. Both are one press in Figma and were zero here. */}
          <Button
            variant="ghost"
            size="icon"
            type="button"
            title={t("paint.flip")}
            aria-label={t("paint.flip")}
            data-gradient-flip="1"
            onClick={() => onPaintChange(flipGradient(paint))}
          >
            <FlipHorizontal size={12} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            type="button"
            title={t("paint.rotate90")}
            aria-label={t("paint.rotate90")}
            data-gradient-rotate="1"
            onClick={() => onPaintChange(rotateGradient(paint))}
          >
            <RotateCw size={12} />
          </Button>
        </div>
      </div>

    </div>
  );
}
