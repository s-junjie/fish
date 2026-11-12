import { updateActivePageElements } from "../../../core/dsl/document-ops";
import { mapElements } from "../../../core/geometry/tree-ops";
import type { ArrowDirection } from "../../../core/interactions/alignment";
import { nudgeElements, reorderInAutoLayout, reorderZIndex } from "../../../core/interactions/alignment";
import { runEditorCommand } from "../../commands/editor-commands";
import { getImageCropTarget } from "../image-crop-edit";
import { consumeGradientStopDelete } from "../gradient-edit";
import { editableSelection, refuseDerivedEdit } from "../selection-guards";
import { altCode, isInputTarget, isMod, isPlain, isArrowKey, letterOf, swallow } from "./guards";
import type { KeyRule } from "./types";

/**
 * Edits that act on the selection: opacity, clipboard, nudge, z-order, delete.
 *
 * Every one of them runs the same two guards first — `refuseDerivedEdit` (a
 * resolved instance child has no id of its own to write) and `editableSelection`
 * (a locked layer is not the canvas's to move) — because a keyboard path that
 * skips a guard is a way around it.
 */

const DIGIT = /^(?:Digit|Numpad)([0-9])$/;

/** Number keys 0-9 set opacity: 1 = 10%, 2 = 20%, ..., 9 = 90%, 0 = 100%. */
export const OPACITY_DIGIT: KeyRule = {
  when: (e, ctx) => isPlain(e) && DIGIT.test(e.code) && ctx.selectedIds.size > 0,
  run: (e, ctx) => {
    if (refuseDerivedEdit(ctx.docRef.current, ctx.selectedIds, ctx.setHintMessage)) return true;
    const ids = editableSelection(ctx.activeEls(), ctx.selectedIds);
    // Nothing editable under it: decline, so the digit stays available to the
    // rules behind this one.
    if (ids.size === 0) return false;
    swallow(e);
    const digit = Number(DIGIT.exec(e.code)?.[1] ?? "0");
    const opacity = digit === 0 ? 1 : digit / 10;
    const next = mapElements(ctx.activeEls(), (el) => (ids.has(el.id) ? { ...el, opacity } : el));
    ctx.commitSnapshot(updateActivePageElements(ctx.docRef.current, next));
    return true;
  }
};

/**
 * `Cmd + A`: every layer on the selection's own level (Figma's "select all
 * siblings"), or the page roots when nothing is selected.
 *
 * Not while an inner mode holds the canvas — a vector edit is about its anchors,
 * and crop is bound to the one image it is framing, whose panel lives off the
 * selection this would replace.
 */
export const SELECT_ALL: KeyRule = {
  when: (e, ctx) =>
    isMod(e) && !e.altKey && !e.shiftKey && letterOf(e) === "a" && !ctx.editingPathId && !getImageCropTarget(),
  run: (e) => {
    swallow(e);
    runEditorCommand("selectAll");
    return true;
  }
};

/**
 * Copy / paste properties: Figma parks these on `Cmd + Alt + C` / `Cmd + Alt + V`,
 * and the Alt is what keeps them clear of the plain clipboard below.
 */
export const STYLE_CLIPBOARD: KeyRule = {
  when: (e) => isMod(e) && e.altKey && (altCode(e, "c") || altCode(e, "v")) && !isInputTarget(e),
  run: (e) => {
    swallow(e);
    runEditorCommand(altCode(e, "c") ? "copyStyle" : "pasteStyle");
    return true;
  }
};

/**
 * Copy as PNG at 2x: `Shift + Cmd + C`.
 *
 * Ahead of the plain clipboard rule so it wins over `Cmd + C`, and Shift keeps it
 * clear of `Cmd + Alt + C`. The same command at 1x is the context-menu "Copy as
 * PNG".
 */
export const COPY_AS_PNG: KeyRule = {
  when: (e) => isMod(e) && e.shiftKey && letterOf(e) === "c" && !isInputTarget(e),
  run: (e) => {
    swallow(e);
    runEditorCommand("copyAsPng", { scale: 2 });
    return true;
  }
};

