import type { DesignElement } from "../../types";
import { flattenLayout } from "../../layout-flat";
import { asBoolean, isPlainObject, normalizeClipContent } from "../shared";
import { normalizeFillStack } from "../paint";
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

  const clip = normalizeClipContent(el, path, repairs);
  // Defaults to false: a frame may be a purely structural wrapper, and a
  // default that hides overflowing children is the more destructive guess.
  base.clipContent = clip ?? false;

  const radius = normalizeCornerRadius(cornerRadiusInput(el), path, repairs, box);
  if (radius !== undefined) base.borderRadius = radius;
  // Smoothing rides along with the radius; a componentSet is a group of
  // definitions and paints nothing, so it has no corners to smooth.
  if (type !== "componentSet") normalizeCornerControls(el, base, true);

  if (ownLayout && type !== "componentSet") Object.assign(base, flattenLayout(ownLayout));

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
