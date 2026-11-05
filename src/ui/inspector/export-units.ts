import type { DesignDocument, DesignElement } from "../../core/dsl/types";
import { childrenOf } from "../../core/geometry/tree-ops";
import { ancestorChain } from "../../core/interactions/component-swap";

/**
 * The pictures one Export press produces.
 *
 * A selection is a set of layers, not a region: two frames are two images, and
 * cropping them together put whatever sits between them into the file. Each unit
 * is a TOP-MOST selected layer — a child selected alongside its parent is part of
 * the parent's picture, not a picture of its own.
 */
export function exportUnits(doc: DesignDocument, selected: readonly DesignElement[]): DesignElement[] {
  const ids = new Set(selected.map((el) => el.id));
  return selected.filter((el) => !ancestorChain(doc, el.id).slice(0, -1).some((parent) => ids.has(parent.id)));
}

/**
 * Every layer the canvas can have painted, in paint order.
 *
 * `flattenElements` walks hidden subtrees too, and a hidden layer is absent from
 * the SVG by construction — so a question of the form "is this layer on the
 * canvas?" must not be asked about one. Counting them made a page with a single
 * hidden section report a canvas that was missing something, and an export the
 * live DOM could have served whole rebuilt the entire tree in a mirror.
 *
 * The whole hidden SUBTREE is skipped, not just the node: children of a hidden
 * frame are as absent as the frame.
 */
export function paintedElements(
  elements: readonly DesignElement[],
  out: DesignElement[] = []
): DesignElement[] {
  for (const el of elements) {
    if (el.visible === false) continue;
    out.push(el);
    paintedElements(childrenOf(el), out);
  }
  return out;
}

/**
 * One filename stem per unit, in selection order.
 *
 * Two layers can share a name, and two downloads with the same name leave the
 * user one file — so a repeat is numbered. The comparison is case-insensitive
 * because the folder it lands in usually is.
 */
export function exportNames(units: readonly DesignElement[]): string[] {
  const taken = new Map<string, number>();
  return units.map((el) => {
    const base = (el.name || el.type || "layer").replace(/[\\/:*?"<>|]/g, "_").trim() || "layer";
    const key = base.toLowerCase();
    const seen = (taken.get(key) ?? 0) + 1;
    taken.set(key, seen);
    return seen === 1 ? base : `${base}-${seen}`;
  });
}
