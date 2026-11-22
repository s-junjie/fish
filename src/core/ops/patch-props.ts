import type { AutoLayout, DesignDocument, DesignElement, ElementType } from "../dsl/types";
import { getActivePage } from "../dsl/document-ops";
import { OVERRIDABLE_PROPERTIES } from "../dsl/constants";
import { commitInstanceOverrides, type InstanceSelection } from "../interactions/instance-resolve";
import { findParentById } from "../geometry/tree-ops";
import { FLAT_LAYOUT_KEYS, layoutOf } from "../dsl/layout-flat";
import { resolveContentInsets } from "../layout/box";
import { resolveStrokeWeights } from "../geometry/stroke-utils";
import { normalizeElement, isPositionAlias, positionAxisOf, unknownElementKey } from "../dsl/normalize/element";
import { canonicalKey, pxLength } from "../dsl/normalize/shared";
import type { NormalizationRepair } from "../dsl/normalize/shared";
import {
  applyTokenShorthandsToElement,
  createTokenVarResolver,
  TOKEN_SHORTHAND_BINDINGS,
  type ShorthandModes
} from "../dsl/normalize/token-shorthand";
import { withoutNumberBinding } from "../dsl/token-bindings";
import { FLAT_TEXT_KEYS, flatKeyHint } from "../dsl/normalize/css-absorb";
import { CSS_KEY_MAP } from "../dsl/css-spelling";
import {
  collectVariables,
  hasVarCallInValue,
  resolveValueTokens,
  type Variables
} from "../dsl/normalize/resolve-values";
import { isObj, type OpOutcome } from "./op-primitives";

export function mergeProps(
  target: Record<string, unknown>,
  patch: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...target };
  for (const [key, value] of Object.entries(patch)) {
    // `null` is the only way to say "unset this": deleting a key in JSON has no
    // other spelling, and the DSL reads absence on `fills` / `effects` / `sizing`.
    if (value === null) {
      delete out[key];
      continue;
    }
    const prev = out[key];
    out[key] = isObj(value) && isObj(prev) ? mergeProps(prev, value) : value;
  }
  return out;
}

/** Every `style` spelling the file uses, mapped to the stored text field. */
const TEXT_TARGET_BY_CANON = new Map<string, string>();
for (const [css, stored] of Object.entries(FLAT_TEXT_KEYS)) {
  const canon = canonicalKey(css);
  if (!TEXT_TARGET_BY_CANON.has(canon)) TEXT_TARGET_BY_CANON.set(canon, stored);
}

/** The property names that are CSS spellings rather than stored field names. */
export const CSS_PATCH_SPELLINGS: ReadonlySet<string> = new Set(
  [
    ...Object.values(CSS_KEY_MAP).filter((key) => key !== "(flattened)"),
    ...Object.keys(FLAT_TEXT_KEYS),
    ...FLAT_LAYOUT_KEYS,
    "border",
    "border-top",
    "border-right",
    "border-bottom",
    "border-left",
    "border-width",
    "border-color",
    "border-style",
    "stroke-width",
    "border-top-width",
    "border-right-width",
    "border-bottom-width",
    "border-left-width",
    "border-top-color",
    "border-right-color",
    "border-bottom-color",
    "border-left-color",
    "border-top-style",
    "border-right-style",
    "border-bottom-style",
    "border-left-style",
    "border-top-left-radius",
    "border-top-right-radius",
    "border-bottom-right-radius",
    "border-bottom-left-radius",
    "radius",
    "corner-radius",
    "background",
    "background-color",
    "box-shadow",
    "filter",
    "backdrop-filter",
    "grid-column",
    "grid-row",
    "grid-area",
    "flex",
    "flex-grow",
    "layout-grow",
    "align-self",
    "margin",
    "object-fit",
    "fit",
    "focal-point",
    "image-crop",
    "crop",
    "href",
    "link-url",
    // Input spellings the normalizer folds but CSS_KEY_MAP never names: without
    // them a patch carrying only one of these keys skips the normalizer and the
    // raw key survives on the stored element (a `white-space` that never became
    // a width, a `view-box` the renderer never baked).
    "view-box",
    "white-space",
    "overflow-x",
    "overflow-y",
    "skew-x",
    "skew-y",
    "rotate-x",
    "rotate-y"
  ].map(canonicalKey)
);

