import { createId } from "../id";
import type { DesignElement, TextSpan, TextStyle } from "../dsl/types";
import { isFullyTransparent, parseCssColor, px } from "./css-values";
import { shouldSkipTag } from "./html-dom";
import { borderWidthsOf, textStyleOf, type VisualStyle } from "./html-style";
import type { Rect, WalkState } from "./html-walk";

export interface Run {
  text: string;
  style?: TextSpan["style"];
}

export interface Runs {
  text: string;
  spans: TextSpan[];
  hasBlock: boolean;
}

export function rangeRect(range: Range, state: WalkState): Rect | null {
  const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0 && r.height > 0);
  if (rects.length === 0) {
    const b = range.getBoundingClientRect();
    if (b.width > 0 && b.height > 0) {
      return { x: b.left - state.origin.x, y: b.top - state.origin.y, width: b.width, height: b.height };
    }
    return null;
  }
  const x = Math.min(...rects.map((r) => r.left)) - state.origin.x;
  const y = Math.min(...rects.map((r) => r.top)) - state.origin.y;
  const right = Math.max(...rects.map((r) => r.right)) - state.origin.x;
  const bottom = Math.max(...rects.map((r) => r.bottom)) - state.origin.y;
  return { x, y, width: right - x, height: bottom - y };
}

export function textInkRect(el: Element, state: WalkState): Rect | null {
  const range = document.createRange();
  range.selectNodeContents(el);
  return rangeRect(range, state);
}

export function verticalAlignOf(ink: Rect | null, content: Rect): TextStyle["verticalAlign"] {
  if (!ink) return "top";
  const delta = ink.y + ink.height / 2 - (content.y + content.height / 2);
  if (Math.abs(delta) < 1.5) return "middle";
  return delta > 0 ? "bottom" : "top";
}

export function horizontalAlignOf(
  ink: Rect | null,
  content: Rect,
  fallback: TextStyle["align"] = "left"
): TextStyle["align"] {
  if (!ink) return fallback;
  if (content.width - ink.width <= 4) return fallback;

  const contentCenter = content.x + content.width / 2;
  const inkCenter = ink.x + ink.width / 2;
  const deltaCenter = Math.abs(inkCenter - contentCenter);
  const deltaRight = Math.abs(ink.x + ink.width - (content.x + content.width));
  const deltaLeft = Math.abs(ink.x - content.x);

  if (deltaCenter < 2.5 && deltaCenter <= deltaLeft && deltaCenter <= deltaRight) {
    return "center";
  }
  if (deltaRight < 2.5 && deltaRight < deltaLeft && deltaRight < deltaCenter) {
    return "right";
  }
  if (deltaLeft < 2.5 && deltaLeft < deltaRight && deltaLeft < deltaCenter) {
    return "left";
  }
  return fallback;
}

/** Scripts a vertical line sets upright instead of turning sideways. */
const UPRIGHT_SCRIPTS = /[\u1100-\u11ff\u2e80-\u303f\u3041-\u33ff\u3400-\u4dbf\u4e00-\u9fff\ua960-\ua97c\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6b\uff01-\uff60\uffe0-\uffe6]/;

/**
 * The angle a vertical writing mode turns through to be drawn as horizontal
 * text, or nothing when one turn cannot reproduce it.
 *
 * `vertical-rl` and `vertical-lr` both run the line top-to-bottom and set Latin
 * glyphs a quarter turn clockwise, which is exactly horizontal text carrying
 * `rotation: 90`. What a single turn cannot hold is type the browser keeps
 * UPRIGHT and merely stacks — `text-orientation: upright`, and CJK under the
 * default `mixed` — because that is a vertical line box, not a sideways one.
 */
export function verticalTextRotation(cs: CSSStyleDeclaration, text: string): number | undefined {
  if (cs.writingMode !== "vertical-rl" && cs.writingMode !== "vertical-lr") return undefined;
  if (cs.getPropertyValue("text-orientation").trim() === "upright") return undefined;
  if (UPRIGHT_SCRIPTS.test(text)) return undefined;
  return 90;
}

export function collapseText(raw: string, cs: CSSStyleDeclaration): string {
  const whiteSpace = cs.whiteSpace;
  if (whiteSpace === "pre" || whiteSpace === "pre-wrap" || whiteSpace === "break-spaces") {
    return raw.replace(/\r\n?/g, "\n");
  }
  if (whiteSpace === "pre-line") return raw.replace(/\r\n?/g, "\n").replace(/[^\S\n]+/g, " ");
  return raw.replace(/\s+/g, " ");
}

const NON_MERGEABLE_TAGS = new Set([
  "img",
  "svg",
  "video",
  "audio",
  "canvas",
  "iframe",
  "input",
  "textarea",
  "select",
  "progress",
  "meter",
  "object",
  "embed",
  "hr",
  "button",
  "math"
]);

export function inlineMergeable(child: Element, cs: CSSStyleDeclaration): boolean {
  if (NON_MERGEABLE_TAGS.has(child.tagName.toLowerCase())) return false;
  if (cs.display === "contents") return true;
  if (cs.display !== "inline") return false;
  if (parseCssColor(cs.backgroundColor)) return false;
  if (cs.backgroundImage && cs.backgroundImage !== "none") return false;
  const border = borderWidthsOf(cs);
  if (border.top > 0 || border.right > 0 || border.bottom > 0 || border.left > 0) return false;
  if (cs.boxShadow && cs.boxShadow !== "none") return false;
  return true;
}

