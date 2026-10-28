import { ContainerElement, DesignDocument, DesignElement, getActivePage } from "../../../core/dsl/types";
import { worldMatrixOf } from "../../../core/interactions/component-swap";
import { elementAABB } from "../../../core/geometry/element-bounds";
import { transformBoundsToAABB, type Rect } from "../../../core/geometry/bounds";
import { isContainer } from "../../../core/geometry/tree-ops";

/*
 * The Alt distance read-out measures the SELECTION, not its first member: a
 * multi-selection is one object on the canvas — the chrome already frames it
 * with a single box — so the distances have to leave from that box too, or the
 * numbers belong to a rectangle the user is not pointing at.
 */

/** The selected layers the tree still resolves, in document order. */
function resolveMembers(
  children: DesignElement[],
  selectedIds: ReadonlySet<string>,
  primary: DesignElement | null
): DesignElement[] {
  const wanted = new Set(selectedIds);
  const out: DesignElement[] = [];
  const walk = (list: DesignElement[]) => {
    for (const el of list) {
      if (wanted.size === 0) return;
      if (wanted.delete(el.id)) out.push(el);
      if (isContainer(el)) walk(el.children || []);
    }
  };
  walk(children);
  // A resolved instance clone is painted, never stored, so the tree cannot
  // return it — the primary arrives already resolved for exactly this case.
  if (primary && wanted.has(primary.id)) out.push(primary);
  return out;
}

/** Union of the boxes the selected layers paint into, in canvas coordinates. */
export function selectionWorldBox(
  doc: DesignDocument,
  selectedIds: ReadonlySet<string>,
  primary: DesignElement | null
): Rect | null {
  const members = resolveMembers(getActivePage(doc).children, selectedIds, primary);
  let box: Rect | null = null;
  for (const el of members) {
    const world = transformBoundsToAABB(elementAABB(el), worldMatrixOf(doc, el));
    if (!world) continue;
    if (!box) {
      box = world;
      continue;
    }
    const x = Math.min(box.x, world.x);
    const y = Math.min(box.y, world.y);
    box = {
      x,
      y,
      width: Math.max(box.x + box.width, world.x + world.width) - x,
      height: Math.max(box.y + box.height, world.y + world.height) - y
    };
  }
  return box;
}

/**
 * The deepest container that is a PROPER ancestor of every selected layer — the
 * frame a multi-selection keeps its padding against.
 *
 * Proper, because a selected frame is part of the object being measured, not
 * the space around it; and every ancestor, because a selection spanning two
 * frames has no single parent but still sits inside their common one. A
 * top-level member has no such frame, and nothing contains the whole selection.
 */
export function selectionCommonParent(
  children: DesignElement[],
  selectedIds: ReadonlySet<string>
): ContainerElement | null {
  const parentOf = new Map<string, ContainerElement>();
  const inTree = new Set<string>();
  const walk = (list: DesignElement[], parent: ContainerElement | null) => {
    for (const el of list) {
      inTree.add(el.id);
      if (parent) parentOf.set(el.id, parent);
      if (isContainer(el)) walk(el.children || [], el);
    }
  };
  walk(children, null);

  const anchors = [...selectedIds].filter((id) => inTree.has(id));
  if (anchors.length === 0) return null;

  const chains = anchors.map((id) => {
    const chain = new Set<string>();
    let p = parentOf.get(id);
    while (p) {
      chain.add(p.id);
      p = parentOf.get(p.id);
    }
    return chain;
  });
  if (chains.some((chain) => chain.size === 0)) return null;

  const common = chains.reduce((acc, chain) => new Set([...acc].filter((id) => chain.has(id))));
  // One member's ancestors are a chain, so walking up from it reaches the
  // deepest shared one first.
  let p = parentOf.get(anchors[0]);
  while (p) {
    if (common.has(p.id)) return p;
    p = parentOf.get(p.id);
  }
  return null;
}
