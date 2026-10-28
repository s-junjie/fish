/**
 * The element builders: one function per DOM element that becomes a leaf, and
 * the naming every produced element carries.
 *
 * Split out of `html-walk.ts`, which owns the traversal — what to descend into,
 * what to drop, what the browser placed where. A builder is the other half: it
 * is handed a measured box and answers with a DSL element, so it can be read
 * without the walk in mind. `Rect` / `WalkState` come back from the walk as
 * types only, which keeps the dependency one-way at runtime.
 */

import { createId } from "../id";
import type { AutoLayout, DesignElement, FrameElement, Paint } from "../dsl/types";
import type { MissingPaint } from "./html-types";
import { imageSource } from "./html-assets";
import { cropFromPosition } from "../geometry/image-crop";
import { px, parseCssColor, parseObjectPosition } from "./css-values";
import { pseudoOf } from "./html-pseudo";
import type { BorderWidths, UnmappedSink, VisualStyle } from "./html-style";
import type { TokenLookup } from "./html-tokens";
import { layoutPadding } from "./html-layout";
import { shapeToElement, svgShapes, svgTexts, svgTextToElement } from "./html-svg";
import { flattenLayout } from "../dsl/layout-flat";
import type { Rect, WalkState } from "./html-walk";

export const r2 = (n: number): number => Math.round(n * 100) / 100;

function styleAttrs(style: VisualStyle): Record<string, unknown> {
  return {
    ...(style.fills ? { fills: style.fills } : {}),
    ...(style.stroke ? { strokes: [style.stroke] } : {}),
    ...(style.borderRadius !== undefined ? { borderRadius: style.borderRadius } : {}),
    ...(style.effects ? { effects: style.effects } : {}),
    ...(style.adjust ? { adjust: style.adjust } : {}),
    ...(style.opacity !== undefined ? { opacity: style.opacity } : {}),
    ...(style.blendMode ? { blendMode: style.blendMode } : {}),
    ...(style.rotation !== undefined ? { rotation: style.rotation } : {}),
    ...(style.visible === false ? { visible: false } : {}),
    ...(style.tokenBindings ? { tokenBindings: style.tokenBindings } : {})
  };
}

/**
 * The spacing tokens a container's own layout was written with.
 *
 * Padding is only bindable on a box that draws no border: the DSL's padding
 * carries the border's width inside it (a CSS border is drawn inside the padding
 * box), so a box with one has no padding value a token can name.
 */
