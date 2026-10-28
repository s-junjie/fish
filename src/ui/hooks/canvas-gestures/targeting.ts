import { ContainerElement, ComponentElement, DesignDocument, DesignElement } from "../../../core/dsl/types";
import { findElementById, findParentById, isContainer } from "../../../core/geometry/tree-ops";
import { owningInstanceId } from "../../../core/interactions/component-swap";

/**
 * Which element a click on the canvas actually targets. Pure functions on the
 * element list: the rules are shared by the click handler, the hover preview and
 * the frame-depth logic, and keeping them here is what makes "a plain click
 * selects the container, a double click pierces in" one implementation instead of
 * three. Extracted from `useCanvasGestures` (AGENTS.md §9).
 */
/**
 * Returns the chain of ancestor frames for `id`, ordered top-level first and
 * ending at the immediate parent. The nesting depth of a frame is
 * `chain.length + 1` (a frame whose parent is the page canvas is depth 1).
 */
export function collectFrameAncestry(elements: DesignElement[], id: string): ContainerElement[] {
  const out: ContainerElement[] = [];
  let cur = findParentById(elements, id);
  while (cur) {
    out.unshift(cur);
    cur = findParentById(elements, cur.id);
  }
  return out;
}

/**
 * Immediate-parent frame ids of all currently-selected elements. A non-empty
 * set means we are "inside" those frames: both the frames themselves and their
 * sibling children become directly single-click selectable (frame/element
 * behavior unified within the active scope).
 */
export function activeScopeFrameIds(
  elements: DesignElement[],
  selectedIds: Set<string>
): Set<string> {
  const ids = new Set<string>();
  for (const sid of selectedIds) {
    const sp = findParentById(elements, sid);
    if (sp && isContainer(sp)) ids.add(sp.id);
  }
  return ids;
}

/**
 * The deepest selected ancestor frame in `ancestry`, or null. When present, a
 * single click on anything inside that frame moves the frame (it "swallows"
 * the click) instead of selecting the child; double clicks pierce in. Includes
 * top-level frames — a selected top-level frame swallows clicks on its
 * children exactly like any deeper frame.
 */
export function findLockedFrame(
  ancestry: ContainerElement[],
  selectedIds: Set<string>
): ContainerElement | null {
  let locked: ContainerElement | null = null;
  for (const f of ancestry) {
    if (selectedIds.has(f.id)) locked = f;
  }
  return locked;
}

/**
 * The nearest enclosing master component of `el`, or null. A master is a
 * published definition, so unlike a frame it never opens up to direct selection:
 * a plain click anywhere inside it lands on the master, and only a double click
 * (or a Cmd/Ctrl pierce) reaches a child. The NEAREST one is the barrier, so a
 * component nested in a component is entered one level at a time.
 */
export function enclosingMasterComponent(
  elements: DesignElement[],
  el: DesignElement
): ComponentElement | null {
  let cur = findParentById(elements, el.id);
  while (cur) {
    if (cur.type === "component") return cur;
    cur = findParentById(elements, cur.id);
  }
  return null;
}

/**
 * True when something strictly inside `containerId` is selected — the "already
 * entered" test for a master. `activeScopeFrameIds` only looks one level up,
 * which is enough for a frame (its direct children are all that can be in scope)
 * but not for a master, whose descendants can be arbitrarily deep.
 */
export function hasSelectedDescendant(
  elements: DesignElement[],
  selectedIds: Set<string>,
  containerId: string
): boolean {
  for (const sid of selectedIds) {
    if (sid === containerId) continue;
    let cur = findParentById(elements, sid);
    while (cur) {
      if (cur.id === containerId) return true;
      cur = findParentById(elements, cur.id);
    }
  }
  return false;
}

/**
 * Mirrors the single-click branch of `handleElementMouseDown`: given the element
 * under the cursor, returns the id a plain single click would select. Used to
 * preview the selection target on hover.
 */
export function resolveSingleClickTarget(
  doc: DesignDocument,
  elements: DesignElement[],
  el: DesignElement,
  selectedIds: Set<string>
): string {
  // The instance a resolved clone belongs to, however deep: its own owner may
  // be a clone too, and then a lookup by id finds nothing — which would leave
  // the preview promising the innermost node while the click selects the
  // instance (element-click.ts resolves the owner the same way).
  const ownerId = owningInstanceId(doc, el);
  const instanceEl = ownerId ? findElementById(elements, ownerId) : null;
  if (instanceEl && ownerId && !selectedIds.has(ownerId)) {
    el = instanceEl;
  }

  // The master wins over every descendant before any scope or depth rule runs,
  // so hovering inside one previews the master too — but only while we are
  // outside it. Once something inside is selected the barrier lifts, exactly as
  // the click handler does, or the preview would promise a target the click
  // never lands on.
  const masterComponent = enclosingMasterComponent(elements, el);
  if (masterComponent && !hasSelectedDescendant(elements, selectedIds, masterComponent.id)) {
    return masterComponent.id;
  }

  // Active scope: the frame(s) that contain a currently-selected element.
  // Inside the scope, both the frame itself and its sibling children are
  // directly single-clickable — unifying frame and element behavior.
  const scopeFrameIds = activeScopeFrameIds(elements, selectedIds);
  const elParentFrame = findParentById(elements, el.id);
  const elParentIsFrame = elParentFrame && isContainer(elParentFrame);
  if ((elParentIsFrame && scopeFrameIds.has(elParentFrame.id)) || scopeFrameIds.has(el.id)) {
    return el.id;
  }

  // A leaf nested inside a frame is gated by that frame: a plain single click
  // can never select it directly (only Cmd/Ctrl pierces). Promote it to its
  // enclosing frame so the frame-depth rules below decide the real target.
  let target = el;
  if (!isContainer(el)) {
    const parent = findParentById(elements, el.id);
    if (parent && isContainer(parent)) target = parent;
  }

  const isFrameEl = isContainer(target);
  const frameAncestry = collectFrameAncestry(elements, target.id);
  const targetDepth = isFrameEl ? frameAncestry.length + 1 : 0;

  if (isFrameEl && targetDepth === 1) return target.id;

  let lockedFrame = findLockedFrame(frameAncestry, selectedIds);
  if (isFrameEl && targetDepth >= 2 && selectedIds.has(target.id)) lockedFrame = target as ContainerElement;
  if (lockedFrame) return lockedFrame.id;

  if (!isFrameEl) return target.id;

  if (targetDepth === 2) return target.id;

  const parent = findParentById(elements, target.id);
  if (parent && isContainer(parent)) return parent.id;

  return target.id;
}
