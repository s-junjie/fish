import { createId } from "../id";
import type {
  AutoLayout,
  DesignElement,
  FrameElement,
  LineHeight,
  Paint,
  TextSpan,
  TextStyle
} from "../dsl/types";
import type { AssetStore } from "./html-assets";
import type { MissingAsset, MissingPaint } from "./html-types";
import { px, isFullyTransparent, parseCssColor, sidewaysTextBox, unrotateBox } from "./css-values";
import { shouldSkipTag } from "./html-dom";
import { claimAuthoredId, minterFor } from "./html-ids";
import { isPseudoClone, pseudoOf } from "./html-pseudo";
import {
  clip,
  embedElement,
  frameElement,
  hasPaint,
  imageElement,
  linkOf,
  nameOf,
  r2,
  rectElement,
  ruleElement,
  spacingBindingsOf,
  svgElement,
  textName
} from "./html-elements";
import {
  borderWidthsOf,
  textStyleOf,
  visualStyleOf,
  type AssetResolver,
  type BorderWidths,
  type UnmappedSink,
  type VisualStyle
} from "./html-style";
import type { HtmlTokens, TokenLookup } from "./html-tokens";
import { childSizingFor, layoutFor, marginOf } from "./html-layout";
import { layoutOf, toCssLine } from "../dsl/layout-flat";
import {
  collectRuns,
  collectRunsFromNodes,
  inlineMergeable,
  rangeRect,
  textElement,
  textInkRect,
  verticalTextRotation,
  type Runs
} from "./html-text";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WalkState {
  body: HTMLElement;
  /** The import host's own origin, so viewport rects can be re-based to (0, 0). */
  origin: { x: number; y: number };
  unmapped: Array<{ path: string; property: string; value: string }>;
  sources: Array<{ id: string; path: string }>;
  /** Where the browser actually had each produced box, keyed by element id. */
  measured: Map<string, Rect>;
  /**
   * The browser's used line-height for a `line-height: normal` box, which
   * computed style reports as the literal string `"normal"`. Supplied by the
   * mount, because only it owns the shadow root the probe has to live in.
   */
  normalLineHeight: (cs: CSSStyleDeclaration) => number | undefined;
  /**
   * What the author wrote for a property, for the handful of values whose
   * COMPUTED form has already thrown away the intent — a track list above all.
   * Supplied by the mount, because only it owns the shadow root's stylesheets.
   */
  authored: (el: Element, property: string) => string | undefined;
  /**
   * The page's design tokens, read off its own custom properties before the
   * walk. One token book for the whole page: a custom property is a document
   *-level name, and two elements that both say `var(--panel)` must land on the
   * same token.
   */
  tokens?: HtmlTokens;
  /** Every referenced bitmap, resolved before the walk because it starts async. */
  assets: AssetStore;
  /**
   * Bitmaps whose bytes did not arrive, with the element and framing that want
   * them — the list a later folder pick fills in without a second import.
   */
  missing: MissingAsset[];
  /**
   * The same for `background-image`, which is read before the element has an id.
   * Resolved against `sources` once the walk is done.
   */
  backgroundMisses: Array<{ path: string; url: string; paint: MissingPaint }>;
  /**
   * Ids the page's own `id` attributes have already claimed, seeded with the
   * ones the target document owns. Mutated by the walk: uniqueness is
   * document-wide, and an import is appended to a page that may already hold
   * the anchor it is about to reuse.
   */
  takenIds: Set<string>;
  signal?: AbortSignal;
}

/** What a child's coordinates and sizing hints are derived from. */
interface ParentContext {
  abs: { x: number; y: number };
  /** The parent's CONTENT box, which is what a flex/grid pass distributes inside. */
  content: { width: number; height: number };
}

interface RotationFrame {
  cx: number;
  cy: number;
  rad: number;
}

const CSS_LINE_HEIGHT_RE = /^([+-]?(?:\d+\.?\d*|\.\d+))(px|%|em)?$/;

