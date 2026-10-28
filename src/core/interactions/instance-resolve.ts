import {
  ComponentElement,
  ComponentOverride,
  ContainerElement,
  DesignDocument,
  DesignElement,
  FrameElement,
  InstanceElement,
  Paint,
  Page,
  Stroke,
  TextElement,
  TextSpan,
  OVERRIDABLE_PROPERTIES,
  getActivePage,
  updateActivePageElements
} from "../dsl/types";
import { effectiveStrokes, topLayer } from "../dsl/paint-stack";
import { deepEqual } from "../deep-equal";
import { isContainer, mapElements, findElementById } from "../geometry/tree-ops";
import { resolveInstanceBox, resolveInstanceNumberMode, resolveInstanceTheme } from "./instance-inherit";
import { applyConstraintsToChildren } from "../geometry/constraints";
import { relayoutDocumentTree } from "../compile";
import { findMasterComponent } from "./component-inventory";
import { layoutOf, withLayout } from "../dsl/layout-flat";
import { instanceScaleOf, scaleLayout, scaleSubtreeAbout } from "../geometry/scale-geometry";
import { syncDualStorage } from "./style-sync";
import { resolveChildSize } from "../layout/context";
import type { StyleTables } from "./style-tables";

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * How an instance's subtree comes into being, and how an edit to that subtree
 * becomes an override on the instance that owns it.
 *
 * Both halves live together because they are the same question asked twice: the
 * resolution decides which nodes EXIST (derived ids, the master chain, cloned
 * children), and the override path decides which of them an instance may OWN.
 * Split out of `component-ops.ts` (AGENTS.md §9): this module reads a document
 * and derives from it, `component-ops` writes whole-document commands.
 */

const OVERRIDABLE_PROPS: readonly ComponentOverride["property"][] = OVERRIDABLE_PROPERTIES;

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

/**
 * Resolved-instance ids are DERIVED, never minted: `<instanceId>_<masterNodeId>`.
 * `SvgElementRenderer` paints an instance by resolving it, and `CanvasDefs` emits
 * its `<defs>` by resolving it again — two independent calls that must agree on
 * every id a clone references. A minted id would make them disagree (gradient /
 * filter / clip / mask references resolve to nothing) and would change on every
 * render, remounting the whole subtree.
 */
function cloneSubtreeWithDerivedIds(
  element: DesignElement,
  prefix: string,
  idMap: Map<string, string>,
  ownerId: string,
  chain: readonly string[]
): DesignElement {
  const derivedId = `${prefix}_${element.id}`;
  idMap.set(element.id, derivedId);

  if (isContainer(element)) {
    const clonedChildren = (element.children || []).map((child) =>
      cloneSubtreeWithDerivedIds(child, prefix, idMap, ownerId, chain)
    );
    return {
      ...element,
      id: derivedId,
      children: clonedChildren,
      __masterNodeId: element.id,
      __instanceId: ownerId,
      __masterChain: chain
    };
  }

  return {
    ...element,
    id: derivedId,
    __masterNodeId: element.id,
    __instanceId: ownerId,
    __masterChain: chain
  };
}

/**
 * Appends `ov` to the override list of the nested instance named by `nestedId`.
 * The clone is a fresh object built for this resolution, so writing into it
 * cannot reach the master; the nested instance resolves later and reads it there.
 */
function applyNestedOverride(
  elements: DesignElement[],
  nestedId: string,
  ov: ComponentOverride
): boolean {
  for (let i = 0; i < elements.length; i++) {
    const el = elements[i];
    if (el.id === nestedId && el.type === "instance") {
      const inst = el as InstanceElement;
      elements[i] = { ...inst, overrides: [...(inst.overrides || []), ov] };
      return true;
    }
    if (isContainer(el) && el.children && applyNestedOverride(el.children, nestedId, ov)) {
      return true;
    }
  }
  return false;
}

