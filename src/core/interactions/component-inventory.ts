import {
  ComponentElement,
  ComponentOverride,
  ComponentSetElement,
  DesignDocument,
  DesignElement,
  InstanceElement,
  Page,
  TextElement
} from "../dsl/types";
import { effectiveStrokes } from "../dsl/paint-stack";
import { findElementById, flattenElements, insideComponent, isContainer } from "../geometry/tree-ops";

/**
 * Read-side of the component model: what components exist, how they group into
 * variant sets, and the small "what IS this node" predicates every entry point
 * asks before acting.
 *
 * Split out of `component-ops.ts` (AGENTS.md §9) along the seam between reading
 * the component graph and writing to it: nothing here mutates a document, and
 * `component-ops` / `instance-resolve` / `component-swap` all read through it.
 */

/**
 * One row of the set's property table — Figma's `variantGroupProperties` entry,
 * flattened for display.
 *
 * `values` is the set's OWN list, not the values its members happen to use. That
 * distinction is the feature: an instance's dropdown offers every value the
 * property declares, and picking one the set has not drawn yet is how you find
 * out that the matrix has a hole in it.
 */
export interface ComponentVariantOption {
  property: string;
  values: string[];
}

export interface ComponentSet {
  /** The `componentSet` node's id, or — for a group no node backs — the shared id. */
  setId: string;
  /**
   * The set node, when there is one. `null` for a legacy group, and that is a
   * supported state rather than a broken one: a document written before the set
   * became a node, a hoisted master and an ungrouped set all produce members that
   * share an `setId` and nothing else. They still group here; they just have no
   * box, no name of their own and nowhere to add a member.
   */
  setNodeId: string | null;
  /**
   * The set's own label. Stored on the node when there is one — deriving it from
   * the members' shared name prefix meant renaming a variant renamed the set and
   * renaming the set was impossible, which is the whole reason the node exists.
   */
  name: string;
  members: ComponentEntry[];
  /** The set's property table, in the order the author declared it. */
  properties: ComponentVariantOption[];
  /**
   * Figma's `defaultVariant`: the top-LEFT-most member, spatially. What an
   * instance becomes when nothing was configured, and what the assets panel
   * inserts. Deliberately geometric — picking it by "the member with no
   * `variantProperties`" was the old reading, and it had no member to find the
   * moment the first variant existed.
   */
  defaultMember: ComponentEntry;
}

/**
 * Assets-panel listing. A main component is reachable from any page, so the
 * scan walks every page and keeps the owning page id — locating one has to
 * switch to that page before it can be selected.
 */
export interface ComponentEntry {
  id: string;
  name: string;
  pageId: string;
  pageName: string;
  width: number;
  height: number;
  instanceCount: number;
  /** Live element — the assets panel paints a thumbnail straight off it. */
  el: ComponentElement;
  setId?: string;
  /** Figma's `variantProperties`: this member's coordinates in the matrix. */
  variantProperties?: Record<string, string>;
}

function commonPrefix(a: string, b: string): string {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return a.slice(0, i);
}

/** Every `componentSet` node in the document, by id. */
function componentSetNodes(doc: DesignDocument): Map<string, ComponentSetElement> {
  const nodes = new Map<string, ComponentSetElement>();
  const pages = doc.pages ?? [];
  for (const page of pages) {
    for (const el of flattenElements(page.children || [])) {
      if (el.type === "componentSet") nodes.set(el.id, el as ComponentSetElement);
    }
  }
  return nodes;
}

/**
 * Members in the order their set stores them.
 *
 * Authoring order, not alphabetical: it decides the matrix's column order and the
 * order values are offered in. Both used to be sorted by locale, which turned
 * every size axis into Large/Medium/Small. A node-backed set answers from
 * `children`; a legacy group has no order of its own and keeps the name-sorted one
 * `collectComponents` handed back.
 */
function inSetOrder(members: ComponentEntry[], node: ComponentSetElement | undefined): ComponentEntry[] {
  if (!node) return members;
  const rank = new Map((node.children || []).map((c, i) => [c.id, i]));
  return [...members].sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
}

