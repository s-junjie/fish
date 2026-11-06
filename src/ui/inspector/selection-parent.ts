import type { DesignDocument, DesignElement, InstanceElement, ScrollOverflow } from "../../core/dsl/types";
import { getActivePage } from "../../core/dsl/types";
import { layoutOf } from "../../core/dsl/layout-flat";
import { findParentById } from "../../core/geometry/tree-ops";
import { ancestorChain } from "../../core/interactions/component-swap";
import { findMasterComponent } from "../../core/interactions/component-inventory";
import { resolveInstanceBox } from "../../core/interactions/instance-inherit";

/**
 * The element a selection sits IN, for a node the document stores and for one it
 * only resolves.
 *
 * `findParentById` walks the stored tree, so it answers nothing for a layer
 * inside an instance: the clone exists only in the resolution. Its parent is
 * still a real element — the instance, or a frame inside the master — and it is
 * the one whose clipping and overflow decide what the child's own controls may
 * say.
 */
export function selectionParent(doc: DesignDocument, el: DesignElement): DesignElement | null {
  const elements = getActivePage(doc).children;
  const stored = findParentById(elements, el.id);
  if (stored) return stored;
  const chain = ancestorChain(doc, el.id);
  return chain.length > 1 ? chain[chain.length - 2] : null;
}

/** Whether the selection is a layer the master owns and the instance only projects. */
export function isInstanceChild(el: DesignElement): boolean {
  return Boolean((el as { __instanceId?: string }).__instanceId);
}

/**
 * Whether the parent PLACES its children — a question about the layout recipe,
 * which for an instance lives on its master. Reading it off the instance said
 * "free-flowing" for every instance whose master is a flex or a grid.
 */
export function parentPlacesChildren(doc: DesignDocument, parent: DesignElement): boolean {
  if (layoutOf(parent)) return true;
  if (parent.type !== "instance") return false;
  const master = findMasterComponent(doc, (parent as InstanceElement).componentId);
  return Boolean(master && layoutOf(master));
}

/**
 * Whether this selection may be given constraints at all.
 *
 * Constraints are geometry, and geometry inside an instance belongs to the
 * master — `constraints` is deliberately absent from `OVERRIDABLE_PROPERTIES`,
 * so a widget there would take an edit the engine cannot store. Everything a
 * layer inside an instance may own is a paint or a behaviour decision
 * (`clipContent`, `scrollBehavior`, the overridable rest).
 */
export function canConstrainChild(el: DesignElement, placesChildren: boolean): boolean {
  if (isInstanceChild(el)) return false;
  return !placesChildren || el.position === "absolute";
}

/**
 * What a container does with what it holds — the pair every scroll affordance
 * is gated on.
 *
 * An instance stores neither field unless the user set it: both are inherited
 * from the master, so reading them off the instance itself answered `false` and
 * `undefined` for an instance that scrolls perfectly well on the canvas.
 */
export function parentScrollOf(
  doc: DesignDocument,
  parent: DesignElement
): { clipContent: boolean; scrollOverflow: ScrollOverflow } {
  if (parent.type !== "instance") {
    const el = parent as { clipContent?: boolean; scrollOverflow?: ScrollOverflow };
    return { clipContent: Boolean(el.clipContent), scrollOverflow: el.scrollOverflow ?? "none" };
  }
  const instance = parent as InstanceElement;
  const master = findMasterComponent(doc, instance.componentId);
  if (!master) return { clipContent: false, scrollOverflow: "none" };
  const box = resolveInstanceBox(instance, master);
  return { clipContent: box.clipContent, scrollOverflow: box.scrollOverflow ?? "none" };
}