/**
 * Kebab spellings the normalizer only reads in its stored camelCase form. The
 * patch surface accepts the CSS spelling, so the key is renamed to what the
 * reader takes before the merge — otherwise the folded result stores a dead
 * `"skew-x"` beside the live `skewX` the renderer actually reads.
 */
const PATCH_KEY_FOLD: Readonly<Record<string, string>> = {
  "view-box": "viewBox",
  "white-space": "whiteSpace",
  "overflow-x": "overflowX",
  "overflow-y": "overflowY",
  "skew-x": "skewX",
  "skew-y": "skewY",
  "rotate-x": "rotateX",
  "rotate-y": "rotateY"
};

export const STRING_LENGTH_AXES: ReadonlySet<string> = new Set(["x", "y", "width", "height", "perspective"]);

const SIZING_BOUNDS = [
  ["min-width", "minWidth"],
  ["max-width", "maxWidth"],
  ["min-height", "minHeight"],
  ["max-height", "maxHeight"]
] as const;

const BORDER_SIDE_WIDTH_KEYS = [
  "border-top-width",
  "border-right-width",
  "border-bottom-width",
  "border-left-width"
] as const;

const BORDER_SIDE_COLOR_KEYS = [
  "border-top-color",
  "border-right-color",
  "border-bottom-color",
  "border-left-color"
] as const;

const BORDER_SIDE_STYLE_KEYS = [
  "border-top-style",
  "border-right-style",
  "border-bottom-style",
  "border-left-style"
] as const;

const STROKE_SIDES = ["top", "right", "bottom", "left"] as const;
type StrokeSideName = (typeof STROKE_SIDES)[number];

/**
 * One layer, narrowed to a single side, carrying the patch's ink.
 *
 * `none` / `hidden` is CSS's "no border here", so the side produces no layer at
 * all rather than a zero-width one the reader would still have to explain.
 */
function inkForSide(
  layer: Record<string, unknown>,
  side: StrokeSideName,
  width: number,
  props: Record<string, unknown>
): Record<string, unknown> | undefined {
  const stylePatch = props[`border-${side}-style`];
  const nextStyle = typeof stylePatch === "string" ? stylePatch.trim().toLowerCase() : undefined;
  if (nextStyle === "none" || nextStyle === "hidden") return undefined;
  const next: Record<string, unknown> = { ...layer, width, side };
  delete next.sides;
  const colorPatch = props[`border-${side}-color`];
  if (typeof colorPatch === "string") {
    // Three colour sources on a row: the literal, the paint and the token that
    // repaints it. The patch names a fourth, so the other three go.
    next.color = colorPatch;
    delete next.paint;
    delete next.tokenId;
  }
  if (nextStyle !== undefined) {
    next.style = nextStyle;
    delete next.dashArray;
  }
  return next;
}

/**
 * Apply single-side ink to the layer stack without rebuilding it.
 *
 * The layer that covers the side is split: what remains of its geometry keeps
 * every field it had, and the patched side becomes its own row with the same
 * fields plus the new colour or style. A rebuild from `border-*-color`
 * longhands cannot express those fields, which is why it used to drop them.
 */
function restyleStrokeSides(raw: unknown, props: Record<string, unknown>): unknown[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const patched = STROKE_SIDES.filter(
    (side) => props[`border-${side}-color`] !== undefined || props[`border-${side}-style`] !== undefined
  );
  if (patched.length === 0) return undefined;

  const layers: unknown[] = [];
  let hit = false;
  for (const row of raw) {
    if (!isObj(row)) {
      layers.push(row);
      continue;
    }
    const weights = resolveStrokeWeights(row as never);
    const covered = patched.filter((side) => weights[side] > 0);
    if (covered.length === 0) {
      layers.push(row);
      continue;
    }
    hit = true;
    const remaining: Record<StrokeSideName, number> = {
      top: weights.top,
      right: weights.right,
      bottom: weights.bottom,
      left: weights.left
    };
    for (const side of covered) remaining[side] = 0;
    const restMax = Math.max(remaining.top, remaining.right, remaining.bottom, remaining.left);
    if (restMax > 0) {
      layers.push({ ...row, width: restMax, side: "custom", sides: remaining });
    }
    for (const side of covered) {
      const ink = inkForSide(row, side, weights[side], props);
      if (ink) layers.push(ink);
    }
  }
  return hit ? layers : undefined;
}

