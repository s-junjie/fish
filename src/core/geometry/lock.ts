import type { ContainerElement, DesignElement } from "../dsl/types";
import { flattenElements, isContainer } from "./tree-ops";

/**
 * Lock semantics, materialized onto the subtree.
 *
 * Not a straight port of Figma: Figma holds that "it's not possible to unlock
 * child layers without unlocking the parent", and this lets one child of a
 * locked frame be unlocked on its own. That is the divergence a mixed subtree
 * comes from, and the canvas still paints such a child untouchable.
 *
 * Locking writes `locked: true` onto the element *and every descendant*, so the
 * plain `el.locked` checks that already exist across hit-testing, the renderer
 * and the canvas gestures stay correct without threading ancestor state through
 * each of them. Unlocking clears the flag from the subtree and drops the key
 * instead of storing `false`, so documents never carry dead flags.
 *
 * Materialization is a snapshot of the moment the lock was toggled, so it does
 * not follow a parent change — but no parent change can strand it either. A
 * locked row is not draggable (`LayerRow`), and dropping *into* a locked
 * container is refused by the layer panel (`layer-reorder`). That pair is what
 * keeps the flag honest, and a new way to move a layer has to answer both.
 *
 * The tempting fix — reconcile the flag against the new parent on every move —
 * cannot work without knowing which layers were locked on purpose, and gets
 * that wrong in the one case it would actually run: moving an unlocked frame
 * whose child was locked deliberately, which would clear the child's lock.
 *
 * What a lock forbids is *canvas* movement and structural edits (select, drag,
 * resize, rotate, delete, restack, reparent, align). It does NOT make the layer
 * opaque to the pointer: a locked layer is transparent, so a click passes
 * through it to whatever is painted behind — the Figma contract, and the reason
 * a lock does not strand the layers it covers. The transparency is enforced in
 * the DOM (`[data-locked]` in style.css), not here and not in the mousedown
 * handler, because the browser hit-tests the real painted geometry. The
 * consequence to keep in mind: a press that passes through and finds nothing
 * behind the lock reaches the canvas container as an ordinary click, so the
 * marquee must require a real drag distance before it selects (LESSONS §75). A
 * locked layer stays selectable in the Layers Panel and its inspector
 * properties stay editable, which is the Figma contract: lock protects against
 * accidental edits, it does not make the layer read-only.
 */

export function isLocked(el: DesignElement | null | undefined): boolean {
  return el?.locked === true;
}

/** Same element without the lock key — the same reference when there is none. */
function withoutLock<T extends DesignElement>(el: T): T {
  if (el.locked === undefined) return el;
  const copy: Record<string, unknown> = { ...el };
  delete copy.locked;
  return copy as unknown as T;
}

/** `el` with the lock state applied to itself and every descendant it owns. */
export function withLockDeep<T extends DesignElement>(el: T, locked: boolean): T {
  const next = (locked ? { ...el, locked: true } : withoutLock(el)) as T;
  if (!isContainer(next)) return next;
  const children = (next as ContainerElement).children;
  if (!children || children.length === 0) return next;
  return { ...next, children: children.map((child) => withLockDeep(child, locked)) } as T;
}

/** Locks or unlocks one element (with its subtree) in place in the tree. */
export function setElementLocked(
  elements: DesignElement[],
  id: string,
  locked: boolean
): DesignElement[] {
  const walk = (list: DesignElement[]): DesignElement[] => {
    let changed = false;
    const out = list.map((el) => {
      if (el.id === id) {
        const next = withLockDeep(el, locked);
        if (next !== el) changed = true;
        return next;
      }
      if (!isContainer(el)) return el;
      const children = (el as ContainerElement).children;
      if (!children || children.length === 0) return el;
      const nextChildren = walk(children);
      if (nextChildren === children) return el;
      changed = true;
      return { ...el, children: nextChildren } as DesignElement;
    });
    return changed ? out : list;
  };
  return walk(elements);
}

/** Locks or unlocks a whole selection as one document edit. */
export function setElementsLocked(
  elements: DesignElement[],
  ids: Set<string>,
  locked: boolean
): DesignElement[] {
  let next = elements;
  for (const id of ids) next = setElementLocked(next, id, locked);
  return next;
}

/**
 * The subset of `ids` the canvas may move or restructure: everything except the
 * elements that are actually locked. Every selection-driven gesture and command
 * filters through this, because a locked layer can still be selected from the
 * Layers Panel and would otherwise travel along with its unlocked siblings.
 *
 * Ids with no element behind them are kept, not dropped: a selected node inside
 * an instance is a resolved clone that is painted but never stored, and it is
 * still draggable through its override path.
 */
export function editableIds(elements: DesignElement[], ids: Set<string>): Set<string> {
  const out = new Set(ids);
  if (ids.size === 0) return out;
  for (const el of flattenElements(elements)) {
    if (ids.has(el.id) && isLocked(el)) out.delete(el.id);
  }
  return out;
}
