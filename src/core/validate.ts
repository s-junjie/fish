import type { DesignDocument, DesignElement, ContainerElement, Paint, ComponentElement, TextElement, InstanceElement } from "./dsl/types";
import { adoptTopLevelElements, getActivePage } from "./dsl/types";
import type { CompileDiagnostic } from "./compile";
import { relayoutDocumentTree, resolveDynamicLineHeight, resolvePadding, gridColumnCount, gridRowCount } from "./compile";
import { flattenElements, isContainer } from "./geometry/tree-ops";
import { PAINT_TYPES as PAINT_TYPE_LIST } from "./dsl/schema-enums";
import { layoutOf } from "./dsl/layout-flat";
import { AXIS_DOWNGRADE_MESSAGES, resolveAxisDetail, type SizingAxis } from "./geometry/resolve-axis";
import { hexToRgb, parseColorAlpha } from "./geometry/color-utils";
import { getGradientStops } from "./geometry/gradient-utils";
import { validateTokenRefs } from "./validate-tokens";
import { DEFAULT_FONT_SIZE } from "./dsl/normalize/text-sizing";

const PAINT_TYPES: ReadonlySet<string> = new Set(PAINT_TYPE_LIST);

interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * Conservative extent scan of path data in LOCAL coordinates: tracks every
 * endpoint plus C/S/Q/T control points. Arc bulges beyond their chord are not
 * measured, so this can under-report — acceptable for a warning-level check
 * whose main target is path data authored in the wrong coordinate space.
 */
function pathLocalExtents(d: string): Box | null {
  const tokens = d.match(/[MmLlHhVvCcSsQqTtAaZz]|-?\d*\.?\d+(?:[eE][-+]?\d+)?/g);
  if (!tokens) return null;
  const arity: Record<string, number> = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };
  let cx = 0, cy = 0, sx = 0, sy = 0;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let cmd = "", firstCommand = true;
  const add = (x: number, y: number) => {
    if (!isFinite(x) || !isFinite(y)) return;
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  };
  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i];
    if (/[A-Za-z]/.test(tok)) {
      cmd = tok;
      i++;
      if (cmd === "Z" || cmd === "z") { cx = sx; cy = sy; continue; }
    }
    const n = arity[cmd.toUpperCase()];
    if (!n) { i++; continue; }
    const p: number[] = [];
    for (let k = 0; k < n && i < tokens.length && !/[A-Za-z]/.test(tokens[i]); k++) p.push(parseFloat(tokens[i++]));
    if (p.length < n) break;
    const rel = cmd === cmd.toLowerCase() && cmd !== "z";
    const abs = (v: number, base: number) => (rel ? base + v : v);
    switch (cmd.toUpperCase()) {
      case "M":
        cx = abs(p[0], cx); cy = abs(p[1], cy);
        sx = cx; sy = cy;
        add(cx, cy);
        firstCommand = false;
        if (n > 2) { /* implicit lineto pairs fall through next loop as M repeats */ }
        break;
      case "L":
        cx = abs(p[0], cx); cy = abs(p[1], cy); add(cx, cy);
        break;
      case "H":
        cx = abs(p[0], cx); add(cx, cy);
        break;
      case "V":
        cy = abs(p[0], cy); add(cx, cy);
        break;
      case "C":
        add(abs(p[0], cx), abs(p[1], cy)); add(abs(p[2], cx), abs(p[3], cy));
        cx = abs(p[4], cx); cy = abs(p[5], cy); add(cx, cy);
        break;
      case "S":
        add(abs(p[0], cx), abs(p[1], cy));
        cx = abs(p[2], cx); cy = abs(p[3], cy); add(cx, cy);
        break;
      case "Q":
        add(abs(p[0], cx), abs(p[1], cy));
        cx = abs(p[2], cx); cy = abs(p[3], cy); add(cx, cy);
        break;
      case "T":
        cx = abs(p[0], cx); cy = abs(p[1], cy); add(cx, cy);
        break;
      case "A":
        cx = abs(p[5], cx); cy = abs(p[6], cy); add(cx, cy);
        break;
    }
    if (firstCommand && cmd.toUpperCase() === "M") { /* start recorded */ }
  }
  if (!isFinite(minX)) return null;
  return { minX, minY, maxX, maxY };
}

function checkPaints(paints: Paint[] | undefined, elementId: string, out: CompileDiagnostic[]) {
  for (const paint of paints ?? []) {
    if (!PAINT_TYPES.has(paint.type)) {
      out.push({ level: "warning", message: `Unknown paint type "${paint.type}" renders nothing`, elementId });
    }
  }
}

