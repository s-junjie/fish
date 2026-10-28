import type { ComponentChildren, JSX } from "preact";
import { ACTION_BAR_CLASS, ACTION_BAR_OFF, ACTION_BAR_ON } from "./inspector/action-bar-style";
import { MENU_ITEM_CLASS } from "./menu-style";

/**
 * The workbench's button.
 *
 * An audit of `src/ui` found **160 buttons written as 110 distinct class
 * strings**, and the same object drawn several ways: an icon button was `p-1`
 * here, `p-0.5` there and `w-5 h-5` somewhere else, with `rounded-ctl`,
 * `rounded-ctl` and `rounded-full` for one job. None of those differences were
 * decisions — which is exactly why they could not be kept.
 *
 * The variants are the ROLES the tree actually has:
 *
 *  - `ghost` — the default. No chrome at rest; `ink-dim` → `ink`, and a `raised`
 *    wash on hover. Correct for anything living inside a panel.
 *  - `danger` — `ghost`, but its hover goes `measure-coral`: delete, remove,
 *    unlink. Never a resting colour: a panel of red glyphs reads as a panel of
 *    errors when nothing is wrong.
 *  - `menu` — a full-width row inside a dropdown, left-aligned to its glyph.
 *  - `bar` — the wide action that closes a section, in a field's box. Its
 *    hover/disabled fills come from `action-bar-style.ts`, because `field` sits
 *    only four units below `raised` and the two must be chosen together.
 *  - `boxed` — a small button wearing a `rule` hairline, for where a control has
 *    to look pressable standing on its own.
 *
 * Sizes are BOXES, not paddings. `icon` is 20px square — the slot the section
 * headers reserve for a trailing control — so an icon button may move between a
 * header and a row without changing that row's height. `iconLg` is the 26px of
 * the inspector's own header, which is a header's size, not a row's.
 *
 * Everything else lands on the `<button>`, so a caller keeps its `data-*` hooks,
 * `title`, `aria-*`, `disabled` and handlers.
 */
export type ButtonVariant = "ghost" | "danger" | "menu" | "bar" | "boxed" | "primary";
export type ButtonSize = "icon" | "iconLg" | "dock" | "text" | "field";

const VARIANT: Record<Exclude<ButtonVariant, "bar">, string> = {
  // The one committing action in a surface: a solid brand fill. `primary` was
  // `bg-brand hover:opacity-90` written by hand in four places.
  primary: "bg-brand text-brand-ink font-medium hover:brightness-105 active:brightness-95 disabled:hover:bg-brand disabled:hover:text-brand-ink",
  ghost: "text-ink-dim hover:text-ink hover:bg-raised disabled:hover:bg-transparent disabled:hover:text-ink-dim",
  danger: "text-ink-dim hover:text-measure-coral disabled:hover:bg-transparent disabled:hover:text-ink-dim",
  // Not a second menu definition: the row lives in `menu-style.ts` so the
  // dock menus, the inspector menus and this variant cannot drift.
  menu: MENU_ITEM_CLASS,
// `boxed` owns its height because `ownsBox` exempts it from `SIZE`, and it
  // is the one variant that had none: with only `px-2` and a 1px rule it rendered
  // 19px tall — the 17.4px line box plus two borders, text sitting on the
  // strokes. 25px is the `field` height, so a boxed button matches the rows it
  // sits among instead of introducing a size of its own.
  boxed: "h-[25px] text-ui gap-1 px-2 rounded-ctl border border-rule bg-panel text-ink hover:border-brand"
};

const SIZE: Record<ButtonSize, string> = {
  icon: "h-5 w-5 flex-none",
  iconLg: "h-[26px] w-[26px] flex-none",
  // The dock's caret button width set to 16px (w-4) while keeping 27px height.
  dock: "h-[27px] w-4 flex-none",
  text: "h-5 flex-none px-2",
  // The height of a FIELD. A popover's committing action has to match the rows
  // around it: at `text` (20px) the Grant Access button sat 5px below every
  // other control in its own panel and read as a stray label rather than a
  // button.
  field: "h-[25px] flex-none px-3"
};

/** Every button shares these: pressability, one motion, and no text selection.
 *
 *  The `disabled:hover:` pair is not cosmetic. A `hover:bg-raised` rule still
 *  matches a disabled button, so a control that is switched off would answer
 *  the pointer with a wash — the one thing a disabled state must never do. The
 *  sites that spelled this out by hand disagreed on the number (`opacity-30`
 *  here, `opacity-50` there); 50 is the one the component keeps. */
const BASE = "font-sans text-ui flex items-center justify-center cursor-default select-none transition-colors duration-micro ease-snap disabled:opacity-50";

type ButtonProps = {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Fill the parent's width — for actions that own their row. */
  block?: boolean;
  children?: ComponentChildren;
  /**
   * Extra classes appended after the variant's own. Used by overlays that
   * need to follow a parent's surface — a hover-only trailing slot on a
   * style card wants `bg-surface group-hover:bg-rule`, and it can only do
   * that by extending the button, not replacing it.
   */
  className?: string;
} & Omit<JSX.ButtonHTMLAttributes<HTMLButtonElement>, "children" | "size" | "class" | "className">;

export function Button({
  variant = "ghost",
  size = "text",
  block = false,
  children,
  className = "",
  ...rest
}: ButtonProps) {
  // `menu` and `boxed` own their box — a dropdown row is full-width and its own
  // padding IS the row, and a boxed button sets its own height around a border.
  const ownsBox = variant === "menu" || variant === "boxed";
  if (variant === "bar") {
    return (
      <button
        {...rest}
        type={rest.type ?? "button"}
        className={`${BASE} ${ACTION_BAR_CLASS} ${rest.disabled ? ACTION_BAR_OFF : ACTION_BAR_ON} ${className}`.trim()}
      >
        {children}
      </button>
    );
  }
  return (
    <button
      {...rest}
      type={rest.type ?? "button"}
      className={`${BASE} ${block ? "w-full " : ""}${ownsBox ? "" : SIZE[size]} ${VARIANT[variant]} ${ownsBox ? "" : "rounded-ctl"} ${className}`.trim()}
    >
      {children}
    </button>
  );
}
