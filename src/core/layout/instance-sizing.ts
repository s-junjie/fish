import { AutoLayoutFields, DesignElement } from "../dsl/types";
import { layoutOf } from "../dsl/layout-flat";
import { isContainer } from "../geometry/tree-ops";
import type { ChildSizeResolver } from "./box";

/**
 * Bakes the measured size of every instance that no layout pass owns.
 *
 * An instance of a hugging master is painted at the size its master's recipe
 * measured, not at the box it was authored with (`resolveInstanceContent`), and a
 * text override or a scale changes that measurement on every resolution. An
 * instance inside an auto-layout parent is written by that parent's pass, which
 * places it as a child — including the axes the parent owns, which the master's
 * own measurement must not overwrite. Everything else has no parent to do it:
 * canvas level, or inside a plain frame. Without this its stored box drifted away
 * from what the canvas drew, and everything that reads the tree rather than the
 * renderer — the selection box, the Scale panel's W/H, the scale reference —
 * disagreed with the artwork: the W/H fields jumped the moment the tool opened,
 * and the outline sat somewhere the component was not.
 *
 * The recursion mirrors `syncTextSizing`'s: the flag describes the level's own
 * parent, so a plain frame nested in a stack still gets its children measured.
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
  return syncInstanceList(elements, false, resolve);
}

function syncInstanceList(
  elements: DesignElement[],
  insideLayout: boolean,
  resolve: ChildSizeResolver
): DesignElement[] {
  let changed = false;
  const next = elements.map((el) => {
    if (el.type === "instance") {
      if (insideLayout) return el;
      const box = resolve(el);
      if (!box || (box.width === el.width && box.height === el.height)) return el;
      changed = true;
      return { ...el, width: box.width, height: box.height };
    }
    if (isContainer(el) && el.children?.length) {
      const children = syncInstanceList(
        el.children,
        Boolean(layoutOf(el as AutoLayoutFields)),
        resolve
      );
      if (children !== el.children) {
        changed = true;
        return { ...el, children };
      }
    }
    return el;
  });
  return changed ? next : elements;
}
