/**
 * Inline `<svg>` → DSL `path` and `text` elements.
 *
 * An icon set is the one part of a page that carries no text and no box the DSL
 * already knows how to draw: without this, every icon in an import lands as an
 * empty rectangle, which is most of what makes a chrome-heavy page look wrong.
 *
 * The conversion is done in the SVG's own VIEWPORT space rather than its user
 * space. `getCTM()` folds in the `viewBox` scale and every ancestor `<g
 * transform>`, so the numbers that come out are already CSS pixels in the same
 * frame as `getBoundingClientRect()` — which means the resulting `path` element's
 * box and its `d` need no further scaling, and the shape sits exactly where the
 * browser drew it.
 *
 * Text is the one conversion that needs a number the DOM will not hand over
 * directly — where the BASELINE sits — so it is derived as `bbox.top + ascent`
 * and the reasoning is at `linesOf`.
 */

import type { DesignElement, LineHeight, Paint, PaintStack, Stroke, TextSpan, TextStyle } from "../dsl/types";
import {
  normalizePathOrigin,
  parsePathData,
  serializePathData,
  type EditablePath,
  type Pt
} from "../geometry/path-data";
import { baselineOffsetOf, fontMetricsOf, measureText, type FontSpec } from "../geometry/text-measure";
import { scaleLetterSpacing } from "../geometry/scale-geometry";
import { resolveDynamicLineHeight } from "../layout/text-sizing";
import { textElement } from "./html-text";
import { parseCssColor, px } from "./css-values";

export interface SvgShape {
  /** The DOM element this came from, for naming and traceability. */
  tag: string;
  /** Document order, so a caller merging shapes and texts interleaves them correctly. */
  order: number;
  /** The shape's box in the host coordinate space, before the caller re-bases it. */
  box: { x: number; y: number; width: number; height: number };
  /** Path data in the element's own box space, `(0,0)` at `box`'s top-left. */
  d: string;
  fillRule?: "nonzero" | "evenodd";
  fills?: PaintStack;
  stroke?: Stroke;
  opacity?: number;
}

/**
 * A `<text>` as the DSL text it becomes.
 *
 * One element per `<text>`, not per line: the DSL's text holds its whole string
 * and wraps it itself, which is also what makes the round trip close — the
 * exporter writes one `<text>` with one `<tspan>` per line, and reading that back
 * has to land on the same single element.
 */
export interface SvgText {
  tag: string;
  /** Document order, matching `SvgShape.order`'s scale. */
  order: number;
  box: { x: number; y: number; width: number; height: number };
  content: string;
  /** Per-run overrides, in `content` order and with the newlines removed. */
  spans?: TextSpan[];
  style: TextStyle;
  fills: PaintStack;
  strokes?: Stroke[];
  opacity?: number;
}

const SHAPE_SELECTOR = "path, rect, circle, ellipse, line, polyline, polygon";

/**
 * Elements whose children are DEFINITIONS rather than drawing.
 *
 * Nothing inside these is painted — a `<clipPath>`'s rectangle is a shape for
 * other shapes to be cut against — and none of them is `display: none`, so the
 * dismissal further down does not catch them: computed display on their children
 * comes back `inline` and `getCTM()` still answers. An icon that clipped
 * anything therefore imported as an extra black rectangle the size of the clip,
 * drawn over everything the author actually drew.
 *
 * Matched on the lower-cased `tagName` rather than with `closest()`, because a
 * selector is case-folded in an HTML document and would have missed `clipPath`
 * and `linearGradient` — the two that carry the camel case.
 */
const DEFINITION_HOSTS = new Set([
  "defs",
  "clippath",
  "mask",
  "symbol",
  "marker",
  "pattern",
  "lineargradient",
  "radialgradient",
  "filter"
]);

function insideDefinitionHost(shape: Element, svg: Element): boolean {
  let current = shape.parentElement;
  while (current) {
    if (DEFINITION_HOSTS.has(current.tagName.toLowerCase())) return true;
    if (current === svg) return false;
    current = current.parentElement;
  }
  return false;
}

/**
 * What this shape's ancestors dim it by.
 *
 * `opacity` does not inherit, so a shape inside `<g opacity="0.4">` computes its
 * own as 1 and the group's is thrown away — a ghosted icon came across solid.
 * CSS composites each group as a unit, so the factors multiply down the chain.
 */
function ancestorOpacity(shape: Element, svg: Element): number {
  let factor = 1;
  let current = shape.parentElement;
  while (current && factor > 0) {
    const own = Number.parseFloat(getComputedStyle(current).opacity);
    if (Number.isFinite(own)) factor *= own;
    if (current === svg) break;
    current = current.parentElement;
  }
  return factor;
}