const CORNER_RADIUS_LONGHANDS = [
  "border-top-left-radius",
  "border-top-right-radius",
  "border-bottom-right-radius",
  "border-bottom-left-radius"
] as const;

/**
 * Whether a patch value names a token.
 *
 * A `$ref` is not a CSS spelling and not a stored one, so the gate below would
 * let it through unnormalized — and an unnormalized `borderRadius: "$x"` stores
 * the literal string, which the renderer reads as 0. Deep, because a paint
 * entry's colour is a ref one level in.
 */
export function hasTokenRef(value: unknown): boolean {
  if (typeof value === "string") return /^\$[A-Za-z0-9._/-]+$/.test(value.trim());
  if (Array.isArray(value)) return value.some(hasTokenRef);
  if (isObj(value)) return Object.values(value).some(hasTokenRef);
  return false;
}

const hasTokenSyntax = (value: unknown): boolean => hasTokenRef(value) || hasVarCallInValue(value);

const isConcreteSizeValue = (value: unknown): boolean =>
  typeof value === "number" || pxLength(value) !== undefined || hasTokenSyntax(value);

/**
 * The first prop the patch surface cannot consume, or null.
 *
 * A patch runs against the STORED shape, and the writer keeps keys it does not
 * know (`preserveUnknown`), so a misspelt property was written verbatim and
 * reported as `patched widht` — the schema's complaint only arrived on the next
 * `check`, one command after the key was already in the file.
 *
 * "Consume" is the patch surface's question, not the normalizer's: `font-size`
 * and `text-align` are authoring spellings the readers relocate into `style`, so
 * they are not stored fields and must not be refused here. `flatKeyHint` is that
 * answer — it is non-null exactly when a relocation table knows the key — and
 * everything left over is graded through the normalizer's own predicate, so the
 * two commands cannot disagree.
 */
export function unknownAuthoredKey(props: Record<string, unknown>, type: string): string | null {
  for (const key of Object.keys(props)) {
    // Input-only aliases: the normalizer folds these at the door, so a patch that
    // names one is understood even though no vocabulary key matches it.
    if (isPositionAlias(key)) continue;
    if (flatKeyHint(key, type as ElementType)) continue;
    const mapped = PATCH_KEY_FOLD[canonicalKey(key)] ?? key;
    const problem = unknownElementKey(mapped, type as ElementType);
    if (problem) return problem;
  }
  return null;
}

/**
 * The patch surface speaks the same dialect as the file, while the document the
 * op runs on holds stored fields. A CSS key must therefore REPLACE the stored
 * field it names before the two are merged — otherwise the reader sees both and
 * its own precedence rule keeps the old one (`overflow` beside `overflow-x`,
 * `rotate` beside `rotation`, an outer `font-size` beside `style.fontSize`).
 * These cleanups only remove the field the patch itself re-states; everything
 * the patch did not mention is left alone.
 */
