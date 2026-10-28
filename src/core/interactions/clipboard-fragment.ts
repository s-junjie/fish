import {
  AssetRef,
  ComponentElement,
  ContainerElement,
  DesignDocument,
  DesignElement,
  DesignStyle,
  DesignToken,
  InstanceElement,
  getActivePage,
  updateActivePageElements
} from "../dsl/types";
import { createId } from "../id";
import {
  isContainer,
  flattenElements,
  computeParentOrigin,
  findElementById,
  mapElements
} from "../geometry/tree-ops";
import { elementAABB } from "../geometry/element-bounds";
import type { Rect } from "../geometry/bounds";
import { relayoutDocumentTree } from "../compile";
import {
  offsetCenteringSourcesIn,
  resolvePastePlacement,
  translateTreeInPlace
} from "./clipboard";
import type { FishClipboardPayload } from "./clipboard-payload";
import { syncDualStorage } from "./style-ops";
import { layoutOf } from "../dsl/layout-flat";

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

/** Row spacing for parked masters; matches the gap `component-hoist` uses. */
const MASTER_ROW_GAP = 40;
const MASTER_ITEM_GAP = 12;

const STYLE_ID_KEYS = ["fillStyleId", "strokeStyleId", "effectStyleId", "textStyleId"] as const;

/**
 * Consuming half of the cross-file clipboard: a payload's definitions are reminted
 * into the destination's id space, then spliced in. The producing half is
 * `clipboard-payload.ts`, and the two are separate files because they run on
 * opposite sides of the system clipboard — one only on copy, the other only on
 * paste — and because the id remapping below is the part that has to be read
 * against the producer's rules to be understood at all.
 */

/**
 * A payload whose definitions have been reminted into the destination's id
 * space. Structurally the payload again, which is the point: by the time a
 * fragment is returned, every reference inside it already points at another
 * member of it.
 */
export interface ClipboardFragment {
  sources: DesignElement[];
  masters: ComponentElement[];
  assets: AssetRef[];
  styles: DesignStyle[];
  tokens?: DesignToken[];
}

/**
 * Mints an id that collides with nothing in `taken`.
 *
 * `createId` is a per-tab counter and a millisecond timestamp under a
 * `localStorage`-shared replica token, so two same-origin tabs can mint the same
 * id. That is survivable for a stray rect and unrecoverable for a main
 * component: a colliding master id makes every existing instance of it resolve
 * to the pasted copy, silently, and there is no way to tell the two apart
 * afterwards.
 *
 * `taken` is seeded with the destination's ids and accumulates every id this
 * paste mints, so a collision is caught both against what is already in the file
 * and against a sibling reminted a moment earlier in the same batch.
 */
function mintFreeId(taken: Set<string>, prefix: string): string {
  let id = createId(prefix);
  while (taken.has(id)) id = createId(prefix);
  taken.add(id);
  return id;
}

/**
 * A nested instance's override target is a `/`-joined chain of master node ids
 * (`component-ops.buildOverrideTarget`), so each hop is mapped separately —
 * mapping the whole string would miss it.
 */
function mapTargetPath(target: string, idMap: Map<string, string>): string {
  if (!target.includes("/")) return idMap.get(target) ?? target;
  return target
    .split("/")
    .map((step) => idMap.get(step) ?? step)
    .join("/");
}

/**
 * Rewrites every cross-reference in a copied subtree through `idMap`.
 *
 * ONE map covers masters and elements together, which is the load-bearing
 * decision of the whole feature: a pasted instance's `componentId`, its
 * `overrides[].targetId` and a text layer's `onPath.pathId` are remappable only
 * because the node they name travelled in the same batch. A remapped
 * `overrides[].targetId` that still binds in the destination is the case
 * flattening destroys permanently.
 */