export function svgShapes(
  svg: SVGSVGElement,
  /** The svg's own box origin, ALREADY un-rotated, in the host's coordinate space. */
  origin: { x: number; y: number },
  report: (property: string, value: string) => void
): SvgShape[] {
  const out: SvgShape[] = [];

  // `<use>`, `<image>` and gradients are reported rather than half-drawn: an
  // icon that renders as some of itself is harder to notice than one that is
  // missing. A definition host's own shapes are NOT reported here — they are
  // skipped below, because they were never part of what the page drew.
  for (const skipped of Array.from(svg.querySelectorAll("use, foreignObject, image"))) {
    if (insideDefinitionHost(skipped, svg)) continue;
    report("svg-element", skipped.tagName.toLowerCase());
  }
  for (const gradient of Array.from(svg.querySelectorAll("linearGradient, radialGradient, pattern"))) {
    report("svg-paint", gradient.tagName.toLowerCase());
  }

  const order = documentOrder(svg);
  for (const node of Array.from(svg.querySelectorAll(SHAPE_SELECTOR))) {
    const shape = node as SVGGraphicsElement;
    if (insideDefinitionHost(shape, svg)) continue;
    const cs = getComputedStyle(shape);
    if (cs.display === "none" || cs.visibility === "hidden") continue;

    const data = shapePathData(shape);
    if (!data) continue;
    const parsed = parsePathData(data);
    if (!parsed) {
      report("svg-shape", `${shape.tagName.toLowerCase()} (unparsable path data)`);
      continue;
    }
    const matrix = typeof shape.getCTM === "function" ? shape.getCTM() : null;
    if (!matrix) {
      report("svg-shape", `${shape.tagName.toLowerCase()} (no transform)`);
      continue;
    }

    // Shifted to the shape's own origin so the DSL `path` element's box and its
    // `d` agree — a `d` whose coordinates start at 300 draws 300px off its box.
    const { normalized, offsetX, offsetY, width, height } = normalizePathOrigin(transformPath(parsed, matrix));
    const d = serializePathData(normalized);
    if (!d) continue;

    const scale = Math.sqrt(Math.abs(matrix.a * matrix.d - matrix.b * matrix.c)) || 1;
    const style = shapeStyle(cs, scale, svg, report, ancestorOpacity(shape, svg));

    out.push({
      tag: shape.tagName.toLowerCase(),
      order: order.get(shape) ?? Number.MAX_SAFE_INTEGER,
      box: {
        x: origin.x + offsetX,
        y: origin.y + offsetY,
        width,
        height
      },
      d,
      ...style
    });
  }
  return out;
}

/** Each node's index within its svg, so two passes can be merged back into paint order. */
function documentOrder(svg: Element): Map<Element, number> {
  const map = new Map<Element, number>();
  Array.from(svg.querySelectorAll("*")).forEach((el, i) => map.set(el, i));
  return map;
}

function transformPath(path: EditablePath, m: DOMMatrix): EditablePath {
  const apply = (p: Pt & { m?: true }): Pt & { m?: true } => {
    const next: Pt & { m?: true } = { x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f };
    if (p.m) next.m = true;
    return next;
  };
  return {
    closed: path.closed,
    anchors: path.anchors.map(apply),
    segments: path.segments.map((s) => {
      if (s.kind === "line") return s;
      if (s.kind === "quad") return { ...s, c: apply(s.c) };
      return { ...s, ca: apply(s.ca), cb: apply(s.cb) };
    })
  };
}

/**
 * The shape as path data in its own user space.
 *
 * `<path>` has it already; the other six are basic shapes the DSL has no element
 * for, and each one's outline is a fixed sequence of commands.
 */
