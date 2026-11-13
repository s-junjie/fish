import { applyAutoLayout } from "../../../core/compile";
import type { FrameElement } from "../../../core/dsl/types";
import { updateActivePageElements } from "../../../core/dsl/document-ops";
import { layoutOf, withLayout } from "../../../core/dsl/layout-flat";
import { mapElements, isContainer } from "../../../core/geometry/tree-ops";
import { runEditorCommand } from "../../commands/editor-commands";
import { isUnchorded, letterOf, swallow } from "./guards";
import type { KeyRule } from "./types";

/**
 * `S`: stack the selection, or stack / unstack one container.
 *
 * On two or more layers it is a structural command (wrap), so it goes through the
 * editor command registry like every other menu item. On a single container it is
 * a toggle on that container's own layout, which the registry has no entry for.
 */
export const STACK_OR_WRAP: KeyRule = {
  when: (e, ctx) => isUnchorded(e) && letterOf(e) === "s",
  run: (e, ctx) => {
    if (ctx.selectedIds.size > 1) {
      swallow(e);
      runEditorCommand(e.shiftKey ? "wrapGrid" : "wrapFlex");
      return true;
    }
    const frame = ctx.primarySelected;
    if (!frame || !isContainer(frame) || ctx.selectedIds.size !== 1) return false;
    swallow(e);
    const target = frame as FrameElement;
    const isStack = layoutOf(target)?.mode === "flex";
    const nextLayout = isStack
      ? undefined
      : {
          mode: "flex" as const,
          direction: "row" as const,
          gap: 16,
          padding: 16,
          justify: "start" as const,
          align: "start" as const
        };
    const next = mapElements(ctx.activeEls(), (el) => {
      if (el.id !== target.id) return el;
      const updated = withLayout(el, nextLayout);
      if (!isStack && (target.children || []).length > 0) {
        const sizing = { ...(el.sizing || {}) };
        if (!sizing.width) sizing.width = "fit-content";
        if (!sizing.height) sizing.height = "fit-content";
        (updated as FrameElement).sizing = sizing;
      } else if (isStack && el.sizing) {
        const sizing = { ...el.sizing };
        delete sizing.width;
        delete sizing.height;
        if (Object.keys(sizing).length === 0) delete (updated as { sizing?: unknown }).sizing;
        else (updated as FrameElement).sizing = sizing;
      }
      return nextLayout ? applyAutoLayout(updated as FrameElement) : (updated as FrameElement);
    });
    ctx.commitSnapshot(updateActivePageElements(ctx.docRef.current, next));
    return true;
  }
};
