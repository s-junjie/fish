/**
 * `foreignObject` -> native SVG `<text>`, the step that makes a canvas
 * rasterizable at all.
 *
 * The canvas paints every text element as HTML inside a `foreignObject`, and a
 * browser refuses to lay out `foreignObject` when an SVG is loaded as an
 * `<img>`. So the exporter re-implements the text layout as SVG text.
 *
 * It reads the *painted* `foreignObject` rather than the design document. A
 * document lookup can only resolve page-tree ids: an instance's children are
 * painted under derived ids (`<instanceId>_<masterNodeId>`, see
 * `component-ops.ts`) that the document tree never mints, so every text run
 * inside a component looked up as "not found" — and was deleted.
 */

import { DesignDocument, HtmlEmbedElement, TextElement, getActivePage } from "./dsl/types";
import { emitEmbedPlaceholder } from "./export-embed-placeholder";
import { textDecorationCss } from "./dsl/text-decoration";
import { findElementById } from "./geometry/tree-ops";
import { resolveDynamicLineHeight, resolveLetterSpacing } from "./compile";
import { cssPaintOrder, paintLayerIndex, topPaint } from "./dsl/paint-stack";
import { isGradientPaint } from "./geometry/gradient-utils";
import { resolveStack } from "./font-stack";
import {
  applyTextTransform,
  layoutTextRun,
  HAlign,
  VAlign,
  TextLayoutInput
} from "./text-layout";

const SVG_NS = "http://www.w3.org/2000/svg";

// Re-exported for the callers that already reach for it here; the implementation
// moved to `text-layout` so the canvas can share it.
export { applyTextTransform };

/**
 * One laid-out text box, whatever its source: a document element or a painted node.
 *
 * The typographic half — everything `layoutTextRun` reads — is `TextLayoutInput`,
 * shared with the canvas. What is added here is the PAINT: a run knows its fill,
 * stroke and shadow because the exporter has to emit them, and the canvas does
 * not need any of it to know where the lines go.
 *
 * `textTransform` and `maxLines`/`textOverflow` are inherited from the layout
 * input and documented there.
 */
interface TextRun extends TextLayoutInput {
  fontStyle?: string;
  fontVariantNumeric?: string;
  fill: string;
  fillOpacity?: number;
  strokeColor?: string;
  strokeWidth?: number;
  textShadow?: string;
  textDecoration?: string;
  spans?: TextElement["spans"];
}

export function convertForeignObjectsToSvg(clone: SVGSVGElement, doc: DesignDocument): void {
  const activePage = getActivePage(doc);
  const foreignObjects = Array.from(clone.querySelectorAll("foreignObject"));

  for (const fo of foreignObjects) {
    // The perspective tilt paints through this wrapper (see `elementTransform3d`).
    // Static SVG cannot carry a CSS 3D transform, so the export degrades to the
    // untransformed artwork the wrapper nests, tagged so the raster path
    // (`bakeTiltedElements`) can find it and warp it back into the projection.
    // A nested text FO rides on in the list above and is converted when the
    // loop reaches it.
    if (fo.getAttribute("data-tilt-fo") === "true") {
      const nested = fo.querySelector("div > svg");
      const elId = fo.closest("[data-element-id]")?.getAttribute("data-element-id") || "";
      if (nested) {
        const flat = fo.ownerDocument.createElementNS(SVG_NS, "g");
        flat.setAttribute("data-tilt-flat", elId);
        const divStyle = fo.querySelector("div")?.getAttribute("style") || "";
        if (divStyle) flat.setAttribute("data-tilt-style", divStyle);
        for (const attr of ["x", "y", "width", "height"] as const) {
          const v = fo.getAttribute(attr);
          if (v !== null) flat.setAttribute(`data-tilt-${attr}`, v);
        }
        while (nested.firstChild) flat.appendChild(nested.firstChild);
        fo.replaceWith(flat);
      } else {
        fo.remove();
      }
      continue;
    }

    const elId = fo.closest("[data-element-id]")?.getAttribute("data-element-id");
    const el = elId ? findElementById(activePage.children, elId) : null;

    if (el && el.type === "text") {
      const run = textRunFromElement(el as TextElement);
      alignTextPatternDef(clone, el as TextElement, run);
      fo.replaceWith(emitTextRun(run));
      continue;
    }

    // A framed page is the one foreignObject that has no SVG equivalent at all,
    // so it is neither converted nor deleted: it is marked. See
    // `emitEmbedPlaceholder` for why the export cannot carry the page itself.
    if (el && el.type === "html") {
      fo.replaceWith(emitEmbedPlaceholder(el as HtmlEmbedElement));
      continue;
    }

    // On-path text is already native `<text>`/`<textPath>`; re-laying it out as
    // a straight box would silently drop the curve it was laid along.
    const nativeText = fo.querySelector("text");
    if (nativeText) {
      fo.replaceWith(nativeText);
      continue;
    }

    const run = textRunFromPaintedNode(fo);
    if (run) {
      fo.replaceWith(emitTextRun(run));
      continue;
    }

    // Backdrop filters and the text-edit textarea paint through the same tag and
    // carry no geometry of their own; there is nothing to convert.
    fo.remove();
  }
}

