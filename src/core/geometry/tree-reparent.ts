import { ComponentElement, ContainerElement, DesignElement, ElementSizing, InstanceElement } from "../dsl/types";
import { applySizingDefaults } from "../dsl/sizing-defaults";
import { layoutOf, type FlatAutoLayout } from "../dsl/layout-flat";
import {
  collectDescendantIds,
  findComponentSetNode,
  findElementById,
  findParentById,
  isContainer
} from "./tree-query";
import { computeParentOrigin } from "./tree-coords";
import { mapElements } from "./tree-edit";

/** The main component `el` names, when `el` is an instance that names one. */
export function ownMasterId(el: DesignElement | null | undefined): string | null {
  if (!el || el.type !== "instance") return null;
  return (el as InstanceElement).componentId || null;
}

/**
 * True when `id` IS a main component (or a set of them) or sits anywhere inside
 * one. A master is a definition, and FISH resolves masters by id from anywhere in
 * the file, so a definition nested in another definition would be cloned into every
 * instance of the outer one as a second definition — an instance is the way to reuse
 * a component inside a component.
 *
 * A SET counts as a boundary, because a set's children are components: nesting a
 * set in a definition nests definitions, by the same argument one level down.
 *
 * The one exception is a variant landing back in its OWN set, which is its home
 * and not a nesting: `nestsComponentInComponent` is what lets a variant be
 * reordered among its siblings.
 */
export function insideComponent(elements: DesignElement[], id: string): boolean {
  let cur = findElementById(elements, id);
  while (cur) {
    if (cur.type === "component" || cur.type === "componentSet") return true;
    cur = findParentById(elements, cur.id);
  }
  return false;
}

/** Placing a main component under `parentId` would nest a definition in one. */
export function nestsComponentInComponent(
  elements: DesignElement[],
  sourceId: string,
  parentId: string | null | undefined
): boolean {
  if (!parentId) return false;
  const source = findElementById(elements, sourceId);
  if (!source) return false;
  if (source.type === "component" && parentId === (source as ComponentElement).setId) return false;
  const isDefinition = source.type === "component" || source.type === "componentSet";
  return isDefinition && insideComponent(elements, parentId);
}

const layoutModeOf = (container: ContainerElement | null | undefined): boolean => {
  const mode = container ? layoutOf(container as FlatAutoLayout)?.mode : undefined;
  return mode === "flex" || mode === "grid";
};

/**
 * A `sizing` default is a statement about the element's *situation*, and it is
 * stored rather than derived (`applySizingDefaults` explains why it has to be). A
 * reparent changes the situation without re-reading the file, so the stored default
 * survives where it no longer means anything — measured in the real editor on
 * 2026-10-09, wrong in both directions:
 *
 *  - INTO an Auto-Layout frame: the text kept the character-count width it was born
 *    with (`1078`) and sat straight across the 312-wide card it had been dropped
 *    into, because a parent's pass only measures an axis that resolves to
 *    fit-content.
 *  - OUT of one: the stored `fit-content` width was re-measured with no box to wrap
 *    to, so a two-line paragraph (312 × 38.63) came back as one 604.36 × 19.31 line
 *    — the text it was dropped as was not the text it was.
 *
 * So the two transitions are reconciled, and only those: a text that ENTERS a
 * layout parent gains the hug default, one that LEAVES has the hug dropped — the
 * resolved numbers stay, so the box it was dropped with is the box it keeps.
 *
 * Text only, on purpose. A container's hug is maintained by its OWN layout pass,
 * which keeps running wherever it sits, so a parent change means nothing to it —
 * pinning one would freeze a hug it should still have. A `fill` axis needs no help
 * either: `resolveAxisDetail` downgrades it where it cannot be honoured and the
 * Inspector reports that, so it comes back by dragging the element into a stack.
 */
export function reconcileSizingAfterReparent(
  elements: DesignElement[],
  movedId: string,
  /** The container it came from, captured BEFORE the move. */
  previousParent: ContainerElement | null
): DesignElement[] {
  const moved = findElementById(elements, movedId);
  if (!moved || moved.type !== "text") return elements;

  const nextParent = findParentById(elements, movedId);
  const enteredLayout = layoutModeOf(nextParent) && !layoutModeOf(previousParent);
  const leftLayout = layoutModeOf(previousParent) && !layoutModeOf(nextParent);
  if (!enteredLayout && !leftLayout) return elements;

  const sizing: ElementSizing = { ...(moved.sizing ?? {}) };

  if (enteredLayout) {
    // The same call normalize makes, with `authored*` left open: by the time a drop
    // happens the number on the element came out of a measurement, so nothing is
    // left that could tell an authored width from a measured one. A text inside a
    // stack therefore behaves the same whether it was authored there or dropped in.
    applySizingDefaults(sizing, {
      type: moved.type,
      ownLayout: undefined,
      parentLayout: nextParent ? layoutOf(nextParent as FlatAutoLayout) ?? null : null,
      authoredWidth: undefined,
      authoredHeight: undefined
    });
  } else {
    if (sizing.width === "fit-content") delete sizing.width;
    if (sizing.height === "fit-content") delete sizing.height;
  }

  const nextSizing = Object.keys(sizing).length > 0 ? sizing : undefined;
  return mapElements(elements, (el) =>
    el.id === movedId ? ({ ...el, sizing: nextSizing } as DesignElement) : el
  );
}

