import { useRef } from "preact/hooks";
import type { GradientStop } from "../../core/dsl/types";
import { buildGradientBarCss } from "../../core/geometry/gradient-utils";
import { t } from "../../i18n";
import { Button } from "../Button";
import { ScrubInput } from "../ScrubInput";
import { SUB_LABEL_CLASS } from "../label-tier";
import { DARK_RING_STRONG_CLASS } from "../ring-style";
import { ROW_SPREAD_CLASS, ROW_TIGHT_CLASS } from "../row-style";
import type { GradientPaint } from "./kind-memory";
import { clampStopOffset, insertStopAt, roundOffset, rotateAxisToAngle } from "./stop-edit";
import { Minus, Tag } from "lucide-react";
import { TokenTag } from "../TokenTag";

/**
 * The two rings a gradient stop wears — `canvas-select` and the swatch hairline.
 * Named rather than inlined because a raw hex at the call site reads as a
 * decision nobody made.
 */
const ACTIVE_STOP_RING = "#3B82F6";
const STOP_RING = "#ffffff";

interface GradientStopBarProps {
  paint: GradientPaint;
  stops: GradientStop[];
  stopIndex: number;
  onStopsChange: (stops: GradientStop[], discrete?: boolean) => void;
  onSelectStop: (index: number) => void;
  onAngleChange: (paint: GradientPaint) => void;
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
  onAngleChange,
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
      onSelectStop(index);
      draggingStop.current = index;
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

  return (
    <div className="space-y-2 pt-2 border-t border-rule-strong">
      <div
        ref={barRef}
        data-gradient-bar="1"
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
        {stops.map((stop, i) => (
          <div
            key={i}
            data-stop-index={i}
            className="absolute top-0 bottom-0 w-3.5 -ml-[7px] cursor-ew-resize"
            style={{ left: `${stop.offset * 100}%` }}
          >
            <div
              className={`absolute top-1/2 left-1/2 w-3.5 h-3.5 -mt-[7px] -ml-[7px] rounded-full border-2 ${DARK_RING_STRONG_CLASS}`}
              style={{
                background: stop.color,
                borderColor: i === stopIndex ? ACTIVE_STOP_RING : STOP_RING
              }}
            />
          </div>
        ))}
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
              onClick={() => {
                onStopsChange(stops.filter((_, i) => i !== stopIndex), true);
                onSelectStop(Math.max(0, stopIndex - 1));
              }}
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
        <div className="w-20 shrink-0">
          <ScrubInput
            label="∠"
            value={Math.round(angle)}
            min={0}
            max={360}
            onChange={(next) => onAngleChange(rotateAxisToAngle(paint, next))}
            onDragStart={onGestureStart}
            onDragEnd={onGestureEnd}
          />
        </div>
      </div>
    </div>
  );
}