function estimateTextLines(content: string, fontSize: number, boxWidth: number): number {
  const raw = content.split("\n");
  let lines = 0;
  for (const line of raw) {
    const estWidth = line.length * fontSize * 0.6;
    lines += Math.max(1, Math.ceil(estWidth / Math.max(1, boxWidth)));
  }
  return lines;
}

/**
 * Grid authoring mistakes that render silently. A grid needs a width: it does
 * not grow one from its children unless it is told to hug, and a content box
 * narrower than its gaps leaves cells with no room at all — both paint a frame
 * that looks empty instead of broken.
 */
function checkGridBox(el: DesignElement, out: CompileDiagnostic[]) {
  if (el.type !== "frame" && el.type !== "component") return;
  const layout = layoutOf(el);
  if (!layout || layout.mode !== "grid") return;

  // The declaration, not the resolved mode: `resolveAxis` downgrades a hug it
  // cannot honour, and the point here is to name the authoring mistake.
  const declaresHugWidth =
    el.sizing?.width === "fit-content" || el.sizing?.width === "max-content";
  const declaresFillWidth = el.sizing?.width === "fill";
  if ((layout.columnsMode ?? "fixed") === "auto" && declaresHugWidth) {
    out.push({
      level: "warning",
      message: `Grid "${el.name || el.id}" cannot hug its width with columnsMode "auto" (the column count depends on the width); give an explicit width or use fixed columns`,
      elementId: el.id
    });
  } else if (!(el.width > 0) && !declaresHugWidth && !declaresFillWidth) {
    out.push({
      level: "warning",
      message: `Grid "${el.name || el.id}" has no width and does not hug width, so every cell is 1px; set an explicit width or sizing.width "fit-content"`,
      elementId: el.id
    });
  }

  // A `fill` width has no authored number to inspect. Its real width comes from
  // the parent's layout pass, so width-derived checks (cell room, auto columns,
  // row arithmetic) wait for the laid-out document rather than measuring the
  // stale 0 the document happened to store.
  if (!(el.width > 0)) return;

  const [, pr, , pl] = resolvePadding(layout.padding);
  const contentW = Math.max(0, el.width - pl - pr);
  const columns = gridColumnCount(layout, contentW);
  const colGap = layout.columnGap ?? layout.gap ?? 0;
  const rawCell = (contentW - (columns - 1) * colGap) / columns;
  if (rawCell < 1) {
    out.push({
      level: "warning",
      message: `Grid "${el.name || el.id}" is too narrow for ${columns} columns with gap ${colGap} (padding ${pl}/${pr}); cells have no room and children will overlap`,
      elementId: el.id
    });
  }

  const childCount = (el as ContainerElement).children?.length ?? 0;
  const { rows, used } = gridRowCount(layout, contentW, childCount);
  if (layout.rows !== undefined && rows > used) {
    out.push({
      level: "warning",
      message: `Grid "${el.name || el.id}" declares rows ${rows} but ${childCount} children in ${columns} columns only fill ${used}; the other ${rows - used} row(s) stay empty because rows is a minimum`,
      elementId: el.id
    });
  }

  // `placement: "column"` reads `rows` as the stride, so a large `rows` packs every
  // child into the first column(s) and the declared `columns` go unused — which
  // matches CSS grid but not what "Cols 3 / Rows 4" reads like in the inspector.
  if (layout.placement === "column" && layout.rows !== undefined && childCount > 0) {
    const reachedColumns = Math.min(columns, Math.ceil(childCount / Math.max(1, Math.round(layout.rows))));
    if (reachedColumns < columns) {
      out.push({
        level: "warning",
        message: `Grid "${el.name || el.id}" fills by column with rows ${Math.round(layout.rows)} as the stride, so ${childCount} children only reach ${reachedColumns} of its ${columns} columns; raise the child count or lower rows to fill them`,
        elementId: el.id
      });
    }
  }
}

/**
 * A size declaration the engine cannot honour is resolved to something else at
 * paint time. Without this check the downgrade is invisible: the top-level frame
 * that asked to fill simply paints at 0x0, and `check` says nothing.
 */
function checkAxisDowngrades(el: DesignElement, parent: ContainerElement | null, out: CompileDiagnostic[]) {
  for (const axis of ["width", "height"] as const satisfies readonly SizingAxis[]) {
    if ((axis === "width" ? el.sizing?.width : el.sizing?.height) !== "fill") continue;
    const { downgrade } = resolveAxisDetail(el, parent, axis);
    if (!downgrade) continue;
    out.push({
      level: "warning",
      message: `Element "${el.name || el.id}" declares sizing.${axis} "fill", which ${AXIS_DOWNGRADE_MESSAGES[downgrade]}; give it an explicit size or a parent that can distribute space`,
      elementId: el.id
    });
  }
}