/**
 * The set's property table.
 *
 * The node's own `variantGroupProperties` when it has one, because that list is the
 * set's and includes values no member uses yet. A legacy group has no node, so its
 * table is inferred from the members in the order they declare — which is the
 * honest answer for a document nobody has edited since, and is the only reading
 * available there.
 *
 * Merged, not chosen: a value a member uses but the table omits is added to the
 * table rather than hidden. A set whose table is short would otherwise make its own
 * members unreachable in the dropdown.
 */
function setProperties(
  members: ComponentEntry[],
  node: ComponentSetElement | undefined
): ComponentVariantOption[] {
  const properties: ComponentVariantOption[] = [];
  const declared = node?.variantGroupProperties;
  for (const [property, values] of Object.entries(declared ?? {})) {
    properties.push({ property, values: [...values] });
  }
  for (const m of members) {
    for (const [property, value] of Object.entries(m.variantProperties ?? {})) {
      let opt = properties.find((p) => p.property === property);
      if (!opt) {
        opt = { property, values: [] };
        properties.push(opt);
      }
      if (!opt.values.includes(value)) opt.values.push(value);
    }
  }
  return properties;
}

/**
 * The property table of ONE set node, without grouping the whole document.
 *
 * `groupComponentSets` answers the same question for every set in the file, which
 * is wasteful for a panel that was handed the node it is editing. Merged rather
 * than read straight off the node, so a value a member carries but the table omits
 * is still offerable — the same guarantee `setProperties` makes there.
 */
export function variantTableOf(set: ComponentSetElement): ComponentVariantOption[] {
  const properties: ComponentVariantOption[] = [];
  for (const [property, values] of Object.entries(set.variantGroupProperties ?? {})) {
    properties.push({ property, values: [...values] });
  }
  for (const child of set.children || []) {
    const own = (child as ComponentElement).variantProperties ?? {};
    for (const [property, value] of Object.entries(own)) {
      let opt = properties.find((p) => p.property === property);
      if (!opt) {
        opt = { property, values: [] };
        properties.push(opt);
      }
      if (!opt.values.includes(value)) opt.values.push(value);
    }
  }
  return properties;
}

/**
 * The label of a group no node backs, reconstructed from its members' names.
 *
 * Only reachable for a legacy set — a node-backed set stores its own — so it stays
 * as forgiving as its inputs. The prefix is stripped of the `Property=Value` tail
 * because that is what a member is named after in Figma, and the set is named
 * after what it makes instead.
 */
function legacySetName(members: ComponentEntry[], properties: ComponentVariantOption[]): string {
  let name = members.reduce((acc, m) => commonPrefix(acc, m.name), members[0].name);
  name = name.replace(/[\s,/_\-=]+$/, "");
  for (const p of properties) {
    // `Property=Value` is OPTIONAL here, and that is the load-bearing part: the
    // shared prefix of `Button State=Default` and `Button State=Hover` is
    // `Button State`, with the `=…` already cut off by the first difference. A
    // pattern that insists on the `=` therefore never matches and every legacy set
    // keeps its property name glued to the end.
    //
    // Escaped because `property` is author text: a set whose axis is named
    // `Size (S/M)` would otherwise compile a broken pattern and throw on read.
    const escaped = p.property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const tail = new RegExp(`[\\s,/_-]*${escaped}\\s*(=\\s*[^,]*)?$`, "i");
    name = name.replace(tail, "").replace(/[\s,/_\-=]+$/, "");
  }
  return name || members[0].name;
}

/**
 * @param entries The inventory, when the caller already has one.
 *
 *   `collectComponents` walks every element of every page, and the panels that
 *   need this grouping also need the swap counts — so they used to build the same
 *   inventory three times per render. Passing it in is what makes one walk serve
 *   all three.
 */
