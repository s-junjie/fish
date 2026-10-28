/**
 * A floating picker is a modal for the *keyboard*, not for the pointer.
 *
 * The global shortcut layer listens on `window` in the CAPTURE phase, so a panel
 * cannot win the race by stopping propagation — whichever order the two listeners
 * were registered in, the shortcut handler runs first. Enter with the colour panel
 * open therefore entered vector edit mode *underneath* the picker, and Escape
 * cleared the selection on its way out.
 *
 * The fix is for the editor to ask before it acts, which is what this registry is
 * for. It is module level rather than a prop because the pickers and the shortcut
 * handler live in different trees that share no re-rendering parent — the same
 * shape as `inspector-activity.ts`.
 *
 * Nested pickers are counted, so the inner one closing does not hand the keyboard
 * back while the outer one is still on screen. The count is clamped at zero: a
 * stray unbalanced close must never leave Enter permanently dead.
 */

let openPickers = 0;

export function setPickerOpen(open: boolean): void {
  openPickers = Math.max(0, openPickers + (open ? 1 : -1));
}

/** `true` while any floating picker owns the keyboard. */
export function isPickerOpen(): boolean {
  return openPickers > 0;
}

/**
 * How many pickers are stacked right now, this one included.
 *
 * A picker that opens another reads this to know whether it is the TOP of the
 * stack: dismissal unwinds one layer at a time, so the parent must stand down
 * while its child is up.
 */
export function pickerDepth(): number {
  return openPickers;
}

