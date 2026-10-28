import { DesignElement, MaskMode } from "../../core/dsl/types";
import { MASK_MODES } from "../../core/dsl/schema-enums";
import { maskChannelVaries } from "../../core/dsl/paint-stack";
import { t } from "../../i18n";
import { CheckRow } from "../CheckRow";
import { SegmentedControl } from "../SegmentedControl";
import { Section } from "./SectionHeader";

interface MaskSectionProps {
  /** The whole selection: the channel is one value or it is none. */
  elements: DesignElement[];
  primarySelected: DesignElement | null;
  onMutate: (updater: (el: DesignElement) => DesignElement, commitImmediately?: boolean) => void;
}

/**
 * A mask layer's settings, and the first thing the panel says about the
 * selection: they decide whether the paint listed below is seen at all, so
 * everything under this row is subject to the choice made here.
 *
 * The channel is offered only where it can change the result: over a stack of
 * solid fills, colour is constant, so `luminance` would resolve to the single
 * number `opacity` already carries and the two segments would render
 * identically.
 *
 * `invert` follows `luminance`, because that is the only channel it means
 * anything for: a mask read as its negative. Inverting ALPHA would reveal
 * everything the layer does not paint — a region, not a shape — so the row is
 * not offered there, and the renderer reads the flag only in luminance mode.
 *
 * The whole section is hidden for a stack of solid fills: the channel cannot
 * vary there, so neither the mode nor the thing that follows it has a choice to
 * offer.
 */
export function MaskSection({ elements, primarySelected, onMutate }: MaskSectionProps) {
  if (!primarySelected?.isMask) return null;
  if (!maskChannelVaries(primarySelected.fills)) return null;

  const modesMixed =
    elements.length > 1 &&
    elements.some((el) => (el.maskMode ?? "alpha") !== (primarySelected.maskMode ?? "alpha"));
  // Absent means `alpha`. Showing that as the active segment rather than as an
  // empty control is what makes the default discoverable.
  const mode: MaskMode = primarySelected.maskMode ?? "alpha";
  const inverted = primarySelected.maskInvert === true;
  const invertMixed =
    elements.length > 1 && elements.some((el) => (el.maskInvert === true) !== inverted);

  return (
    <Section id="mask" title={t("mask.mode")}>
      {/* Neither segment lit when they disagree: there is no channel that describes
          the selection, and lighting the primary's would offer a press that means
          something else. Clicking either one is the edit that resolves it. */}
      <SegmentedControl<MaskMode>
        value={modesMixed ? ("" as MaskMode) : mode}
        onChange={(next) => onMutate((el) => ({ ...el, maskMode: next }), true)}
        items={MASK_MODES.map((m) => ({
          value: m,
          label: t(`mask.${m}`),
          title: t(`mask.${m}Hint`),
          grow: true
        }))}
      />
      {/* Unarmed on a mixed selection rather than lit from the primary: pressing
          it means "invert every one of these", which is the same edit from
          either starting state. */}
      {!modesMixed && mode === "luminance" && (
        <CheckRow
          checked={!invertMixed && inverted}
          onChange={(next) => onMutate((el) => ({ ...el, maskInvert: next ? true : undefined }), true)}
          label={t("mask.invert")}
          title={t("mask.invertHint")}
          testId="mask-invert"
        />
      )}
    </Section>
  );
}
