/**
 * Key predicates, and the two ways a rule may consume an event.
 *
 * `swallow` is the common case: the editor answered the key, so neither the page
 * nor anything behind the overlay may also answer it. `e.preventDefault()` alone
 * is what a rule uses when a listener BELOW still has to see the event — the
 * canvas relies on that for Escape, delete and nudge.
 */

export const isMod = (e: KeyboardEvent) => e.metaKey || e.ctrlKey;

/** No modifier at all — the shape of every canvas letter and digit. */
export const isPlain = (e: KeyboardEvent) =>
  !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey;

/**
 * No CHORD modifier. Shift is allowed, because `Shift+S` still names the key
 * "s" to a user and `P` during a path edit has to keep cycling the pen.
 */
export const isUnchorded = (e: KeyboardEvent) => !e.metaKey && !e.ctrlKey && !e.altKey;

export const letterOf = (e: KeyboardEvent) => e.key.toLowerCase();

/**
 * The physical key, for a shortcut that carries Alt/Option.
 *
 * macOS applies the Option layer to the CHARACTER before the page sees it:
 * ⌥⌘C arrives as `key: "ç"`, ⌥⌘B as `"∫"`, ⌥⌘V as `"√"`. Matching `e.key` there
 * is matching a character the layout invented, so those shortcuts silently did
 * nothing — and the dead key could even open an IME composition. `e.code` is the
 * key the hardware reported and is the same everywhere, so every Alt shortcut
 * matches on it.
 */
export const altCode = (e: KeyboardEvent, letter: string) =>
  e.code === `Key${letter.toUpperCase()}`;

const ARROWS = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]);

export const isArrowKey = (e: KeyboardEvent) => ARROWS.has(e.key);

export const isInputTarget = (e: KeyboardEvent) => {
  const target = e.target as HTMLElement | null;
  if (!target) return false;
  return target.tagName === "INPUT" || target.tagName === "TEXTAREA" || Boolean(target.isContentEditable);
};

export const swallow = (e: KeyboardEvent) => {
  e.preventDefault();
  e.stopPropagation();
};
