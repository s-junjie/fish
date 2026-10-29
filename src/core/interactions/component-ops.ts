import {
  ComponentElement,
  ComponentOverride,
  DesignDocument,
  DesignElement,
  FrameElement,
  InstanceElement,
  getActivePage,
  updateActivePageElements
} from "../dsl/types";
import { deepEqual } from "../deep-equal";
import { resolveInstanceBox, resolveInstanceNumberMode, resolveInstanceTheme } from "./instance-inherit";
import {
  findElementById,
  insideComponent,
  mapElements,
  reparentSelectionIntoFrame
} from "../geometry/tree-ops";
import { placeHoistedMasters, stripInnerMasters } from "./component-hoist";
import { createId } from "../id";
import { findMasterComponent } from "./component-inventory";
import { resolveInstanceContent, stripDerivedMarkers } from "./instance-resolve";
import { instanceScaleOf, scaleLayout } from "../geometry/scale-geometry";
import { getActiveNumberMode, getActiveTheme } from "./mode-ops";
import { styleTables } from "./style-tables";
import { layoutOf, withLayout } from "../dsl/layout-flat";

const round2 = (n: number): number => Math.round(n * 100) / 100;


function buildComponentWrapper(el: DesignElement): FrameElement {
  return {
    id: createId("frame"),
    type: "frame",
    name: el.name || el.type,
    x: el.x,
    y: el.y,
    width: el.width,
    height: el.height,
    children: [],
    clipContent: false
  };
}

/**
 * Turns any element into a main component, in place.
 *
 * A frame becomes the component directly; anything else is first wrapped by
 * `buildComponentWrapper` and re-based into it through
 * `reparentSelectionIntoFrame` — the same builder the group/wrap commands use,
 * so the wrapper lands at the element's index in the element's own parent and
 * the element keeps its on-screen position (children are stored in local
 * coordinates). The id changes on that path, so callers must select
 * `component.id` rather than the id they passed in.
 *
 * A frame that already holds a main component is promoted by HOISTING those
 * masters out (`component-hoist.ts`) and leaving instances behind: a component may
 * be used inside another component, but never defined inside one.
 */
export function createComponentFromElement(
  doc: DesignDocument,
  elementId: string
): { doc: DesignDocument; component: ComponentElement | null; hoisted: ComponentElement[] } {
  const activePage = getActivePage(doc);
  const target = findElementById(activePage.children, elementId);
  if (!target || insideComponent(activePage.children, target.id)) {
    return { doc, component: null, hoisted: [] };
  }

  const container: FrameElement =
    target.type === "frame" ? (target as FrameElement) : buildComponentWrapper(target);
  const tree =
    target.type === "frame"
      ? activePage.children
      : reparentSelectionIntoFrame(activePage.children, [target], container);

  const node = findElementById(tree, container.id) as FrameElement | null;
  if (!node) return { doc, component: null, hoisted: [] };

  const { children, hoisted } = stripInnerMasters(node.children || []);
  const component: ComponentElement = {
    ...node,
    children,
    type: "component",
    name: node.name ? node.name : `Component ${node.id}`
  };

  let updatedElements = mapElements(tree, (el) => (el.id === component.id ? component : el));
  if (hoisted.length > 0) {
    updatedElements = placeHoistedMasters(updatedElements, component, hoisted);
  }
  return {
    doc: {
      ...updateActivePageElements(doc, updatedElements),
      updatedAt: new Date().toISOString()
    },
    component,
    hoisted
  };
}