/**
 * The author's `line-height` declaration → the DSL tagged value, unit preserved.
 *
 * Computed style reports a unitless (or `%`, `em`) line height as its USED px, so
 * reading `cs.lineHeight` alone flattens every ratio to a px that then stops
 * following a font-size change. `state.authored` hands back what the page actually
 * wrote, so `1.5` / `150%` / `1.5em` stay multipliers and only `24px` becomes an
 * absolute length — the same reading the DSL itself uses. A value the parser does
 * not cover (`rem`, `calc()`) and a `normal` both fall through to the computed px,
 * which for `normal` is the browser's own answer.
 */
function cssLineHeightToDsl(raw: string): LineHeight | "normal" | undefined {
  const token = raw.trim().toLowerCase();
  if (token === "normal") return "normal";
  const match = CSS_LINE_HEIGHT_RE.exec(token);
  if (!match) return undefined;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  if (match[2] === "px") return `${r2(value)}px` as LineHeight;
  if (match[2] === "%") return r2(value / 100);
  return r2(value);
}

/**
 * The line height a text box imports with. The browser resolves `normal` to a
 * font-dependent used value the DSL cannot reproduce on its own, so it is probed
 * (`state.normalLineHeight`) into a px — an imported box must match the page it
 * came from, not the engine's own tiered default.
 */
function htmlLineHeight(el: Element, cs: CSSStyleDeclaration, state: WalkState): LineHeight | undefined {
  const authored = state.authored(el, "line-height");
  if (authored !== undefined) {
    const parsed = cssLineHeightToDsl(authored);
    if (parsed === "normal") return probeNormalLineHeight(cs, state);
    if (parsed !== undefined) return parsed;
  }
  const computed = cs.lineHeight;
  if (computed === "" || computed === "normal") return probeNormalLineHeight(cs, state);
  const px = Number.parseFloat(computed);
  return Number.isFinite(px) && px > 0 ? (`${r2(px)}px` as LineHeight) : undefined;
}

function probeNormalLineHeight(cs: CSSStyleDeclaration, state: WalkState): LineHeight | undefined {
  const px = state.normalLineHeight(cs);
  return px !== undefined && px > 0 ? (`${r2(px)}px` as LineHeight) : undefined;
}

/** No paint and no inset, for a text child a synthesized box already carries. */
const PLAIN_STYLE: VisualStyle = { border: { top: 0, right: 0, bottom: 0, left: 0, uniform: true, color: null } };

export function walkDocument(
  state: WalkState,
  rootName: string,
  /** `<html>` itself, whose own background is what paints behind everything. */
  documentElement?: HTMLElement | null
): DesignElement | null {
  const bodyRect = measuredRect(state.body, state);
  const root = mapElement(
    state.body,
    { abs: { x: bodyRect.x, y: bodyRect.y }, content: contentSize(bodyRect, getComputedStyle(state.body)) },
    [],
    state,
    rootName
  );
  rootHtmlBackgroundInto(root, documentElement, state);
  // A page whose content overflows its own body box — a float, or a block placed
  // absolutely — would otherwise import into a frame shorter than what it holds,
  // and the frame's height is the handle the user grabs.
  if (root && root.type === "frame" && !layoutOf(root) && root.children.length > 0) {
    const bottom = root.children.reduce((max, child) => Math.max(max, child.y + child.height), 0);
    if (bottom > root.height) {
      root.height = r2(bottom);
      state.measured.set(root.id, { x: 0, y: 0, width: root.width, height: root.height });
    }
  }
  return root;
}

/**
 * The page's own backdrop, which usually lives on `<html>`.
 *
 * A background on the root element is what fills the viewport, and `<body>` is
 * what the walk builds the page's root frame from — so a dark shell written as
 * `html { background: #0b0b0c }` imported as an unpainted frame over transparent
 * canvas, with nothing anywhere reporting the loss. Written only where the body
 * has no background of its own, because CSS's own propagation is the same
 * one-way rule: body paints over html, never the reverse.
 */
function rootHtmlBackgroundInto(
  root: DesignElement | null,
  documentElement: HTMLElement | null | undefined,
  state: WalkState
): void {
  if (!root || root.type !== "frame" || !documentElement || documentElement === state.body) return;
  if (root.fills && root.fills.length > 0) return;
  const html = getComputedStyle(documentElement);
  const colour = parseCssColor(html.backgroundColor);
  if (!colour) return;
  root.fills = [
    {
      type: "solid",
      color: colour.color,
      ...(colour.opacity !== undefined ? { opacity: colour.opacity } : {})
    } as Paint
  ];
}

