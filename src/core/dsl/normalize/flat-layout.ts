/**
 * Reads the FLAT CSS auto-layout keys off an element into the engine's own
 * `AutoLayout` shape, which `normalizeAutoLayout` then validates.
 *
 * Two things make this more than a rename:
 *
 *  - `grid-template-columns` names two DSL fields. A NUMBER is a count
 *    (`columns`), an ARRAY is explicit tracks (`columnSizes`); the same for rows.
 *  - `align-items` means `align` in a flex box and `cellAlign` in a grid, so it
 *    can only be routed once `display` is known.
 *
 * Storage is always flat: the caller flattens the returned `AutoLayout` back onto
 * the element with `flattenLayout`. A `layout` key of any shape is not read.
 */

import type { AutoLayout } from "../types";
import { LAYOUT_FIELD_TO_FLAT, FLAT_LAYOUT_KEYS } from "../layout-flat";
import { MAX_GRID_TRACKS, normalizeAutoLayout } from "./auto-layout";
import { canonicalKey, pxLength, type ElementType, type NormalizationRepair } from "./shared";

/** Which fields own each flat key, once input-only aliases are left out. */
const flatOwners = (): Map<string, string[]> => {
  const owners = new Map<string, string[]>();
  for (const [field, flat] of Object.entries(LAYOUT_FIELD_TO_FLAT)) {
    const list = owners.get(flat);
    if (list) list.push(field);
    else owners.set(flat, [field]);
  }
  return owners;
};

const owners = flatOwners();

/**
 * The flat keys whose destination needs `display` first: `align-items` is
 * `align` in a flex box and `cellAlign` in a grid, and each `grid-template-*`
 * is a count or a track list depending on its value — every key no single field
 * owns, plus `display` itself, which picks the mode the others are read against.
 * Together with `FLAT_TO_FIELD` these cover `FLAT_LAYOUT_KEYS` exactly — that
 * equality is asserted in `tests/layout-vocabulary.test.ts`, because a key stored
 * by `flattenLayout` and read by neither table is written and then ignored.
 */
export const FLAT_ROUTED_KEYS: readonly string[] = [
  "display",
  ...[...owners.entries()].filter(([, fields]) => fields.length !== 1).map(([flat]) => flat)
];

/** Flat CSS key → the `layout` field it names, when the mapping needs no mode. */
export const FLAT_TO_FIELD: ReadonlyArray<readonly [string, string]> = [...owners.entries()]
  .filter(([flat, fields]) => fields.length === 1 && !FLAT_ROUTED_KEYS.includes(flat))
  .map(([flat, [field]]) => [flat, field] as const);

/** Split a CSS track list on whitespace outside parentheses (`repeat(...)`, `minmax(...)`). */
function splitTrackTokens(input: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (depth === 0 && /\s/.test(ch)) {
      if (i > start) parts.push(input.slice(start, i));
      start = i + 1;
    }
  }
  if (start < input.length) parts.push(input.slice(start));
  return parts;
}

/**
 * Parse a flat `grid-template-columns` / `grid-template-rows` value:
 * - number (or integer string `"3"`) → track count (`columns` / `rows`)
 * - array → explicit track list (`columnSizes` / `rowSizes`)
 * - CSS track string (`"1fr 2fr"`, `"280px 1fr"`, `"repeat(3, 1fr)"`,
 *   `"repeat(auto-fit, minmax(240px, 1fr))"`) → expanded track list or auto columns
 * - anything else → forwarded to `columnSizes` / `rowSizes` so `normalizeAutoLayout`
 *   reports the invalid value instead of dropping it silently.
 */
