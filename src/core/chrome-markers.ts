/**
 * The markers the canvas paints its own affordances with.
 *
 * Two readers need the same list, and they are the same list because both are
 * answering "is this something the user drew, or something the editor drew to
 * help them draw it":
 *
 * - `CanvasArea.tsx` sizes the zoom variable on the chrome that is PAINTED, so
 *   it takes the live value on its own element instead of waiting for the root's
 *   settle.
 * - `export.ts` deletes the chrome from the clone, so the file a user ships does
 *   not carry the editor's viewport state.
 *
 * They were spelled separately once, and drifted: the export kept deleting only
 * the overlay/title/hit markers while the canvas had since grown three more, so
 * every export of a document containing a frame shipped a
 * `data-chrome-counter` group holding `--fish-zoom` and the pan offsets — a copy
 * of how the canvas happened to be scrolled, inside a file that has no canvas.
 */

/** Chrome that is drawn, not invisible — so the zoom variable has to reach it. */
export const LIVE_CHROME_SELECTOR =
  "[data-chrome-counter], [data-component-set-outline], [data-instance-placeholder]";

/** Everything that must not survive into an exported file. */
export const EXPORT_CHROME_SELECTOR =
  `[data-overlay='true'], [data-frame-title='true'], [data-hit='true'], ${LIVE_CHROME_SELECTOR}`;
