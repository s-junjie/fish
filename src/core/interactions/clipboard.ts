import {
  ContainerElement,
  DesignDocument,
  DesignElement,
  InstanceElement
} from "../dsl/types";
import { createId } from "../id";
import { isContainer, findElementById, findParentById, flattenElements, mapElements, computeParentOrigin } from "../geometry/tree-ops";
import { elementAABB } from "../geometry/element-bounds";
import type { Rect } from "../geometry/bounds";
import { relayoutDocumentTree } from "../../core/compile";
import { stripDerivedMarkers, resolveInstanceSelection, isStoredNode } from "./instance-resolve";
import { worldOriginOf } from "./component-swap";
import { layoutOf } from "../dsl/layout-flat";

/**
 * The in-file clipboard: clone/cut/insert primitives and the paste placement
 * resolver. Clones always mint fresh ids (including descendants) so pasted
 * subtrees never collide with the originals they are inserted next to.
 *
 * The cross-file payload lives in `clipboard-fragment.ts`; it shares the
 * placement resolver below but not the insert primitives, because a foreign
 * payload has no originals to sit beside.
 */

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

export function cloneWithNewIds(src: DesignElement): {
  clone: DesignElement;
  idMap: Map<string, string>;
} {
  const clone = deepClone(src);
  const idMap = new Map<string, string>();

  const reid = (node: DesignElement) => {
    const fresh = createId(node.type);
    idMap.set(node.id, fresh);
    node.id = fresh;
    if (isContainer(node)) (node.children || []).forEach(reid);
  };
  reid(clone);

  // References to nodes INSIDE the copy, which the fresh ids invalidated. Two, and
  // both are local to the subtree — a text's path and a variant's set.
  //
  // `setId` is the one that bites silently: a duplicated set whose members still
  // name the original would have its variants grouped into the set it was copied
  // from, so the copy would show up as one more member of somebody else's set.
  const remapLocalRefs = (node: DesignElement) => {
    const loose = node as unknown as Record<string, unknown>;
    const onPath = loose.onPath as { pathId?: string } | undefined;
    if (onPath && typeof onPath.pathId === "string" && idMap.has(onPath.pathId)) {
      loose.onPath = { ...onPath, pathId: idMap.get(onPath.pathId) };
    }
    if (node.type === "component" && typeof loose.setId === "string" && idMap.has(loose.setId)) {
      loose.setId = idMap.get(loose.setId);
    }
    if (isContainer(node)) (node.children || []).forEach(remapLocalRefs);
  };
  remapLocalRefs(clone);

  return { clone, idMap };
}

export function translateTreeInPlace(el: DesignElement, ddx: number, ddy: number): void {
  if (ddx === 0 && ddy === 0) return;
  el.x += ddx;
  el.y += ddy;
}

/** Selected elements that have no selected ancestor — the units a copy carries. */
export function collectTopMostSelected(
  elements: DesignElement[],
  selectedIds: Set<string>
): DesignElement[] {
  const out: DesignElement[] = [];
  const walk = (list: DesignElement[]) => {
    for (const el of list) {
      if (selectedIds.has(el.id)) {
        out.push(el);
        continue;
      }
      if (isContainer(el)) walk(el.children || []);
    }
  };
  walk(elements);
  return out;
}

/** A resolved clone as a real node, at the canvas position it is painted at. */
function asStoredCopyOf(doc: DesignDocument, node: DesignElement): DesignElement {
  const origin = worldOriginOf(doc, node);
  const stored = stripDerivedMarkers(node);
  return { ...stored, x: stored.x + origin.x, y: stored.y + origin.y };
}

/**
 * The units Copy carries: `collectTopMostSelected` plus, for every selected id the
 * tree does not store, the resolved clone of a layer inside an instance.
 *
 * `collectTopMostSelected` walks the document tree, and a resolved clone is not in
 * it — the canvas paints it, the file never holds it — so Copy on a layer inside an
 * instance collected nothing and the row did nothing at all. The clone is handed
 * back as an ordinary node instead, moved to the canvas position it is PAINTED at:
 * its own `x`/`y` are relative to a parent that exists only inside the resolution,
 * and pasting at those coordinates put a nested child at whatever sat near the page
 * origin. `asStoredCopyOf` says the rest.
 *
 * A clone whose owning instance is already a unit is skipped: copying the instance
 * carries every layer it projects.
 */
