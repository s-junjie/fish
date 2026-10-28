/**
 * The `layout` object — its vocabulary (every spelling a `layout` field is
 * written in), its readers, and the shapes its values take.
 *
 * It lives apart from the rest of the element sizing normalizer because the
 * vocabulary is a closed set that the schema and `dsl.md` also read: keeping
 * the spellings, the readers and the published key list in ONE table is what
 * stops a key from being "recognised" by the unknown-key pass while no reader
 * ever looks at it (`row-gap` did exactly that).
 */

import type { AutoLayout, LayoutCell, TrackSize } from "../types";
import { DEFAULT_FLEX_DIRECTION } from "../layout-flat";
import {
  asBoolean,
  asNumber,
  canonicalKey,
  isPlainObject,
  lengthUnit,
  pxLength,
  type NormalizationRepair
} from "./shared";

/**
 * Every spelling an author may write for each canonical `layout` field.
 *
 * `LAYOUT_KEYS` (what the unknown-key pass accepts) is derived from this, and so
 * is every reader — so a spelling cannot be accepted-but-unread, and adding a
 * key in one place cannot leave the other behind.
 */
export const LAYOUT_FIELDS = {
  mode: ["mode", "display"],
  direction: ["direction", "flex-direction", "flexDirection"],
  gap: ["gap", "grid-gap"],
  rowGap: ["rowGap", "row-gap", "grid-row-gap"],
  columnGap: ["columnGap", "column-gap", "grid-column-gap"],
  padding: ["padding"],
  justify: ["justify", "justify-content", "justifyContent"],
  align: ["align", "align-items", "alignItems"],
  alignContent: ["alignContent", "align-content"],
  wrap: ["wrap", "flex-wrap", "flexWrap"],
  columns: ["columns"],
  rows: ["rows"],
  columnSizes: ["columnSizes", "column-sizes"],
  rowSizes: ["rowSizes", "row-sizes"],
  cellAlign: ["cellAlign", "cell-align"],
  placement: ["placement"],
  masonry: ["masonry"],
  columnsMode: ["columnsMode", "columns-mode"],
  columnWidthMin: ["columnWidthMin", "column-width-min"]
} as const satisfies Record<string, readonly string[]>;

type LayoutField = keyof typeof LAYOUT_FIELDS;

/** Known `layout` keys, so an unknown one can be reported instead of vanishing. */
export const LAYOUT_KEYS = new Set<string>(
  Object.values(LAYOUT_FIELDS).flatMap((spellings) => [...spellings])
);

/** The spelling table, so a reader reads the first spelling that is present. */
const readLayout = (raw: Record<string, unknown>, field: LayoutField): unknown => {
  for (const spelling of LAYOUT_FIELDS[field]) {
    if (raw[spelling] !== undefined) return raw[spelling];
  }
  return undefined;
};

/** Fields each mode ignores, expanded to every spelling they accept.
 *
 * Carrying them across a mode switch is what made a control look dead: edit it
 * in grid, switch to stack, and the stale value "comes back" — or vice versa, so
 * the edit you just made seems to do nothing.
 *
 * Derived from `LAYOUT_FIELDS` rather than written out, because the check reads
 * raw keys: a hand-written list of camel names let every kebab spelling skip the
 * gate its camel twin passed, so `layout: { mode: "grid", "justify-content": … }`
 * was dropped with no repair at all. Deriving them makes a spelling unable to
 * be recognised without also being gated. */
const spellingsOf = (...fields: LayoutField[]): string[] =>
  fields.flatMap((field) => [...LAYOUT_FIELDS[field]]);

export const GRID_ONLY_LAYOUT_KEYS = spellingsOf(
  "columns", "rows",
  "columnSizes", "rowSizes",
  "cellAlign", "placement", "masonry", "columnsMode", "columnWidthMin"
);
export const FLEX_ONLY_LAYOUT_KEYS = spellingsOf("direction", "justify", "align", "alignContent", "wrap");

