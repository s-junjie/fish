import { ComponentElement, DesignElement, InstanceElement } from "../dsl/types";
import { isContainer } from "../geometry/tree-ops";
import { createId } from "../id";

/**
 * Promoting a frame that ALREADY holds a main component.
 */

/** The stand-in a hoisted master leaves behind: its box, in its slot. */
function instanceOfMaster(master: ComponentElement): InstanceElement {
  return {
    id: createId("inst"),
    type: "instance",
    name: master.name || master.type,
    componentId: master.id,
    x: master.x,
    y: master.y,
    width: master.width,
    height: master.height,
    // The instance declares what the master declared, and now that means it: an
    // instance's `sizing` is a copy of the master's, re-pointed by
    // `propagateMasterSize`, so a hugging master leaves a hugging clone. `fill`
    // needs no flag — a master that filled its slot is still filled by its clone.
    sizing: master.sizing,
    rotation: master.rotation ?? 0,
    opacity: master.opacity ?? 1,
    visible: master.visible ?? true,
    overrides: []
  };
}

/**
 * Replaces every main component inside `children` with an instance of it, handing
 * the masters themselves back.
 *
 * Nested masters are hoisted too (a legacy document can still hold one after a
 * paste), so what lands outside never contains a definition either.
 */
export function stripInnerMasters(children: DesignElement[]): {
  children: DesignElement[];
  hoisted: ComponentElement[];
} {
  const hoisted: ComponentElement[] = [];
  return { children: strip(children, hoisted), hoisted };
}

function strip(children: DesignElement[], hoisted: ComponentElement[]): DesignElement[] {
  const out: DesignElement[] = [];
  for (const el of children) {
    if (el.type === "component") {
      const master = el as ComponentElement;
      hoisted.push({ ...master, children: strip(master.children || [], hoisted) });
      out.push(instanceOfMaster(master));
      continue;
    }
    if (el.type === "componentSet") {
      // A set is a definition container like a master, and `canCreateComponentHere`
      // refuses to promote a frame that holds one directly — but the frame can
      // still hold one indirectly, and leaving the empty shell behind would be a
      // node that draws a border around nothing. The members are hoisted like any
      // other master and an instance of the first stands in for the whole set.
      const members = (el.children || []) as ComponentElement[];
      for (const member of members) {
        hoisted.push({ ...member, children: strip(member.children || [], hoisted) });
      }
      const first = members[0];
      out.push(first ? instanceOfMaster(first) : { ...el, children: [] });
      continue;
    }
    if (isContainer(el)) {
      out.push({ ...el, children: strip(el.children || [], hoisted) });
      continue;
    }
    out.push(el);
  }
  return out;
}

/**
 * Puts the hoisted masters next to the new component — same parent, one gap to
 * the right of it, laid out in a row. The component's own slot is taken by the
 * instances, so the masters only need somewhere visible to live. Their authored
 * coordinates belong to the parent they left, so the row position is derived from
 * the component rather than converted.
 */
export function placeHoistedMasters(
  elements: DesignElement[],
  component: ComponentElement,
  masters: ComponentElement[]
): DesignElement[] {
  const GAP = 40;
  let cursor = component.x + component.width + GAP;
  const placed = masters.map((master) => {
    const next = { ...master, x: cursor, y: component.y };
    cursor += master.width + GAP;
    return next;
  });
  return insertAfterSibling(elements, component.id, placed);
}

/** Inserts `additions` right after `anchorId` in whichever list holds it. */
function insertAfterSibling(
  elements: DesignElement[],
  anchorId: string,
  additions: DesignElement[]
): DesignElement[] {
  let inserted = false;
  const walk = (list: DesignElement[]): DesignElement[] => {
    const out: DesignElement[] = [];
    for (const el of list) {
      out.push(isContainer(el) ? { ...el, children: walk(el.children || []) } : el);
      if (el.id === anchorId) {
        out.push(...additions);
        inserted = true;
      }
    }
    return out;
  };
  const next = walk(elements);
  return inserted ? next : elements;
}
