import type { DesignElement } from "./types";

/**
 * The element keys the FILE spells differently from the runtime.
 *
 * Storage keeps the engine's camelCase: it is an implementation detail no author
 * sees, and renaming it would touch every reader, every layout pass and every
 * geometry test for no gain — the only surface an author or a model ever touches
 * is the text in `#design-doc`. So the spelling happens once, here, on the way
 * out, and the reader's existing CSS aliases take it back on the way in.
 *
 * Some of these are not a rename but a re-shape: `rotation` becomes a CSS angle,
 * `flipX` becomes one axis of `scale`, `style` becomes flat `font-*` keys. The
 * target is listed here so `tests/css-spelling.test.ts` can prove every
 * camelCase key in the vocabulary has a decision, and `spellElement` below is
 * what actually writes the value.
 */
export const CSS_KEY_MAP: Readonly<Record<string, string>> = {
  borderRadius: "border-radius",
  blendMode: "mix-blend-mode",
  clipContent: "overflow",
  visible: "visibility",
  fillRule: "fill-rule",
  rotation: "rotate",
  flipX: "scale",
  flipY: "scale",
  rotateX: "transform",
  rotateY: "transform",
  maskMode: "mask-mode",
  maskInvert: "mask-invert",
  minWidth: "min-width",
  maxWidth: "max-width",
  minHeight: "min-height",
  maxHeight: "max-height",
  style: "(flattened)"
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** Lengths CSS requires a unit on, except zero — which CSS writes bare. */
const px = (value: unknown): unknown => {
  if (typeof value !== "number") return value;
  return value === 0 ? "0" : `${value}px`;
};

/** CSS's 1-4 value side shorthand, in top/right/bottom/left order. */
function cssSides(value: unknown): unknown {
  if (!Array.isArray(value) || value.length !== 4 || value.some((n) => typeof n !== "number")) {
    return typeof value === "number" ? px(value) : value;
  }
  const [top, right, bottom, left] = value as number[];
  if (top === right && right === bottom && bottom === left) return px(top);
  if (top === bottom && right === left) return `${px(top)} ${px(right)}`;
  if (right === left) return `${px(top)} ${px(right)} ${px(bottom)}`;
  return `${px(top)} ${px(right)} ${px(bottom)} ${px(left)}`;
}

/** Explicit grid tracks as CSS's track list; a count is already CSS-shaped. */
function cssTracks(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value
    .map((track) => {
      if (typeof track === "number") return px(track);
      if (isObject(track) && typeof track.fr === "number") return `${track.fr}fr`;
      return track;
    })
    .join(" ");
}

/** One axis of a grid placement: `"2 / span 2"`, `"2"`, or `"span 2"`. */
function cssGridAxis(start: unknown, span: unknown): string | undefined {
  if (typeof start !== "number") return typeof span === "number" ? `span ${span}` : undefined;
  return typeof span === "number" ? `${start} / span ${span}` : `${start}`;
}

/** The values whose CSS vocabulary is not the stored one. */
const CSS_VALUES: Readonly<Record<string, (value: unknown) => unknown>> = {
  clipContent: (value) => (value === true ? "hidden" : "visible"),
  visible: (value) => (value === false ? "hidden" : "visible"),
  x: px,
  y: px,
  width: px,
  height: px,
  perspective: px,
  gap: px,
  "row-gap": px,
  "column-gap": px,
  minWidth: px,
  maxWidth: px,
  minHeight: px,
  maxHeight: px,
  "grid-template-columns": cssTracks,
  "grid-template-rows": cssTracks,
  padding: cssSides,
  margin: cssSides
};

/**
 * `style` fields whose CSS property exists and is read back at the top level.
 * The inverse of `css-absorb.FLAT_TEXT_KEYS`, plus `color` — CSS's text ink,
 * which the reader folds into `style.color` and then derives the fill from.
 */
const FLAT_STYLE_KEYS: Readonly<Record<string, string>> = {
  fontFamily: "font-family",
  fontSize: "font-size",
  fontWeight: "font-weight",
  fontStyle: "font-style",
  fontVariantNumeric: "font-variant-numeric",
  lineHeight: "line-height",
  letterSpacing: "letter-spacing",
  align: "text-align",
  verticalAlign: "vertical-align",
  color: "color",
  textDecoration: "text-decoration",
  textTransform: "text-transform",
  maxLines: "line-clamp",
  textOverflow: "text-overflow",
  textShadow: "text-shadow"
};

/** camelCase keys that stay, because CSS has no property that means them. */
const grouped = (keys: string[], why: string): Record<string, string> =>
  Object.fromEntries(keys.map((key) => [key, why]));

/**
 * Enumerated rather than inferred: the gate in `tests/css-spelling.test.ts`
 * requires every camelCase key in `CANONICAL_KEYS` to appear either above or
 * here, so a new field cannot quietly land back in the file as camelCase. Each
 * entry carries why it is exempt, since "no CSS equivalent" is a claim.
 */
export const NO_CSS_EQUIVALENT: Readonly<Record<string, string>> = {
  ...grouped(
    [
      "clipsContent", "layoutGrow", "pathData", "textColor", "linkUrl",
      "focalPoint", "imageCrop", "backgroundColor", "borderColor", "borderWidth",
      "borderStyle", "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth",
      "boxShadow", "objectFit", "cornerRadius", "strokeWidth",
      "strokeSides", "borderSides", "strokeTopWeight", "strokeRightWeight",
      "strokeBottomWeight", "strokeLeftWeight", "strokeSide", "borderSide",
      "flexGrow", "assetId", "posterAssetId", "slide", "themeMode", "numberMode", "boxSizing"
    ],
    "an input spelling: normalize folds it into another field and never writes it back"
  ),
  ...grouped(
    [
      "componentId", "setId", "variantProperties", "variantGroupProperties", "overrides",
      "cornerSmoothing", "onPath", "startAngle", "innerRadius", "isMask", "fillEnabled",
      "alwaysLive", "cachedTitle", "cachedFavicon", "sizeOverride", "instanceScale", "spans", "arrow",
      "arrowhead", "autoplay", "loop", "muted", "controls", "srcdoc"
    ],
    "a design primitive or embed option CSS has no property for"
  ),
  ...grouped(
    ["tokenBindings", "fillStyleId", "strokeStyleId", "effectStyleId", "textStyleId", "link"],
    "engine bookkeeping: a binding, a style link or a prototype action"
  )
};

/** Whether a key may be written to the file as-is despite not being CSS. */
export const isCssExempt = (key: string): boolean => key in NO_CSS_EQUIVALENT || key in CSS_KEY_MAP;

/** A radius is CSS's side shorthand too: `[8, 16, 8, 16]` → `8px 16px`. */
function cssRadius(value: unknown): unknown {
  return cssSides(value);
}

/** The text panel's style object, as the CSS properties it is made of. */
function flattenStyle(style: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const leftovers: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(style)) {
    const cssKey = FLAT_STYLE_KEYS[field];
    if (cssKey === undefined) {
      leftovers[field] = value;
      continue;
    }
    if (value === undefined) continue;
    if (field === "fontSize" || field === "letterSpacing") out[cssKey] = px(value);
    else if (field === "textDecoration" && Array.isArray(value)) out[cssKey] = value.join(" ");
    else out[cssKey] = value;
  }
  // A style field with no CSS name (`tokenBindings`) keeps the object it lives in.
  if (Object.keys(leftovers).length > 0) out.style = leftovers;
  return out;
}