function parseFlatGridTemplate(
  raw: unknown,
  allowAutoColumns: boolean
): { count?: number; sizes?: unknown; autoColumnMin?: number } {
  if (raw === undefined) return {};
  if (typeof raw === "number") return { count: raw };
  if (Array.isArray(raw)) return { sizes: raw };
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed.toLowerCase() === "none") return {};
    if (/^\d+$/.test(trimmed)) return { count: Number(trimmed) };
    if (allowAutoColumns) {
      // `auto-fill` and `auto-fit` differ only in whether trailing EMPTY tracks
      // survive. `columnsMode: "auto"` derives the count from the width rather
      // than the children, which is the `auto-fill` reading, so both spellings
      // land here instead of one being silently dropped.
      const autoColumns = /^repeat\(\s*auto-(?:fit|fill)\s*,\s*minmax\(\s*([^,]+?)\s*,\s*1fr\s*\)\s*\)$/i.exec(trimmed);
      if (autoColumns) {
        const minPx = pxLength(autoColumns[1].trim());
        if (minPx !== undefined && minPx > 0) return { autoColumnMin: minPx };
      }
    }
    const tokens = splitTrackTokens(trimmed);
    if (tokens.length === 0) return { sizes: raw };
    const expanded: string[] = [];
    for (const token of tokens) {
      const rep = /^repeat\(\s*(\d+)\s*,\s*(.+)\s*\)$/i.exec(token);
      if (rep) {
        const n = Math.min(MAX_GRID_TRACKS, Math.max(0, Number(rep[1])));
        const inner = splitTrackTokens(rep[2].trim());
        if (n > 0 && inner.length > 0) {
          for (let i = 0; i < n && expanded.length < MAX_GRID_TRACKS; i++) expanded.push(...inner);
          continue;
        }
      }
      expanded.push(token);
    }
    return { sizes: expanded };
  }
  return { sizes: raw };
}

export function readFlatAutoLayout(
  el: Record<string, unknown>,
  path: string,
  repairs: NormalizationRepair[],
  type?: ElementType
): AutoLayout | undefined {
  // Every key is matched through `canonicalKey`, so `flexDirection` and
  // `flex-direction` both land; `key` keeps the author's spelling for the repair.
  const flat = new Map<string, { key: string; value: unknown }>();
  for (const key of Object.keys(el)) {
    const c = canonicalKey(key);
    // On an ellipse, `gap` is the angular arc gap (0..180°), not a layout gap.
    if (type === "ellipse" && c === "gap") continue;
    if (!flat.has(c)) flat.set(c, { key, value: el[key] });
  }
  const get = (c: string) => flat.get(c)?.value;

  const displayRaw = get("display");
  const isGrid = canonicalKey(String(displayRaw ?? "")).replace(/^inline-/, "") === "grid";

  const raw: Record<string, unknown> = {};
  if (get("display") !== undefined) raw.mode = get("display");
  for (const [src, dst] of FLAT_TO_FIELD) {
    if (get(src) !== undefined) raw[dst] = get(src);
  }
  if (get("align-items") !== undefined) raw[isGrid ? "cellAlign" : "align"] = get("align-items");

  const cols = parseFlatGridTemplate(get("grid-template-columns"), true);
  if (cols.autoColumnMin !== undefined) {
    if (raw.columnsMode === undefined) raw.columnsMode = "auto";
    if (raw.columnWidthMin === undefined) raw.columnWidthMin = cols.autoColumnMin;
  } else if (cols.count !== undefined) {
    raw.columns = cols.count;
  } else if (cols.sizes !== undefined) {
    raw.columnSizes = cols.sizes;
  }

  const rows = parseFlatGridTemplate(get("grid-template-rows"), false);
  if (rows.count !== undefined) raw.rows = rows.count;
  else if (rows.sizes !== undefined) raw.rowSizes = rows.sizes;

  const hasFlat = Object.keys(raw).length > 0;
  if (!hasFlat) return undefined;

  if (displayRaw === undefined) {
    // No `display` => no layout at all. Nothing is invented: each flat key is
    // named back rather than silently creating a flex box.
    for (const key of FLAT_LAYOUT_KEYS) {
      if (key === "display") continue;
      const entry = flat.get(key);
      if (entry) {
        repairs.push({
          kind: "dropped-property",
          path: `${path}/${entry.key}`,
          message: `"${entry.key}" needs a layout; set display "flex" or "grid"`
        });
      }
    }
    return undefined;
  }
  return normalizeAutoLayout(raw, `${path}/layout`, repairs);
}
