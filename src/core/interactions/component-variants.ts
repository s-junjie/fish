import {
  ComponentElement,
  ComponentSetElement,
  DesignDocument,
  DesignElement,
  getActivePage,
  updateActivePageElements
} from "../dsl/types";
import {
  findComponentSetNode,
  flattenElements,
  isContainer,
  mapElements,
  removeElementFromTree
} from "../geometry/tree-ops";
import { createId } from "../id";
import { fitComponentSet, nextVariantOrigin } from "../layout/component-set";
import { assembleComponentSet, dissolveComponentSet, ensureComponentSet } from "./component-set-tree";
import { nextVariantPropertyName, nextVariantValueName, parseSlashNaming, variantName } from "./variant-naming";

/**
 * The authoring actions on a variant set, in Figma's vocabulary.
 *
 * A set is a `componentSet` node whose children are the variants, and the two
 * halves of Figma's model live in two places, as they do there:
 * `variantGroupProperties` on the SET is the property table — each column and
 * every value it may take — and `variantProperties` on each MEMBER is that
 * variant's coordinates. An instance addresses one member by id and its dropdowns
 * read the table, which is why a value nobody has used yet can still be offered.
 *
 * The names here are Figma's, deliberately and including the parts that read
 * oddly: the first property is `Property 1`, the first value is `Default`, and a
 * member is called `State=Hover` rather than `Button hover`. The reasoning for
 * each is in `variant-naming.ts`.
 *
 * SCOPE: every write lands on the ACTIVE page, because that is the page
 * `updateActivePageElements` writes into and the only page `apply-ops` can name a
 * target on. The readers are scoped the same way, and deliberately: they used to
 * walk every page, so a set that lived elsewhere was counted as present while the
 * write went nowhere.
 *
 * `labels` are the user-facing strings the generated names need, handed in from the
 * UI layer because `i18n` is not a dependency of the model (AGENTS.md §4).
 */
export interface VariantLabels {
  property: (n: number) => string;
  firstValue: string;
  nthValue: (n: number) => string;
}

/** The same labels in the shape `variant-naming.ts` takes. */
const valueLabels = (labels: VariantLabels) => ({
  first: labels.firstValue,
  nth: labels.nthValue
});

/** Reads `doc` as if the active page were the only one. */
const activePageDoc = (doc: DesignDocument): DesignDocument => {
  const page = getActivePage(doc);
  return { ...doc, pages: [page], activePageId: page.id };
};

/** A component on the ACTIVE page, or null — see the scope note above. */
function locate(doc: DesignDocument, componentId: string): ComponentElement | null {
  const found = flattenElements(getActivePage(doc).children || []).find(
    (el) => el.id === componentId && el.type === "component"
  );
  return (found as ComponentElement | undefined) ?? null;
}

/** The set node on the active page, or null. */
function locateSet(doc: DesignDocument, setId: string | undefined): ComponentSetElement | null {
  return findComponentSetNode(getActivePage(doc).children, setId);
}

/**
 * Replaces one node anywhere on the active page, by id.
 *
 * The id test stays INSIDE this helper rather than in the caller's closure, which
 * looks redundant and is not: `mapElements` applies the callback to descendants
 * too, so an unguarded replacement would substitute the node for its entire subtree.
 */
function withElementReplaced(
  doc: DesignDocument,
  id: string,
  replace: (el: DesignElement) => DesignElement
): DesignDocument {
  return {
    ...updateActivePageElements(
      doc,
      mapElements(getActivePage(doc).children, (el) => (el.id === id ? replace(el) : el))
    ),
    updatedAt: new Date().toISOString()
  };
}

/**
 * A copy of a master that shares no node id with it.
 *
 * Instances address their master's layers by id — that is what an override's
 * `targetId` is — so a copy that kept the source's ids would make an override on
 * one member resolve against the other. Every descendant gets a fresh id, which
 * also means a copy placed in the same document cannot collide with its original.
 */