/** A stroke paints through `paint` when it has one, and through `color` otherwise. */
const strokePaintsOf = (el: DesignElement): Paint[] =>
  (el.strokes ?? []).map((stroke) => stroke.paint).filter((paint): paint is Paint => Boolean(paint));

function checkElement(el: DesignElement, parent: ContainerElement | null, out: CompileDiagnostic[], inMaster: boolean) {
  checkPaints(el.fills, el.id, out);
  checkPaints(strokePaintsOf(el), el.id, out);

  if (el.type === "path" && el.width > 0 && el.height > 0) {
    const ext = pathLocalExtents(el.d);
    if (ext) {
      const tol = 0.5;
      if (ext.minX < -tol || ext.minY < -tol || ext.maxX > el.width + tol || ext.maxY > el.height + tol) {
        out.push({
          level: "warning",
          message: `Path data outside local box (${ext.minX.toFixed(1)}..${ext.maxX.toFixed(1)} x ${ext.minY.toFixed(1)}..${ext.maxY.toFixed(1)} in 0..${el.width} x 0..${el.height}); overhang will clip if parent frame clips content`,
          elementId: el.id
        });
      }
    }
  }

  // A text box whose height the engine derives from its content cannot overflow
  // by authoring mistake — the estimate only applies to authored heights. Nor can
  // one that declares a line clamp: being cut is what maxLines was asked for, so
  // reporting it would flag the author's own instruction. Nor one inside a
  // master: the authored box is a template every instance re-derives (its own
  // size through the constraint/layout pass) and whose text it may override, so
  // the estimate grades a box nothing paints at those numbers — an instance that
  // does inherit the clipping shows it on canvas instead.
  if (
    el.type === "text" &&
    !inMaster &&
    (el as TextElement).style?.maxLines === undefined &&
    el.sizing?.height !== "fit-content" &&
    el.sizing?.height !== "fill" &&
    el.width > 0 &&
    el.height > 0
  ) {
    const fontSize = el.style?.fontSize || DEFAULT_FONT_SIZE;
    const lines = estimateTextLines(el.content ?? "", fontSize, el.width);
    const lineH = resolveDynamicLineHeight(fontSize, el.style?.lineHeight);
    if (lines * lineH > el.height + 1) {
      out.push({
        level: "warning",
        message: `Estimated text height ${Math.round(lines * lineH)}px exceeds element height ${el.height}px (wraps or clips); give the text an explicit height, widen the box, or split the text`,
        elementId: el.id
      });
    }
  }

  checkGridBox(el, out);
  checkAxisDowngrades(el, parent, out);

  // A content-driven size on a container with no layout pass to compute it: the
  // element keeps the box it was authored with, and nothing says why.
  if (
    (el.type === "frame" || el.type === "component") &&
    !layoutOf(el) &&
    (el.sizing?.width === "fit-content" ||
      el.sizing?.width === "max-content" ||
      el.sizing?.height === "fit-content")
  ) {
    out.push({
      level: "warning",
      message: `Frame "${el.name || el.id}" declares a content-driven size but has no Auto-Layout (Stack or Grid), so nothing computes it; treated as Fixed`,
      elementId: el.id
    });
  }

  if (el.type === "line" || el.type === "arrow") {
    const seg = el as any;
    const hasDelta = Number.isFinite(seg.dx) && Number.isFinite(seg.dy);
    if (!Number.isFinite(seg.x) || !Number.isFinite(seg.y) || !hasDelta) {
      out.push({
        level: "error",
        message: `Line/arrow "${el.name || el.id}" has invalid non-numeric endpoints (x=${seg.x}, y=${seg.y}, dx=${seg.dx}, dy=${seg.dy})`,
        elementId: el.id
      });
    }
  }
}

/**
 * Relative luminance conforming to WCAG 2.1 (0..1).
 */
function relativeLuminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  const a = [r, g, b].map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return a[0] * 0.2126 + a[1] * 0.7152 + a[2] * 0.0722;
}

/** WCAG contrast ratio: 1:1 to 21:1. */
function contrastRatio(hex1: string, hex2: string): number {
  const l1 = relativeLuminance(hex1);
  const l2 = relativeLuminance(hex2);
  const max = Math.max(l1, l2);
  const min = Math.min(l1, l2);
  return (max + 0.05) / (min + 0.05);
}