function remapReferences(
  el: DesignElement,
  idMap: Map<string, string>,
  styleIdMap: Map<string, string>
): DesignElement {
  const next: DesignElement = { ...el, id: idMap.get(el.id) ?? el.id };
  const loose = next as unknown as Record<string, unknown>;

  if (next.type === "instance") {
    const inst = next as InstanceElement;
    const remapped = idMap.get(inst.componentId);
    if (remapped) inst.componentId = remapped;
    if (Array.isArray(inst.overrides)) {
      inst.overrides = inst.overrides.map((o) => {
        const targetId = mapTargetPath(o.targetId, idMap);
        let value = o.value;
        if (
          (o.property === "fillStyleId" ||
            o.property === "strokeStyleId" ||
            o.property === "textStyleId" ||
            o.property === "effectStyleId") &&
          typeof o.value === "string" &&
          styleIdMap.has(o.value)
        ) {
          value = styleIdMap.get(o.value)!;
        }
        return targetId === o.targetId && value === o.value ? o : { ...o, targetId, value };
      });
    }
  }

  const onPath = loose.onPath as { pathId?: string } | undefined;
  if (onPath && typeof onPath.pathId === "string" && idMap.has(onPath.pathId)) {
    loose.onPath = { ...onPath, pathId: idMap.get(onPath.pathId)! };
  }

  // The set a variant belongs to is an ELEMENT id, so it moves with the same
  // ledger as the variant. Left alone, a pasted component set carries members
  // pointing at the source file's set node: they would group under an id nothing
  // in this document answers to, which reads as "these variants are not a set".
  if (next.type === "component" && typeof loose.setId === "string" && idMap.has(loose.setId)) {
    loose.setId = idMap.get(loose.setId);
  }

  for (const key of STYLE_ID_KEYS) {
    const bound = loose[key];
    if (typeof bound === "string" && styleIdMap.has(bound)) {
      loose[key] = styleIdMap.get(bound);
    }
  }

  return isContainer(next) && next.children
    ? { ...next, children: next.children.map((c) => remapReferences(c, idMap, styleIdMap)) }
    : next;
}

/**
 * Re-points every paint layer's `assetId` at its reminted asset.
 */
function remapAssetRefs(el: DesignElement, assetIdMap: Map<string, string>): DesignElement {
  const next: DesignElement = { ...el };
  const loose = next as unknown as Record<string, unknown>;

  const remapLayer = (p: unknown): unknown => {
    if (!p || typeof p !== "object") return p;
    const paint = p as { type?: string; assetId?: string };
    if (paint.type !== "image" || !paint.assetId || !assetIdMap.has(paint.assetId)) return p;
    return { ...paint, assetId: assetIdMap.get(paint.assetId) };
  };

  if (Array.isArray(loose.fills)) loose.fills = (loose.fills as unknown[]).map(remapLayer);
  if (typeof loose.posterAssetId === "string" && assetIdMap.has(loose.posterAssetId)) {
    loose.posterAssetId = assetIdMap.get(loose.posterAssetId);
  }

  return isContainer(next) && next.children
    ? { ...next, children: next.children.map((c) => remapAssetRefs(c, assetIdMap)) }
    : next;
}

/**
 * Mints the fragment's entire id space in one pass, so every reference resolves.
 *
 * Three independent ledgers, deliberately not merged. Element ids are unique
 * document-wide (one `seenIds` pass spans every page in `normalize/document.ts`)
 * and are guarded against the destination's node ids. Assets and styles are flat
 * `doc.assets` / `doc.styles` arrays with their own ids and no cross-uniqueness
 * machinery: `normalizeStyles` keeps no ledger at all, so a duplicate style id
 * would not be repaired on load, and every style read is a first-match
 * `Array.find` — which would resolve a pasted element's `fillStyleId` to an
 * unrelated style, and leave the inspector editing the wrong definition. Styles
 * therefore get the same collision treatment as nodes, and are reminted
 * unconditionally: ids are unique per document, so a same-id style in two
 * documents is a coincidence, never identity.
 */
export function remintFragment(
  doc: DesignDocument,
  payload: FishClipboardPayload
): ClipboardFragment {
  const taken = new Set<string>();
  for (const page of doc.pages || []) {
    for (const el of flattenElements(page.children || [])) taken.add(el.id);
  }
  for (const el of flattenElements(getActivePage(doc).children)) taken.add(el.id);
  for (const asset of doc.assets || []) taken.add(asset.id);
  for (const style of doc.styles || []) taken.add(style.id);

  const idMap = new Map<string, string>();
  const assetIdMap = new Map<string, string>();
  const styleIdMap = new Map<string, string>();

  const mint = (sourceId: string, prefix: string, map: Map<string, string>): string => {
    const existing = map.get(sourceId);
    if (existing) return existing;
    const id = mintFreeId(taken, prefix);
    map.set(sourceId, id);
    return id;
  };

  for (const asset of payload.assets || []) mint(asset.id, "asset", assetIdMap);
  for (const style of payload.styles || []) mint(style.id, "style", styleIdMap);

  // Every source id is minted before any reference is rewritten, because a
  // node's `componentId` can name a master that a later sibling in the same list
  // is about to add. Masters go first only so that a source id colliding with a
  // master id resolves in the master's favour.
  const primeIds = (list: readonly DesignElement[]): void => {
    for (const el of list) {
      if (!idMap.has(el.id)) idMap.set(el.id, mintFreeId(taken, el.type));
      if (isContainer(el)) primeIds(el.children || []);
    }
  };
  primeIds(payload.masters || []);
  primeIds(payload.elements || []);

  const remintedStyles = (payload.styles || []).map((s) => ({ ...s, id: styleIdMap.get(s.id) ?? s.id }));
  const remintedTokens = (payload.tokens || []).map((t) => ({ ...t }));
  const tables = {
    tokens: [...(doc.tokens || []), ...remintedTokens],
    styles: [...(doc.styles || []), ...remintedStyles]
  };

  const remint = (list: readonly DesignElement[]): DesignElement[] =>
    list.map((el) =>
      syncDualStorage(
        remapAssetRefs(remapReferences(deepClone(el), idMap, styleIdMap), assetIdMap),
        tables
      )
    );

  return {
    sources: remint(payload.elements || []),
    masters: remint(payload.masters || []) as ComponentElement[],
    assets: (payload.assets || []).map((a) => ({ ...a, id: assetIdMap.get(a.id) ?? a.id })),
    styles: remintedStyles,
    ...(remintedTokens.length > 0 ? { tokens: remintedTokens } : {})
  };
}