function cloneMaster(comp: ComponentElement, name: string): ComponentElement {
  const remap = new Map<string, string>();
  const reid = (el: DesignElement): DesignElement => {
    const next: DesignElement = { ...el, id: createId(el.type) };
    remap.set(el.id, next.id);
    return isContainer(next)
      ? ({ ...next, children: (next.children || []).map(reid) } as DesignElement)
      : next;
  };
  const children = (comp.children || []).map(reid);
  return { ...comp, id: createId("cmp"), name, children };
}

/**
 * Rewrites the set AND the members that a property edit touches, as one document.
 *
 * Every mutation here is two writes at once — the table on the set, the coordinates
 * and the derived name on each member — and the reason is undo. Split across two
 * commits, one ⌘Z would take the table back and leave members pointing at a column
 * that no longer exists.
 *
 * `append` exists because "add a variant" is the same edit: it adds a value to the
 * table AND a member. Doing those as two `writeSet` calls meant the second rebuilt
 * the set from the object it was handed rather than from what the first wrote, and
 * silently dropped the value it had just registered.
 */
function writeSet(
  doc: DesignDocument,
  set: ComponentSetElement,
  mutate: (state: {
    properties: Record<string, string[]>;
    members: Map<string, Record<string, string>>;
    append?: (copy: ComponentElement) => void;
  }) => void,
  append?: ComponentElement
): DesignDocument {
  const members = new Map<string, Record<string, string>>();
  for (const child of set.children || []) {
    members.set(child.id, { ...((child as ComponentElement).variantProperties ?? {}) });
  }
  const properties: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(set.variantGroupProperties ?? {})) properties[k] = [...v];

  let addCopy: ((copy: ComponentElement) => void) | undefined;
  if (append) {
    members.set(append.id, { ...(append.variantProperties ?? {}) });
    addCopy = (copy) => members.set(copy.id, { ...(copy.variantProperties ?? {}) });
  }
  mutate({ properties, members, append: addCopy });

  const nextChildren = (set.children || []).map((child) => {
    const coords = members.get(child.id);
    if (!coords) return child;
    return {
      ...(child as ComponentElement),
      variantProperties: coords,
      name: variantName(coords, child.name ?? "")
    } as DesignElement;
  });
  if (append) nextChildren.push(append);

  return withElementReplaced(doc, set.id, () =>
    fitComponentSet({ ...set, variantGroupProperties: properties, children: nextChildren })
  );
}

/**
 * Figma's "Add property → Variant", and the first thing you press on a lone main
 * component.
 *
 * Creates one property on the set, gives the component that becomes the set's
 * first member the first value of it, and renames the member after its
 * coordinates. That last part is the whole difference from the old behaviour,
 * which cloned the component and left the original behind with no value at all —
 * so a set came out with one member that belonged to no cell of its own matrix,
 * and there was nothing in the panel that said so.
 *
 * Returns the set, or null when the component is already in one: Figma's control
 * is "Add property", and adding a property to a set that has one is a different
 * command (`addVariantProperty`) rather than this one.
 */
export function addVariantProperty(
  doc: DesignDocument,
  componentId: string,
  labels: VariantLabels,
  name?: string
): { doc: DesignDocument; set: ComponentSetElement | null; property: string | null } {
  const comp = locate(doc, componentId);
  if (!comp) return { doc, set: null, property: null };
  const existing = locateSet(doc, comp.setId);
  if (existing) return { doc, set: existing, property: null };

  const property = name?.trim() || nextVariantPropertyName([], labels.property);
  const value = labels.firstValue;
  const ensured = ensureComponentSet(doc, comp, {
    properties: { [property]: [value] },
    coordinates: { [comp.id]: { [property]: value } }
  });
  return {
    doc: ensured ? ensured.doc : doc,
    set: ensured?.set ?? null,
    property: ensured ? property : null
  };
}

/**
 * Adds one property to a set that already has one, giving it `Default` on every
 * member that has no value for it.
 *
 * The backfill is Figma's: a new column is `Default` down the whole set until
 * somebody changes a cell, not blank, because a blank cell is a hole and a
 * two-property set should not open with one everywhere.
 */
