import { ContainerElement, DesignElement } from "../dsl/types";
import { elementPivot, elementTransformMatrix } from "./transforms";
import { identityMatrix, multiply, translation, type Matrix2D } from "./matrix";
import { collectDescendantIds, isContainer } from "./tree-query";

export function getTopLevelAncestorFrame(elements: DesignElement[], targetId: string): ContainerElement | null {
  for (const root of elements) {
    if (isContainer(root)) {
      if (root.id === targetId) return root;
      if (collectDescendantIds(root).includes(targetId)) return root;
    }
  }
  return null;
}

/**
 * Every element's parent origin, computed once per tree instead of once per
 * question.
 *
 * The walk this replaces ran per call, and the drag/resize paths ask it once per
 * candidate element per frame — so a 3120-element page paid 6240 tree walks a
 * frame and the snap list, which only ever needs the handful inside the viewport,
 * cost more than the drag. Keyed on the elements array identity, the same
 * structural-sharing invariant `flattenElements` relies on: a commit that does not
 * touch a subtree hands back the same array and reuses this map.
 */
const parentOriginCache = new WeakMap<DesignElement[], Map<string, { x: number; y: number }>>();

function parentOriginMap(elements: DesignElement[]): Map<string, { x: number; y: number }> {
  const cached = parentOriginCache.get(elements);
  if (cached) return cached;

  const map = new Map<string, { x: number; y: number }>();
  const walk = (list: DesignElement[], originX: number, originY: number) => {
    for (const el of list) {
      if (!map.has(el.id)) map.set(el.id, { x: originX, y: originY });
      if (isContainer(el)) {
        walk(el.children || [], originX + el.x, originY + el.y);
      }
    }
  };
  walk(elements, 0, 0);
  parentOriginCache.set(elements, map);
  return map;
}

/**
 * Every element's parent CHAIN as one matrix, computed once per tree.
 *
 * The translation-only `parentOriginMap` above is the same walk with the
 * rotation dropped, and it is right for everything that only asks "where does
 * this child's `x` sit on the canvas" — a drag writing `x` back, a snap
 * candidate, an export frame. It is NOT right for anything that has to place
 * geometry rather than read a coordinate, because the renderer does not draw a
 * child beside its parent, it draws it INSIDE the parent's turned `<g>`: the
 * whole subtree inherits the frame's `rotation`. So a child of a frame turned
 * -35° paints at a point the translation-only chain cannot name, and every
 * consumer that placed a box there — the selection overlay's handles above all
 * — put the chrome somewhere the artwork is not.
 *
 * Hence a second map rather than a corrected one: `parentOriginMap` stays the
 * cheap answer for the write paths that genuinely want the un-turned origin,
 * and this one carries the composition the renderer actually performs.
 *
 * The walk mirrors `SvgNodeRenderer`'s nesting exactly — a container contributes
 * `translate(x, y)` and then its own turn about its own centre, and the child's
 * turn composes inside that. Keyed on the elements array identity, the same
 * structural-sharing invariant the other two maps rely on.
 */
const parentMatrixCache = new WeakMap<DesignElement[], Map<string, Matrix2D>>();

/**
 * The transform carrying a node's PARENT-LOCAL space into canvas space — the
 * matrix to hang a node's own box inside, NOT including the node's own rotation.
 *
 * That split is what makes it composable: the overlay wants
 * `parentMatrix · ownTransform`, and the multiply happens in the caller, where
 * the node's own pivot is known.
 */
function parentMatrixMap(elements: DesignElement[]): Map<string, Matrix2D> {
  const cached = parentMatrixCache.get(elements);
  if (cached) return cached;

  const map = new Map<string, Matrix2D>();
  const walk = (list: DesignElement[], parentM: Matrix2D) => {
    for (const el of list) {
      if (!map.has(el.id)) map.set(el.id, parentM);
      if (!isContainer(el)) continue;
      // A container's children are emitted inside `translate(x, y)` and, one
      // level up, inside the container's own rotated group — so the chain is
      // turn-then-shift, and the two must not be swapped.
      const pivot = elementPivot(el);
      const own = elementTransformMatrix(el, pivot.x, pivot.y);
      walk(el.children || [], multiply(multiply(parentM, own), translation(el.x, el.y)));
    }
  };
  walk(elements, identityMatrix());
  parentMatrixCache.set(elements, map);
  return map;
}

/**
 * The canvas-absolute origin of an element by walking the parent chain.
 * Returns { x, y } such that `element.x + result.x` gives the canvas x of the element.
 *
 * For top-level elements, returns { x: 0, y: 0 } (they ARE at canvas coords).
 * For a child of a frame at canvas (fx, fy), returns { x: fx, y: fy }.
 *
 * TRANSLATION ONLY. An ancestor's `rotation` is deliberately not folded in —
 * see `parentMatrixMap` for why that is the right answer here and the wrong one
 * there, and `computeParentWorldMatrix` for the matrix.
 */
export function computeParentOrigin(
  elements: DesignElement[],
  targetId: string
): { x: number; y: number } {
  const direct = parentOriginMap(elements).get(targetId);
  if (direct) return direct;
  // A resolved clone is not in the document tree, so the map above cannot hold
  // it. Its owner instance is the deepest id the target is prefixed with.
  function findInstanceOwner(
    list: DesignElement[],
    originX: number,
    originY: number
  ): { originX: number; originY: number; inst: DesignElement } | null {
    let best: { originX: number; originY: number; inst: DesignElement } | null = null;
    for (const el of list) {
      if (el.type === "instance" && targetId.startsWith(`${el.id}_`)) {
        if (!best || el.id.length > best.inst.id.length) {
          best = { originX, originY, inst: el };
        }
      }
      if (isContainer(el)) {
        const childMatch = findInstanceOwner(el.children || [], originX + el.x, originY + el.y);
        if (childMatch && (!best || childMatch.inst.id.length > best.inst.id.length)) {
          best = childMatch;
        }
      }
    }
    return best;
  }
  const instOwner = findInstanceOwner(elements, 0, 0);
  if (instOwner) {
    return {
      x: instOwner.originX + instOwner.inst.x,
      y: instOwner.originY + instOwner.inst.y
    };
  }

  return { x: 0, y: 0 };
}

/**
 * The matrix carrying a node's parent-local space into canvas space, ancestors'
 * rotations included.
 *
 * This is the matrix to hand `SvgNodeRenderer`'s nesting to a box that has to
 * land where the artwork is. Multiply the node's OWN turn into it and the
 * result places the node's box in canvas space — see `worldMatrixOf` in
 * `component-swap.ts`, which adds the node's own rotation and resolves the
 * clones a tree walk cannot reach.
 *
 * A resolved clone is absent by construction, so it is absent here too and the
 * answer is the identity: a caller that cannot place a node draws nothing
 * rather than drawing it at the canvas origin.
 */
export function computeParentWorldMatrix(elements: DesignElement[], targetId: string): Matrix2D {
  return parentMatrixMap(elements).get(targetId) ?? identityMatrix();
}