/**
 * Clipboard: `Cmd + C` / `Cmd + X` / `Cmd + D`.
 *
 * `Cmd + V` is deliberately left to the browser so the `paste` event fires —
 * `useEditorCommands` is the single paste entry (images, cross-file payloads,
 * plain text, in-memory fallback).
 */
export const CLIPBOARD: KeyRule = {
  when: (e) => isMod(e) && (letterOf(e) === "c" || letterOf(e) === "x" || letterOf(e) === "d"),
  run: (e) => {
    swallow(e);
    const k = letterOf(e);
    runEditorCommand(k === "c" ? "copy" : k === "x" ? "cut" : "duplicate");
    return true;
  }
};

const NUDGE_VECTOR: Record<ArrowDirection, [number, number]> = {
  left: [-1, 0],
  right: [1, 0],
  up: [0, -1],
  down: [0, 1]
};

const DIRECTION_OF: Record<string, ArrowDirection> = {
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowUp: "up",
  ArrowDown: "down"
};

/**
 * Arrow keys nudge — except for a DIRECT child of an auto-layout stack, which has
 * no position of its own, so arrows walk it through the ordering. A layer inside
 * a plain frame within a stack is placed by that frame and nudges like any other
 * element.
 */
export const ARROW_NUDGE: KeyRule = {
  when: (e, ctx) => isArrowKey(e) && ctx.selectedIds.size > 0,
  run: (e, ctx) => {
    e.preventDefault();
    if (refuseDerivedEdit(ctx.docRef.current, ctx.selectedIds, ctx.setHintMessage)) return true;
    const els = ctx.activeEls();
    const ids = editableSelection(els, ctx.selectedIds);
    if (ids.size === 0) return true;
    const dir = DIRECTION_OF[e.key];
    const stackMove = reorderInAutoLayout(els, ids, dir);
    if (stackMove) {
      if (stackMove.moved) ctx.commitSnapshot(updateActivePageElements(ctx.docRef.current, stackMove.elements));
      return true;
    }
    const [dx, dy] = NUDGE_VECTOR[dir];
    ctx.commitSnapshot(updateActivePageElements(ctx.docRef.current, nudgeElements(els, ids, dx, dy, e.shiftKey)));
    return true;
  }
};

/**
 * Layer ordering: `[`, `]`, `Cmd + [`, `Cmd + ]`.
 *
 * Matched on `e.code`, for the same reason the Alt shortcuts are (LESSONS §46):
 * `e.key` is a CHARACTER, and a bare bracket is the one key a layout or an IME
 * most reliably rewrites on the way to the page. `Shift + [` already arrives as
 * `{`, a Chinese or Japanese IME composes it into something else entirely, and a
 * dead key can raise `isComposing` and be dropped by the guard at the top of the
 * dispatcher — while `Cmd + [` short-circuits the IME and arrives clean.
 *
 * Figma's mapping, which is the one the context menu's hints advertise: bare
 * moves the layer to the very front / very back, Cmd steps it one place.
 */
export const Z_ORDER: KeyRule = {
  when: (e, ctx) => ctx.selectedIds.size > 0 && (e.code === "BracketRight" || e.code === "BracketLeft"),
  run: (e, ctx) => {
    e.preventDefault();
    if (refuseDerivedEdit(ctx.docRef.current, ctx.selectedIds, ctx.setHintMessage)) return true;
    const els = ctx.activeEls();
    const ids = editableSelection(els, ctx.selectedIds);
    if (ids.size === 0) return true;
    const forward = e.code === "BracketRight";
    const action = isMod(e) ? (forward ? "forward" : "backward") : forward ? "front" : "back";
    const next = reorderZIndex(els, ids, action);
    if (next !== els) ctx.commitSnapshot(updateActivePageElements(ctx.docRef.current, next));
    return true;
  }
};

export const DELETE: KeyRule = {
  when: (e, ctx) => (e.key === "Backspace" || e.key === "Delete") && ctx.selectedIds.size > 0,
  run: (e) => {
    e.preventDefault();
    // A stop is a sub-object of the layer, and the panel editing one is a
    // portal the shortcut cannot see into. While a gradient editor is open the
    // key belongs to that stop: removing the layer it was aiming at is the one
    // outcome the author cannot undo their way out of.
    if (consumeGradientStopDelete()) return true;
    runEditorCommand("delete");
    return true;
  }
};