export function preparePatch(
  target: DesignElement,
  props: Record<string, unknown>
): { element: Record<string, unknown>; css: boolean; keys: string[] } {
  const out = { ...(target as unknown as Record<string, unknown>) };
  // One key, one meaning: a CSS spelling that survives the merge under its own
  // name is a field the reader never looks at, so the alias is folded here.
  const folded: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props)) {
    folded[PATCH_KEY_FOLD[canonicalKey(key)] ?? key] = value;
  }
  props = folded;
  // What actually reaches the merge. The layer-restyle path consumes its own
  // keys, and an element-level longhand left behind would be read as a CSS
  // border — which also moves the stroke inside the box.
  const carried: Record<string, unknown> = { ...props };
  const propCanon = new Set(Object.keys(props).map(canonicalKey));
  const has = (...names: string[]): boolean => names.some((name) => propCanon.has(canonicalKey(name)));
  // An input-only axis alias REPLACES the axis it names. The stored `x` is the
  // OLD position: leaving it beside the patch's `left` gives the fold two
  // spellings of one axis, which resolves as "left ignored" — so a patch asking
  // to move the layer would report that the move it wrote was discarded.
  for (const key of Object.keys(props)) {
    const axis = positionAxisOf(key);
    if (axis) delete out[axis];
  }
  const css = Object.entries(props).some(([key, value]) => {
    const canon = canonicalKey(key);
    return (
      CSS_PATCH_SPELLINGS.has(canon) ||
      // An axis alias only becomes `x`/`y` inside the normalizer, so a patch that
      // names one has to take the CSS route or it would store a key nobody reads.
      isPositionAlias(key) ||
      hasTokenSyntax(value) ||
      (STRING_LENGTH_AXES.has(canon) && typeof value === "string") ||
      // CSS's one percent property: "50%" is a number the clamp must see, so a
      // string opacity routes through the normalizer like any other spelling.
      (canon === "opacity" && typeof value === "string")
    );
  });

  if (has("overflow", "clip")) {
    // A shorthand REPLACES the axes it states. Leaving a longhand behind would
    // shadow the value the patch just named, and the panel would read `Mixed`
    // for a box the author had just set to one value.
    delete out.overflowX;
    delete out.overflowY;
    delete out["overflow-x"];
    delete out["overflow-y"];
  }
  if (has("visibility", "visible")) delete out.visible;

  if (has("rotate", "rotation")) delete out.rotation;
  if (has("transform")) {
    // A transform LIST replaces every field it can express. `absorbTransform`
    // only fills a field the element does not already state, so a `skewX` left
    // behind here would outrank the new list and a `rotate(10deg)` patch would
    // change nothing at all.
    delete out.rotation;
    delete out.rotateX;
    delete out.rotateY;
    delete out.skewX;
    delete out.skewY;
    delete out.perspective;
    delete out.flipX;
    delete out.flipY;
  }
  if (has("scale")) {
    delete out.flipX;
    delete out.flipY;
  }

  if (has("mix-blend-mode", "blendMode", "blend")) {
    delete out.blendMode;
    delete out.blend;
  }
  if (has("fill-rule", "fillRule")) delete out.fillRule;
  if (has("mask-mode", "maskMode")) delete out.maskMode;
  if (has("mask-invert", "maskInvert")) delete out.maskInvert;

  if (isObj(out.sizing)) {
    const sizing = { ...out.sizing };
    if (has("width")) {
      delete sizing.widthExpr;
      if (!has("sizing") && isConcreteSizeValue(props.width)) delete sizing.width;
    }
    if (has("height")) {
      delete sizing.heightExpr;
      if (!has("sizing") && isConcreteSizeValue(props.height)) delete sizing.height;
    }
    if (has("border-radius", "borderRadius", "radius", "corner-radius", ...CORNER_RADIUS_LONGHANDS)) {
      delete sizing.borderRadiusY;
      delete sizing.borderRadiusExpr;
    }
    for (const [kebab, camel] of SIZING_BOUNDS) {
      if (!has(kebab, camel)) continue;
      delete sizing[camel];
      delete sizing[kebab];
      delete sizing[`${camel}Expr`];
    }
    if (Object.keys(sizing).length > 0) out.sizing = sizing;
    else delete out.sizing;
  }

  if (has("border-radius", "borderRadius", "radius", "corner-radius")) delete out.borderRadius;
  if (has("grid-area")) delete out["grid-area"];

  // A patch that writes a LITERAL into a slot a number token owns is an explicit
  // new value, and the binding is the pointer that would put the token's number
  // back when the element is read — so it goes with the old value. Composite
  // shorthands (`padding`, `borderRadius`) also supersede all prior side/corner
  // pointers so a partial `{ top: "$x", left: 8 }` cannot leave stale sides.
  if (isObj(out.tokenBindings)) {
    let bindings = out.tokenBindings as Record<string, string>;
    for (const [key, value] of Object.entries(props)) {
      const prop = TOKEN_SHORTHAND_BINDINGS[canonicalKey(key)];
      if (prop === undefined) continue;
      if (hasTokenSyntax(value) && prop !== "padding" && prop !== "borderRadius") continue;
      bindings = withoutNumberBinding(bindings, prop) ?? {};
    }
    if (Object.keys(bindings).length > 0) out.tokenBindings = bindings;
    else delete out.tokenBindings;
  }

  if (isObj(out.style)) {
    const style = { ...(out.style as Record<string, unknown>) };
    for (const key of Object.keys(props)) {
      const stored = TEXT_TARGET_BY_CANON.get(canonicalKey(key));
      if (!stored) continue;
      for (const styleKey of Object.keys(style)) {
        if (styleKey === stored || FLAT_TEXT_KEYS[canonicalKey(styleKey)] === stored) delete style[styleKey];
      }
    }
    out.style = style;
  }

  const stylePatch = isObj(props.style) ? props.style : undefined;
  const inkFromStyle =
    isObj(stylePatch) &&
    ["color", "fill", "text-color", "textColor"].some((key) => stylePatch[key] !== undefined);
  const inkFromTop = Object.keys(props).some((key) => TEXT_TARGET_BY_CANON.get(canonicalKey(key)) === "color");
  const bgFromTop = out.type !== "text" && has("background", "background-color");
  if ((inkFromTop || inkFromStyle || bgFromTop) && !has("fills")) delete out.fills;

  if (!has("strokes")) {
    const hasSideShorthand = has("border-top", "border-right", "border-bottom", "border-left");
    const hasSideColorOrStyle = has(...BORDER_SIDE_COLOR_KEYS, ...BORDER_SIDE_STYLE_KEYS);
    // A patch that states nothing but one side's ink is applied to the layers
    // themselves. Rebuilding them from `border-*-color` longhands would keep the
    // three CSS fields and drop everything the dialect stores beside them —
    // align, opacity, cap, join, dash offset, a paint — and would silently turn
    // a per-layer colour token into a literal.
    const inkOnly =
      hasSideColorOrStyle &&
      !hasSideShorthand &&
      !has("border", "border-width", "stroke-width", "border-color", "border-style");
    const restyled = inkOnly ? restyleStrokeSides(out.strokes, props) : undefined;
    if (restyled) {
      out.strokes = restyled;
      // The layers carry the ink now. Leaving the longhands in the patch would
      // write a CSS border spelling onto the element, and `fromCssBorder` reads
      // that presence as "this stroke sits inside the box".
      for (const side of STROKE_SIDES) {
        delete carried[`border-${side}-color`];
        delete carried[`border-${side}-style`];
      }
    } else if (has("border") || hasSideShorthand) {
      delete out.strokes;
    } else if (hasSideColorOrStyle) {
      if (Array.isArray(out.strokes) && out.strokes.length > 0) {
        const seeded: Partial<Record<"top" | "right" | "bottom" | "left", { width: number; color?: string; style: string }>> = {};
        for (const layer of out.strokes) {
          if (!isObj(layer)) continue;
          const w = resolveStrokeWeights(layer as any);
          for (const side of ["top", "right", "bottom", "left"] as const) {
            if (w[side] > 0) {
              seeded[side] = {
                width: w[side],
                color: typeof layer.color === "string" ? layer.color : undefined,
                style: typeof layer.style === "string" ? layer.style : "solid"
              };
            }
          }
        }
        for (const side of ["top", "right", "bottom", "left"] as const) {
          const prev = seeded[side];
          if (!prev) continue;
          if (!has("border-width", "stroke-width", `border-${side}-width`)) {
            out[`border-${side}-width`] = prev.width;
          }
          if (prev.color && !has("border-color", `border-${side}-color`)) {
            out[`border-${side}-color`] = prev.color;
          }
          if (!has("border-style", `border-${side}-style`)) {
            out[`border-${side}-style`] = prev.style;
          }
        }
      }
      delete out.strokes;
    } else if (Array.isArray(out.strokes) && out.strokes.length > 0 && isObj(out.strokes[0])) {
      const rawBorderStyle = props["border-style"] ?? props.borderStyle;
      if (has("border-style") && typeof rawBorderStyle === "string" && rawBorderStyle.trim().toLowerCase() === "none") {
        delete out.strokes;
      } else {
        out.strokes = out.strokes.map((layer, index) => {
          if (!isObj(layer)) return layer;
          const nextLayer = { ...layer };
          if (has("border-color")) {
            // Three colour sources on a row and the patch names a fourth: the
            // literal, the paint, and the token the row follows — which
            // `applyToPaint` re-materialises from `tokenId`, so leaving it made
            // the new colour disappear between the merge and the reader.
            delete nextLayer.color;
            delete nextLayer.paint;
            delete nextLayer.tokenId;
          }
          if (has("border-width", "stroke-width")) {
            delete nextLayer.width;
            delete nextLayer.strokeWidth;
          }
          if (has("border-style")) {
            delete nextLayer.style;
            delete nextLayer.dashArray;
          }
          if (index === 0 && has(...BORDER_SIDE_WIDTH_KEYS)) {
            delete nextLayer.side;
          }
          return nextLayer;
        });
      }
    }
  }

  if (has("box-shadow") && !has("effects") && Array.isArray(out.effects)) {
    out.effects = out.effects.filter(
      (e) => !isObj(e) || (e.type !== "drop-shadow" && e.type !== "inner-shadow")
    );
  }
  if (has("backdrop-filter") && !has("effects") && Array.isArray(out.effects)) {
    out.effects = out.effects.filter((e) => !isObj(e) || e.type !== "backdrop-blur");
  }
  if (has("filter") && !has("adjust")) delete out.adjust;

  return { element: mergeProps(out, carried), css, keys: Object.keys(props) };
}

