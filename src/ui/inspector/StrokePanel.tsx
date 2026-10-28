import { useEffect, useRef } from "preact/hooks";
import { createPortal } from "preact/compat";
import { Stroke, StrokeSide, DesignElement } from "../../core/dsl/types";
import { StrokeLineControls } from "./StrokeLineControls";
import { ScrubInput } from "../ScrubInput";
import { SegmentedControl } from "../SegmentedControl";
import { Select } from "../Select";
import { Button } from "../Button";
import { PanelHeader } from "../PanelHeader";
import { useAnchoredPosition, placementStyle } from "../hooks/useAnchoredPosition";
import { useDismiss } from "../hooks/useDismiss";
import { setPickerOpen } from "../hooks/picker-focus";
import { t } from "../../i18n";
import { SUB_LABEL_CLASS } from "../label-tier";
import { ROW_SPREAD_CLASS } from "../row-style";

const PANEL_WIDTH = 240;
const VIEWPORT_MARGIN = 8;
const ANCHOR_GAP = 10;
const BOTTOM_MARGIN = 20;

export interface StrokePanelProps {
  stroke: Stroke;
  anchor: HTMLElement | null;
  onClose: () => void;
  onChange: (patch: Partial<Stroke>, discrete?: boolean) => void;
  onCommit?: () => void;
  onGestureStart: () => void;
  onGestureEnd: () => void;
  elementType?: DesignElement["type"];
}

