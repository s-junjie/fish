import {
  ComponentElement,
  DesignDocument,
  DesignElement,
  Page,
  getActivePage
} from "./dsl/types";
import { elementAABB, subtreeBounds } from "./geometry/element-bounds";
import { isElementInViewport, type ViewportBox } from "./geometry/cull";
import { flattenElements, isContainer } from "./geometry/tree-ops";
import { resolveInstanceChildren } from "./interactions/instance-resolve";
import { elementTransformMatrix, elementPivot } from "./geometry/transforms";
import { identityMatrix, multiply, translation, type Matrix2D } from "./geometry/matrix";
import type { Rect } from "./geometry/bounds";
import { transformBoundsToAABB } from "./geometry/bounds";

export interface MeasuredNode extends Rect {
  id: string;
  name: string;
  type: DesignElement["type"];
  /** The box as stored, relative to the parent's origin. */
  local: Rect;
  /** A node inside an instance: its id is derived, and it is read-only. */
  derived: boolean;
  /** The instance that owns a derived node, otherwise null. */
  instanceId: string | null;
  /**
   * False when the canvas is not currently painting this node.
   *
   * Two separate reasons, and they are not the same mistake to make of them. A page
   * other than the active one is never laid out, so its numbers are what was
   * authored — reading one as if it were on screen is how a page gets a
   * canvas-height back-fill built from coordinates nothing ever positioned. A node
   * the viewport culled IS laid out and IS correct, but the renderer returned null
   * for it, so an export taken right now photographs empty canvas where it stands.
   * The second is the dangerous one: every number still says the element is fine.
   *
   * `rendered` is only ever false for the culling reason when a viewport was passed
   * in. `core/` is DOM-free and cannot know the canvas size, so an uncalled-for
   * answer has to mean "no viewport information, assume painted".
   */
  rendered: boolean;
}

function pagesOf(doc: DesignDocument): Page[] {
  return doc.pages && doc.pages.length > 0 ? doc.pages : [getActivePage(doc)];
}

function componentIndex(doc: DesignDocument): Map<string, ComponentElement> {
  const index = new Map<string, ComponentElement>();
  for (const page of pagesOf(doc)) {
    for (const el of flattenElements(page.children || [])) {
      if (el.type === "component") index.set(el.id, el);
    }
  }
  return index;
}

function collect(
  list: readonly DesignElement[],
  parentM: Matrix2D,
  rendered: boolean,
  instanceId: string | null,
  masters: Map<string, ComponentElement>,
  out: MeasuredNode[],
  viewport?: ViewportBox,
  /** Stop as soon as this id is measured — see `measureElement`. */
  want?: string
): boolean {
  for (const el of list) {
    const local = elementAABB(el);
    // The canvas box is the STORED box carried through the chain the renderer
    // draws, not the stored box plus a sum of offsets. The renderer nests a child
    // inside its frame's turned group, so a frame's `rotation` moves everything
    // under it; adding `x`/`y` alone reported a box the node does not paint into,
    // and an export taken from it cropped somewhere else entirely.
    //
    // `local` stays exactly as stored — it is the parent-relative box, and that
    // is a different answer callers rely on.
    const pivot = elementPivot(el);
    const worldM = multiply(parentM, elementTransformMatrix(el, pivot.x, pivot.y));
    const world = transformBoundsToAABB(local, worldM)!;
    const x = world.x;
    const y = world.y;
    // Subtree, not own box: a frame whose own box has left the viewport can still
    // hold a child that has not, and the frame is the one that gets culled.
    const painted = rendered && (!viewport || isElementInViewport(subtreeBounds(el), viewport));
    out.push({
      id: el.id,
      name: el.name || "",
      type: el.type,
      x,
      y,
      width: world.width,
      height: world.height,
      local,
      derived: instanceId !== null,
      instanceId,
      rendered: painted
    });

    if (want !== undefined && el.id === want) return true;

    // Children are emitted inside `translate(x, y)`, which is the shift the box
    // above already accounts for — carrying it down is what lets a turned frame
    // report its children's real places.
    const childM = multiply(worldM, translation(el.x, el.y));

    if (el.type === "instance") {
      // A master that is absent or is not a component contributes no children, and
      // the instance's own box is still what the canvas paints (a dashed
      // placeholder), so the node above is the whole answer in that case.
      const master = el.componentId ? masters.get(el.componentId) : null;
      // A clone id is minted as `${owner}_${child}` (`cloneSubtreeWithDerivedIds`),
      // so an id that does not start with this instance's own prefix cannot be
      // inside it — and resolving an instance to look for it means cloning the
      // master's subtree and re-running its layout, which on a component-heavy
      // page is most of the cost of asking "where is this one box".
      const couldHold = want === undefined || want.startsWith(`${el.id}_`);
      if (master && couldHold && collect(resolveInstanceChildren(el, master), childM, rendered, el.id, masters, out, viewport, want)) {
        return true;
      }
      continue;
    }
    if (isContainer(el) && collect(el.children || [], childM, rendered, null, masters, out, viewport, want)) {
      return true;
    }
  }
  return false;
}

/**
 * Every element in the document with the box it paints into, in canvas
 * coordinates. This is the geometry readback an external agent has no other way
 * to get: the DSL stores children in each parent's local space, and the DOM names
 * an instance's children by a derived id the document never mints, so neither the
 * file nor a DOM probe answers "where is this element, exactly".
 */
export function measureDocument(doc: DesignDocument, viewport?: ViewportBox): MeasuredNode[] {
  const active = getActivePage(doc);
  const masters = componentIndex(doc);
  const out: MeasuredNode[] = [];
  for (const page of pagesOf(doc)) {
    collect(page.children || [], identityMatrix(), page.id === active.id, null, masters, out, viewport);
  }
  return out;
}

/** One element by id, or null when no node in the document carries that id. */
/**
 * One element by id, walking only as far as it has to.
 *
 * This used to measure the ENTIRE document and then pick one node out of the
 * result, which is a full tree walk that resolves every instance and re-runs
 * their layout — a document-wide text-measurement pass to answer a question
 * about one box. `exportBounds` calls it per selected element on every render of
 * the export panel, so a drag paid it once per frame: the first frame after the
 * press measured 72 uncached strings and blocked for ~60 ms, which is the pause
 * before an element starts following the pointer.
 *
 * The walk stops at the first node carrying the id, which is also the rule the
 * old `find` applied ("a document can carry the same id twice; the first
 * occurrence wins").
 */
export function measureElement(doc: DesignDocument, id: string, viewport?: ViewportBox): MeasuredNode | null {
  const active = getActivePage(doc);
  const masters = componentIndex(doc);
  const out: MeasuredNode[] = [];
  for (const page of pagesOf(doc)) {
    const found = collect(
      page.children || [],
      identityMatrix(),
      page.id === active.id,
      null,
      masters,
      out,
      viewport,
      id
    );
    if (found) return out[out.length - 1] ?? null;
  }
  return null;
}