/**
 * Normalize a subtree the op verbs are about to write (`patch`, `replace`,
 * `insert`).
 *
 * `tokens` is what makes a `$ref` in the patch mean the same thing it means in a
 * file. Passed in rather than derived: a patch carries no document, and the
 * modes matter — a colour token resolved in the wrong theme is a layer that
 * changes colour the moment something re-syncs it.
 */
/** Parent dimensions + content dimensions passed into element normalization for `%` lengths. */
export function parentBoxOf(
  parent: DesignElement | null | undefined,
  parentLayout: AutoLayout | null
): { width: number; height: number; contentWidth: number; contentHeight: number } | undefined {
  if (!parent) return undefined;
  const [pt, pr, pb, pl] = parentLayout ? resolveContentInsets(parent, parentLayout.padding) : [0, 0, 0, 0];
  return {
    width: parent.width,
    height: parent.height,
    contentWidth: Math.max(0, parent.width - pl - pr),
    contentHeight: Math.max(0, parent.height - pt - pb)
  };
}

export function normalizePatchedElement(
  raw: Record<string, unknown>,
  parentLayout: AutoLayout | null,
  vars: Variables,
  options: {
    tokens?: unknown;
    modes?: ShorthandModes;
    onRepair?: (repair: NormalizationRepair) => void;
    parentBox?: { width: number; height: number; contentWidth?: number; contentHeight?: number };
  } = {}
): DesignElement {
  const tokenRepairs: NormalizationRepair[] = [];
  const withTokens =
    options.tokens === undefined
      ? raw
      : applyTokenShorthandsToElement(raw, options.tokens, options.modes ?? {}, "/patch", tokenRepairs, vars);
  const tokenResolver =
    options.tokens === undefined ? undefined : createTokenVarResolver(options.tokens, options.modes ?? {});
  const { value: resolvedValue, unresolved } = resolveValueTokens(withTokens, vars, tokenResolver);
  const resolved = resolvedValue as Record<string, unknown>;
  // A patch has no repair channel of its own; the caller turns these into a
  // failed outcome rather than letting a dropped declaration look applied.
  for (const repair of tokenRepairs) options.onRepair?.(repair);
  for (const hit of unresolved) {
    options.onRepair?.({
      kind: "document",
      path: hit.path || "/patch",
      message: `"${hit.text}": no custom property (define it in "variables" or add a fallback)`
    });
  }
  // Only what was DROPPED is worth failing an op over: an `info` repair is the
  // engine renaming a key it understood, and failing a patch for that would make
  // every ordinary CSS-spelled patch an error. A refused colour is not that — it
  // leaves the layer with no fill at all, so `ok` on that op is the lie the
  // comment above is about.
  const elementRepairs: NormalizationRepair[] = [];
  const normalized = normalizeElement(resolved, "/patch", 0, elementRepairs, "el_", parentLayout, true, undefined, undefined, undefined, options.parentBox);
  for (const repair of elementRepairs) {
    if (repair.severity !== "info") options.onRepair?.(repair);
  }
  return (normalized ?? resolved) as unknown as DesignElement;
}

