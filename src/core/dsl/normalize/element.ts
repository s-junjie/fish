import { type DesignElement, type AutoLayout, type ElementSizing, type MaskMode, type SizeMode } from "../types";
import { asNumber, asBoolean, clamp, camelCase, canonicalKey, isPlainObject, lengthUnit, pxLength, normalizeVisible, ElementType, NormalizationRepair, ELEMENT_TYPES, type RawComponentBoxes } from "./shared";
import { deepEqual } from "../../deep-equal";
import { MASK_MODES } from "../schema-enums";
import { normalizeEffects, shadowToEffect, normalizeBoxShadow } from "./effects";
import { readBlendMode, reportRefusedBlendMode } from "./blend-mode";
import { normalizeColorFilter, normalizeElementSizing, type SizingAxis } from "./text-sizing";
import { normalizeMarginShape, readGridPlacement } from "./auto-layout";
import { absorbTransform } from "./transform";
import { absorbWritingMode } from "./writing-mode";
import { readFlatAutoLayout } from "./flat-layout";
import { toCssLine } from "../layout-flat";
import { absorbFlatText, flatSizeMode, flatKeyHint } from "./css-absorb";
import { parseFilterValue } from "../../import/css-values";
import { normalizeLink } from "../link";
import { normalizeSlide } from "../slide";
import { applySizingDefaults } from "../sizing-defaults";
import { ELEMENT_BRANCHES } from "./element-branches";

/** The cross-axis overrides a child may state for itself. */
const ALIGN_SELF_VALUES: ReadonlySet<string> = new Set(["start", "center", "end", "stretch"]);

/**
 * `maskMode` is absent-by-default (`alpha`), so an unrecognised value is dropped
 * rather than guessed: defaulting a typo to `luminance` would silently turn every
 * "shows through" pixel into a brightness test.
 */export function normalizeMaskMode(raw: unknown): MaskMode | undefined {
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  const key = canonicalKey(raw);
  return (MASK_MODES as readonly string[]).includes(key) ? (key as MaskMode) : undefined;
}

// ---------------------------------------------------------------------------
// elements
// ---------------------------------------------------------------------------

/**
 * Every key `normalizeElement` recognises on an input element — canonical names
 * and the aliases they absorb.
 *
 * Two spellings only: camelCase for the DSL's own fields (`borderRadius`) and
 * kebab-case for anything CSS names (`border-radius`, `flex-direction`). Both
 * are written out here, because `canonicalKey` cannot rebuild a hyphen from a
 * camel word or the reverse for every key. `snake_case` is NEITHER — it is
 * refused by name (see `isKnownElementKey`) rather than collapsed onto a key
 * the gate has no reader for.
 *
 * A key outside this set is either copied through verbatim (when the load path
 * asks for unknown-key preservation) or dropped with a `dropped-property`
 * repair. That makes this set the answer to "does the engine read this key at
 * all", which is why it is module-level and exported: `fish.schema.json`
 * publishes the keys an author may write, and a key it declares that nothing
 * here reads is a silent no-op in a document that still round-trips and still
 * saves. `tests/version-consistency.test.ts` holds the two together.
 */
