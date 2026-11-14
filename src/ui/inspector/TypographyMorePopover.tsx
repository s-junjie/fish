import { useRef } from "preact/hooks";
import { createPortal } from "preact/compat";
import { Minus, ArrowDownFromLine } from "lucide-react";
import type { TextStyle } from "../../core/dsl/types";
import { PanelHeader } from "../PanelHeader";
import { POPOVER_SURFACE_CLASS } from "../menu-style";
import { SegmentedControl } from "../SegmentedControl";
import { ScrubInput } from "../ScrubInput";
import { SUB_LABEL_CLASS } from "../label-tier";
import { ROW_SPREAD_GAP_CLASS } from "../row-style";
import { useAnchoredPosition, placementStyle, sidePanelCompute } from "../hooks/useAnchoredPosition";
import { useDismiss } from "../hooks/useDismiss";
import { POPOVER_WIDTH } from "./StylePickerPopover";
import { DecorationRow, CaseRow } from "./typography-fields";
import { NumeralsMark } from "./NumeralsMark";
import { t } from "../../i18n";

interface TypographyMorePopoverProps {
  anchor: HTMLElement;
  onClose: () => void;
  styleOwnsType: boolean;
  armedStyleValues: string[];
  onToggleDecoration: (value: string, next: boolean) => void;
  textTransform?: TextStyle["textTransform"];
  onChangeTextTransform: (next: TextStyle["textTransform"]) => void;
  figuresValue: string;
  onChangeFigures: (v: string) => void;
  truncateMode: string;
  maxLines?: number;
  onChangeTruncate: (v: string) => void;
  onChangeMaxLines: (lines: number) => void;
  onDragStart: () => void;
  onDragEnd: () => void;
}

/**
 * Secondary type controls (decoration, case, numerals, truncation) anchored to
 * the More button so the inspector keeps only the primary type and alignment
 * rows visible at rest.
 */
export function TypographyMorePopover({
  anchor,
  onClose,
  styleOwnsType,
  armedStyleValues,
  onToggleDecoration,
  textTransform,
  onChangeTextTransform,
  figuresValue,
  onChangeFigures,
  truncateMode,
  maxLines,
  onChangeTruncate,
  onChangeMaxLines,
  onDragStart,
  onDragEnd
}: TypographyMorePopoverProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const anchorRef = useRef<HTMLElement | null>(anchor);
  anchorRef.current = anchor;

  const pos = useAnchoredPosition({
    anchorRef,
    panelRef,
    deps: [styleOwnsType, maxLines !== undefined],
    compute: sidePanelCompute(POPOVER_WIDTH, 240)
  });
  useDismiss(true, onClose, panelRef, anchorRef);

  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-label={t("typography.settings")}
      data-typography-more-popover="true"
      data-host-popover="true"
      style={placementStyle(pos, POPOVER_WIDTH)}
      className={`fixed z-[70] px-2.5 py-2 flex flex-col gap-2 text-ui select-none ${POPOVER_SURFACE_CLASS}`}
    >
      <PanelHeader title={t("typography.settings")} onClose={onClose} />

      {!styleOwnsType && (
        <DecorationRow
          values={armedStyleValues}
          onToggle={onToggleDecoration}
        />
      )}

      {!styleOwnsType && (
        <CaseRow
          value={textTransform}
          onChange={onChangeTextTransform}
        />
      )}

      <div className={ROW_SPREAD_GAP_CLASS}>
        <span className={`${SUB_LABEL_CLASS} shrink-0`}>{t("typography.figures")}</span>
        <SegmentedControl<string>
          className="flex-1"
          value={figuresValue}
          onChange={onChangeFigures}
          items={[
            {
              value: "normal",
              icon: <NumeralsMark tabular={false} />,
              title: t("typography.figuresProportional"),
              grow: true,
              attrs: { "data-typography-figures": "normal" }
            },
            {
              value: "tabular-nums",
              icon: <NumeralsMark tabular />,
              title: t("typography.figuresTabular"),
              grow: true,
              attrs: { "data-typography-figures": "tabular-nums" }
            }
          ]}
        />
      </div>

      <div className={ROW_SPREAD_GAP_CLASS}>
        <span className={`${SUB_LABEL_CLASS} shrink-0`}>{t("typography.truncate")}</span>
        <SegmentedControl<string>
          className="flex-1"
          value={truncateMode}
          onChange={onChangeTruncate}
          items={[
            {
              value: "off",
              icon: <Minus size={11} />,
              title: t("typography.truncateOff"),
              grow: true,
              attrs: { "data-typography-truncate": "off" }
            },
            {
              value: "clip",
              icon: <ArrowDownFromLine size={11} />,
              title: t("typography.truncateClip"),
              grow: true,
              attrs: { "data-typography-truncate": "clip" }
            },
            {
              value: "ellipsis",
              label: "…",
              title: t("typography.truncateEllipsis"),
              grow: true,
              attrs: { "data-typography-truncate": "ellipsis" }
            }
          ]}
        />
      </div>

      {maxLines !== undefined && (
        <ScrubInput
          label={t("typography.truncateLines")}
          value={maxLines ?? 1}
          min={1}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          onChange={(l) => onChangeMaxLines(Math.max(1, Math.round(l)))}
        />
      )}
    </div>,
    document.body
  );
}
