import { isInputTarget } from "./guards";
import { ALL_RULES, GLOBAL_RULES } from "./keymap";
import type { ShortcutContext } from "./types";

/**
 * One press, walked down the keymap. Exported and free of hooks so the ordering
 * arguments in `keymap.ts` can be graded by a test that owns a fake event.
 */
export function handleShortcut(e: KeyboardEvent, ctx: ShortcutContext): boolean {
  // Guard against IME composition: a key pressed mid-composition belongs to the
  // input method, and `keyCode` 229 is the same event on browsers that report it
  // that way.
  if (e.isComposing || (e as { keyCode?: number }).keyCode === 229) return false;

  const rules = isInputTarget(e) ? GLOBAL_RULES : ALL_RULES;
  for (const rule of rules) {
    if (!rule.when(e, ctx)) continue;
    if (rule.run(e, ctx) === false) continue;
    return true;
  }
  return false;
}