export function createInstanceFromComponent(
  doc: DesignDocument,
  componentId: string,
  position?: { x: number; y: number }
): { doc: DesignDocument; instance: InstanceElement | null } {
  const master = findMasterComponent(doc, componentId);
  if (!master) {
    return { doc, instance: null };
  }

  const instance: InstanceElement = {
    id: createId("inst"),
    type: "instance",
    // An instance is the master under another name only in the tree — in the
    // layer panel it IS the master, so it carries the master's name verbatim.
    name: master.name,
    componentId: master.id,
    x: position ? position.x : master.x + 40,
    y: position ? position.y : master.y + 40,
    width: master.width,
    height: master.height,
    // The sizing comes across with the box for the same reason: an instance with
    // no `sizing` inherits whatever the master declares, and until this was copied
    // a new instance started out reading as Fixed while the master it projects was
    // hugging — the size menu and the canvas disagreeing from the first frame.
    sizing: master.sizing,
    rotation: master.rotation ?? 0,
    opacity: master.opacity ?? 1,
    visible: master.visible ?? true,
    // NO overrides. A change the user has not made is absent, and the resolution
    // reads the master's own layer for it — which is what keeps "edit the master,
    // every instance follows" true. Materialising the defaults here froze the
    // link at the moment the instance was born.
    overrides: []
  };

  const activePage = getActivePage(doc);
  return {
    doc: {
      ...updateActivePageElements(doc, [...activePage.children, instance]),
      updatedAt: new Date().toISOString()
    },
    instance
  };
}

/**
 * The instance's own fields that Reset gives back, as data rather than as two
 * hand-written lists.
 *
 * There used to be two: the list `resetInstanceOverrides` deletes, and the check
 * `hasAnythingToReset` makes to decide whether there is anything to reset at all.
 * They disagreed — the check never looked at `strokes`, `stroke`, `fillEnabled`,
 * `sizing` or the four `*StyleId`s — so an instance whose only change was one of
 * those reported "nothing to reset" while the reset would in fact have done
 * something, and the button that opens it stayed disabled.
 *
 * `sizing` is deleted like the rest, but the CHECK treats it differently: it is
 * copied from the master at creation, so presence is not evidence of an edit. See
 * `hasAnythingToReset`.
 */
const RESET_KEYS = [
  "fills",
  "strokes",
  "stroke",
  "effects",
  "clipContent",
  "borderRadius",
  "fillEnabled",
  "fillStyleId",
  "strokeStyleId",
  "textStyleId",
  "effectStyleId",
  "sizing",
  // Back to the master means back to the mode it was AUTHORED in. Without this a
  // theme the user pinned on one instance outlived every other override. Both
  // axes: a density pinned on one instance outlives its master the same way.
  "themeMode",
  "numberMode",
  // And back to 1x, which is the same promise for the contents: a scale left
  // behind keeps type and padding off the master's own values while the box reads
  // as the master's size.
  "instanceScale"
] as const;

/**
 * Back to the master: props and overrides go, and so does a hand-set box. The
 * size is not an override in the document model — it is a copied field plus a
 * `sizeOverride` flag — but from the user's side it is the change they can see,
 * so leaving it would make Reset visibly incomplete.
 */
export function resetInstanceOverrides(
  instance: InstanceElement,
  master?: ComponentElement
): InstanceElement {
  const next: InstanceElement = { ...instance, overrides: [] };
  delete next.sizeOverride;
  // `sizing` is the same kind of copy, with the same absent-means-inherit reading,
  // so "back to the master" has to give it back too — otherwise a Fixed the user
  // pinned on one axis outlives the reset. It is in `RESET_KEYS`, which is also
  // what makes `hasAnythingToReset` agree.
  if (master) {
    next.width = master.width;
    next.height = master.height;
  }
  // The instance's OWN paint fields are overrides too, and by the same presence
  // rule an `effects: []` is an answer rather than an absence: it suppresses the
  // master's shadow. Leaving them here meant "back to the master" still came back
  // with the master switched off.
  for (const key of RESET_KEYS) {
    delete (next as unknown as Record<string, unknown>)[key];
  }
  return next;
}

export function removeInstanceOverrides(
  doc: DesignDocument,
  instanceId: string,
  masterNodeId: string
): DesignDocument | null {
  const target = findElementById(getActivePage(doc).children, instanceId);
  if (!target || target.type !== "instance") return null;
  const inst = target as InstanceElement;
  const remaining = (inst.overrides || []).filter((o) => o.targetId !== masterNodeId);
  if (remaining.length === (inst.overrides || []).length) return null;
  const nextInst: InstanceElement = { ...inst, overrides: remaining };
  const next = updateActivePageElements(
    doc,
    mapElements(getActivePage(doc).children, (el) => (el.id === instanceId ? nextInst : el))
  );
  return { ...next, updatedAt: new Date().toISOString() };
}

