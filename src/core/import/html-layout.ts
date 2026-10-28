import type { AutoLayout, ElementSizing, LayoutCell, SizeMode, TrackSize } from "../dsl/types";
import type { UnmappedSink } from "./html-style";
import { resolveTracks } from "../layout/grid-layout";
import { absolutePx, px } from "./css-values";
import { splitTopLevel } from "./split";

export interface LayoutDecision {
  layout?: AutoLayout;
}

const JUSTIFY: Record<string, NonNullable<AutoLayout["justify"]>> = {
  "flex-start": "start",
  start: "start",
  "flex-end": "end",
  end: "end",
  center: "center",
  "space-between": "space-between",
  "space-around": "space-around",
  "space-evenly": "space-evenly"
};

const ALIGN: Record<string, NonNullable<AutoLayout["align"]>> = {
  "flex-start": "start",
  start: "start",
  "flex-end": "end",
  end: "end",
  center: "center"
};

const ALIGN_CONTENT: Record<string, NonNullable<AutoLayout["alignContent"]>> = {
  "flex-start": "start",
  start: "start",
  "flex-end": "end",
  end: "end",
  center: "center",
  "space-between": "space-between",
  "space-around": "space-around",
  "space-evenly": "space-evenly"
};

const lengthOrZero = (raw: string): number => {
  if (!raw || raw === "normal") return 0;
  return Math.max(0, px(raw) ?? 0);
};

const round2 = (n: number): number => Math.round(n * 100) / 100;

function flexLayout(cs: CSSStyleDeclaration, sink: UnmappedSink): LayoutDecision {
  const rawDirection = cs.flexDirection;
  // `row-reverse` is a real reorder and the DSL has no spelling for it. Physically
  // reversing `children` would reproduce the geometry but not the paint order —
  // CSS keeps painting in DOM order — so the container is left without a layout
  // rather than given a wrong one.
  if (rawDirection.endsWith("-reverse")) {
    sink("flex-direction", rawDirection);
    return {};
  }

  const direction: AutoLayout["direction"] = rawDirection.startsWith("row") ? "row" : "column";
  const layout: AutoLayout = { mode: "flex", direction };

  const rowGap = lengthOrZero(cs.rowGap);
  const columnGap = lengthOrZero(cs.columnGap);
  // The DSL keeps `gap` as the main-axis gap and a per-axis field for the other,
  // so an unequal row/column gap is sayable now — it is a wrap container's
  // between-lines gap beside its between-items gap.
  const mainGap = direction === "row" ? columnGap : rowGap;
  const crossGap = direction === "row" ? rowGap : columnGap;
  if (mainGap > 0) layout.gap = mainGap;
  if (crossGap !== mainGap) {
    if (direction === "row") layout.rowGap = crossGap;
    else layout.columnGap = crossGap;
  }

  // `normal` is the computed spelling of the flex defaults — `flex-start` for
  // justify, `stretch` for align — so it is the default rather than a value the
  // DSL could not express, and reporting it would bury the real gaps.
  const justify = JUSTIFY[cs.justifyContent];
  if (justify) layout.justify = justify;
  else if (cs.justifyContent !== "normal") sink("justify-content", cs.justifyContent);

  // `stretch` is deliberately not written: the DSL spells a stretched child on
  // the CHILD (`sizing: fill`), and the walk applies it per child from what was
  // measured. Writing an `align` here would fight that.
  const align = ALIGN[cs.alignItems];
  if (align) layout.align = align;
  else if (cs.alignItems !== "normal" && cs.alignItems !== "stretch") sink("align-items", cs.alignItems);

  if (cs.flexWrap === "wrap") layout.wrap = "wrap";
  else if (cs.flexWrap !== "nowrap") sink("flex-wrap", cs.flexWrap);

  // `align-content` distributes the LINES of a wrapped stack — the second
  // cross-axis level, distinct from `align-items`. `stretch` (CSS's default) is
  // not written: FISH states its defaults and `start` is the line stack it
  // already draws.
  const alignContent = ALIGN_CONTENT[cs.alignContent];
  if (alignContent) layout.alignContent = alignContent;
  else if (cs.alignContent !== "normal" && cs.alignContent !== "stretch") sink("align-content", cs.alignContent);

  return { layout };
}

