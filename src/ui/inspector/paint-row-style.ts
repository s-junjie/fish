/**
 * The chrome every paint ROW wears: Fill, Stroke, Effects and the
 * selection-colours strip.
 *
 * All four draw the same thing — a swatch, a hex, an opacity — and they drifted:
 * the strip's rows sat on the flat canvas background with a dim label while Fill's
 * were an elevated row, so one colour read as two different objects inside one
 * panel. The same drift StylePill exists for, so the fix is the same: one
 * definition. Values are tokens (AGENTS §3), not hex utilities.
 *
 * `border` (the width) lives here, the COLOUR does not: Fill and Stroke swap the
 * colour while their own panel is open, and two competing `border-*` utilities
 * resolve by stylesheet order, not by class order — so exactly one colour class
 * is appended. Without the width the colour class was a declaration with nothing
 * to paint: `border-paint-row-rule` set a colour on a box preflight had already
 * given `border-width: 0`, so the hairline around every paint row — and the
 * brighter one that IS the open state — never rendered at all. Measured: 0px.
 */
export const PAINT_ROW_CLASS =
  "relative flex items-center gap-2 h-[30px] rounded-swatch border px-[9px] transition-colors bg-surface hover:bg-rule";

export const PAINT_ROW_RULE_IDLE = "border-paint-row-rule";

export const PAINT_ROW_RULE_OPEN = "border-paint-row-rule-open";

/**
 * A stroke row that wears a style.
 *
 * The style needs a line of its own: a name in a 30px row beside width, settings,
 * eye and remove left it 67px, which truncated `Brand Orange` to `Brand O…`. So
 * the bound row is a CARD — the style on top, the controls that belong to that
 * same stroke below — and ONE border around both is what says they are one row.
 * The grip inside drags the card, never a single line. A free row keeps the
 * single line it always had; there is no name to make room for.
 */
/**
 * The demo's `.sw`: 14px square, 3px radius, ringed INSIDE by a 16% white
 * hairline so the edge reads against any colour the swatch happens to be.
 * A `border` would eat 2px of the 14 and leave 12px of colour; `ring-inset`
 * keeps the full square, which is what the demo draws.
 *
 * No cursor: Fill's swatch is a div, the strip's is a button, each sets its own.
 */
export const PAINT_SWATCH_CLASS =
  "relative h-3.5 w-3.5 flex-none shrink-0 overflow-hidden rounded-swatch ring-1 ring-inset ring-swatch-ring";

/**
 * Alpha only reads against something — this is what makes a translucent paint
 * legible.
 *
 * Inline because Tailwind cannot express a conic gradient as a utility, but
 * still one definition: it was copied into the swatch, the row, the colour
 * field, the drag ghost and the style picker, and the copy in the picker had
 * drifted a shade lighter, so one paint read as two different greys.
 */
export const PAINT_SWATCH_CHECKER: Record<string, string> = {
  backgroundImage: "repeating-conic-gradient(#3a3a3a 0% 25%, #242424 0% 50%)",
  backgroundSize: "6px 6px"
};

/**
 * The line that marks a row's pending drop slot.
 *
 * The ring is neutral on purpose. It used to be `0 0 4px rgba(59,130,246,.6)`
 * — a BLUE glow on an amber bar, which was wrong twice over: DESIGN.md forbids
 * coloured/glowing shadows, and #3B82F6 is `canvas-select`, a canvas semantic
 * that means "selected", not "glowing". A dark 1px ring gives the bar the
 * definition it needed without either problem.
 */
export const PAINT_DROP_INDICATOR_CLASS =
  "absolute left-0 right-0 h-[2px] bg-brand z-30 pointer-events-none rounded-full shadow-[0_0_0_1px_rgba(0,0,0,0.45)]";

/** The demo's `.paint .hex`: 10px mono, tabular, `ink-dim`. It was `text-xs`
    (12px) — two steps above the demo, and the reason a paint row read wide. */
export const PAINT_HEX_FIELD_CLASS =
  "min-w-0 flex-1 bg-transparent text-left text-code tabular-nums uppercase text-ink-dim focus:outline-none";

/**
 * The alpha % scrub well container in paint rows.
 *
 * 48px fits "100" and "%" comfortably without squishing the hex field.
 * Previously `w-[4.5rem]` (72px) was oversized and starved the hex field in narrower panels.
 */
export const PAINT_ALPHA_CONTAINER_CLASS = "w-[48px] shrink-0";