/** The stored field a patch key writes, for the override vocabulary. */
function overridableKeyOf(key: string): string {
  const canon = canonicalKey(key);
  const text = TEXT_TARGET_BY_CANON.get(canon);
  if (text) return text === "color" ? "fills" : "style";
  if (
    canon === "border-radius" ||
    canon === "radius" ||
    canon === "corner-radius" ||
    (CORNER_RADIUS_LONGHANDS as readonly string[]).includes(canon)
  ) {
    return "borderRadius";
  }
  if (canon === "background" || canon === "background-color") return "fills";
  if (
    canon === "border" ||
    canon === "border-top" ||
    canon === "border-right" ||
    canon === "border-bottom" ||
    canon === "border-left" ||
    canon === "border-color" ||
    canon === "border-width" ||
    canon === "border-style" ||
    canon === "stroke-width" ||
    (BORDER_SIDE_WIDTH_KEYS as readonly string[]).includes(canon) ||
    (BORDER_SIDE_COLOR_KEYS as readonly string[]).includes(canon) ||
    (BORDER_SIDE_STYLE_KEYS as readonly string[]).includes(canon)
  ) {
    return "strokes";
  }
  if (canon === "box-shadow" || canon === "backdrop-filter") return "effects";
  if (canon === "filter") return "adjust";
  if (canon === "href" || canon === "link-url") return "link";
  if (canon === "overflow-x") return "overflowX";
  if (canon === "overflow-y") return "overflowY";
  if (canon === "clip") return "overflow";
  if (canon === "scroll-x" || canon === "scroll-left") return "scrollX";
  if (canon === "scroll-y" || canon === "scroll-top") return "scrollY";
  if (canon === "scroll-behavior") return "scrollBehavior";
  if (canon === "visibility") return "visible";
  if (canon === "mix-blend-mode" || canon === "blend") return "blendMode";
  return key;
}