export function collectCopySources(
  doc: DesignDocument,
  elements: DesignElement[],
  selectedIds: Set<string>
): DesignElement[] {
  const out = collectTopMostSelected(elements, selectedIds);
  for (const id of selectedIds) {
    if (isStoredNode(doc, id)) continue;
    const sel = resolveInstanceSelection(doc, id);
    if (!sel) continue;
    if (out.some((unit) => flattenElements([unit]).some((child) => child.id === sel.instance.id))) continue;
    out.push(asStoredCopyOf(doc, sel.node));
  }
  return out;
}

export function removeElements(elements: DesignElement[], ids: Set<string>): DesignElement[] {
  const walk = (list: DesignElement[]): DesignElement[] =>
    list
      .filter((el) => !ids.has(el.id))
      .map((el) => (isContainer(el) ? { ...el, children: walk(el.children || []) } : el));
  return walk(elements);
}

/**
 * Remove `ids` and reflow the whole tree.
 *
 * Reflowing only the frames that lost a child is not enough: a hug frame's new
 * size has to reach its ancestors (LESSONS #20/#23/#27), and a frame whose last
 * child just left has to collapse onto its padding. Both fall out of one full
 * pass, and a partial one only moves the stale geometry somewhere else.
 */
export function removeElementsWithRelayout(
  elements: DesignElement[],
  ids: Set<string>
): DesignElement[] {
  return relayoutDocumentTree(removeElements(elements, ids));
}

export type PastePlacement =
  /** Append into these containers (the selected, unlocked, non-self ones). */
  | { kind: "into"; containerIds: string[] }
  /** Nudge a copy of a page-root source, for a user who selected something else. */
  | { kind: "beside-original" }
  /** Land at the page root, centred in the viewport. */
  | { kind: "onto-canvas" };

/**
 * Decides where a paste lands. The selection is the only input that is not
 * derivable from the clipboard, which is why this lives apart from the insert
 * primitives.
 *
 * Two cases need a decision, and both are about the same thing: a paste nobody
 * placed has to be somewhere the user can see it.
 *
 * `onto-canvas` covers the empty selection. `insertClones` files a clone next to
 * its original, so a layer copied out of a frame came straight back into the
 * frame the user had just clicked away from, and a page-root source pasted after
 * a scroll landed wherever its original sits — off the screen, or off the page
 * that is now active. An empty selection is the user saying "not in there" and
 * nothing else, so the copy is centred in the viewport instead.
 *
 * `beside-original` is the familiar paste-in-place nudge, kept for the case it
 * reads as: something else is selected, so the user is looking at the region the
 * copy belongs to, and a clone that lands 20px off its original is the one they
 * expect. A nested source still comes out to the page root — that is the frame
 * they clicked away from, not "here".
 */
export function resolvePastePlacement(
  elements: DesignElement[],
  sources: readonly DesignElement[],
  selectedIds: Iterable<string>
): PastePlacement {
  const selected = Array.from(new Set(selectedIds))
    .map((id) => findElementById(elements, id))
    .filter((el): el is DesignElement => Boolean(el));

  // A container that is itself in the clipboard would receive its own clone as
  // a child, so it is not a valid destination for this paste.
  const containerIds = selected
    .filter((el): el is ContainerElement => isContainer(el) && !el.locked)
    .filter((el) => !sources.some((s) => s.id === el.id))
    .map((el) => el.id);

  if (containerIds.length > 0) return { kind: "into", containerIds };

  // Nothing selected at all: no answer to give, so land where the user is looking.
  // An id that resolves to nothing counts as nothing — a selection the tree does
  // not hold cannot say where the copy belongs either.
  if (selected.length === 0) return { kind: "onto-canvas" };

  // Everything copied already sits at the page root, so `beside-original` is
  // just the familiar paste-in-place nudge. A source with no parent at all
  // (cut, or copied from another page) is already covered by the same path.
  const allAtPageRoot = sources.every((s) => !findParentById(elements, s.id));
  return allAtPageRoot ? { kind: "beside-original" } : { kind: "onto-canvas" };
}