const CELL_ALIGN: Record<string, NonNullable<AutoLayout["cellAlign"]>> = {
  normal: "stretch",
  stretch: "stretch",
  start: "start",
  "flex-start": "start",
  center: "center",
  end: "end",
  "flex-end": "end"
};

/**
 * A grid is rebuilt from the AUTHORED track list where there is one, and from the
 * sizes the browser resolved where there is not.
 *
 * Computed `grid-template-columns` is already used px, which is the right answer
 * to "what box is this" and the wrong answer to "what does this grid mean": the
 * `1fr` in `280px 1fr 288px` is gone, and so is the `auto-fit` that decided how
 * many tracks there were. Both are the behaviour the page had when its window
 * changed — the one thing a measured px list can never give back.
 *
 * What a count cannot say, a list can, and what a list cannot say, a share can.
 */
function gridLayout(
  cs: CSSStyleDeclaration,
  sink: UnmappedSink,
  content: { width: number; height: number },
  authored?: (property: string) => string | undefined
): LayoutDecision {
  const used = trackSizes(cs.gridTemplateColumns);
  if (used.length === 0 && !authored) {
    sink("grid-template-columns", cs.gridTemplateColumns);
    return {};
  }
  const declared = parseTrackList(authored?.("grid-template-columns"));
  if (authored?.("grid-template-columns") && !declared) {
    // A track this cannot spell — `auto`, `min-content`, `fit-content()` — is a
    // gap rather than a reason to fall back silently: the fallback would answer
    // a different question and look like it had answered this one.
    sink("grid-template-columns", authored("grid-template-columns") as string);
  }
  if (used.length === 0) {
    sink("grid-template-columns", cs.gridTemplateColumns);
    return {};
  }
  if (lengthOrZero(cs.gridColumnGap) !== lengthOrZero(cs.gridRowGap)) {
    sink("gap", `row ${cs.gridRowGap} / column ${cs.gridColumnGap}`);
  }

  const columnGap = lengthOrZero(cs.columnGap);
  const rowGap = lengthOrZero(cs.rowGap);
  const plan = trackPlan(declared, used, content.width, columnGap);

  const layout: AutoLayout = { mode: "grid", columns: used.length };
  if (plan.autoFit !== undefined) {
    layout.columnsMode = "auto";
    layout.columnWidthMin = plan.autoFit;
  } else if (plan.sizes) {
    layout.columnSizes = plan.sizes;
  }

  // Rows are derived from the children, so a single row — or several of the same
  // height — needs nothing said. Only a row sizing the DSL cannot infer is a gap.
  const declaredRows = parseTrackList(authored?.("grid-template-rows"));
  const usedRows = trackSizes(cs.gridTemplateRows);
  const rowPlan = trackPlan(
    declaredRows?.autoFit ? undefined : declaredRows,
    usedRows,
    content.height,
    rowGap
  );
  if (rowPlan.sizes && !uniformShares(rowPlan.sizes)) layout.rowSizes = rowPlan.sizes;
  if (columnGap > 0) layout.columnGap = columnGap;
  if (rowGap > 0) layout.rowGap = rowGap;
  // `place-items: center` is the common spelling of "centre the icon in its
  // cell", and `cellAlign` is the DSL's name for it. The two CSS axes have one
  // DSL field, so they are only carried across when they agree — a grid that
  // centres on one axis and stretches on the other is reported, not flattened to
  // whichever one happened to be read first.
  const alignItems = CELL_ALIGN[cs.alignItems];
  const justifyItems = CELL_ALIGN[cs.justifyItems];
  if (alignItems && justifyItems) {
    if (alignItems === justifyItems) {
      if (alignItems !== "stretch") layout.cellAlign = alignItems;
    } else {
      sink("place-items", `${cs.alignItems} ${cs.justifyItems}`);
      if (justifyItems !== "stretch") layout.cellAlign = justifyItems;
    }
  } else if (cs.alignItems === "baseline" || cs.justifyItems === "baseline") {
    sink("place-items", `${cs.alignItems} ${cs.justifyItems}`);
  }

  if (cs.gridAutoFlow === "column" || cs.gridAutoFlow === "column dense") layout.placement = "column";
  if (cs.gridAutoFlow.endsWith("dense")) sink("grid-auto-flow", cs.gridAutoFlow);

  /* `justify-content` (and `align-content`) place the whole track block inside
     the container, which is a different statement from anything the dialect's
     `AutoLayout` carries — its own `justify` orders the tracks, and the engine's
     grid pass does not distribute slack. An auto-width grid centred in its
     parent therefore falls back to measured coordinates with nothing said, so
     the two names what was lost. */
  if (!isContentDefault(cs.justifyContent)) sink("justify-content", cs.justifyContent);
  if (!isContentDefault(cs.alignContent)) sink("align-content", cs.alignContent);

  // Implicit row sizing, which is what makes a grid's rows behave the same after
  // a resize. Only ever written for the rows: the columns come from the used
  // track list and rows alone are derived from the children.
  const autoRows = authored?.("grid-auto-rows");
  if (autoRows && autoRows !== "auto") sink("grid-auto-rows", autoRows);

  return { layout };
}

