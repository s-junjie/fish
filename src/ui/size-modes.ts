import { ContainerElement, DesignElement, SizeMode } from "../core/dsl/types";
import { SizingAxis, withAxisMode, resolveAxisDetail, AXIS_DOWNGRADE_MESSAGES } from "../core/geometry/resolve-axis";
import { t } from "../i18n";

const LABEL_KEYS: Record<SizeMode, string> = {
  fixed: "stack.fixed",
  "fit-content": "stack.hug",
  "max-content": "stack.maxContent",
  fill: "stack.fill"
};

export interface SizeModeOption {
  mode: SizeMode;
  label: string;
  /** What this mode does on this axis, in one line. */
  note: string;
  /** False when the engine would substitute something else for it. */
  effective: boolean;
  /** Why it is unavailable, phrased to read after the label. */
  reason?: string;
}

/** Every mode is listed on every axis; the ones that cannot apply say why instead of vanishing. */
const ALL_MODES: SizeMode[] = ["fixed", "fit-content", "max-content", "fill"];

function noteKey(mode: SizeMode, axis: SizingAxis, el: DesignElement): string {
  if (mode === "fixed") return "stack.noteFixed";
  if (mode === "max-content") return axis === "width" ? "stack.noteMaxWidth" : "stack.noteMaxHeight";
  if (mode === "fill") return axis === "width" ? "stack.noteFillWidth" : "stack.noteFillHeight";
  const isText = el.type === "text";
  if (axis === "width") return isText ? "stack.noteFitTextWidth" : "stack.noteFitWidth";
  return isText ? "stack.noteFitTextHeight" : "stack.noteFitHeight";
}

export function sizeModeLabel(mode: SizeMode): string {
  return t(LABEL_KEYS[mode]);
}

/**
 * The three letters a size field's caret wears when a non-fixed mode is armed.
 *
 * Deliberately NOT localised. These sit in a 25px well beside a number, where
 * `Hug`/`Max Content`/`Fill` would either overflow or push the value off the
 * field — and the menu that opens from the same button carries the full,
 * translated name plus its note, so nothing is lost by shortening the badge.
 */
const SHORT_LABEL: Record<SizeMode, string> = {
  fixed: "fixed",
  "fit-content": "fit",
  "max-content": "max",
  fill: "fill"
};

export function sizeModeShortLabel(mode: SizeMode): string {
  return SHORT_LABEL[mode];
}

/**
 * The options for one axis, each flagged with whether choosing it would change
 * anything. `fill` and `max-content` are the two that can be impossible where
 * the element sits, and offering them greyed with a reason beats both hiding
 * them (the rule stays invisible) and accepting them silently (the pick looks
 * like it worked).
 */
export function sizeModeOptions(
  el: DesignElement | null,
  parent: ContainerElement | null,
  axis: SizingAxis
): SizeModeOption[] {
  if (!el) return [];
  return ALL_MODES.map((mode) => {
    const label = sizeModeLabel(mode);
    const note = t(noteKey(mode, axis, el));
    const probe = withAxisMode(el, axis, mode);
    const stored = (axis === "width" ? probe.sizing?.width : probe.sizing?.height) ?? "fixed";
    const detail = resolveAxisDetail(probe, parent, axis);
    // Two ways a mode can be unavailable: the engine refuses to store it on this
    // axis (max-content has no vertical meaning), or it stores it and then
    // resolves to something else at layout time.
    const storable = stored === mode;
    const effective = storable && detail.mode === mode;
    const reason = effective
      ? undefined
      : detail.downgrade
        ? `${label} ${AXIS_DOWNGRADE_MESSAGES[detail.downgrade]}`
        : note;
    return { mode, label, note, effective, reason };
  });
}