function shapePathData(shape: SVGGraphicsElement): string | null {
  const num = (name: string, fallback = 0): number => {
    const raw = shape.getAttribute(name);
    const n = raw === null ? NaN : parseFloat(raw);
    return Number.isFinite(n) ? n : fallback;
  };
  const tag = shape.tagName.toLowerCase();

  switch (tag) {
    case "path":
      return shape.getAttribute("d");

    case "rect": {
      const x = num("x");
      const y = num("y");
      const w = num("width");
      const h = num("height");
      if (w <= 0 || h <= 0) return null;
      const rx = Math.min(num("rx", num("ry")), w / 2);
      const ry = Math.min(num("ry", num("rx")), h / 2);
      if (rx <= 0 || ry <= 0) return `M${x} ${y}H${x + w}V${y + h}H${x}Z`;
      return (
        `M${x + rx} ${y}` +
        `H${x + w - rx}A${rx} ${ry} 0 0 1 ${x + w} ${y + ry}` +
        `V${y + h - ry}A${rx} ${ry} 0 0 1 ${x + w - rx} ${y + h}` +
        `H${x + rx}A${rx} ${ry} 0 0 1 ${x} ${y + h - ry}` +
        `V${y + ry}A${rx} ${ry} 0 0 1 ${x + rx} ${y}Z`
      );
    }

    case "circle": {
      const cx = num("cx");
      const cy = num("cy");
      const r = num("r");
      if (r <= 0) return null;
      return ellipseData(cx, cy, r, r);
    }

    case "ellipse": {
      const rx = num("rx");
      const ry = num("ry");
      if (rx <= 0 || ry <= 0) return null;
      return ellipseData(num("cx"), num("cy"), rx, ry);
    }

    case "line": {
      const x1 = num("x1");
      const y1 = num("y1");
      const x2 = num("x2");
      const y2 = num("y2");
      // A zero-length line paints nothing, and a `path` element with a 0x0 box is
      // an element the user cannot see or grab — the same reason `rect` and
      // `circle` refuse their degenerate forms above.
      if (Math.abs(x1 - x2) < 1e-9 && Math.abs(y1 - y2) < 1e-9) return null;
      return `M${x1} ${y1}L${x2} ${y2}`;
    }

    case "polyline":
    case "polygon": {
      const coords = (shape.getAttribute("points") ?? "").trim().split(/[\s,]+/).map(Number);
      // `points` is a flat PAIR list, so one bad token re-pairs every coordinate
      // after it and yields a shape that is confidently wrong in a way nothing
      // reports. Refused instead, like `svg-body.ts` refuses the same input.
      if (
        coords.length < 4 ||
        coords.length % 2 !== 0 ||
        coords.some((n) => !Number.isFinite(n))
      ) {
        return null;
      }
      let d = `M${coords[0]} ${coords[1]}`;
      for (let i = 2; i + 1 < coords.length; i += 2) d += `L${coords[i]} ${coords[i + 1]}`;
      return tag === "polygon" ? `${d}Z` : d;
    }

    default:
      return null;
  }
}

/** Two half arcs, which is the shortest faithful spelling of a full ellipse. */
function ellipseData(cx: number, cy: number, rx: number, ry: number): string {
  return `M${cx - rx} ${cy}A${rx} ${ry} 0 1 0 ${cx + rx} ${cy}A${rx} ${ry} 0 1 0 ${cx - rx} ${cy}Z`;
}

/**
 * Paint and stroke from computed style.
 *
 * `scale` matters for the stroke: `stroke-width` is in USER units, and the path
 * data has already been scaled into viewport pixels by the `viewBox` transform,
 * so a 2-unit stroke on a 24-unit icon drawn at 12px has to become 1px. Missing
 * this is what makes imported icons look like they were drawn with a marker.
 */
/**
 * The one colour a `url(#id)` paint server is mostly made of, or null.
 *
 * A gradient cannot be rebuilt here — an imported shape becomes a `path` with a
 * flat paint stack, and there is nowhere to put stops. But dropping the fill
 * outright (what this used to do) left the element with no `fills` at all, which
 * is not "unpainted" in the DSL, it is INVISIBLE: the shape imported as a box
 * with nothing in it and exported again as an empty `<g>`.
 *
 * An icon's gradient is nearly always a two-stop ramp within one hue, so its
 * first stop is wrong the way a photocopy is wrong — recognizable, and reported
 * as such — while nothing at all is wrong the way a blank page is.
 */
function paintServerColor(svg: Element, raw: string): string | null {
  const ref = /url\(\s*['"]?#([^'")\s]+)['"]?\s*\)/.exec(raw);
  if (!ref) return null;

  let id: string | null = ref[1];
  // A gradient can inherit its stops from another (`<linearGradient href="#base">`),
  // so the id is followed a bounded number of hops; a cycle means no colour.
  for (let hop = 0; id && hop < 4; hop++) {
    const server = definitionById(svg, id);
    if (!server) return null;
    const tag = server.tagName.toLowerCase();
    // A pattern is a tile, not a colour: there is no single value to fall back to.
    if (tag !== "lineargradient" && tag !== "radialgradient") return null;

    const stop = server.querySelector("stop");
    if (stop) {
      const color = parseCssColor(stop.getAttribute("stop-color") ?? getComputedStyle(stop).stopColor);
      if (color) return color.color;
    }
    const href = server.getAttribute("href") ?? server.getAttribute("xlink:href");
    id = href && href.startsWith("#") ? href.slice(1) : null;
  }
  return null;
}