/** The container-level content alignments worth saying nothing about. */
function isContentDefault(value: string): boolean {
  return value === "normal" || value === "stretch" || value === "start" || value === "flex-start" || value === "auto";
}

/** The used px sizes of a computed track list, ignoring anything not a length. */
function trackSizes(raw: string): number[] {
  if (!raw || raw === "none") return [];
  return raw
    .split(/\s+/)
    .map((t) => px(t))
    .filter((n): n is number => n !== undefined);
}

export interface TrackList {
  /** A track per column or row, in the order the author wrote them. */
  tracks?: TrackSize[];
  /** `repeat(auto-fit, …)`: no fixed count, so the width decides it. */
  autoFit?: { min: number };
}

/**
 * A CSS track list, read off the declaration the AUTHOR wrote.
 *
 * `repeat(N, …)` is expanded because it is only a way of writing N tracks;
 * `repeat(auto-fit, …)` is not, because it is the rule that decides N from the
 * width — which `columnsMode: "auto"` already spells. Anything a track cannot
 * carry (`auto`, `min-content`, a `minmax` whose floor is not zero) yields
 * `undefined` rather than a guess, so the caller names it instead of importing
 * a number that happens to fit this one width.
 */
export function parseTrackList(raw: string | undefined): TrackList | undefined {
  if (!raw || raw === "none") return undefined;
  const list: TrackList = {};
  const tracks = expandTracks(splitTopLevel(raw), list);
  if (list.autoFit) return list;
  return tracks && tracks.length > 0 ? { tracks } : undefined;
}

/** Every track saying the same thing, which a COUNT already spells. */
function uniformShares(tracks: TrackSize[]): boolean {
  if (tracks.length === 0) return false;
  const [first] = tracks;
  const same = (t: TrackSize): boolean =>
    typeof first === "number"
      ? typeof t === "number" && Math.abs(t - first) <= 0.5
      : typeof t !== "number" && Math.abs(t.fr - first.fr) <= 0.5;
  return tracks.every(same);
}

/**
 * What to write for one axis: nothing (a count), a track list, or an `auto-fit`
 * minimum — decided by which one REPRODUCES what the browser measured.
 *
 * The ratio is the point of this axis, but CSS's `fr` is `minmax(auto, 1fr)`: a
 * track whose content is bigger than its share GROWS, and the engine has no
 * automatic minimum (§10.1 names `min-height: 0` as the workaround pages write
 * for exactly that). Where it happened, the used px are the only faithful
 * answer — so the measurement wins and the ratio is dropped rather than imported
 * as a number the engine will resolve differently and then downgrade.
 *
 * This is the same bargain the container-level self-check makes, applied to the
 * tracks themselves: dynamic where it can be, exact where it must be.
 */
