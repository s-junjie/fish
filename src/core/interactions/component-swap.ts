import {
  ComponentElement,
  ComponentOverride,
  DesignDocument,
  DesignElement,
  InstanceElement,
  getActivePage,
  updateActivePageElements
} from "../dsl/types";
import {
  childrenOf,
  computeParentOrigin,
  computeParentWorldMatrix,
  findElementById,
  findParentById,
  flattenElements,
  isContainer,
  mapElements
} from "../geometry/tree-ops";
import { identityMatrix, multiply, translation, type Matrix2D } from "../geometry/matrix";
import { instanceScaleOf } from "../geometry/scale-geometry";

const round2 = (n: number): number => Math.round(n * 100) / 100;
import { elementPivot, elementTransformMatrix } from "../geometry/transforms";
import { deepEqual } from "../deep-equal";
import { collectComponents, findMasterComponent, findVariantMember, groupComponentSets, isDerivedNode, propertyValue, type ComponentEntry } from "./component-inventory";
import { commitInstanceOverrides, resolveInstanceChildren, resolveInstanceSelection } from "./instance-resolve";

/**
 * Re-pointing an instance at another component: which components a swap may pick,
 * and what happens to the instance's overrides when it does.
 *
 * Split out of `component-ops.ts` (which had crossed the §9 ceiling) because it is
 * a coherent seam with one direction of dependency: this module READS the
 * component model — masters, resolution, the component graph around a node — and
 * `component-ops` never reads back. The graph queries are here rather than in the
 * UI because the panels and the write path both have to agree about them: a
 * candidate the tree refuses must not look acceptable in a dropdown.
 */

// --- what a node IS, resolved ------------------------------------------------

/**
 * The steps under any element: its stored children, or — for an instance, which
 * stores none — the resolved clone. One resolver for the renderer, the layer
 * tree and the swap guards, so they can never disagree about what is inside.
 */
export function resolvedChildren(doc: DesignDocument | null | undefined, el: DesignElement): DesignElement[] {
  const own = childrenOf(el);
  if (own.length > 0 || el.type !== "instance" || !doc) return own;
  const instance = el as InstanceElement;
  const master = findMasterComponent(doc, instance.componentId);
  return master ? resolveInstanceChildren(instance, master) : [];
}

/**
 * A stored node is found by id; a resolved clone is not in the tree at all, so it
 * is looked up through the instance that projects it.
 */
export function findNodeById(doc: DesignDocument, id: string): DesignElement | null {
  const stored = findElementById(getActivePage(doc).children, id);
  if (stored) return stored;
  return resolveInstanceSelection(doc, id)?.node ?? null;
}

/**
 * The canvas origin a node's own `x`/`y` are relative to — what its parent
 * contributes.
 *
 * For a stored node that is the parent chain in the tree. For a resolved clone
 * the chain lives in the resolution instead, and every step from the instance
 * down adds its own offset: a node inside a nested instance, or inside a frame
 * inside the master, sits at the sum of them. `computeParentOrigin` only sees
 * the outermost instance, which drew the selection box for such a node one or
 * more levels short of where it is painted.
 */
export function worldOriginOf(doc: DesignDocument, el: DesignElement): { x: number; y: number } {
  const elements = getActivePage(doc).children;
  if (findElementById(elements, el.id)) return computeParentOrigin(elements, el.id);
  const route = resolvedRoute(doc, el.id);
  if (!route) return { x: 0, y: 0 };
  const base = computeParentOrigin(elements, route[0].id);
  let x = base.x + route[0].x;
  let y = base.y + route[0].y;
  // The last step is the node itself; its own offset belongs to the caller.
  for (let i = 1; i < route.length - 1; i++) {
    x += route[i].x;
    y += route[i].y;
  }
  return { x, y };
}

