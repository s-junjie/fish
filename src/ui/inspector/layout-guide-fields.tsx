import type { ComponentChildren } from "preact";
import type { DesignDocument, LayoutGuide, LayoutGuideAlign, LayoutGuideKind } from "../../core/dsl/types";
import { DEFAULT_GUIDE_COLOR, guideGeometry, retargetGuide, type GuideBox } from "../../core/layout/layout-guides";
import { ColorField } from "../ColorField";
import { ScrubInput } from "../ScrubInput";
import { Select } from "../Select";
import { t } from "../../i18n";
import { Columns, Grid, Rows } from "lucide-react";

export const GUIDE_KINDS: LayoutGuideKind[] = ["columns", "rows", "grid"];

/** The leading mark of a guide row — the same one the layer section draws. */
export const GUIDE_KIND_ICON = { columns: Columns, rows: Rows, grid: Grid } as const;
const ALIGNS: LayoutGuideAlign[] = ["start", "center", "end", "stretch"];

/**
 * One guide's settings, as rows.
 *
 * Shared by the two places a guide is edited — the popover on a layer, and a
 * saved style in the design system — so the two cannot drift into asking for the
 * same numbers differently. `box` is only ever used to seed a fixed-size set's
 * width when the alignment changes; a style has no frame, so it passes a nominal
 * one and the author edits the number anyway.
 */
export function LayoutGuideFields({
  guide,
  box,
  doc,
  onChange,
  onDragStart,
  onDragEnd,
  trailing
}: {
  guide: LayoutGuide;
  box: GuideBox;
  doc?: DesignDocument;
  onChange: (next: LayoutGuide, commit?: boolean) => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  /** Sits beside the kind select — the remove button of a multi-guide style. */
  trailing?: ComponentChildren;
}) {
  const align = guide.align ?? "stretch";
  const geometry = guideGeometry(guide, box);

  return (
    <>
      <div className="flex items-center gap-1">
        <Select
          className="flex-1"
          data-layout-guide-kind={guide.kind}
          value={guide.kind}
          onChange={(value) => onChange(retargetGuide(guide, value as LayoutGuideKind, box), true)}
        >
          {GUIDE_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {t(`layoutGuide.kind.${kind}`)}
            </option>
          ))}
        </Select>
        {trailing}
      </div>

      {guide.kind === "grid" ? (
        <ScrubInput
          className="w-full"
          value={guide.size ?? 8}
          min={1}
          label={t("layoutGuide.size")}
          onChange={(value) => onChange({ ...guide, size: Math.max(1, value) })}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
        />
      ) : (
        <>
          <ScrubInput
            className="w-full"
            value={guide.count ?? 1}
            min={1}
            max={48}
            label={t("layoutGuide.count")}
            onChange={(value) => onChange({ ...guide, count: Math.max(1, Math.round(value)) })}
            onDragStart={onDragStart}
            onDragEnd={onDragEnd}
          />

          <Select
              className="w-full"
              data-layout-guide-align={guide.kind}
              value={align}
              onChange={(value) => {
                const next = value as LayoutGuideAlign;
                if (next === "stretch") {
                  const { width: _width, height: _height, ...rest } = guide;
                  onChange({ ...rest, align: next }, true);
                  return;
                }
                const size = Math.round(geometry.kind === "bands" ? geometry.bandSize : 96);
                onChange(
                  guide.kind === "columns"
                    ? { ...guide, align: next, width: guide.width ?? size }
                    : { ...guide, align: next, height: guide.height ?? size },
                  true
                );
              }}
            >
              {ALIGNS.map((value) => (
                <option key={value} value={value}>
                  {t(`layoutGuide.align.${guide.kind === "rows" ? "y" : "x"}.${value}`)}
                </option>
              ))}
            </Select>

          {/* A fixed-size set is the only one with a size to state. Showing the
              stretched width here as a disabled number would be a control that
              changes when the box resizes without ever being edited. */}
          {align !== "stretch" && (
            <ScrubInput
              className="w-full"
              value={(guide.kind === "columns" ? guide.width : guide.height) ?? 0}
              min={1}
              label={t(guide.kind === "columns" ? "layoutGuide.width" : "layoutGuide.height")}
              onChange={(value) =>
                onChange(
                  guide.kind === "columns"
                    ? { ...guide, width: Math.max(1, value) }
                    : { ...guide, height: Math.max(1, value) }
                )
              }
              onDragStart={onDragStart}
              onDragEnd={onDragEnd}
            />
          )}

          <ScrubInput
            className="w-full"
            value={guide.margin ?? 0}
            min={0}
            label={t("layoutGuide.margin")}
            onChange={(value) => onChange({ ...guide, margin: Math.max(0, value) })}
            onDragStart={onDragStart}
            onDragEnd={onDragEnd}
          />

          <ScrubInput
            className="w-full"
            value={guide.gutter ?? 0}
            min={0}
            label={t("layoutGuide.gutter")}
            onChange={(value) => onChange({ ...guide, gutter: Math.max(0, value) })}
            onDragStart={onDragStart}
            onDragEnd={onDragEnd}
          />
        </>
      )}

      <ColorField
        className="w-full"
        value={guide.color ?? DEFAULT_GUIDE_COLOR}
        doc={doc}
        onChange={(value, discrete) => onChange({ ...guide, color: value }, Boolean(discrete))}
        onGestureStart={onDragStart}
        onGestureEnd={onDragEnd}
      />
    </>
  );
}