export function addVariantPropertyToSet(
  doc: DesignDocument,
  setId: string,
  labels: VariantLabels,
  name?: string
): { doc: DesignDocument; property: string | null } {
  const set = locateSet(doc, setId);
  if (!set) return { doc, property: null };
  const property =
    name?.trim() || nextVariantPropertyName(Object.keys(set.variantGroupProperties ?? {}), labels.property);
  const value = nextVariantValueName([], valueLabels(labels));
  const next = writeSet(doc, set, ({ properties, members }) => {
    properties[property] = [value];
    for (const coords of members.values()) {
      if (!(property in coords)) coords[property] = value;
    }
  });
  return { doc: next, property };
}

/**
 * Figma's "Add variant": a copy of the selected one, placed below it in the set,
 * carrying a value nobody has used yet.
 *
 * There is no axis-and-value form to fill in, because Figma has none — the copy
 * inherits every coordinate it can and differs on exactly one property, which
 * defaults to the first column. Which property is the one decision worth naming:
 * `property` takes it when the caller knows, and the set's first column is the
 * answer otherwise, matching "Creates a new value for a variant property".
 */
export function addVariant(
  doc: DesignDocument,
  componentId: string,
  labels: VariantLabels,
  property?: string
): { doc: DesignDocument; variant: ComponentElement | null } {
  const comp = locate(doc, componentId);
  if (!comp) return { doc, variant: null };
  const set = locateSet(doc, comp.setId);
  if (!set) return { doc, variant: null };

  const table = set.variantGroupProperties ?? {};
  const columns = Object.keys(table);
  const column = property && property in table ? property : columns[0];
  if (!column) return { doc, variant: null };

  const source = (set.children || []).find((c) => c.id === comp.id) as ComponentElement | undefined;
  if (!source) return { doc, variant: null };

  const value = nextVariantValueName(table[column] ?? [], valueLabels(labels));
  const coordinates = { ...(source.variantProperties ?? {}), [column]: value };
  const at = nextVariantOrigin(set);
  const copy: ComponentElement = {
    ...cloneMaster(source, variantName(coordinates, source.name ?? "")),
    x: at.x,
    y: at.y,
    setId: set.id,
    variantProperties: coordinates
  };

  // One write: the new value on the table and the new member are the same edit, and
  // two would have the second rebuild the set from the object it was handed rather
  // than from what the first wrote — dropping the value it had just registered.
  const next = writeSet(
    doc,
    set,
    ({ properties }) => {
      properties[column] = [...(table[column] ?? []), value];
    },
    copy
  );
  return { doc: next, variant: copy };
}

/**
 * Sets one cell of the matrix, and registers the value on the set if it is new.
 *
 * Registering is what makes the table the authority: a value typed into a cell has
 * to become offerable everywhere, or the next instance dropdown would list the
 * property's values as though this one did not exist.
 */
export function setVariantValue(
  doc: DesignDocument,
  setId: string,
  componentId: string,
  property: string,
  value: string
): DesignDocument | null {
  const target = value.trim();
  if (!target) return null;
  const set = locateSet(doc, setId);
  if (!set) return null;
  return writeSet(doc, set, ({ properties, members }) => {
    const list = properties[property] ?? [];
    if (!list.includes(target)) properties[property] = [...list, target];
    const coords = members.get(componentId);
    if (coords) coords[property] = target;
  });
}

/** Renames a property: its column in the table and every member's coordinate. */
export function renameVariantProperty(
  doc: DesignDocument,
  setId: string,
  from: string,
  to: string
): DesignDocument | null {
  const target = to.trim();
  if (!target || from === target) return null;
  const set = locateSet(doc, setId);
  if (!set) return null;
  return writeSet(doc, set, ({ properties, members }) => {
    const renamed: Record<string, string[]> = {};
    for (const [key, valueList] of Object.entries(properties)) {
      renamed[key === from ? target : key] = valueList;
    }
    for (const key of Object.keys(properties)) delete properties[key];
    Object.assign(properties, renamed);
    for (const coords of members.values()) {
      if (!(from in coords)) continue;
      // Rebuilt from the table's order rather than assigned into: a member that
      // kept both `Size` and `Style` would carry a coordinate for a column that no
      // longer exists, and its name would read `…, Size=…, Style=…`.
      const seated: Record<string, string> = {};
      for (const key of Object.keys(properties)) {
        seated[key] = key === target ? coords[from] : (coords[key] ?? "");
      }
      for (const key of Object.keys(coords)) delete coords[key];
      Object.assign(coords, seated);
    }
  });
}