/**
 * Ceiling on `layout.columns` / `layout.rows`. Both size a real array in the
 * layout pass, and both are read straight out of an untrusted file or a model
 * response, so the cap is the only thing between a bad number and a dead tab.
 * Far above any real design; see the `count` helper for the failure it prevents.
 */
export const MAX_GRID_TRACKS = 256;

/**
 * CSS spells the start/end of a flex line `flex-start` / `flex-end`; the DSL
 * stores `start` / `end`. One table because the alias is the same one for
 * `justify-content`, `align-items`, `align-content` and `align-self` — four
 * readers that drifted apart the moment each carried its own copy.
 */
export const CSS_LINE_ALIASES: Record<string, string> = {
  "flex-start": "start",
  "flex-end": "end",
  "self-start": "start",
  "self-end": "end",
  left: "start",
  right: "end"
};

/** Resolve a CSS alignment keyword to its DSL spelling. */
export const cssLineValue = (value: string): string => CSS_LINE_ALIASES[value] ?? value;

/** 1 value = all sides, 2 = vertical/horizontal, 3 = top/horizontal/bottom, 4 = t/r/b/l. */
export function expandPadding(values: number[]): number | [number, number, number, number] {
  if (values.length === 1) return values[0];
  if (values.length === 2) return [values[0], values[1], values[0], values[1]];
  if (values.length === 3) return [values[0], values[1], values[2], values[1]];
  return [values[0], values[1], values[2], values[3]];
}

/**
 * Every CSS spelling of a four-sided length onto the canonical
 * `number | [t,r,b,l]`. A two-value array is the shape a model reaches for when
 * it wants vertical/horizontal spacing, and it used to be dropped in silence —
 * so the frame rendered with no padding at all and nothing said why.
 *
 * `clamp` is the one difference between the two callers: padding is floored at
 * zero because a box smaller than its own content is not a thing, while a
 * negative margin is exactly how CSS pulls a child back over its neighbour. It
 * is a parameter rather than two functions because the two readers differ in
 * that one bound and nothing else — sharing the shapes is what keeps a `%` or an
 * `em` from being swallowed as 0 on one side and reported on the other.
 *
 * `pxLength`, not `asNumber`: `asNumber("5%")` is 5, so percentage and em
 * spacing used to be read as that many PIXELS. They name no box here, so the
 * shape is rejected and the caller reports it rather than guessing a number.
 */
function normalizeSideShape(raw: unknown, clamp: boolean): number | [number, number, number, number] | undefined {
  const side = (v: unknown): number | undefined => {
    const n = pxLength(v);
    if (n === undefined) return undefined;
    return clamp ? Math.max(0, n) : n;
  };

  if (typeof raw === "number") return side(raw);

  if (typeof raw === "string") {
    const parts = raw.trim().split(/[\s,]+/).filter(Boolean);
    if (parts.length === 0 || parts.length > 4) return undefined;
    const nums = parts.map(side);
    if (nums.some((n) => n === undefined)) return undefined;
    return expandPadding(nums as number[]);
  }

  if (Array.isArray(raw)) {
    if (raw.length === 0 || raw.length > 4) return undefined;
    const nums = raw.map(side);
    if (nums.some((n) => n === undefined)) return undefined;
    return expandPadding(nums as number[]);
  }

  if (isPlainObject(raw)) {
    const named = ["top", "right", "bottom", "left", "t", "r", "b", "l"];
    if (!named.some((k) => raw[k] !== undefined)) return undefined;
    // Absent sides default to 0, but a side the author DID write and the reader
    // cannot read (a `%`, an `em`) fails the whole shape, so the caller's
    // "is not a supported shape" repair fires instead of the side being
    // swallowed as 0 — which is what silently zeroed `{ top: "2rem" }`.
    const read = (long: string, short: string): number | undefined => {
      const v = raw[long] !== undefined ? raw[long] : raw[short];
      return v === undefined ? 0 : side(v);
    };
    const corners = [read("top", "t"), read("right", "r"), read("bottom", "b"), read("left", "l")];
    if (corners.some((n) => n === undefined)) return undefined;
    return corners as [number, number, number, number];
  }

  return undefined;
}

