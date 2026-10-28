/**
 * The auto-layout vocabulary, FLAT on the element. The stored document carries
 * CSS property names at the element top level — `display`, `flex-direction`,
 * `gap`, `padding`, `grid-template-columns` — instead of a nested `layout`
 * object.
 *
 * The engine keeps its own `AutoLayout` shape: every reader derives it with
 * `layoutOf`, every writer goes back through `withLayout`. That leaves the
 * layout maths untouched — only the storage boundary speaks CSS.
 *
 * Kebab keys are bracket-accessed (`el["flex-direction"]`), the price of storing
 * CSS names. Values are CSS too: the engine's
 * `start` / `end` are stored as `flex-start` / `flex-end` (except on a grid,
 * where `cell-align` is CSS's own `start` / `end`).
 */

import type { AutoLayout, AutoLayoutFields, TrackSize } from "./types";

/**
 * The flat key each `AutoLayout` field is stored as — the one place the stored
 * vocabulary is written down. `FLAT_LAYOUT_KEYS` is derived from it, and so is
 * the author-facing hint in `normalize/css-absorb.ts`.
 *
 * Two pairs share a key: `columns` / `columnSizes` are both
 * `grid-template-columns` (a number is a count, an array is explicit tracks),
 * and `rows` / `rowSizes` likewise.
 */
export const LAYOUT_FIELD_TO_FLAT = {
  mode: "display",
  direction: "flex-direction",
  justify: "justify-content",
  align: "align-items",
  alignContent: "align-content",
  wrap: "flex-wrap",
  gap: "gap",
  rowGap: "row-gap",
  columnGap: "column-gap",
  padding: "padding",
  columns: "grid-template-columns",
  rows: "grid-template-rows",
  columnSizes: "grid-template-columns",
  rowSizes: "grid-template-rows",
  cellAlign: "align-items",
  placement: "grid-auto-flow",
  masonry: "masonry",
  columnsMode: "columns-mode",
  columnWidthMin: "column-width-min"
} as const;

/**
 * Every flat key an auto-layout writes on its element — exactly what
 * `flattenLayout` can emit, because the erase in `withLayout` must cover the
 * write. A key missing here survives "remove auto layout" and comes back the
 * next time the element is given one.
 */
export const FLAT_LAYOUT_KEYS: readonly string[] = [...new Set(Object.values(LAYOUT_FIELD_TO_FLAT))];

export type FlatAutoLayout = AutoLayoutFields;

/** The engine's `start` / `end` are CSS's `flex-start` / `flex-end`. */
export const toCssLine = (v: string): string => (v === "start" ? "flex-start" : v === "end" ? "flex-end" : v);
export const toDslLine = (v: string): string => (v === "flex-start" ? "start" : v === "flex-end" ? "end" : v);

/**
 * What a flex container does when it says nothing about an axis — CSS's own
 * defaults, written once.
 *
 * FISH used to answer `column` and `start`: a `{ display: "flex", gap: 8 }`
 * stacked its children downwards and left them at the top-left, so an author
 * writing CSS got a transposed layout and a cross axis that never stretched.
 * The document dialect is CSS, so the defaults have to be too.
 */
export const DEFAULT_FLEX_DIRECTION = "row";
export const DEFAULT_FLEX_ALIGN = "stretch";

/** `[engine field, flat key]` for the numeric fields, identical in both directions. */
const NUM: ReadonlyArray<readonly [string, string]> = [
  ["gap", "gap"],
  ["rowGap", "row-gap"],
  ["columnGap", "column-gap"]
];

/** The flex fields: `[field, flat key, allowed values?]`. `toCss/DslLine` is idempotent off `start`/`end`. */
const FLEX: ReadonlyArray<readonly [string, string] | readonly [string, string, readonly string[]]> = [
  ["direction", "flex-direction", ["row", "column"]],
  ["justify", "justify-content"],
  ["align", "align-items"],
  ["alignContent", "align-content"],
  ["wrap", "flex-wrap", ["nowrap", "wrap"]]
];

