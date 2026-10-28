import {
  ComponentElement,
  ComponentSetElement,
  DesignDocument,
  DesignElement,
  getActivePage,
  updateActivePageElements
} from "../dsl/types";
import {
  computeParentOrigin,
  findComponentSetNode,
  findParentById,
  isContainer
} from "../geometry/tree-ops";
import { createId } from "../id";
import { COMPONENT_SET_PADDING, fitComponentSet } from "../layout/component-set";
import { variantName } from "./variant-naming";

/**
 * Structural surgery on a `componentSet` node: creating it around masters that are
 * already on the canvas, and taking it away again.
 *
 * Split from `component-variants.ts` (AGENTS.md §9) along the seam between moving
 * NODES and setting a value on one. Everything here is about where a set sits and
 * what is inside it; nothing here decides which value a variant carries.
 *
 * All of it is absolute-coordinate work. Children are stored in their parent's
 * local space, so wrapping masters that are already placed means reading where they
 * are on the canvas, doing the arithmetic there, and subtracting the new node's
 * origin back out — the alternative (trusting the local numbers) puts a member at
 * the wrong place the moment the masters were not siblings to begin with.
 */

/**
 * What a set is given when it is created: the property table it declares, and each
 * member's own coordinates within it.
 *
 * Both halves are explicit because a set without them is not a set. `properties`
 * is Figma's `variantGroupProperties` and carries values no member uses yet, which
 * is what lets an instance dropdown offer a variant nobody has drawn. `coordinates`
 * is the same shape as Figma's `variantProperties`, one entry per member.
 */
export interface SetAssembly {
  /** Column order is the author's; the inspector's matrix follows it. */
  properties: Record<string, string[]>;
  coordinates: Record<string, Record<string, string>>;
  /** The set's name. Figma gives the set the main component's own name. */
  name?: string;
}

/** Canvas-absolute origin of `el`'s own box, within `elements`. */
function absoluteOrigin(elements: DesignElement[], el: DesignElement): { x: number; y: number } {
  const parent = findParentById(elements, el.id);
  const parentAbs = parent
    ? (() => {
        const o = computeParentOrigin(elements, parent.id);
        return { x: o.x + parent.x, y: o.y + parent.y };
      })()
    : { x: 0, y: 0 };
  return { x: el.x + parentAbs.x, y: el.y + parentAbs.y };
}

/**
 * Replaces `anchorId` with `insertions` and drops `droppedIds`, in one walk.
 *
 * `mapElements` can express neither half: its callback returns one element per
 * input, and both "three members scattered in different containers go away" and
 * "this node became two" break that. Returns the input array when nothing moved,
 * so an untouched subtree stays reference-equal for every memo above it.
 */
function spliceOut(
  list: DesignElement[],
  anchorId: string,
  insertions: DesignElement[],
  droppedIds: ReadonlySet<string>
): DesignElement[] {
  let changed = false;
  const out: DesignElement[] = [];
  for (const el of list) {
    if (droppedIds.has(el.id)) {
      changed = true;
      continue;
    }
    if (el.id === anchorId) {
      out.push(...insertions);
      changed = true;
      continue;
    }
    // The container guard is load-bearing twice: a leaf has no `children` to walk,
    // and recursing with `[]` would compare `[] !== undefined` and hand every leaf
    // in the document a `children: []` it never had.
    if (!isContainer(el)) {
      out.push(el);
      continue;
    }
    const children = spliceOut(el.children || [], anchorId, insertions, droppedIds);
    if (children !== el.children) {
      out.push({ ...el, children });
      changed = true;
    } else {
      out.push(el);
    }
  }
  return changed ? out : list;
}

/**
 * The set node `comp` belongs to, creating one around it when there isn't one.
 *
 * A lone component becomes a one-member set. The set grows around artwork that is
 * already placed, which is why this reads absolute coordinates.
 */
