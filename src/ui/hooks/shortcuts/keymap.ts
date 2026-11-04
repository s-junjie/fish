import {
  CREATE_COMPONENT,
  DETACH_INSTANCE,
  FLATTEN,
  GROUP,
  OUTLINE_TEXT,
  REDO,
  RENAME,
  SAVE,
  TOGGLE_LOCK,
  UNDO_REDO
} from "./document";
import {
  ARROW_NUDGE,
  CLIPBOARD,
  COPY_AS_PNG,
  DELETE,
  OPACITY_DIGIT,
  SELECT_ALL,
  STYLE_CLIPBOARD,
  Z_ORDER
} from "./edit";
import { STACK_OR_WRAP } from "./layout";
import {
  CROP_EXIT,
  DRILL_IN,
  ENTER,
  ESCAPE,
  PATH_EDIT_PASSTHROUGH,
  PRESENTATION,
  TOGGLE_PRESENT
} from "./modes";
import { PATH_EDIT_LETTERS, TOOL_LETTERS } from "./tools";
import type { KeyRule } from "./types";
import { SPACE_PAN, TOGGLE_UI, ZOOM_ACTUAL_MOD0, ZOOM_IN, ZOOM_OUT, ZOOM_SHIFT_DIGITS } from "./view";

/**
 * The keymap. Position in these arrays IS priority: the first rule whose `when`
 * holds and whose `run` does not decline wins, and nothing behind it sees the key.
 *
 * Two lists, not one, because a focused input splits the keyboard in half:
 *
 * - `GLOBAL_RULES` are the chords the editor answers before asking where the
 *   keystroke came from: the deck (which a focused field must not shield), the
 *   mode stack, and the structural commands that refuse a field themselves
 *   (`!isInputTarget`).
 * - `CANVAS_RULES` are the canvas's own grammar: letters, digits, arrows,
 *   brackets. None of them may take a keystroke from a name field, so they are
 *   simply not offered one.
 *
 * Most of the order is grouping. What is actually load-bearing:
 *
 * - `TOGGLE_PRESENT` first, because the deck below it drops every key it does not
 *   own — a rule behind it can never close the deck again.
 * - crop, then Escape, then Enter: the innermost mode answers first, and each of
 *   these would otherwise be read as a command by a rule further down.
 * - the vector editor's letters before the tool letters (a letter it owns must not
 *   also swap a tool under the gesture), and its arrow hand-off before the nudge.
 * - `⌘⇧C` before `⌘C`, and `⌥⌘C` / `⌥⌘V` before both: the modifier is the only
 *   thing telling three clipboard commands apart.
 */
export const GLOBAL_RULES: readonly KeyRule[] = [
  TOGGLE_PRESENT,
  PRESENTATION,
  CROP_EXIT,
  ESCAPE,
  ENTER,
  RENAME,
  GROUP,
  TOGGLE_LOCK,
  CREATE_COMPONENT,
  DETACH_INSTANCE,
  TOGGLE_UI
];

export const CANVAS_RULES: readonly KeyRule[] = [
  OPACITY_DIGIT,
  ZOOM_IN,
  ZOOM_OUT,
  ZOOM_SHIFT_DIGITS,
  ZOOM_ACTUAL_MOD0,
  DRILL_IN,
  UNDO_REDO,
  REDO,
  SAVE,
  FLATTEN,
  OUTLINE_TEXT,
  SPACE_PAN,
  SELECT_ALL,
  STYLE_CLIPBOARD,
  COPY_AS_PNG,
  CLIPBOARD,
  PATH_EDIT_LETTERS,
  TOOL_LETTERS,
  STACK_OR_WRAP,
  PATH_EDIT_PASSTHROUGH,
  ARROW_NUDGE,
  Z_ORDER,
  DELETE
];

export const ALL_RULES: readonly KeyRule[] = [...GLOBAL_RULES, ...CANVAS_RULES];