/**
 * The matrix carrying `el` into canvas space, ancestors' turns and its own.
 *
 * Put on a `<g>` that then draws the element at the coordinates the element
 * ALREADY stores — `x`, `y`, `width`, `height` — this reproduces exactly what
 * `SvgNodeRenderer` paints, because it composes in the same order:
 *
 *     ancestors… → this node's own turn about its own pivot
 *
 * The node's own `x` / `y` shift is deliberately NOT baked in. The renderer
 * emits children inside `translate(x, y)` and the overlay's rect already sits at
 * `(x, y)`, so folding the shift into the matrix as well would apply it twice.
 * Leaving it out is also what keeps an unrotated top-level layer's transform the
 * IDENTITY, and an identity renders as no `transform` attribute at all — the
 * canvas's memo comparator is a byte-level whitelist, so spelling the identity
 * out would dirty the markup of every layer on the page.
 *
 * `worldOriginOf` is the translation-only answer and is right for a caller that
 * wants to know where a child's `x` sits before WRITING one back. This is the
 * other question — "where is this box, turned and all" — and the two disagree
 * the moment any ancestor has a `rotation`, because the renderer draws children
 * inside the frame's turned group rather than beside it.
 *
 * The resolved-clone branch mirrors `worldOriginOf`'s, step for step: the
 * instance is a stored node the tree map can place, and every step below it is
 * a clone whose own turn and shift compose inside the one above.
 */
export function worldMatrixOf(doc: DesignDocument, el: DesignElement): Matrix2D {
  const elements = getActivePage(doc).children;
  const own = () => {
    const pivot = elementPivot(el);
    return elementTransformMatrix(el, pivot.x, pivot.y);
  };

  if (findElementById(elements, el.id)) {
    return multiply(computeParentWorldMatrix(elements, el.id), own());
  }

  const route = resolvedRoute(doc, el.id);
  if (!route) return identityMatrix();

  let m = multiply(computeParentWorldMatrix(elements, route[0].id), stepMatrix(route[0]));
  // The last step is the node itself; its own turn belongs to the caller.
  for (let i = 1; i < route.length - 1; i++) {
    m = multiply(m, stepMatrix(route[i]));
  }
  return multiply(m, own());
}

/**
 * The matrix carrying a node's own GEOMETRY coordinates — the space a shape's
 * `d`, and therefore a path's anchors and control points, are written in — into
 * canvas space.
 *
 * `worldMatrixOf` deliberately stops one step short: it places the node's BOX,
 * so a caller that already draws at `(el.x, el.y)` must not shift twice. But a
 * path's anchors are not drawn at that box, they are stored relative to it, so
 * every reader that has to agree with the artwork needs the shift composed IN.
 *
 * The shift goes on the RIGHT, matching the renderer: it emits `translate(x, y)`
 * INSIDE the node's turned group, so the turn is applied about a pivot in the
 * parent's frame and the geometry rides inside it.
 */
export function worldShapeMatrixOf(doc: DesignDocument, el: DesignElement): Matrix2D {
  return multiply(worldMatrixOf(doc, el), translation(el.x, el.y));
}

/**
 * One step of a resolved route: the node's own turn, then the shift that places
 * it inside its parent — the two the renderer nests, in the order it nests them.
 */
function stepMatrix(el: DesignElement): Matrix2D {
  const pivot = elementPivot(el);
  return multiply(elementTransformMatrix(el, pivot.x, pivot.y), translation(el.x, el.y));
}

/**
 * The instance a painted node belongs to: its own `__instanceId`, or — when that
 * id is itself a resolved clone — the outermost instance projecting it.
 *
 * The second half is what an instance inside an instance needs. Its children
 * carry the INNER instance as owner, and that id is absent from the document
 * tree, so a lookup by id finds nothing and a click falls all the way through
 * to the innermost painted shape instead of the instance the user sees.
 */
export function owningInstanceId(
  doc: DesignDocument,
  el: DesignElement
): string | null {
  const own = (el as { __instanceId?: string }).__instanceId;
  if (!own) return null;
  if (findElementById(getActivePage(doc).children, own)) return own;
  return resolveInstanceSelection(doc, el.id)?.instanceId ?? null;
}

