/**
 * One cell of an icon grid — the align cluster's six, the slide transition
 * picker's five.
 *
 * 25px, `field` fill, its OWN inset hairline, and no tray behind them: the demo's
 * cells sit straight on the panel and the gap between them shows the panel
 * through. A tray filled those gaps in and turned six buttons into one band.
 *
 * `ring-1 ring-inset ring-rule` is the tokenised form of the demo's
 * `box-shadow: inset 0 0 0 1px var(--rule)`.
 *
 * The fill is NOT part of this box, and that is the whole point of the module:
 * `hover:bg-raised` (#242428) is a step *below* `hover:bg-field-active`
 * (#343434), so an armed cell that inherited the unarmed hover lost its fill
 * under the pointer and read as unarmed. Both are hover variants of equal
 * specificity, so which one lands is decided by the order Tailwind emitted them —
 * measured to be `raised`, the one the armed cell cannot have. `iconCell` picks
 * between them instead of letting the stylesheet.
 */
const ICON_CELL_BOX =
  "h-[25px] flex items-center justify-center rounded-swatch ring-1 ring-inset ring-rule " +
  "transition-colors duration-micro ease-snap";

/** The armed cell. A step of NEUTRAL grey above the track, not the amber wash:
 * amber marks an armed TOOL and a commit, and a five-way choice between ways of
 * arriving is neither. */
const ICON_CELL_ARMED = "bg-field-active text-ink hover:bg-field-active";

const ICON_CELL_IDLE = "bg-field text-ink-muted hover:text-ink hover:bg-raised";

/**
 * A cell's classes, armed or not. Every other box property is shared, so a new
 * icon grid cannot pick up a hover the design does not want for it.
 */
export const iconCell = (armed = false) => `${ICON_CELL_BOX} ${armed ? ICON_CELL_ARMED : ICON_CELL_IDLE}`;