export function normalizePaddingShape(raw: unknown): number | [number, number, number, number] | undefined {
  return normalizeSideShape(raw, true);
}

export function normalizeMarginShape(raw: unknown): number | [number, number, number, number] | undefined {
  return normalizeSideShape(raw, false);
}

/**
 * A grid child's track placement — CSS `grid-column` / `grid-row`.
 *
 * Both indices are 1-based, matching the grid line numbers CSS itself uses, so a
 * value read off `grid-column: 2 / 4` is written the same way. A 0 would name no
 * track at all and is dropped rather than silently read as the first one; the
 * cap is the same one the track list carries, because the placement indexes an
 * array built from it.
 */
export function normalizeLayoutCell(raw: unknown): LayoutCell | undefined {
  if (!isPlainObject(raw)) return undefined;
  const index = (v: unknown): number | undefined => {
    const n = Math.floor(asNumber(v) ?? NaN);
    return Number.isFinite(n) && n >= 1 && n <= MAX_GRID_TRACKS ? n : undefined;
  };
  const column = index(raw.column ?? raw.col ?? raw.columnStart);
  const row = index(raw.row ?? raw.rowStart);
  const columnSpan = index(raw.columnSpan ?? raw.colSpan);
  const rowSpan = index(raw.rowSpan);

  const cell: LayoutCell = {};
  if (column !== undefined) cell.column = column;
  if (row !== undefined) cell.row = row;
  if (columnSpan !== undefined) cell.columnSpan = columnSpan;
  if (rowSpan !== undefined) cell.rowSpan = rowSpan;
  return Object.keys(cell).length > 0 ? cell : undefined;
}

/** One half of a CSS line range: a 1-based line number, or `span N` for a count. */
function gridLine(raw: string): { line?: number; span?: number } | undefined {
  const text = raw.trim().toLowerCase();
  if (!text || text === "auto") return undefined;
  const span = /^span\s+(\d+)$/.exec(text);
  if (span) {
    const n = Number(span[1]);
    return n >= 1 && n <= MAX_GRID_TRACKS ? { span: n } : undefined;
  }
  if (/^\d+$/.test(text)) {
    const n = Number(text);
    return n >= 1 && n <= MAX_GRID_TRACKS ? { line: n } : undefined;
  }
  return undefined;
}

/**
 * A CSS line range — `"2"`, `"2 / 4"`, `"2 / span 2"`, `"span 2"` — as the
 * start line and the number of tracks it covers.
 *
 * The DSL stores a placement as `{ column, columnSpan }` (a start and a COUNT),
 * because the layout pass indexes an array with it; CSS states a start and an
 * END LINE. The two agree only after `end - start`, which is why this cannot be
 * a rename.
 */
function gridTrackRange(raw: string): { start?: number; span?: number } | undefined {
  const parts = raw.split("/").map((part) => part.trim());
  if (parts.length === 0 || parts.length > 2) return undefined;
  const first = gridLine(parts[0]);
  const second = parts.length > 1 ? gridLine(parts[1]) : undefined;
  if (parts.length > 1 && second === undefined) return undefined;
  if (first === undefined && second === undefined) return undefined;
  const out: { start?: number; span?: number } = {};
  if (first?.line !== undefined) out.start = first.line;
  if (first?.span !== undefined) out.span = first.span;
  if (second?.span !== undefined) out.span = second.span;
  if (second?.line !== undefined && first?.line !== undefined) {
    const span = second.line - first.line;
    if (span >= 1 && span <= MAX_GRID_TRACKS) out.span = span;
  }
  return out;
}

/**
 * The grid placement under every spelling CSS has for it, merged into one cell.
 *
 * `grid-column` / `grid-row` were refused outright — the unknown-key gate had
 * never heard of them — so an author writing the standard property got a child
 * stacked in the first free track and no word about it. `grid-area` is read both
 * as the DSL's object and as CSS's `row-start / column-start / row-end /
 * column-end` shorthand.
 *
 * Later, more specific statements win: the per-axis properties outrank the
 * four-value shorthand, which outranks the object.
 */