/**
 * The translate that centres the cloned group in `target`.
 *
 * Measured in the sources' OWN coordinates, not their canvas positions: a clone
 * appended to the page root is positioned at `src.x + offset`, so folding in a
 * parent origin would cancel the very thing the translate is there to do. Where
 * the original sat does not matter here — landing in the viewport is the whole
 * point — only how big the group is.
 */
export function offsetCenteringSourcesIn(
  sources: readonly DesignElement[],
  target: Rect
): { x: number; y: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const src of sources) {
    const box = elementAABB(src);
    minX = Math.min(minX, box.x);
    minY = Math.min(minY, box.y);
    maxX = Math.max(maxX, box.x + box.width);
    maxY = Math.max(maxY, box.y + box.height);
  }

  if (!Number.isFinite(minX)) return { x: 0, y: 0 };
  return {
    x: Math.round(target.x + target.width / 2 - (minX + maxX) / 2),
    y: Math.round(target.y + target.height / 2 - (minY + maxY) / 2)
  };
}

/**
 * Clone `sources` and splice each clone directly above its original (same
 * parent, same z-order slot). Sources that vanished from the document land at
 * the root so a paste never silently drops content.
 *
 * `rootIdBySource` maps each source id to the id of the clone spliced in for
 * it. `newIds` also lists every descendant, so a caller that needs to address
 * the clones as whole units (select them, drive a gesture off them) has to use
 * this map instead of reading `newIds` positionally.
 */
function cloneSources(
  sources: readonly DesignElement[],
  offset: { x: number; y: number }
): { byOriginalId: Map<string, DesignElement>; clones: DesignElement[]; newIds: string[] } {
  const byOriginalId = new Map<string, DesignElement>();
  const clones: DesignElement[] = [];
  const newIds: string[] = [];

  for (const src of sources) {
    if (src.type === "component") {
      const inst: InstanceElement = {
        id: createId("inst"),
        type: "instance",
        name: src.name,
        componentId: src.id,
        x: src.x + offset.x,
        y: src.y + offset.y,
        width: src.width,
        height: src.height,
        rotation: src.rotation ?? 0,
        opacity: src.opacity ?? 1,
        visible: src.visible ?? true,
        overrides: []
      };
      byOriginalId.set(src.id, inst);
      clones.push(inst);
      newIds.push(inst.id);
      continue;
    }
    const { clone, idMap } = cloneWithNewIds(src);
    translateTreeInPlace(clone, offset.x, offset.y);
    byOriginalId.set(src.id, clone);
    clones.push(clone);
    newIds.push(...idMap.values());
  }

  return { byOriginalId, clones, newIds };
}

function rootIdMapFor(
  sources: readonly DesignElement[],
  byOriginalId: Map<string, DesignElement>
): Map<string, string> {
  const rootIdBySource = new Map<string, string>();
  for (const src of sources) {
    const clone = byOriginalId.get(src.id);
    if (clone) rootIdBySource.set(src.id, clone.id);
  }
  return rootIdBySource;
}

/**
 * Clone `sources` and splice each clone directly above its original (same
 * parent, same z-order slot). Sources that vanished from the document land at
 * the root so a paste never silently drops content.
 *
 * `rootIdBySource` maps each source id to the id of the clone spliced in for
 * it. `newIds` also lists every descendant, so a caller that needs to address
 * the clones as whole units (select them, drive a gesture off them) has to use
 * this map instead of reading `newIds` positionally.
 */
