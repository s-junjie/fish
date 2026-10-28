import { useEffect, useState } from "preact/hooks";

/**
 * The inspector and the canvas are looking at the same element, and the selection
 * chrome is drawn over it.
 *
 * Typing `40` into a width field and watching the box's outline and eight handles
 * jump on every keystroke is noisy, and on a large selection the handles sit right
 * on top of the numbers being read. So while a *value* is being worked the
 * overlay goes away, and comes back on its own once the panel has been quiet for a
 * couple of seconds — long enough to have typed a new value, short enough that the
 * box is never missing when the user looks up from the panel.
 *
 * Two rules keep this from becoming "the canvas is broken":
 *
 *  - **Only editing counts.** Pressing a button in the panel is a command, not an
 *    edit, and a button that commits (resize to fit, a style card) is the exact
 *    moment the user is about to go back to the canvas. Hiding the handles for two
 *    seconds after a click on "resize to fit" leaves nothing to drag.
 *  - **Touching the canvas brings them straight back.** The suppression is for
 *    reading a number, not for the gesture that follows it; a pointer press on the
 *    canvas restores the overlay immediately rather than waiting out the timer.
 *
 * A module-level store rather than component state, because the two consumers are
 * in different trees that do not share a re-rendering parent: the panel and
 * `CanvasArea` are siblings under `main.tsx`, and a prop-carried update would
 * re-render the whole canvas on every keystroke.
 */

const RESTORE_DELAY_MS = 2000;

let hidden = false;
let timer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<(hidden: boolean) => void>();

function publish() {
  for (const listener of listeners) listener(hidden);
}

function restore() {
  if (timer) clearTimeout(timer);
  timer = null;
  if (!hidden) return;
  hidden = false;
  publish();
}

/** Restart the quiet period. Called on every interaction with an inspector value. */
export function notifyInspectorActivity(): void {
  hidden = true;
  publish();
  if (timer) clearTimeout(timer);
  timer = setTimeout(restore, RESTORE_DELAY_MS);
}

function subscribe(listener: (hidden: boolean) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** `true` while the overlay should stay off the canvas. */
export function useInspectorOverlayHidden(): boolean {
  const [value, setValue] = useState(hidden);
  useEffect(() => {
    // Re-read on mount: the timer can fire between render and subscribe, and
    // starting from a stale `true` would leave the overlay off for good.
    setValue(hidden);
    return subscribe(setValue);
  }, []);
  return value;
}

/**
 * Mark the subtree as part of the inspector, wherever it is rendered from.
 *
 * The colour and style popovers portal into `document.body`, so a listener on the
 * panel root would never see an edit made inside one — which is where half of all
 * property editing happens. One attribute per portal root lets a single
 * document-level listener answer "is this event ours?".
 */
export const INSPECTOR_ACTIVITY_ATTR = "data-inspector-activity";

export function isInspectorActivityTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return Boolean(el?.closest?.(`[${INSPECTOR_ACTIVITY_ATTR}]`));
}

/**
 * The colour panel's three drag surfaces: the hue and alpha rails, the
 * saturation/value square, and a gradient's stop bar. Each writes the colour on
 * every pointer move, so the value is being watched change under the pointer —
 * the same reason a scrub suppresses the overlay, and for the same reason a
 * swatch button does not: a swatch commits and the user goes back to the canvas,
 * a rail is still being moved.
 *
 * Named here rather than at each call site so the rule stays one predicate.
 */
const COLOR_SURFACES = "[data-rail], [data-sv-area], [data-gradient-bar]";

/** A field being edited, as opposed to a control being pressed. */
function isValueEdit(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || el.tagName === "BUTTON") return false;
  // A scrub starts on its LABEL, a span outside the input, and the press is the
  // edit: without this the overlay would stay up over the numbers being scrubbed,
  // which is the exact thing suppression exists to prevent.
  if (el.closest?.("[data-scrub-label]")) return true;
  if (el.closest?.(COLOR_SURFACES)) return true;
  if (el.isContentEditable) return true;
  if (el.tagName === "TEXTAREA" || el.tagName === "SELECT") return true;
  return el.tagName === "INPUT";
}

/**
 * Take the overlay off the canvas while an inspector value is being worked, and
 * put it back on the next quiet period or the next canvas press.
 *
 * All listeners are on `document` in the capture phase, because the popovers
 * render outside the panel and because a canvas press has to be seen *before* the
 * gesture handler decides whether there are handles to grab.
 */
export function useInspectorActivityWatcher(): void {
  useEffect(() => {
    const onEdit = (e: Event) => {
      if (!isInspectorActivityTarget(e.target)) return;
      // `input` is the only signal a scrub emits (it writes the value straight to
      // the store, never through the DOM), and it can only come from a value.
      if (e.type === "input" || isValueEdit(e.target)) notifyInspectorActivity();
    };
    /**
     * Restoring on POINTERMOVE rather than on pointerdown.
     *
     * The difference is whether a gesture can start at all. A handle has to exist
     * to receive the press that grabs it, so restoring on `pointerdown` is already
     * too late for a drag that begins on one — and three e2e suites failed in a way
     * that read as a broken resize. Restoring as soon as the pointer LEAVES the
     * panel means the handles are back before the pointer ever reaches them, so
     * shift-dragging off a panel button works and a drag straight onto a handle
     * works too.
     */
    const onLeavePanel = (e: Event) => {
      if (isInspectorActivityTarget(e.target)) return;
      restore();
    };
    for (const name of ["focusin", "input", "pointerdown"] as const) {
      document.addEventListener(name, onEdit, true);
    }
    // `pointermove` rather than `pointerover`: it fires for the very first motion
    // across the canvas and does not depend on an element boundary being crossed.
    document.addEventListener("pointermove", onLeavePanel, true);
    return () => {
      for (const name of ["focusin", "input", "pointerdown"] as const) {
        document.removeEventListener(name, onEdit, true);
      }
      document.removeEventListener("pointermove", onLeavePanel, true);
    };
  }, []);
}