/** Renames one value on one property, across every member that carries it. */
export function renameVariantValue(
  doc: DesignDocument,
  setId: string,
  property: string,
  from: string,
  to: string
): DesignDocument | null {
  const target = to.trim();
  if (!target || from === target) return null;
  const set = locateSet(doc, setId);
  if (!set) return null;
  return writeSet(doc, set, ({ properties, members }) => {
    const list = properties[property] ?? [];
    // Replace all occurrences of 'from' with 'target', deduplicating if target was already present
    const updated: string[] = [];
    for (const v of list) {
      const next = v === from ? target : v;
      if (!updated.includes(next)) {
        updated.push(next);
      }
    }
    if (!updated.includes(target)) {
      updated.push(target);
    }
    properties[property] = updated;
    for (const coords of members.values()) {
      if (coords[property] === from) coords[property] = target;
    }
  });
}

/**
 * Removes one VALUE from a property's table — the leftover of a rename.
 *
 * `setVariantValue` registers the new value and leaves the old one declared, so a
 * cell edited to `Compact` keeps `Small` on every dropdown with no member behind
 * it. There is no member to delete, and the row's trash looped over the members
 * that carried the value — of which there were none — so it did nothing at all.
 *
 * Refusals are the two things a column cannot survive: a value some member still
 * sits on (rename it on that member instead), and the last value (a column with no
 * values is not a column).
 */
export function removeVariantValue(
  doc: DesignDocument,
  setId: string,
  property: string,
  value: string
): DesignDocument | null {
  const set = locateSet(doc, setId);
  if (!set) return null;
  const values = set.variantGroupProperties?.[property];
  if (!values?.includes(value) || values.length <= 1) return null;
  const used = (set.children ?? []).some(
    (child) => (child as ComponentElement).variantProperties?.[property] === value
  );
  if (used) return null;
  return writeSet(doc, set, ({ properties }) => {
    properties[property] = (properties[property] ?? []).filter((v) => v !== value);
  });
}

/**
 * Removes a property and its column.
 *
 * The table keeps the values even when no member used them, so this is the only
 * way a value ever leaves a set — which is what makes it the right place to put
 * the destructive control, rather than on a cell where it would read as "clear
 * this one".
 */
export function removeVariantProperty(
  doc: DesignDocument,
  setId: string,
  property: string
): DesignDocument | null {
  const set = locateSet(doc, setId);
  if (!set || !(property in (set.variantGroupProperties ?? {}))) return null;
  return writeSet(doc, set, ({ properties, members }) => {
    delete properties[property];
    for (const coords of members.values()) delete coords[property];
  });
}

/** Removes one member. A set of one is not a set, so it goes too. */
export function removeVariant(doc: DesignDocument, componentId: string): DesignDocument | null {
  const comp = locate(doc, componentId);
  if (!comp || !comp.setId) return null;
  const set = locateSet(doc, comp.setId);
  if (!set) return null;
  const setId = comp.setId;
  const remaining = (set.children || []).map((c) => c.id).filter((id) => id !== componentId);

  const [elements, removed] = removeElementFromTree(getActivePage(doc).children, componentId);
  // The guard is what keeps the two halves of this function in step: the count
  // below decides whether the survivor is un-grouped, so a removal that did not
  // happen must not reach it — "the node is gone" is the fact this needs, not "a
  // lookup found a component".
  if (!removed) return null;

  const next: DesignDocument = {
    ...updateActivePageElements(doc, elements),
    updatedAt: new Date().toISOString()
  };

  return remaining.length === 1
    ? dissolveComponentSet(next, setId) ?? next
    : withElementReplaced(next, setId, () =>
        fitComponentSet({ ...set, children: (set.children || []).filter((c) => c.id !== componentId) })
      );
}