/** By id rather than by selector: an id is not guaranteed to be selector-safe. */
function definitionById(svg: Element, id: string): Element | null {
  for (const el of Array.from(svg.querySelectorAll("linearGradient, radialGradient, pattern"))) {
    if (el.getAttribute("id") === id) return el;
  }
  return null;
}

// ---------------------------------------------------------------------------
// text
// ---------------------------------------------------------------------------

/**
 * The attributes that make a `<tspan>` start a NEW LINE rather than extend the one
 * it follows.
 *
 * This is not a guess about authoring style: `wrapLines` breaks on newlines, so
 * the exporter writes one `<tspan>` per line with an explicit `x` and `dy`, and
 * reading that back has to recover the same line count. A `<tspan>` with none of
 * these continues the current line, which is how a run of differently-styled
 * words is spelled.
 */
const LINE_ATTRS = ["x", "y", "dx", "dy"];

const NO_BORDER = { top: 0, right: 0, bottom: 0, left: 0, uniform: true, color: null };

/** The document's precision: a baseline difference of two DOM boxes arrives with noise in the 8th decimal. */
const r2 = (n: number): number => Math.round(n * 100) / 100;

interface TextChunk {
  text: string;
  /** The node whose computed style this run carries, or `null` for bare text. */
  el: Element | null;
  style?: TextSpan["style"];
}

interface TextLine {
  chunks: TextChunk[];
  /** Child indices to keep when this line's box is measured on its own. */
  from: number;
  to: number;
}

/**
 * Every line of a `<text>`, as the runs on it.
 *
 * A line's box is measured by re-inserting a CLONE with the other children
 * removed, rather than by taking each `<tspan>`'s own `getBBox()`. A bare text
 * run — `<text x y>Hello <tspan x dy>world</tspan></text>` — belongs to the first
 * line but has no element of its own to measure, and a `<tspan>`'s box covers
 * only itself, so neither the element nor its anchor can answer where that line
 * sits. A truncated clone has exactly one line in it, which does.
 */
function textLinesOf(node: Element, base: CSSStyleDeclaration, report: (p: string, v: string) => void): TextLine[] {
  const lines: TextLine[] = [];
  // Held in an object rather than a `let` so the assignments made inside the two
  // closures below are visible to the reads that follow them.
  const state: { current: TextLine | null } = { current: null };
  let cursor = 0;
  let pendingStart = 0;

  const open = (): TextLine => {
    const line: TextLine = { chunks: [], from: pendingStart, to: 0 };
    lines.push(line);
    state.current = line;
    return line;
  };
  const push = (text: string, el: Element | null, style?: TextSpan["style"]) => {
    const line = state.current ?? open();
    if (text) line.chunks.push({ text, el, style });
  };

  const absorb = (el: Element, baseEl: Element) => {
    for (const inner of Array.from(el.childNodes)) {
      if (inner.nodeType === 3) {
        push(inner.textContent ?? "", el, spanStyleBetween(el, baseEl));
        continue;
      }
      if (inner.nodeType !== 1) continue;
      const innerEl = inner as Element;
      if (innerEl.tagName.toLowerCase() !== "tspan") {
        report("svg-text-element", innerEl.tagName.toLowerCase());
        continue;
      }
      if (LINE_ATTRS.some((a) => innerEl.hasAttribute(a))) report("svg-text-tspan", "positioned inside a line");
      push(innerEl.textContent ?? "", innerEl, spanStyleBetween(innerEl, el));
    }
  };

  for (const child of Array.from(node.childNodes)) {
    cursor++;
    if (child.nodeType === 3) {
      // Inter-element whitespace is not a run: `xml:space` defaults to collapsing it.
      const raw = child.textContent ?? "";
      if (!raw.trim()) continue;
      pendingStart = cursor - 1;
      push(raw, null);
      continue;
    }
    if (child.nodeType !== 1) continue;
    const el = child as Element;
    if (el.tagName.toLowerCase() !== "tspan") {
      report("svg-text-element", el.tagName.toLowerCase());
      continue;
    }
    if (LINE_ATTRS.some((a) => el.hasAttribute(a)) || !state.current) {
      pendingStart = cursor - 1;
      open();
    }
    absorb(el, node);
    if (state.current) state.current.to = cursor;
  }

  // A line's slice runs to the next line's start; the last one takes what is left.
  for (let i = 0; i < lines.length; i++) lines[i].to = i + 1 < lines.length ? lines[i + 1].from : cursor;
  return lines;
}