export function groupComponentSets(
  doc: DesignDocument,
  entries: ComponentEntry[] = collectComponents(doc)
): {
  sets: ComponentSet[];
  singles: ComponentEntry[];
} {
  const nodes = componentSetNodes(doc);

  const bySet = new Map<string, ComponentEntry[]>();
  const singles: ComponentEntry[] = [];
  for (const entry of entries) {
    if (!entry.setId) {
      singles.push(entry);
      continue;
    }
    const list = bySet.get(entry.setId) || [];
    list.push(entry);
    bySet.set(entry.setId, list);
  }

  const sets: ComponentSet[] = [];
  for (const [setId, found] of bySet) {
    const members = inSetOrder(found, nodes.get(setId));
    const properties = setProperties(members, nodes.get(setId));
    const node = nodes.get(setId);
    const name = node?.name ?? legacySetName(members, properties);
    sets.push({
      setId,
      setNodeId: node ? node.id : null,
      name,
      members,
      properties,
      defaultMember: defaultVariantOf(members)
    });
  }

  sets.sort((a, b) => a.name.localeCompare(b.name));
  return { sets, singles };
}

/**
 * Figma's `defaultVariant`: the top-left-most member, spatially.
 *
 * Row first, then column, so "top-left" means what it says for a set arranged as a
 * grid and still means "topmost" for the single column Figma defaults to. Sorting
 * the entries would work too and would also be wrong — it would tie the order of
 * two members that are in the same cell to their names.
 */
function defaultVariantOf(members: ComponentEntry[]): ComponentEntry {
  return members.reduce((best, m) =>
    m.el.y < best.el.y || (m.el.y === best.el.y && m.el.x < best.el.x) ? m : best
  );
}

/**
 * The member sitting at exactly these coordinates, or undefined for a hole.
 *
 * Undefined is the answer Figma gives too, and it is worth keeping: a set may
 * declare `State: [Default, Hover, Pressed]` with only two of the three drawn, and
 * an instance configured for the third has to be told there is nothing there
 * rather than handed a member that is not it.
 */
export function findVariantMember(
  set: ComponentSet,
  values: Record<string, string>
): ComponentEntry | undefined {
  return set.members.find((m) => {
    const own = m.variantProperties ?? {};
    return Object.entries(values).every(([k, val]) => (own[k] || "") === val);
  });
}

export function findComponentSet(
  doc: DesignDocument,
  componentId: string
): ComponentSet | null {
  const { sets } = groupComponentSets(doc);
  return sets.find((s) => s.members.some((m) => m.id === componentId)) || null;
}

/**
 * The values one property may be set to — the whole declared list.
 *
 * Every value, not only the ones a member currently fills. Figma offers all of
 * them, and that is how you discover a hole: the dropdown says `Pressed` is
 * possible and selecting it reports that nobody has drawn that variant yet. The
 * earlier reading narrowed the list to combinations that existed, which hid the
 * hole and made the matrix's shape unknowable from the instance panel.
 *
 * The instance's own value is kept even when the table has forgotten it, so a
 * member can never become unreachable through its own control.
 */
export function variantOptionsFor(
  set: ComponentSet,
  property: string,
  current: Record<string, string>
): string[] {
  const declared = set.properties.find((p) => p.property === property)?.values ?? [];
  const out = [...declared];
  const own = current[property];
  if (own && !out.includes(own)) out.push(own);
  return out;
}

/**
 * The values of one property that would land on a HOLE in the matrix.
 *
 * A set declares every value a property may take, and an instance is offered all
 * of them — that is how a designer discovers `Pressed` exists. Selecting one that
 * no member fills changes nothing, so the option says so up front rather than
 * after a click that appears to have been ignored.
 */
export function variantHoles(
  set: ComponentSet,
  property: string,
  current: Record<string, string>
): string[] {
  return variantOptionsFor(set, property, current).filter(
    (value) => !findVariantMember(set, { ...current, [property]: value })
  );
}

/** The stored value of one overridable property — shared with `component-swap.ts`. */
export function propertyValue(el: DesignElement, property: ComponentOverride["property"]): unknown {
  if (property === "strokes") return effectiveStrokes(el);
  if (property === "style") return (el as TextElement).style;
  return (el as unknown as Record<string, unknown>)[property];
}

