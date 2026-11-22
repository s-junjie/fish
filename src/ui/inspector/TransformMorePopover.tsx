import { useEffect, useRef } from "preact/hooks";
import { createPortal } from "preact/compat";
import type { DesignElement } from "../../core/dsl/types";
import { t } from "../../i18n";
import { PanelHeader } from "../PanelHeader";
import { POPOVER_SURFACE_CLASS } from "../menu-style";
import { SUB_LABEL_CLASS } from "../label-tier";
import { ScrubInput } from "../ScrubInput";
import { placementStyle, sidePanelCompute, useAnchoredPosition } from "../hooks/useAnchoredPosition";
import { useDismiss } from "../hooks/useDismiss";
import { setPickerOpen } from "../hooks/picker-focus";
import { POPOVER_WIDTH } from "./StylePickerPopover";
import type { Resolved } from "./mixed";

interface TransformMorePopoverProps {
  anchor: HTMLElement;
  onClose: () => void;
  elementId?: string;
  tiltX: Resolved<number>;
  tiltY: Resolved<number>;
  perspective: Resolved<number>;
  skewX: Resolved<number>;
  skewY: Resolved<number>;
  locked: boolean;
  lockedHint?: string;
  onMutate: (updater: (el: DesignElement) => DesignElement, commitImmediately?: boolean) => void;
  onDragStart: () => void;
  onDragEnd: () => void;
}

/**
 * Perspective tilt and shear, anchored to the Position group's More button.
 * Both are paint-side numbers with no canvas handles, so they do not need two
 * captioned rows of the panel at rest — the Typography group's More trade.
 */
export function TransformMorePopover({
  anchor,
  onClose,
  elementId,
  tiltX,
  tiltY,
  perspective,
  skewX,
  skewY,
  locked,
  lockedHint,
  onMutate,
  onDragStart,
  onDragEnd
}: TransformMorePopoverProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const anchorRef = useRef<HTMLElement | null>(anchor);
  anchorRef.current = anchor;

  const pos = useAnchoredPosition({
    anchorRef,
    panelRef,
    compute: sidePanelCompute(POPOVER_WIDTH, 240)
  });
  useDismiss(true, onClose, panelRef, anchorRef);

  // The shortcut layer listens in capture, so Escape would reach it first and
  // clear the selection — taking this popover's host section with it.
  useEffect(() => {
    setPickerOpen(true);
    return () => setPickerOpen(false);
  }, []);

  const fieldKey = (name: string) => (elementId ? `${elementId}_${name}` : `multi_${name}`);

  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-label={t("properties.transformSettings")}
      data-transform-more-popover="true"
      data-host-popover="true"
      style={placementStyle(pos, POPOVER_WIDTH)}
      className={`fixed z-[70] px-2.5 py-2 flex flex-col gap-2 text-ui select-none ${POPOVER_SURFACE_CLASS}`}
    >
      <PanelHeader title={t("properties.transformSettings")} onClose={onClose} />

      <div className={SUB_LABEL_CLASS}>{t("properties.tilt")}</div>
      <div className="grid grid-cols-3 gap-1">
        <ScrubInput
          key={fieldKey("tiltX")}
          label="X°"
          value={tiltX.mixed ? undefined : tiltX.value}
          mixed={tiltX.mixed}
          min={-89}
          max={89}
          disabled={locked}
          title={locked ? lockedHint : t("properties.tiltX")}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          onChange={(v) => onMutate((el) => ({ ...el, rotateX: v }))}
        />
        <ScrubInput
          key={fieldKey("tiltY")}
          label="Y°"
          value={tiltY.mixed ? undefined : tiltY.value}
          mixed={tiltY.mixed}
          min={-89}
          max={89}
          disabled={locked}
          title={locked ? lockedHint : t("properties.tiltY")}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          onChange={(v) => onMutate((el) => ({ ...el, rotateY: v }))}
        />
        <ScrubInput
          key={fieldKey("persp")}
          label="d"
          value={perspective.mixed ? undefined : perspective.value}
          mixed={perspective.mixed}
          min={50}
          max={100000}
          disabled={locked}
          title={locked ? lockedHint : t("properties.perspectiveDistance")}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          onChange={(v) => onMutate((el) => ({ ...el, perspective: v }))}
        />
      </div>

      <div className={SUB_LABEL_CLASS}>{t("properties.skew")}</div>
      <div className="grid grid-cols-2 gap-1">
        <ScrubInput
          key={fieldKey("skewX")}
          label="X°"
          value={skewX.mixed ? undefined : skewX.value}
          mixed={skewX.mixed}
          min={-89}
          max={89}
          disabled={locked}
          title={locked ? lockedHint : t("properties.skewX")}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          onChange={(v) => onMutate((el) => ({ ...el, skewX: v }))}
        />
        <ScrubInput
          key={fieldKey("skewY")}
          label="Y°"
          value={skewY.mixed ? undefined : skewY.value}
          mixed={skewY.mixed}
          min={-89}
          max={89}
          disabled={locked}
          title={locked ? lockedHint : t("properties.skewY")}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          onChange={(v) => onMutate((el) => ({ ...el, skewY: v }))}
        />
      </div>
    </div>,
    document.body
  );
}