/**
 * Writes the mode / binding overrides onto the freshly cloned subtree, in place.
 *
 * In place is safe and deliberate: the array is built for this resolution alone,
 * and the nodes in it are copies the master never sees.
 *
 * Direct targets only. A path form names a node inside a NESTED instance, and
 * that instance's own resolution is where its mode is decided — it runs this very
 * pass on its own overrides, so reaching in from here would apply the mode to the
 * outer pass and never enter the materialisation the tail is measured by.
 */
function applyPreMaterializeOverrides(
  elements: DesignElement[],
  instance: InstanceElement,
  idMap: Map<string, string>
): void {
  for (const ov of instance.overrides || []) {
    if (!PRE_MATERIALIZE_PROPERTIES.has(ov.property)) continue;
    if (ov.targetId.indexOf("/") > 0) continue;
    applyPropertyToSubtree(elements, idMap.get(ov.targetId) || ov.targetId, ov.property, ov.value);
  }
}

/**
 * Drops the derived markers a resolved clone carries, making the subtree real.
 *
 * Detaching hands the clones over as an ordinary frame's children, but they were
 * minted with `__instanceId` / `__masterNodeId`. Left in place, every path that
 * refuses "an edit to a node the document tree does not contain" — transform
 * handles, drag, Delete, nudge, align, the inspector's instance strip — goes on
 * refusing them, so a detached instance would stay uneditable: the exact
 * opposite of what detaching is for.
 */
export function stripDerivedMarkers(el: DesignElement): DesignElement {
  const copy: Record<string, unknown> = { ...el };
  delete copy.__instanceId;
  delete copy.__masterNodeId;
  delete copy.__masterChain;
  const node = copy as unknown as DesignElement;
  if (!isContainer(node)) return node;
  const children = (node as ContainerElement).children;
  return children && children.length > 0
    ? ({ ...node, children: children.map(stripDerivedMarkers) } as DesignElement)
    : node;
}

/**
 * Whether the document tree STORES a node under this id — the other half of
 * `isDerivedNode`, and a question `editableIds` deliberately cannot answer: it
 * keeps an id with no element behind it, because a resolved clone is still
 * draggable through its override path.
 *
 * A command that writes back BY id needs this one. Without it a derived-only
 * selection looked writable to Cut and Duplicate, which collected no sources and
 * committed nothing, and to Lock and Flatten, which committed a step that changed
 * nothing at all.
 */
export function isStoredNode(doc: DesignDocument, id: string): boolean {
  return findElementById(getActivePage(doc).children, id) !== null;
}

/** True when at least one of `ids` names a node the document tree stores. */
export function hasStoredSelection(doc: DesignDocument, selectedIds: Iterable<string>): boolean {
  for (const id of selectedIds) if (isStoredNode(doc, id)) return true;
  return false;
}

/**
 * A text-on-path only stays valid when its path travelled in the same clone, so
 * the reference is re-pointed at the clone. Copies are shallow, so this rebuilds
 * the node instead of assigning into it — mutating `onPath.pathId` here would
 * rewrite the master's own element.
 */
function relinkOnPath(node: DesignElement, idMap: Map<string, string>): DesignElement {
  const onPath = (node as any).onPath;
  const next: DesignElement =
    onPath && typeof onPath.pathId === "string" && idMap.has(onPath.pathId)
      ? ({ ...node, onPath: { ...onPath, pathId: idMap.get(onPath.pathId)! } } as DesignElement)
      : node;
  if (isContainer(next)) {
    return { ...next, children: (next.children || []).map((c) => relinkOnPath(c, idMap)) };
  }
  return next;
}

export function resolveInstanceChildren(
  instance: InstanceElement,
  master: ComponentElement
): DesignElement[] {
  return resolveInstanceContent(instance, master).children;
}

/**
 * The master's resolved subtree AND the outer box it laid itself out into.
 *
 * The two have to travel together. The layout pass below computes a size and the
 * caller has to paint at it: when the master hugs an axis, the size the pass
 * arrives at is the content's, and a caller that kept the instance's stored
 * `width` would lay the children out at one size and draw the instance's chrome
 * at another. A pill whose label outgrew it clipped in exactly that way.
 */