/**
 * Removes ONE property's override from one node, leaving the rest of that node's
 * changes in place.
 *
 * The counterpart of `removeInstanceOverrides`, which is all-or-nothing: a user
 * who changed the fill AND the radius of a child and wants its fill back had to
 * lose the radius too. Removing hands the property to the master again, which is
 * what "reset just this" means.
 */
export function removeInstanceOverrideProperty(
  doc: DesignDocument,
  instanceId: string,
  masterNodeId: string,
  property: ComponentOverride["property"]
): DesignDocument | null {
  const target = findElementById(getActivePage(doc).children, instanceId);
  if (!target || target.type !== "instance") return null;
  const inst = target as InstanceElement;
  const overrides = inst.overrides || [];
  const remaining = overrides.filter((o) => !(o.targetId === masterNodeId && o.property === property));
  if (remaining.length === overrides.length) return null;
  const nextInst: InstanceElement = { ...inst, overrides: remaining };
  const next = updateActivePageElements(
    doc,
    mapElements(getActivePage(doc).children, (el) => (el.id === instanceId ? nextInst : el))
  );
  return { ...next, updatedAt: new Date().toISOString() };
}

/**
 * Back to the master for the WHOLE instance: props, every override on every node,
 * and a hand-set box.
 *
 * Distinct from `removeInstanceOverrides`, which resets ONE node. An instance
 * nested inside another component only ever reached the latter — `ComponentSection`
 * carries the instance-level control and is suppressed for instance children — so
 * there was no way back from a swapped icon, a changed label, or a hand-resized
 * box without detaching, which is not a reversible answer.
 */
export function resetInstance(doc: DesignDocument, instanceId: string): DesignDocument | null {
  const target = findElementById(getActivePage(doc).children, instanceId);
  if (!target || target.type !== "instance") return null;
  const inst = target as InstanceElement;
  const master = findMasterComponent(doc, inst.componentId) ?? undefined;
  if (!hasAnythingToReset(inst, master)) return null;
  const nextInst = resetInstanceOverrides(inst, master);
  const next = updateActivePageElements(
    doc,
    mapElements(getActivePage(doc).children, (el) => (el.id === instanceId ? nextInst : el))
  );
  return { ...next, updatedAt: new Date().toISOString() };
}

/**
 * Whether "reset the instance" would change anything — drives the button's state.
 *
 * Takes the master because one of the fields Reset clears is not evidence of its
 * own. `sizing` is COPIED from the master when the instance is created (the box
 * comes across with it, so the size menu and the canvas agree from the first
 * frame), which means every instance of a master that declares sizing — a hugging
 * one, or one that fills an axis — was born "dirty": Reset lit up, and pressing it
 * wrote a commit and an undo step while the picture stayed identical. Only a
 * `sizing` that DIFFERS from the master's is a change the user made. A master with
 * no `sizing` copies none, so it says nothing either way and the other keys decide.
 *
 * Without a master the old reading stands (present means changed), which is the
 * honest answer when there is nothing to compare against.
 */
export function hasAnythingToReset(inst: InstanceElement, master?: ComponentElement): boolean {
  if ((inst.overrides?.length ?? 0) > 0) return true;
  if (inst.sizeOverride === true) return true;
  // Reads the same list Reset writes, so the button's enabled state cannot drift
  // from what pressing it would do. `sizing` is the one entry that needs the
  // comparison above rather than a presence test.
  for (const key of RESET_KEYS) {
    if (key === "sizing") continue;
    if ((inst as unknown as Record<string, unknown>)[key] !== undefined) return true;
  }
  return inst.sizing !== undefined && !deepEqual(inst.sizing, master?.sizing);
}

/**
 * The instance's own fields that differ from its master — what "this instance is
 * not just its master" is made of, one entry per thing a user can give back.
 *
 * `sizing` is the only entry that cannot be answered by presence: it is copied
 * from the master at creation, so it counts only when it DIFFERS. `size` and
 * `instanceScale` are the two that move the box rather than a style, and each is
 * a separate tag because giving back a hand-resized box is not giving back a
 * scale.
 */
