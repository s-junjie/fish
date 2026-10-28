import { DesignDocument, DesignElement } from "../../core/dsl/types";
import { BLEND_MODES } from "../../core/dsl/schema-enums";
import { ScrubInput } from "../ScrubInput";
import { Select } from "../Select";
import { t } from "../../i18n";
import { Section } from "./SectionHeader";
import { ROW_TIGHT_CLASS } from "../row-style";
import { CornerControls, IndependentCornersToggle } from "./CornerControls";
import { MIXED_LABEL, resolveAcross } from "./mixed";

interface AppearanceSectionProps {
  /** The whole selection: every row below is written to every member of it. */
  elements: DesignElement[];
  primarySelected: DesignElement | null;
  doc?: DesignDocument;
  docRef?: { current: DesignDocument };
  /**
   * Whether the corner fields render here. They belong to this section — how a
   * corner is cut is how the layer surfaces — and are withheld only while a path
   * is in edit mode, which has no box to cut. A resolved instance child DOES get
   * them: `borderRadius` is an override, and how deep a card's corner is cut is
   * precisely what an instance is supposed to be able to differ by.
   */
  showCorners: boolean;
  is4Corners: boolean;
  onToggle4Corners: (val: boolean) => void;
  onMutate: (updater: (el: DesignElement) => DesignElement, commitImmediately?: boolean) => void;
  /** The undo stream for a token edit saved from the corner token picker. */
  onCommitSnapshot?: (newDoc: DesignDocument) => void;
  onDragStart: () => void;
  onDragEnd: () => void;
}

/**
 * The APPEARANCE section: how the layer surfaces — the cut of its corners, then
 * blend mode and opacity. Size and the clip switch are NOT here: the W/H fields
 * render at the top of the LAYOUT section (`SizeFields`) and the clip switch
 * closes it (`AutoLayoutSection`), because both are statements about the box
 * rather than its surface.
 */
export function AppearanceSection({
  elements,
  primarySelected,
  doc,
  docRef,
  showCorners,
  is4Corners,
  onToggle4Corners,
  onMutate,
  onCommitSnapshot,
  onDragStart,
  onDragEnd
}: AppearanceSectionProps) {
  if (!primarySelected) return null;

  const blend = resolveAcross(elements, (el) => el.blendMode || "normal");
  const opacity = resolveAcross(elements, (el) => Math.round((el.opacity ?? 1) * 100));

  return (
    /* No eye in the header. Visibility is a property of the LAYER, and the
       layer list already carries it — a second toggle here meant the same
       state had two homes. The trailing slot carries the independent-corners
       switch instead, beside the corner fields it arms. */
    <Section
      id="appearance"
      title={t("properties.appearance")}
      trailing={
        showCorners ? (
          <IndependentCornersToggle
            elements={elements}
            is4Corners={is4Corners}
            onToggle4Corners={onToggle4Corners}
            onMutate={onMutate}
          />
        ) : undefined
      }
    >

      {/* Not gated on a single selection. A corner radius is one number per
          layer, and `onMutate` writes it to all of them — so the section was
          describing a capability the panel had and hiding it exactly when there
          was a selection worth using it on. Fields that disagree read Mixed. */}
      {showCorners && (
        <CornerControls
          elements={elements}
          doc={doc}
          docRef={docRef}
          is4Corners={is4Corners}
          onToggle4Corners={onToggle4Corners}
          onMutate={onMutate}
          onCommitSnapshot={onCommitSnapshot}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
        />
      )}

      {/* Opacity first, blend second — opacity is the knob touched ten times as
          often, so it leads. Both fields flex: two equal halves of one row, no
          fixed width announcing that one value matters less than the other. */}
      <div className={ROW_TIGHT_CLASS}>
        <div className="flex-1 min-w-0">
          <ScrubInput
            label="%"
            value={opacity.mixed ? undefined : opacity.value}
            mixed={opacity.mixed}
            min={0}
            max={100}
            onDragStart={onDragStart}
            onDragEnd={onDragEnd}
            onChange={(pct) => onMutate((el) => ({ ...el, opacity: pct / 100 }))}
          />
        </div>

        <Select
          className="flex-1 min-w-0"
          value={blend.mixed ? "" : blend.value}
          onChange={(mode) => onMutate((el) => ({ ...el, blendMode: mode as any }), true)}
          title={t("blend.label")}
        >
          {/* An option to hold "no one value" — a native select renders `value=""`
              as an empty box, and an empty box beside a filled one says "unset",
              which is a different claim from "these disagree". */}
          {blend.mixed && (
            <option value="" disabled>
              {MIXED_LABEL}
            </option>
          )}
          {BLEND_MODES.map((mode) => (
            <option key={mode} value={mode}>
              {t(`blend.${mode}`)}
            </option>
          ))}
        </Select>
      </div>
    </Section>
  );
}
