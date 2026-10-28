export interface PresentationKeys {
  next: () => void;
  prev: () => void;
  first: () => void;
  last: () => void;
  exit: () => void;
  toggleFullscreen?: () => void;
}

/**
 * Presentation mode's keymap, and whether a key belonged to it.
 *
 * It has to be asked for from the shortcut layer rather than handled inside the
 * overlay: that layer listens on `window` in the capture phase, so an overlay
 * that stops propagation is already too late — the same reason `picker-focus`
 * exists. Presentation answers every key it recognises and the caller swallows
 * the rest, because a deck must not also be nudging elements with the arrow
 * keys or deleting them with Backspace.
 */
export function presentKey(e: KeyboardEvent, keys: PresentationKeys): boolean {
  const go = (fn: () => void) => {
    e.preventDefault();
    e.stopPropagation();
    fn();
    return true;
  };

  switch (e.key) {
    case "Escape":
      return go(keys.exit);
    case "ArrowRight":
    case "ArrowDown":
    case "PageDown":
      return go(keys.next);
    case "ArrowLeft":
    case "ArrowUp":
    case "PageUp":
      return go(keys.prev);
    case "Home":
      return go(keys.first);
    case "End":
      return go(keys.last);
    case "r":
    case "R":
      return go(keys.first);
    case "f":
    case "F":
      if (!e.metaKey && !e.ctrlKey && keys.toggleFullscreen) return go(keys.toggleFullscreen);
      break;
    default:
      break;
  }
  // Space advances, matched on `e.code` because `e.key` for it is a space
  // character a layout or an IME is free to rewrite.
  if (e.code === "Space") return go(keys.next);
  return false;
}

/**
 * The chords a deck must not swallow: the ones the browser and the OS answer
 * before the page is consulted.
 *
 * This is an allowlist rather than "no ⌘, so let ⌘ through", because the
 * editor's shortcuts are built out of exactly the modified keys that pass such a
 * test. The arrow-nudge branch reads `e.key` and never looks at the modifiers,
 * so a "modified keys pass through" rule let ⌥← nudge the layer hidden behind
 * the overlay and push an undo entry, and let ⌘R open a rename field back there
 * that the deck then swallowed every keystroke of. Letting only these through
 * is what makes "a deck changes nothing" true rather than nearly true.
 */
export function isBrowserReservedKey(e: KeyboardEvent): boolean {
  if (e.key === "F5" || e.key === "F11" || e.key === "F12") return true;
  if (!e.metaKey && !e.ctrlKey) return false;
  // ⌘W/T/Q/M/N are the browser's own tab, window and quit chords. Matched on
  // `e.code` so an Alt-layer layout cannot disguise one as some other character.
  return ["KeyW", "KeyT", "KeyQ", "KeyM", "KeyN"].includes(e.code);
}