// ---------------------------------------------------------------------------
// measurement
// ---------------------------------------------------------------------------

function measuredRect(el: Element, state: WalkState): Rect {
  const r = el.getBoundingClientRect();
  return { x: r.left - state.origin.x, y: r.top - state.origin.y, width: r.width, height: r.height };
}

function insetOf(cs: CSSStyleDeclaration): { x: number; y: number; right: number; bottom: number } {
  const border = borderWidthsOf(cs);
  return {
    x: border.left + (px(cs.paddingLeft) ?? 0),
    y: border.top + (px(cs.paddingTop) ?? 0),
    right: border.right + (px(cs.paddingRight) ?? 0),
    bottom: border.bottom + (px(cs.paddingBottom) ?? 0)
  };
}

function contentSize(rect: Rect, cs: CSSStyleDeclaration): { width: number; height: number } {
  const inset = insetOf(cs);
  return {
    width: Math.max(0, rect.width - inset.x - inset.right),
    height: Math.max(0, rect.height - inset.y - inset.bottom)
  };
}

/**
 * A box measured on screen, pulled back out of every rotation between it and the
 * space it is being placed in.
 *
 * `getBoundingClientRect()` reports axis-aligned boxes, so a rotated ancestor
 * skews every descendant's rect. Undoing the chain — centre first, then the
 * size — recovers the box the DSL would draw before applying its own
 * `rotation`.
 */
function unrotate(rect: Rect, frames: RotationFrame[]): Rect {
  if (frames.length === 0) return rect;
  let cx = rect.x + rect.width / 2;
  let cy = rect.y + rect.height / 2;
  let total = 0;
  for (let i = frames.length - 1; i >= 0; i--) {
    const f = frames[i];
    const dx = cx - f.cx;
    const dy = cy - f.cy;
    cx = f.cx + dx * Math.cos(-f.rad) - dy * Math.sin(-f.rad);
    cy = f.cy + dx * Math.sin(-f.rad) + dy * Math.cos(-f.rad);
    total -= f.rad;
  }
  return unrotateBox(rect, (total * 180) / Math.PI);
}

/**
 * The DOM path of an element, as `body/0/2/1`.
 *
 * Materialized pseudo-elements are SKIPPED when numbering siblings, so a page
 * that has them still reports the same paths a browser without them would — the
 * paths are what a probe lines the import up against, and an extra node in the
 * middle would shift every one of them.
 */
export function domPath(el: Element, body: Element): string {
  const pseudo = pseudoOf(el);
  const parent: Element | null = el.parentElement;
  if (pseudo && parent) return `${domPath(parent, body)}~${pseudo}`;

  const parts: number[] = [];
  let cur: Element | null = el;
  while (cur && cur !== body) {
    const owner: Element | null = cur.parentElement;
    if (!owner) break;
    let index = 0;
    for (const sibling of Array.from(owner.children)) {
      if (sibling === cur) break;
      if (!isPseudoClone(sibling)) index += 1;
    }
    parts.unshift(index);
    cur = owner;
  }
  return `body/${parts.join("/")}`;
}

// ---------------------------------------------------------------------------
// the walk
// ---------------------------------------------------------------------------

