import { ancestorChain } from "../../../core/interactions/component-swap";
import { isContainer } from "../../../core/geometry/tree-ops";
import { getImageCropTarget, setImageCropTarget } from "../image-crop-edit";
import { isPickerOpen } from "../picker-focus";
import { isBrowserReservedKey, presentKey } from "../../present/presentKeys";
import { isArrowKey, isInputTarget, isMod, swallow } from "./guards";
import type { KeyRule } from "./types";

/**
 * The rules that belong to a MODE rather than to a command: presentation, crop,
 * vector edit, and the two keys that walk the mode stack (Escape, Enter).
 *
 * They sit at the top of the keymap because a mode that is open owns the
 * keyboard. Everything they do, they do because a listener in the capture phase
 * on `window` runs BEFORE the overlay that a user would expect to answer the key
 * — an overlay stopping propagation is already too late.
 */

/**
 * `Cmd/Ctrl + Enter` toggles presentation.
 *
 * Ahead of `presentation` below AND of the bare-Enter rule further down, which
 * looks at no modifiers and would read this as "enter vector edit mode": the deck
 * drops every key it does not own, so a rule sitting behind that block is a rule
 * that can never close the deck again.
 */
export const TOGGLE_PRESENT: KeyRule = {
  when: (e, ctx) => isMod(e) && e.key === "Enter" && !isInputTarget(e) && Boolean(ctx.onTogglePresent),
  run: (e, ctx) => {
    swallow(e);
    ctx.onTogglePresent?.();
    return true;
  }
};

/**
 * A deck acts on the keys it knows and DROPS every other one, modified or not,
 * because the editor behind the overlay would otherwise nudge with the arrows,
 * delete with Backspace, or — the case a modifier test misses — answer ⌥← and ⌘R,
 * since the arrow rule reads `e.key` and never looks at the modifiers. Only the
 * browser's own chords get through, so a deck really does change nothing.
 */
export const PRESENTATION: KeyRule = {
  when: (_e, ctx) => Boolean(ctx.presentation),
  run: (e, ctx) => {
    const keys = ctx.presentation;
    if (!keys) return false;
    // The browser's chord: not the deck's, and not the editor's either — this
    // rule ends the walk without touching the event.
    if (isBrowserReservedKey(e)) return true;
    if (!presentKey(e, keys)) swallow(e);
    return true;
  }
};

/**
 * Crop mode is the innermost editing mode there is, and both keys mean "leave
 * it" before either means anything else. Enter especially: the rule below reads
 * a lone Enter as "open the vector editor", which would put a pen on the very
 * shape being cropped.
 *
 * Deliberately NOT gated on an open picker, unlike Escape and Enter. Crop mode's
 * panel is a FLOATING one, and it is open for as long as the mode is — so a
 * picker gate would hand both keys to the panel's own dismissal and exit the mode
 * as a side effect of closing a panel. The mode owns its own exit; the panel's
 * close still exits it too, through the row.
 */
export const CROP_EXIT: KeyRule = {
  when: (e) => (e.key === "Escape" || e.key === "Enter") && !isInputTarget(e) && Boolean(getImageCropTarget()),
  run: (e) => {
    swallow(e);
    setImageCropTarget(null);
    return true;
  }
};

/**
 * Escape: leave path edit mode, then the armed tool, then walk the selection up
 * its parent chain. At the page root there is nowhere left to go, so the last
 * press clears the selection.
 */