function suggestAccessibleColor(inkHex: string, bgHex: string): string {
  const bgL = relativeLuminance(bgHex);
  const isDarkBg = bgL < 0.25;
  const { r, g, b } = hexToRgb(inkHex);
  if (isDarkBg) {
    if (r > g + 40 && r > b + 40) return "#FF453A";
    if (b > r + 30 && b > g + 30) return "#0A84FF";
    if (g > r + 30 && g > b + 30) return "#30D158";
    return "#FFFFFF";
  } else {
    if (r > g + 40 && r > b + 40) return "#D70015";
    if (b > r + 30 && b > g + 30) return "#0040DD";
    if (g > r + 30 && g > b + 30) return "#1E7E34";
    return "#111111";
  }
}

/**
 * The colours a paint stack can put on a pixel, or `undefined` when none of them
 * can say.
 *
 * Gradients answer with EVERY stop, because each stop is a colour a glyph or a
 * backdrop ends up wearing: reading only `from` is how a legible white-to-orange
 * wordmark got measured as black and reported at 1.1:1 against a dark card, and
 * how a card painted light-to-dark got treated as whichever end came first.
 *
 * A layer too faint to cover what is under it does not answer either — that is
 * what keeps a translucent glass panel from being read as the backdrop — and an
 * image or pattern never answers at all: text over a photo can sit on any
 * colour, so a verdict there is a guess dressed as a measurement.
 *
 * Nothing authored at all still has to resolve, which is what `fallback` is
 * for: an omitted text colour is black and an omitted canvas is white, and both
 * are real decisions the engine already makes when it paints.
 */
function paintableColors(paints: Paint[] | undefined, fallback?: string): string[] | undefined {
  if (!paints || paints.length === 0) return fallback ? [fallback] : undefined;
  for (let i = paints.length - 1; i >= 0; i--) {
    const paint = paints[i];
    if (!paint || paint.enabled === false) continue;
    if (paint.type === "image" || paint.type === "pattern") return undefined;
    const opacity = typeof paint.opacity === "number" ? paint.opacity : 1;
    const colors = paint.type === "solid" ? [paint.color] : getGradientStops(paint).map((s) => s.color);
    const painted = colors.filter((c) => (parseColorAlpha(c).alphaPct / 100) * opacity >= 0.5);
    if (painted.length > 0) return painted;
  }
  return undefined;
}

/** What a text sitting straight on the canvas is read against. */
function canvasBackdropColor(background: unknown): string[] | undefined {
  return paintableColors(background ? ([background as Paint] as Paint[]) : [], "#FFFFFF");
}

const rawOf = (el: DesignElement): Record<string, unknown> => el as unknown as Record<string, unknown>;

const EDGE = 0.5;

/**
 * Types whose fill paints their BOX. A text's fills are its glyph ink and a
 * path's fill follows its curve, so neither can answer "what colour is behind
 * this box" — the first version of this scan read a sibling headline's ink as a
 * backdrop and reported the demo's own headings at 1.0:1 against themselves.
 */
const BOX_PAINTERS: ReadonlySet<string> = new Set([
  "frame",
  "component",
  "componentSet",
  "instance",
  "rect",
  "ellipse",
  "polygon",
  "star",
  "video",
  "html"
]);

const numOf = (value: unknown, fallback = 0): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

/** Where an element lands, in its parent's coordinates. */
type PlacedBox = { x: number; y: number; w: number; h: number };

/**
 * Where every element actually lands, keyed by id.
 *
 * The stored `x`/`y` of a child inside an auto-layout container is whatever was
 * written there last — zero for a document authored as JSON, and the previous
 * pass's numbers for one the editor saved. Comparing those to decide "is this
 * sibling behind that text" answers a question about a layout that does not
 * exist, so the scan asks the layout pass instead. It is the same pass
 * `geometryReport` runs, and it costs about a millisecond on a hundred elements.
 */
function layoutBoxes(roots: DesignElement[]): Map<string, PlacedBox> {
  const boxes = new Map<string, PlacedBox>();
  const collect = (els: DesignElement[] | undefined) => {
    for (const el of els ?? []) {
      const any = rawOf(el);
      boxes.set(el.id, { x: numOf(any.x), y: numOf(any.y), w: numOf(any.width), h: numOf(any.height) });
      collect(any.children as DesignElement[] | undefined);
    }
  };
  try {
    collect(relayoutDocumentTree(roots));
  } catch {
    // A document malformed enough to break the layout pass still has to be
    // reported, not to crash the reporter: fall back to what it stores.
    collect(roots);
  }
  return boxes;
}

