import { ScrubInput } from "../ScrubInput";
import { SegmentedControl } from "../SegmentedControl";
import { t } from "../../i18n";
import { spacingScrubHooks } from "../hooks/spacing-scrub";
import { SpacingKind } from "../../core/geometry/spacing-bands";
import { PanelLeftDashed, PanelRightDashed } from "lucide-react";

export type PadMode = "1" | "2" | "4";
export type PadTuple = [number, number, number, number];

/**
 * Padding mode 2 (vertical + horizontal) glyph: a box split into quadrants.
 *
 * It was a cross of double-headed arrows, one per axis, and at 13px the four
 * arrowheads met in the middle and read as one blot — the exact confusion the
 * other two modes avoid by drawing the BOX they apply to. Keeping the box and
 * splitting it by a horizontal and a vertical rule says what the mode does: the
 * two bands share one value, top with bottom and left with right. Same frame as
 * mode 1's inset ring and mode 4's ticked edges, so the three read as one set.
 */
function AxisPaddingIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M3 12h18M12 3v18" />
    </svg>
  );
}

/**
 * Padding mode 1 (one value for every side): a box with a uniform inset.
 *
 * The three modes used to be `Maximize2` / cross / `Move` — and `Maximize2` is
 * the corner-arrows "expand" glyph, which says the opposite of "one number for
 * all four sides". These two are drawn as what the mode DOES: an inset ring for
 * the uniform case, a tick on each edge for the independent one.
 */
function UniformPaddingIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <rect x="8.5" y="8.5" width="7" height="7" rx="1" />
    </svg>
  );
}

/** Padding mode 4 (a value per side): a box with a tick on every edge. */
function SidesPaddingIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M12 3v3.5M12 17.5V21M3 12h3.5M17.5 12H21" />
    </svg>
  );
}
/**
 * The padding-mode segment, which flex and grid both render and margin borrows.
 *
 * It picks how many numbers the editor shows — one, two, or four — and each
 * choice is also what the canvas overlay is told to light up, so the switch is a
 * statement about the drawing and not only about the field.
 */
export function PadModeSegmented({
  value,
  onChange
}: {
  value: PadMode;
  onChange: (next: PadMode) => void;
}) {
  return (
    <SegmentedControl<PadMode>
      items={[
        { value: "1", icon: <UniformPaddingIcon />, title: t("stack.paddingModeAll") },
        { value: "2", icon: <AxisPaddingIcon />, title: t("stack.paddingModeAxis") },
        { value: "4", icon: <SidesPaddingIcon />, title: t("stack.paddingModeSides") }
      ]}
      value={value}
      onChange={onChange}
    />
  );
}

/** The four pad fields, shown per the mode: one scrub, two, or a 2×2 grid. */
export function PaddingFields({
  pad,
  mode,
  elementId,
  kind,
  min = 0,
  tokenName,
  onDetachToken,
  onOpenTokenPicker,
  onDragStart,
  onDragEnd,
  onChange
}: {
  pad: PadTuple;
  mode: PadMode;
  /**
   * Who the canvas overlay is drawing for. `elementId` is the frame for padding
   * and the child for margin, and `kind` is what decides the band's treatment —
   * the two are otherwise the same component down to the shared shape of their
   * numbers.
   */
  elementId: string;
  kind: Extract<SpacingKind, "padding" | "margin">;
  /**
   * The floor. 0 for padding — a box smaller than its own content is not a
   * thing — and negative for margins, which are signed on purpose. One component
   * for both because the SHAPE is identical (one, two or four numbers, in CSS
   * order) and the difference is a single number.
   */
  min?: number;
  tokenName?: string;
  onDetachToken?: () => void;
  onOpenTokenPicker?: (anchor: HTMLElement) => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  onChange: (next: PadTuple) => void;
}) {
  const [pt, pr, pb, pl] = pad;

  /**
   * The sides ONE field writes, which is exactly the mode's semantics: "1" is
   * all four, "2" is the vertical or the horizontal pair, "4" is one side. The
   * overlay draws these and no others, so dragging `T` lights the top edge alone
   * instead of every edge of the frame.
   */
  const sidesOf = (side: number): number[] =>
    mode === "1" ? [0, 1, 2, 3] : mode === "2" ? (side === 0 ? [0, 2] : [1, 3]) : [side];
  const scrub = (side: number) =>
    spacingScrubHooks({ elementId, kind, sides: sidesOf(side) }, onDragStart, onDragEnd);

  if (mode === "1") {
    return (
      <ScrubInput
        label={<UniformPaddingIcon />}
        value={pt}
        min={min}
        tokenName={tokenName}
        onDetachToken={onDetachToken}
        onOpenTokenPicker={onOpenTokenPicker}
        {...scrub(0)}
        onChange={(v) => onChange([v, v, v, v])}
      />
    );
  }
  if (mode === "2") {
    return (
      <div className="grid grid-cols-2 gap-1.5">
        <ScrubInput
          label={t("stack.paddingShortVertical")}
          value={pt}
          min={min}
          {...scrub(0)}
          onChange={(v) => onChange([v, pr, v, pr])}
        />
        <ScrubInput
          label={t("stack.paddingShortHorizontal")}
          value={pr}
          min={min}
          {...scrub(1)}
          onChange={(v) => onChange([pt, v, pt, v])}
        />
      </div>
    );
  }
  /* Reading order of the 2×2 grid: T R / L B. The bottom row reads left-to-right
     as left-then-bottom, so the cell under `T` is `L` rather than `B`. */
  return (
    <div className="grid grid-cols-2 gap-1">
      <ScrubInput
        label={<PanelLeftDashed size={12} className="rotate-90 shrink-0" />}
        title={t("stack.paddingShortTop")}
        value={pt}
        min={min}
        {...scrub(0)}
        onChange={(v) => onChange([v, pr, pb, pl])}
      />
      <ScrubInput
        label={<PanelRightDashed size={12} className="shrink-0" />}
        title={t("stack.paddingShortRight")}
        value={pr}
        min={min}
        {...scrub(1)}
        onChange={(v) => onChange([pt, v, pb, pl])}
      />
      <ScrubInput
        label={<PanelLeftDashed size={12} className="shrink-0" />}
        title={t("stack.paddingShortLeft")}
        value={pl}
        min={min}
        {...scrub(3)}
        onChange={(v) => onChange([pt, pr, pb, v])}
      />
      <ScrubInput
        label={<PanelRightDashed size={12} className="rotate-90 shrink-0" />}
        title={t("stack.paddingShortBottom")}
        value={pb}
        min={min}
        {...scrub(2)}
        onChange={(v) => onChange([pt, pr, v, pl])}
      />
    </div>
  );
}