/** The box of one slice of a `<text>`'s children, in the text's own user space. */
function bboxOfSlice(node: Element, from: number, to: number): DOMRect | null {
  const clone = node.cloneNode(true) as Element;
  Array.from(clone.childNodes).forEach((child, i) => {
    if (i < from || i >= to) child.remove();
  });
  const parent = node.parentNode;
  if (!parent) return null;
  parent.insertBefore(clone, node);
  let box: DOMRect | null = null;
  // eslint-disable-next-line no-empty
  try {
    box = (clone as SVGGraphicsElement).getBBox();
  } catch {
    box = null;
  }
  clone.remove();
  return box && (box.width || box.height) ? box : null;
}

function spanStyleBetween(el: Element, base: Element): TextSpan["style"] | undefined {
  const cs = getComputedStyle(el);
  const bcs = getComputedStyle(base);
  const out: NonNullable<TextSpan["style"]> = {};
  if (cs.fontFamily !== bcs.fontFamily) out.fontFamily = cs.fontFamily;
  const size = px(cs.fontSize);
  const baseSize = px(bcs.fontSize);
  if (size !== undefined && size !== baseSize) out.fontSize = size;
  if (cs.fontWeight !== bcs.fontWeight && /^\d+$/.test(cs.fontWeight)) out.fontWeight = parseInt(cs.fontWeight, 10);
  if (cs.fontStyle !== bcs.fontStyle && (cs.fontStyle === "italic" || cs.fontStyle === "oblique")) out.fontStyle = "italic";
  const spacing = px(cs.letterSpacing);
  const baseSpacing = px(bcs.letterSpacing);
  if (spacing !== undefined && spacing !== baseSpacing) out.letterSpacing = spacing;
  const colour = parseCssColor(cs.fill)?.color;
  const baseColour = parseCssColor(bcs.fill)?.color;
  if (colour && colour !== baseColour) out.color = colour;
  const decoration = decorationLines(cs);
  if (decoration.length > 0 && decoration.join() !== decorationLines(bcs).join()) out.textDecoration = decoration;
  return Object.keys(out).length > 0 ? out : undefined;
}

function decorationLines(cs: CSSStyleDeclaration): NonNullable<TextStyle["textDecoration"]> {
  const out: NonNullable<TextStyle["textDecoration"]> = [];
  for (const line of cs.textDecorationLine.split(/\s+/)) {
    if (line === "underline" || line === "line-through") out.push(line);
  }
  return out;
}

/**
 * Every `<text>` under `svg`, as the DSL text elements they become.
 *
 * The baseline is the whole problem here and the DOM answers it indirectly. An
 * element's `getBBox()` for `<text>` is the union of its glyphs' FONT boxes — not
 * their ink — so `bbox.top` is exactly one ascent above the baseline, and Chrome
 * shifts that box along with the glyphs, which is why the same subtraction is
 * right under `dominant-baseline="hanging"` or `"middle"` too. Neither
 * `getStartPositionOfChar().y` nor the `y` attribute will do: both report where
 * the pen went, and neither moves when `dominant-baseline` does. Measured across
 * fonts and baseline modes in `scratch/probe-ascent-source.mjs`.
 */
