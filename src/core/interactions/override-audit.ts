/**
 * What an override may address, and what is wrong with it when it addresses
 * something else.
 *
 * One rule, read from three places: the resolution refuses a property its write
 * chain has no branch for, `check` has to say the same thing about a file, and
 * `inspect` has to list the slots an author may write. A second list would answer
 * the same question with a different answer, which is exactly how an override
 * ends up "valid" in one reader and dropped in another.
 */

import { OVERRIDABLE_PROPERTIES } from "../dsl/types";
import type { ComponentElement, DesignDocument, DesignElement, OverridableProperty } from "../dsl/types";
import { findElementById } from "../geometry/tree-query";
import { findMasterComponent } from "./component-inventory";

/** The properties whose write branch exists only for a text node. */
const TEXT_ONLY: ReadonlySet<string> = new Set(["content", "style", "spans"]);

/** Everything this node can carry as an override, in the declared order. */
export function overridableFor(el: DesignElement): OverridableProperty[] {
  return el.type === "text"
    ? [...OVERRIDABLE_PROPERTIES]
    : OVERRIDABLE_PROPERTIES.filter((property) => !TEXT_ONLY.has(property));
}

/**
 * Why an override paints nothing, or null when it will apply.
 *
 * Graded against the node the write LANDS on, not against the union of names:
 * `content` on a rect is a listed property that still paints nothing, and the
 * resolution drops it through `overridableFor` — so that is the list read here.
 *
 * A path (`a/b`) descends through nested instances exactly as the resolution
 * hands the tail down, one instance per segment. The node this master holds is
 * `a`; if it is not an instance, nothing ever receives `b`.
 */
export function overrideProblem(
  master: ComponentElement,
  override: { targetId?: unknown; property?: unknown },
  doc: DesignDocument
): string | null {
  const property = String(override.property ?? "");
  if (!(OVERRIDABLE_PROPERTIES as readonly string[]).includes(property)) {
    return `"${property}" is not an overridable property`;
  }

  const path = String(override.targetId ?? "").split("/");
  const head = path[0];
  let node = head === master.id ? master : findElementById(master.children ?? [], head);
  if (!node) {
    return `"${property}" targets "${head}", which is not a node inside master "${master.name || master.id}"`;
  }

  for (const segment of path.slice(1)) {
    if (node.type !== "instance") {
      return `"${property}" targets "${segment}", but "${node.id}" is a ${node.type} — a path descends only into a nested instance`;
    }
    const nested = findMasterComponent(doc, node.componentId);
    // An unreachable master is that instance's own error; naming this override
    // for it would be a second finding for one mistake.
    if (!nested) return null;
    const next = findElementById(nested.children ?? [], segment);
    if (!next) {
      return `"${property}" targets "${segment}", which is not a node inside the nested master "${nested.name || nested.id}"`;
    }
    node = next;
  }

  if (!overridableFor(node).includes(property as OverridableProperty)) {
    return `"${property}" cannot be carried by "${node.id}" (${node.type}) — the resolution skips it and the master's value paints`;
  }
  return null;
}
