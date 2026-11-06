import {
  ComponentElement,
  ComponentOverride,
  DesignDocument,
  DesignElement,
  InstanceElement,
  Page,
  TextElement,
  OVERRIDABLE_PROPERTIES,
  getActivePage,
  updateActivePageElements
} from "../dsl/types";
import { effectiveStrokes } from "../dsl/paint-stack";
import { deepEqual } from "../deep-equal";
import { relayoutDocumentTree } from "../compile";
import { isContainer, mapElements } from "../geometry/tree-ops";
import { findMasterComponent } from "./component-inventory";
import { instanceSizeResolver, resolveInstanceChildren } from "./instance-resolve";
import { emptyAsUndefined, isPlainRecord } from "./override-shape";

/**
 * The WRITE half of the instance machinery: which nodes an instance may own, and
 * how an edit made to one of them becomes an override on the instance.
 *
 * Split from `instance-resolve` (AGENTS §8), and the seam is a question, not a
 * line count: that module answers "which nodes EXIST" and runs on every frame of
 * a drag, this one answers "what did the user change" and runs when a commit
 * lands. The read path never calls into this file — the one thing they share is
 * the resolution itself, which the read half owns.
 */

export interface InstanceSelection {
  instanceId: string;
  masterNodeId: string;
  instance: InstanceElement;
  master: ComponentElement;
  /** The resolved clone the user actually clicked. */
  node: DesignElement;
  /** False when the node cannot be addressed at all: an override keyed on it
   * would have nowhere to live. */
  overridable: boolean;
}

const OVERRIDABLE_PROPS: readonly ComponentOverride["property"][] = OVERRIDABLE_PROPERTIES;

/** `findResolvedNode`, keeping every step it walked through on the way. */
function findResolvedPath(
  doc: DesignDocument,
  el: DesignElement,
  id: string
): DesignElement[] | null {
  if (el.id === id) return [el];
  if (el.type === "instance") {
    const master = findMasterComponent(doc, (el as InstanceElement).componentId);
    if (master) {
      for (const child of resolveInstanceChildren(el as InstanceElement, master)) {
        const found = findResolvedPath(doc, child, id);
        if (found) return [el, ...found];
      }
    }
    return null;
  }
  if (isContainer(el)) {
    for (const child of el.children || []) {
      const found = findResolvedPath(doc, child, id);
      if (found) return [el, ...found];
    }
  }
  return null;
}

/**
 * Turns a rendered clone id back into the instance and master node it came
 * from. Ids are minted with underscores (`inst_x1_time_1`), so slicing the id
 * apart is ambiguous — the owning instance is the longest id that prefixes it.
 */
export function resolveInstanceSelection(
  doc: DesignDocument,
  derivedId: string
): InstanceSelection | null {
  const instances: InstanceElement[] = [];
  const collect = (els: DesignElement[]) => {
    for (const el of els) {
      if (el.type === "instance") instances.push(el as InstanceElement);
      if (isContainer(el)) collect(el.children || []);
    }
  };
  const pages: Page[] =
    doc.pages && doc.pages.length > 0 ? doc.pages : [{ id: "", name: "", canvas: doc.canvas, children: getActivePage(doc).children || [] }];
  for (const page of pages) collect(page.children || []);

  let owner: InstanceElement | null = null;
  for (const inst of instances) {
    if (!derivedId.startsWith(`${inst.id}_`)) continue;
    if (!owner || inst.id.length > owner.id.length) owner = inst;
  }
  if (!owner) return null;

  const master = findMasterComponent(doc, owner.componentId);
  if (!master) return null;

  let path: DesignElement[] | null = null;
  for (const child of resolveInstanceChildren(owner, master)) {
    const found = findResolvedPath(doc, child, derivedId);
    if (found) {
      path = [owner as DesignElement, ...found];
      break;
    }
  }
  const node = path && path.length > 0 ? path[path.length - 1] : null;
  if (!node) return null;

  /**
   * The master node ids from the instance down to this node, one per instance
   * crossing, joined with `/`.
   *
   * Within a single master the bare id is enough — the resolution walks frames
   * recursively — so only a step that descends INTO another instance starts a
   * new segment. `slot/dot` is therefore the dot inside the icon instance inside
   * the card instance, and `content/icon` is not a thing: the frame is part of
   * the same master and the id stays `icon`.
   */
  const steps: string[] = [];
  for (let i = 1; i < path!.length; i++) {
    const id = path![i].__masterNodeId || "";
    if (i > 1 && path![i - 1].type === "instance") steps.push(id);
    else if (steps.length === 0) steps.push(id);
    else steps[steps.length - 1] = id;
  }
  return {
    instanceId: owner.id,
    masterNodeId: steps.join("/"),
    instance: owner,
    master,
    node,
    overridable: steps.length > 0 && steps.every((step) => step !== "")
  };
}

