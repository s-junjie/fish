import { DesignElement } from "../dsl/types";
import type { ChildSizeResolver } from "./box";

/**
 * Bakes the measured size of every TOP-LEVEL instance into the tree.
 *
 * An instance of a hugging master is painted at the size its master's recipe
 * measured, not at the box it was authored with (`resolveInstanceContent`), and a
 * text override or a scale changes that measurement on every resolution. A nested
 * instance is written by the parent's layout pass, which places it as a child; a
 * top-level one has no parent and nothing did, so its stored box drifted away from
 * what the canvas drew. Everything that reads the tree rather than the renderer —
 * the selection box, the Scale panel's W/H, the scale reference — then disagreed
 * with the artwork: the W/H fields jumped the moment the tool opened, and the
 * outline sat somewhere the component was not.
 *
 * `resolve` is the pass's own resolver, never the ambient one: a caller that named a
 * document (a test, an import, another page) must get that document's measurements.
 *
 * Returns the same array when nothing moved, so structural sharing survives.
 */
export function syncInstanceSizing(
  elements: DesignElement[],
  resolve: ChildSizeResolver | undefined
): DesignElement[] {
  if (!resolve) return elements;
  let changed = false;
  const next = elements.map((el) => {
    if (el.type !== "instance") return el;
    const box = resolve(el);
    if (!box || (box.width === el.width && box.height === el.height)) return el;
    changed = true;
    return { ...el, width: box.width, height: box.height };
  });
  return changed ? next : elements;
}
