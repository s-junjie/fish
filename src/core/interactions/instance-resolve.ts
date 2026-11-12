import { ComponentElement, ComponentOverride, ContainerElement, DesignDocument, DesignElement, FrameElement, InstanceElement, type Overflow, Paint, Stroke, TextElement, TextSpan } from "../dsl/types";
import { getActivePage } from "../dsl/document-ops";
import { isContainer, findElementById } from "../geometry/tree-ops";
import { resolveInstanceBox, resolveInstanceNumberMode, resolveInstanceTheme } from "./instance-inherit";
import { applyConstraintsToChildren } from "../geometry/constraints";
import { relayoutDocumentTree } from "../compile";
import { findMasterComponent } from "./component-inventory";
import { overridableFor } from "./override-audit";
import { layoutOf, withLayout } from "../dsl/layout-flat";
import { instanceScaleOf, scaleLayout, scaleSizingBounds, scaleSubtreeAbout } from "../geometry/scale-geometry";
import { syncDualStorage } from "./style-sync";
import { resolveChildSize } from "../layout/context";
import { textMeasureRevision } from "../geometry/text-measure";
import { emptyAsUndefined, isPlainRecord } from "./override-shape";
import type { ChildSizeResolver } from "../layout/box";
import type { StyleTables } from "./style-tables";

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * How an instance's subtree comes into being: derived ids, the master chain,
 * cloned children, and the box the layout pass has to measure.
 *
 * This is the READ half — it runs on every frame that paints an instance, so it
 * holds no opinion about who may edit what. The write half (which nodes an
 * instance owns, how an edit becomes an override) lives in `instance-write`, and
 * re-exported below so callers keep one import. Split out of `component-ops.ts`
 * (AGENTS.md §9): this module reads a document and derives from it,
 * `component-ops` writes whole-document commands.
 */

export {
  commitInstanceOverrides,
  instanceOverridePatch,
  resolveInstanceSelection,
  resolvedEditChangesNode,
  setInstanceOverride
} from "./instance-write";
export type { InstanceSelection } from "./instance-write";

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
  /**
   * The generation of the font measurements this resolution was laid out with.
   *
   * A resolution ends in a layout pass, and that pass measures text. The inputs
   * above cannot see a font arriving — the master, the override list and the box
   * are untouched — so without this the instance kept the fallback face's boxes
   * for the rest of the session, and the freshly painted type overflowed a width
   * nobody re-measured.
   */
  measureRevision: number;
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
 * How many instance crossings a single resolution may descend through.
 *
 * A cycle is `chain.includes(master.id)` and is caught exactly. This is the other
 * pathological shape: a chain of DISTINCT masters, which is acyclic, legal and
 * unbounded — the renderer resolves one level per crossing, so a file 500 deep
 * exhausts the stack instead of drawing something wrong. 32 is far past any
 * nesting a design uses and well inside the call budget.
 */
const MAX_INSTANCE_DEPTH = 32;

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
  if (a.measureRevision !== b.measureRevision) return false;
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
  // The cycle check above only catches a master that REPEATS. A file can nest a
  // different master at every level — legal, acyclic, and 500 deep — and the
  // renderer resolves a level per crossing, so the recursion ends in a stack
  // overflow rather than in a wrong picture. The cap is the depth a design can
  // plausibly use; past it the instance paints its own box and nothing inside.
  if (chain.length >= MAX_INSTANCE_DEPTH) return { children: [], width: instance.width, height: instance.height };
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
    chain,
    measureRevision: textMeasureRevision()
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
    // master × factor rather than a 1x layout crammed into a smaller box. The
    // bounds that clamp a derived size are lengths of that box too.
    const sizing = instance.sizing ?? (instance.sizeOverride ? undefined : master.sizing);
    const synthetic: FrameElement = {
      ...(scaled ? withLayout(master, scaleLayout(layoutOf(master)!, scale.x, scale.y, Math.min(scale.x, scale.y))) : master),
      id: instance.id,
      type: "frame",
      x: instance.x,
      y: instance.y,
      width: box.width,
      height: box.height,
      sizing: scaled ? scaleSizingBounds(sizing, scale.x, scale.y) : sizing,
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

/**
 * The resolver a layout pass needs so an instance is measured by what it paints.
 *
 * An instance stores the box it was authored with; `resolveInstanceContent` is
 * what turns that into the box the master actually lays out into, which differs
 * whenever the master hugs. Without this the parent places siblings against the
 * stored number and a hugging instance overlaps them.
 *
 * Deliberately ONE level. The document tree's layout is what needs the real size
 * of a child; a master lays out its own children by its own recipe, and a nested
 * instance inside a master is that recipe's business. Recursing here would make
 * instance resolution re-enter the layout pass that called it.
 *
 * Lives HERE, built on `resolveInstanceContent` and `findMasterComponent`: the
 * override commit below has to measure the document it just wrote by the same
 * rule that resolves it, and a module pointing back at this one would close a
 * cycle. `./instance-size` re-exports it for every other caller.
 */
export function instanceSizeResolver(doc: DesignDocument): ChildSizeResolver {
  return (el: DesignElement) => {
    if (el.type !== "instance") return null;
    const inst = el as InstanceElement;
    const master = findMasterComponent(doc, inst.componentId);
    if (!master) return null;
    const resolved = resolveInstanceContent(inst, master);
    return { width: resolved.width, height: resolved.height };
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
      // The list the rest of the engine answers with: a property whose branch does
      // not exist for this node type is a no-op, and it says so in one place.
      if (!overridableFor(el).includes(property)) return false;
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
      } else if (property === "overflow") {
        updated.overflow = value as Overflow;
        delete updated.overflowX;
        delete updated.overflowY;
      } else if (property === "scrollX") {
        updated.scrollX = Math.max(0, Number(value) || 0);
      } else if (property === "scrollY") {
        updated.scrollY = Math.max(0, Number(value) || 0);
      } else if (property === "scrollBehavior") {
        updated.scrollBehavior = value as any;
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