/**
 * One id → first-element-per-page index per document, in page order.
 *
 * A linear scan was correct and ruinous: the layer panel asks this question once
 * per row per render (twice — `hasRows` and `rowOrderOf`), so a 3120-row page of
 * instances walked every page of the document 984 times a frame. Measured on the
 * YumQuick page that was 76% of a drag frame in `findElementById` alone.
 *
 * Keyed on the document object, which every commit replaces, so the index can
 * never outlive the tree it describes. Pages are kept separate rather than merged
 * into one map because the scan's page order is observable: a page holding the id
 * as something OTHER than a component must not shadow a component of that id on a
 * later page.
 */
const masterIndexCache = new WeakMap<DesignDocument, Map<string, DesignElement>[]>();

function masterPageIndex(doc: DesignDocument): Map<string, DesignElement>[] {
  const cached = masterIndexCache.get(doc);
  if (cached) return cached;

  const pageIndex = (els: DesignElement[] | undefined): Map<string, DesignElement> => {
    const map = new Map<string, DesignElement>();
    for (const el of flattenElements(els || [])) {
      if (!map.has(el.id)) map.set(el.id, el);
    }
    return map;
  };

  const pages = (doc.pages ?? []).map((page) => pageIndex(page.children));

  masterIndexCache.set(doc, pages);
  return pages;
}

export function findMasterComponent(doc: DesignDocument, componentId: string): ComponentElement | null {
  for (const page of masterPageIndex(doc)) {
    const found = page.get(componentId);
    if (found && found.type === "component") return found as ComponentElement;
  }
  return null;
}

/**
 * What one page contributes to the inventory: the components it defines and how
 * many instances point at each component id.
 *
 * Cached per PAGE, not per document, because a document is replaced on every
 * commit while its pages are not: editing an empty page must not re-walk the
 * 1,841-element page beside it. Pages are immutable objects, so the cache can
 * never describe a tree that has since changed.
 */
interface PageComponentScan {
  entries: Array<Omit<ComponentEntry, "instanceCount">>;
  instanceCounts: Map<string, number>;
}

const pageScanCache = new WeakMap<Page, PageComponentScan>();

function scanPage(page: Page): PageComponentScan {
  const hit = pageScanCache.get(page);
  if (hit) return hit;
  const entries: Array<Omit<ComponentEntry, "instanceCount">> = [];
  const instanceCounts = new Map<string, number>();
  for (const el of flattenElements(page.children || [])) {
    if (el.type === "instance") {
      const cid = (el as InstanceElement).componentId;
      if (cid) instanceCounts.set(cid, (instanceCounts.get(cid) || 0) + 1);
    } else if (el.type === "component") {
      const comp = el as ComponentElement;
      entries.push({
        id: comp.id,
        name: comp.name || comp.id,
        pageId: page.id,
        pageName: page.name,
        width: comp.width,
        height: comp.height,
        el: comp,
        setId: comp.setId,
        variantProperties: comp.variantProperties
      });
    }
  }
  const scan = { entries, instanceCounts };
  pageScanCache.set(page, scan);
  return scan;
}