/**
 * Properties whose override value is a BAG of sub-keys rather than one value.
 *
 * `diffOverridable` reports `style` as a per-axis delta — that is what keeps an
 * instance following its master for every axis the user never touched — so writing
 * it is a merge too. See `setInstanceOverride`. `tokenBindings` is the same shape
 * for the same reason: binding a radius token must not unbind a type-size one.
 */
const BAG_PROPERTIES: ReadonlySet<ComponentOverride["property"]> = new Set([
  "style",
  "tokenBindings"
]);

export function setInstanceOverride(
  instance: InstanceElement,
  override: ComponentOverride
): InstanceElement {
  const currentOverrides = instance.overrides ? [...instance.overrides] : [];
  const idx = currentOverrides.findIndex(
    (o) => o.targetId === override.targetId && o.property === override.property
  );
  if (idx >= 0) {
    const previous = currentOverrides[idx];
    // One override slot per (node, property), but a bag holds many keys: the
    // second edit to a node's style or a nested instance's properties arrives as
    // a delta for the key it touched, and REPLACING the entry dropped every key
    // an earlier edit had written. Editing `color` then `fontSize` sent the colour
    // back to the master; editing one nested property then another left only the
    // second. Merging keeps the slot unique and the earlier keys alive.
    currentOverrides[idx] =
      BAG_PROPERTIES.has(override.property) &&
      isPlainRecord(previous.value) &&
      isPlainRecord(override.value)
        ? { ...previous, value: { ...previous.value, ...override.value } }
        : override;
  } else {
    currentOverrides.push(override);
  }
  return {
    ...instance,
    overrides: currentOverrides
  };
}

function diffOverridable(before: DesignElement, after: DesignElement): ComponentOverride[] {
  const out: ComponentOverride[] = [];
  for (const prop of OVERRIDABLE_PROPS) {
    if (prop === "style" || prop === "tokenBindings") {
      // A bag of keys, so diff it per key: storing the whole object would pin
      // fontFamily (or every other binding) onto this instance forever and it
      // would stop following the master for the keys the user never touched.
      const a = ((before as any)[prop] || {}) as Record<string, unknown>;
      const b = ((after as any)[prop] || {}) as Record<string, unknown>;
      const delta: Record<string, unknown> = {};
      for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
        if (!deepEqual(a[key], b[key])) delta[key] = b[key];
      }
      if (Object.keys(delta).length > 0) out.push({ targetId: "", property: prop, value: delta });
      continue;
    }
    if (prop === "spans") {
      // `[]` and `undefined` are the same run set — "one style for the whole
      // string" — so they must not read as a change against each other, or
      // deleting the last span would write an override that says nothing.
      const a = emptyAsUndefined((before as TextElement).spans);
      const b = emptyAsUndefined((after as TextElement).spans);
      if (deepEqual(a, b)) continue;
      out.push({ targetId: "", property: prop, value: b });
      continue;
    }
    // The presence rule above cannot decide these: `undefined` is not "unset"
    // here, it is the DEFAULT, and the default is `true` for both — an absent
    // `visible` means shown and an absent `fillEnabled` means the stack paints.
    // So hiding a layer that never spelled it out, or switching off a fill that
    // never spelled out that it was on, is a change from true to false and has to
    // be written.
    if (prop === "visible" || prop === "fillEnabled") {
      const a = (before as any)[prop] !== false;
      const b = (after as any)[prop] !== false;
      if (a !== b) out.push({ targetId: "", property: prop, value: b });
      continue;
    }
    if (
      prop === "fillStyleId" ||
      prop === "strokeStyleId" ||
      prop === "textStyleId" ||
      prop === "effectStyleId"
    ) {
      // Detaching a style only DELETES the id, and a deleted field is not a
      // change: `before` and `after` both read `undefined` and nothing is written,
      // so the Detach button on a child inside an instance reported success and
      // changed nothing. `null` is what says "no style" in a way that survives
      // resolution — the master's id would otherwise come straight back.
      const a = (before as any)[prop] ?? null;
      const b = (after as any)[prop] ?? null;
      if (a !== b) out.push({ targetId: "", property: prop, value: b });
      continue;
    }
    if (prop === "clipContent" || prop === "locked") {
      const a = Boolean((before as any)[prop]);
      const b = Boolean((after as any)[prop]);
      if (a !== b) out.push({ targetId: "", property: prop, value: b });
      continue;
    }
    if (
      prop === "scrollOverflow" ||
      prop === "scrollX" ||
      prop === "scrollY" ||
      prop === "scrollBehavior"
    ) {
      const a = (before as any)[prop];
      const b = (after as any)[prop];
      if (a !== b) out.push({ targetId: "", property: prop, value: b });
      continue;
    }
    const a = prop === "strokes" ? effectiveStrokes(before) : (before as any)[prop];
    const b = prop === "strokes" ? effectiveStrokes(after) : (after as any)[prop];
    if (!a && !b) continue;
    if (a === b || deepEqual(a, b)) continue;
    out.push({ targetId: "", property: prop, value: b });
  }
  return out;
}