export function insertClones(
  elements: DesignElement[],
  sources: DesignElement[],
  offset: { x: number; y: number } = { x: 0, y: 0 }
): { elements: DesignElement[]; newIds: string[]; rootIdBySource: Map<string, string> } {
  const { byOriginalId, clones, newIds } = cloneSources(sources, offset);

  const inserted = new Set<DesignElement>();
  const walk = (list: DesignElement[]): DesignElement[] => {
    const out: DesignElement[] = [];
    for (const el of list) {
      const next = isContainer(el) ? { ...el, children: walk(el.children || []) } : el;
      out.push(next);
      const clone = byOriginalId.get(el.id);
      if (clone) {
        out.push(clone);
        inserted.add(clone);
      }
    }
    return out;
  };

  let result = walk(elements);
  const leftovers = clones.filter((clone) => !inserted.has(clone));
  if (leftovers.length > 0) result = [...result, ...leftovers];

  return { elements: result, newIds, rootIdBySource: rootIdMapFor(sources, byOriginalId) };
}

/**
 * Clone `sources` and append every clone to the page root, whatever parent the
 * original sits in. This is the paste that honours "the canvas", where
 * `insertClones` would put the copy back inside the frame it came from.
 */
export function insertClonesAtRoot(
  elements: DesignElement[],
  sources: DesignElement[],
  offset: { x: number; y: number } = { x: 0, y: 0 }
): { elements: DesignElement[]; newIds: string[]; rootIdBySource: Map<string, string> } {
  const { byOriginalId, clones, newIds } = cloneSources(sources, offset);
  return {
    elements: [...elements, ...clones],
    newIds,
    rootIdBySource: rootIdMapFor(sources, byOriginalId)
  };
}

export interface InsertIntoContainerOptions {
  viewport?: Rect;
}

/**
 * Clone `sources` and append them into `targetContainerId`.
 *
 * A paste into the frame the sources already live in nudges by (+20, +20), so the
 * copy clears the original and reads as a copy. A paste into a *different* frame
 * keeps the sources' own coordinates if they land within the frame's bounds, so
 * the content lands where it sat relative to its old parent. If the source falls
 * outside the target frame's bounds, it is centred in the frame's visible region
 * (or frame centre if fully visible / off-screen) so it never gets lost far away.
 *
 * An auto-layout target positions its children itself, so neither applies there.
 */
export function insertClonesIntoContainer(
  elements: DesignElement[],
  sources: DesignElement[],
  targetContainerId: string,
  options?: InsertIntoContainerOptions
): { elements: DesignElement[]; newIds: string[] } {
  const target = findElementById(elements, targetContainerId);
  if (!target || !isContainer(target)) {
    return insertClones(elements, sources, { x: 20, y: 20 });
  }

  const clones: DesignElement[] = [];
  const newIds: string[] = [];

  for (const src of sources) {
    if (src.type === "component") {
      const inst: InstanceElement = {
        id: createId("inst"),
        type: "instance",
        name: src.name,
        componentId: src.id,
        x: src.x,
        y: src.y,
        width: src.width,
        height: src.height,
        rotation: src.rotation ?? 0,
        opacity: src.opacity ?? 1,
        visible: src.visible ?? true,
        overrides: []
      };
      clones.push(inst);
      newIds.push(inst.id);
      continue;
    }
    const { clone, idMap } = cloneWithNewIds(src);
    clones.push(clone);
    newIds.push(...idMap.values());
  }

  if (!layoutOf(target) && clones.length > 0) {
    const targetChildren = target.children || [];
    const wereAllChildren = sources.every((s) => targetChildren.some((c) => c.id === s.id));

    if (wereAllChildren) {
      // Only a paste back into the source's own frame has to move, or the copy is
      // invisible under it.
      for (const clone of clones) {
        translateTreeInPlace(clone, 20, 20);
      }
    } else {
      // Check whether the cloned elements land completely outside the target container bounds.
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;

      for (const clone of clones) {
        const box = elementAABB(clone);
        minX = Math.min(minX, box.x);
        minY = Math.min(minY, box.y);
        maxX = Math.max(maxX, box.x + box.width);
        maxY = Math.max(maxY, box.y + box.height);
      }

      // If partially overlapping with the frame, keep relative coordinates. Only when completely outside, center in visible region.
      const completelyOutside = maxX <= 0 || minX >= target.width || maxY <= 0 || minY >= target.height;
      if (completelyOutside) {
        // Calculate the visible region of the target container in its local coordinate space.
        let targetBox: Rect = { x: 0, y: 0, width: target.width, height: target.height };
        if (options?.viewport) {
          const origin = computeParentOrigin(elements, target.id);
          const worldTarget: Rect = {
            x: origin.x + target.x,
            y: origin.y + target.y,
            width: target.width,
            height: target.height
          };
          const visX = Math.max(worldTarget.x, options.viewport.x);
          const visY = Math.max(worldTarget.y, options.viewport.y);
          const visR = Math.min(worldTarget.x + worldTarget.width, options.viewport.x + options.viewport.width);
          const visB = Math.min(worldTarget.y + worldTarget.height, options.viewport.y + options.viewport.height);
          if (visR > visX && visB > visY) {
            targetBox = {
              x: visX - worldTarget.x,
              y: visY - worldTarget.y,
              width: visR - visX,
              height: visB - visY
            };
          }
        }
        const delta = offsetCenteringSourcesIn(clones, targetBox);
        for (const clone of clones) {
          translateTreeInPlace(clone, delta.x, delta.y);
        }
      }
    }
  }

  const nextElements = mapElements(elements, (el) => {
    if (el.id === targetContainerId && isContainer(el)) {
      return {
        ...el,
        children: [...(el.children || []), ...clones]
      };
    }
    return el;
  });

  return { elements: nextElements, newIds };
}