/** The engine's cross-axis override, read from the stored `align-self`. */
export function alignSelfOf(el: object | null | undefined): AutoLayout["align"] | undefined {
  if (!el) return undefined;
  const v = (el as Record<string, unknown>)["align-self"];
  return typeof v === "string" ? (toDslLine(v) as AutoLayout["align"]) : undefined;
}

/** Reconstruct the engine's `AutoLayout` view from the flat stored keys. */
export function layoutOf(element: object | null | undefined): AutoLayout | undefined {
  if (!element) return undefined;
  const el = element as Record<string, unknown>;
  const display = el.display;
  if (display !== "flex" && display !== "grid") return undefined;
  const layout: AutoLayout = { mode: display };
  const out = layout as unknown as Record<string, unknown>;

  for (const [field, key] of NUM) if (typeof el[key] === "number") out[field] = el[key];
  if (el.padding !== undefined) layout.padding = el.padding as AutoLayout["padding"];

  if (display === "grid") {
    const cols = el["grid-template-columns"];
    if (typeof cols === "number") layout.columns = cols;
    else if (Array.isArray(cols)) layout.columnSizes = cols as TrackSize[];
    const rows = el["grid-template-rows"];
    if (typeof rows === "number") layout.rows = rows;
    else if (Array.isArray(rows)) layout.rowSizes = rows as TrackSize[];
    // A grid's `align-items` is its `cellAlign`, and reads exactly as CSS does —
    // `start` / `end`, never `flex-start` / `flex-end`.
    const cellAlign = el["align-items"];
    if (cellAlign === "start" || cellAlign === "center" || cellAlign === "end" || cellAlign === "stretch") {
      layout.cellAlign = cellAlign;
    }
    const flow = el["grid-auto-flow"];
    if (flow === "row" || flow === "column") layout.placement = flow;
    if (el.masonry === true) layout.masonry = true;
    if (el["columns-mode"] === "auto" || el["columns-mode"] === "fixed") layout.columnsMode = el["columns-mode"];
    if (typeof el["column-width-min"] === "number") layout.columnWidthMin = el["column-width-min"] as number;
  } else {
    for (const [field, key, allowed] of FLEX) {
      const v = el[key];
      if (typeof v === "string" && (!allowed || allowed.includes(v))) out[field] = toDslLine(v);
    }
  }
  return layout;
}

/** Flatten an `AutoLayout` into the CSS-named keys the document stores. */
export function flattenLayout(layout: AutoLayout): FlatAutoLayout {
  const out: FlatAutoLayout = { display: layout.mode };
  const src = layout as unknown as Record<string, unknown>;

  for (const [field, key] of NUM) if (typeof src[field] === "number") (out as Record<string, unknown>)[key] = src[field];
  if (layout.padding !== undefined) out.padding = layout.padding;

  if (layout.mode === "grid") {
    if (layout.columnSizes && layout.columnSizes.length > 0) out["grid-template-columns"] = layout.columnSizes;
    else if (typeof layout.columns === "number") out["grid-template-columns"] = layout.columns;
    if (layout.rowSizes && layout.rowSizes.length > 0) out["grid-template-rows"] = layout.rowSizes;
    else if (typeof layout.rows === "number") out["grid-template-rows"] = layout.rows;
    if (layout.cellAlign) out["align-items"] = layout.cellAlign;
    if (layout.placement) out["grid-auto-flow"] = layout.placement;
    if (layout.masonry === true) out.masonry = true;
    if (layout.columnsMode) out["columns-mode"] = layout.columnsMode;
    if (typeof layout.columnWidthMin === "number") out["column-width-min"] = layout.columnWidthMin;
  } else {
    for (const [field, key] of FLEX) {
      const v = src[field];
      if (typeof v === "string") (out as Record<string, unknown>)[key] = toCssLine(v);
    }
  }
  return out;
}

/** Strip every flat layout key, then write `layout` (or nothing) back onto `el`. */
export function withLayout<T extends object>(el: T, layout: AutoLayout | undefined): T {
  const out = { ...el } as Record<string, unknown>;
  for (const key of FLAT_LAYOUT_KEYS) delete out[key];
  if (layout) Object.assign(out, flattenLayout(layout));
  return out as T;
}