const boxOf = (el: DesignElement, boxes: Map<string, PlacedBox>): PlacedBox => {
  const placed = boxes.get(el.id);
  if (placed) return placed;
  const any = rawOf(el);
  return { x: numOf(any.x), y: numOf(any.y), w: numOf(any.width), h: numOf(any.height) };
};

/** Does `outer`'s box contain `inner`'s? Both sit in the same parent's coordinates. */
function coversBox(outer: DesignElement, inner: DesignElement, boxes: Map<string, PlacedBox>): boolean {
  const o = boxOf(outer, boxes);
  const i = boxOf(inner, boxes);
  if (o.w <= EDGE || o.h <= EDGE) return false;
  return (
    o.x <= i.x + EDGE &&
    o.y <= i.y + EDGE &&
    o.x + o.w >= i.x + i.w - EDGE &&
    o.y + o.h >= i.y + i.h - EDGE
  );
}

/**
 * What a child is painted on, given the siblings painted before it.
 *
 * The fill of the container was the only backdrop this check could see, so a
 * white label over a photograph — the photograph being a sibling rect rather
 * than the card's own fill — was measured against the canvas white and reported
 * at 1.0:1, with a recommendation to make the text near-black. The picture was
 * fine; the backdrop was wrong.
 *
 * Scanning backwards from the child finds the topmost sibling whose box contains
 * it. A sibling that paints nothing is transparent and the scan continues past
 * it; one this check can reduce to colours answers; one it cannot (an image, a
 * gradient too faint to cover, anything translucent or blended) answers "unknown"
 * and stops the check, because a verdict there would be a guess.
 *
 * Partial overlap is deliberately not enough: a badge that clips a corner of the
 * text box says nothing about the colour behind the glyphs.
 */
function backdropOver(
  siblings: DesignElement[],
  index: number,
  target: DesignElement,
  inherited: string[] | null,
  boxes: Map<string, PlacedBox>
): string[] | null {
  for (let i = index - 1; i >= 0; i--) {
    const sibling = siblings[i];
    const any = rawOf(sibling);
    if (any.visible === false) continue;
    if (!BOX_PAINTERS.has(String(any.type ?? ""))) continue;
    if (!coversBox(sibling, target, boxes)) continue;
    const fills = (Array.isArray(any.fills) ? (any.fills as Paint[]) : []).filter((p) => p && p.enabled !== false);
    // A wrapper that paints nothing of its own is not the backdrop; whatever it
    // contains is, and this walk resolves that when it descends into the wrapper.
    if (fills.length === 0) continue;
    if (typeof any.opacity === "number" && any.opacity < 0.5) return null;
    if (typeof any.blendMode === "string" && any.blendMode !== "normal") return null;
    if (any.adjust || any.filter) return null;
    const effects = Array.isArray(any.effects) ? (any.effects as { type?: string; enabled?: boolean }[]) : [];
    if (effects.some((e) => e?.enabled !== false && (e.type === "layer-blur" || e.type === "backdrop-blur"))) return null;
    return paintableColors(fills) ?? null;
  }
  return inherited;
}

/**
 * Checks text visibility using standard WCAG 2.1 contrast ratio.
 * High-saturation hues (like pure red #E00000 or bright blue on dark backgrounds)
 * are properly recognized by human perceptual luminance, and when contrast falls below
 * 3.0:1 (unreadable), actionable alternative color recommendations are supplied to agents.
 */
function checkInvisibleText(el: DesignElement, backdrop: string[] | null, out: CompileDiagnostic[]) {
  if (el.type !== "text" || !backdrop) return;
  const ink = paintableColors(el.fills, el.style?.color ?? "#000000");
  if (!ink) return;
  // Every colour the glyphs wear against every colour underneath them: one
  // unreadable pairing is one part of the word that cannot be read, so the
  // reported ratio is the worst there is.
  let worst: { ink: string; surface: string; ratio: number } | null = null;
  for (const rawInk of ink) {
    const { hex6, alphaPct } = parseColorAlpha(rawInk);
    // A fully transparent ink paints nothing at all: it is a decision, and
    // reading it as the `hex6` it happens to carry reported a contrast failure
    // with a colour suggestion for text that is invisible on purpose.
    if (alphaPct === 0) continue;
    for (const rawSurface of backdrop) {
      const surface = parseColorAlpha(rawSurface).hex6;
      const ratio = contrastRatio(hex6, surface);
      if (ratio >= 3.0) continue;
      if (!worst || ratio < worst.ratio) worst = { ink: hex6, surface, ratio };
    }
  }
  if (!worst) return;
  const suggested = suggestAccessibleColor(worst.ink, worst.surface);
  out.push({
    level: "info",
    message: `Text "${el.name || el.id}" contrast ratio is ${worst.ratio.toFixed(1)}:1 against backdrop ${worst.surface.toUpperCase()} (below readable 3:1; will not read). Recommended readable color: ${suggested}.`,
    elementId: el.id
  });
}

