import type { ColorFilter } from "../../core/dsl/types";
import {
  ADJUST_AXES,
  COLOR_FILTER_PRESETS,
  isNeutralColorFilter,
  matchPreset,
  presetFilter,
  sliderNeutral,
  valueToSlider,
  withAdjustValue
} from "../../core/dsl/color-filter";
import { t } from "../../i18n";
import { Select } from "../Select";
import { SliderRow } from "../SliderRow";
import { RotateCcw } from "lucide-react";
import { Section } from "./SectionHeader";

interface AdjustRowsProps {
  /** The fold's identity and the group's e2e hook. */
  sectionId: string;
  title: string;
  filter: ColorFilter | undefined;

  onChange: (next: ColorFilter | undefined, discrete?: boolean) => void;
  onDragStart?: () => void;
  onDragEnd?: () => void;

  slidersMaxHeight?: number;
}


export function AdjustRows({
  sectionId,
  title,
  filter,
  onChange,
  onDragStart,
  onDragEnd,
  slidersMaxHeight
}: AdjustRowsProps) {
  const adjusted = !isNeutralColorFilter(filter);
  const preset = matchPreset(filter);

  return (
    <Section
      id={sectionId}
      title={title}
      className="space-y-2 min-h-0 flex flex-col"
      data-adjust-section="1"
      trailing={
        <button
          type="button"
          data-adjust-reset="1"
          disabled={!adjusted}
          onClick={() => onChange(undefined, true)}
          className={`p-0.5 rounded-ctl transition-colors cursor-default ${adjusted ? "text-ink-dim hover:text-ink hover:bg-raised" : "text-ink-muted"
            }`}
          title={t("adjust.reset")}
        >
          <RotateCcw size={13} />
        </button>
      }
    >

      <div data-adjust-preset="1" className="shrink-0">
        <Select
          className="w-full"
          value={preset}
          onChange={(id) => onChange(presetFilter(id), true)}
          title={t("adjust.choosePreset")}
        >
          {COLOR_FILTER_PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {t(`adjust.presets.${p.id}`)}
            </option>
          ))}
          {preset === "custom" && <option value="custom">{t("adjust.custom")}</option>}
        </Select>
      </div>

      <div
        data-adjust-sliders="1"

        className={`space-y-3 pt-0.5 overscroll-contain min-h-0 ${slidersMaxHeight ? "-mx-2.5 px-2.5" : ""
          }`}

        style={
          slidersMaxHeight
            ? {
              maxHeight: slidersMaxHeight,
              overflowY: "auto",
              overflowX: "hidden"
            }
            : undefined
        }
      >
        {ADJUST_AXES.map((axis) => (
          <SliderRow
            key={axis.key}
            dataSlider={axis.key}
            label={t(`adjust.${axis.key}`)}
            value={valueToSlider(axis, filter?.[axis.key])}
            neutralAt={sliderNeutral(axis)}
            onChange={(v) => onChange(withAdjustValue(filter, axis.key, v))}
            onReset={() => onChange(withAdjustValue(filter, axis.key, sliderNeutral(axis)), true)}
            onDragStart={onDragStart}
            onDragEnd={onDragEnd}
          />
        ))}
      </div>
    </Section>
  );
}