export function collectComponents(doc: DesignDocument): ComponentEntry[] {
  const pages: Page[] = doc.pages ?? [];
  const scans = pages.map(scanPage);

  const counts = new Map<string, number>();
  for (const scan of scans) {
    for (const [cid, n] of scan.instanceCounts) counts.set(cid, (counts.get(cid) || 0) + n);
  }

  const entries: ComponentEntry[] = [];
  for (const scan of scans) {
    for (const base of scan.entries) {
      entries.push({ ...base, instanceCount: counts.get(base.id) || 0 });
    }
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  return reuseComponentsIfEqual(entries);
}

/**
 * Hand back the previous list when nothing in it changed.
 *
 * The layer panel compares `components` by identity, so a new array per commit
 * is a panel re-render per commit — which is the whole reason `layerTreeEqual`
 * exists and is then never reached. Only the entries are compared: an unchanged
 * component reuses its stored element, and a component that was edited cannot.
 */
let lastComponents: ComponentEntry[] = [];

function reuseComponentsIfEqual(next: ComponentEntry[]): ComponentEntry[] {
  const prev = lastComponents;
  if (prev.length !== next.length) {
    lastComponents = next;
    return next;
  }
  for (let i = 0; i < next.length; i++) {
    const a = prev[i];
    const b = next[i];
    if (a === b) continue;
    if (
      a.id !== b.id ||
      a.name !== b.name ||
      a.pageId !== b.pageId ||
      a.pageName !== b.pageName ||
      a.width !== b.width ||
      a.height !== b.height ||
      a.instanceCount !== b.instanceCount ||
      a.el !== b.el ||
      a.setId !== b.setId ||
      a.variantProperties !== b.variantProperties
    ) {
      lastComponents = next;
      return next;
    }
  }
  lastComponents = prev;
  return prev;
}

/**
 * The instance a world point lands on, or null.
 *
 * Walked in reverse draw order so the top-most one wins, and it does NOT descend
 * into an instance: an instance stores no children, so anything "inside" it
 * belongs to its master and cannot be a second swap target.
 *
 * It does not descend into a COMPONENT either, and for the same reason one step
 * further out: a master is a definition, not scenery. Dropping a component card on
 * one used to find the instance the master happens to contain — at a coordinate
 * offset into the master — and "swap" it, which rewrote the definition every
 * instance of that master resolves from. The gesture is meant to insert; a
 * definition is not a drop target.
 */
export function findInstanceAtPoint(
  elements: DesignElement[],
  x: number,
  y: number
): InstanceElement | null {
  for (let i = elements.length - 1; i >= 0; i--) {
    const el = elements[i];
    const inside =
      x >= el.x && x <= el.x + el.width && y >= el.y && y <= el.y + el.height;
    if (el.type === "instance" && inside) return el as InstanceElement;
    if (el.type === "component") continue;
    if (isContainer(el) && el.children && el.children.length > 0) {
      // Children are stored in the container's own space, so the point moves.
      const hit = findInstanceAtPoint(el.children, x - el.x, y - el.y);
      if (hit) return hit;
    }
  }
  return null;
}

/**
 * True for a node that exists only as a resolved clone of an instance's master.
 *
 * Such a node is painted but never stored, so every gesture that writes back to
 * the document tree by id silently does nothing on it. Callers must recognise it
 * and refuse loudly — a handle that drags into the void is worse than no handle.
 * Derived ids are minted as
 * `<instanceId>_<masterNodeId>`, which is the same rule `resolveInstanceSelection`
 * relies on.
 */
export function isDerivedNode(el: DesignElement | null | undefined): boolean {
  return Boolean(el && (el as { __instanceId?: string }).__instanceId);
}

/** True when every id in `ids` belongs to a derived clone of `instanceId`. */
export function isDerivedFrom(instanceId: string, id: string): boolean {
  return id === instanceId || id.startsWith(`${instanceId}_`);
}

/**
 * The page that owns a main component, or null when the id is not a component.
 * A master can live on any page, so "go to main component" has to switch pages
 * first — selecting an id that is not on the active page selects nothing.
 */
export function findComponentOwnerPageId(
  doc: DesignDocument,
  componentId: string
): string | null {
  for (const page of doc.pages || []) {
    const found = findElementById(page.children || [], componentId);
    if (found && found.type === "component") return page.id;
  }
  return null;
}

/**
 * A component already is one, a resolved clone is not in the tree to own, and a
 * set is a group of them: promoting one would either flatten the set into a
 * single master or put a definition inside a definition.
 */
export function canBecomeComponent(el: DesignElement | null | undefined): boolean {
  return Boolean(
    el && el.type !== "component" && el.type !== "componentSet" && !isDerivedNode(el)
  );
}

/**
 * `canBecomeComponent`, plus the structural half: a definition cannot be created
 * inside another one. Inside a component, an instance is the way to reuse one, so
 * every entry point (the ⌥⌘K shortcut, the inspector button) asks this rather
 * than re-deriving the rule.
 *
 * A set counts as one, which is what refuses a promotion inside it: the children
 * there are definitions, and a master among definitions would be cloned into every
 * instance of the set's members.
 */
export function canCreateComponentHere(
  elements: DesignElement[],
  el: DesignElement | null | undefined
): boolean {
  return canBecomeComponent(el) && !insideComponent(elements, el!.id);
}