function estimateTextSpan(el: TextElement): { width: number; height: number } {
  const fontSize = el.style?.fontSize || DEFAULT_FONT_SIZE;
  const lineH = resolveDynamicLineHeight(fontSize, el.style?.lineHeight);
  const raw = (el.content ?? "").split("\n");
  const boxW = typeof el.width === "number" && el.width > 0 ? el.width : 0;
  let lines = 0;
  let maxLineLen = 0;
  for (const line of raw) {
    if (line.length > maxLineLen) maxLineLen = line.length;
    if (boxW > 0) {
      const estWidth = line.length * fontSize * 0.6;
      lines += Math.max(1, Math.ceil(estWidth / boxW));
    } else {
      lines += 1;
    }
  }
  const width = boxW > 0 ? boxW : Math.max(1, maxLineLen * fontSize * 0.6);
  const height = typeof el.height === "number" && el.height > 0 ? el.height : lines * lineH;
  return { width, height };
}

function checkOverlappingTextChildren(parent: ContainerElement, out: CompileDiagnostic[]) {
  const isAutoLayout = layoutOf(parent)?.mode === "flex" || layoutOf(parent)?.mode === "grid";
  if (isAutoLayout) return;
  const children = parent.children ?? [];
  const textChildren = children.filter((c): c is TextElement => c.type === "text" && c.visible !== false);
  if (textChildren.length < 2) return;

  const boxes = textChildren.map((t) => {
    const span = estimateTextSpan(t);
    const x = typeof t.x === "number" ? t.x : 0;
    const y = typeof t.y === "number" ? t.y : 0;
    return { el: t, x, y, width: span.width, height: span.height };
  });

  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i];
      const b = boxes[j];
      const interX = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
      const interY = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
      const interArea = interX * interY;
      const minArea = Math.min(a.width * a.height, b.width * b.height);
      if (minArea <= 0 || interArea <= 0) continue;
      // One box inside the other is LAYERING, not a collision: a wordmark set
      // over a display glyph is how that composition is built, and the
      // 0.6em-per-character estimate of a 400px glyph swallows every label
      // anywhere near it.
      if (interArea / minArea >= 0.98) continue;
      // A quarter of the smaller box, not 8% of it. The box is estimated from a
      // character count (`estimateTextSpan`), so a threshold below that
      // estimator's own error was reporting the estimator, not the layout.
      if (interArea / minArea <= 0.25) continue;
      out.push({
        level: "warning",
        message: `Text elements "${a.el.name || a.el.id}" and "${b.el.name || b.el.id}" visually overlap in plain frame "${parent.name || parent.id}" (~${Math.round((interArea / minArea) * 100)}% of the smaller box); wrap in an Auto-Layout stack (flex column) or use a single text node with newlines — or ignore this if the layering is deliberate`,
        elementId: b.el.id
      });
    }
  }
}

/**
 * Descend into a run of siblings, asking each what it is painted on.
 *
 * The root of a page is the same question as the inside of a frame: a full-bleed
 * photograph placed under a headline is a sibling at either level.
 */
function walkSiblings(
  siblings: DesignElement[],
  parent: ContainerElement | null,
  out: CompileDiagnostic[],
  backdrop: string[] | null,
  boxes: Map<string, PlacedBox>,
  inMaster = false
) {
  for (let i = 0; i < siblings.length; i++) {
    walk(siblings[i], parent, out, backdropOver(siblings, i, siblings[i], backdrop, boxes), boxes, inMaster);
  }
}