export function spacingBindingsOf(
  tokens: TokenLookup,
  layout: AutoLayout,
  cs: CSSStyleDeclaration,
  border: BorderWidths
): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  const gap = typeof layout.gap === "number" ? layout.gap : layout.columnGap;
  if (typeof gap === "number" && gap > 0) {
    const id = tokens.number(["gap", "column-gap", "row-gap"], gap);
    if (id) out.gap = id;
  }
  if (border.top === 0 && border.right === 0 && border.bottom === 0 && border.left === 0) {
    const padding = layoutPadding(cs, border);
    if (typeof padding === "number" && padding > 0) {
      const id = tokens.number(["padding", "padding-top"], padding);
      if (id) out.padding = id;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function hasPaint(style: VisualStyle): boolean {
  return Boolean((style.fills && style.fills.length > 0) || style.stroke || (style.effects && style.effects.length > 0));
}

export function frameElement(
  el: Element,
  id: string,
  box: Rect,
  style: VisualStyle,
  children: DesignElement[],
  layout: AutoLayout | undefined,
  cs: CSSStyleDeclaration,
  link: string | undefined,
  rootName: string | null
): FrameElement {
  const frame: FrameElement = {
    id,
    type: "frame",
    name: rootName ?? nameOf(el),
    x: box.x,
    y: box.y,
    width: box.width,
    height: box.height,
    ...styleAttrs(style),
    clipContent: style.clipContent ?? false,
    ...(link ? { link } : {}),
    children
  } as FrameElement;

  if (layout) {
    const padding = layoutPadding(cs, style.border);
    Object.assign(frame, flattenLayout(padding === 0 ? layout : { ...layout, padding }));
  }
  return frame;
}

export function rectElement(el: Element, id: string, box: Rect, style: VisualStyle, link: string | undefined): DesignElement {
  return {
    id,
    type: "rect",
    name: nameOf(el),
    x: box.x,
    y: box.y,
    width: box.width,
    height: box.height,
    // A rect with no fill is backfilled to transparent WITH a repair by
    // normalize, so a stack is always written here.
    fills: style.fills ?? ([{ type: "solid", color: "transparent" }] as Paint[]),
    ...(style.stroke ? { strokes: [style.stroke] } : {}),
    ...(style.borderRadius !== undefined ? { borderRadius: style.borderRadius } : {}),
    ...(style.effects ? { effects: style.effects } : {}),
    ...(style.adjust ? { adjust: style.adjust } : {}),
    ...(style.opacity !== undefined ? { opacity: style.opacity } : {}),
    ...(style.blendMode ? { blendMode: style.blendMode } : {}),
    ...(style.rotation !== undefined ? { rotation: style.rotation } : {}),
    ...(style.visible === false ? { visible: false } : {}),
    ...(style.tokenBindings ? { tokenBindings: style.tokenBindings } : {}),
    ...(link ? { link } : {})
  } as DesignElement;
}

export function imageElement(
  el: Element,
  id: string,
  box: Rect,
  style: VisualStyle,
  state: WalkState,
  sink: UnmappedSink
): DesignElement {
  const img = el as HTMLImageElement;
  const src = imageSource(img);
  const paints: Paint[] = [];

  if (src) {
    // The asset's size is the bitmap's OWN size, not the box it happens to be
    // drawn in: a crop framing is solved from it, so recording the box here
    // would make `cover` a no-op and every framing a no-op with it.
    const natural = { width: img.naturalWidth, height: img.naturalHeight };
    // How the bitmap is framed is a property of the CSS, not of whether its
    // bytes arrived — so it is solved once and kept, and attaching the folder
    // later only has to supply the asset id.
    const framing = imageFraming(el, box, natural, sink);
    const assetId = state.assets.idFor(src, {
      name: nameOf(el),
      width: natural.width > 0 ? natural.width : box.width,
      height: natural.height > 0 ? natural.height : box.height
    });
    if (assetId) {
      paints.push({ type: "image", assetId, ...framing.paint });
    } else {
      // Its bytes are not in the document, so the element keeps the box and loses
      // the picture — reported with WHY, since "not fetched" and "cannot be read"
      // are fixed differently. The framing rides along, so the folder that
      // arrives later needs no second walk of the page.
      const why = state.assets.reason(src);
      sink("img", why ? `${src} — ${why}` : src);
      state.missing.push({ elementId: id, url: src, paint: framing.paint, position: framing.position });
    }
  }

  const fills = paints.length > 0 ? [...(style.fills ?? []), ...paints] : style.fills;
  return rectElement(el, id, box, { ...style, fills }, linkOf(el, sink));
}

/**
 * `object-fit` + `object-position` as the paint fields that reproduce them.
 *
 * `cover` and `contain` keep the bitmap's own proportions and leave a margin,
 * which `object-position` decides the side of — a portrait avatar framed on its
 * face rather than its shoulders. The framing is exact when the natural size is
 * known, so it is written as a crop; a page whose bitmap has not loaded yet has
 * nothing to solve, and hands the position back to be solved later rather than
 * reporting a gap that the folder will close anyway.
 */
function imageFraming(
  el: Element,
  box: Rect,
  natural: { width: number; height: number },
  sink: UnmappedSink
): { paint: MissingPaint; position?: { x: number; y: number } } {
  const objectFit = getComputedStyle(el).objectFit;
  const fit = objectFit === "cover" || objectFit === "contain" ? objectFit : "fill";
  if (fit !== objectFit) sink("object-fit", objectFit);
  if (fit === "fill") return { paint: { fit } };
  const frame = getComputedStyle(el).objectPosition;
  // Only `50% 50%` is the default: `0% 0%` is `object-position: top left`
  // resolving to the same numbers the initial value never produces.
  if (!frame || frame === "50% 50%") return { paint: { fit } };
  const position = parseObjectPosition(frame);
  if (!position) {
    sink("object-position", frame);
    return { paint: { fit } };
  }
  if (natural.width > 0 && natural.height > 0) {
    return { paint: { fit: "crop", crop: cropFromPosition({ box, natural, position, fit }) } };
  }
  return { paint: { fit }, position };
}

export function ruleElement(el: Element, id: string, box: Rect, style: VisualStyle, sink: UnmappedSink): DesignElement {
  const cs = getComputedStyle(el);
  /* A `<hr>` draws either a border or a background, and the two are told apart
     by WIDTH rather than by colour: the UA stylesheet gives `<hr>` an `inset`
     border whose colour Chrome keeps reporting as `rgb(128, 128, 128)` even
     after `border: 0`, so preferring it unconditionally repainted every styled
     divider grey over the background the author had written. */
  const drawn = style.border.top > 0 ? parseCssColor(cs.borderTopColor)?.color : undefined;
  const colour = drawn ?? parseCssColor(cs.backgroundColor)?.color ?? style.stroke?.color ?? "#000000";
  const width = Math.max(1, px(cs.borderTopWidth) ?? 0, style.border.top, box.height);
  if (style.fills && style.fills.length > 0) sink("hr-background", "rendered as a line");
  // A line carries one colour and one width, so anything else the divider was
  // given names itself rather than disappearing into the stroke it replaced.
  for (const [property, given] of [
    ["border-radius", style.borderRadius !== undefined],
    ["box-shadow", Boolean(style.effects && style.effects.length > 0)],
    ["filter", Boolean(style.adjust)],
    ["opacity", style.opacity !== undefined],
    ["mix-blend-mode", Boolean(style.blendMode)],
    ["rotation", style.rotation !== undefined]
  ] as const) {
    if (given) sink(property, "a <hr> imports as a line");
  }
  return {
    id,
    type: "line",
    name: nameOf(el),
    x: box.x,
    y: box.y,
    width: box.width,
    height: 0,
    dx: box.width,
    dy: 0,
    strokes: [{ color: colour, width, style: "solid", align: "center" }]
  } as DesignElement;
}

/**
 * An inline `<svg>` becomes a frame of `path` elements.
 *
 * The frame keeps the icon's own box (and its clipping), and each shape is placed
 * inside it. `rect` is the svg's box ALREADY un-rotated, which is what the
 * shape offsets are relative to — `getCTM()` reports the svg's local space, so
 * feeding it the axis-aligned bound a rotation produces would offset every icon
 * by the difference between the two.
 */
export function svgElement(
  el: Element,
  id: string,
  box: Rect,
  rect: Rect,
  style: VisualStyle,
  sink: UnmappedSink,
  link: string | undefined
): { frame: DesignElement; children: DesignElement[] } {
  const shapes = svgShapes(el as SVGSVGElement, { x: rect.x, y: rect.y }, sink);
  const texts = svgTexts(el as SVGSVGElement, { x: rect.x, y: rect.y }, sink);
  // Shapes and text are collected in two passes, so they are put back in document
  // order before becoming children: a label drawn under a badge is below it, and
  // appending the text after every shape would paint it over one it sits behind.
  const children: DesignElement[] = [
    ...shapes.map((shape) => ({ order: shape.order, build: () =>
      shapeToElement(
        createId("path"),
        shape,
        { x: r2(shape.box.x - rect.x), y: r2(shape.box.y - rect.y) },
        `${nameOf(el)} / ${shape.tag}`
      ) })),
    ...texts.map((text) => ({ order: text.order, build: () =>
      svgTextToElement(
        createId("text"),
        text,
        { x: r2(text.box.x - rect.x), y: r2(text.box.y - rect.y) },
        `${nameOf(el)} / text`
      ) }))
  ]
    .sort((a, b) => a.order - b.order)
    .map((item) => item.build());

  const frame = {
    id,
    type: "frame",
    name: nameOf(el),
    x: box.x,
    y: box.y,
    width: box.width,
    height: box.height,
    ...styleAttrs(style),
    clipContent: style.clipContent ?? false,
    ...(link ? { link } : {}),
    children
  } as DesignElement;

  return { frame, children };
}

export function embedElement(el: Element, id: string, box: Rect, style: VisualStyle, sink: UnmappedSink): DesignElement {
  const srcdoc = el.getAttribute("srcdoc") ?? "";
  const src = (el.getAttribute("src") ?? "").trim();
  if (!srcdoc && !/^https?:\/\//i.test(src)) {
    sink("iframe", src || "no source");
    return rectElement(el, id, box, style, undefined);
  }
  return {
    id,
    type: "html",
    name: nameOf(el),
    x: box.x,
    y: box.y,
    width: box.width,
    height: box.height,
    ...(srcdoc ? { srcdoc } : { src }),
    ...(style.borderRadius !== undefined ? { borderRadius: style.borderRadius } : {})
  } as DesignElement;
}

// ---------------------------------------------------------------------------
// misc
// ---------------------------------------------------------------------------

export function linkOf(el: Element, sink: UnmappedSink): string | undefined {
  const href = el.getAttribute("href");
  if (!href) return undefined;
  const value = href.trim();
  if (/^(https?:|mailto:|tel:)/i.test(value)) return value;
  // A relative href has no base to resolve against — the document arrived as
  // text, not from a URL — so it is reported rather than guessed at.
  sink("href", value);
  return undefined;
}

const NAME_LIMIT = 40;

export function nameOf(el: Element): string {
  const aria = el.getAttribute("aria-label");
  if (aria && aria.trim()) return clip(aria.trim());
  const title = el.getAttribute("title");
  if (title && title.trim()) return clip(title.trim());
  const pseudo = pseudoOf(el);
  const host = el.parentElement;
  if (pseudo && host) return clip(`${hostNameOf(host)}::${pseudo}`);
  return hostNameOf(el);
}

function hostNameOf(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const id = el.getAttribute("id");
  if (id) return clip(`${tag}#${id}`);
  const cls = el.getAttribute("class");
  const first = cls ? cls.trim().split(/\s+/)[0] : "";
  if (first) return clip(`${tag}.${first}`);
  return tag;
}

export function textName(el: Element, text: string): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  return trimmed ? clip(trimmed, 24) : nameOf(el);
}

export function clip(value: string, limit = NAME_LIMIT): string {
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}
