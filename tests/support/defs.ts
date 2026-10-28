import { Fragment } from "preact";
import { ElementDefs, renderElementDefs } from "../../src/ui/canvas/CanvasDefs";

/**
 * The def markup, with the component boundary taken out.
 *
 * `CanvasDefs` emits one `<ElementDefs>` per element, so a drag re-renders the
 * layer that moved and leaves the other 1,840 fragments alone. That is invisible
 * to a browser and very visible to a test: the markup now lives behind a
 * component, and every helper that walks `defs.props.children` stops at it.
 *
 * One definition, here, rather than a slightly different walker in each file.
 */
export function defsMarkup(node: any): any[] {
  const out: any[] = [];
  const walk = (current: any) => {
    if (!current) return;
    if (Array.isArray(current)) {
      for (const child of current) walk(child);
      return;
    }
    if (typeof current !== "object") return;
    if (current.type === ElementDefs) {
      walk(renderElementDefs(current.props));
      return;
    }
    if (current.type === Fragment) {
      walk(current.props?.children);
      return;
    }
    out.push(current);
    walk(current.props?.children);
  };
  walk(node);
  return out;
}

/** The first def matching `predicate`, or undefined. */
export function findDef(defs: any, predicate: (node: any) => boolean): any {
  return defsMarkup(defs).find(predicate);
}

/** A def by its `id` attribute. */
export function defById(defs: any, id: string): any {
  return findDef(defs, (node) => node?.props?.id === id);
}