function walk(
  el: DesignElement,
  parent: ContainerElement | null,
  out: CompileDiagnostic[],
  backdrop: string[] | null = null,
  boxes: Map<string, PlacedBox> = new Map(),
  inMaster = false
) {
  if (parent && parent.width > 0 && parent.height > 0 && el.width > 0 && el.height > 0) {
    const isAutoLayout = layoutOf(parent)?.mode === "flex" || layoutOf(parent)?.mode === "grid";
    if (!isAutoLayout) {
      const noOverlap =
        el.x + el.width <= 0.5 ||
        el.x >= parent.width - 0.5 ||
        el.y + el.height <= 0.5 ||
        el.y >= parent.height - 0.5;
      if (noOverlap) {
        out.push({
          level: "info",
          message: `Element "${el.name || el.id}" lies entirely outside its parent frame "${parent.name || parent.id}"`,
          elementId: el.id
        });
      }
    }
  }
  checkElement(el, parent, out, inMaster);
  checkInvisibleText(el, backdrop, out);
  if (isContainer(el)) {
    checkOverlappingTextChildren(el, out);
    const hasFills = (el.fills ?? []).some((f) => f && f.enabled !== false);
    const own = paintableColors(el.fills);
    const hasBackdropBlur = (el.effects ?? []).some(
      (e) => (e?.type === "backdrop-blur" || e?.type === "liquid-glass") && e?.enabled !== false
    );
    // A surface the check cannot reduce to colours — glass, an image fill — hands
    // `null` down, which is "unknown" and stops the check rather than guessing.
    const nextBackdrop = (hasFills && !own) || hasBackdropBlur ? null : (own ?? backdrop);
    // Each child asks what is under IT: an earlier sibling that covers it is a
    // better answer than the container's own fill, and a wrapper with no fill of
    // its own passes the answer down to the text inside it.
    walkSiblings(el.children ?? [], el, out, nextBackdrop, boxes, inMaster || el.type === "component" || el.type === "componentSet");
  }
}


/**
 * The masters a master's own subtree instantiates, at any depth — the edges of
 * the componentId graph. An instance nested inside a plain frame counts the same
 * as one directly under the root: resolution reaches both identically.
 */
function nestedMasterIds(comp: ComponentElement): string[] {
  const out: string[] = [];
  const walk = (els: DesignElement[] | undefined) => {
    for (const el of els ?? []) {
      if (el.type === "instance") {
        const cid = (el as { componentId?: string }).componentId;
        if (cid) out.push(cid);
        // A nested instance's own children belong to ITS master, not to this one,
        // so following them here would report edges the graph does not have.
        continue;
      }
      if (el.type === "frame" || el.type === "component") {
        walk((el as ContainerElement).children);
      }
    }
  };
  walk(comp.children);
  return out;
}

/**
 * True when following nested instances from `startId` can come back to it. The
 * walk carries the current path rather than everything seen, so a diamond (two
 * masters sharing a third) is not mistaken for a loop.
 */
function reachesItself(startId: string, components: Map<string, ComponentElement>): boolean {
  const path = new Set<string>();
  const walk = (id: string): boolean => {
    if (path.has(id)) return true;
    const comp = components.get(id);
    if (!comp) return false;
    path.add(id);
    for (const next of nestedMasterIds(comp)) {
      if (walk(next)) {
        path.delete(id);
        return true;
      }
    }
    path.delete(id);
    return false;
  };
  return walk(startId);
}

/**
 * Pre-compile document validation: catches authoring mistakes that render
 * silently (path data outside its local box, text wrapping past its box,
 * unknown paints, unsupported canvas backgrounds). Pure logic, no DOM.
 */
