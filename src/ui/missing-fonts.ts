/**
 * The one piece of state the missing-font surface owns: whether it is open, and
 * which edit was refused to open it.
 *
 * Module-level rather than a prop, because the caller that OPENS it is a
 * gesture three layers below the shell (`useInlineEditing`), and the caller that
 * RENDERS it is the shell itself. Threading a setter down would put a modal's
 * visibility in the deps of every hook between them, and every one of those
 * hooks would then re-create its callbacks when a dialog opens. The inspector's
 * section collapse state is stored the same way, for the same reason.
 */
export interface MissingFontBlockedEdit {
  elementId: string;
  /** The layer's name, as the panel says it back to the author. */
  name: string;
  /** The family that refused the edit — the first named one, not `sans-serif`. */
  family: string;
}

export interface MissingFontsState {
  open: boolean;
  blocked: MissingFontBlockedEdit | null;
}

let state: MissingFontsState = { open: false, blocked: null };
const listeners = new Set<() => void>();

export function missingFontsState(): MissingFontsState {
  return state;
}

export function subscribeMissingFonts(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

function publish(next: MissingFontsState): void {
  if (next.open === state.open && next.blocked === state.blocked) return;
  state = next;
  for (const listener of [...listeners]) listener();
}

/**
 * Open the panel. `blocked` is what a refused edit passes, so the panel opens
 * already saying which layer could not be edited and why — a panel that opened
 * with no reason would look like a random interruption.
 */
export function openMissingFonts(blocked: MissingFontBlockedEdit | null = null): void {
  publish({ open: true, blocked });
}

export function closeMissingFonts(): void {
  publish({ open: false, blocked: null });
}