/**
 * The one op a derived node answers to.
 *
 * An override is keyed on the MASTER's node id, so the write has to land on the
 * instance; `commitInstanceOverrides` builds it from the diff between the clone
 * and what the patch made of it, which is why the merge happens against
 * `sel.node` rather than against anything read out of the tree.
 */
export function patchDerivedClone(
  doc: DesignDocument,
  sel: InstanceSelection,
  props: Record<string, unknown>
): { doc: DesignDocument; outcome: Omit<OpOutcome, "index"> } {
  const id = sel.node.id;
  if (!sel.overridable) {
    return {
      doc,
      outcome: {
        op: "patch",
        ok: false,
        detail: `"${id}" is inside instance "${sel.instanceId}" but nothing in it can hold an override; edit master "${sel.master.id}" instead`,
        id
      }
    };
  }
  const prepared = preparePatch(sel.node, props);
  const keys = prepared.keys.map(overridableKeyOf);
  const blocked = keys.filter((key) => !(OVERRIDABLE_PROPERTIES as readonly string[]).includes(key));
  const masterNodeId = sel.node.__masterNodeId ?? sel.node.id;
  const masterParent =
    masterNodeId === sel.master.id
      ? findParentById(getActivePage(doc).children, sel.instanceId)
      : findParentById(sel.master.children ?? [], masterNodeId) ?? sel.master;
  const parentLayout = masterParent ? (layoutOf(masterParent) ?? null) : null;
  const vars = collectVariables(doc.variables);
  const merged = prepared.css
    ? normalizePatchedElement(prepared.element, parentLayout, vars, {
        tokens: doc.tokens,
        modes: doc,
        parentBox: parentBoxOf(masterParent, parentLayout)
      })
    : (prepared.element as unknown as DesignElement);
  const next = commitInstanceOverrides(doc, [sel], () => merged);
  if (!next) {
    // Silent success here is the failure this file refuses everywhere else: the
    // op says it wrote, the canvas draws the master, and nothing says why.
    const because = blocked.length > 0
      ? `${blocked.join(", ")} ${blocked.length === 1 ? "is" : "are"} not overridable on an instance child`
      : "the patch matched what the clone already resolved to";
    return {
      doc,
      outcome: {
        op: "patch",
        ok: false,
        detail: `nothing written to "${id}": ${because}. Overridable here: ${OVERRIDABLE_PROPERTIES.join(", ")}`,
        id
      }
    };
  }
  const written = keys.filter((key) => !(blocked as string[]).includes(key));
  return {
    doc: next,
    outcome: {
      op: "patch",
      ok: true,
      // The master is named on success too: an instance-local override and an edit
      // to the definition are different outcomes, and only this line says which
      // one happened — `reset-instance` is what takes it back.
      detail: `override on "${id}" of instance "${sel.instanceId}" (master "${sel.master.id}" unchanged): ${written.join(", ") || "no change"}`,
      id
    }
  };
}
