// Type-only leaf. Lives in core/ so `geometry/shape-creation.ts` can name the
// tool union without core reaching back into the toolbar component that renders
// the dock; the union is domain vocabulary, the dock is one view of it.

export type ToolType =
  | "select"
  | "hand"
  /** Scales a selection and everything measured in pixels of it. Behaves as
   *  `select` for picking and marquee; only the resize differs. */
  | "scale"
  | "frame"
  | "rect"
  | "ellipse"
  | "line"
  | "arrow"
  | "polygon"
  | "star"
  | "path"
  | "text"
  | "text-on-path"
  | "comment";

export type ShapeToolType = "rect" | "ellipse" | "line" | "arrow" | "polygon" | "star" | "path";

/**
 * What the pen does with a click.
 *
 * `draw` starts a new path; the other two edit one that already exists, the way
 * Figma's pen changes its cursor when it is pointed at a shape.
 */
export type PenMode = "draw" | "add" | "remove";

/** `P` walks this order, so `draw` is always reachable from anywhere in it. */
export const PEN_MODES: readonly PenMode[] = ["draw", "add", "remove"];

export const nextPenMode = (mode: PenMode): PenMode => {
  const i = PEN_MODES.indexOf(mode);
  return PEN_MODES[(i + 1) % PEN_MODES.length];
};

/** The tools the dock's first group holds. Scale is one of them: it picks and
 *  moves like Move and only differs in the resize, so it is the third way to move
 *  things rather than a tool of its own. */
export type NavToolType = "select" | "hand";
