import type { DesignElement } from "../../types";
import { flattenLayout } from "../../layout-flat";
import { asBoolean, isPlainObject, normalizeOverflow, normalizeScrollOffset } from "../shared";
import { normalizeFillStack } from "../paint";
import { normalizeLayoutGuides } from "../layout-guides";
import { cornerRadiusInput, normalizeCornerRadius, normalizeStrokes } from "../stroke";
import { normalizeCornerControls, type ElementBranch } from "./shared";

export const normalizeContainer: ElementBranch = ({ el, base, path, repairs, type, ownLayout, normalizeChild, box }) => {
  const rawChildren = Array.isArray(el.children) ? el.children : [];
  const children: DesignElement[] = [];
  rawChildren.forEach((child, childIndex) => {
    const normalized = normalizeChild(child, `${path}/children/${childIndex}`, childIndex);
    if (normalized) children.push(normalized);
  });
  base.children = children;

  // Frames take a fill stack too (CSS `background` is absorbed by the same
  // helper); an absent stack keeps the frame a structural wrapper.
  const fills = normalizeFillStack(el, path, repairs);
  if (fills && fills.length > 0) base.fills = fills;

  const strokes = normalizeStrokes(el, path, repairs);
  if (strokes) base.strokes = strokes;

  // Absent means visible: a frame may be a purely structural wrapper, and a
  // default that hides overflowing children is the more destructive guess. A
  // box that MEANS to clip says so, which is what makes `grep overflow` honest.
  Object.assign(base, normalizeOverflow(el, path, repairs));
  const sx = normalizeScrollOffset(el.scrollX ?? el.scrollLeft ?? el["scroll-x"] ?? el["scroll-left"]);
  if (sx !== undefined && sx > 0) base.scrollX = sx;
  const sy = normalizeScrollOffset(el.scrollY ?? el.scrollTop ?? el["scroll-y"] ?? el["scroll-top"]);
  if (sy !== undefined && sy > 0) base.scrollY = sy;

  const radius = normalizeCornerRadius(cornerRadiusInput(el), path, repairs, box);
  if (radius !== undefined) base.borderRadius = radius;
  // Smoothing rides along with the radius; a componentSet is a group of
  // definitions and paints nothing, so it has no corners to smooth.
  if (type !== "componentSet") normalizeCornerControls(el, base, true);

  if (ownLayout && type !== "componentSet") Object.assign(base, flattenLayout(ownLayout));

  // Guides are the author's ruler over this box, so they belong to the two types
  // that HAVE a box the author lays out in. A componentSet is fitted to its
  // variants on every load, so a guide on it would point at a size that is about
  // to change under it — reported, not dropped, and not stored.
  if (type === "componentSet") {
    if (el.layoutGuides !== undefined || el["layout-guides"] !== undefined) {
      repairs.push({
        kind: "layout",
        path: `${path}/layoutGuides`,
        message:
          'type "componentSet" has no stable box — it is fitted to its variants on load — so layout guides cannot be stored on it. Put them on the variants.'
      });
    }
  } else {
    const guides = normalizeLayoutGuides(el, path, repairs);
    if (guides && guides.length > 0) base.layoutGuides = guides;
  }

  if (type === "componentSet") {
    // Reported, not dropped: a set is a group of definitions and a stack is
    // what arranges artwork. The key survives as written so the author can see
    // that their file still declares one, and the set lays its children out
    // itself (`fitComponentSet`).
    if (ownLayout) {
      repairs.push({
        kind: "layout",
        path: `${path}/layout`,
        message:
          'type "componentSet" has no Auto-Layout; its variants are positioned freely and the set fits itself. The declared layout was ignored.'
      });
    }
    if (asBoolean(el.collapsed) === true) base.collapsed = true;
    // A bare string for one value is coerced rather than dropped: it reads as
    // an axis with a single option, which is what an author who wrote
    // `{"State": "Hover"}` meant, and dropping it would leave a set whose
    // members carry coordinates nothing can read.
    const rawTable = el.variantGroupProperties;
    if (isPlainObject(rawTable)) {
      const table: Record<string, string[]> = {};
      for (const [property, values] of Object.entries(rawTable)) {
        const list = Array.isArray(values)
          ? values.filter((v) => typeof v === "string")
          : typeof values === "string"
            ? [values]
            : [];
        if (list.length > 0) table[property] = list;
      }
      base.variantGroupProperties = table;
    }
  }

  if (type === "component") {
    if (typeof el.setId === "string") base.setId = el.setId;
    if (isPlainObject(el.variantProperties)) base.variantProperties = el.variantProperties;
  }
};
