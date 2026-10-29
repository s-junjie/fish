const ACTION_BOX_BASE =
  "flex items-center justify-center gap-1.5 h-[25px] rounded-swatch ring-1 ring-inset text-ui font-sans font-medium transition-colors cursor-default";

const ACTION_BAR_BASE = `w-full ${ACTION_BOX_BASE}`;

/**
 * The wide, full-width action button that closes a section: "Create component",
 * "Combine as variants", "Add variant", "Close Path".
 *
 * It wears the same box as a field — 25px, 3px radius, `field` fill under an
 * inset hairline — because anything heavier than the fields around it stops
 * reading as an action on the selection and starts reading as a different kind
 * of object. One definition, because these buttons appear in four panels
 * (ComponentSection, VariantSetMatrix, ExportSection, VectorSection) and four
 * copies would drift.
 */
export const ACTION_BAR_CLASS = `${ACTION_BAR_BASE} bg-field ring-rule`;

/**
 * Enabled: legible as a control, and it BRIGHTENS on hover.
 *
 * Not `hover:bg-raised`: the base is `field` (#242424) and `raised` is #242428 —
 * four units, i.e. a hover with no visible feedback at all, which is how this
 * button came to read as inert. `field-active` is the one neutral step above
 * `field`, and it is the same step the armed segment wears.
 */
export const ACTION_BAR_ON = "text-ink-dim hover:text-ink hover:bg-field-active";

/** Refused: still shows the box, but says it cannot be pressed. */
export const ACTION_BAR_OFF = "text-ink-muted";

/**
 * The same box as a TOGGLE ("Ignore auto layout").
 *
 * The fill is left to the caller here rather than baked into the base because
 * an armed toggle wears `bg-brand-wash` INSTEAD of `bg-field`, and the two
 * cannot be stacked: two `bg-*` utilities on one element resolve by stylesheet
 * order, not by class order, so the fill has to be chosen, not overridden.
 */
export const ACTION_BAR_TOGGLE_CLASS = ACTION_BAR_BASE;

/** A toggle at rest: the plain field box, brightening on hover. */
export const ACTION_BAR_TOGGLE_OFF = `${ACTION_BAR_ON} bg-field ring-rule`;

/**
 * A toggle that is ON: the amber wash. It is the same "armed" fill every other
 * toggle in the panel wears (visibility, lock, mask, 4 corners, loop, muted),
 * and the ring goes amber with it so the box keeps an edge on the wash.
 */
export const ACTION_BAR_TOGGLE_ON = "bg-brand-wash ring-brand text-brand";

/**
 * The same toggle as an icon-only control sharing a row with other actions, so
 * it owns a square box instead of the row's width. It pairs with
 * `ACTION_BAR_TOGGLE_OFF` / `_ON` unchanged: one definition of what an armed
 * toggle looks like, whatever width it is asked to be.
 */
export const ACTION_TOGGLE_ICON_CLASS = `${ACTION_BOX_BASE} w-[25px] flex-none`;

/**
 * The HALF-width twin: two actions side by side ("Reset overrides" /
 * "Detach instance"), or an action sharing a row with fields ("Export PNG"
 * beside its format and scale selects).
 *
 * Same 25px field box as `ACTION_BAR_CLASS`, but no width of its own — the
 * caller sizes it (`flex-1` in a pair, `flex-1` beside selects) — and
 * `text-row font-sans font-medium` with `whitespace-nowrap`, because a 12px mono label in a
 * half-width slot wrapped onto two lines and turned a button into a slab.
 * Pair with `ACTION_BAR_ON` / `ACTION_BAR_OFF` exactly as the full-width bar
 * does.
 */
export const ACTION_BUTTON_CLASS =
  "flex-1 min-w-0 flex items-center justify-center gap-1 h-[25px] rounded-swatch bg-field ring-1 ring-inset ring-rule text-row font-sans font-medium whitespace-nowrap transition-colors cursor-default";