function mapElement(
  el: Element,
  parent: ParentContext,
  frames: RotationFrame[],
  state: WalkState,
  rootName: string | null,
  /** Whether a layout pass is placing this element, which changes what "empty" costs. */
  inLayout = false
): DesignElement | null {
  if (state.signal?.aborted) throw new DOMException("Import aborted", "AbortError");
  const cs = getComputedStyle(el);
  if (cs.display === "none") return null;

  const measured = unrotate(measuredRect(el, state), frames);
  const path = domPath(el, state.body);
  const sink = sinkFor(state, path);
  const authored = claimAuthoredId(el.getAttribute("id"), state.takenIds);
  if (authored && "conflict" in authored) {
    sink("id", `"${authored.conflict}" is already used in this document, so this element was given a minted id`);
  } else if (authored?.renamedFrom) {
    sink("id", `${authored.renamedFrom} → ${authored.id}`);
  }
  const mint = minterFor(authored && "id" in authored ? authored.id : null);

  const resolveAsset: AssetResolver = (url, hint) => {
    const assetId = state.assets.idFor(url, { ...hint, name: nameOf(el) });
    const pageUrl = state.assets.normalize(url);
    return assetId ? { assetId, url: pageUrl } : { reason: state.assets.reason(url), url: pageUrl };
  };
  let missedBackground = false;
  // One lookup per element: the declarations it can read are its own, so a
  // custom property scoped to `.card` resolves for the card and not for the page.
  const tokens = state.tokens?.lookup((property) => state.authored(el, property));
  const style = visualStyleOf(cs, measured, sink, resolveAsset, (url, paint) => {
    // A background's element id is minted further down, so the DOM path is what
    // names it here; the caller inverts `sources` once the walk is complete.
    missedBackground = true;
    state.backgroundMisses.push({ path, url, paint });
  }, tokens);

  /* The box an element CARRIES is the box before its own turn. The DSL draws
     `rotation` about that box's own centre, so handing it the bound of the turn
     instead turns the element twice: an 80×40 element turned 90° measures 40×80,
     and a 40×80 box turned 90° is an 80×40 drawing — the width and the height
     swapped once too often, with the centre (the one thing a turn does not move)
     left as the only thing in the right place. `unrotate` above only strips the
     ANCESTORS' turns, because a frame is known before its children are walked;
     the element's own angle is only known here. */
  const rect = style.rotation !== undefined ? unrotateBox(measured, style.rotation) : measured;

  const childFrames =
    style.rotation !== undefined
      ? [...frames, { cx: rect.x + rect.width / 2, cy: rect.y + rect.height / 2, rad: (style.rotation * Math.PI) / 180 }]
      : frames;

  const parentAbs = rootName ? { x: 0, y: 0 } : parent.abs;
  const box: Rect = rootName
    ? { x: 0, y: 0, width: r2(rect.width), height: r2(rect.height) }
    : {
        x: r2(rect.x - parentAbs.x),
        y: r2(rect.y - parentAbs.y),
        width: r2(rect.width),
        height: r2(rect.height)
      };

  /**
   * Records where the browser had each produced box, keyed by the id it ended up
   * with.
   *
   * Taken from the PRODUCED box rather than the element's rect: a text element is
   * placed at its content box, and comparing the layout pass against the border
   * box would report a padding as a mismatch. `extra` covers the children of a
   * box this walk synthesized, which have no DOM path of their own.
   */
  const record = (built: DesignElement | null, extra: DesignElement[] = []): DesignElement | null => {
    if (!built) return null;
    state.sources.push({ id: built.id, path });
    state.measured.set(built.id, {
      x: r2(parentAbs.x + built.x),
      y: r2(parentAbs.y + built.y),
      width: r2(built.width),
      height: r2(built.height)
    });
    extra.forEach((child, index) => {
      state.sources.push({ id: child.id, path: `${path}~${index}` });
      state.measured.set(child.id, {
        x: r2(parentAbs.x + built.x + child.x),
        y: r2(parentAbs.y + built.y + child.y),
        width: r2(child.width),
        height: r2(child.height)
      });
    });
    return built;
  };

  const link = linkOf(el, sink);
  const tag = el.tagName.toLowerCase();

  // --- elements that are neither a run of text nor a box of boxes ----------
  if (tag === "img") return record(imageElement(el, mint("rect"), box, style, state, sink));
  if (tag === "hr") return record(ruleElement(el, mint("line"), box, style, sink));
  if (tag === "iframe") return record(embedElement(el, mint("html"), box, style, sink));
  if (tag === "svg") {
    const { frame, children } = svgElement(el, mint("frame"), box, rect, style, sink, link);
    return record(frame, children);
  }
  if (tag === "video" || tag === "audio") sink(tag, el.getAttribute("src") ?? "");
  if (tag === "canvas") sink("canvas", "bitmap");
  if (tag === "input" || tag === "textarea" || tag === "select") sink(tag, (el as HTMLInputElement).value ?? "");
  // Each of these draws something the browser composes from state the dialect
  // has no element for — a progress ring, a bar, a plugin surface. Reported so
  // they do not evaporate into a silent empty frame.
  if (tag === "progress" || tag === "meter") sink(tag, String((el as HTMLProgressElement).value ?? ""));
  if (tag === "object" || tag === "embed") sink(tag, el.getAttribute("data") ?? el.getAttribute("src") ?? "");

  if (cs.display === "list-item") {
    const marker = markerOf(el, cs);
    if (marker) sink("list-style", marker);
  }

  const textStyle = textStyleOf(cs, sink, style.textFills, tokens);
  // `normal` is the default on nearly every page and the DSL would substitute
  // its own 1.38× tier for it, so the browser's own answer is written in. Every
  // text box in the import depends on this one number. The author's declaration
  // is read first when there is one, so a unitless ratio stays a ratio.
  const lineHeight = htmlLineHeight(el, cs, state);
  if (lineHeight !== undefined) textStyle.style.lineHeight = lineHeight;
  const runs = collectRuns(el, textStyle.style, state);

  // A text leaf is decided FIRST: when every element child is an inline run, the
  // whole thing is one text element and there are no child boxes to walk.
  if (!runs.hasBlock && runs.text.trim()) {
    const inset = insetOf(cs);
    const padded = inset.x > 0 || inset.y > 0 || inset.right > 0 || inset.bottom > 0;
    const absoluteContent: Rect = {
      x: rect.x + inset.x,
      y: rect.y + inset.y,
      width: Math.max(0, rect.width - inset.x - inset.right),
      height: Math.max(0, rect.height - inset.y - inset.bottom)
    };
    const content = { x: r2(absoluteContent.x - parentAbs.x), y: r2(absoluteContent.y - parentAbs.y), width: r2(absoluteContent.width), height: r2(absoluteContent.height) };

    const ink = textInkRect(el, state);
    const plainLeaf = !padded && !hasPaint(style) && !style.clipContent;
    /* A vertical line is reproduced by turning the text a quarter turn. Without
       a wrapper the element itself carries it; with one, the frame stays the
       page's box and only the text inside turns. `vertical-lr` stacks its later
       lines to the RIGHT, while turned text stacks them left, so more than one
       column is the one case a turn reproduces wrongly — reported instead of
       drawn backwards. */
    const vertical = verticalTextRotation(cs, runs.text);
    const stacksRight =
      cs.writingMode === "vertical-lr" &&
      typeof textStyle.style.lineHeight === "number" &&
      measured.width > textStyle.style.lineHeight * 1.5;
    const turned = vertical !== undefined && !stacksRight;
    if (plainLeaf) {
      if (turned) {
        const box = sidewaysTextBox(measured, style.rotation ?? 0);
        const local: Rect = {
          x: r2(box.x - parentAbs.x),
          y: r2(box.y - parentAbs.y),
          width: r2(box.width),
          height: r2(box.height)
        };
        return record(
          textElement(
            textName(el, runs.text),
            mint("text"),
            local,
            null,
            local,
            { ...style, rotation: box.rotation },
            textStyle,
            runs,
            link
          )
        );
      }
      if (cs.writingMode !== "horizontal-tb") sink("writing-mode", cs.writingMode);
      return record(textElement(textName(el, runs.text), mint("text"), content, ink, absoluteContent, style, textStyle, runs, link));
    }
    // A leaf that pads, paints or clips is a BOX around the text: a text element
    // carries no background and no padding, so flattening a button into one
    // would lose its fill and slide its glyphs to the box edge.
    //
    // The frame's id is taken FIRST because the frame is the box the page wrote
    // the id on; the text inside it is the element this walk synthesized, so it
    // is the one that has to mint.
    const frameId = mint("frame");
    if (turned) {
      // The frame is the page's own (unrotated) box. The text inside is turned
      // about the centre of the frame's CONTENT box, which is the column its
      // glyphs occupied after padding was taken out.
      const innerBox = sidewaysTextBox({ x: inset.x, y: inset.y, width: content.width, height: content.height });
      const inner = textElement(
        textName(el, runs.text),
        mint("text"),
        { x: innerBox.x, y: innerBox.y, width: innerBox.width, height: innerBox.height },
        null,
        innerBox,
        { ...PLAIN_STYLE, rotation: innerBox.rotation },
        textStyle,
        runs,
        undefined
      );
      return record(frameElement(el, frameId, box, style, [inner], undefined, cs, link, null), [inner]);
    }
    if (cs.writingMode !== "horizontal-tb") sink("writing-mode", cs.writingMode);
    const inner = textElement(textName(el, runs.text), mint("text"), { x: inset.x, y: inset.y, width: content.width, height: content.height }, ink, absoluteContent, PLAIN_STYLE, textStyle, runs, undefined);
    return record(frameElement(el, frameId, box, style, [inner], undefined, cs, link, null), [inner]);
  }

  const content = contentSize(rect, cs);
  const decision = layoutFor(cs, sink, content, (property) => state.authored(el, property));
  if (tokens && decision.layout) {
    // Spacing is the one axis the visual pass cannot bind: `gap` and `padding`
    // only exist once the layout pass has decided them, and a container's
    // padding is where a page's spacing token shows up most often.
    const spacing = spacingBindingsOf(tokens, decision.layout, cs, style.border);
    if (spacing) style.tokenBindings = { ...style.tokenBindings, ...spacing };
  }
  const children = collectChildren(el, { abs: { x: rect.x, y: rect.y }, content }, childFrames, state, decision.layout, sink);

  if (children.length === 0) {
    // An empty box with no paint is invisible — UNLESS a container is placing
    // it. A flex child with no fill is still a slot: a spacer, an indent, a
    // divider whose colour lives on a child. Dropping one shortens the row by
    // its width plus the gap, and every sibling after it slides over, which is
    // exactly the drift a layout parent's self-check then has to downgrade.
    //
    // A box whose only paint is a bitmap that did not arrive is kept for the
    // same reason: the picture is coming from a folder the user has yet to pick,
    // and an element that was dropped cannot receive it.
    const painted = hasPaint(style) || missedBackground;
    if (!painted && !link && !inLayout) return null;
    if (!painted && !link && box.width === 0 && box.height === 0) return null;
    return record(rectElement(el, mint("rect"), box, style, link));
  }
  return record(frameElement(el, mint("frame"), box, style, children, decision.layout, cs, link, rootName));
}

