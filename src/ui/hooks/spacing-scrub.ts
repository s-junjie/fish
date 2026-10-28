import { useEffect, useState } from "preact/hooks";
import { SpacingScrub } from "../../core/geometry/spacing-bands";

/**
 * "A spacing value is being scrubbed in the inspector right now, and here is
 * which one." The canvas reads it and draws the matching bands.
 *
 * The alternative — carrying the descriptor down as props — cannot work from
 * where it has to be written. `ScrubInput` fires `onDragStart` when the pointer
 * goes down on its label and `onDragEnd` when it comes up, and neither knows
 * whether the field it belongs to is padding, margin or gap; and the reader is
 * `CanvasArea`, a different subtree whose re-render on every `pointermove` would
 * be the canvas work the scrub is already spending on the document.
 *
 * So this is a module-level store for the same reason `inspector-activity.ts` is
 * one, and it holds the same amount of state: one descriptor, set on press and
 * cleared on release.
 */

let current: SpacingScrub | null = null;
const listeners = new Set<(scrub: SpacingScrub | null) => void>();

function publish() {
  for (const listener of listeners) listener(current);
}

/** Announce the start of a spacing scrub. Safe to call twice — the last wins. */
export function beginSpacingScrub(scrub: SpacingScrub): void {
  current = scrub;
  publish();
}

/**
 * Clear the scrub.
 *
 * Deliberately not conditional on the descriptor matching the one that began it:
 * a release always has to reach the canvas, because the overlay must not be able
 * to outlive the gesture that put it there — a band left on the canvas with no
 * scrub driving it cannot be dismissed by any other means.
 */
export function endSpacingScrub(): void {
  if (!current) return;
  current = null;
  publish();
}

export function useSpacingScrub(): SpacingScrub | null {
  const [value, setValue] = useState(current);
  useEffect(() => {
    // Re-read on mount for the same reason `inspector-activity.ts` does: the
    // press can land between this component's render and its subscription.
    setValue(current);
    return subscribe(setValue);
  }, []);
  return value;
}

function subscribe(listener: (scrub: SpacingScrub | null) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * The `[onDragStart, onDragEnd]` pair a spacing field hands to `ScrubInput`.
 *
 * Wrapped rather than added to `ScrubInput` because `ScrubInput` is a generic
 * numeric field: knowing that a field is padding and not a width is the
 * inspector's business, and putting it on the primitive would make every scrub
 * in the app carry a box-model descriptor it has no use for.
 */
export function spacingScrubHooks(
  scrub: SpacingScrub,
  onDragStart: () => void,
  onDragEnd: () => void
): { onDragStart: () => void; onDragEnd: () => void } {
  return {
    onDragStart: () => {
      beginSpacingScrub(scrub);
      onDragStart();
    },
    onDragEnd: () => {
      endSpacingScrub();
      onDragEnd();
    }
  };
}