export function svgTexts(
  svg: SVGSVGElement,
  /** The svg's own box origin, in the host's coordinate space. */
  origin: { x: number; y: number },
  report: (property: string, value: string) => void
): SvgText[] {
  const out: SvgText[] = [];
  const order = documentOrder(svg);

  for (const node of Array.from(svg.querySelectorAll("text"))) {
    if (insideDefinitionHost(node, svg)) continue;
    if (!(node.textContent ?? "").trim()) continue;
    const cs = getComputedStyle(node);
    if (cs.display === "none" || cs.visibility === "hidden") continue;
    if (node.querySelector("textPath")) {
      report("svg-text", "textPath");
      continue;
    }
    if (/^vertical/.test(cs.writingMode ?? "")) {
      report("svg-text", `writing-mode: ${cs.writingMode}`);
      continue;
    }
    const matrix = typeof (node as SVGGraphicsElement).getCTM === "function" ? (node as SVGGraphicsElement).getCTM() : null;
    if (!matrix) {
      report("svg-text", "no transform");
      continue;
    }
    // A rotated or skewed text is a rotated box in the DSL, and this path has no
    // way to say so; the axis-aligned bound is where it lands, which is reported
    // rather than passed off as faithful.
    if (Math.abs(matrix.b) > 1e-6 || Math.abs(matrix.c) > 1e-6 || Math.abs(matrix.a - matrix.d) > 1e-6) {
      report("svg-text-transform", "rotated or skewed");
    }
    if (node.querySelector("[textLength], [lengthAdjust]")) report("svg-text-length", "textLength");

    const scale = Math.sqrt(Math.abs(matrix.a * matrix.d - matrix.b * matrix.c)) || 1;
    const toViewport = (x: number, y: number) => ({
      x: matrix.a * x + matrix.c * y + matrix.e,
      y: matrix.b * x + matrix.d * y + matrix.f
    });

    const baseSize = Math.max(1, px(cs.fontSize) ?? 16);
    const weightRaw = cs.fontWeight;
    const weight = /^\d+$/.test(weightRaw) ? parseInt(weightRaw, 10) : 400;
    const italic = cs.fontStyle === "italic" || cs.fontStyle === "oblique";
    const metricsSpec: FontSpec = {
      fontFamily: cs.fontFamily,
      fontSize: baseSize,
      fontWeight: weight,
      fontStyle: italic ? "italic" : undefined
    };

    const lines = textLinesOf(node, cs, report);
    const measured = lines.map((line) => {
      const box = bboxOfSlice(node, line.from, line.to);
      if (!box) return null;
      const text = line.chunks.map((c) => c.text).join("").replace(/^\u00A0$/, "");
      const topLeft = toViewport(box.x, box.y);
      const bottomRight = toViewport(box.x + box.width, box.y + box.height);
      const size = Math.max(baseSize, ...line.chunks.map((c) => c.style?.fontSize ?? 0));
      const ascent = fontMetricsOf({ ...metricsSpec, fontSize: size }).ascent * scale;
      return {
        text,
        chunks: line.chunks,
        x: Math.min(topLeft.x, bottomRight.x),
        y: Math.min(topLeft.y, bottomRight.y),
        width: Math.abs(bottomRight.x - topLeft.x),
        height: Math.abs(bottomRight.y - topLeft.y),
        size: size * scale,
        // The one number the DOM will not hand over: `bbox.top` is an ascent above it.
        baseline: Math.min(topLeft.y, bottomRight.y) + ascent
      };
    });
    if (measured.some((m) => m === null)) {
      report("svg-text", "no box");
      continue;
    }
    const rows = measured as NonNullable<(typeof measured)[number]>[];

    const fontSize = r2(Math.max(...rows.map((r) => r.size)));
    const letterSpacing = px(cs.letterSpacing);
    // The DSL stores an absolute line box here: the row-to-row baseline step (or the
    // engine default for a single line) is a measured px, not a ratio.
    const lineHeight =
      rows.length > 1
        ? r2(rows[1].baseline - rows[0].baseline)
        : resolveDynamicLineHeight(fontSize, undefined);
    if (rows.length > 2) {
      for (let i = 2; i < rows.length; i++) {
        if (Math.abs(rows[i].baseline - rows[i - 1].baseline - lineHeight) > 0.5) {
          report("svg-text-line-height", "uneven line spacing");
          break;
        }
      }
    }

    const paint = shapeStyle(cs, scale, svg, report, ancestorOpacity(node, svg));
    const fills: PaintStack = paint.fills ?? [];
    const ink = fills.length > 0 && fills[0].type === "solid" ? fills[0].color : null;
    const transformRaw = cs.textTransform;
    const textTransform =
      transformRaw === "uppercase" || transformRaw === "lowercase" || transformRaw === "capitalize" ? transformRaw : undefined;

    // The lines' widths as the DSL will measure them — the same function and the
    // same spec the layout uses, so a line exactly as wide as its own ink cannot
    // come back wrapped into two. `textTransform` belongs in the spec for that
    // reason: the layout measures the CASED string, and a box measured on the
    // source string would wrap at a different word.
    const widths = rows.map((r) =>
      Math.max(
        r.width,
        measureText(r.text, {
          fontFamily: cs.fontFamily,
          fontSize,
          fontWeight: weight,
          fontStyle: italic ? "italic" : undefined,
          letterSpacing: letterSpacing !== undefined ? letterSpacing * scale : 0,
          lineHeight,
          textTransform
        }).width
      )
    );

    const anchorRaw = (cs as unknown as { textAnchor?: string }).textAnchor ?? node.getAttribute("text-anchor") ?? "start";
    const requested = anchorRaw === "middle" ? "center" : anchorRaw === "end" ? "right" : "left";
    const placed = placeLines(rows, widths, requested, report);

    const style: TextStyle = {
      fontFamily: cs.fontFamily,
      fontSize,
      ...(weight !== 400 ? { fontWeight: weight } : {}),
      ...(italic ? { fontStyle: "italic" as const } : {}),
      ...(letterSpacing !== undefined && letterSpacing !== 0 ? { letterSpacing: r2(letterSpacing * scale) } : {}),
      lineHeight: `${lineHeight}px` as LineHeight,
      align: placed.align,
      verticalAlign: "top",
      color: ink ?? "#000000",
      ...(decorationLines(cs).length > 0 ? { textDecoration: decorationLines(cs) } : {}),
      ...(textTransform ? { textTransform } : {})
    };

    const spans = rows
      .flatMap((r) => r.chunks)
      .filter((c) => c.style)
      .map((c) => ({ text: c.text, style: scaleSpan(c.style, scale) }));

    out.push({
      tag: "text",
      order: order.get(node) ?? Number.MAX_SAFE_INTEGER,
      box: {
        x: r2(origin.x + placed.x),
        // The baseline the browser drew at, moved back up to the top of a line box
        // the DSL can reproduce — the inverse of what the exporter now adds.
        y: r2(origin.y + rows[0].baseline - baselineOffsetOf({ ...metricsSpec, lineHeight })),
        width: r2(placed.width),
        height: r2(rows.length * lineHeight)
      },
      content: rows.map((r) => r.text).join("\n"),
      ...(spans.length > 0 ? { spans } : {}),
      style,
      fills,
      ...(paint.stroke ? { strokes: [paint.stroke] } : {}),
      ...(paint.opacity !== undefined ? { opacity: paint.opacity } : {})
    });
  }
  return out;
}