/**
 * True when running `updater` against a resolved node would change anything at
 * all. Lets a caller tell "the edit was refused because the instance does not own
 * that property" from "the updater changed nothing", so only the first case is
 * worth telling the user about.
 */
export function resolvedEditChangesNode(
  node: DesignElement,
  updater: (el: DesignElement) => DesignElement
): boolean {
  return !deepEqual(node, updater({ ...node }));
}

/**
 * The element edit that carries `updater`'s change on `selections` as overrides
 * on the owning instances — identity for every element that is not one of them.
 *
 * Split out of `commitInstanceOverrides` for a caller whose write runs through a
 * TREE rather than a document (the selection palette rewrites the page's element
 * list and hands it back), so that override construction has one implementation
 * and not two that can drift. The instance written is the one in the tree being
 * rewritten, not the snapshot the selection was resolved from.
 */
export function instanceOverridePatch(
  selections: readonly InstanceSelection[],
  updater: (el: DesignElement) => DesignElement
): (el: DesignElement) => DesignElement {
  const patches = new Map<string, ComponentOverride[]>();

  for (const sel of selections) {
    if (!sel.overridable) continue;
    const after = updater({ ...sel.node });
    const diffs = diffOverridable(sel.node, after);
    if (diffs.length === 0) continue;
    const list = patches.get(sel.instanceId) || [];
    for (const d of diffs) list.push({ ...d, targetId: sel.masterNodeId });
    patches.set(sel.instanceId, list);
  }
  if (patches.size === 0) return (el) => el;

  return (el) => {
    const list = el.type === "instance" ? patches.get(el.id) : undefined;
    if (!list) return el;
    let inst = el as InstanceElement;
    for (const ov of list) inst = setInstanceOverride(inst, ov);
    return inst;
  };
}

/**
 * Runs the inspector's element updater against resolved clones and writes the
 * difference as overrides on their instances. Returns null when the updater
 * changed nothing the instance is allowed to own.
 */
export function commitInstanceOverrides(
  doc: DesignDocument,
  selections: InstanceSelection[],
  updater: (el: DesignElement) => DesignElement
): DesignDocument | null {
  const patch = instanceOverridePatch(selections, updater);
  const elements = mapElements(getActivePage(doc).children, patch);
  if (elements === getActivePage(doc).children) return null;
  const withOverrides = updateActivePageElements(doc, elements);
  // An override changes what the instance paints — longer text, a bigger size,
  // a hidden icon — and the instance's stored box and its parent's auto-layout
  // only read that through the layout pass. Settling it HERE is what keeps a
  // hugging tag from overlapping its siblings until some unrelated edit happens
  // to re-run the layout.
  const laidOut = relayoutDocumentTree(
    getActivePage(withOverrides).children,
    instanceSizeResolver(withOverrides)
  );
  return {
    ...updateActivePageElements(withOverrides, laidOut),
    updatedAt: new Date().toISOString()
  };
}