export const CANONICAL_KEYS: ReadonlySet<string> = new Set([
  "id", "type", "name", "x", "y", "width", "height", "rotation", "flipX", "flipY", "opacity",
  "rotateX", "rotateY", "perspective",
  // The CSS transform surface. `rotate` / `scale` are the standalone properties
  // and `transform` is the list; all three fold onto the four geometry fields
  // (`rotation`, `flipX`/`flipY`, `rotateX`/`rotateY`) that the renderer reads.
  "transform", "rotate", "scale",
  // Vertical text is a turned line: the reader folds this onto `rotation` and
  // swaps the box's axes, so it is a spelling, not a stored field.
  "writing-mode", "text-orientation",
  "visible", "visibility", "locked", "isMask", "maskMode", "mask-invert", "maskInvert", "effects", "filter", "adjust", "constraints", "metadata", "tokenBindings", "themeMode", "numberMode", "sizing",
  "position", "align-self", "margin", "grid-area", "grid-column", "grid-row",
  "content", "style", "text", "characters", "textColor", "assetId", "asset", "fit", "objectFit",
  // A text's own glyph outline. Carried so a mask has geometry to carry (see
  // `TextElement.outline`); absent it, a mask frame holding words masks by its
  // box, which is what Figma never means.
  "outline",
  "focalPoint", "crop", "imageCrop", "borderRadius", "radius", "cornerRadius", "border-radius",
  // CSS names one corner per property; the DSL holds four, so these fold into
  // the corner object `stroke.ts` already reads rather than owning a field.
  "border-top-left-radius", "border-top-right-radius", "border-bottom-right-radius", "border-bottom-left-radius",
  "fills", "backgroundColor", "background-color", "background", "color", "opacity", "alpha",
  "d", "path", "pathData", "fillRule", "fill-rule", "border", "borderColor", "border-color", "borderWidth", "border-width",
  "border-top", "border-right", "border-bottom", "border-left",
  "borderTopWidth", "border-top-width", "borderRightWidth", "border-right-width", "borderBottomWidth", "border-bottom-width", "borderLeftWidth", "border-left-width",
  "borderStyle", "border-style", "strokeWidth",
  // The stroke-row input spellings: a Figma per-side weight, a `sides` map or a
  // one-side selector folds into the `strokes[]` row it belongs to (`.sides` /
  // `.side`) and is never written back. A reader looks each up by the one
  // literal listed here; the other spelling of the pair reaches it through
  // `withAliasSpellings`.
  "strokeSides", "borderSides", "strokeTopWeight", "strokeRightWeight", "strokeBottomWeight", "strokeLeftWeight", "strokeSide", "borderSide",
  "from", "to", "children",
  "arrow", "arrowhead",
  "clipContent", "clipsContent", "clip", "overflow", "boxSizing", "box-sizing", "flex", "flex-grow", "layoutGrow", "flexGrow", "padding",
  // The flat CSS auto-layout keys: this IS the stored vocabulary, not an alias.
  "display", "flex-direction", "justify-content", "align-items", "align-content", "flex-wrap",
  "row-gap", "column-gap", "grid-template-columns", "grid-template-rows", "grid-auto-flow",
  "masonry", "columns-mode", "column-width-min",
  "minWidth", "maxWidth", "minHeight", "maxHeight", "min-width", "max-width", "min-height", "max-height", "boxShadow", "box-shadow",
  "backdrop-filter",
  "componentId", "overrides", "setId", "variantProperties", "variantGroupProperties",
  "fillStyleId", "strokeStyleId", "effectStyleId", "textStyleId", // Read by a per-type branch above, so the value always lands on the base
  // element — but the gate did not know that, and an unrecognised key that was
  // still handled reports a `dropped-property` repair naming a property the
  // engine had not dropped. Repairs are the agent-facing signal (p5a), so a
  // false one costs the same as a silent drop.
  "strokes", "blendMode", "blend", "mix-blend-mode", "fillEnabled", "onPath", "link", "href", "linkUrl", "slide",
  "sides", "sweep", "innerRadius", "startAngle", "gap",
  "points", "cornerSmoothing", "dx", "dy", "sizeOverride", "instanceScale", "collapsed", "spans",
  "autoplay", "loop", "muted", "controls", "posterAssetId", "src", "srcdoc", "cachedTitle", "cachedFavicon", "alwaysLive"
]);

/**
 * `CANONICAL_KEYS` through `canonicalKey`, so a spelling the normalizer reads by
 * canonical name (`flexDirection` → `flex-direction`, `alignSelf` →
 * `align-self`) is not also reported as an unknown key the engine dropped. The
 * flat CSS layout surface is read that way, so a camel spelling the reader
 * honoured must not produce a `dropped-property` repair.
 */
const CANONICAL_KEY_SET: ReadonlySet<string> = new Set([...CANONICAL_KEYS].map(canonicalKey));

/**
 * Whether the element reader knows this key.
 *
 * A key is known when it is listed exactly, or when it is a camel/kebab variant
 * of a listed key. A key carrying an UNDERSCORE is only known if it is listed
 * exactly, and none are: `canonicalKey` folds `_` to `-`, so `flip_x` would
 * otherwise collapse onto `flipX` and be accepted by a gate that has no reader
 * for it — a key that reports nothing and does nothing. Since the dialect's two
 * spellings are camelCase (DSL) and kebab-case (CSS), `snake_case` is neither,
 * and the honest answer is the loud one: `unknown property`.
 */
const isKnownElementKey = (key: string): boolean =>
  CANONICAL_KEYS.has(key) || (!key.includes("_") && CANONICAL_KEY_SET.has(canonicalKey(key)));

/**
 * Copies each authored key onto the other spelling the vocabulary lists for it.
 *
 * The gate accepts any camel/kebab variant of a listed key, but readers read one
 * literal spelling, so an unread variant was neither applied nor reported:
 * `gridColumn` stacked a child in the first free track in silence, and CSS's own
 * `stroke-width` lost the stroke the DSL's `strokeWidth` kept. Filling both
 * directions once, here, is what makes "accepted by the gate" mean "consumed by
 * a reader" without editing every reader — and it holds for keys added later.
 *
 * A key carrying an underscore is left alone: snake_case is refused by name
 * rather than folded onto a key the gate has no reader for.
 */
function withAliasSpellings(
  raw: Record<string, unknown>,
  path: string,
  repairs: NormalizationRepair[]
): Record<string, unknown> {
  let out: Record<string, unknown> | undefined;
  for (const key of Object.keys(raw)) {
    if (CANONICAL_KEYS.has(key) || key.includes("_")) continue;
    const value = raw[key];
    for (const spelling of [canonicalKey(key), camelCase(key)]) {
      if (spelling === key || !CANONICAL_KEYS.has(spelling)) continue;
      const held = (out ?? raw)[spelling];
      if (held === undefined) {
        out ??= { ...raw };
        out[spelling] = value;
      } else if (!deepEqual(held, value)) {
        repairs.push({
          kind: "dropped-property",
          path: `${path}/${key}`,
          message: `"${key}" ignored: ${spelling} is already ${JSON.stringify(held)}`
        });
      }
    }
  }
  return out ?? raw;
}

