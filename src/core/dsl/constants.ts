import type { OverridableProperty } from "./types";

/**
 * The element fields that name a `doc.styles[]` entry.
 *
 * One list because five readers walk it — the load-time dangling-reference
 * check, the style delete's unbind, the usage count, and both halves of the
 * cross-file clipboard — and a field any one of them forgets is a binding that
 * survives the delete of its style, counts as zero uses, is not carried by a
 * copy, or is reported as dangling on every load. `textStyleId` only ever
 * appears on a text layer and `layoutGuideStyleId` only on a container; reading
 * the key off the wrong type yields `undefined`, which is what keeps the list
 * flat.
 */
export const STYLE_BINDING_FIELDS = [
  "fillStyleId",
  "strokeStyleId",
  "effectStyleId",
  "textStyleId",
  "layoutGuideStyleId"
] as const;

/**
 * Exhaustive on purpose: adding a member to `OverridableProperty` without
 * listing it here is a compile error, and listing something that is not a member
 * is too. Four hand-written copies of this list used to drift — the readers had
 * 14 entries while the writers had 18, so the four style bindings below were
 * written as overrides and silently filtered out by `normalize` on the next
 * load. The other copies now import `OVERRIDABLE_PROPERTIES` instead of
 * restating it, and `tests/version-consistency.test.ts` holds it against the
 * schema.
 */
const OVERRIDABLE_PROPERTY_MAP: Record<OverridableProperty, true> = {
  content: true,
  style: true,
  spans: true,
  fills: true,
  strokes: true,
  effects: true,
  adjust: true,
  borderRadius: true,
  cornerSmoothing: true,
  blendMode: true,
  link: true,
  visible: true,
  opacity: true,
  fillEnabled: true,
  assetId: true,
  locked: true,
  overflow: true,
  componentId: true,
  fillStyleId: true,
  strokeStyleId: true,
  textStyleId: true,
  effectStyleId: true,
  tokenBindings: true,
  themeMode: true,
  numberMode: true,
  scrollX: true,
  scrollY: true,
  scrollBehavior: true
};

export const OVERRIDABLE_PROPERTIES = Object.keys(
  OVERRIDABLE_PROPERTY_MAP
) as readonly OverridableProperty[];

/** The dash pattern `style: "dashed"` stands for when no `dashArray` is given. */
export const DEFAULT_DASH: readonly number[] = [6, 4];
