import { ComponentSetElement, ContainerElement, DesignDocument, DesignElement, getActivePage } from "../dsl/types";

export function isContainer(el: DesignElement): el is ContainerElement {
  return el.type === "frame" || el.type === "component" || el.type === "componentSet";
}

/** The set node `id` names, when it names one that is actually a set. */
export function findComponentSetNode(
  elements: DesignElement[],
  id: string | undefined | null
): ComponentSetElement | null {
  if (!id) return null;
  const found = findElementById(elements, id);
  return found && found.type === "componentSet" ? (found as ComponentSetElement) : null;
}

export function childrenOf(el: DesignElement): DesignElement[] {
  return isContainer(el) ? el.children || [] : [];
}

/**
 * One id → element and id → parent index per tree, built on first use.
 *
 * Both lookups are recursive scans, and the callers ask repeatedly about one
 * tree: a hover resolves the element under the pointer and then walks its parent
 * chain, a drop asks for the parent of every candidate, the layer panel resolves
 * rows. Five to ten full walks per event over a 1,841-element page is what this
 * replaces with one — keyed on the array identity, the same structural-sharing
 * invariant `flattenElements` and the origin maps already rely on.
 *
 * First match wins in pre-order, which is what the recursive scans returned for
 * a duplicated id.
 */
interface TreeIndex {
  byId: Map<string, DesignElement>;
  parentById: Map<string, ContainerElement>;
}

const indexCache = new WeakMap<DesignElement[], TreeIndex>();
/**
 * Trees that have been asked about once, and get an index on the next question.
 *
 * Building the index is one full walk (0.17 ms on 1,841 elements) while a single
 * lookup that hits early costs a fraction of that — so a drag frame, which
 * replaces the page array and then resolves one element, must not pay to index a
 * tree it asks about twice. A pointer moving over a page asks many times about
 * one tree, and that is the case the index is for.
 */
const asked = new WeakSet<DesignElement[]>();

function indexOf(elements: DesignElement[]): TreeIndex | null {
  const cached = indexCache.get(elements);
  if (cached) return cached;
  if (!asked.has(elements)) {
    asked.add(elements);
    return null;
  }
  const byId = new Map<string, DesignElement>();
  const parentById = new Map<string, ContainerElement>();
  const walk = (list: DesignElement[], parent: ContainerElement | null) => {
    for (const el of list) {
      if (!byId.has(el.id)) byId.set(el.id, el);
      if (parent && !parentById.has(el.id)) parentById.set(el.id, parent);
      if (isContainer(el)) walk(el.children || [], el);
    }
  };
  walk(elements, null);
  const index = { byId, parentById };
  indexCache.set(elements, index);
  return index;
}

function scanById(elements: DesignElement[], id: string): DesignElement | null {
  for (const el of elements) {
    if (el.id === id) return el;
    const found = scanById(childrenOf(el), id);
    if (found) return found;
  }
  return null;
}

function scanParentById(elements: DesignElement[], id: string): ContainerElement | null {
  for (const el of elements) {
    if (!isContainer(el)) continue;
    if ((el.children || []).some((child) => child.id === id)) return el;
    const found = scanParentById(el.children || [], id);
    if (found) return found;
  }
  return null;
}

export function findElementById(elements: DesignElement[], id: string): DesignElement | null {
  return indexOf(elements)?.byId.get(id) ?? scanById(elements, id);
}

export function findParentById(elements: DesignElement[], id: string): ContainerElement | null {
  return indexOf(elements)?.parentById.get(id) ?? scanParentById(elements, id);
}

export function collectDescendantIds(element: DesignElement): string[] {
  const ids: string[] = [];
  const walk = (children: DesignElement[]) => {
    for (const child of children) {
      ids.push(child.id);
      walk(childrenOf(child));
    }
  };
  walk(childrenOf(element));
  return ids;
}

/**
 * The container whose children are the selection's siblings — null when the page
 * root is the level to speak of.
 *
 * A SINGLE stored parent is required. A selection spanning two parents, or one
 * made of clones an instance projects (which store no parent at all), has no one
 * level behind it, and the page root is the level that always exists.
 *
 * An empty selection lands here too, and that is the intent: nothing selected
 * means the level you are looking at is the page.
 */
function siblingScope(
  elements: DesignElement[],
  selectedIds: Set<string>
): ContainerElement | null {
  let scope: ContainerElement | null = null;
  for (const id of selectedIds) {
    const parent = findParentById(elements, id);
    if (!parent) return null;
    if (scope && scope.id !== parent.id) return null;
    scope = parent;
  }
  return scope;
}

/**
 * The layers ⌘A takes: the selection's own level — its siblings — and the page
 * roots when there is no level to descend from.
 *
 * Minus the two kinds a click can never land on: a hidden layer, and a locked
 * one, which is transparent to the pointer by design. Putting either in the
 * selection would select something the user cannot see and cannot move. A hidden
 * scope says the same thing one level up: it paints neither itself nor its
 * children, so the level it would have offered is not on screen at all.
 */
export function selectableSiblingIds(elements: DesignElement[], selectedIds: Set<string>): string[] {
  const scope = siblingScope(elements, selectedIds);
  if (scope?.visible === false) return [];
  const level = scope ? scope.children ?? [] : elements;
  return level.filter((el) => el.visible !== false && !el.locked).map((el) => el.id);
}

export function countElements(doc: DesignDocument): number {
  const walk = (els: DesignElement[] | undefined): number =>
    (els ?? []).reduce(
      (sum, el) => sum + 1 + walk((el as { children?: DesignElement[] }).children),
      0
    );
  return walk(getActivePage(doc).children);
}
