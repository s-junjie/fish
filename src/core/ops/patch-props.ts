import type { AutoLayout, DesignDocument, DesignElement } from "../dsl/types";
import { OVERRIDABLE_PROPERTIES, getActivePage } from "../dsl/types";
import { commitInstanceOverrides, type InstanceSelection } from "../interactions/instance-resolve";
import { findParentById } from "../geometry/tree-ops";
import { FLAT_LAYOUT_KEYS, layoutOf } from "../dsl/layout-flat";
import { normalizeElement } from "../dsl/normalize/element";
import { canonicalKey } from "../dsl/normalize/shared";
import { FLAT_TEXT_KEYS } from "../dsl/normalize/css-absorb";
import { CSS_KEY_MAP } from "../dsl/css-spelling";
import { collectVariables, resolveValueTokens, type Variables } from "../dsl/normalize/resolve-values";
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
    "link-url"
  ].map(canonicalKey)
);

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

const CORNER_RADIUS_LONGHANDS = [
  "border-top-left-radius",
  "border-top-right-radius",
  "border-bottom-right-radius",
  "border-bottom-left-radius"
] as const;

/**
 * The patch surface speaks the same dialect as the file, while the document the
 * op runs on holds stored fields. A CSS key must therefore REPLACE the stored
 * field it names before the two are merged — otherwise the reader sees both and
 * its own precedence rule keeps the old one (`overflow` beside `clipContent`,
 * `rotate` beside `rotation`, an outer `font-size` beside `style.fontSize`).
 * These cleanups only remove the field the patch itself re-states; everything
 * the patch did not mention is left alone.
 */
export function preparePatch(
  target: DesignElement,
  props: Record<string, unknown>
): { element: Record<string, unknown>; css: boolean; keys: string[] } {
  const out = { ...(target as unknown as Record<string, unknown>) };
  const propCanon = new Set(Object.keys(props).map(canonicalKey));
  const has = (...names: string[]): boolean => names.some((name) => propCanon.has(canonicalKey(name)));
  const css = Object.entries(props).some(([key, value]) => {
    const canon = canonicalKey(key);
    return CSS_PATCH_SPELLINGS.has(canon) || (STRING_LENGTH_AXES.has(canon) && typeof value === "string");
  });

  if (has("overflow", "clip", "clipContent", "clipsContent")) {
    delete out.clipContent;
    delete out.clipsContent;
    delete out.clip;
  }
  if (has("visibility", "visible")) delete out.visible;

  if (has("rotate", "rotation")) delete out.rotation;
  if (has("transform")) {
    delete out.rotation;
    delete out.rotateX;
    delete out.rotateY;
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
    for (const [kebab, camel] of SIZING_BOUNDS) {
      if (!has(kebab)) continue;
      delete sizing[camel];
      delete sizing[kebab];
    }
    out.sizing = sizing;
  }

  if (has("border-radius", "borderRadius", "radius", "corner-radius")) delete out.borderRadius;
  if (has("grid-area")) delete out["grid-area"];

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
    if (has("border", "border-top", "border-right", "border-bottom", "border-left")) {
      delete out.strokes;
    } else if (Array.isArray(out.strokes) && out.strokes.length > 0 && isObj(out.strokes[0])) {
      const rawBorderStyle = props["border-style"] ?? props.borderStyle;
      if (has("border-style") && typeof rawBorderStyle === "string" && rawBorderStyle.trim().toLowerCase() === "none") {
        delete out.strokes;
      } else {
        const first = { ...(out.strokes[0] as Record<string, unknown>) };
        if (has("border-color")) {
          delete first.color;
          delete first.paint;
        }
        if (has("border-width", "stroke-width")) {
          delete first.width;
          delete first.strokeWidth;
        }
        if (has("border-style")) {
          delete first.style;
          delete first.dashArray;
        }
        if (has(...BORDER_SIDE_WIDTH_KEYS)) {
          delete first.side;
        }
        out.strokes = [first, ...out.strokes.slice(1)];
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

  return { element: mergeProps(out, props), css, keys: Object.keys(props) };
}

export function normalizePatchedElement(
  raw: Record<string, unknown>,
  parentLayout: AutoLayout | null,
  vars: Variables
): DesignElement {
  const resolved = resolveValueTokens(raw, vars).value as Record<string, unknown>;
  const normalized = normalizeElement(resolved, "/patch", 0, [], "el_", parentLayout, true);
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
    (BORDER_SIDE_WIDTH_KEYS as readonly string[]).includes(canon)
  ) {
    return "strokes";
  }
  if (canon === "box-shadow" || canon === "backdrop-filter") return "effects";
  if (canon === "filter") return "adjust";
  if (canon === "href" || canon === "link-url") return "link";
  if (canon === "overflow" || canon === "clip") return "clipContent";
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
    ? normalizePatchedElement(prepared.element, parentLayout, vars)
    : (mergeProps({ ...sel.node } as unknown as Record<string, unknown>, props) as unknown as DesignElement);
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