export interface ResolvedInstanceContent {
  children: DesignElement[];
  /** Differs from the instance's stored box exactly when the master hugs. */
  width: number;
  height: number;
}

export interface InstanceResolveOptions {
  /** The COLOUR mode the instance renders under, which may come from an ancestor container. */
  theme?: string;
  /** The NUMBER mode the instance renders under; independent of `theme`. */
  numberMode?: string;
  /** Required with `theme`: the tables the cloned master content is re-materialized against. */
  tables?: StyleTables;
}

/**
 * Everything a resolution reads, except `x` / `y`.
 *
 * A move changes nothing here: the position reaches the synthetic layout frame
 * and never a child's local coordinate, so a dragged instance resolves to the
 * SAME `children` array and the same clone objects every frame. That is what
 * keeps `<ElementDefs>` and `MemoizedSvgNode` from rebuilding a subtree nothing
 * moved.
 */
interface ResolveSignature {
  width: number | undefined;
  height: number | undefined;
  sizing: InstanceElement["sizing"];
  sizeOverride: boolean | undefined;
  scaleX: number;
  scaleY: number;
  overrides: ComponentOverride[] | undefined;
  themeMode: string | undefined;
  numberMode: string | undefined;
  /** The modes the CALLER resolved for this instance (see `InstanceResolveOptions`). */
  theme: string | undefined;
  inheritedNumberMode: string | undefined;
  tables: StyleTables | undefined;
  chain: readonly string[];
}

/** A nested instance's resolved size, the one `core/layout` input that lives outside this key. */
interface NestedSize {
  el: DesignElement;
  width: number;
  height: number;
}

interface ResolveEntry {
  signature: ResolveSignature;
  nested: NestedSize[];
  result: ResolvedInstanceContent;
}

/**
 * A cap per master, not a lifetime: instances are few, but an Alt-drag mints new
 * ids and their clones would otherwise accumulate until the master is replaced.
 */
const RESOLVE_CACHE_LIMIT = 64;
const resolvedByMaster = new WeakMap<ComponentElement, Map<string, ResolveEntry>>();

function sameSignature(a: ResolveSignature, b: ResolveSignature): boolean {
  if (a.width !== b.width || a.height !== b.height) return false;
  if (a.sizing !== b.sizing || a.sizeOverride !== b.sizeOverride) return false;
  if (a.scaleX !== b.scaleX || a.scaleY !== b.scaleY) return false;
  if (a.overrides !== b.overrides) return false;
  if (a.themeMode !== b.themeMode || a.numberMode !== b.numberMode) return false;
  if (a.theme !== b.theme || a.inheritedNumberMode !== b.inheritedNumberMode) return false;
  if (a.tables?.tokens !== b.tables?.tokens || a.tables?.styles !== b.tables?.styles) return false;
  if (a.chain.length !== b.chain.length) return false;
  for (let i = 0; i < a.chain.length; i++) if (a.chain[i] !== b.chain[i]) return false;
  return true;
}

/**
 * The size the layout pass would measure this child at right now.
 *
 * A nested instance's box is the ONE part of a resolution that can change
 * without the master object changing: `relayoutDocumentTree` asks the store's
 * ambient resolver, which resolves the nested instance against the document.
 * Everything else the pass reads is on the master or the instance.
 */
function ambientBox(el: DesignElement): { width: number; height: number } {
  return resolveChildSize()?.(el) ?? { width: el.width, height: el.height };
}

function nestedSizes(children: DesignElement[]): NestedSize[] {
  const out: NestedSize[] = [];
  const walk = (list: DesignElement[]) => {
    for (const el of list) {
      if (el.type === "instance") {
        const box = ambientBox(el);
        out.push({ el, width: box.width, height: box.height });
      }
      if (isContainer(el)) walk(el.children || []);
    }
  };
  walk(children);
  return out;
}

function nestedSizesHold(recorded: NestedSize[]): boolean {
  for (const row of recorded) {
    const box = ambientBox(row.el);
    if (box.width !== row.width || box.height !== row.height) return false;
  }
  return true;
}