/** One element, spelled for the file. Recurses into `children`. */
function spellElement(el: Record<string, unknown>): Record<string, unknown> {
  const { rotation, flipX, flipY, rotateX, rotateY, borderRadius, style, sizing, "grid-area": gridArea, ...rest } = el;
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(rest)) {
    if (key === "children" && Array.isArray(value)) {
      out.children = value.map(spellChild);
      continue;
    }
    const cssKey = CSS_KEY_MAP[key] ?? key;
    out[cssKey] = CSS_VALUES[key]?.(value) ?? value;
  }

  if (isObject(sizing)) {
    const { minWidth, maxWidth, minHeight, maxHeight, ...sizingRest } = sizing;
    if (minWidth !== undefined) out["min-width"] = px(minWidth);
    if (maxWidth !== undefined) out["max-width"] = px(maxWidth);
    if (minHeight !== undefined) out["min-height"] = px(minHeight);
    if (maxHeight !== undefined) out["max-height"] = px(maxHeight);
    if (Object.keys(sizingRest).length > 0) out.sizing = sizingRest;
  } else if (sizing !== undefined) {
    out.sizing = sizing;
  }

  if (isObject(gridArea)) {
    const column = cssGridAxis(gridArea.column, gridArea.columnSpan);
    const row = cssGridAxis(gridArea.row, gridArea.rowSpan);
    if (column) out["grid-column"] = column;
    if (row) out["grid-row"] = row;
  } else if (gridArea !== undefined) {
    out["grid-area"] = gridArea;
  }

  if (rotation !== undefined) out.rotate = `${rotation}deg`;
  // `flipX: false` is never stored — the reader only keeps a true — so a flip is
  // written by its presence, and a negative axis is the only way CSS says it.
  const sx = flipX === true ? -1 : 1;
  const sy = flipY === true ? -1 : 1;
  if (sx === -1 || sy === -1) out.scale = `${sx} ${sy}`;
  if (rotateX !== undefined || rotateY !== undefined) {
    out.transform = [
      rotateX !== undefined ? `rotateX(${rotateX}deg)` : "",
      rotateY !== undefined ? `rotateY(${rotateY}deg)` : ""
    ]
      .filter(Boolean)
      .join(" ");
  }
  if (borderRadius !== undefined) out["border-radius"] = cssRadius(borderRadius);

  if (isObject(style)) {
    // Only text carries a style object the flat surface reads.
    if (el.type === "text") Object.assign(out, flattenStyle(style));
    else out.style = style;
  }
  return out;
}

const spellChild = (child: unknown): unknown => (isObject(child) ? spellElement(child) : child);

/** A whole document, in the dialect the file speaks. */
export function applyCssSpelling(plain: Record<string, unknown>): Record<string, unknown> {
  const pages = plain.pages;
  if (!Array.isArray(pages)) return plain;
  return {
    ...plain,
    pages: pages.map((page) => {
      if (!isObject(page)) return page;
      const record = page as Record<string, unknown>;
      return Array.isArray(record.children)
        ? { ...record, children: (record.children as DesignElement[]).map(spellChild) }
        : page;
    })
  };
}
