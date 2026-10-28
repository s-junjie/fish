import { ContainerElement, DesignElement, FrameElement } from "../dsl/types";
import { childrenOf, findElementById, findParentById, isContainer } from "./tree-query";

// Keyed on the elements array identity: an unchanged tree flattens once and is
// reused for every selection/pan/zoom render.
const flattenCache = new WeakMap<DesignElement[], DesignElement[]>();

export function flattenElements(elements: DesignElement[]): DesignElement[] {
  const cached = flattenCache.get(elements);
  if (cached) return cached;

  const out: DesignElement[] = [];
  const walk = (list: DesignElement[]) => {
    for (const el of list) {
      out.push(el);
      walk(childrenOf(el));
    }
  };
  walk(elements);
  flattenCache.set(elements, out);
  return out;
}

/**
 * Structural sharing: `fn` receives the live element (never a copy) and must
 * return the same reference when it does not change it. Untouched subtrees keep
 * their identity, so downstream memo comparisons stay O(changed path) instead of
 * O(tree). Returns the original array when nothing changed at all.
 */
export function mapElements(
  elements: DesignElement[],
  fn: (el: DesignElement) => DesignElement
): DesignElement[] {
  let changed = false;
  const out = elements.map((el) => {
    let next = fn(el);
    if (isContainer(next) && next.children) {
      const nextChildren = mapElements(next.children, fn);
      if (nextChildren !== next.children) {
        next = { ...next, children: nextChildren };
      }
    }
    if (next !== el) changed = true;
    return next;
  });
  return changed ? out : elements;
}

/**
 * Removes element by id from anywhere in tree and returns [remainingElements, removedElement].
 */
export function removeElementFromTree(
  elements: DesignElement[],
  id: string
): [DesignElement[], DesignElement | null] {
  let removed: DesignElement | null = null;

  const walk = (list: DesignElement[]): DesignElement[] => {
    const out: DesignElement[] = [];
    for (const el of list) {
      if (el.id === id) {
        removed = el;
        continue;
      }
      if (isContainer(el) && el.children) {
        out.push({ ...el, children: walk(el.children) });
      } else {
        out.push(el);
      }
    }
    return out;
  };

  const nextList = walk(elements);
  return [nextList, removed];
}

/**
 * Wrap `wrapped` elements inside `frame`, keeping them exactly where they are on
 * screen.
 *
 * Coordinate model: children are stored in their parent's local space, and the
 * renderer draws `frame.translate(frame.x, frame.y)` around `child.translate(child.x, child.y)`.
 * So the new frame must be created *inside the common parent* of the wrapped
 * elements at the wrapped bounding box, and the wrapped elements must be
 * re-based into the frame's local space (`child.x -= frame.x`).
 *
 * If every wrapped element shares one parent (a frame, or the root page) the
 * frame is nested in place there. If the selection spans multiple parents the
 * legacy top-level insertion is kept (no re-base).
 */
export function reparentSelectionIntoFrame(
  elements: DesignElement[],
  wrapped: DesignElement[],
  frame: FrameElement
): DesignElement[] {
  if (wrapped.length === 0) return elements;

  const parentIds = new Set<string | null>();
  for (const el of wrapped) {
    const p = findParentById(elements, el.id);
    parentIds.add(p ? p.id : null);
  }
  const commonParentId = parentIds.size === 1 ? [...parentIds][0] : undefined;

  // Re-base the wrapped elements into the frame's local space. Only the direct
  // wrapped elements shift; their descendants keep their own relative coords.
  const rebased = wrapped.map((c) => ({ ...c, x: c.x - frame.x, y: c.y - frame.y }));
  const frameEl: FrameElement = { ...frame, children: rebased };

  // Anchor the new frame where the first wrapped element sat, preserving z-order.
  const parentChildren =
    commonParentId === undefined
      ? []
      : commonParentId === null
        ? elements
        : (findElementById(elements, commonParentId) as ContainerElement | null)?.children || [];
  let anchorIndex = -1;
  for (let i = 0; i < parentChildren.length; i++) {
    if (wrapped.some((w) => w.id === parentChildren[i].id)) {
      anchorIndex = i;
      break;
    }
  }

  // Remove the wrapped elements from the tree.
  let remaining = elements;
  for (const el of wrapped) {
    const [next] = removeElementFromTree(remaining, el.id);
    remaining = next;
  }

  if (commonParentId === undefined) {
    // Mixed parents: legacy top-level insertion, no re-base.
    const topIdx = Math.min(
      ...elements.map((el, i) => (wrapped.some((w) => w.id === el.id) ? i : Infinity))
    );
    const out = [...remaining];
    out.splice(topIdx === Infinity ? out.length : Math.min(topIdx, out.length), 0, frameEl);
    return out;
  }

  if (commonParentId === null) {
    const out = [...remaining];
    out.splice(anchorIndex < 0 ? out.length : anchorIndex, 0, frameEl);
    return out;
  }

  const parentId = commonParentId;
  return mapElements(remaining, (el) => {
    if (el.id === parentId && isContainer(el)) {
      const kids = el.children || [];
      const idx = anchorIndex < 0 ? kids.length : Math.min(anchorIndex, kids.length);
      const newKids = [...kids];
      newKids.splice(idx, 0, frameEl);
      return { ...el, children: newKids };
    }
    return el;
  });
}

export function insertElementIntoContainer(
  elements: DesignElement[],
  newEl: DesignElement,
  targetContainerId?: string
): DesignElement[] {
  if (!targetContainerId) {
    return [...elements, newEl];
  }
  return mapElements(elements, (el) => {
    if (el.id === targetContainerId && isContainer(el)) {
      return {
        ...el,
        children: [...(el.children || []), newEl]
      };
    }
    return el;
  });
}