/**
 * Re-insert cut sources under their OWN ids — a cut is a move, not a copy.
 *
 * This is the whole reason a cut has to be told apart from a copy. A main
 * component is addressed by id from anywhere in the file, so re-minting it (which
 * every clone path does) leaves every instance in the document pointing at an id
 * that no longer exists: they fall back to the red "missing master" placeholder
 * and stay broken, because the definition they name is gone for good. Keeping the
 * id makes cut → paste a relocation, which is what the gesture is for.
 *
 * The sources arrive already placed: a cut out of a frame has to be shifted by the
 * frame's origin to land back where it was (its own `x` / `y` are parent-local and
 * mean nothing at the page root), and that delta differs per source when a
 * selection spans frames. Hence no offset parameter — the caller owns the geometry.
 *
 * `intoContainerId` moves them under one container; with none they land at the page
 * root. A single destination on purpose: the same id cannot be inserted twice, so a
 * cut of three layers into three selected frames has to pick one.
 */
export function insertVerbatim(
  elements: DesignElement[],
  sources: readonly DesignElement[],
  intoContainerId: string | null
): { elements: DesignElement[]; ids: string[] } {
  const ids = sources.map((s) => s.id);
  const moved = [...sources];

  if (!intoContainerId) {
    return { elements: [...elements, ...moved], ids };
  }
  const target = findElementById(elements, intoContainerId);
  if (!target || !isContainer(target)) {
    // The destination vanished between deciding and inserting: the page root is
    // the only place a verbatim paste can still be valid.
    return { elements: [...elements, ...moved], ids };
  }
  // A layout container places its own children, so the sources keep the local
  // coordinates they were cut with and the stack arranges them.
  return {
    elements: mapElements(elements, (el) =>
      el.id === intoContainerId && isContainer(el)
        ? { ...el, children: [...(el.children || []), ...moved] }
        : el
    ),
    ids
  };
}

/**
 * True when every source id is still free in `elements` — the precondition for a
 * verbatim re-insert. A second paste of the same cut fails it, because the first
 * paste put the ids back; that paste has to be a copy anyway.
 */
export function idsAvailable(elements: DesignElement[], sources: readonly DesignElement[]): boolean {
  const taken = new Set(flattenElements(elements).map((el) => el.id));
  return sources.every((s) => !taken.has(s.id));
}