/**
 * Carries `x` / `y` across a reparent, so a layer the tree moves stays where it
 * PAINTS.
 *
 * `x` is parent-LOCAL: the tree is asked "which list are you in" and the canvas
 * reads a number written against the parent that was there when it was written.
 * A move that changes the parent therefore moves the layer although nobody
 * touched a coordinate — and the layer panel's drop was the one path doing
 * exactly that, so a row dragged from one frame into another jumped by the
 * difference between the two frames' origins. The canvas drop has always
 * converted (`reparentOnCanvasDrop`), and this is the same conversion.
 *
 * `originsBefore` holds `computeParentOrigin` for each moved id as read from the
 * tree BEFORE the move — the only moment it can be read, because afterwards
 * nothing remembers which space the numbers belong to.
 *
 * A destination whose own flow places the child (a flex/grid parent holding an
 * in-flow child, `inFlowChildren` in auto-layout.ts) gets the result overwritten
 * by the relayout in the same commit; every other destination reads it verbatim
 * — a free frame, the page, and the two kinds a flow holds back
 * (`position: "absolute"`, `visible: false`).
 *
 * Translation only, matching `computeParentOrigin` and every other write path.
 */
export function preserveCanvasPositionsAfterReparent(
  elements: DesignElement[],
  originsBefore: Map<string, { x: number; y: number }>
): DesignElement[] {
  if (originsBefore.size === 0) return elements;
  return mapElements(elements, (el) => {
    const before = originsBefore.get(el.id);
    if (!before) return el;
    const after = computeParentOrigin(elements, el.id);
    const dx = before.x - after.x;
    const dy = before.y - after.y;
    if (dx === 0 && dy === 0) return el;
    return { ...el, x: el.x + dx, y: el.y + dy } as DesignElement;
  });
}

/** Why the tree refused a reparent. Named here because the tree decides it. */
export type ReparentRefusal =  | "instance-in-own-master"
  | "component-in-component"
  | "variant-out-of-set";

/**
 * True when placing `sourceId` under `parentId` would put an instance inside the
 * subtree of its own main component.
 *
 * An instance is a projection of its master, so a master that contains one of
 * itself can never finish resolving (`resolveInstanceChildren` would clone the
 * master forever). Both reparent paths run this — `moveElementInTree` for the
 * layer tree, `reparentOnCanvasDrop` for the canvas — and any depth counts: a
 * clone buried in the master is exactly as unresolvable as a direct child. The
 * master is matched by id alone, so it does not have to sit on this page.
 */
export function nestsInstanceInOwnMaster(
  elements: DesignElement[],
  sourceId: string,
  parentId: string | null | undefined
): boolean {
  if (!parentId) return false;
  const masterId = ownMasterId(findElementById(elements, sourceId));
  if (!masterId) return false;
  let cur = findElementById(elements, parentId);
  while (cur) {
    if (cur.id === masterId) return true;
    cur = findParentById(elements, cur.id);
  }
  return false;
}

/**
 * Whether a drop would put `sourceId` somewhere a `componentSet` does not allow.
 *
 * A set holds the members of ONE set and nothing else, so three things follow and
 * none of them is expressible as a "no reparent into components" rule:
 *
 *  - a variant's landing parent has to be the very set it belongs to. Any other
 *    parent would leave it grouped under a set it is no longer inside, and
 *    reordering within its own set is unaffected — `moveElementInTree` resolves
 *    before/after to the target's parent, so a reorder lands on the same id.
 *  - a component carrying no `setId` may not be dropped into a set either.
 *    Becoming a variant is what `makeVariant` is for, and a drag that did it
 *    silently would have no way to name the new axis value.
 *  - nothing that is not a component goes into a set at all. A frame parked there
 *    is never cloned into an instance, so it is scenery inside a definition.
 */