export function spanStyleOf(cs: CSSStyleDeclaration, base: TextStyle): TextSpan["style"] | undefined {
  const out: NonNullable<TextSpan["style"]> = {};
  if (cs.fontFamily && cs.fontFamily !== base.fontFamily) out.fontFamily = cs.fontFamily;
  const size = px(cs.fontSize);
  if (size !== undefined && size !== base.fontSize) out.fontSize = size;
  const weight = /^\d+$/.test(cs.fontWeight) ? parseInt(cs.fontWeight, 10) : undefined;
  if (weight !== undefined && weight !== base.fontWeight) out.fontWeight = weight;
  if (cs.fontStyle === "italic" && base.fontStyle !== "italic") out.fontStyle = "italic";
  const colour = parseCssColor(cs.color)?.color;
  if (colour && colour !== base.color) out.color = colour;
  else if (!colour && isFullyTransparent(cs.color) && base.color !== "transparent" && base.color !== "#00000000") {
    out.color = "#00000000";
  }
  const decoration: NonNullable<TextSpan["style"]>["textDecoration"] = [];
  for (const line of cs.textDecorationLine.split(/\s+/)) {
    if (line === "underline" || line === "line-through") decoration.push(line);
  }
  if (decoration.length > 0) out.textDecoration = decoration;
  return Object.keys(out).length > 0 ? out : undefined;
}

export function collectRunsFromNodes(
  nodes: Node[],
  parentCs: CSSStyleDeclaration,
  base: TextStyle,
  state: WalkState
): Runs {
  const runs: Run[] = [];
  let hasBlock = false;

  for (const node of nodes) {
    if (node.nodeType === 3) {
      const text = collapseText(node.textContent ?? "", parentCs);
      if (text) runs.push({ text });
      continue;
    }
    if (node.nodeType !== 1) continue;
    const child = node as Element;
    const tag = child.tagName.toLowerCase();
    if (tag === "br") {
      runs.push({ text: "\n" });
      continue;
    }
    if (shouldSkipTag(tag)) continue;

    const ccs = getComputedStyle(child);
    if (ccs.display === "none") continue;
    if (!inlineMergeable(child, ccs)) {
      hasBlock = true;
      continue;
    }

    const sub = collectRuns(child, base, state);
    if (sub.hasBlock) {
      hasBlock = true;
      continue;
    }
    const override = spanStyleOf(ccs, base);
    for (const span of sub.spans) {
      runs.push(override ? { text: span.text, style: { ...span.style, ...override } } : { text: span.text });
    }
  }

  if (hasBlock) {
    return { text: runs.map((r) => r.text).join(""), spans: [], hasBlock: true };
  }

  if (runs.length > 0) {
    runs[0] = { ...runs[0], text: runs[0].text.replace(/^\s+/, "") };
    runs[runs.length - 1] = { ...runs[runs.length - 1], text: runs[runs.length - 1].text.replace(/\s+$/, "") };
  }
  const kept = runs.filter((r) => r.text.length > 0);
  return {
    text: kept.map((r) => r.text).join(""),
    spans: kept.map((r) => (r.style ? { text: r.text, style: r.style } : { text: r.text })),
    hasBlock: false
  };
}

export function collectRuns(el: Element, base: TextStyle, state: WalkState): Runs {
  return collectRunsFromNodes(Array.from(el.childNodes), getComputedStyle(el), base, state);
}

export function textElement(
  name: string,
  id: string,
  localBox: Rect,
  inkBox: Rect | null,
  contentBox: Rect,
  style: VisualStyle,
  textStyle: ReturnType<typeof textStyleOf>,
  runs: Runs,
  link: string | undefined
): DesignElement {
  const align = horizontalAlignOf(inkBox, contentBox, textStyle.style.align);
  const resolved: TextStyle = { ...textStyle.style, align, verticalAlign: verticalAlignOf(inkBox, contentBox) };
  if (textStyle.maxLines !== undefined) resolved.maxLines = textStyle.maxLines;
  if (textStyle.textOverflow !== undefined) resolved.textOverflow = textStyle.textOverflow;

  const spans = runs.spans.filter((s) => s.text.length > 0);
  const hasRichRuns = spans.length > 1 || spans.some((s) => s.style);
  /* Both spellings land on the ELEMENT, not on `style.tokenBindings`: that one is
     a text style's own bindings, and a text element carries no style id for the
     canvas to resolve them through. */
  const tokenBindings = { ...style.tokenBindings, ...textStyle.tokenBindings };

  return {
    id,
    type: "text",
    name,
    x: localBox.x,
    y: localBox.y,
    width: localBox.width,
    height: localBox.height,
    content: runs.text,
    style: resolved,
    fills: textStyle.fills,
    ...(textStyle.strokes ? { strokes: textStyle.strokes } : {}),
    ...(hasRichRuns ? { spans } : {}),
    ...(style.effects ? { effects: style.effects } : {}),
    ...(style.opacity !== undefined ? { opacity: style.opacity } : {}),
    ...(style.blendMode ? { blendMode: style.blendMode } : {}),
    ...(style.rotation !== undefined ? { rotation: style.rotation } : {}),
    ...(style.visible === false ? { visible: false } : {}),
    ...(Object.keys(tokenBindings).length > 0 ? { tokenBindings } : {}),
    ...(link ? { link } : {})
  } as DesignElement;
}