/**
 * Figma's "Combine as variants", with its slash convention.
 *
 * `Button/Primary/Large` becomes a set called `Button` whose table is
 * `Property 1: [Primary]` and `Property 2: [Large]`, so a team that already
 * encodes hierarchy in layer names gets a readable matrix with nothing to rename.
 * Names with no slash still combine: the members become `Property 1=Default` and
 * their own names are dropped, because a member of a set is named after where it
 * sits and "here lies whatever this used to be called" is not an answer.
 *
 * The set takes the FIRST member's name when nothing says otherwise, matching
 * Figma: `Button` is a set called `Button`, not `Button copy`.
 */
export function combineAsVariants(
  doc: DesignDocument,
  componentIds: string[],
  labels: VariantLabels
): { doc: DesignDocument; setId: string; name: string } | null {
  if (componentIds.length < 2) return null;
  const found = componentIds.map((id) => locate(doc, id));
  if (found.some((c) => !c)) return null;
  const members = found as ComponentElement[];

  // Parsed ONCE per member: the parser is also what decides the column count, so
  // a ragged input (one member with fewer slashes) loses the extra columns rather
  // than leaving a value blank on the members that did name one.
  const parsed = members.map((m) => parseSlashNaming([m.name ?? ""]).propertyValues);
  // The SHALLOWEST name, not the deepest: Figma requires every member to have the
  // same number of slashes, and taking the deepest would leave a column filled on
  // some rows and blank on others — a hole the author never asked for.
  const depth = Math.min(...parsed.map((p) => p.length));

  const table: Record<string, string[]> = {};
  const coordinates: Record<string, Record<string, string>> = {};
  if (depth > 0) {
    for (let column = 0; column < depth; column++) {
      const property = nextVariantPropertyName(Object.keys(table), labels.property);
      const values: string[] = [];
      for (const p of parsed) {
        const v = p[column]?.[0];
        if (v && !values.includes(v)) values.push(v);
      }
      table[property] = values.length > 0 ? values : [labels.firstValue];
    }
    for (const [index, m] of members.entries()) {
      const coords: Record<string, string> = {};
      for (let column = 0; column < depth; column++) {
        const property = Object.keys(table)[column]!;
        coords[property] = parsed[index][column]?.[0] ?? table[property][0];
      }
      coordinates[m.id] = coords;
    }
  } else {
    // No slashes anywhere: one column, and every member gets `Default`. Two
    // members sharing a coordinate is a duplicate Figma would also produce, and
    // the author's next move is to change a cell — not to be told the combine
    // failed because they had not named anything.
    const property = labels.property(1);
    table[property] = [labels.firstValue];
    for (const m of members) coordinates[m.id] = { [property]: labels.firstValue };
  }

  const setName = parseSlashNaming(members.map((m) => m.name ?? "")).setName;
  const assembled = assembleComponentSet(doc, members[0], members, {
    properties: table,
    coordinates,
    name: setName || members[0].name
  });
  if (!assembled) return null;
  return { doc: assembled.doc, setId: assembled.set.id, name: assembled.set.name ?? "" };
}

/** Renames the set itself. Nothing else moves — no member name mentions it. */
export function renameComponentSet(
  doc: DesignDocument,
  setId: string,
  name: string
): DesignDocument | null {
  const target = name.trim();
  if (!target) return null;
  const set = locateSet(doc, setId);
  if (!set || set.name === target) return null;
  return withElementReplaced(doc, setId, () => ({ ...set, name: target }));
}

/** Figma's collapse: paint the first variant, keep the box. */
export function setComponentSetCollapsed(
  doc: DesignDocument,
  setId: string,
  collapsed: boolean
): DesignDocument | null {
  const set = locateSet(doc, setId);
  if (!set || Boolean(set.collapsed) === collapsed) return null;
  return withElementReplaced(doc, setId, () => {
    const next: ComponentSetElement = { ...set };
    if (collapsed) next.collapsed = true;
    else delete next.collapsed;
    return next;
  });
}

export { dissolveComponentSet };