export function resolveInstanceContent(
  instance: InstanceElement,
  master: ComponentElement,
  options?: InstanceResolveOptions
): ResolvedInstanceContent {
  // A master that already sits on the path that produced this clone would expand
  // into itself forever: resolving it yields a nested instance pointing back, and
  // the render pass — which resolves again for every nested instance it paints —
  // never comes back up. The chain rides on the clone rather than being threaded
  // through the callers, so the renderer, `CanvasDefs` and the layer rows all cut
  // the cycle at the same place without having to know it exists. A document can
  // only get here from outside (every write path refuses a cycle), so this is
  // the difference between a red placeholder and a blank canvas.
  const chain = (instance as { __masterChain?: readonly string[] }).__masterChain || [];
  if (chain.includes(master.id)) return { children: [], width: instance.width, height: instance.height };
  const nextChain = [...chain, master.id];

  const scale = instanceScaleOf(instance);
  const signature: ResolveSignature = {
    width: instance.width,
    height: instance.height,
    sizing: instance.sizing,
    sizeOverride: instance.sizeOverride,
    scaleX: scale.x,
    scaleY: scale.y,
    overrides: instance.overrides,
    themeMode: instance.themeMode,
    numberMode: instance.numberMode,
    theme: options?.theme,
    inheritedNumberMode: options?.numberMode,
    tables: options?.tables,
    chain
  };
  const bucket = resolvedByMaster.get(master);
  const cached = bucket?.get(instance.id);
  if (cached && sameSignature(cached.signature, signature) && nestedSizesHold(cached.nested)) {
    return cached.result;
  }

  const idMap = new Map<string, string>();
  const cloned: DesignElement[] = (master.children || []).map((child) =>
    cloneSubtreeWithDerivedIds(child, instance.id, idMap, instance.id, nextChain)
  );
  // Relink only once every clone exists — a text can reference a path that is a
  // later sibling, and the map is still filling up while the clones are built.
  // Relinking rebuilds nodes, so everything below works on the relinked array.
  const clonedChildren = cloned.map((child) => relinkOnPath(child, idMap));

  // The instance's own box, resolved once: it drives the layout pass below AND
  // the constraint baseline, so both have to read the same numbers.
  const box = resolveInstanceBox(instance, master);

  const theme = options?.theme ? resolveInstanceTheme(instance, master, options.theme) : undefined;
  const numberMode = options?.numberMode
    ? resolveInstanceNumberMode(instance, master, options.numberMode)
    : theme;
  const tables = options?.tables;
  const themed = (children: DesignElement[]): DesignElement[] =>
    theme && tables ? children.map((child) => syncDualStorage(child, tables, theme, numberMode)) : children;

  // Applied BEFORE the pass, not with the rest below: these two decide WHICH mode
  // and WHICH token value the pass materialises. See `PRE_MATERIALIZE_PROPERTIES`.
  applyPreMaterializeOverrides(clonedChildren, instance, idMap);

  // Re-materialized BEFORE the layout pass, not after it. A number token can
  // carry a different value per mode, so measuring the box with one mode's
  // numbers and drawing it with another's lays the subtree out for a size it
  // does not have — the pass would then be the thing that put the text it just
  // measured outside the box it just measured it for.
  const themedChildren = themed(clonedChildren);

  // A scaled instance is the master's subtree at another size, and the factor has
  // to reach every length inside it — type size, padding, gap, coordinates,
  // radii. It is applied to the CLONES, never to the master, which is what keeps
  // the master and its other instances at 1x.
  const scaled = scale.x !== 1 || scale.y !== 1;
  const baseWidth = scaled ? round2(master.width * scale.x) : master.width;
  const baseHeight = scaled ? round2(master.height * scale.y) : master.height;
  const children = scaled
    ? themedChildren.map((child) => scaleSubtreeAbout(child, { x: 0, y: 0 }, scale.x, scale.y))
    : themedChildren;

  // Overrides land on the SCALED clones, not on the master's own numbers. The
  // Inspector reads a resolved node, so the number it shows — and the number the
  // user types over it — is already in the instance's space: writing it before
  // the scale would multiply it by the factor a second time, and editing the type
  // of one headline would come back half the size the user asked for.
  if (instance.overrides && instance.overrides.length > 0) {
    // Two passes, and the ORDER is load-bearing. A direct `componentId` override
    // replaces a nested instance's master and drops the overrides its own clone
    // carried — they described the old master's layers. A path override
    // (`slot/dot`) is handed to that SAME clone, so it has to arrive after the
    // wipe that clears the stale ones, or a swap would delete the very overrides
    // `swapNestedInstance` just remapped onto the new master.
    for (const ov of instance.overrides) {
      // Already on the clone — they were the input to the materialisation above.
      if (PRE_MATERIALIZE_PROPERTIES.has(ov.property)) continue;
      if (ov.targetId.indexOf("/") > 0) continue;
      applyPropertyToSubtree(children, idMap.get(ov.targetId) || ov.targetId, ov.property, ov.value);
    }
    for (const ov of instance.overrides) {
      // A path (`slot/dot`) names a node inside a NESTED instance. This pass only
      // ever resolves one master deep, so it cannot reach it — hand the tail to
      // the nested instance clone, which applies it to its own children when the
      // renderer resolves IT. Without this a deep override matched nothing and
      // silently did nothing, which is why only the outermost layer of an
      // instance used to be editable at all.
      const slash = ov.targetId.indexOf("/");
      if (slash <= 0) continue;
      const nestedId = idMap.get(ov.targetId.slice(0, slash)) || ov.targetId.slice(0, slash);
      applyNestedOverride(children, nestedId, {
        targetId: ov.targetId.slice(slash + 1),
        property: ov.property,
        value: ov.value
      });
    }
  }

  if (layoutOf(master)) {
    // The instance owns the outer box, while the master owns the layout recipe.
    // Re-run that recipe against the instance's stored width/height so a prop
    // change reflows its children inside the instance instead of leaving the
    // master coordinates frozen in place.
    //
    // The recipe INCLUDES its hug. Dropping `sizing` (which is what this used to
    // do) pinned the pass to the instance's stored box, so a master that hugs —
    // a tag, a chip, anything sized by its own label — laid its children out at
    // a fixed width and the content overflowed instead of growing the pill.
    // `sizeOverride` is the user's "this box is mine": there the stored number
    // wins and the axis stays fixed. `fill` is unaffected either way — a
    // parentless frame has nothing to distribute from and falls back to fixed.
    //
    // The instance's OWN `sizing` outranks the master's, and only because
    // `withAxisMode` pins an axis to `fixed` via `sizeOverride`: that is what makes
    // one axis of a hugging instance fixed while the other keeps hugging. An
    // instance that never expressed an opinion carries the master's, which is what
    // `createInstanceFromComponent` and `propagateMasterSize` keep it equal to.
    //
    // A SCALED instance re-runs the recipe at its own proportions: the padding,
    // gaps and tracks scale with the factor, so the box the pass arrives at is
    // master × factor rather than a 1x layout crammed into a smaller box.
    const synthetic: FrameElement = {
      ...(scaled ? withLayout(master, scaleLayout(layoutOf(master)!, scale.x, scale.y, Math.min(scale.x, scale.y))) : master),
      id: instance.id,
      type: "frame",
      x: instance.x,
      y: instance.y,
      width: box.width,
      height: box.height,
      sizing: instance.sizing ?? (instance.sizeOverride ? undefined : master.sizing),
      children
    };
    const laid = relayoutDocumentTree([synthetic])[0] as FrameElement;
    return remember(master, instance.id, signature, {
      children: laid.children || [],
      width: laid.width,
      height: laid.height
    });
  }

  // No layout in the master: its children carry their own coordinates, so the
  // instance's size has to reach them the same way a frame resize does — a
  // constraint pass. The baseline is the MASTER's box at the instance's own
  // factor, never "the size the instance had last time": resolution runs on every
  // render, so an incremental transform would drift instead of converging.
  const constrained = applyConstraintsToChildren(
    children,
    { x: 0, y: 0, width: baseWidth, height: baseHeight },
    { x: 0, y: 0, width: box.width, height: box.height }
  );
  // A SCALED instance re-runs the layout of its own subtree instead of only
  // multiplying numbers. Every factor above reaches a box, never a measurement:
  // a `max-content` text keeps `master.width × k`, which is not what the text
  // measures at the scaled font — and a box a fraction short of its own glyphs
  // breaks the line that fitted at 1x. `relayoutDocumentTree` is the pass that
  // measures (and re-flows the stacks inside the master), which is exactly why
  // the same subtree nested as a COMPONENT never showed the symptom: that path
  // already resolved through a layout master.
  const settled = scaled ? relayoutDocumentTree(constrained) : constrained;
  return remember(master, instance.id, signature, {
    children: settled,
    width: box.width,
    height: box.height
  });
}

