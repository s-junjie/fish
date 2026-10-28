import { DesignDocument, DesignElement, InstanceElement } from "../dsl/types";
import { ChildSizeResolver } from "../layout/box";
import { findMasterComponent } from "./component-inventory";
import { resolveInstanceContent } from "./instance-resolve";

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