export function StrokePanel({
  stroke,
  anchor,
  onClose,
  onChange,
  onCommit,
  onGestureStart,
  onGestureEnd,
  elementType
}: StrokePanelProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const anchorRef = useRef<HTMLElement | null>(anchor);
  anchorRef.current = anchor;

  const pos = useAnchoredPosition({
    anchorRef,
    panelRef,
    deps: [anchor, stroke.side, stroke.align],
    compute: (anchorEl, panel) => {
      const a = anchorEl.getBoundingClientRect();
      if (a.width === 0 && a.height === 0 && a.top === 0 && a.left === 0) return null;
      const host = anchorEl.closest("[data-host-popover], [data-style-picker-popover]");
      const bounds = host ? host.getBoundingClientRect() : a;
      let left = bounds.left - PANEL_WIDTH - ANCHOR_GAP;
      if (left < VIEWPORT_MARGIN) {
        left = Math.min(bounds.right + ANCHOR_GAP, window.innerWidth - PANEL_WIDTH - VIEWPORT_MARGIN);
      }
      left = Math.max(VIEWPORT_MARGIN, left);

      const height = panel.offsetHeight || 300;
      const fitsBelow = a.top + height <= window.innerHeight - BOTTOM_MARGIN;
      const fitsAbove = a.top - height >= VIEWPORT_MARGIN;
      const top = fitsBelow
        ? a.top
        : fitsAbove
          ? a.top - height
          : Math.max(VIEWPORT_MARGIN, window.innerHeight - height - BOTTOM_MARGIN);
      return { left, top };
    }
  });

  useDismiss(true, onClose, panelRef, anchorRef);

  /* The panel owns the keyboard while it is up (see `picker-focus`). Without
     this, Escape closed it and then went on to the shortcut layer, which read
     the same key as "clear the selection" — and the selection going away took
     this panel's host section with it, so the key looked like it closed two
     things at once. */
  useEffect(() => {
    setPickerOpen(true);
    return () => setPickerOpen(false);
  }, []);

  const strokeAlign = stroke.align || "center";

  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      data-stroke-panel="1"
      data-inspector-activity="true"
      style={placementStyle(pos, PANEL_WIDTH)}
      className="fixed z-[60] bg-panel border border-rule-strong rounded-pill shadow-popover p-2.5 space-y-2.5 text-ui text-ink select-none animate-pop-in"
    >
      <PanelHeader title={t("paint.settings")} onClose={onClose} className="pb-1.5 border-b border-rule" />

      {/* Stroke Line Controls (solid/dash, cap, join, miter) */}
      <StrokeLineControls
        stroke={stroke}
        onChange={onChange}
        onDragStart={onGestureStart}
        onDragEnd={onGestureEnd}
        showCapJoin={elementType !== "frame" && elementType !== "component"}
      />

      {/* Stroke Alignment (Inside / Center / Outside) - For closed shapes */}
      {elementType !== "line" && elementType !== "arrow" && (
        <div className="space-y-1">
          <span className={SUB_LABEL_CLASS}>{t("paint.position")}</span>
          <SegmentedControl<string>
            className="w-full"
            value={strokeAlign}
            onChange={(v) => onChange({ align: v as Stroke["align"] }, true)}
            items={[
              { value: "inside", label: t("paint.inside"), grow: true },
              { value: "center", label: t("paint.center"), grow: true },
              { value: "outside", label: t("paint.outside"), grow: true }
            ]}
          />
        </div>
      )}

      {/* Stroke Side (All / Top / Bottom / Left / Right / Custom) - For rectangular shapes */}
      {(elementType === "rect" ||
        elementType === "frame" ||
        elementType === "component" ||
        elementType === "instance") && (
        <div className="space-y-1">
          <div className={ROW_SPREAD_CLASS}>
            <span className={SUB_LABEL_CLASS}>{t("paint.side")}</span>
            <Select
              className="w-28"
              value={stroke.side || "all"}
              onChange={(v) => {
                const nextSide = v as StrokeSide;
                let nextSides = stroke.sides;
                if (nextSide === "custom" && !nextSides) {
                  const w = stroke.width || 1;
                  nextSides = { top: w, right: w, bottom: w, left: w };
                }
                onChange({ side: nextSide, sides: nextSides }, true);
              }}
              title={t("paint.side")}
            >
              <option value="all">{t("paint.sideAll")}</option>
              <option value="top">{t("paint.sideTop")}</option>
              <option value="bottom">{t("paint.sideBottom")}</option>
              <option value="left">{t("paint.sideLeft")}</option>
              <option value="right">{t("paint.sideRight")}</option>
              <option value="custom">{t("paint.sideCustom")}</option>
            </Select>
          </div>

          {/* Custom Per-Side Inputs */}
          {stroke.side === "custom" && (
            <div className="grid grid-cols-2 gap-1.5 pt-1">
              <ScrubInput
                label="T"
                value={stroke.sides?.top ?? stroke.width ?? 0}
                min={0}
                onDragStart={onGestureStart}
                onDragEnd={() => {
                  onGestureEnd();
                  onCommit?.();
                }}
                onChange={(val) => {
                  const baseSides = stroke.sides || {
                    top: stroke.width,
                    right: stroke.width,
                    bottom: stroke.width,
                    left: stroke.width
                  };
                  onChange({ sides: { ...baseSides, top: val } });
                }}
                title={t("paint.topStrokeWidth")}
              />
              <ScrubInput
                label="R"
                value={stroke.sides?.right ?? stroke.width ?? 0}
                min={0}
                onDragStart={onGestureStart}
                onDragEnd={() => {
                  onGestureEnd();
                  onCommit?.();
                }}
                onChange={(val) => {
                  const baseSides = stroke.sides || {
                    top: stroke.width,
                    right: stroke.width,
                    bottom: stroke.width,
                    left: stroke.width
                  };
                  onChange({ sides: { ...baseSides, right: val } });
                }}
                title={t("paint.rightStrokeWidth")}
              />
              <ScrubInput
                label="B"
                value={stroke.sides?.bottom ?? stroke.width ?? 0}
                min={0}
                onDragStart={onGestureStart}
                onDragEnd={() => {
                  onGestureEnd();
                  onCommit?.();
                }}
                onChange={(val) => {
                  const baseSides = stroke.sides || {
                    top: stroke.width,
                    right: stroke.width,
                    bottom: stroke.width,
                    left: stroke.width
                  };
                  onChange({ sides: { ...baseSides, bottom: val } });
                }}
                title={t("paint.bottomStrokeWidth")}
              />
              <ScrubInput
                label="L"
                value={stroke.sides?.left ?? stroke.width ?? 0}
                min={0}
                onDragStart={onGestureStart}
                onDragEnd={() => {
                  onGestureEnd();
                  onCommit?.();
                }}
                onChange={(val) => {
                  const baseSides = stroke.sides || {
                    top: stroke.width,
                    right: stroke.width,
                    bottom: stroke.width,
                    left: stroke.width
                  };
                  onChange({ sides: { ...baseSides, left: val } });
                }}
                title={t("paint.leftStrokeWidth")}
              />
            </div>
          )}
        </div>
      )}
    </div>,
    document.body
  );
}