/** The route from the outermost owning instance down to `id`, for clones only. */
export function resolvedRoute(doc: DesignDocument, id: string): DesignElement[] | null {
  const owner = resolveInstanceSelection(doc, id);
  if (!owner) return null;
  const deeper = rowRoute(doc, resolvedChildren(doc, owner.instance), id);
  return deeper ? [owner.instance, ...deeper] : null;
}

function rowRoute(doc: DesignDocument, rows: DesignElement[], id: string): DesignElement[] | null {
  for (const row of rows) {
    if (row.id === id) return [row];
    const deeper = rowRoute(doc, resolvedChildren(doc, row), id);
    if (deeper) return [row, ...deeper];
  }
  return null;
}

/**
 * The chain the active page's root down to `id`, both ends included — every
 * ancestor, in order.
 *
 * Two trees have to be walked, because a selected node may live in either of
 * them: a stored node is reached through the document tree, while a resolved
 * clone exists only inside the instance that projects it, so its ancestors
 * above the instance come from the tree and every step below comes from the
 * resolution. `findParentById` alone therefore cannot reach a clone at all,
 * and `resolvedRoute` alone would start at the instance and lose every frame
 * above it.
 */
export function ancestorChain(doc: DesignDocument, id: string): DesignElement[] {
  const elements = getActivePage(doc).children;
  if (findElementById(elements, id)) return ancestorsUp(elements, id);
  const route = resolvedRoute(doc, id);
  if (!route || route.length === 0) return [];
  // `route[0]` is the outermost instance, which IS stored, so it is where the
  // two halves meet: the steps below it come from the route, the ones above it
  // from the tree.
  const above = findParentById(elements, route[0].id);
  return [...(above ? ancestorsUp(elements, above.id) : []), ...route];
}

/** Root-first list ending at `id`, built by walking parents up from `id`. */
function ancestorsUp(elements: DesignElement[], id: string): DesignElement[] {
  const chain: DesignElement[] = [];
  let node = id ? findElementById(elements, id) : null;
  while (node) {
    chain.unshift(node);
    node = findParentById(elements, node.id);
  }
  return chain;
}

/**
 * Every component that transitively CONTAINS `nodeId`: the masters its
 * resolution passes through, plus the real component ancestors it sits under.
 *
 * Re-pointing an instance at one of these would put that instance inside its own
 * resolution — `resolveInstanceChildren` would clone forever. The outermost
 * instance's master counts even though the node is not stored in it: the clone
 * the user is looking at lives inside that master's projection.
 */
export function componentAncestors(doc: DesignDocument, nodeId: string): Set<string> {
  const out = new Set<string>();
  const route = resolvedRoute(doc, nodeId);

  let head: DesignElement | null;
  if (route) {
    // Every step except the node itself: each is an instance whose master holds
    // the node one level down (the node's own master is the "swap to itself" case,
    // which `swapRefusal` names separately).
    for (const step of route.slice(0, -1)) {
      if (step.type === "instance") out.add((step as InstanceElement).componentId);
    }
    head = route[0];
  } else {
    head = findElementById(getActivePage(doc).children, nodeId);
  }

  let parent = head ? findParentById(getActivePage(doc).children, head.id) : null;
  while (parent) {
    if (parent.type === "component") out.add(parent.id);
    parent = findParentById(getActivePage(doc).children, parent.id);
  }
  return out;
}

/**
 * Every component reachable from `nodeId`'s own resolution — what the instance
 * shows, directly or through nested instances. Resolved rather than read off the
 * master's tree, so an override that re-points a nested instance is already
 * reflected (the clone carries the effective `componentId`).
 */