/**
 * The list marker a `display: list-item` element draws, or `""` when the page
 * draws none.
 *
 * REPORTED rather than rebuilt, and the reason is measured rather than assumed.
 * A marker has no node, and unlike `::before` its box is not recoverable by
 * materialising a clone: Chrome places a glyph marker (`disc`, `circle`,
 * `square`) and a numeric one (`decimal`, `upper-roman`) by DIFFERENT rules. At
 * 16px with the content edge at x=40, a `disc`'s ink ends 11px short of the edge
 * while `1.` ends 5.75px short; shifting a clone measured at the `inside`
 * position reproduces the numeric case to ±1.3px and misses the glyph case by
 * 6px. A bullet that is 6px off is a WRONG element, not an uneditable one, so
 * the loss is named instead of approximated.
 */
function markerOf(el: Element, cs: CSSStyleDeclaration): string {
  const marker = getComputedStyle(el, "::marker");
  if (marker.content === "none") return "";
  const type = cs.listStyleType;
  if (type && type !== "none") return `${type} ${cs.listStylePosition}`;
  // A marker the page wrote itself (`content: "→"`) is a string, and it still
  // cannot be placed — but naming it says what was lost.
  return marker.content && marker.content !== "normal" ? marker.content : "";
}

/**
 * A sink that names one element's DOM path.
 *
 * Not a closure over the walker's own sink: `collectChildren` has to report a
 * CHILD's gap before it has descended into it, and the parent's sink would name
 * the parent — `body/` instead of `body/13`.
 */