export type InstanceOwnField = "size" | "instanceScale" | (typeof RESET_KEYS)[number];

export function instanceOwnFields(inst: InstanceElement, master?: ComponentElement): InstanceOwnField[] {
  const out: InstanceOwnField[] = [];
  if (inst.sizeOverride === true) out.push("size");
  for (const key of RESET_KEYS) {
    if (key === "sizing") continue;
    if ((inst as unknown as Record<string, unknown>)[key] !== undefined) out.push(key);
  }
  if (inst.sizing !== undefined && !deepEqual(inst.sizing, master?.sizing)) out.push("sizing");
  return out;
}

/**
 * Gives ONE of those fields back to the master.
 *
 * The all-or-nothing Reset is the wrong answer to "keep my copy change but drop
 * the fill I tried" — the same argument that put per-property tags on an instance
 * child. Reset stays the one-click escape; this is the scalpel.
 */
export function resetInstanceField(
  doc: DesignDocument,
  instanceId: string,
  field: InstanceOwnField
): DesignDocument | null {
  const target = findElementById(getActivePage(doc).children, instanceId);
  if (!target || target.type !== "instance") return null;
  const inst = target as InstanceElement;
  const master = findMasterComponent(doc, inst.componentId) ?? undefined;
  if (!instanceOwnFields(inst, master).includes(field)) return null;

  const nextInst: InstanceElement = { ...inst };
  if (field === "size") {
    // The hand-set box goes; a scale the user also applied STAYS, and the box it
    // produces is master × factor. Clearing both here meant one tag on the panel
    // undid two different edits.
    delete nextInst.sizeOverride;
    if (master) {
      const scale = instanceScaleOf(inst);
      nextInst.width = round2(master.width * scale.x);
      nextInst.height = round2(master.height * scale.y);
    }
  } else if (field === "instanceScale") {
    // The factor goes; a hand-set box is still the user's, so only an instance
    // that was tracking its master takes the master's size back.
    delete (nextInst as { instanceScale?: unknown }).instanceScale;
    if (master && nextInst.sizeOverride !== true) {
      nextInst.width = master.width;
      nextInst.height = master.height;
    }
  } else {
    delete (nextInst as unknown as Record<string, unknown>)[field];
  }

  const next = updateActivePageElements(
    doc,
    mapElements(getActivePage(doc).children, (el) => (el.id === instanceId ? nextInst : el))
  );
  return { ...next, updatedAt: new Date().toISOString() };
}

/**
 * Unlink ONE property of one node inside an instance.
 *
 * `removeInstanceOverrides` drops every override on a node at once, which is the
 * right answer for "reset this node" and the wrong one for "I want my own colour
 * here but the master's everything else" — the edit a user makes when a child
 * inherits a fill they want to change. There was no way to express that, because
 * the only control was the all-or-nothing one, so the answer was to detach the
 * whole instance.
 *
 * Freezing rather than deleting: the override must KEEP the master's current value,
 * because the alternative — removing it — hands the field straight back to the
 * master, and the master's next edit would undo the change the user just made.
 * That is the same pin a normal override is, entered deliberately.
 */
export function unlinkInstanceOverride(
  doc: DesignDocument,
  instanceId: string,
  masterNodeId: string,
  property: ComponentOverride["property"],
  value: unknown
): DesignDocument | null {
  const target = findElementById(getActivePage(doc).children, instanceId);
  if (!target || target.type !== "instance") return null;
  const inst = target as InstanceElement;
  const overrides = inst.overrides || [];
  // Already linked: nothing to freeze, and a second freeze would be a silent no-op
  // that the panel would render as a successful unlink.
  if (overrides.some((o) => o.targetId === masterNodeId && o.property === property)) return null;
  const nextInst: InstanceElement = {
    ...inst,
    overrides: [...overrides, { targetId: masterNodeId, property, value }]
  };
  const next = updateActivePageElements(
    doc,
    mapElements(getActivePage(doc).children, (el) => (el.id === instanceId ? nextInst : el))
  );
  return { ...next, updatedAt: new Date().toISOString() };
}

