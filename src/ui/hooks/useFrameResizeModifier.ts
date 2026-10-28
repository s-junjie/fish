import { useEffect, useState } from "preact/hooks";

/**
 * True while Cmd (macOS) or Ctrl (Windows/Linux) is held.
 *
 * The Cmd/Ctrl+drag frame resize needs to know about the modifier BEFORE the
 * gesture starts, because a frame whose axis the layout engine owns has no usable
 * handle to grab until it is held. The canvas therefore has to be able to draw
 * those handles on a key press, not on a pointer press.
 *
 * Key state is tracked from the event rather than read off the pointer event, so
 * it is correct for the window as a whole — and a `blur` clears it, because a
 * key held while the tab loses focus never delivers its `keyup`.
 */
export function useFrameResizeModifier(): boolean {
  const [held, setHeld] = useState(false);

  useEffect(() => {
    const isModifier = (e: KeyboardEvent) => e.metaKey || e.ctrlKey;
    const sync = (e: KeyboardEvent) => setHeld(isModifier(e));
    const clear = () => setHeld(false);
    window.addEventListener("keydown", sync);
    window.addEventListener("keyup", sync);
    window.addEventListener("blur", clear);
    return () => {
      window.removeEventListener("keydown", sync);
      window.removeEventListener("keyup", sync);
      window.removeEventListener("blur", clear);
    };
  }, []);

  return held;
}