function sinkFor(state: WalkState, path: string): UnmappedSink {
  return (property, value) => {
    state.unmapped.push({ path, property, value: String(value).slice(0, 120) });
  };
}

/**
 * The order the browser PAINTS a parent's children in, when that is not the order
 * they are written.
 *
 * CSS paints the static children in document order and the positioned ones by
 * `z-index`, so a decorative overlay written FIRST with `z-index: 60` is painted
 * last and covers the shell that follows it. The DSL has no `z-index` and the
 * renderer paints in array order, so keeping document order buried the overlay:
 * `a.back` on `brand-gold.html` is a visible "← BRAND COLOUR" button on the page
 * and invisible in the canvas.
 *
 * Declined when it would move the IN-FLOW children relative to each other. The
 * layout pass places those by array position, and a wrong position is worse than
 * a wrong z — so a `position: relative` sibling carrying a z-index still reports
 * the gap rather than being silently shuffled.
 */
type ChildItem =
  | { type: "element"; el: Element; cs: CSSStyleDeclaration; z: number }
  | { type: "text"; nodes: Node[]; runs: Runs };

function collectChildItems(
  parent: Element,
  parentCs: CSSStyleDeclaration,
  textStyle: TextStyle,
  isFlexOrGrid: boolean,
  state: WalkState
): ChildItem[] {
  const items: ChildItem[] = [];
  let currentTextNodes: Node[] = [];

  const flushText = () => {
    if (currentTextNodes.length === 0) return;
    const nodes = currentTextNodes;
    currentTextNodes = [];
    const runs = collectRunsFromNodes(nodes, parentCs, textStyle, state);
    if (runs.text.trim().length > 0) {
      items.push({ type: "text", nodes, runs });
    }
  };

  for (const node of Array.from(parent.childNodes)) {
    if (node.nodeType === 3) {
      currentTextNodes.push(node);
      continue;
    }
    if (node.nodeType !== 1) continue;
    const child = node as Element;
    const tag = child.tagName.toLowerCase();
    if (shouldSkipTag(tag)) continue;
    const ccs = getComputedStyle(child);
    if (ccs.display === "none") continue;

    if (tag === "br" && !isFlexOrGrid) {
      currentTextNodes.push(child);
      continue;
    }

    if (!isFlexOrGrid && inlineMergeable(child, ccs)) {
      currentTextNodes.push(child);
      continue;
    }

    flushText();
    const rawZ = ccs.position === "static" ? 0 : Number(ccs.zIndex);
    items.push({
      type: "element",
      el: child,
      cs: ccs,
      z: Number.isFinite(rawZ) ? rawZ : 0
    });
  }
  flushText();
  return items;
}