export function inferElementType(el: Record<string, unknown>): ElementType | undefined {
  // A children array with no usable type is a container, and the only container
  // type is `frame`.
  if (Array.isArray(el.children)) return "frame";
  if (
    typeof el.content === "string" ||
    typeof el.text === "string" ||
    typeof el.characters === "string" ||
    isPlainObject(el.style) ||
    typeof el.style === "string"
  ) {
    return "text";
  }
  if (
    typeof el.dx === "number" || typeof el.dy === "number" ||
    isPlainObject(el.from) || isPlainObject(el.to)
  ) {
    // Only `arrow` / `arrowhead` name what the engine draws: one head at the far
    // end, in one shape. `marker-end` / `marker-start` are refused with the gate
    // saying so — a `marker-start` would promise a head at the start and get one
    // at the end, and a `marker-end: url(#…)` would promise a glyph nothing
    // renders, the same dishonesty `arrowStart` / `arrowEnd` / `arrowSize` lost
    // their fields to.
    const hasArrow = el.arrow || el.arrowhead;
    return hasArrow ? "arrow" : "line";
  }
  if (typeof el.d === "string" || typeof el.pathData === "string") return "path";
  if (el.fills !== undefined || el.backgroundColor !== undefined || el.background !== undefined) return "rect";
  return undefined;
}

/**
 * Ids are unique across the whole document, not per page: `findMasterComponent`
 * scans every page for a component id, and `validate` builds one `componentById`
 * map across all of them. A repeated id is therefore not merely untidy — the
 * second element becomes unreachable, and an instance silently binds to the
 * first one found.
 *
 * Two different remedies, because the two cases are not the same:
 *
 *  - An id *we* synthesize must be unique by construction. The fallback counter
 *    restarts on every page, so two pages each holding an id-less component
 *    both produced `el_1`. Nothing can have meant the synthesized id yet, so
 *    stepping past the collision costs no reference.
 *  - An id the author *wrote* is left exactly as written and reported instead.
 *    Renaming it would break whatever an instance was already pointing at, and
 *    "two elements share this id" is a fact about their file, not something
 *    normalization should silently resolve on their behalf.
 */
function resolveElementId(
  raw: Record<string, unknown>,
  path: string,
  index: number,
  repairs: NormalizationRepair[],
  idPrefix: string,
  seenIds?: Set<string>
): string {
  const authored = typeof raw.id === "string" && raw.id ? raw.id : undefined;

  if (!seenIds) return authored || `${idPrefix}${index + 1}`;

  if (authored) {
    if (seenIds.has(authored)) {
      repairs.push({
        kind: "document",
        path: `${path}/id`,
        message: `id "${authored}" is already used earlier in this document; ids must be unique`
      });
    } else {
      seenIds.add(authored);
    }
    return authored;
  }

  let candidate = `${idPrefix}${index + 1}`;
  let bump = 0;
  while (seenIds.has(candidate)) {
    bump++;
    candidate = `${idPrefix}${index + 1}_${bump}`;
  }
  seenIds.add(candidate);
  return candidate;
}