export function validateDocument(input: DesignDocument): CompileDiagnostic[] {
  // `fish check` and the editor both hand this whatever they hold, and a
  // single-page document may carry its tree at the top level.
  const doc = adoptTopLevelElements(input);
  const out: CompileDiagnostic[] = [];

  // An instance whose master is unreachable paints a dashed empty box, and what
  // to do about it is not discoverable from the canvas. A master can live on ANY
  // page, so this has to be a document-level check rather than part of the walk.
  // The same pass indexes the masters, which the cycle check below needs.
  const componentById = new Map<string, ComponentElement>();
  const nodeById = new Map<string, DesignElement>();
  const instances: DesignElement[] = [];
  const collectRefs = (els: DesignElement[] | undefined) => {
    for (const el of els ?? []) {
      if (!nodeById.has(el.id)) nodeById.set(el.id, el);
      if (el.type === "component") componentById.set(el.id, el);
      if (el.type === "instance") instances.push(el);
      if (isContainer(el)) {
        collectRefs(el.children);
      }
    }
  };
  for (const page of doc.pages && doc.pages.length > 0 ? doc.pages : [{ children: getActivePage(doc).children }]) {
    collectRefs(page.children as DesignElement[] | undefined);
  }
  for (const inst of instances) {
    const componentId = (inst as { componentId?: string }).componentId;
    if (!componentId || componentById.has(componentId)) continue;
    // A master authored as a `frame` is the common slip, and the node really is
    // in the document — only the type gate keeps it out of the index. Reporting
    // it as absent sends the author hunting a missing asset instead of at the
    // one-word difference that is the actual fix.
    const shadow = nodeById.get(componentId);
    out.push({
      level: "error",
      message: shadow
        ? `Instance "${inst.name || inst.id}" points at "${componentId}", which exists but is a ${shadow.type} node — only type:"component" counts as a master, so this instance renders as a dashed empty box. Give that node type:"component" (what make-component does), or repoint the instance`
        : `Instance "${inst.name || inst.id}" points at component "${componentId}", which is not in this document — it renders as an empty placeholder until it is repointed or deleted`,
      elementId: inst.id
    });
  }

  // An instance's box is its own: it is filled from the master at load when
  // omitted, but an explicit 0 is kept. That is the one remaining way to author
  // an instance whose chrome (fill, stroke, radius) has nothing to paint on, so
  // name it here rather than letting the canvas show only the children.
  for (const inst of instances) {
    const instance = inst as InstanceElement;
    const master = componentById.get(instance.componentId);
    if (!master) continue;
    const hugs = (axis: "width" | "height") => {
      const mode = instance.sizing?.[axis] ?? master.sizing?.[axis];
      return mode === "fit-content" || mode === "max-content";
    };
    const collapsed = (["width", "height"] as const).filter(
      (axis) => instance[axis] <= 0 && master[axis] > 0 && !hugs(axis)
    );
    if (collapsed.length === 0) continue;
    out.push({
      level: "warning",
      message: `Instance "${instance.name || instance.id}" has a ${instance.width}×${instance.height} box while master "${master.name || master.id}" is ${master.width}×${master.height}. An omitted width/height inherits the master's box; this explicit 0 is kept. Set the axis you want, or use sizeOverride for a deliberately different size`,
      elementId: instance.id
    });
  }

  // A master that reaches itself through nested instances can never finish
  // resolving, and every write path refuses to build one — but a document also
  // arrives from outside (an agent editing the JSON block, an import), and there
  // the loop is invisible until the canvas stops painting. Resolution now stops
  // at the repeat, so the damage is bounded, but a warning naming the master is
  // the only clue the author gets.
  for (const [id, comp] of componentById) {
    if (!reachesItself(id, componentById)) continue;
    out.push({
      level: "warning",
      message: `Main component "${comp.name || id}" uses itself through nested instances — it paints down to the repeat and stops there, and nothing inside the loop is editable. Break it by pointing the nested instance at a different component.`,
      elementId: id
    });
  }

  /**
   * A child that is not a component is cloned by nothing and resolved by nothing,
   * so it sits inside a definition box and never appears in a single instance —
   * invisible rather than broken.
   */
  for (const page of doc.pages && doc.pages.length > 0 ? doc.pages : []) {
    for (const set of flattenElements(page.children || [])) {
      if (set.type !== "componentSet") continue;
      for (const child of set.children || []) {
        if (child.type === "component") continue;
        out.push({
          level: "warning",
          message: `Component set "${set.name || set.id}" holds "${child.name || child.id}", a ${child.type} node. Only a type:"component" can be a variant — the other nodes sit inside the set and are never cloned into an instance, so they are invisible rather than wrong.`,
          elementId: child.id
        });
      }
    }
  }

  if (doc.pages && doc.pages.length > 0) {
    for (const page of doc.pages) {
      const pageBg = page.canvas?.background;
      if (pageBg && pageBg.type !== "solid") {
        out.push({
          level: "warning",
          message: `canvas.background type "${pageBg.type}" is not supported by the runtime and falls back to a dark solid; use "solid"`,
          elementId: undefined
        });
      }
      const children = page.children ?? [];
      walkSiblings(children, null, out, canvasBackdropColor(page.canvas?.background) ?? null, layoutBoxes(children));
    }
  } else {
    const bg = doc.canvas?.background;
    if (bg && bg.type !== "solid") {
      out.push({
        level: "warning",
        message: `canvas.background type "${bg.type}" is not supported by the runtime and falls back to a dark solid; use "solid"`,
        elementId: undefined
      });
    }
    const children = getActivePage(doc).children ?? [];
    walkSiblings(children, null, out, canvasBackdropColor(doc.canvas?.background) ?? null, layoutBoxes(children));
  }

  // Design-token references are checked separately because they resolve against
  // `doc.tokens[]` and `doc.styles[]` — document-level tables the per-element
  // walk never sees.
  out.push(...validateTokenRefs(doc));
  return out;
}
