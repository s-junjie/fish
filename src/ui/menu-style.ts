/**
 * The one menu.
 *
 * A menu is a lightweight popover: it floats over the canvas or a panel, it is
 * dismissed by the same gestures, and its rows are the same rows. It was drawn
 * three times — the right-click `ContextMenu`, the dock's three tool menus, and
 * the effect-kind menu — and the copies had drifted into three different
 * objects:
 *
 *   - **width**: the dock menus were a hard `w-36` (144px). "Scale" and
 *     "Reset instance" do not fit in 144px of 12px monospace, and a label that
 *     does not fit is a menu that has to be re-opened to read.
 *   - **the separator was invisible**: `h-px bg-raised` on a `bg-raised` menu is
 *     a 1px line of the colour it is drawn on. Two of the three dock menus have
 *     one, and neither could be seen.
 *   - **elevation**: `bg-panel` in one place, `bg-raised` in another, and
 *     `raised` is also the row HOVER — so a hovered row disappeared into its own
 *     menu.
 *
 * Fixed here once. Width and metrics are exported because the row height is
 * needed for the viewport-overflow calculation, not because callers should be
 * choosing their own.
 *
 * Hover is brand amber, the way it was before this module existed. The earlier
 * argument for `raised` was that brand means "armed tool" or "commit" — but a
 * menu row IS a command, and a command row lighting up in the command colour is
 * the one place that reading is true rather than borrowed. Conflict states keep
 * coral, which is why the two never have to share a row.
 *
 * No `transition-colors` here, unlike every other control in the shell: a menu
 * opens on the press and the pointer is already over the row it lands on, so a
 * fade means the first thing the user sees is the row mid-transition. Instant
 * is also what Figma and macOS do here.
 */

/** Shared by every menu surface; callers add their own positioning.
 *  `min-w-[216px]` is `MENU_WIDTH` as a class — the number lives in the class
 *  because Tailwind cannot read a JS constant, and the comment is the only thing
 *  keeping the two in step. */
export const MENU_SURFACE_CLASS =
  "min-w-[216px] rounded-pill border border-rule-strong bg-surface p-1 shadow-popover z-50";

/** One menu row. Rounded items inside inset container with no transition. */
export const MENU_ITEM_CLASS =
  "group w-full font-sans flex items-center gap-2 h-[26px] px-2.5 rounded-ctl text-left text-ui text-ink-dim hover:text-brand-ink hover:bg-brand disabled:pointer-events-none disabled:text-ink-muted disabled:hover:bg-transparent disabled:hover:text-ink-muted transition-none";

/** Armed: brand TEXT, and brand hover flips it to brand-ink. */
export const MENU_ITEM_ON_CLASS = "text-brand hover:text-brand-ink hover:bg-brand";

/**
 * The two-line option row: a name and the sentence explaining it — the size
 * menu's Fixed / Fit Content / Max Content / Fill.
 *
 * `MENU_ITEM_CLASS` cannot be adopted verbatim because it pins `h-[26px]` and
 * holds one line. This is that same row allowed to grow, so it inherits every
 * other rule rather than re-deciding them: sans, the brand hover, no transition.
 *
 * Its one liberty is the vertical rhythm: `gap-0.5` is a typographic adjustment
 * between a name and its own explanation, not layout spacing, and `gap-1` (4px)
 * opened every row by 2px for no reading gain.
 */
export const MENU_OPTION_CLASS =
  "group w-full font-sans flex flex-col items-start gap-0.5 px-2 py-1.5 rounded-ctl text-left transition-none hover:bg-brand disabled:pointer-events-none disabled:hover:bg-transparent";

/** The option's name. The menu row's step (`ui`), which is what a menu row is. */
export const MENU_OPTION_NAME_CLASS =
  "flex-1 text-ui text-ink-dim group-hover:text-brand-ink";

/** Armed name, and the mark beside it. Both flip on the brand hover fill. */
export const MENU_OPTION_NAME_ON_CLASS = "text-brand group-hover:text-brand-ink";

/**
 * The explanation under a name: prose, one step down from it.
 *
 * `row` rather than `ui` because a name and the sentence defining it are two
 * ranks, and §The label tiers' whole argument is that ranks are separated by
 * SIZE as well as colour — on one step they differ only by ink and read as one
 * block. `AutosaveBadge`'s popover pairs the same way (sans `ui` title over sans
 * `row` description). The line-height comes from the step, so none is set here.
 */
export const MENU_OPTION_NOTE_CLASS =
  "text-row text-ink-muted group-hover:text-brand-ink";

/** Shortcut badge in a menu row. Turns to brand-ink on hover alongside the row label with no transition. */
export const MENU_SHORTCUT_CLASS =
  "shrink-0 text-row text-ink-muted tabular-nums group-hover:text-brand-ink transition-none";

/** A rule between groups. `rule`, NOT the surface colour — see the note above. */
export const MENU_SEPARATOR_CLASS = "my-1 mx-1.5 h-px bg-rule";

/** Minimum width, in px. Wide enough for the longest command in the app. */
export const MENU_WIDTH = 216;

/** Row height, in px. Must match `MENU_ITEM_CLASS`'s `h-[26px]`. */
export const MENU_ROW_HEIGHT = 26;
/**
 * The NON-menu floating layer: a popover with content in it rather than rows —
 * the autosave panel, the style picker, the font list, the colour panel.
 *
 * Same shell as a menu — ridge border, the popover depth tier, the same radius —
 * because it is the same object seen from a different angle. It was a fourth set
 * of values (`bg-panel` + `border-rule`), which is what made the autosave popover
 * read as a different product next to the menus it shares a dismissal rule with.
 *
 * **`panel`, where a menu is `surface`.** A menu's rows are text over an open
 * plate, so the plate can be the higher step without anything landing on the same
 * step. A content popover paints `surface` BLOCKS in it — a paint row is a
 * `surface` card by definition (DESIGN.md §Colors), and a `field` sits in its
 * wells. On a `surface` popover that row measured ΔL = 0.00 against its own
 * container: the card vanished and the whole panel read as one flat sheet.
 * The rule is DESIGN.md's — "every popover's base" is `panel`, and `surface` is
 * the second elevation for NESTED chrome — so `panel` is what makes the nesting
 * legible; `surface` on both levels is what erased it.
 */
export const POPOVER_SURFACE_CLASS =
  "rounded-pill border border-rule-strong bg-panel py-1 shadow-popover z-50";