export const ESCAPE: KeyRule = {
  when: (e) => e.key === "Escape" && !isInputTarget(e) && !isPickerOpen(),
  run: (e, ctx) => {
    e.preventDefault();
    if (ctx.editingPathId && ctx.onExitPathEdit) {
      ctx.onExitPathEdit();
      return true;
    }
    // The armed tool is the newest state on the stack, and it is what Escape
    // leaves first: the selection the tool was about to act on survives the
    // press, so one Escape returns to Move and the next one drops the selection.
    // Clearing both at once made the key feel like a reset, and a user who only
    // wanted out of the Hand tool lost what they were holding.
    //
    // The pen is exempt: it treats Escape as "leave the pen" itself (the draft is
    // cancelled and the tool stays up, which is what drawing a run of paths
    // means), so `path` must not be answered here.
    if (ctx.isScaleToolActive && ctx.onLeaveScaleTool) {
      ctx.onLeaveScaleTool();
      ctx.setCurrentNavTool("select");
      return true;
    }
    if (ctx.activeTool !== "select" && ctx.activeTool !== "path") {
      ctx.setActiveTool("select");
      // The nav slot draws `currentNavTool`, not the active tool, so leaving Hand
      // has to put the SLOT back as well — otherwise the tool is Move and the
      // dock still shows a hand, which reads as "Escape did nothing".
      ctx.setCurrentNavTool("select");
      return true;
    }
    const firstId = Array.from(ctx.selectedIds)[0];
    const chain = firstId ? ancestorChain(ctx.docRef.current, firstId) : [];
    const parent = chain.length > 1 ? chain[chain.length - 2] : null;
    ctx.setSelectedIds(parent ? new Set([parent.id]) : new Set());
    return true;
  }
};

/**
 * Enter: leave the Scale tool, else enter or exit vector edit mode.
 *
 * Scale first: it is a temporary mode with a panel and no draft to commit, so
 * Enter means "I am done with this tool" — and it must be asked before the rules
 * below, which would otherwise answer Enter with a vector editor the user did not
 * ask for.
 *
 * An open floating picker answers Enter itself (it confirms and closes), and this
 * listener runs first — capture on `window` — so the picker cannot block it from
 * below. Hence the registry question rather than an event ordering trick.
 *
 * Declines when it matched none of the three, so a bare Enter still reaches
 * `DRILL_IN`: with no `onStartPathEdit` wired up, Enter on a text layer has to
 * open the text editor rather than fall through to nothing.
 */
export const ENTER: KeyRule = {
  when: (e) => e.key === "Enter" && !isInputTarget(e) && !isPickerOpen(),
  run: (e, ctx) => {
    if (ctx.isScaleToolActive && ctx.onLeaveScaleTool) {
      e.preventDefault();
      ctx.onLeaveScaleTool();
      return true;
    }
    if (ctx.editingPathId && ctx.onExitPathEdit) {
      e.preventDefault();
      ctx.onExitPathEdit();
      return true;
    }
    if (ctx.primarySelected && ctx.selectedIds.size === 1 && ctx.onStartPathEdit) {
      e.preventDefault();
      ctx.onStartPathEdit(ctx.primarySelected);
      return true;
    }
    return false;
  }
};

/**
 * Enter on a selected container drills into its children; on a text layer it
 * opens the text editor.
 *
 * Both branches open a canvas edit, and a locked layer is reachable only through
 * the Layers Panel — it answers neither.
 */
export const DRILL_IN: KeyRule = {
  when: (e) => e.key === "Enter" && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey,
  run: (e, ctx) => {
    const el = ctx.primarySelected;
    if (!el || el.locked || ctx.selectedIds.size !== 1) return false;
    if (el.type === "text") {
      swallow(e);
      ctx.startCanvasTextEdit(el);
      return true;
    }
    if (!isContainer(el)) return false;
    const children = el.children || [];
    if (children.length === 0) return false;
    swallow(e);
    ctx.setSelectedIds(new Set(children.map((c) => c.id)));
    return true;
  }
};

/**
 * While a path is in vector edit the arrows and Backspace belong to the anchor
 * overlay, not to the element. This listener runs in the capture phase, so the
 * overlay cannot protect them with stopPropagation — hence a rule that ends the
 * walk WITHOUT touching the event.
 */
export const PATH_EDIT_PASSTHROUGH: KeyRule = {
  when: (e, ctx) =>
    Boolean(ctx.editingPathId) &&
    (isArrowKey(e) || ((e.key === "Backspace" || e.key === "Delete") && ctx.selectedIds.size > 0)),
  run: () => true
};