export interface PasteFragmentOptions {
  /** The world rect the viewport shows, for a paste with no container to land in. */
  viewport: Rect;
}

/**
 * Splices a reminted fragment into `doc`.
 *
 * Placement deliberately does not take the in-file `resolvePastePlacement`
 * answer for a foreign payload. A pasted clone is by definition absent from the
 * target tree, so `findParentById` finds no original and the answer is the
 * page-root nudge — which is the same as having no placement rule at all, and it
 * drops a layer copied out of a frame at its old parent-local coordinates on top
 * of whatever sits at the page origin. A cross-file paste has no original to sit
 * beside, so it centres in the viewport, or in the target frame when one is
 * selected.
 *
 * Carried masters land at the page root even when the content goes into a frame.
 * That asymmetry is intentional: a definition is not the user's content, and
 * parking it inside the artboard they are designing — or inside its auto-layout
 * — is worse than putting it above. Resolution is unaffected, because
 * `findMasterComponent` scans every page.
 */
export function pasteFragmentIntoDoc(
  doc: DesignDocument,
  fragment: ClipboardFragment,
  selectedIds: readonly string[],
  options: PasteFragmentOptions
): { doc: DesignDocument; newIds: string[]; carriedMasters: number } {
  const active = getActivePage(doc).children;
  const placement = resolvePastePlacement(active, fragment.sources, selectedIds);
  // A copied master arrives as content and the insert primitives turn a
  // component into an instance of it — the same in-file rule. The definition
  // itself is `fragment.masters`, parked below, so the two share an id and
  // resolve.
  const sources = fragment.sources.map(toPastedContent);
  const rootIdBySource = new Map(sources.map((s, i) => [fragment.sources[i].id, s.id]));

  let nextElements: DesignElement[];
  let newIds: string[];

  if (placement.kind === "into") {
    nextElements = active;
    const allNew: string[] = [];
    for (const containerId of placement.containerIds) {
      const target = findElementById(nextElements, containerId);
      // A layout container positions its own children, so the fragment's
      // coordinates are read as a stack slot rather than an offset.
      const moved = target && isContainer(target) && layoutOf(target) ? sources : centerIn(nextElements, sources, containerId);
      nextElements = appendIntoContainer(nextElements, containerId, moved);
      allNew.push(...moved.map((s) => s.id));
    }
    nextElements = nextElements;
    newIds = allNew;
  } else {
    const delta = offsetCenteringSourcesIn(sources, options.viewport);
    const moved = sources.map((s) => shifted(s, delta));
    nextElements = [...active, ...moved];
    newIds = moved.map((s) => s.id);
  }

  if (fragment.masters.length > 0) {
    nextElements = parkMastersAbove(
      nextElements,
      [...rootIdBySource.values()],
      fragment.masters,
      placement.kind === "into" ? placement.containerIds[0] : null
    );
  }

  return {
    doc: {
      ...updateActivePageElements(doc, relayoutDocumentTree(nextElements)),
      assets: [...(doc.assets || []), ...fragment.assets],
      styles: [...(doc.styles || []), ...fragment.styles],
      ...(fragment.tokens?.length ? { tokens: [...(doc.tokens || []), ...fragment.tokens] } : {})
    },
    newIds,
    carriedMasters: fragment.masters.length
  };
}

/**
 * The content a fragment contributes, in the destination.
 *
 * A copied master becomes an instance of the definition that travelled with it,
 * which is the same rule the in-file paste applies and the same one Figma does:
 * what lands on the canvas is usable, and the definition is a separate thing
 * parked behind it. Everything else is already reminted and passes through.
 */
function toPastedContent(el: DesignElement): DesignElement {
  if (el.type !== "component") return el;
  return {
    id: createId("inst"),
    type: "instance",
    name: el.name,
    componentId: el.id,
    x: el.x,
    y: el.y,
    width: el.width,
    height: el.height,
    rotation: el.rotation ?? 0,
    opacity: el.opacity ?? 1,
    visible: el.visible ?? true,
    overrides: []
  } as InstanceElement;
}