export function componentDescendants(doc: DesignDocument, nodeId: string): Set<string> {
  const out = new Set<string>();
  const node = findNodeById(doc, nodeId);
  if (!node || node.type !== "instance") return out;

  const walk = (children: DesignElement[]) => {
    for (const child of children) {
      if (child.type === "instance") {
        const cid = (child as InstanceElement).componentId;
        if (!cid || out.has(cid)) continue;
        out.add(cid);
        const master = findMasterComponent(doc, cid);
        if (master) walk(resolveInstanceChildren(child as InstanceElement, master));
        continue;
      }
      if (isContainer(child)) walk(childrenOf(child));
    }
  };

  const master = findMasterComponent(doc, (node as InstanceElement).componentId);
  if (master) walk(resolveInstanceChildren(node as InstanceElement, master));
  return out;
}

/** Why a component cannot be the target of a swap. */
export type SwapRefusal =
  /** The instance already projects it: nothing to do. */
  | "same-component"
  /** It contains this instance — the swap would make the instance its own ancestor. */
  | "contains-instance"
  /** The instance already shows it: the swap would make it its own descendant. */
  | "inside-instance";

/**
 * The single swap guard, shared by the instance's own swap control and the nested
 * one. It lives here rather than in the two panels so a candidate the tree would
 * refuse can never look acceptable in one of them.
 */
export function swapRefusal(
  doc: DesignDocument,
  nodeId: string,
  candidateId: string
): SwapRefusal | null {
  const node = findNodeById(doc, nodeId);
  if (!node || node.type !== "instance") return null;
  if (candidateId === (node as InstanceElement).componentId) return "same-component";
  if (componentAncestors(doc, nodeId).has(candidateId)) return "contains-instance";
  if (componentDescendants(doc, nodeId).has(candidateId)) return "inside-instance";
  return null;
}

// --- moving an instance to another master ------------------------------------

/**
 * Re-points overrides at another master.
 *
 * Identity has to be the LAYER NAME, not the node id: each variant is its own
 * component, so the child ids of one variant never appear in another and an
 * id-based filter drops every override the moment the user switches variant.
 *
 * Figma's second rule comes along with it: a change survives a swap only when
 * both masters STARTED from the same value for that property. Without that check,
 * swapping to a variant whose layer already differs silently applies a change the
 * user made against a completely different base.
 */
function remapOverridesByName(
  overrides: ComponentOverride[],
  previous: ComponentElement,
  next: ComponentElement
): ComponentOverride[] {
  const byName = new Map<string, DesignElement>();
  for (const el of flattenElements(next.children || [])) {
    if (el.name && !byName.has(el.name)) byName.set(el.name, el);
  }

  const out: ComponentOverride[] = [];
  for (const ov of overrides) {
    const oldNode = findElementById(previous.children || [], ov.targetId);
    if (!oldNode) continue;
    const nextNode = oldNode.name ? byName.get(oldNode.name) : undefined;
    if (!nextNode) continue;
    if (!deepEqual(propertyValue(oldNode, ov.property), propertyValue(nextNode, ov.property))) continue;
    out.push({ ...ov, targetId: nextNode.id });
  }
  return out;
}

/**
 * Points an instance at another component. Overrides are re-pointed by layer
 * name against the new master, and survive only when that layer's property had
 * the same value in both masters — see `remapOverridesByName`.
 */
