/**
 * The frame size list, shown while the Frame tool is armed — the same place, and
 * the same moment, Figma offers its presets. It replaces the rest of the panel
 * for as long as the tool is on, selection or no selection: arming the tool is a
 * statement that the next thing to happen is a NEW board, and the sections that
 * describe the current layer answer a question the user has already left.
 *
 * It is an inspector SECTION rather than a dock menu because the choice is a
 * size, and a size is a property: the panel is where properties live, and the
 * dock's one job is to say which tool is armed. The list also has to be
 * readable while the user is dragging a custom frame, which a menu that covers
 * the canvas is not.
 *
 * One header per group rather than one header over the whole list: the groups
 * are the units a person scrolls past (they came for a phone, not for a size
 * table), so each folds on its own and the four together are still the whole
 * panel. There is no umbrella title above them — "Frame presets" would be the
 * fourth statement of the same thing in a panel whose only content is presets.
 *
 * Pressing a row CREATES and leaves the tool, so the list disappears in the
 * same gesture — one frame per press, no armed mode left behind.
 *
 * Rows, not cards: a preset is a name over a measurement, and a grid of chips
 * read as a gallery of boards rather than as the list of sizes it is. A row also
 * gives the size its own right-aligned column, which is the only way `440 × 956`
 * and `375 × 667` can be compared without reading each one.
 */
import { t } from "../../i18n";
import { FRAME_PRESETS, FRAME_PRESET_GROUPS, type FramePreset } from "../../core/frame-presets";
import { Section } from "./SectionHeader";

interface FramePresetListProps {
  onCreate: (preset: FramePreset) => void;
}

const PRESETS_BY_GROUP = FRAME_PRESET_GROUPS.map((group) => ({
  group,
  presets: FRAME_PRESETS.filter((p) => p.group === group)
})).filter((g) => g.presets.length);

export function FramePresetList({ onCreate }: FramePresetListProps) {
  return (
    <>
      {PRESETS_BY_GROUP.map(({ group, presets }) => (
        <Section key={group} id={`frame-presets-${group}`} title={t(`frame.presets.group.${group}`)}>
          <div className="-mx-1.5 space-y-0.5">
            {presets.map((preset) => (
              <button
                key={preset.id}
                type="button"
                data-frame-preset={preset.id}
                onClick={() => onCreate(preset)}
                className="group flex h-[26px] w-full items-center justify-between gap-2 rounded-ctl px-1.5 text-left transition-colors duration-micro ease-snap hover:bg-raised"
              >
                <span className="min-w-0 truncate text-row text-ink-dim group-hover:text-ink">
                  {t(preset.nameKey)}
                </span>
                <span className="shrink-0 text-meta tabular-nums text-ink-muted">
                  {preset.width} × {preset.height}
                </span>
              </button>
            ))}
          </div>
        </Section>
      ))}
    </>
  );
}