function trackPlan(
  declared: TrackList | undefined,
  used: number[],
  content: number,
  gap: number
): { sizes?: TrackSize[]; autoFit?: number } {
  if (used.length === 0) return {};
  const measured = (sizes: number[]): boolean =>
    sizes.length === used.length && sizes.every((s, i) => Math.abs(s - used[i]) <= 0.5);
  const even = (count: number): number[] =>
    new Array(count).fill(Math.max(0, (content - Math.max(0, count - 1) * gap) / count));

  if (declared?.autoFit !== undefined) {
    const min = declared.autoFit.min;
    const count = Math.max(1, Math.floor((content + gap) / (min + gap)));
    return count === used.length && measured(even(count)) ? { autoFit: min } : { sizes: used.map(round2) };
  }
  if (!declared?.tracks) {
    return measured(even(used.length)) ? {} : { sizes: used.map(round2) };
  }
  const tracks = declared.tracks;
  if (tracks.length !== used.length) return { sizes: used.map(round2) };
  if (uniformShares(tracks) && measured(even(tracks.length))) return {};
  return measured(resolveTracks(tracks, content, gap)) ? { sizes: tracks } : { sizes: used.map(round2) };
}

function expandTracks(tokens: string[], autoFit?: TrackList): TrackSize[] | undefined {
  const out: TrackSize[] = [];
  for (const token of tokens) {
    const counted = /^repeat\(\s*(\d+)\s*,\s*(.+?)\s*\)$/i.exec(token);
    if (counted) {
      const inner = expandTracks(splitTopLevel(counted[2]), autoFit);
      if (!inner) return undefined;
      for (let i = 0; i < Number(counted[1]); i++) out.push(...inner);
      continue;
    }
    const auto = /^repeat\(\s*auto-(fit|fill)\s*,\s*(.+?)\s*\)$/i.exec(token);
    if (auto) {
      // `auto-fill` keeps the empty tracks it did not need, which is a row of
      // holes; the DSL's auto mode is `auto-fit` and there is no spelling for
      // the difference, so it is named rather than collapsed into fit.
      if (auto[1].toLowerCase() !== "fit") return undefined;
      const min = trackMin(auto[2]);
      if (min === undefined) return undefined;
      if (autoFit) autoFit.autoFit = { min };
      return [];
    }
    const track = trackOf(token);
    if (track === undefined) return undefined;
    out.push(track);
  }
  return out;
}