export function swapInstanceComponent(
  doc: DesignDocument,
  instanceId: string,
  nextComponentId: string
): DesignDocument | null {
  const page = getActivePage(doc);
  const target = findElementById(page.children, instanceId);
  if (!target || target.type !== "instance") return null;
  if (swapRefusal(doc, instanceId, nextComponentId)) return null;
  const master = findMasterComponent(doc, nextComponentId);
  if (!master) return null;

  const inst = target as InstanceElement;
  const previous = findMasterComponent(doc, inst.componentId);
  const overrides = previous
    ? remapOverridesByName(inst.overrides || [], previous, master)
    : (inst.overrides || []).filter((o) =>
        flattenElements(master.children || []).some((el) => el.id === o.targetId)
      );

  // A hand-set box stays the user's: `sizeOverride` is the flag that says so.
  // Without it the instance was TRACKING its master, so it has to start tracking
  // the new one — `propagateMasterSize` only fires when the master itself is
  // resized, and would never come back for a master it was already resized past.
  // A scaled instance tracks THROUGH its factor: the new master's box is a 1x
  // number, and copying it across unchanged would undo the scale on the box while
  // its contents stayed scaled.
  const scale = instanceScaleOf(inst);
  const scaled = scale.x !== 1 || scale.y !== 1;
  const nextInst: InstanceElement = {
    ...inst,
    componentId: master.id,
    overrides,
    width: inst.sizeOverride ? inst.width : scaled ? round2(master.width * scale.x) : master.width,
    height: inst.sizeOverride ? inst.height : scaled ? round2(master.height * scale.y) : master.height
  };

  const nextDoc = updateActivePageElements(
    doc,
    mapElements(page.children, (el) => (el.id === instanceId ? nextInst : el))
  );
  return { ...nextDoc, updatedAt: new Date().toISOString() };
}

/**
 * The choices a swap control offers: every variant of a set under its set name,
 * then the standalone components. One implementation for both swap sites — the
 * instance's own panel and a nested instance's override — so the same component
 * can never read two different ways.
 *
 * Given the node being swapped, the components that would put it inside itself
 * (or inside what it already shows) come back `disabled` rather than hidden: the
 * current master has to stay in the list or the control would read as empty, and
 * seeing WHY a neighbour cannot be picked beats it silently missing.
 */
/**
 * One row of the swap list: a component SET or a standalone COMPONENT.
 *
 * Figma's swap list is not a variant list. A set is one candidate — "make this a
 * Button" — and which cell of the Button matrix the instance lands in is the
 * second question, answered by its own variant rows. Flattening every member into
 * the list turned a 3×4 set into twelve `Button · Size=Small, State=Hover` rows
 * and put the two different operations in one control.
 *
 * `id` is still the MEMBER the picker commits, because that is what a swap
 * writes; a set's row carries the member its coordinates already match, or the
 * set's default when the other set has no such cell.
 */
export interface ComponentSwapOption {
  id: string;
  label: string;
  /** What the picker draws beside the label: a set's frame, or one component. */
  kind: "set" | "component";
  /** The set this row stands for, when it stands for one. */
  setId?: string;
  disabled?: boolean;
  refusal?: SwapRefusal;
}

/** The coordinates a component sits at inside its own set, or none. */
function coordinatesOf(
  sets: ReturnType<typeof groupComponentSets>["sets"],
  componentId: string
): Record<string, string> {
  for (const set of sets) {
    const member = set.members.find((m) => m.id === componentId);
    if (member) return member.variantProperties ?? {};
  }
  return {};
}

