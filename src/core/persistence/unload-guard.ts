import type { DesignDocument } from "../dsl/types";

/**
 * What the unload guard is allowed to look at: two references and one flag.
 *
 * Deliberately not a predicate over content. This runs inside `beforeunload`,
 * which the browser will not let us block on, and `computeContentHash`
 * normalizes and folds the whole document — 42.6 MB and ~50 ms on the measured
 * file. A guard that costs a frame's worth of main thread on every close is a
 * guard the user experiences as the app hanging before it quits.
 */
export interface UnloadState {
  /** The document object the file was last known to hold. */
  saved: DesignDocument;
  current: DesignDocument;
  /**
   * The controller still owes a write: a debounce is armed, a flush is queued,
   * or one is in flight. A flush is a chain of IndexedDB and File System Access
   * awaits, so a flush that started in `pagehide` can be cut off before it
   * commits anything — "a write is under way" is not evidence that it finished.
   */
  owed: boolean;
}

/**
 * Whether closing the tab right now could lose work.
 *
 * Reference comparison is exact for the question being asked. Every commit
 * replaces the document object, so `saved === current` means nothing has been
 * committed since the write that landed; undo replays the objects the history
 * stack holds rather than re-cloning them, so undoing back to the saved state
 * restores that same reference and the guard clears by itself.
 *
 * The failure mode is a prompt after a commit that produced equal content (a
 * style re-materialization, say) — a dialog the user dismisses. The opposite
 * error is a tab that closes over the last two seconds of work and says
 * nothing, which is why the cheap check is the one that decides.
 */
export function shouldWarnBeforeUnload(state: UnloadState): boolean {
  return state.owed || state.saved !== state.current;
}