export function escapesItsVariantSet(
  elements: DesignElement[],
  sourceId: string,
  parentId: string | null | undefined
): boolean {
  const source = findElementById(elements, sourceId);
  if (!source) return false;
  const set = findComponentSetNode(elements, parentId);
  if (set) return source.type !== "component" || source.setId !== set.id;
  if (source.type !== "component" || !source.setId) return false;
  return parentId !== source.setId;
}

/** The refusal a drop under `parentId` earns, or null when it is allowed. */
export function reparentRefusal(
  elements: DesignElement[],
  sourceId: string,
  parentId: string | null | undefined
): ReparentRefusal | null {
  if (nestsInstanceInOwnMaster(elements, sourceId, parentId)) return "instance-in-own-master";
  if (nestsComponentInComponent(elements, sourceId, parentId)) return "component-in-component";
  if (escapesItsVariantSet(elements, sourceId, parentId)) return "variant-out-of-set";
  return null;
}

/**
 * Removes every id in `ids` from anywhere in the tree and collects them into
 * `taken`, in DOCUMENT order.
 *
 * Document order, not the order they were asked for: a multi-selection is built
 * by clicking, and the tree is the only thing that knows where those rows sit
 * relative to one another — a block has to land in the order it was stored in.
 *
 * A list nothing was taken from is handed back by reference, so a drop that
 * moves nothing leaves structural sharing — and the caller's identity checks —
 * intact.
 */
function takeElementsFromTree(
  elements: DesignElement[],
  ids: Set<string>,
  taken: DesignElement[]
): DesignElement[] {
  let changed = false;

  const walk = (list: DesignElement[]): DesignElement[] => {
    const out: DesignElement[] = [];
    for (const el of list) {
      if (ids.has(el.id)) {
        changed = true;
        taken.push(el);
        continue;
      }
      if (isContainer(el) && el.children) {
        const children = walk(el.children);
        if (children !== el.children) out.push({ ...el, children });
        else out.push(el);
      } else {
        out.push(el);
      }
    }
    return out;
  };

  const next = walk(elements);
  return changed ? next : elements;
}

/**
 * Moves elements `sourceIds` as ONE block before/after `targetId` or inside the
 * `targetId` container, keeping their relative order.
 *
 * The block is what makes a multi-selection drag one move rather than one move
 * per row: the rows that travel together leave their lists first, so the
 * destination is resolved on a list they are no longer in — the same "index
 * among the siblings that stay" arithmetic the canvas drop slot does.
 */
export function moveElementsInTree(
  elements: DesignElement[],
  sourceIds: string[],
  targetId: string,
  position: "before" | "after" | "inside"
): DesignElement[] {
  const wanted = new Set(sourceIds);
  // A row that travels with the block is not a place to drop the block: the drop
  // would be reading a position the block is about to vacate.
  if (wanted.has(targetId)) return elements;

  const moving: DesignElement[] = [];
  const withoutSources = takeElementsFromTree(elements, wanted, moving);
  if (moving.length === 0) return elements;

  // Prevent dragging an ancestor into its own descendant — and, for a block, into
  // the subtree of any member that travels with it.
  for (const el of moving) {
    if (collectDescendantIds(el).includes(targetId)) return elements;
  }

  // Where the block would land: `inside` is the target itself, `before`/`after`
  // join the target's parent — both can be (or sit under) a member's master, and
  // one member's refusal has to refuse the whole move rather than leave the rest
  // of the selection behind.
  const landingParentId =
    position === "inside" ? targetId : findParentById(elements, targetId)?.id ?? null;
  for (const el of moving) {
    if (reparentRefusal(elements, el.id, landingParentId)) return elements;
  }

  const insert = (list: DesignElement[]): DesignElement[] => {
    const out: DesignElement[] = [];
    for (const el of list) {
      if (el.id === targetId) {
        if (position === "before") {
          out.push(...moving, el);
          continue;
        }
        if (position === "after") {
          out.push(el, ...moving);
          continue;
        }
        if (position === "inside" && isContainer(el)) {
          out.push({
            ...el,
            children: [...(el.children || []), ...moving]
          });
          continue;
        }
        out.push(el);
        continue;
      }
      if (isContainer(el) && el.children) {
        out.push({ ...el, children: insert(el.children) });
      } else {
        out.push(el);
      }
    }
    return out;
  };

  return insert(withoutSources);
}

/**
 * Moves element `sourceId` before/after `targetId` or inside `targetId` container.
 */
export function moveElementInTree(
  elements: DesignElement[],
  sourceId: string,
  targetId: string,
  position: "before" | "after" | "inside"
): DesignElement[] {
  return moveElementsInTree(elements, [sourceId], targetId, position);
}