export function componentSwapOptions(
  doc: DesignDocument,
  swapNodeId?: string,
  /**
   * The inventory, when the caller already has it.
   *
   * `collectComponents` walks every element of every page, and the panel that
   * needs these options also needs the set list and the swap count — so it used
   * to build the same inventory three times per render. Passing it in is what
   * makes one walk serve all three.
   */
  entries?: ComponentEntry[]
): ComponentSwapOption[] {
  const { sets, singles } = groupComponentSets(doc, entries ?? collectComponents(doc));
  const node = swapNodeId ? findNodeById(doc, swapNodeId) : null;
  const currentComponentId = node && node.type === "instance" ? (node as InstanceElement).componentId : null;
  const current = currentComponentId ? coordinatesOf(sets, currentComponentId) : {};

  const options: ComponentSwapOption[] = [
    ...sets.map((set) => {
      // The set this instance is ALREADY a member of points at that very member.
      // Matching by coordinates instead answers with the FIRST member sitting at
      // them, and two members can share a cell — every set born from slash-less
      // names starts with all of them on `Property 1=Default`. The picker then
      // held an id the instance is not, so the row read as a different component
      // and the control announced "Missing component".
      if (currentComponentId && set.members.some((m) => m.id === currentComponentId)) {
        return { id: currentComponentId, label: set.name, kind: "set" as const, setId: set.setId };
      }
      // Only the axes BOTH sets declare can carry over: a Button's `Size` says
      // nothing about a Chip, and asking the Chip for a cell that mentions `Size`
      // matches nothing and silently reset the swap to its top-left. What both
      // sets do declare is kept, so `State=Hover` stays hover.
      const shared: Record<string, string> = {};
      for (const property of set.properties) {
        if (property.property in current) shared[property.property] = current[property.property];
      }
      const member = findVariantMember(set, shared) ?? set.defaultMember;
      return { id: member.id, label: set.name, kind: "set" as const, setId: set.setId };
    }),
    ...singles.map((entry) => ({ id: entry.id, label: entry.name, kind: "component" as const }))
  ];
  if (!swapNodeId) return options;
  return options.map((option) => {
    const refusal = swapRefusal(doc, swapNodeId, option.id);
    return refusal ? { ...option, disabled: true, refusal } : option;
  });
}

/** An instance a drop can land on: a real one, or a clone inside another. */
export interface SwapTarget {
  kind: "instance" | "nested";
  id: string;
}

/**
 * The instance a world point lands on, descending through instance clones.
 *
 * `findInstanceAtPoint` deliberately stops at the outer instance, because for an
 * INSERT that is the right answer. For a swap the nested case is the interesting
 * one: replacing the icon inside a card is a real gesture, and it needs the
 * clone's id — the same derived id the canvas selects with.
 *
 * The deepest hit wins, and a drop on the card but beside the icon still resolves
 * to the card, so the gesture never falls through to inserting on top of it.
 */
export function findSwapTargetAtPoint(
  doc: DesignDocument,
  x: number,
  y: number
): SwapTarget | null {
  const enter = (el: DesignElement, ox: number, oy: number): SwapTarget | null => {
    if (el.type === "instance") {
      const inst = el as InstanceElement;
      const master = findMasterComponent(doc, inst.componentId);
      if (master) {
        const deeper = findIn(resolveInstanceChildren(inst, master), ox + inst.x, oy + inst.y);
        if (deeper) return deeper;
      }
      return { kind: isDerivedNode(el) ? "nested" : "instance", id: el.id };
    }
    return isContainer(el) && el.children?.length ? findIn(el.children, ox + el.x, oy + el.y) : null;
  };
  const findIn = (elements: DesignElement[], ox: number, oy: number): SwapTarget | null => {
    for (let i = elements.length - 1; i >= 0; i--) {
      const el = elements[i];
      // A master is a definition, not scenery — the same refusal
      // `findInstanceAtPoint` makes.
      if (el.type === "component") continue;
      const inside = x >= ox + el.x && x <= ox + el.x + el.width && y >= oy + el.y && y <= oy + el.y + el.height;
      if (!inside) continue;
      const target = enter(el, ox, oy);
      if (target) return target;
    }
    return null;
  };
  return findIn(getActivePage(doc).children || [], 0, 0);
}

/**
 * The new path for one tail, or null when the new master has no counterpart for
 * it — in which case the override has nothing left to describe.
 *
 * A path override (`slot/dot`) is keyed by the ids on the far side of a crossing,
 * and those ids belong to the OLD master. Swapping the nested instance therefore
 * orphaned every one of them: the tail matched nothing in the new master and the
 * label the user had typed inside the card's button went back to the new
 * variant's default with nothing said. The rule is the same name-based,
 * same-starting-value one `remapOverridesByName` applies to a top-level swap — a
 * layer NAME is the only identity two variants share.
 */