/** The content box an auto-layout frame's children are placed into. */
function innerBox(frame: ContainerElement): Rect {
  const padding = layoutOf(frame)?.padding;
  if (padding === undefined) {
    return { x: frame.x, y: frame.y, width: frame.width, height: frame.height };
  }
  const [top, right, bottom, left] =
    typeof padding === "number" ? [padding, padding, padding, padding] : padding;
  return {
    x: frame.x + left,
    y: frame.y + top,
    width: frame.width - left - right,
    height: frame.height - top - bottom
  };
}

/** Moves a node by a delta, returning the same node for chaining. */
function shifted(el: DesignElement, delta: { x: number; y: number }): DesignElement {
  translateTreeInPlace(el, delta.x, delta.y);
  return el;
}

/**
 * Nudges the fragment to the middle of the container it is about to enter.
 *
 * The in-file `insertClonesIntoContainer` deliberately keeps the sources' own
 * coordinates, which is right for a paste back into the frame they came out of
 * and meaningless for a foreign frame: the relative position refers to a parent
 * this file does not have. Done before insertion, because the offset is
 * measured in the sources' own coordinates and the container's box is where it
 * is going.
 */
function centerIn(
  elements: DesignElement[],
  sources: readonly DesignElement[],
  containerId: string
): DesignElement[] {
  const container = findElementById(elements, containerId);
  if (!container || !isContainer(container) || layoutOf(container)) return [...sources];
  const delta = offsetCenteringSourcesIn(sources, innerBox(container));
  if (delta.x === 0 && delta.y === 0) return [...sources];
  return sources.map((s) => shifted(s, delta));
}

/** Appends nodes to a container, falling back to the page root if it vanished. */
function appendIntoContainer(
  elements: DesignElement[],
  containerId: string,
  nodes: readonly DesignElement[]
): DesignElement[] {
  const target = findElementById(elements, containerId);
  if (!target || !isContainer(target)) return [...elements, ...nodes];
  return mapElements(elements, (el) =>
    el.id === containerId && isContainer(el) ? { ...el, children: [...(el.children || []), ...nodes] } : el
  );
}

/**
 * Places the carried masters in a row above the content, and behind it in
 * z-order so the paste reads on top of the definitions it depends on.
 *
 * The reference line is the top of whatever the content was placed against: a
 * page-root clone's own `elementAABB` is already its canvas box, so
 * `computeParentOrigin` is only needed when the target frame is itself nested.
 * A rotated node is measured unrotated, the same simplification
 * `offsetCenteringSourcesIn` already makes, so the row and the content agree.
 */
function parkMastersAbove(
  elements: DesignElement[],
  pastedIds: readonly string[],
  masters: readonly ComponentElement[],
  intoContainerId: string | null
): DesignElement[] {
  let referenceY = 0;
  if (intoContainerId) {
    const container = findElementById(elements, intoContainerId);
    if (container) referenceY = container.y + computeParentOrigin(elements, intoContainerId).y;
  } else {
    const first = pastedIds.length > 0 ? findElementById(elements, pastedIds[0]) : null;
    if (first) referenceY = elementAABB(first).y;
  }

  const rowHeight = masters.reduce((h, m) => h + m.height + MASTER_ITEM_GAP, 0);
  let cursorX = 0;
  let cursorY = referenceY - rowHeight - MASTER_ROW_GAP;
  const placed = masters.map((m) => {
    const next: ComponentElement = { ...m, x: cursorX, y: cursorY };
    cursorX += m.width + MASTER_ITEM_GAP;
    cursorY += m.height + MASTER_ITEM_GAP;
    return next;
  });

  // SVG paints in array order, so an earlier index is behind. The masters go
  // immediately before the pasted content's TOP-LEVEL ancestor — the content
  // itself is not at the root when the paste went into a frame, so filtering the
  // root array by the sources' own ids would find nothing and leave the masters
  // stranded on top of the user's artboard.
  const anchorId = intoContainerId ?? (pastedIds.length > 0 ? pastedIds[0] : null);
  const anchor = anchorId ? topLevelAncestorId(elements, anchorId) : null;
  if (!anchor) return [...elements, ...placed];

  const at = elements.findIndex((el) => el.id === anchor);
  return [...elements.slice(0, at), ...placed, ...elements.slice(at)];
}

/** The page-root ancestor of `id` — the node whose z-slot the paste occupies. */
function topLevelAncestorId(elements: readonly DesignElement[], id: string): string | null {
  const walk = (list: readonly DesignElement[], ancestorId: string | null): string | null => {
    for (const el of list) {
      if (el.id === id) return ancestorId ?? el.id;
      if (isContainer(el)) {
        const found = walk(el.children || [], ancestorId ?? el.id);
        if (found) return found;
      }
    }
    return null;
  };
  return walk(elements, null);
}