function paintOrderOfItems(items: ChildItem[]): {
  items: ChildItem[];
  reordered: boolean;
} {
  if (!items.some((item) => item.type === "element" && item.z !== 0)) {
    return { items, reordered: false };
  }

  const sorted = [...items].sort((a, b) => {
    const za = a.type === "element" ? a.z : 0;
    const zb = b.type === "element" ? b.z : 0;
    return za - zb;
  });

  const inFlow = (list: typeof items) =>
    list.filter(
      (item) =>
        item.type === "text" ||
        (item.cs.position !== "absolute" && item.cs.position !== "fixed" && item.cs.position !== "sticky")
    );

  const before = inFlow(items);
  const after = inFlow(sorted);
  const same =
    before.length === after.length &&
    before.every((item, i) => {
      const other = after[i];
      if (item.type !== other.type) return false;
      return item.type === "element"
        ? item.el === (other as typeof item).el
        : item.nodes === (other as typeof item).nodes;
    });

  if (!same) return { items, reordered: false };
  return { items: sorted, reordered: true };
}

function collectChildren(
  parent: Element,
  parentCtx: ParentContext,
  frames: RotationFrame[],
  state: WalkState,
  layout: AutoLayout | undefined,
  sink: UnmappedSink
): DesignElement[] {
  const out: DesignElement[] = [];
  const parentCs = getComputedStyle(parent);
  const parentTextStyle = textStyleOf(parentCs, sink);
  const parentLineHeight = htmlLineHeight(parent, parentCs, state);
  if (parentLineHeight !== undefined) parentTextStyle.style.lineHeight = parentLineHeight;

  const isFlexOrGrid =
    Boolean(layout) ||
    parentCs.display === "flex" ||
    parentCs.display === "inline-flex" ||
    parentCs.display === "grid" ||
    parentCs.display === "inline-grid";

  const rawItems = collectChildItems(parent, parentCs, parentTextStyle.style, isFlexOrGrid, state);
  const { items, reordered } = paintOrderOfItems(rawItems);

  for (const item of items) {
    if (item.type === "element") {
      const { el: child, cs: ccs, z } = item;
      const tag = child.tagName.toLowerCase();
      if (shouldSkipTag(tag)) continue;
      if (ccs.display === "none") continue;
      if (!reordered && z !== 0) sinkFor(state, domPath(child, state.body))("z-index", ccs.zIndex);

      if (ccs.display === "contents") {
        out.push(...collectChildren(child, parentCtx, frames, state, layout, sink));
        continue;
      }

      const mapped = mapElement(child, parentCtx, frames, state, null, Boolean(layout));
      if (!mapped) continue;

      const outOfFlow = ccs.position === "absolute" || ccs.position === "fixed" || ccs.position === "sticky";
      let built: DesignElement = outOfFlow ? ({ ...mapped, position: "absolute" } as DesignElement) : mapped;

      if (!layout) {
        out.push(built);
        continue;
      }

      const margin = marginOf(ccs, sink);
      if (margin !== undefined) built = { ...built, margin } as DesignElement;
      const childRect = unrotate(measuredRect(child, state), frames);
      const childLayout = childSizingFor(ccs, layout, parentCtx.content, childRect, sink);
      if (childLayout.sizing) built = { ...built, sizing: { ...(built.sizing ?? {}), ...childLayout.sizing } } as DesignElement;
      if (childLayout.alignSelf) built = { ...built, "align-self": toCssLine(childLayout.alignSelf) } as DesignElement;
      if (childLayout.grow !== undefined) built = { ...built, "flex-grow": childLayout.grow } as DesignElement;
      if (childLayout.cell) built = { ...built, "grid-area": childLayout.cell } as DesignElement;
      out.push(built);
    } else {
      const { nodes, runs } = item;
      const range = document.createRange();
      range.setStartBefore(nodes[0]);
      range.setEndAfter(nodes[nodes.length - 1]);
      const measured = rangeRect(range, state);
      if (!measured || (measured.width === 0 && measured.height === 0)) continue;

      const childRect = unrotate(measured, frames);
      const localBox: Rect = {
        x: r2(childRect.x - parentCtx.abs.x),
        y: r2(childRect.y - parentCtx.abs.y),
        width: r2(childRect.width),
        height: r2(childRect.height)
      };
      const textId = createId("text");
      const textEl = textElement(
        clip(runs.text.trim().replace(/\s+/g, " "), 24),
        textId,
        localBox,
        measured,
        measured,
        PLAIN_STYLE,
        parentTextStyle,
        runs,
        undefined
      );

      // Text that is a run inside a parent with block children cannot carry the
      // quarter turn a vertical line needs, so the loss is named here.
      if (parentCs.writingMode !== "horizontal-tb") sink("writing-mode", parentCs.writingMode);

      const parentPath = domPath(parent, state.body);
      state.sources.push({ id: textId, path: `${parentPath}~text-${out.length}` });
      state.measured.set(textId, {
        x: r2(parentCtx.abs.x + localBox.x),
        y: r2(parentCtx.abs.y + localBox.y),
        width: r2(localBox.width),
        height: r2(localBox.height)
      });

      let built: DesignElement = textEl;
      if (layout) {
        const childLayout = childSizingFor(parentCs, layout, parentCtx.content, childRect, sink);
        if (childLayout.sizing) built = { ...built, sizing: { ...(built.sizing ?? {}), ...childLayout.sizing } } as DesignElement;
        if (childLayout.alignSelf) built = { ...built, "align-self": toCssLine(childLayout.alignSelf) } as DesignElement;
        if (childLayout.grow !== undefined) built = { ...built, "flex-grow": childLayout.grow } as DesignElement;
        if (childLayout.cell) built = { ...built, "grid-area": childLayout.cell } as DesignElement;
      }
      out.push(built);
    }
  }
  return out;
}