function remapPathTail(
  doc: DesignDocument,
  tail: string,
  property: ComponentOverride["property"],
  previous: ComponentElement,
  next: ComponentElement
): string | null {
  const cut = tail.indexOf("/");
  const head = cut > 0 ? tail.slice(0, cut) : tail;
  const rest = cut > 0 ? tail.slice(cut + 1) : "";

  const oldNode = findElementById(previous.children || [], head);
  if (!oldNode) return null;
  const nextNode = oldNode.name ? byName(next.children || []).get(oldNode.name) : undefined;
  if (!nextNode) return null;
  // Figma's second rule, as on a top-level swap: the change survives only when
  // both masters STARTED from the same value for it.
  if (!deepEqual(propertyValue(oldNode, property), propertyValue(nextNode, property))) return null;

  if (!rest) return nextNode.id;
  if (oldNode.type !== "instance" || nextNode.type !== "instance") return null;
  const oldMaster = findMasterComponent(doc, (oldNode as InstanceElement).componentId);
  const nextMaster = findMasterComponent(doc, (nextNode as InstanceElement).componentId);
  if (!oldMaster || !nextMaster) return null;
  const deeper = remapPathTail(doc, rest, property, oldMaster, nextMaster);
  return deeper === null ? null : `${nextNode.id}/${deeper}`;
}

function byName(children: DesignElement[]): Map<string, DesignElement> {
  const map = new Map<string, DesignElement>();
  for (const el of flattenElements(children)) {
    if (el.name && !map.has(el.name)) map.set(el.name, el);
  }
  return map;
}

/**
 * Re-points a NESTED instance at another master, seen from the OUTER instance.
 *
 * A node inside an instance is a resolved clone with no record of its own, so its
 * master cannot be swapped on the node: the change lands as a `componentId`
 * override on the instance that owns it — the same route a text edit inside the
 * instance travels. Returns null when the node is not an overridable instance
 * child, which is the case one level deeper (§5.1 / P1-3).
 */
export function swapNestedInstance(
  doc: DesignDocument,
  nestedNodeId: string,
  nextComponentId: string
): DesignDocument | null {
  const selection = resolveInstanceSelection(doc, nestedNodeId);
  if (!selection || !selection.overridable || selection.node.type !== "instance") return null;
  if (swapRefusal(doc, nestedNodeId, nextComponentId)) return null;
  const nextMaster = findMasterComponent(doc, nextComponentId);
  if (!nextMaster) return null;

  const previousMaster = findMasterComponent(doc, (selection.node as InstanceElement).componentId);
  const withRemapped = previousMaster
    ? remapIntoNestedInstance(doc, selection.instance, selection.masterNodeId, previousMaster, nextMaster)
    : doc;

  return commitInstanceOverrides(withRemapped, [selection], (el) => ({
    ...el,
    componentId: nextComponentId
  }));
}

/** Applies `remapPathTail` to every override that crosses into the nested instance. */
function remapIntoNestedInstance(
  doc: DesignDocument,
  instance: InstanceElement,
  nestedPath: string,
  previous: ComponentElement,
  next: ComponentElement
): DesignDocument {
  const prefix = `${nestedPath}/`;
  const overrides = instance.overrides || [];
  let changed = false;
  const remapped: ComponentOverride[] = [];
  for (const ov of overrides) {
    if (!ov.targetId.startsWith(prefix)) {
      remapped.push(ov);
      continue;
    }
    const tail = remapPathTail(doc, ov.targetId.slice(prefix.length), ov.property, previous, next);
    if (tail !== null) {
      remapped.push({ ...ov, targetId: `${prefix}${tail}` });
      if (`${prefix}${tail}` !== ov.targetId) changed = true;
    } else {
      changed = true;
    }
  }
  if (!changed) return doc;
  const nextDoc = updateActivePageElements(
    doc,
    mapElements(getActivePage(doc).children, (el) =>
      el.id === instance.id ? { ...(el as InstanceElement), overrides: remapped } : el
    )
  );
  return nextDoc;
}