export function readGridPlacement(
  el: Record<string, unknown>,
  onRefused?: (key: string, value: unknown) => void
): LayoutCell | undefined {
  const cell: LayoutCell = {};

  const area = el["grid-area"];
  if (isPlainObject(area)) {
    const fromObject = normalizeLayoutCell(area);
    if (fromObject) Object.assign(cell, fromObject);
    else onRefused?.("grid-area", area);
  } else if (typeof area === "string" && area.trim()) {
    const parts = area.split("/").map((part) => part.trim());
    // CSS order is row-start / column-start / row-end / column-end.
    const [rowStart, columnStart, rowEnd, columnEnd] = parts;
    const row = rowStart ? gridTrackRange(rowEnd ? `${rowStart} / ${rowEnd}` : rowStart) : undefined;
    const column = columnStart ? gridTrackRange(columnEnd ? `${columnStart} / ${columnEnd}` : columnStart) : undefined;
    if (row?.start !== undefined) cell.row = row.start;
    if (row?.span !== undefined) cell.rowSpan = row.span;
    if (column?.start !== undefined) cell.column = column.start;
    if (column?.span !== undefined) cell.columnSpan = column.span;
    if (!row && !column) onRefused?.("grid-area", area);
  }

  for (const [key, axis] of [
    ["grid-column", "column"],
    ["grid-row", "row"]
  ] as const) {
    const raw = el[key];
    if (raw === undefined) continue;
    const range = typeof raw === "string" ? gridTrackRange(raw) : undefined;
    if (!range) {
      onRefused?.(key, raw);
      continue;
    }
    if (axis === "column") {
      if (range.start !== undefined) cell.column = range.start;
      else delete cell.column;
      if (range.span !== undefined) cell.columnSpan = range.span;
      else delete cell.columnSpan;
    } else {
      if (range.start !== undefined) cell.row = range.start;
      else delete cell.row;
      if (range.span !== undefined) cell.rowSpan = range.span;
      else delete cell.rowSpan;
    }
  }

  return Object.keys(cell).length > 0 ? cell : undefined;
}

/**
 * The weight in an `fr` track, in either of the two spellings an author uses:
 * the CSS string `"1fr"` and the object `{ fr: 1 }`.
 */
export function frWeightOf(raw: unknown): number | undefined {
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    const match = /^(-?\d+(?:\.\d+)?)fr$/i.exec(trimmed);
    if (match) return Math.max(0, Number(match[1]));
    const minmax = /^minmax\(\s*0(?:px)?\s*,\s*(-?\d+(?:\.\d+)?)fr\s*\)$/i.exec(trimmed);
    if (minmax) return Math.max(0, Number(minmax[1]));
    return undefined;
  }
  if (isPlainObject(raw)) {
    const weight = asNumber(raw.fr);
    return weight === undefined || !Number.isFinite(weight) ? undefined : Math.max(0, weight);
  }
  return undefined;
}

/**
 * One track: a px length, or a share of what the fixed tracks leave behind.
 *
 * A value that is neither is dropped rather than read as 0 — a flexible track
 * read as no pixels at all would collapse the one column the layout was built
 * around, which is a quieter failure than dropping it and saying so.
 */
function trackSizeOf(
  key: string,
  raw: unknown,
  drop: (key: string, message: string) => void
): TrackSize | undefined {
  const weight = frWeightOf(raw);
  if (weight !== undefined) return { fr: weight };
  const px = pxLength(raw);
  if (px === undefined) {
    const unit = lengthUnit(raw);
    drop(
      key,
      `track ${JSON.stringify(raw)} is neither a px length nor an fr share${
        unit ? ` (it carries "${unit}"; percentages and em are not resolved in a track)` : ""
      }; dropped`
    );
    return undefined;
  }
  return Math.max(0, Math.round(px * 100) / 100);
}

