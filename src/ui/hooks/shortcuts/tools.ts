import { isUnchorded, letterOf, swallow } from "./guards";
import type { KeyRule } from "./types";

/** The bare letter keys: what tool is armed, and what a letter means inside one. */

/**
 * A path in vector edit is a mode of its own: the single letters belong to the
 * editor inside it, so R or O must not swap in a shape tool underneath the user's
 * hands mid-gesture. Escape and Enter are handled above and still work, which is
 * the only way out.
 */
const PATH_EDIT_OWNED = new Set(["v", "h", "l", "r", "o", "t", "f", "k"]);

export const PATH_EDIT_LETTERS: KeyRule = {
  when: (e, ctx) => Boolean(ctx.editingPathId) && isUnchorded(e),
  run: (e, ctx) => {
    const k = letterOf(e);
    // P still cycles the pen's own mode, because that is the mode being edited —
    // but it must not also swap in the pen tool, or the draw overlay and the
    // anchor overlay end up on screen at once.
    if (k === "p") {
      swallow(e);
      ctx.onCyclePenMode?.(true);
      return true;
    }
    if (PATH_EDIT_OWNED.has(k)) {
      swallow(e);
      return true;
    }
    return false;
  }
};

/**
 * The tool letters.
 *
 * They deliberately do not `swallow` — a bare letter typed on the canvas is not a
 * key the browser would act on, and leaving the event alone keeps a plain
 * character available to anything listening below.
 */
export const TOOL_LETTERS: KeyRule = {
  when: (e) => isUnchorded(e),
  run: (e, ctx) => {
    switch (letterOf(e)) {
      // K is the Scale TOOL, not a command: a mode with live handles, an anchor
      // and a factor, so it belongs in the Move/Hand group in the dock — and this
      // is the ONLY other way in, because a third entry point would give one mode
      // three places to be switched on from and the panel that goes with it has
      // to appear for all of them.
      case "k":
        if (!ctx.onSetScaleTool) return false;
        swallow(e);
        ctx.onSetScaleTool();
        return true;
      case "v":
        ctx.setActiveTool("select");
        ctx.setCurrentNavTool("select");
        return true;
      case "h":
        ctx.setActiveTool("hand");
        ctx.setCurrentNavTool("hand");
        return true;
      case "r":
        ctx.setActiveTool("rect");
        ctx.setCurrentShapeTool("rect");
        return true;
      case "o":
        ctx.setActiveTool("ellipse");
        ctx.setCurrentShapeTool("ellipse");
        return true;
      case "l":
        ctx.setActiveTool("line");
        ctx.setCurrentShapeTool("line");
        return true;
      case "p":
        // Pressing P again walks draw -> add -> remove, the way Figma's pen
        // changes its own cursor. Reaching for the pen twice should not be the
        // only way back to drawing, so the cycle returns to draw.
        ctx.setActiveTool("path");
        ctx.setCurrentShapeTool("path");
        ctx.onCyclePenMode?.(ctx.penActive());
        return true;
      case "t":
        ctx.setActiveTool("text");
        return true;
      case "f":
        ctx.setActiveTool("frame");
        return true;
      case "c":
        ctx.setActiveTool(ctx.activeTool === "comment" ? "select" : "comment");
        return true;
      case "z": {
        const zoom = ctx.zoom();
        swallow(e);
        (ctx.selectedIds.size > 0 ? zoom.onZoomToSelection : zoom.onZoomToFit)?.();
        return true;
      }
      default:
        return false;
    }
  }
};