export function ensureComponentSet(
  doc: DesignDocument,
  comp: ComponentElement,
  assembly: SetAssembly
): { doc: DesignDocument; set: ComponentSetElement } | null {
  const existing = findComponentSetNode(getActivePage(doc).children, comp.setId);
  if (existing) return { doc, set: existing };

  return assembleComponentSet(doc, comp, [comp], {
    ...assembly,
    name: assembly.name ?? comp.name
  });
}

/**
 * Wraps `members` into a set node, in the tree position `anchor` already occupied.
 *
 * The set keeps the anchor's name unless the caller supplies one, because in
 * Figma the set is named after the main component it grew out of — `Button`
 * becomes a set called `Button`, not `Button copy` or a type name.
 */
export function assembleComponentSet(
  doc: DesignDocument,
  anchor: ComponentElement,
  members: ComponentElement[],
  assembly: SetAssembly
): { doc: DesignDocument; set: ComponentSetElement } | null {
  if (members.length === 0) return null;
  const elements = getActivePage(doc).children;
  const placed = members.map((m) => ({ ...m, abs: absoluteOrigin(elements, m) }));
  const originX = Math.min(...placed.map((p) => p.abs.x)) - COMPONENT_SET_PADDING;
  const originY = Math.min(...placed.map((p) => p.abs.y)) - COMPONENT_SET_PADDING;

  // Minted once and reused, never per child: the id is on the node AND on every
  // member, and two `createId` calls would produce a set whose children all name a
  // different set than the one holding them.
  const setId = createId("set");
  const set: ComponentSetElement = {
    id: setId,
    type: "componentSet",
    name: assembly.name ?? anchor.name,
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    variantGroupProperties: assembly.properties,
    children: placed.map(({ abs, ...m }) => {
      const variantProperties = assembly.coordinates[m.id] ?? {};
      return {
        ...m,
        x: abs.x - originX,
        y: abs.y - originY,
        setId,
        variantProperties,
        name: variantName(variantProperties, m.name ?? "")
      };
    })
  };

  const hostParent = findParentById(elements, anchor.id);
  const hostOrigin = hostParent ? absoluteOrigin(elements, hostParent) : { x: 0, y: 0 };
  const localSet = fitComponentSet({ ...set, x: originX - hostOrigin.x, y: originY - hostOrigin.y });
  const dropped = new Set(members.map((m) => m.id));
  dropped.delete(anchor.id);
  return {
    doc: {
      ...updateActivePageElements(doc, spliceOut(elements, anchor.id, [localSet], dropped)),
      updatedAt: new Date().toISOString()
    },
    set: localSet
  };
}

/**
 * Removes the set node and leaves its members as plain components, in its place.
 *
 * Ungrouping rather than ungrouping-and-still-a-set: a survivor that kept a
 * `setId` no node backs would still group in the assets panel, so pulling a set
 * apart would appear to do nothing. The coordinates go with the grouping — what is
 * left is a set of components that no longer claim to be variants of one another,
 * and `State=Hover` in a layer name with nothing to resolve it against is worse
 * than the name the member had before it joined.
 */
export function dissolveComponentSet(doc: DesignDocument, setId: string): DesignDocument | null {
  const elements = getActivePage(doc).children;
  const set = findComponentSetNode(elements, setId);
  if (!set) return null;

  const released = (set.children || []).map((child) => {
    const lone: ComponentElement = { ...(child as ComponentElement) };
    delete lone.setId;
    delete lone.variantProperties;
    // Straight to the set's own position: a child at `child.x` inside a set at
    // `set.x` is at `child.x + set.x` in the parent, which is the parent's space
    // these are released into.
    return { ...lone, x: child.x + set.x, y: child.y + set.y } as DesignElement;
  });

  return {
    ...updateActivePageElements(doc, spliceOut(elements, setId, released, new Set())),
    updatedAt: new Date().toISOString()
  };
}