/**
 * Where the box goes and which alignment says so.
 *
 * The DSL holds ONE rectangle with ONE alignment for every line, so an author who
 * placed each line at its own x cannot be reproduced — those are the cases worth
 * reporting. Everything else is derived from where the lines actually are.
 */
function placeLines(
  rows: { x: number; width: number }[],
  widths: number[],
  requested: TextStyle["align"],
  report: (property: string, value: string) => void
): { x: number; width: number; align: TextStyle["align"] } {
  const left = (i: number) => rows[i].x;
  const right = (i: number) => rows[i].x + widths[i];
  const centre = (i: number) => rows[i].x + widths[i] / 2;

  const spread = (f: (i: number) => number): number => Math.max(...rows.map((_, i) => f(i))) - Math.min(...rows.map((_, i) => f(i)));
  const box =
    requested === "center"
      ? { width: Math.max(...widths), x: centre(0) - Math.max(...widths) / 2 }
      : requested === "right"
        ? { width: Math.max(...widths), x: Math.max(...rows.map((_, i) => right(i))) - Math.max(...widths) }
        : { width: Math.max(...rows.map((_, i) => right(i))) - Math.min(...rows.map((_, i) => left(i))), x: Math.min(...rows.map((_, i) => left(i))) };

  // If every line is where the alignment would put it, the model holds.
  const agreement = rows.map((_, i) =>
    Math.abs((box.x + (requested === "center" ? box.width / 2 - widths[i] / 2 : requested === "right" ? box.width - widths[i] : 0)) - left(i))
  );
  if (Math.max(...agreement) <= 0.5) return { ...box, align: requested };

  report("text-anchor", `lines start at ${spread(left).toFixed(1)}px apart`);
  const start = Math.min(...rows.map((_, i) => left(i)));
  return { x: start, width: Math.max(...rows.map((_, i) => right(i))) - start, align: "left" };
}

/** Span sizes are read in the text's own user space and the DSL counts in viewport px. */
function scaleSpan(style: TextSpan["style"], scale: number): TextSpan["style"] {
  if (!style) return style;
  return {
    ...style,
    ...(style.fontSize !== undefined ? { fontSize: r2(style.fontSize * scale) } : {}),
    ...(style.letterSpacing !== undefined ? { letterSpacing: scaleLetterSpacing(style.letterSpacing, scale) } : {})
  };
}

/** A `<text>` as the DSL element it becomes, through the same factory HTML text uses. */
export function svgTextToElement(id: string, text: SvgText, local: { x: number; y: number }, name: string): DesignElement {
  return textElement(
    name,
    id,
    { ...local, width: text.box.width, height: text.box.height },
    null,
    { x: local.x, y: local.y, width: text.box.width, height: text.box.height },
    { border: NO_BORDER, ...(text.opacity !== undefined ? { opacity: text.opacity } : {}) },
    { style: text.style, fills: text.fills, ...(text.strokes ? { strokes: text.strokes } : {}) },
    { text: text.content, spans: text.spans ?? [], hasBlock: false },
    undefined
  );
}