/**
 * A pattern def is authored in the element's own space, while an exported
 * `<text>` carries absolute page coordinates. Shifting the def by the element's
 * origin is what keeps the tile phase where the canvas painted it.
 */
function alignTextPatternDef(clone: SVGSVGElement, el: TextElement, run: TextRun): void {
  const id = /^url\(#([^)]+)\)$/.exec(run.fill)?.[1];
  if (!id || !id.startsWith("pat_")) return;
  const def = clone.querySelector(`[id="${id}"]`) as SVGElement | null;
  if (!def) return;
  if (def.tagName === "linearGradient") {
    for (const attr of ["x1", "y1", "x2", "y2"] as const) {
      const value = Number(def.getAttribute(attr) ?? 0);
      const shift = attr === "x1" || attr === "x2" ? el.x : el.y;
      def.setAttribute(attr, String(value + shift));
    }
    return;
  }
  def.setAttribute("x", String(Number(def.getAttribute("x") ?? 0) + el.x));
  def.setAttribute("y", String(Number(def.getAttribute("y") ?? 0) + el.y));
}

function textRunFromElement(textEl: TextElement): TextRun {  const fontSize = textEl.style?.fontSize || 24;

  // `topPaint`, not `find`: stacks are stored bottom-first, so the first
  // enabled entry is the layer *underneath*. The canvas reads the top layer
  // and an exported file that disagrees with the canvas is a silent regression
  // in the one artifact the user actually ships.
  //
  // No layer is NO INK. `style.color` is the field an author writes text colour
  // in, and normalization has already turned an authored one into a layer when
  // the element carried no stack — so reading it again here painted glyphs the
  // author had emptied, and the `#FFFFFF` behind it painted them white
  // (LESSONS_LEARNED §206).
  const topFill = topPaint(textEl.fills || []);
  const fillDisabled = textEl.fillEnabled === false;
  let fill = "none";
  if (topFill && !fillDisabled) {
    if (topFill.type === "solid") fill = topFill.color;
    else if (isGradientPaint(topFill)) {
      fill = `url(#grad_fill_${textEl.id}_${paintLayerIndex(textEl.fills, topFill, 0)})`;
    } else if (topFill.type === "pattern") {
      fill = `url(#pat_${textEl.id}_${paintLayerIndex(textEl.fills, topFill, 0)})`;
    }
  }

  const allStrokes = (textEl as any).strokes || [];
  const activeStroke = allStrokes.find((s: any) => s && s.enabled !== false && s.width > 0);

  const textShadowEffects = cssPaintOrder(
    (textEl.effects || []).filter(
      (ef) => ef.enabled !== false && ef.type === "drop-shadow"
    )
  );
  let textShadow = textEl.style?.textShadow;
  if (textShadowEffects.length > 0) {
    textShadow = textShadowEffects
      .map((ef: any) => {
        const x = ef.offset?.x || 0;
        const y = ef.offset?.y || 0;
        const blur = ef.blur || 0;
        const color = ef.color || "#000000";
        return `${x}px ${y}px ${blur}px ${color}`;
      })
      .join(", ");
  }

  return {
    content: textEl.content || "",
    x: textEl.x,
    y: textEl.y,
    width: textEl.width,
    height: textEl.height,
    fontSize,
    fontFamily: resolveStack(textEl.style?.fontFamily),
    fontWeight: String(textEl.style?.fontWeight || 400),
    lineHeight: resolveDynamicLineHeight(fontSize, textEl.style?.lineHeight),
    letterSpacing: resolveLetterSpacing(fontSize, textEl.style?.letterSpacing),
    textTransform: textEl.style?.textTransform && textEl.style.textTransform !== "none"
      ? textEl.style.textTransform
      : undefined,
    fontStyle: textEl.style?.fontStyle === "italic" ? "italic" : undefined,
    fontVariantNumeric:
      textEl.style?.fontVariantNumeric && textEl.style.fontVariantNumeric !== "normal"
        ? textEl.style.fontVariantNumeric
        : undefined,
    maxLines: textEl.style?.maxLines,
    textOverflow: textEl.style?.textOverflow,
    align: (textEl.style?.align as HAlign) || "left",
    verticalAlign: (textEl.style?.verticalAlign as VAlign) || "top",
    fill,
    strokeColor: activeStroke
      ? activeStroke.paint?.type === "pattern"
        ? `url(#pat_stroke_${textEl.id}_${paintLayerIndex(allStrokes, activeStroke, 0)})`
        : isGradientPaint(activeStroke.paint)
          ? `url(#grad_stroke_${textEl.id}_${paintLayerIndex(allStrokes, activeStroke, 0)})`
          : activeStroke.color ||
            (activeStroke.paint?.type === "solid" ? activeStroke.paint.color : undefined) ||
            "#FFFFFF"
      : undefined,
    strokeWidth: activeStroke ? activeStroke.width || 1 : undefined,
    textShadow,
    // The element's list joined here, at the boundary into a `TextRun`, which is
    // the string-shaped half of this module: `text-decoration` is a presentation
    // attribute whose grammar is the CSS list, so nothing past this line has to
    // know that the document stores lines rather than a value.
    //
    // Empty when the text is split into runs, for the reason the canvas gives at
    // the same point: the attribute propagates to the `tspan` children and cannot
    // be taken back off one of them, so a run that turned a line off would still
    // be painted through. The runs carry their own instead, resolved just below.
    textDecoration:
      textEl.spans && textEl.spans.length > 0
        ? undefined
        : textDecorationCss(textEl.style?.textDecoration),
    spans: textEl.spans?.map((span) => {
      // Resolved, not left to inherit: `text-decoration` is propagated rather
      // than inherited, so a run that says nothing would otherwise get the
      // element's line by being a child, and a run that says `[]` could not stop
      // it. Baking the answer in here is what keeps `[]` meaningful.
      const own = span.style?.textDecoration;
      if (own || !textEl.style?.textDecoration) return span;
      return { ...span, style: { ...(span.style ?? {}), textDecoration: textEl.style.textDecoration } };
    })
  };
}

const PX_VALUE = /^-?[\d.]+px$/;

function numAttr(el: Element, name: string): number {
  const n = parseFloat(el.getAttribute(name) || "");
  return Number.isFinite(n) ? n : 0;
}

/**
 * Split a serialized `style` attribute by hand. The export works on a detached
 * clone, where `el.style` may be an empty declaration, and the attribute is the
 * one place the painted values provably survive.
 */
function parseInlineStyle(el: Element): Record<string, string> {
  const out: Record<string, string> = {};
  const attr = el.getAttribute("style");
  if (!attr) return out;
  for (const decl of attr.split(";")) {
    const sep = decl.indexOf(":");
    if (sep <= 0) continue;
    out[decl.slice(0, sep).trim().toLowerCase()] = decl.slice(sep + 1).trim();
  }
  return out;
}

function textRunFromPaintedNode(fo: Element): TextRun | null {
  const painted = fo.firstElementChild;
  if (!painted) return null;

  const style = parseInlineStyle(painted);
  // A backdrop div has no text, so every field below falls back to its default
  // and the caller emits a run of one NBSP in a default 24px white face. That is
  // how a glass panel used to export a ghost glyph in its top-left corner. The
  // marker divs are already removed before this runs; this rejects any that
  // survives, so the deletion branch stays reachable on its own terms.
  if (style["backdrop-filter"] || style["-webkit-backdrop-filter"]) return null;
  const fontSize = parseFloat(style["font-size"]) || 24;
  // `cssLineHeight` emits a unitless ratio unless the design pins a px line
  // height, so the unit has to be inferred from the value.
  const declared = style["line-height"];
  const lineHeight = declared
    ? PX_VALUE.test(declared)
      ? parseFloat(declared)
      : parseFloat(declared) * fontSize
    : resolveDynamicLineHeight(fontSize, undefined);

  // The clamp lives on the INNER text node, not on `painted`: the wrapper keeps
  // `display: flex` for vertical alignment, and `-webkit-box` would replace it.
  const innerNode = painted.firstElementChild;
  const innerStyle = innerNode ? parseInlineStyle(innerNode) : {};

  // The renderer parks the resolved paint on the `foreignObject` — not on the
  // wrapper div this function is handed — because a gradient has no CSS colour
  // to ride in, and because `none` is its own spelling for "this text has no
  // ink". Reading the wrapper's attributes found nothing, so every text reached
  // through this path (an instance's children are painted under derived ids the
  // page tree never mints) exported its default white, gradient included.
  const attr = (name: string): string | null => fo.getAttribute(name) ?? painted.getAttribute(name);
  const fill = attr("data-text-fill") || style["color"] || innerStyle["color"] || "none";
  const fillOpacity = parseFloat(attr("data-text-opacity") || "") || undefined;
  let strokeColor = attr("data-text-stroke") || undefined;
  let strokeWidth = parseFloat(attr("data-text-stroke-width") || "") || undefined;
  if (!strokeColor) {
    const webkitStroke = style["-webkit-text-stroke"];
    const m = webkitStroke ? /^([\d.]+)px\s+(.+)$/.exec(webkitStroke) : null;
    if (m) {
      strokeWidth = parseFloat(m[1]);
      strokeColor = m[2];
    }
  }

  const clampRaw = parseInt(innerStyle["-webkit-line-clamp"] || style["-webkit-line-clamp"] || "", 10);
  const singleLine =
    innerStyle["white-space"] === "nowrap" || style["white-space"] === "nowrap";
  const maxLines = Number.isFinite(clampRaw) && clampRaw > 0 ? clampRaw : singleLine ? 1 : undefined;
  const overflowRaw = innerStyle["text-overflow"] || style["text-overflow"];

  const justify = style["justify-content"];
  return {
    content: painted.textContent || "",
    x: numAttr(fo, "x"),
    y: numAttr(fo, "y"),
    width: numAttr(fo, "width"),
    height: numAttr(fo, "height"),
    fontSize,
    fontFamily: resolveStack(style["font-family"]),
    fontWeight: style["font-weight"] || "400",
    lineHeight,
    letterSpacing: parseFloat(style["letter-spacing"]) || 0,
    textTransform: style["text-transform"] && style["text-transform"] !== "none"
      ? style["text-transform"]
      : undefined,
    fontStyle: style["font-style"] === "italic" ? "italic" : undefined,
    fontVariantNumeric:
      style["font-variant-numeric"] && style["font-variant-numeric"] !== "normal"
        ? style["font-variant-numeric"]
        : undefined,
    maxLines,
    textOverflow: overflowRaw === "ellipsis" ? "ellipsis" : overflowRaw === "clip" ? "clip" : undefined,
    align: (style["text-align"] as HAlign) || "left",
    verticalAlign: justify === "center" ? "middle" : justify === "flex-end" ? "bottom" : "top",
    fill,
    fillOpacity,
    strokeColor,
    strokeWidth,
    textShadow: style["text-shadow"] || attr("data-text-shadow") || undefined,
    textDecoration: style["text-decoration"] && style["text-decoration"] !== "none"
      ? style["text-decoration"]
      : undefined
  };
}

/**
 * What the glyphs look like once `text-transform` has been applied.
 *
 * The canvas lets the browser do it and keeps the source string intact; the
 * export has to bake it in, because `wrapLines` measures the string itself.
 * Uppercase is wider than the casing it replaced, so measuring the raw paragraph
 * would break the exported run at a different word than the canvas breaks it.
 * `capitalize` upper-cases the first letter of each WORD, which is what CSS does
 * and not what a naive first-letter pass does.
 */
function emitTextRun(run: TextRun): SVGTextElement {
  // Where the lines go is `text-layout`'s answer, shared with the canvas: the
  // exported file and the canvas paint the same run, and the only way to keep
  // them agreeing at every word is to ask the same function.
  const { lines, startX, startY, baselineOffset, textAnchor, placement } = layoutTextRun(run);

  const placeLine = (node: SVGElement, idx: number) => {
    const p = placement(idx);
    node.setAttribute("x", String(p.x));
    node.setAttribute("dy", p.dy);
    if (p.textLength !== undefined) {
      node.setAttribute("textLength", String(p.textLength));
      node.setAttribute("lengthAdjust", p.lengthAdjust!);
    }
  };

  const textNode = document.createElementNS(SVG_NS, "text");
  // `y` is a BASELINE and `startY` is a line box's top, so the box's own
  // offset-to-baseline has to be added back. `hanging` used to stand in for it,
  // and stood in badly: it puts the baseline at 0.8×ascent below `y` where the
  // HTML line box puts it `half-leading + ascent` below the top, lifting every
  // exported run by ~0.26em — 6px on a 24px label, measured pixel-for-pixel
  // against the canvas. Lines after the first are unaffected: `dy` is a
  // line-to-line step and both models agree it is one line height.
  textNode.setAttribute("x", String(startX));
  textNode.setAttribute("y", String(startY + baselineOffset));
  textNode.setAttribute("font-family", run.fontFamily);
  textNode.setAttribute("font-size", `${run.fontSize}px`);
  textNode.setAttribute("font-weight", String(run.fontWeight));
  if (run.fontStyle) textNode.setAttribute("font-style", run.fontStyle);
  if (run.fontVariantNumeric) textNode.setAttribute("font-variant-numeric", run.fontVariantNumeric);
  if (run.letterSpacing) textNode.setAttribute("letter-spacing", `${run.letterSpacing}px`);
  textNode.setAttribute("text-anchor", textAnchor);
  textNode.setAttribute("dominant-baseline", "alphabetic");
  textNode.setAttribute("fill", run.fill);
  if (run.fillOpacity !== undefined && run.fillOpacity < 1) {
    textNode.setAttribute("fill-opacity", String(run.fillOpacity));
  }
  if (run.strokeColor && run.strokeWidth) {
    textNode.setAttribute("stroke", run.strokeColor);
    textNode.setAttribute("stroke-width", String(run.strokeWidth));
  }
  if (run.textShadow) {
    textNode.setAttribute("style", `text-shadow: ${run.textShadow}`);
  }
  if (run.textDecoration && run.textDecoration !== "none") {
    textNode.setAttribute("text-decoration", run.textDecoration);
  }

  // If there are multi-span styles, render sub-tspans per line
  if (run.spans && run.spans.length > 0) {
    let charOffset = 0;
    const spanIntervals = run.spans.map((s) => {
      const start = charOffset;
      const end = charOffset + s.text.length;
      charOffset = end;
      return { span: s, start, end };
    });

    let currentLineStart = 0;
    lines.forEach((lineText, idx) => {
      const lineTspan = document.createElementNS(SVG_NS, "tspan");
      placeLine(lineTspan, idx);

      const currentLineEnd = currentLineStart + lineText.length;
      // Slice intervals that intersect [currentLineStart, currentLineEnd]
      const overlapping = spanIntervals
        .filter((si) => si.end > currentLineStart && si.start < currentLineEnd)
        .map((si) => {
          const sliceStart = Math.max(0, si.start - currentLineStart);
          const sliceEnd = Math.min(lineText.length, si.end - currentLineStart);
          return {
            text: lineText.slice(sliceStart, sliceEnd),
            style: si.span.style
          };
        })
        .filter((chunk) => chunk.text.length > 0);

      if (overlapping.length > 0) {
        for (const chunk of overlapping) {
          const subTspan = document.createElementNS(SVG_NS, "tspan");
          subTspan.textContent = chunk.text;
          const s = chunk.style || {};
          if (s.fontFamily) subTspan.setAttribute("font-family", resolveStack(s.fontFamily));
          if (s.fontSize) subTspan.setAttribute("font-size", `${s.fontSize}px`);
          if (s.fontWeight) subTspan.setAttribute("font-weight", String(s.fontWeight));
          if (s.fontStyle) subTspan.setAttribute("font-style", s.fontStyle);
          if (s.letterSpacing !== undefined)
            subTspan.setAttribute("letter-spacing", `${resolveLetterSpacing(s.fontSize ?? run.fontSize, s.letterSpacing)}px`);
          if (s.color) subTspan.setAttribute("fill", s.color);
          const spanDecoration = textDecorationCss(s.textDecoration);
          if (spanDecoration) subTspan.setAttribute("text-decoration", spanDecoration);
          lineTspan.appendChild(subTspan);
        }
      } else {
        lineTspan.textContent = lineText || "\u00A0";
      }

      textNode.appendChild(lineTspan);
      currentLineStart = currentLineEnd;
    });
  } else {
    lines.forEach((lineText, idx) => {
      const tspan = document.createElementNS(SVG_NS, "tspan");
      placeLine(tspan, idx);
      tspan.textContent = lineText || "\u00A0";
      textNode.appendChild(tspan);
    });
  }

  return textNode;
}