/** The floor a `minmax()` starts at, which is the number `auto-fit` needs. */
function trackMin(raw: string): number | undefined {
  const minmax = /^minmax\(\s*([^,]+)\s*,/i.exec(raw.trim());
  return lengthOf((minmax ? minmax[1] : raw).trim());
}

function trackOf(token: string): TrackSize | undefined {
  const text = token.trim();
  const weight = /^(-?\d+(?:\.\d+)?)fr$/i.exec(text);
  if (weight) return { fr: Math.max(0, Number(weight[1])) };
  const length = lengthOf(text);
  if (length !== undefined) return length;
  const minmax = /^minmax\(\s*([^,]+)\s*,\s*(.+?)\s*\)$/i.exec(text);
  if (!minmax) return undefined;
  const upper = /^(-?\d+(?:\.\d+)?)fr$/i.exec(minmax[2].trim());
  if (upper) {
    // A floor above zero is a bound the `{ fr }` share cannot carry, and a
    // share that quietly ignores it is worse than a reported gap.
    const floor = lengthOf(minmax[1].trim()) ?? 0;
    return floor > 0 ? undefined : { fr: Math.max(0, Number(upper[1])) };
  }
  return undefined;
}

/**
 * A CSS length the DSL can hold, of which bare `0` is the one that arrives
 * without a unit. A relative unit is not one: a track list is stored as the
 * number of pixels it measured at, so `20rem` read as `20` would be a 320px
 * column silently written as a 20px one. Returning undefined makes the whole
 * list unspellable, which `gridLayout` reports.
 */
function lengthOf(raw: string): number | undefined {
  const value = absolutePx(raw.trim());
  return value === undefined ? undefined : Math.max(0, value);
}

export function layoutFor(
  cs: CSSStyleDeclaration,
  sink: UnmappedSink,
  content: { width: number; height: number },
  authored?: (property: string) => string | undefined
): LayoutDecision {
  const display = cs.display;
  if (display === "flex" || display === "inline-flex") return flexLayout(cs, sink);
  if (display === "grid" || display === "inline-grid") return gridLayout(cs, sink, content, authored);
  // Everything else is a block flow, and block layout has no DSL counterpart:
  // margin collapsing, floats and `position: relative` offsets all move children
  // in ways no `layout` field describes. Those children keep the boxes the
  // browser measured, which is exactly what a layout-less frame does.
  return {};
}

export interface ChildBox {
  width: number;
  height: number;
}

/** The per-child cross-axis override, as the DSL spells it. */
export type AlignSelf = NonNullable<AutoLayout["align"]>;

const ALIGN_SELF: Record<string, AlignSelf> = {
  "flex-start": "start",
  start: "start",
  center: "center",
  "flex-end": "end",
  end: "end",
  stretch: "stretch"
};

export interface ChildLayout {
  sizing?: ElementSizing;
  alignSelf?: AlignSelf;
  grow?: number;
  cell?: LayoutCell;
}

function setAxis(sizing: ElementSizing, axis: "width" | "height", mode: SizeMode): void {
  if (axis === "width") sizing.width = mode;
  else if (mode !== "max-content") sizing.height = mode;
}

/**
 * The layout declarations a child needs from its own computed style, given the
 * parent's layout.
 *
 * `flex-grow` becomes `fill` because that is the same statement — "take the
 * leftover on the main axis" — and a share other than `1` is kept as `flexGrow`.
 * `align-self: stretch` becomes a `fill` on the cross axis. `align-self:
 * start/center/end` becomes `layoutAlignSelf`, which is the DSL's own per-child
 * override; only `baseline`, which has no DSL spelling, is reported.
 */
export function childSizingFor(
  cs: CSSStyleDeclaration,
  layout: AutoLayout,
  container: ChildBox,
  child: ChildBox,
  sink: UnmappedSink
): ChildLayout {
  const sizing: ElementSizing = {};
  const result: ChildLayout = {};
  const isRow = layout.mode === "flex" && layout.direction === "row";
  const mainAxis: "width" | "height" = layout.mode === "grid" ? "width" : isRow ? "width" : "height";
  const crossAxis: "width" | "height" = mainAxis === "width" ? "height" : "width";

  if (layout.mode === "flex") {
    const grow = Number.parseFloat(cs.flexGrow);
    if (Number.isFinite(grow) && grow > 0) {
      setAxis(sizing, mainAxis, "fill");
      // The share itself is worth keeping only when it is not the implicit equal
      // one: `flex: 1` and an absent grow both mean "an equal slice", and writing
      // `1` everywhere would be noise on nearly every flex child.
      if (grow !== 1) result.grow = grow;
    }

    // `flex-basis` is deliberately NOT reported: the box the browser resolved it
    // to is the box the child is stored at, so a non-growing item keeps the right
    // size either way, and `flex: 1` (basis 0, grow 1) is exactly the `fill` the
    // branch above already wrote. Reporting it buried the real gaps under 21
    // entries that all said "handled".
    const shrink = Number.parseFloat(cs.flexShrink);
    if (Number.isFinite(shrink) && shrink !== 1 && shrink !== 0) sink("flex-shrink", cs.flexShrink);
  }

  const alignSelf = cs.alignSelf;
  if (alignSelf && alignSelf !== "auto") {
    const mapped = ALIGN_SELF[alignSelf];
    // `stretch` is a SIZE statement, not a placement one, so it is said once —
    // as `fill` on the cross axis — rather than twice from two directions.
    if (mapped === "stretch") setAxis(sizing, crossAxis, "fill");
    else if (mapped) result.alignSelf = mapped;
    else sink("align-self", alignSelf);
  } else if (cs.alignItems === "stretch" || cs.alignItems === "normal" || layout.mode === "grid") {
    // `align-items: stretch` is the default in CSS (computed as `normal`), so a
    // child that measured the full cross extent of the container was stretched
    // rather than authored that way. Saying `fill` is what keeps the DSL from
    // re-measuring it — a text in a stretch column would otherwise come back at
    // its intrinsic width.
    const measured = crossAxis === "width" ? child.width : child.height;
    const available = crossAxis === "width" ? container.width : container.height;
    if (available > 0 && Math.abs(measured - available) <= 0.5) setAxis(sizing, crossAxis, "fill");
  }

  const order = Number.parseFloat(cs.order);
  if (Number.isFinite(order) && order !== 0) sink("order", cs.order);

  /* Size bounds, which the engine resolves on every size a pass writes (fill,
     stretch, hug). Unlike a track list these come through COMPUTED style with
     their unit intact, and the unit decides whether the number is worth
     keeping: `max-width: 290px` computes to `290px` and carries across, but
     `max-width: 90%` computes to `90%` — still relative, and `sizing.maxWidth`
     has no relative spelling. Reading its digits would freeze a share of
     whatever the parent happened to be at import, so it is named instead.
     `0px` and `none` are the absent spellings and are not written: a bound of
     zero is a bound with nothing to say. */
  for (const [property, raw, key] of [
    ["min-width", cs.minWidth, "minWidth"],
    ["max-width", cs.maxWidth, "maxWidth"],
    ["min-height", cs.minHeight, "minHeight"],
    ["max-height", cs.maxHeight, "maxHeight"]
  ] as const) {
    if (!raw || raw === "none" || raw === "auto") continue;
    const value = absolutePx(raw);
    if (value === undefined) {
      sink(property, raw);
      continue;
    }
    if (value > 0) sizing[key] = round2(value);
  }

  if (layout.mode === "grid") {
    const cell = cellOf(cs, layout, sink);
    if (cell) result.cell = cell;
    /* `justify-self` is the inline-axis twin of `align-self`, and the dialect
       spells only the latter — so a badge pinned to the end of its column arrives
       stretched across it, which is a different box rather than a missing one. */
    const justifySelf = cs.justifySelf;
    if (justifySelf && justifySelf !== "auto" && justifySelf !== "normal" && justifySelf !== "stretch") {
      sink("justify-self", justifySelf);
    }
  }

  if (Object.keys(sizing).length > 0) result.sizing = sizing;
  return result;
}

/** A grid line as a positive 1-based number; a negative line counts from the end. */
/**
 * A negative line counts back from the end, and "the end" is a different number
 * depending on which end it is — which is the whole off-by-one this pair exists
 * to keep out of one formula.
 *
 * An END line counts back from the last LINE, and N tracks have N+1 lines, so
 * `1 / -1` on three columns runs from line 1 to line 4 and spans all three
 * tracks. A START line counts back from the last TRACK: `-1` on its own is the
 * last row, which is where a sticky footer puts itself.
 */
const endLine = (raw: string, count: number): number | undefined => {
  const n = plainLine(raw);
  if (n === undefined) return undefined;
  if (n > 0) return n;
  if (count < 1) return undefined;
  return count + 2 + n;
};

const startLine = (raw: string, count: number): number | undefined => {
  const n = plainLine(raw);
  if (n === undefined) return undefined;
  if (n > 0) return n;
  if (count < 1) return undefined;
  return count + 1 + n;
};

const plainLine = (raw: string): number | undefined => {
  const value = raw.trim();
  if (!/^-?\d+$/.test(value)) return undefined;
  const n = Number(value);
  return n === 0 ? undefined : n;
};

const spanIn = (raw: string): number | undefined => {
  const match = /^span\s+(\d+)$/.exec(raw.trim());
  return match ? Number(match[1]) : undefined;
};

/** A negative LINE, as opposed to a `span N`, which counts from where it stands. */
const isBackwardsLine = (raw: string): boolean => /^-\d+$/.test(raw.trim());

/**
 * One axis of `grid-column` / `grid-row`, as a start line and a span.
 *
 * The two are read off the COMPUTED values, which is what makes "did the author
 * say anything" answerable: Chrome reports `auto` for a child that flow places,
 * `span N` for a span, and 1-based line numbers otherwise. An auto child is left
 * to flow rather than frozen where this snapshot happened to put it — the point
 * of rebuilding a grid rather than storing its coordinates.
 *
 * A negative end line (`grid-column: 1 / -1`, the usual spelling of "the rest of
 * the row") is resolved against the track count, which is the only reason this
 * needs it.
 */
function axisOf(start: string, end: string, count: number): { start?: number; span?: number } | undefined {
  // A negative line counts back from the end, so it means nothing without the
  // track count. A count of zero means the tracks are implicit and nothing here
  // knows how many there are — and resolving `-1` against a stand-in of 1 pins
  // the child to the FIRST row of a three-row grid, which `layoutCell` states
  // explicitly and so nothing downstream corrects. With no count the whole axis
  // is reported instead: a child that flows is the browser-independent answer,
  // and a named gap is the only thing that says the placement was lost.
  if (count < 1 && (isBackwardsLine(start) || isBackwardsLine(end))) return undefined;
  const span = spanIn(start) ?? spanIn(end);
  const from = startLine(start, count);
  const to = endLine(end, count);
  if (from !== undefined) {
    if (to !== undefined && to > from) return { start: from, span: to - from };
    return span !== undefined ? { start: from, span } : { start: from };
  }
  // A span with no start is the common "this field takes two tracks" case.
  if (to !== undefined) return { span: Math.max(1, to - 1) };
  if (span !== undefined) return { span };
  return undefined;
}

const isAuto = (value: string): boolean => {
  const v = value.trim();
  return v === "" || v === "auto";
};

function cellOf(cs: CSSStyleDeclaration, layout: AutoLayout, sink: UnmappedSink): LayoutCell | undefined {
  const columns = layout.columnSizes?.length ?? Math.round(layout.columns ?? 0);
  // The COLUMNS are always knowable: `gridLayout` writes `columns` from the used
  // track list, so a negative `grid-column` line has something to count back
  // from. The ROWS are not — `gridLayout` writes neither `rows` nor `rowSizes`
  // unless the author sized them, because the engine derives them from the
  // children. Zero therefore means "implicit", not "one row", and `axisOf` is
  // what decides what to do about it.
  const rows = Math.max(layout.rowSizes?.length ?? 0, Math.round(layout.rows ?? 0));
  const column = axisOf(cs.gridColumnStart, cs.gridColumnEnd, Math.max(1, columns));
  const row = axisOf(cs.gridRowStart, cs.gridRowEnd, rows);
  // A value that is neither `auto` nor a line nor a span is a placement this
  // cannot say; reported rather than silently folded into "auto".
  if (!isAuto(cs.gridColumnStart) && column === undefined) sink("grid-column", `${cs.gridColumnStart} / ${cs.gridColumnEnd}`);
  if (!isAuto(cs.gridRowStart) && row === undefined) sink("grid-row", `${cs.gridRowStart} / ${cs.gridRowEnd}`);
  if (column === undefined && row === undefined) return undefined;
  return {
    ...(column?.start !== undefined ? { column: column.start } : {}),
    ...(row?.start !== undefined ? { row: row.start } : {}),
    ...(column?.span !== undefined ? { columnSpan: column.span } : {}),
    ...(row?.span !== undefined ? { rowSpan: row.span } : {})
  };
}

/**
 * A child's CSS margin, as the DSL's `layoutMargin`.
 *
 * `auto` has no DSL spelling: in CSS it absorbs free space, which is a
 * distribution rule the dialect puts on the CONTAINER (`justify`) rather than on
 * a child, so a margin with an `auto` side is reported rather than half-read.
 * Everything else carries across exactly, including a negative value — the
 * dialect's margins are signed for the same reason CSS's are.
 */
export function marginOf(
  cs: CSSStyleDeclaration,
  sink: UnmappedSink
): number | [number, number, number, number] | undefined {
  const sides = [cs.marginTop, cs.marginRight, cs.marginBottom, cs.marginLeft];
  if (sides.some((side) => side === "auto")) {
    sink("margin", sides.join(" "));
    return undefined;
  }
  const values = sides.map((side) => px(side) ?? 0);
  if (values.every((v) => v === 0)) return undefined;
  return values.every((v) => v === values[0]) ? values[0] : (values as [number, number, number, number]);
}

/** The container's own padding, widened by its border so children start where CSS puts them. */
export function layoutPadding(
  cs: CSSStyleDeclaration,
  border: { top: number; right: number; bottom: number; left: number }
): number | [number, number, number, number] {
  const values = [
    (px(cs.paddingTop) ?? 0) + border.top,
    (px(cs.paddingRight) ?? 0) + border.right,
    (px(cs.paddingBottom) ?? 0) + border.bottom,
    (px(cs.paddingLeft) ?? 0) + border.left
  ].map((v) => Math.max(0, Math.round(v * 100) / 100));
  if (values.every((v) => v === values[0])) return values[0];
  return values as [number, number, number, number];
}