/** Stores a resolution for the next frame that asks the same question. */
function remember(
  master: ComponentElement,
  instanceId: string,
  signature: ResolveSignature,
  result: ResolvedInstanceContent
): ResolvedInstanceContent {
  let bucket = resolvedByMaster.get(master);
  if (!bucket) {
    bucket = new Map();
    resolvedByMaster.set(master, bucket);
  }
  bucket.delete(instanceId);
  bucket.set(instanceId, { signature, nested: nestedSizes(result.children), result });
  if (bucket.size > RESOLVE_CACHE_LIMIT) {
    const oldest = bucket.keys().next().value;
    if (oldest !== undefined) bucket.delete(oldest);
  }
  return result;
}

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

/**
 * Properties the MATERIALISATION pass reads, and which therefore have to land on
 * the clone before it runs.
 *
 * `syncDualStorage` picks a mode off `themeMode` and resolves every numeric token
 * it finds in `tokenBindings`, so an override written after that pass paints the
 * master's numbers — and keeps painting them until some unrelated edit re-resolves
 * the subtree. Everything else lands after the scale instead, because the numbers
 * an inspector shows (and the user types over) are already in the instance's own
 * space.
 */
const PRE_MATERIALIZE_PROPERTIES: ReadonlySet<ComponentOverride["property"]> = new Set([
  "themeMode",
  "numberMode",
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

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** An empty run set means "no runs", which is what an absent `spans` says. */
function emptyAsUndefined<T>(value: T[] | undefined): T[] | undefined {
  return Array.isArray(value) && value.length === 0 ? undefined : value;
}

/**
 * Merge a bag delta onto what the clone already carries, dropping the keys the
 * delta names as `undefined` — unbinding is a CHANGE, and a key left present with
 * no value would still shadow the master's binding.
 */
function mergedBag(current: unknown, delta: Record<string, unknown>): Record<string, unknown> | undefined {
  const merged: Record<string, unknown> = { ...(isPlainRecord(current) ? current : {}) };
  for (const [key, value] of Object.entries(delta)) {
    if (value === undefined) delete merged[key];
    else merged[key] = value;
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
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
  return {
    ...updateActivePageElements(doc, elements),
    updatedAt: new Date().toISOString()
  };
}

/**
 * Writes a value onto ONE property of every node whose id is `targetId`, inside
 * an already-resolved clone list. `false` means nothing was written — the id was
 * not found, or the property does not apply to that node type.
 *
 * The return value is load-bearing: a caller looking for "the property landed"
 * used to get `true` from the mere fact that the id matched, which is how a
 * property bound to the wrong layer (or to the wrong property) became a panel
 * row that could be edited forever and drew nothing.
 */
export function applyPropertyToSubtree(
  elements: DesignElement[],
  targetId: string,
  property: ComponentOverride["property"],
  value: unknown
): boolean {
  for (let i = 0; i < elements.length; i++) {
    const el = elements[i];
    if (el.id === targetId) {
      const updated = { ...el } as any;
      let wrote = true;
      if (property === "content" && el.type === "text") {
        updated.content = String(value);
      } else if (property === "style" && el.type === "text") {
        // Merge, never replace: a panel writes one axis (fontSize, colour…) and a
        // wholesale assignment would silently drop every other axis with it.
        updated.style = { ...((el as TextElement).style || {}), ...(value as object) };
      } else if (property === "spans" && el.type === "text") {
        // Copied, not adopted: the value is the stored override, shared by every
        // resolution of this instance, so handing it to the clone would let a
        // later in-place edit reach back into the document.
        const spans = emptyAsUndefined(
          Array.isArray(value) ? (JSON.parse(JSON.stringify(value)) as TextSpan[]) : undefined
        );
        if (spans) updated.spans = spans;
        else delete updated.spans;
      } else if (property === "tokenBindings") {
        updated.tokenBindings = mergedBag(el.tokenBindings, (value || {}) as Record<string, unknown>);
      } else if (property === "themeMode") {
        updated.themeMode =
          value === undefined || value === null || value === "" ? undefined : String(value);
      } else if (property === "numberMode") {
        updated.numberMode =
          value === undefined || value === null || value === "" ? undefined : String(value);
      } else if (
        property === "fillStyleId" ||
        property === "strokeStyleId" ||
        property === "textStyleId" ||
        property === "effectStyleId"
      ) {
        updated[property] = value ?? undefined;
      } else if (property === "fills") {
        updated.fills = value;
      } else if (property === "effects") {
        updated.effects = Array.isArray(value) ? value : undefined;
      } else if (property === "adjust") {
        updated.adjust = value;
      } else if (property === "borderRadius") {
        updated.borderRadius = value;
      } else if (property === "cornerSmoothing") {
        updated.cornerSmoothing = typeof value === "number" ? Math.min(1, Math.max(0, value)) : undefined;
      } else if (property === "blendMode") {
        updated.blendMode = value;
      } else if (property === "strokes") {
        // `strokes` is what renders, so an override that wrote only the shorthand
        // stayed invisible on every element that already carried a stack.
        const stack = Array.isArray(value)
          ? (value as Stroke[])
          : value
            ? [value as Stroke]
            : undefined;
        if (stack) updated.strokes = stack;
        else delete updated.strokes;
      } else if (property === "visible") {
        updated.visible = Boolean(value);
      } else if (property === "fillEnabled") {
        updated.fillEnabled = Boolean(value);
      } else if (property === "opacity") {
        updated.opacity = Number(value);
      } else if (property === "clipContent") {
        updated.clipContent = Boolean(value);
      } else if (property === "locked") {
        updated.locked = Boolean(value);
      } else if (property === "link") {
        // Clearing the field has to be storable, and `undefined` on the clone is
        // exactly that: the resolved node stops carrying the master's URL. A
        // deleted key would fall back to the master on the next resolve.
        updated.link = value === undefined || value === null || value === "" ? undefined : String(value);
      } else if (property === "componentId") {
        updated.componentId = String(value);
        // The nested instance's own props/overrides described the OLD master's
        // layers, so they go with it; the clone has none of its own, and the outer
        // instance's overrides on those layers are keyed by master node id, so
        // they simply stop matching.
        delete updated.props;
        delete updated.overrides;
      } else if (property === "assetId") {
        const assetId = String(value);
        if (el.type === "video") {
          updated.assetId = assetId;
        } else {
          const layers = (updated.fills || []) as Paint[];
          updated.fills = layers.some((p) => p.type === "image")
            ? layers.map((p) => (p.type === "image" ? { ...p, assetId } : p))
            : [...layers, { type: "image", assetId, fit: "cover" }];
        }
      } else {
        wrote = false;
      }
      if (!wrote) return false;
      elements[i] = updated;
      return true;
    }
    if (isContainer(el) && el.children) {
      if (applyPropertyToSubtree(el.children, targetId, property, value)) {
        return true;
      }
    }
  }
  return false;
}
