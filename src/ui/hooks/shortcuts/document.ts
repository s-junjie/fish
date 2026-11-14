import { isContainer } from "../../../core/geometry/tree-ops";
import { runEditorCommand } from "../../commands/editor-commands";
import { hasDraftUndo, runDraftUndo } from "../draft-undo";
import { refuseDerivedEdit } from "../selection-guards";
import { altCode, isInputTarget, isMod, letterOf, swallow } from "./guards";
import type { KeyRule } from "./types";

/**
 * Commands on the document and on the selection's place in it: file, history,
 * structure, components. All of them go through `runEditorCommand`, so a key here
 * and the menu item that spells the same command cannot drift apart.
 */

/** `Cmd + R` or `F2`: rename the selected layer. Also prevents a browser reload. */
export const RENAME: KeyRule = {
  when: (e) => ((isMod(e) && letterOf(e) === "r") || e.key === "F2") && !isInputTarget(e),
  run: (e, ctx) => {
    swallow(e);
    if (refuseDerivedEdit(ctx.docRef.current, ctx.selectedIds, ctx.setHintMessage)) return true;
    const el = ctx.primarySelected;
    if (el) ctx.startRenaming(el.id, el.name || el.type);
    return true;
  }
};

/** `Cmd + G`: group. `Cmd + Shift + G`: ungroup. `Cmd + Alt + G`: group as frame. */
export const GROUP: KeyRule = {
  when: (e) => isMod(e) && letterOf(e) === "g" && !isInputTarget(e),
  run: (e, ctx) => {
    swallow(e);
    if (refuseDerivedEdit(ctx.docRef.current, ctx.selectedIds, ctx.setHintMessage)) return true;
    if (e.shiftKey) {
      if (ctx.primarySelected && isContainer(ctx.primarySelected)) runEditorCommand("ungroup");
    } else if (e.altKey) {
      runEditorCommand("groupAsFrame");
    } else {
      runEditorCommand("group");
    }
    return true;
  }
};

/** `Shift + Cmd + L`: lock / unlock the selection (toggle, Figma parity). */
export const TOGGLE_LOCK: KeyRule = {
  when: (e) => isMod(e) && e.shiftKey && letterOf(e) === "l" && !isInputTarget(e),
  run: (e) => {
    swallow(e);
    runEditorCommand("toggleLockSelection");
    return true;
  }
};

/** `Cmd + Alt + K`: create a component out of the selection. */
export const CREATE_COMPONENT: KeyRule = {
  when: (e) => isMod(e) && e.altKey && altCode(e, "k") && !isInputTarget(e),
  run: (e) => {
    swallow(e);
    runEditorCommand("createComponent");
    return true;
  }
};

/** `Cmd + Alt + B`: detach an instance from its main component. */
export const DETACH_INSTANCE: KeyRule = {
  when: (e) => isMod(e) && e.altKey && altCode(e, "b") && !isInputTarget(e),
  run: (e) => {
    swallow(e);
    runEditorCommand("detachInstance");
    return true;
  }
};

export const DRAFT_UNDO_REDO: KeyRule = {
  when: (e) => isMod(e) && !e.altKey && (letterOf(e) === "z" || letterOf(e) === "y") && hasDraftUndo(),
  run: (e) => {
    swallow(e);
    runDraftUndo(letterOf(e) === "y" || e.shiftKey);
    return true;
  }
};

export const UNDO_REDO: KeyRule = {
  when: (e) => isMod(e) && letterOf(e) === "z",
  run: (e, ctx) => {
    e.preventDefault();
    if (e.shiftKey) ctx.handleRedo();
    else ctx.handleUndo();
    return true;
  }
};

export const REDO: KeyRule = {
  when: (e) => isMod(e) && letterOf(e) === "y",
  run: (e, ctx) => {
    e.preventDefault();
    ctx.handleRedo();
    return true;
  }
};

/** `Cmd + S` saves, `Shift + Cmd + S` saves as. */
export const SAVE: KeyRule = {
  when: (e) => isMod(e) && letterOf(e) === "s",
  run: (e, ctx) => {
    // No handler means this file may not be written: leave the browser's own ⌘S
    // alone rather than swallowing it on a document that cannot save.
    if (!ctx.triggerSave) return true;
    e.preventDefault();
    if (e.shiftKey && ctx.triggerSaveAs) ctx.triggerSaveAs();
    else ctx.triggerSave();
    return true;
  }
};

export const FLATTEN: KeyRule = {
  when: (e) => isMod(e) && !e.altKey && !e.shiftKey && letterOf(e) === "e",
  run: (e) => {
    e.preventDefault();
    runEditorCommand("flatten");
    return true;
  }
};

export const OUTLINE_TEXT: KeyRule = {
  when: (e) => isMod(e) && e.shiftKey && !e.altKey && letterOf(e) === "o",
  run: (e) => {
    e.preventDefault();
    runEditorCommand("outlineText");
    return true;
  }
};
