import { useCallback, useRef, useState } from "preact/hooks";

/**
 * How long a hint stays up.
 *
 * A refusal is short and a report is not: "Imported 412 layers from Landing as
 * 3 page(s) · 12 layers lost a property Figma's plugin API cannot read" takes
 * several seconds to read, and one fixed number is either too short for the
 * report or insulting for "Nothing to paste". So the time scales with the
 * message — roughly reading speed — inside bounds that keep a paragraph from
 * parking itself on screen for half a minute.
 */
const HINT_FLOOR_MS = 4000;
const HINT_CEILING_MS = 12000;
const HINT_MS_PER_CHAR = 60;

const hintTimeout = (msg: string): number =>
  Math.min(HINT_CEILING_MS, Math.max(HINT_FLOOR_MS, msg.length * HINT_MS_PER_CHAR));

/**
 * The one-line toast, and the timer that takes it down.
 *
 * A hint raised by a REFUSED gesture has to clear itself, or it sits on screen
 * until some unrelated event replaces it — so the timeout lives with the
 * message, not with whichever gesture happened to raise it.
 */
export function useHint() {
  const [hintMessage, setHintMessage] = useState<string>("");
  const [busyMessage, setBusyMessage] = useState<string | null>(null);
  const hintTimerRef = useRef<number | null>(null);

  const showHint = useCallback((msg: string) => {
    setHintMessage(msg);
    if (hintTimerRef.current !== null) window.clearTimeout(hintTimerRef.current);
    hintTimerRef.current = window.setTimeout(() => {
      hintTimerRef.current = null;
      setHintMessage("");
    }, hintTimeout(msg));
  }, []);

  /**
   * Take the hint down NOW, by hand.
   *
   * The timer is cleared as well as the message emptied, because a pending
   * timeout firing into an empty message is harmless but a hint that reappears
   * after being dismissed is not: the click said "I have read this", and the
   * report a long import leaves up is exactly the one a designer dismisses to
   * get on with the next gesture.
   */
  const dismissHint = useCallback(() => {
    if (hintTimerRef.current !== null) window.clearTimeout(hintTimerRef.current);
    hintTimerRef.current = null;
    setHintMessage("");
  }, []);

  /**
   * A pinned "work in progress" line with no timer of its own: it goes down
   * when the caller says the work is done, not after a reading delay — the
   * length of a rasterization is not knowable from the message. A null takes
   * it down. Kept as a separate slot from the toast so a completed report can
   * replace the spinner in the same commit instead of overlapping timers.
   */
  const setBusy = useCallback((msg: string | null) => setBusyMessage(msg), []);

  return { hintMessage, setHintMessage, showHint, dismissHint, busyMessage, setBusy };
}