/**
 * CSS's two-value `gap` shorthand, `gap: <row> <column>`, as the pair it means.
 * A single value is uniform and the caller keeps it in `gap`; a pair has to
 * become `rowGap` / `columnGap`, because no one number says two.
 */
function gapPairOf(raw: unknown): { row: number; column: number } | undefined {
  let parts: unknown[];
  if (Array.isArray(raw)) parts = raw;
  else if (typeof raw === "string") parts = raw.trim().split(/\s+/).filter(Boolean);
  else return undefined;
  if (parts.length !== 2) return undefined;
  const row = pxLength(parts[0]);
  const column = pxLength(parts[1]);
  if (row === undefined || column === undefined) return undefined;
  return { row: Math.max(0, row), column: Math.max(0, column) };
}

export function normalizeAutoLayout(
  raw: unknown,
  path: string,
  repairs: NormalizationRepair[]
): AutoLayout | undefined {
  if (!isPlainObject(raw)) {
    if (raw !== undefined && raw !== null) {
      repairs.push({
        kind: "layout",
        path: `${path}`,
        message: `layout ${JSON.stringify(raw)} is not an object and was dropped`
      });
    }
    return undefined;
  }
  const drop = (key: string, message: string) => {
    repairs.push({ kind: "layout", path: `${path}/${key}`, message });
  };
  const note = (key: string, message: string) => {
    repairs.push({ kind: "layout", path: `${path}/${key}`, severity: "info", message });
  };
  // A length read for the `layout` fields that take one. `%` and `em` name no
  // box in the stored model — the resolver folds `rem`/`calc` but leaves `%` and
  // `em` — so a value it could not turn into px is dropped and reported rather
  // than read as that many pixels (`asNumber("5%")` is 5). Reading a percentage
  // gap as 5px was invisible: the layout ran, just not the one that was written.
  const length = (key: string, value: unknown): number | undefined => {
    if (value === undefined) return undefined;
    const n = pxLength(value);
    if (n === undefined) {
      const unit = lengthUnit(value);
      drop(
        key,
        `${JSON.stringify(value)} is not a px length${
          unit ? ` (it carries "${unit}"; percentages and em are not resolved against a parent here)` : ""
        }`
      );
      return undefined;
    }
    return n;
  };
  // `display` is the CSS spelling of `mode`. `inline-*` is the same layout with
  // an inline outer box, which the DSL has no notion of; `block` means "no
  // auto-layout".
  const displayRaw = readLayout(raw, "mode");
  const display = typeof displayRaw === "string" ? canonicalKey(displayRaw).replace(/^inline-/, "") : undefined;
  const modeRaw = display === undefined ? "flex" : display;
  if (modeRaw === "none" || modeRaw === "off" || modeRaw === "disabled" || modeRaw === "false" || modeRaw === "block") {
    return undefined;
  }
  // A grid row/column count sizes an array with it (`new Array(rows)` in the
  // layout pass), so an uncapped value in a hand-edited or model-authored file
  // is not a wrong layout — it is an 8 GB allocation that kills the tab with an
  // uncatchable heap OOM, past which no error handler and no try/catch helps.
  const count = (key: string, value: unknown): number | undefined => {
    const n = asNumber(value);
    if (n === undefined) return undefined;
    const rounded = Math.max(1, Math.round(n));
    if (rounded > MAX_GRID_TRACKS) {
      drop(key, `${rounded} exceeds the ${MAX_GRID_TRACKS} track limit; clamped`);
      return MAX_GRID_TRACKS;
    }
    return rounded;
  };
  const direction = canonicalKey(String(readLayout(raw, "direction") ?? DEFAULT_FLEX_DIRECTION));
  const mode = modeRaw === "grid" ? "grid" : "flex";
  if (mode !== modeRaw) {
    drop("mode", `layout.mode "${String(displayRaw)}" is not supported (flex | grid); treated as ${mode}`);
  }
  // Only the fields this mode actually reads survive; the other family is
  // dropped with a note so "my direction did nothing" is answerable.
  const layout: Record<string, unknown> = { mode };
  // CSS's `gap` is a shorthand: one value is uniform, two are `[row, column]`
  // and can only be kept as the per-axis fields. `gap` is read in both modes.
  const gapPair = gapPairOf(readLayout(raw, "gap"));
  if (gapPair) {
    layout.rowGap = gapPair.row;
    layout.columnGap = gapPair.column;
  } else {
    const gap = length("gap", readLayout(raw, "gap"));
    if (gap !== undefined) layout.gap = Math.max(0, gap);
  }
  // Per-axis gaps apply in BOTH modes (CSS `column-gap` / `row-gap`), so they are
  // read before the mode split rather than dropped for a flex parent.
  const columnGap = length("columnGap", readLayout(raw, "columnGap"));
  if (columnGap !== undefined) layout.columnGap = Math.max(0, columnGap);
  const rowGap = length("rowGap", readLayout(raw, "rowGap"));
  if (rowGap !== undefined) layout.rowGap = Math.max(0, rowGap);

  const padding = normalizePaddingShape(readLayout(raw, "padding"));
  if (padding !== undefined) layout.padding = padding;
  else if (readLayout(raw, "padding") !== undefined) {
    drop(
      "padding",
      `${JSON.stringify(readLayout(raw, "padding"))} is not a padding shape (px | "t r b l" | {t,r,b,l})`
    );
  }

  // Every value below is an enum the engine reads, so an out-of-enum value is
  // silently ignored geometry. Reporting it is the only way the author can tell
  // "my align did nothing" from "align is broken".
  const pick = (
    key: string,
    value: unknown,
    allowed: string[],
    canonical: (v: string) => string = (v) => canonicalKey(v)
  ): string | undefined => {
    if (typeof value !== "string") return undefined;
    const c = canonical(value);
    if (allowed.includes(c)) return c;
    drop(key, `${key} "${value}" is not one of ${allowed.join("|")}`);
    return undefined;
  };
  const pickCss = (key: string, value: unknown, allowed: string[]): string | undefined =>
    typeof value === "string" ? pick(key, value, allowed, (v) => cssLineValue(canonicalKey(v))) : undefined;

  if (mode === "flex") {
    // The old ternary mapped everything that was not row/horizontal to column, so
    // `row-reverse` silently flipped the axis AND dropped the reversal. Report
    // both halves by name; the axis keyword is still honoured so the layout is at
    // least the right way round.
    const directionRaw = readLayout(raw, "direction") ?? DEFAULT_FLEX_DIRECTION;
    const dirBase = direction.replace(/-?reverse$/, "");
    const reversed = dirBase !== direction;
    const axis = dirBase === "row" || dirBase === "horizontal" ? "row" : dirBase === "column" || dirBase === "vertical" ? "column" : undefined;
    if (axis === undefined) {
      drop("direction", `direction "${String(directionRaw)}" is not one of row|column; treated as "${DEFAULT_FLEX_DIRECTION}"`);
    } else if (reversed) {
      drop("direction", `direction "${String(directionRaw)}" reversal is not supported; treated as "${axis}"`);
    }
    layout.direction = axis ?? DEFAULT_FLEX_DIRECTION;
    const justify = pickCss("justify", readLayout(raw, "justify"), ["start", "center", "end", "space-between", "space-around", "space-evenly"]);
    if (justify) layout.justify = justify;
    // CSS's `align-items` default is `stretch`; stored when written, defaulted at
    // read time by the layout pass — nothing here invents a value the author
    // did not write, so a document that says nothing stays silent in the file.
    const align = pickCss("align", readLayout(raw, "align"), ["start", "center", "end", "stretch"]);
    if (align) layout.align = align;
    const alignContent = pickCss(
      "alignContent",
      readLayout(raw, "alignContent"),
      ["start", "center", "end", "stretch", "space-between", "space-around", "space-evenly"]
    );
    if (alignContent) layout.alignContent = alignContent;
    const wrapRaw = readLayout(raw, "wrap");
    const wrap = pick("wrap", wrapRaw, ["wrap", "nowrap"]);
    if (wrap) layout.wrap = wrap;
    // `wrap: true` is the CSS/Framer spelling; it means "wrap" here.
    if (wrap === undefined && asBoolean(wrapRaw) === true) {
      layout.wrap = "wrap";
      note("wrap", 'layout.wrap true migrated to layout.wrap "wrap"');
    }
    for (const key of GRID_ONLY_LAYOUT_KEYS) {
      if (raw[key] !== undefined) {
        drop(key, `${key} only applies to grid layouts (mode is "flex")`);
      }
    }
  } else {
    const columns = count("columns", readLayout(raw, "columns"));
    if (columns !== undefined) layout.columns = columns;
    // Explicit tracks are a LIST, and a list has to be bounded the same way a
    // count is: the layout pass sizes an array with it.
    const tracks = (key: string, value: unknown): TrackSize[] | undefined => {
      if (value === undefined) return undefined;
      if (!Array.isArray(value)) {
        drop(key, `${key} must be an array of px lengths or fr shares`);
        return undefined;
      }
      if (value.length > MAX_GRID_TRACKS) {
        drop(key, `${value.length} tracks, past the ${MAX_GRID_TRACKS} track limit; clamped`);
      }
      const out: TrackSize[] = [];
      for (const entry of value.slice(0, MAX_GRID_TRACKS)) {
        const track = trackSizeOf(key, entry, drop);
        if (track !== undefined) out.push(track);
      }
      return out.length > 0 ? out : undefined;
    };
    const columnSizes = tracks("columnSizes", readLayout(raw, "columnSizes"));
    if (columnSizes) layout.columnSizes = columnSizes;
    const rowSizes = tracks("rowSizes", readLayout(raw, "rowSizes"));
    if (rowSizes) layout.rowSizes = rowSizes;
    const rowsRaw = asNumber(readLayout(raw, "rows"));
    const masonry = asBoolean(readLayout(raw, "masonry")) === true;
    if (masonry) {
      layout.masonry = true;
      // A masonry column has no row count: its height is whatever its items
      // stack up to, so honouring `rows` here would be silently impossible. It
      // has no tracks either — the column count comes from `columns`.
      if (rowsRaw !== undefined) {
        drop("rows", "rows has no effect when masonry is on (columns grow to fit)");
      }
      for (const key of ["columnSizes", "rowSizes"] as const) {
        if (layout[key] !== undefined) {
          drop(key, `${key} has no effect when masonry is on (columns are equal and grow to fit)`);
          delete layout[key];
        }
      }
    } else if (rowsRaw !== undefined) {
      layout.rows = count("rows", rowsRaw);
    }
    const cellAlign = pickCss("cellAlign", readLayout(raw, "cellAlign"), ["stretch", "start", "center", "end"]);
    if (cellAlign) layout.cellAlign = cellAlign;
    const placement = pick("placement", readLayout(raw, "placement"), ["row", "column"]);
    if (placement) layout.placement = placement;
    const columnsMode = pick("columnsMode", readLayout(raw, "columnsMode"), ["auto", "fixed"]);
    if (columnsMode) layout.columnsMode = columnsMode;
    const columnWidthMin = length("columnWidthMin", readLayout(raw, "columnWidthMin"));
    if (columnWidthMin !== undefined) layout.columnWidthMin = Math.max(1, columnWidthMin);
    for (const key of FLEX_ONLY_LAYOUT_KEYS) {
      if (raw[key] !== undefined) {
        drop(key, `${key} only applies to Stack layouts (mode is "grid")`);
      }
    }
  }

  for (const key of Object.keys(raw)) {
    if (!LAYOUT_KEYS.has(key)) {
      drop(key, `unknown layout property "${key}" is unsupported`);
    }
  }

  return layout as unknown as AutoLayout;
}