/**
 * Whether a node inside an instance is linked for one property, i.e. whether the
 * panel should offer the unlink at all. The panel shows an action that would do
 * nothing only when the state is already what the action would produce.
 */
export function isInstancePropertyLinked(
  doc: DesignDocument,
  instanceId: string,
  masterNodeId: string,
  property: ComponentOverride["property"]
): boolean {
  const target = findElementById(getActivePage(doc).children, instanceId);
  if (!target || target.type !== "instance") return false;
  return (target as InstanceElement).overrides?.some(
    (o) => o.targetId === masterNodeId && o.property === property
  ) === true;
}

export function detachInstance(
  doc: DesignDocument,
  instanceId: string,
  masterComp?: ComponentElement
): { doc: DesignDocument; frame: FrameElement | null } {
  const activePage = getActivePage(doc);
  const target = findElementById(activePage.children, instanceId);
  if (!target || target.type !== "instance") {
    return { doc, frame: null };
  }

  const instance = target as InstanceElement;
  const master = masterComp || findMasterComponent(doc, instance.componentId);
  if (!master) {
    return { doc, frame: null };
  }

  // The modes the instance renders under, and the tables it resolves against — the
  // children below are materialised HERE, once, so the detached frame carries the
  // colours and the spacing the canvas was painting rather than whatever the next
  // sync decides. Both axes travel: a compact instance detached without its number
  // mode re-materialised its children under the colour mode, and its padding came
  // out at the comfortable density.
  const tables = styleTables(doc);
  const theme = resolveInstanceTheme(instance, master, getActiveTheme(doc));
  const resolvedNumberMode = resolveInstanceNumberMode(instance, master, getActiveNumberMode(doc));

  const clonedChildren = resolveInstanceContent(instance, master, {
    theme,
    numberMode: resolvedNumberMode,
    tables
  }).children.map(stripDerivedMarkers);
  // Everything the instance PAINTS transfers through the same resolver the canvas
  // used, so a detached frame looks exactly like the instance did: fields the
  // instance set itself stay, the rest come from the master. Copying `master.*`
  // wholesale (the old shape) erased an effect the user had added to the instance.
  const box = resolveInstanceBox(instance, master, undefined, {
    theme,
    numberMode: resolvedNumberMode,
    tables
  });
  // A scaled instance's children arrive at ITS size, so the frame has to keep the
  // recipe at that size too: the master's 1x padding and gaps would reflow the
  // scaled content the first time a layout pass ran over the detached frame.
  const scale = instanceScaleOf(instance);
  const scaled = scale.x !== 1 || scale.y !== 1;
  const layout = layoutOf(master);
  const frameLayout =
    layout && scaled ? scaleLayout(layout, scale.x, scale.y, Math.min(scale.x, scale.y)) : layout;
  // The MODE is part of that look, and the resolver deliberately does not report
  // it — an instance's colours come out of the theme tables already. A detached
  // frame has no master to fall back on, so the mode it was resolved under has to
  // be written down or the artwork silently changes sides on the next theme switch.
  const themeMode = instance.themeMode ?? master.themeMode;
  const numberMode = instance.numberMode ?? master.numberMode;

  const frame: FrameElement = withLayout(
    {
      id: instance.id,
      type: "frame",
      name: instance.name || master.name,
      x: instance.x,
      y: instance.y,
      width: box.width,
      height: box.height,
      rotation: instance.rotation,
      opacity: instance.opacity,
      visible: instance.visible,
      fills: box.fills,
      strokes: box.strokes,
      clipContent: box.clipContent,
      borderRadius: box.borderRadius,
      effects: box.effects,
      ...(themeMode ? { themeMode } : {}),
      ...(numberMode ? { numberMode } : {}),
      children: clonedChildren
    } as FrameElement,
    frameLayout
  );

  const updatedElements = mapElements(activePage.children, (el) => (el.id === instanceId ? frame : el));

  return {
    doc: {
      ...updateActivePageElements(doc, updatedElements),
      updatedAt: new Date().toISOString()
    },
    frame
  };
}