function shapeStyle(
  cs: CSSStyleDeclaration,
  scale: number,
  svg: Element,
  report: (property: string, value: string) => void,
  inherited: number = 1
): Pick<SvgShape, "fillRule" | "fills" | "stroke" | "opacity"> {
  const out: Pick<SvgShape, "fillRule" | "fills" | "stroke" | "opacity"> = {};

  const fillRaw = cs.fill;
  const fill = parseCssColor(fillRaw);
  if (fillRaw && fillRaw !== "none") {
    if (fill) {
      const alpha = Number.parseFloat(cs.fillOpacity);
      const opacity = fill.opacity !== undefined ? fill.opacity : Number.isFinite(alpha) && alpha < 1 ? alpha : undefined;
      out.fills = [{ type: "solid", color: fill.color, ...(opacity !== undefined ? { opacity } : {}) }];
    } else {
      const fallback = paintServerColor(svg, fillRaw);
      if (fallback) out.fills = [{ type: "solid", color: fallback }];
      // Still reported either way: a fallback is one stop of a ramp, which is a
      // different colour from the one the author wrote.
      report("fill", fillRaw);
    }
  }
  if (cs.fillRule === "evenodd") out.fillRule = "evenodd";

  const strokeRaw = cs.stroke;
  const strokeParsed = parseCssColor(strokeRaw);
  const strokeFallback = !strokeParsed && strokeRaw ? paintServerColor(svg, strokeRaw) : null;
  const strokeColor = strokeParsed ?? (strokeFallback ? { color: strokeFallback, opacity: undefined } : null);
  const width = Number.parseFloat(cs.strokeWidth);
  if (strokeRaw && strokeRaw !== "none" && strokeColor && Number.isFinite(width) && width > 0) {
    const nonScaling = cs.vectorEffect === "non-scaling-stroke";
    const strokeAlpha = Number.parseFloat(cs.strokeOpacity);
    // Computed `stroke-dasharray` carries units — `"2px, 1px"` — so `Number()` on
    // each token gave NaN for every one of them and the pattern was filtered out:
    // every dashed icon arrived solid, with nothing in the report.
    const dash = cs.strokeDasharray
      .split(/[\s,]+/)
      .map(parseFloat)
      .filter((n) => Number.isFinite(n) && n >= 0);
    const dashOffset = px(cs.strokeDashoffset);
    out.stroke = {
      color: strokeColor.color,
      width: Math.round(width * (nonScaling ? 1 : scale) * 100) / 100,
      align: "center",
      style: "solid",
      ...(cs.strokeLinecap === "round" || cs.strokeLinecap === "square" ? { cap: cs.strokeLinecap } : {}),
      ...(cs.strokeLinejoin === "round" || cs.strokeLinejoin === "bevel" ? { join: cs.strokeLinejoin } : {}),
      ...(Number.isFinite(Number.parseFloat(cs.strokeMiterlimit)) ? { miterLimit: Number.parseFloat(cs.strokeMiterlimit) } : {}),
      ...(dash.length > 0 ? { dashArray: dash.map((n) => Math.round(n * (nonScaling ? 1 : scale) * 100) / 100) } : {}),
      ...(dashOffset !== undefined && dashOffset !== 0 ? { dashOffset: Math.round(dashOffset * (nonScaling ? 1 : scale) * 100) / 100 } : {}),
      ...(Number.isFinite(strokeAlpha) && strokeAlpha < 1 ? { opacity: strokeAlpha } : {})
    };
  }

  const opacity = Number.parseFloat(cs.opacity) * inherited;
  if (Number.isFinite(opacity) && opacity < 1) out.opacity = Math.round(opacity * 1000) / 1000;
  return out;
}

/** A shape's paint, as the DSL element it becomes. */
export function shapeToElement(
  id: string,
  shape: SvgShape,
  local: { x: number; y: number },
  name: string
): DesignElement {
  return {
    id,
    type: "path",
    name,
    x: local.x,
    y: local.y,
    width: shape.box.width,
    height: shape.box.height,
    d: shape.d,
    ...(shape.fills ? { fills: shape.fills } : {}),
    ...(shape.stroke ? { strokes: [shape.stroke] } : {}),
    ...(shape.fillRule ? { fillRule: shape.fillRule } : {}),
    ...(shape.opacity !== undefined ? { opacity: shape.opacity } : {})
  } as DesignElement;
}