export function normalizeElement(
  raw: unknown,
  path: string,
  index: number,
  repairs: NormalizationRepair[],
  idPrefix: string,
  parentLayout: AutoLayout | null,
  preserveUnknown: boolean = false,
  seenIds?: Set<string>,
  rawComponentBoxes?: RawComponentBoxes
): DesignElement | null {
  if (!isPlainObject(raw)) {
    repairs.push({ kind: "dropped-property", path, message: "element is not an object; dropped" });
    return null;
  }

  let el: Record<string, unknown> = withAliasSpellings(raw, path, repairs);

  // --- type ---------------------------------------------------------------
  const declaredType = typeof el.type === "string" ? el.type.trim() : undefined;
  // Matched case-insensitively and resolved to the canonical spelling, because
  // the vocabulary is camelCase (`componentSet`) and lower-casing the author's
  // word first would make that one type unrecognised and quietly turn a set into
  // a frame — which is invisible, because a frame holds the same children.
  const canonicalType = declaredType
    ? ELEMENT_TYPES.find((t) => t.toLowerCase() === declaredType.toLowerCase())
    : undefined;
  let type: ElementType | undefined = canonicalType;

  if (!type) {
    const inferred = inferElementType(el);
    if (inferred) {
      repairs.push({
        kind: "type",
        path: `${path}/type`,
        message: `type "${String(el.type)}" is not a DSL element type; inferred "${inferred}"`
      });
      type = inferred;
    } else {
      repairs.push({
        kind: "type",
        path: `${path}/type`,
        message: `unrecognised element type "${String(el.type)}"; defaulted to "rect"`
      });
      type = "rect";
    }
  }

  // --- geometry -----------------------------------------------------------
  // `x`/`y` are px lengths like any other: `asNumber("5%")` is 5, so a
  // percentage or em offset used to be placed as that many pixels with no
  // repair. Nothing here can resolve a percentage (there is no parent box in the
  // stored model), so the field is dropped and reported.
  const axisLength = (axis: string, value: unknown): number | undefined => {
    if (value === undefined) return undefined;
    const n = pxLength(value);
    if (n === undefined) {
      const unit = lengthUnit(value);
      repairs.push({
        kind: "element",
        path: `${path}/${axis}`,
        message: `${axis} ${JSON.stringify(value)} is not a px length${unit ? ` (carries "${unit}")` : ""}`
      });
    }
    return n;
  };
  const x = axisLength("x", el.x ?? el.left) ?? 0;
  const y = axisLength("y", el.y ?? el.top) ?? 0;
  // An instance has no box of its own until someone gives it one. Treating an
  // omitted axis as 0 made a hand-authored instance vanish (only its children
  // painted); the master's box is the only meaningful default. Only OMITTED
  // axes inherit — an explicit 0 is still the author's answer.
  const authoredWidthRaw = el.width;
  const authoredHeightRaw = el.height;
  const masterBox =
    type === "instance" && rawComponentBoxes && typeof el.componentId === "string"
      ? rawComponentBoxes.get(el.componentId)
      : undefined;
  const widthRaw = authoredWidthRaw !== undefined ? authoredWidthRaw : masterBox?.width;
  const heightRaw = authoredHeightRaw !== undefined ? authoredHeightRaw : masterBox?.height;
  const width = Math.max(0, pxLength(widthRaw) ?? 0);
  const height = Math.max(0, pxLength(heightRaw) ?? 0);
  // A non-length `width`/`height` (`"auto"`, `"100%"`) used to be written as `0`
  // with no repair: the axis default is a number, so a value CSS would derive was
  // pinned to zero. A sizing MODE is folded into `sizing` further down, so
  // only a value that is neither a length nor a mode is reported as coerced here.
  for (const [axis, rawValue] of [["width", authoredWidthRaw], ["height", authoredHeightRaw]] as const) {
    if (rawValue === undefined) continue;
    if (pxLength(rawValue) === undefined && flatSizeMode(rawValue, axis) === undefined) {
      repairs.push({
        kind: "sizing",
        path: `${path}/${axis}`,
        message: `${axis} ${JSON.stringify(rawValue)} is not a px length (belongs in sizing.${axis})`
      });
    }
  }

  const base: Record<string, unknown> = {
    id: resolveElementId(raw, path, index, repairs, idPrefix, seenIds),
    type,
    x,
    y,
    width,
    height
  };

  if (typeof el.name === "string" && el.name) base.name = el.name;

  const rotation = asNumber(el.rotation);
  if (rotation !== undefined) base.rotation = rotation;

  const flipX = asBoolean(el.flipX);
  if (flipX) base.flipX = true;

  const flipY = asBoolean(el.flipY);
  if (flipY) base.flipY = true;

  const rawAny = el as Record<string, unknown>;
  const rotateX = asNumber(rawAny.rotateX);
  if (rotateX !== undefined) base.rotateX = rotateX;
  const rotateY = asNumber(rawAny.rotateY);
  if (rotateY !== undefined) base.rotateY = rotateY;
  const perspective = asNumber(rawAny.perspective);
  if (perspective !== undefined && perspective > 0) base.perspective = perspective;

  // A CSS `transform` / `rotate` / `scale` states the same geometry these four
  // fields do, so it is folded onto them; a field written in the DSL's own
  // spelling wins over the one absorbed from CSS.
  absorbTransform(raw, base, path, repairs);
  // Vertical text is not a field: it is the line turned a quarter turn, so it is
  // folded onto the geometry the transform pass just settled.
  absorbWritingMode(el, base, type, path, repairs);

  const opacity = asNumber(el.opacity);
  if (opacity !== undefined) base.opacity = clamp(opacity, 0, 1);

  // `alpha` is whitelisted here but read only on a paint object, never on the
  // element. An element-level `alpha: 0.5` looked authored and did nothing.
  if (el.alpha !== undefined) {
    repairs.push({
      kind: "element",
      path: `${path}/alpha`,
      message: `element-level "alpha" is not read; use "opacity" (alpha is a paint-layer property)`
    });
  }

  const visible = normalizeVisible(el, path, repairs);
  if (visible !== undefined) base.visible = visible;

  // The engine measures every box with the border and padding INSIDE the width,
  // i.e. CSS's `border-box`, so `box-sizing: border-box` is the one value it can
  // honour and it is accepted silently. `content-box` asks for the other model,
  // which the engine does not implement, so it must report rather than be
  // silently overridden — a rename to the CSS name makes an author stop checking.
  const boxSizingRaw = el["box-sizing"] ?? (el as Record<string, unknown>).boxSizing;
  if (typeof boxSizingRaw === "string" && boxSizingRaw.trim()) {
    const boxSizing = canonicalKey(boxSizingRaw);
    if (boxSizing !== "border-box") {
      repairs.push({
        kind: "element",
        path: `${path}/box-sizing`,
        message:
          boxSizing === "content-box"
            ? 'box-sizing "content-box" is not supported (the engine always measures border-box); ignored'
            : `box-sizing "${boxSizingRaw}" is not one of border-box | content-box; ignored`
      });
    }
  }

  const locked = asBoolean(el.locked);
  if (locked !== undefined) base.locked = locked;

  const isMask = asBoolean(el.isMask);
  if (isMask !== undefined) base.isMask = isMask;

  // The file writes CSS `mask-mode`; `maskMode` is the engine spelling and the
  // older author spelling. The CSS key wins when both are present.
  const maskModeKey = el["mask-mode"] !== undefined ? "mask-mode" : "maskMode";
  const rawMaskMode = el[maskModeKey];
  const maskMode = normalizeMaskMode(rawMaskMode);
  if (maskMode) base.maskMode = maskMode;
  else if (typeof rawMaskMode === "string" && rawMaskMode.trim()) {
    repairs.push({
      kind: "element",
      path: `${path}/${maskModeKey}`,
      message: `${maskModeKey} "${rawMaskMode}" is not one of ${MASK_MODES.join(" | ")} and was dropped`
    });
  }

  const maskInvert = asBoolean(el["mask-invert"] ?? el.maskInvert);
  if (maskInvert !== undefined) base.maskInvert = maskInvert;

  // Both are declared on the element (types.ts), both are read downstream —
  // `resolveInstanceBox` decides whether an instance paints its own stack,
  // `export` reads the same flag — and neither was read here. The property
  // registry lists them, so a load that dropped them made the registry name a
  // key that silently did nothing: the `autoLayout` mistake with the loss on
  // our side of the file instead of the author's.
  //
  // The refusal is reported for the same reason `link`'s is: the author wrote a
  // mode the DSL publishes, and getting back a layer that blends normally is a
  // difference nothing in the document can explain.
  const blend = readBlendMode(el);
  if (blend.mode) base.blendMode = blend.mode;
  else reportRefusedBlendMode(blend, "element", `${path}/blendMode`, repairs);

  const fillEnabled = asBoolean(el.fillEnabled);
  if (fillEnabled !== undefined) base.fillEnabled = fillEnabled;

  // A refused link is reported rather than dropped in silence: the value reached
  // the field, so the author believes a layer is clickable when it is not — and
  // the two refusals (a typo'd scheme, `javascript:`) are exactly the ones worth
  // naming.
  const rawLink = el.link ?? el.href ?? el.linkUrl;
  const link = normalizeLink(rawLink);
  if (link) base.link = link;
  else if (typeof rawLink === "string" && rawLink.trim()) {
    repairs.push({
      kind: "element",
      path: `${path}/link`,
      message: `link "${rawLink}" is not an http(s), mailto: or tel: URL and was dropped`
    });
  }

  // Only a top-level container presents as a slide, so `slide` on anything else
  // is reported: it looks authored and does nothing, which is worse than a
  // dropped key the author never sees.
  if (el.slide !== undefined) {
    // `html` is here because it is a slide in its own right — see `SlideHost`.
    if (type === "frame" || type === "component" || type === "componentSet" || type === "html") {
      const slide = normalizeSlide(el.slide);
      if (slide) base.slide = slide;
    } else {
      repairs.push({
        kind: "dropped-property",
        path: `${path}/slide`,
        message: `slide is only read on a top-level frame, component, componentSet or html and was dropped from this ${type}`
      });
    }
  }

  if (isPlainObject(el.constraints)) {
    const constraints: Record<string, unknown> = {};
    const H_MODES = ["left", "right", "center", "stretch", "scale"];
    const V_MODES = ["top", "bottom", "center", "stretch", "scale"];
    if (typeof el.constraints.horizontal === "string" && H_MODES.includes(el.constraints.horizontal)) {
      constraints.horizontal = el.constraints.horizontal;
    }
    if (typeof el.constraints.vertical === "string" && V_MODES.includes(el.constraints.vertical)) {
      constraints.vertical = el.constraints.vertical;
    }
    const preserve = asBoolean(el.constraints.preserveAspectRatio);
    if (preserve !== undefined) constraints.preserveAspectRatio = preserve;
    if (Object.keys(constraints).length > 0) base.constraints = constraints;
  }

  if (isPlainObject(el.metadata)) base.metadata = el.metadata;

  if (isPlainObject(el.tokenBindings)) {
    const bindings: Record<string, string> = {};
    for (const [k, v] of Object.entries(el.tokenBindings as Record<string, unknown>)) {
      if (typeof v === "string" && v.trim()) {
        bindings[k] = v.trim();
      }
    }
    if (Object.keys(bindings).length > 0) base.tokenBindings = bindings;
  }

  if (typeof el.themeMode === "string" && el.themeMode.trim()) {
    base.themeMode = el.themeMode.trim();
  }

  if (typeof el.numberMode === "string" && el.numberMode.trim()) {
    base.numberMode = el.numberMode.trim();
  }

  // The flat CSS authored surface: fold top-level text keys into
  // `style`, a `width`/`height` that names a sizing MODE (never a length) into
  // `sizing`. Both helpers rewrite `el`; the absorbed keys are removed so the
  // unknown-key pass below never sees them. The layout spellings are read flat
  // by `readFlatAutoLayout` below, so there is no fold step for them.
  el = absorbFlatText(el, type, path, repairs);

  const flatSizing: ElementSizing = {};
  for (const [axis, rawValue] of [["width", el.width], ["height", el.height]] as const) {
    if (rawValue === undefined) continue;
    if (pxLength(rawValue) !== undefined) continue; // an authored pixel size stays where it is
    const mode = flatSizeMode(rawValue, axis);
    if (mode === "percent") {
      repairs.push({
        kind: "sizing",
        path: `${path}/${axis}`,
        message: `${axis} ${JSON.stringify(rawValue)} is a percentage the DSL cannot hold (only "100%"); dropped`
      });
    } else if (mode) {
      (flatSizing as Record<string, SizeMode>)[axis] = mode;
      repairs.push({ kind: "sizing", path: `${path}/${axis}`, severity: "info", message: `outer "${axis}" ${JSON.stringify(rawValue)} moved into sizing.${axis} = "${mode}"` });
    }
  }
  for (const [boundKey, kebabKey] of [
    ["minWidth", "min-width"],
    ["maxWidth", "max-width"],
    ["minHeight", "min-height"],
    ["maxHeight", "max-height"]
  ] as const) {
    const rawBound = el[boundKey] ?? el[kebabKey];
    if (rawBound === undefined) continue;
    const writtenKey = el[boundKey] !== undefined ? boundKey : kebabKey;
    const unit = lengthUnit(rawBound);
    const n = pxLength(rawBound);
    if (n === undefined || !Number.isFinite(n) || n < 0) {
      repairs.push({
        kind: "sizing",
        path: `${path}/${writtenKey}`,
        message: `${writtenKey} ${JSON.stringify(rawBound)} is not a px length${unit && unit !== "px" ? ` (carries "${unit}")` : ""}`
      });
    } else {
      flatSizing[boundKey] = Math.round(n * 100) / 100;
    }
  }

  // `ownLayout` is resolved here and becomes the `parentLayout` of children.
  const ownLayout = readFlatAutoLayout(el, path, repairs, type);
  const sizing: ElementSizing = {
    ...flatSizing,
    ...(normalizeElementSizing(el.sizing, path, repairs) ?? {})
  };
  applySizingDefaults(sizing, {
    type,
    ownLayout,
    parentLayout,
    authoredWidth: pxLength(el.width),
    authoredHeight: pxLength(el.height)
  });

  // `flexGrow` is the canonical spelling; `layoutGrow` (Figma) and `flex` (CSS)
  // are read as aliases, keeping the first number of `flex: 2 1 0`. A positive
  // grow means "fill along the PARENT's main axis", and that axis belongs to the
  // parent, so it can only be resolved here with `parentLayout` in hand: writing
  // a fixed `width` would stretch a child of a column along the wrong axis
  // (LESSONS_LEARNED class: axis confusion). The share itself is kept as
  // `flexGrow`, and only when it says more than the implicit equal `1`.
  const elRecord = el as Record<string, unknown>;
  const growKey = elRecord["flex-grow"] !== undefined
    ? "flex-grow"
    : elRecord.flexGrow !== undefined
      ? "flexGrow"
      : elRecord.layoutGrow !== undefined
        ? "layoutGrow"
        : "flex";
  const isCanonicalGrow = growKey === "flex-grow" || growKey === "flexGrow";
  const growRaw = elRecord[growKey];
  const grow = typeof growRaw === "number" ? growRaw : typeof growRaw === "string" ? parseFloat(growRaw) : undefined;
  // `flex: 1 1 0` and `layoutGrow: 1` both resolve to a positive grow; `0`
  // (CSS `flex: 0`) means "do not grow" and is left alone.
  if (grow !== undefined && grow > 0) {
    if (parentLayout && parentLayout.mode !== "grid") {
      const axis: "width" | "height" = parentLayout.direction === "row" ? "width" : "height";
      sizing[axis] = "fill";
      if (grow !== 1) base["flex-grow"] = grow;
      // Only an alias needs the normalization reported; an author who wrote
      // `flexGrow` already said the canonical thing.
      if (!isCanonicalGrow) {
        repairs.push({ kind: "layout", path: `${path}/${growKey}`, severity: "info", message: `"${growKey}" normalized to sizing.${axis} = "fill"` });
      }
    } else {
      // Spelled either way. Reporting only the aliases left `flex-grow` and
      // `flexGrow` silent in exactly the case the author most needs told —
      // three spellings of one idea, two of them mute.
      repairs.push({ kind: "layout", path: `${path}/${growKey}`, message: `"${growKey}" needs a flex parent to fill along; ignored` });
    }
  }

  if (Object.keys(sizing).length > 0) base.sizing = sizing;

  // Only "absolute" means out-of-flow. In-flow is absent: "relative", "static",
  // "flow" from authors thinking in CSS are accepted as "in the flow" (omitted),
  // without a noisy dropped-property repair. Any unrecognised value is reported.
  const rawLayoutPosition = typeof el.position === "string" ? el.position : "";
  const layoutPosition = canonicalKey(rawLayoutPosition);
  if (layoutPosition === "absolute") {
    base.position = "absolute";
  } else if (layoutPosition && layoutPosition !== "relative" && layoutPosition !== "static" && layoutPosition !== "flow") {
    repairs.push({
      kind: "layout",
      path: `${path}/position`,
      message: `"${rawLayoutPosition}" is not a layout position (expected "absolute")`
    });
  }

  // `start` is stored rather than folded into "absent": the two say different
  // things — absent inherits the container's `align`, `start` overrides it — so
  // dropping it would turn a deliberate override into whatever the container
  // happens to say.
  // Two spellings only — kebab `align-self` and camel `alignSelf`. A third,
  // `align_self`, is snake_case and refused by name like every other snake key
  // (the gate reports it), so the reader must not quietly honour it either.
  const rawAlignSelf = elRecord["align-self"] ?? elRecord.alignSelf;
  if (rawAlignSelf !== undefined) {
    // CSS spells the start/end of a flex line `flex-start` / `flex-end`; stored so.
    const written = canonicalKey(String(rawAlignSelf));
    const alignSelf = written === "flex-start" ? "start" : written === "flex-end" ? "end" : written;
    if (ALIGN_SELF_VALUES.has(alignSelf)) {
      base["align-self"] = toCssLine(alignSelf) as typeof base["align-self"];
    } else {
      repairs.push({
        kind: "layout",
        path: `${path}/align-self`,
        message: `"${String(rawAlignSelf)}" is not a cross-axis alignment (${[...ALIGN_SELF_VALUES].join("|")})`
      });
    }
  }

  const rawMargin = el.margin;
  if (rawMargin !== undefined) {
    const margin = normalizeMarginShape(rawMargin);
    if (margin !== undefined) {
      base.margin = margin;
    } else {
      repairs.push({
        kind: "layout",
        path: `${path}/margin`,
        message: `margin ${JSON.stringify(rawMargin)} is not a supported shape (px | "t r b l" | {t,r,b,l})`
      });
    }
  }

  const placedCell = readGridPlacement(el as Record<string, unknown>, (key, value) => {
    repairs.push({
      kind: "layout",
      path: `${path}/${key}`,
      message: `${key} ${JSON.stringify(value)} is not a CSS grid line range (e.g. "2 / span 2")`
    });
  });
  if (placedCell) base["grid-area"] = placedCell;

  // --- effects ------------------------------------------------------------
  const effects = normalizeEffects(el.effects, path, repairs);
  // CSS `backdrop-filter` is the same blur applied to what is BEHIND the layer,
  // which is exactly `backdrop-blur`. Only the blur half maps: the colour
  // adjustments act on the backdrop and have no field, so they are named.
  const backdropFilterRaw = el["backdrop-filter"];
  if (
    typeof backdropFilterRaw === "string" &&
    backdropFilterRaw.trim() &&
    backdropFilterRaw.trim() !== "none"
  ) {
    const parsed = parseFilterValue(backdropFilterRaw);
    if (parsed.blur !== undefined && parsed.blur > 0) {
      effects.push({ type: "backdrop-blur", blur: parsed.blur, enabled: true });
      repairs.push({
        kind: "effect",
        path: `${path}/backdrop-filter`,
        severity: "info",
        message: 'CSS "backdrop-filter" blur() converted to effects[].type = "backdrop-blur"'
      });
    }
    const refused = [...(parsed.filter ? Object.keys(parsed.filter) : []), ...parsed.unsupported];
    if (refused.length > 0) {
      repairs.push({
        kind: "effect",
        path: `${path}/backdrop-filter`,
        message: `backdrop-filter functions with no field on the backdrop were skipped: ${[...new Set(refused)].join(", ")}`
      });
    }
  }
  // CSS `box-shadow` string → effects. The DSL stack is bottom-first, so the
  // CSS first-listed (front-most) shadow is reversed to the end of the array.
  const boxShadowRaw = el.boxShadow ?? (el as Record<string, unknown>)["box-shadow"];
  if (typeof boxShadowRaw === "string" && boxShadowRaw.trim() && boxShadowRaw.trim() !== "none") {
    const bsEffects = normalizeBoxShadow(boxShadowRaw);
    if (bsEffects && bsEffects.length) {
      effects.push(...bsEffects);
      repairs.push({
        kind: "effect",
        path: `${path}/boxShadow`,
        severity: "info",
        message: 'CSS "boxShadow" expanded into effects[] (stored bottom-first)'
      });
    }
  }
  if (effects.length > 0) base.effects = effects;

  // Element-wide colour adjustment; `adjust` is the canonical key and legacy
  // `filter` (an object) is absorbed. A CSS `filter:` STRING is parsed by
  // `parseFilterValue` — its colour-adjustment subset merges into `adjust`,
  // while `blur()` and `drop-shadow()` become effects.
  const rawAdjust = (el as Record<string, unknown>).adjust ?? el.filter;
  const colorFilter = normalizeColorFilter(rawAdjust);
  let baseAdjust = colorFilter;
  const filterRaw = typeof rawAdjust === "string" ? rawAdjust.trim() : "";
  if (filterRaw && filterRaw !== "none") {
    const parsed = parseFilterValue(filterRaw);
    if (parsed.filter) baseAdjust = { ...(baseAdjust || {}), ...parsed.filter };
    if (parsed.blur !== undefined) effects.push({ type: "layer-blur", blur: parsed.blur, enabled: true });
    for (const sh of parsed.shadows) effects.push(shadowToEffect(sh));
    if (parsed.unsupported.length) {
      repairs.push({
        kind: "effect",
        path: `${path}/adjust`,
        message: `filter functions not expressible in the DSL were skipped: ${parsed.unsupported.join(", ")}`
      });
    }
    if (effects.length > 0) base.effects = effects;
  }
  if (baseAdjust) base.adjust = baseAdjust;

  // A style id is a string when it is bound and an explicit `null` when an
  // instance has DETACHED from its master's binding. Both are answers; only the
  // missing key means "no opinion, inherit" — and on an instance the missing key
  // is the one that hands the binding back. Dropping the `null` here is what made
  // a detach survive the click and then come back on the next load, for the same
  // reason `fills: []` and `effects: []` are kept below.
  const readStyleId = (k: string) => {
    const v = el[k];
    return typeof v === "string" ? v.trim() || undefined : v === null ? null : undefined;
  };
  const fillStyleId = readStyleId("fillStyleId");
  if (fillStyleId !== undefined) base.fillStyleId = fillStyleId;
  const strokeStyleId = readStyleId("strokeStyleId");
  if (strokeStyleId !== undefined) base.strokeStyleId = strokeStyleId;
  const effectStyleId = readStyleId("effectStyleId");
  if (effectStyleId !== undefined) base.effectStyleId = effectStyleId;

  // A container hands its children back to this function with its own id as the
  // prefix and its own layout as theirs, so a nested frame inherits the parent's
  // auto-layout without the branch knowing how recursion is wired.
  const normalizeChild = (child: unknown, childPath: string, childIndex: number): DesignElement | null =>
    normalizeElement(child, childPath, childIndex, repairs, `${String(base.id)}_`, ownLayout ?? null, preserveUnknown, seenIds, rawComponentBoxes);

  // --- per-type payload ---------------------------------------------------
  // Dispatched, not switched: the arms live in `element-branches/`, one entry
  // per `ElementType`, and a new type has to be registered there — where the
  // record's type makes a missing member a compile error rather than the silent
  // no-op a `default` used to be (LESSONS_LEARNED §38).
  ELEMENT_BRANCHES[type]({
    el,
    base,
    path,
    repairs,
    type,
    box: { x, y, width, height },
    sizing,
    ownLayout,
    normalizeChild
  });

  /* `outline` is the text glyph's own geometry, kept only as `{ d }`. CSS's
     `outline` is a ring drawn outside the box, which has no field here, and an
     author writing it got nothing back — no ring, and no word. */
  if (el.outline !== undefined && (base as Record<string, unknown>).outline === undefined) {
    repairs.push({
      kind: "dropped-property",
      path: `${path}/outline`,
      message: `outline ${JSON.stringify(el.outline)} is not a text glyph outline ({ d }); CSS's outline ring has no field — use strokes`
    });
  }

  // Report canonical properties we intentionally dropped, so a schema tightening
  // never fails silently and the model can be told what it got wrong.
  if (preserveUnknown) {
    for (const key of Object.keys(el)) {
      if (!isKnownElementKey(key) && (base as any)[key] === undefined) {
        (base as any)[key] = el[key];
      }
    }
  } else {
    for (const key of Object.keys(el)) {
      if (!isKnownElementKey(key)) {
        // The hint is derived from the vocabulary tables (`LAYOUT_FIELDS`,
        // `FLAT_TEXT_KEYS`), so a spelling they teach is one the hint knows; the
        // old hard-coded lists named five layout keys that are now folded before
        // this pass ever sees them, and offered `style.*` on frames that have no
        // style at all.
        const target = flatKeyHint(key, type);
        const hint = target ? ` (did you mean ${target}?)` : "";
        repairs.push({
          kind: "dropped-property",
          path: `${path}/${key}`,
          message: `unknown property "${key}" is unsupported${hint}`
        });
      }
    }
  }

  return base as unknown as DesignElement;
}