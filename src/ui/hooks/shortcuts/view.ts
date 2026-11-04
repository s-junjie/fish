import { isInputTarget, isMod, isPlain, swallow } from "./guards";
import type { KeyRule } from "./types";

/** The camera, and the chrome that frames it. */

/** `Tab` or `Cmd/Ctrl + .`: collapse every chrome panel into a pure canvas. */
export const TOGGLE_UI: KeyRule = {
  when: (e) =>
    !isInputTarget(e) &&
    ((e.key === "Tab" && !e.metaKey && !e.ctrlKey && !e.altKey) ||
      (isMod(e) && (e.key === "." || e.code === "Period"))),
  run: (e, ctx) => {
    swallow(e);
    ctx.onToggleUiVisible?.();
    return true;
  }
};

/**
 * `Plus` / `Minus` walk the zoom ladder.
 *
 * Matched on `e.code`, for the same reason `altCode` exists: the character Shift
 * produces is layout-dependent ("!" on most, "+" and "_" here), and the numpad is
 * a second code entirely. They are also deliberately the Cmd-less form, so they
 * cannot be confused with a file or document command.
 */
export const ZOOM_IN: KeyRule = {
  when: (e) => isPlain(e) && (e.code === "Equal" || e.code === "NumpadAdd"),
  run: (e, ctx) => {
    swallow(e);
    ctx.zoom().onZoomIn?.();
    return true;
  }
};

export const ZOOM_OUT: KeyRule = {
  when: (e) => isPlain(e) && (e.code === "Minus" || e.code === "NumpadSubtract"),
  run: (e, ctx) => {
    swallow(e);
    ctx.zoom().onZoomOut?.();
    return true;
  }
};

const SHIFT_DIGIT_TARGETS = {
  Digit0: "onZoomToActualSize",
  Digit1: "onZoomToFit",
  Digit2: "onZoomToSelection"
} as const;

/** `Shift+0` sits at 1:1, `Shift+1` frames the page, `Shift+2` frames the selection. */
export const ZOOM_SHIFT_DIGITS: KeyRule = {
  when: (e) => {
    if (!e.shiftKey || isMod(e) || e.altKey) return false;
    const digit = /^(?:Digit|Numpad)([012])$/.exec(e.code);
    return digit !== null;
  },
  run: (e, ctx) => {
    const code = e.code.replace(/^Numpad/, "Digit") as keyof typeof SHIFT_DIGIT_TARGETS;
    swallow(e);
    ctx.zoom()[SHIFT_DIGIT_TARGETS[code]]?.();
    return true;
  }
};

/**
 * `Cmd/Ctrl + 0` is also 1:1, and it is the chord people reach for out of habit.
 * Browsers bind it to "reset page zoom", so the default is cancelled rather than
 * left to race us for the key.
 */
export const ZOOM_ACTUAL_MOD0: KeyRule = {
  when: (e) => isMod(e) && !e.altKey && !e.shiftKey && (e.code === "Digit0" || e.code === "Numpad0"),
  run: (e, ctx) => {
    swallow(e);
    ctx.zoom().onZoomToActualSize?.();
    return true;
  }
};

/** Space holds a temporary pan mode; the matching keyup puts it down. */
export const SPACE_PAN: KeyRule = {
  when: (e, ctx) => e.code === "Space" && !ctx.isSpacePressed,
  run: (e, ctx) => {
    e.preventDefault();
    ctx.setIsSpacePressed(true);
    return true;
  }
};
