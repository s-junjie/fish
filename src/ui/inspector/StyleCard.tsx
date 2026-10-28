import type { ComponentChildren } from "preact";
import type { JSX } from "preact";

/**
 * One card for a style, wherever it appears.
 *
 * A style shows up in three places — bound under Fill / Stroke / Effects /
 * Typography, listed in the inspector's Local Styles, and listed in the style
 * picker — and each place drew its own: a bordered `surface` pill with an unlink
 * button, a row with a drag grip, and a bare row with no chrome at all. Same
 * object, three shapes, so one style read as three different things depending on
 * where you happened to be standing.
 *
 * The chrome is the PAINT ROW's, because a style IS a paint with a name: the same
 * 38px floor (the paint row's 30px was too tight to show a wrapped description,
 * so the subtitle's own line was clipped even when the rest of the row had room
 * to breathe), the same 3px radius, the same `surface` fill under a 1px inset
 * hairline.
 * The bound state carries NO tint here — it used to wear `bg-selection` (a
 * `brand` wash), but two cards, one bound and one not, read as "two different
 * states of the same card" rather than "the same card, one of them chosen".
 * Selection is a one-check answer, not a colour answer: the caller shows it
 * with a `Check` glyph in the trailing slot (the picker and the local-styles
 * list both already do), and the card itself stays the neutral `surface` it is
 * everywhere else. The inspector uses the same rule for layer rows.
 *
 * `trailing` is an OVERLAY, not a flex child. The row's right end stays in the
 * text's flex flow until a button appears on it, and the button then sits on
 * top of the same pixels the text was using — so a description that fits only
 * when the buttons are gone gets the full width, and the buttons occlude it
 * with their own surface when they appear. The buttons carry the same
 * `bg-surface group-hover:bg-rule` themselves (see `StyleGroupList`), the same
 * way LayerTree's lock/eye do, so the gaps between them show the card, not a
 * third colour.
 */
const CARD =
  "relative flex items-center gap-2 min-h-[38px] py-1.5 rounded-swatch px-2.5 ring-1 ring-inset ring-rule transition-colors";

/** The button surface a trailing overlay wears on a StyleCard so it occludes the
 *  name/subtitle under it — and on hover matches the card's own `bg-rule`. */
export const STYLE_CARD_TRAILING_BG = "bg-surface group-hover:bg-rule";

interface StyleCardProps {
  /** The 14px mark, from `renderStylePreview`. */
  preview: ComponentChildren;
  name: string;
  subtitle?: string;
  /** Buttons at the right end. The caller decides whether to hide them until hover. */
  trailing?: ComponentChildren;
  /** Leading slot — the drag grip, when the list is reorderable. */
  leading?: ComponentChildren;
  /** Bound to the current selection. */
  selected?: boolean;
  onClick?: JSX.MouseEventHandler<HTMLDivElement>;
  className?: string;
  /** Hooks the callers' tests reach for. */
  rowProps?: Record<string, string | undefined>;
}

export function StyleCard({
  preview,
  name,
  subtitle,
  trailing,
  leading,
  selected = false,
  onClick,
  className = "",
  rowProps
}: StyleCardProps) {
  return (
    <div
      {...rowProps}
      onClick={onClick}
      className={`${CARD} bg-surface hover:bg-rule ${
        onClick ? "cursor-pointer" : ""
      } ${className}`.trim()}
    >
      {leading}
      <div className="flex items-center gap-2.5 min-w-0 flex-1">
        <div className="shrink-0">{preview}</div>
        <div className="min-w-0 flex-1 flex flex-col justify-center">
          <span className="block truncate text-row text-ink leading-snug">{name}</span>
          {subtitle ? (
            <span className="block truncate text-meta text-ink-muted leading-snug">
              {subtitle}
            </span>
          ) : null}
        </div>
      </div>
      {/* The overlay slot: absolute so the row's flex layout never sees a button. */}
      {trailing ? (
        <div className="absolute right-1.5 top-1/2 -translate-y-1/2 flex items-center gap-0.5">
          {trailing}
        </div>
      ) : null}
    </div>
  );
}
