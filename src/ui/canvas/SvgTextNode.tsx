import { TextElement, Paint, PatternPaint } from "../../core/dsl/types";
import { isGradientPaint } from "../../core/geometry/gradient-utils";
import { patternCssBackground } from "../../core/geometry/pattern-tile";
import { cssPaintOrder, topPaint } from "../../core/dsl/paint-stack";
import { measureTextBlockHeight, resolveDynamicLineHeight, resolveLetterSpacing } from "../../core/compile";
import { trailingTrackingShift } from "../../core/geometry/text-measure";
import { textDecorationCss } from "../../core/dsl/text-decoration";
import { resolveStack } from "../../core/font-stack";
import { textFontStatus } from "../../core/fonts/font-status";
import { onPathRunText } from "../../core/geometry/on-path";
import { CANVAS_ON_SELECT } from "./canvas-colors";
import { NodeRenderContext } from "./NodeRenderContext";
import { EditableTextContent } from "./EditableTextContent";
import { renderFills, renderStrokes, resolveSolidPaintBlend } from "./SvgShapeNode";

function reportOnPathTextBounds(node: SVGTextElement | null, el: TextElement, ctx: NodeRenderContext) {
  const report = ctx.onOnPathTextBounds;
  if (!node || !report) return;
  requestAnimationFrame(() => {
    if (!node.isConnected) return;
    let b: DOMRect;
    try {
      b = node.getBBox();
    } catch {
      return;
    }
    const box = { x: b.x, y: b.y, width: b.width, height: b.height };
    if (
      Math.abs(box.x - el.x) > 0.5 ||
      Math.abs(box.y - el.y) > 0.5 ||
      Math.abs(box.width - el.width) > 0.5 ||
      Math.abs(box.height - el.height) > 0.5
    ) {
      report(el.id, box);
    }
  });
}

export interface SvgTextNodeProps {
  el: TextElement;
  isEditingText: boolean;
  activeFills: Paint[];
  activeStrokes: any[];
  fillLayerIndex: (f: Paint, fallback: number) => number;
  strokeLayerIndex: (s: any, fallback: number) => number;
  ctx: NodeRenderContext;
}

const PUA_ONLY_RE = /^[\uE000-\uF8FF\u{F0000}-\u{10FFFF}\s]+$/u;

export function SvgTextNode({
  el,
  isEditingText,
  activeFills,
  activeStrokes,
  fillLayerIndex,
  strokeLayerIndex,
  ctx
}: SvgTextNodeProps) {
  // A node renderer is a function of its props — no hooks: `tests/text-ink.test.ts`
  // and the export rig call it directly, and that is the constraint `NodeRenderContext`
  // states for every chrome affordance. So the mark is DERIVED here, from the one
  // resolver, and it is the row that subscribes (`useFontStatusUpdates`): the layer
  // row is the mark an author acts on, this attribute is the one a spec reads.
  //
  // Nothing caches this, so a family that arrives later (the picker's grant) is
  // reflected the next time this node paints — and the glyphs need no help at all,
  // because `resolveStack` already put the real family FIRST in the CSS stack.
  //
  // No badge is drawn. The substitute face is visible as itself, and a tag per
  // layer would annotate the artwork the tool exists to show.
  const fontProblem = textFontStatus(el);
  const missingFont = fontProblem?.status === "missing" ? fontProblem.family : null;
  // Text paints one colour, so the top-most layer wins — index 0 is the
  // bottom of the stack, not the layer the eye sees. `activeFills` is already
  // empty when the author turned the fill off, and a text with no layer at all
  // has NO INK: `style.color` is the field an author writes text colour in, not
  // a second paint store, and reading it here is what put black glyphs back on a
  // text whose fill stack said `[]` (LESSONS_LEARNED §206). The normalizer has
  // already folded an authored `style.color` into a layer when the element had
  // no stack, so nothing that was ever visible stops being visible.
  const topFill = topPaint(activeFills);
  const resolvedTopFill = topFill ? resolveSolidPaintBlend(topFill, activeFills, false, false) : null;
  const isGradientText = Boolean(topFill && isGradientPaint(topFill));
  const isPatternText = Boolean(topFill && topFill.type === "pattern");
  const textFill: string | undefined =
    topFill && topFill.type === "solid"
      ? resolvedTopFill?.fillVal ?? topFill.color
      : topFill && isGradientPaint(topFill)
        ? `url(#grad_fill_${el.id}_${fillLayerIndex(topFill, 0)})`
        : topFill && topFill.type === "pattern"
          ? `url(#pat_${el.id}_${fillLayerIndex(topFill, 0)})`
          : undefined;
  // The foreignObject path paints with CSS, where a `url(#…)` is not a colour:
  // the tile arrives as a background and the glyphs clip it.
  const patternBackground = isPatternText && topFill
    ? patternCssBackground(topFill as PatternPaint, { width: el.width, height: el.height })
    : undefined;
  const textFillOpacity = resolvedTopFill ? resolvedTopFill.opacity : 1;
  // A caret is an AFFORDANCE, not paint: a text with no ink still has to show
  // where the cursor is, so this one falls back the way the glyphs no longer do.
  const caretColor = (isPatternText ? undefined : textFill) ?? el.style?.color ?? CANVAS_ON_SELECT;
  const primaryStroke = activeStrokes[activeStrokes.length - 1];
  const textStrokeColor = primaryStroke
    ? primaryStroke.paint && isGradientPaint(primaryStroke.paint)
      ? `url(#grad_stroke_${el.id}_${strokeLayerIndex(primaryStroke, 0)})`
      : primaryStroke.paint?.type === "pattern"
        ? `url(#pat_stroke_${el.id}_${strokeLayerIndex(primaryStroke, 0)})`
        : primaryStroke.color || CANVAS_ON_SELECT
    : undefined;
  // `-webkit-text-stroke` takes a colour, not a paint server, so the editable
  // overlay falls back to the stroke's own colour for the paint kinds the canvas
  // paints through a `url(#…)`.
  const textStrokeCssColor =
    primaryStroke?.paint && (isGradientPaint(primaryStroke.paint) || primaryStroke.paint.type === "pattern")
      ? primaryStroke.color || CANVAS_ON_SELECT
      : textStrokeColor;
  const textStrokeWidth = primaryStroke?.width;

  // A text casts its shadow with its glyphs, so a drop shadow here is a CSS
  // `text-shadow` and never an SVG filter (`effect-filter-def` skips it too).
  const textShadowEffects = cssPaintOrder(
    (el.effects || []).filter((ef) => ef.enabled !== false && ef.type === "drop-shadow")
  );
  let computedTextShadow = el.style?.textShadow;
  if (textShadowEffects.length > 0) {
    computedTextShadow = textShadowEffects
      .map((ef: any) => `${ef.offset?.x || 0}px ${ef.offset?.y || 0}px ${ef.blur || 0}px ${ef.color || "#000000"}`)
      .join(", ");
  }

  const fontSize = el.style?.fontSize || 24;
  let maxFontSize = fontSize;
  if (el.spans && el.spans.length > 0) {
    for (const s of el.spans) {
      if (s.style?.fontSize && s.style.fontSize > maxFontSize) {
        maxFontSize = s.style.fontSize;
      }
    }
  }
  const maxLines = el.style?.maxLines;
  const clampEllipsis = el.style?.textOverflow === "ellipsis";
  let textClamp: any = undefined;
  if (maxLines && maxLines > 0) {
    const textOverflow = clampEllipsis ? "ellipsis" : "clip";
    textClamp =
      maxLines === 1
        ? { whiteSpace: "nowrap", overflow: "hidden", textOverflow }
        : { display: "-webkit-box", WebkitBoxOrient: "vertical", WebkitLineClamp: maxLines, overflow: "hidden", textOverflow };
  }

  const decoration =
    el.spans && el.spans.length > 0 ? undefined : textDecorationCss(el.style?.textDecoration);

  const st = el.style;
  const letterSpacing = resolveLetterSpacing(fontSize, st?.letterSpacing);
  const typography: any = {
    fontFamily: resolveStack(st?.fontFamily),
    fontSize: `${fontSize}px`,
    fontWeight: st?.fontWeight || 400,
    lineHeight: `${resolveDynamicLineHeight(maxFontSize, st?.lineHeight)}px`,
    letterSpacing: st?.letterSpacing !== undefined ? `${letterSpacing}px` : "normal",
    textAlign: st?.align || "left",
    whiteSpace: "pre-line",
    wordBreak: "normal",
    overflowWrap: "normal",
    textShadow: computedTextShadow || undefined
  };
  if (st?.textTransform && st.textTransform !== "none") typography.textTransform = st.textTransform;
  if (decoration) typography.textDecoration = decoration;
  if (st?.fontStyle && st.fontStyle !== "normal") typography.fontStyle = st.fontStyle;
  if (st?.fontVariantNumeric && st.fontVariantNumeric !== "normal") typography.fontVariantNumeric = st.fontVariantNumeric;
  const verticalAlign =
    el.style?.verticalAlign === "bottom"
      ? "flex-end"
      : el.style?.verticalAlign === "middle"
        ? "center"
        : "flex-start";

  /**
   * Where the draft's first line goes while the editor is open.
   *
   * A draft that ends in a newline paints one line more than the box measures:
   * the caret needs a line of its own, and a trailing newline hangs in the
   * settled string. Centring or bottom-aligning by that painted height therefore
   * lifts every visible line by up to a line — the text slides out of its own
   * box as the author deletes back to a line break. Align by the draft's own
   * height instead and let the caret line hang below the box, so the glyphs stay
   * where the committed paint will put them.
   */
  const editingOffset = (() => {
    if (!isEditingText || verticalAlign === "flex-start") return 0;
    const draftHeight = measureTextBlockHeight(el, ctx.canvasTextDraft || "");
    return Math.max(0, verticalAlign === "center" ? (el.height - draftHeight) / 2 : el.height - draftHeight);
  })();

  // The browser reserves one trailing `letter-spacing` in the line box while the
  // ink stops short of it, so the alignment lands half a tracking (centred) or a
  // whole one (right) to the left of the box it was measured into. A translate is
  // the whole fix: layout, wrap and the box are untouched, only the painted line
  // moves — see `trailingTrackingShift`, where the numbers are measured.
  const alignShift = trailingTrackingShift(el.style?.align, letterSpacing);

  // Selecting and editing a text are decided together with every other
  // targeting rule in `element-click.ts` (the press that drills in must not be
  // the press that opens the editor). This only keeps the event off the canvas.
  const handleDblClick = (e: MouseEvent) => {
    e.stopPropagation();
  };

  // When a Figma TEXT node holds an SF Symbol or private-use glyph whose
  // `characters` were stripped to "" (or remain PUA codepoints that no web font
  // covers) while `fillGeometry` (`el.outline`) carries the measured glyph
  // outline, paint the vector outline directly so the symbol is not lost.
  if (
    !isEditingText &&
    !el.onPath?.pathId &&
    el.outline?.d &&
    (!el.content || !el.content.trim() || PUA_ONLY_RE.test(el.content))
  ) {
    return (
      <g
        transform={`translate(${el.x}, ${el.y})`}
        onMouseDown={(e) => ctx.onElementMouseDown(e, el)}
        onDblClick={handleDblClick}
      >
        {renderFills(
          el,
          activeFills,
          el.outline.d,
          el.outline.fillRule,
          fillLayerIndex,
          () => undefined,
          false
        )}
        {renderStrokes(el, activeStrokes, el.outline.d, strokeLayerIndex)}
      </g>
    );
  }

  return el.onPath?.pathId ? (
    <>
      <text
        ref={(node: SVGTextElement | null) => reportOnPathTextBounds(node, el, ctx)}
        data-font-missing={missingFont || undefined}
        fill={textFill ?? "none"}
        fillOpacity={textFillOpacity < 1 ? textFillOpacity : undefined}
        stroke={textStrokeColor}
        strokeWidth={textStrokeWidth}
        fontSize={el.style?.fontSize || 24}
        fontFamily={resolveStack(el.style?.fontFamily)}
        fontWeight={el.style?.fontWeight || 400}
        fontStyle={el.style?.fontStyle === "italic" ? "italic" : undefined}
        letterSpacing={el.style?.letterSpacing !== undefined ? `${letterSpacing}px` : "normal"}
        style={{
          textShadow: computedTextShadow || undefined,
          ...(el.style?.textTransform && el.style.textTransform !== "none"
            ? { textTransform: el.style.textTransform }
            : {})
        }}
        onMouseDown={(e) => ctx.onElementMouseDown(e, el)}
        onDblClick={handleDblClick}
      >
        <textPath
          href={`#guide_path_${el.id}`}
          startOffset={`${el.onPath?.startOffset || 0}%`}
          textAnchor={el.onPath?.startOffset === 100 ? "end" : "start"}
        >
          {onPathRunText(el, ctx.onPathGuides?.get(el.id) ?? null)}
        </textPath>
      </text>
      {isEditingText && (
        <foreignObject
          x={el.x}
          y={el.y}
          width={Math.max(1, el.width)}
          height={Math.max(1, el.height)}
          style={{ overflow: "visible" }}
        >
          <textarea
            ref={ctx.canvasTextInputRef}
            name="canvas-text"
            value={ctx.canvasTextDraft}
            // A composition is mid-edit: every intermediate string an IME
            // produces would otherwise be written to the model and re-measured,
            // and the candidate window then fights the render it caused. The
            // block editor already holds off until `compositionend`; this is the
            // same rule, and it used to be the one path that did not have it.
            onInput={(e) => {
              if ((e as any).isComposing) return;
              ctx.setCanvasTextDraft((e.target as HTMLTextAreaElement).value);
            }}
            onCompositionEnd={(e) => {
              ctx.setCanvasTextDraft((e.target as HTMLTextAreaElement).value);
            }}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
            onDblClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if ((e as any).nativeEvent?.isComposing || (e as any).isComposing || e.keyCode === 229) return;
              // `Enter` commits here rather than opening a line: a `textPath` has
              // no second line to open, and a newline folded into the content
              // would paint as a space. Cmd/Ctrl+Enter is accepted as well so the
              // commit key is the same one the block editor uses.
              if (e.key === "Enter") {
                if (e.shiftKey && !e.metaKey && !e.ctrlKey) return;
                e.preventDefault();
                ctx.onCommitCanvasText();
              } else if (e.key === "Escape") {
                e.preventDefault();
                ctx.onCancelCanvasText();
              }
            }}
            onBlur={ctx.onCommitCanvasText}
            style={{
              ...typography,
              color: "transparent",
              caretColor,
              background: "transparent",
              border: "none",
              outline: "none",
              resize: "none",
              position: "absolute",
              left: 0,
              top: 0,
              width: "100%",
              height: "100%",
              padding: 0,
              margin: 0,
              whiteSpace: "pre"
            }}
          />
        </foreignObject>
      )}
    </>
  ) : (
    // WebKit drops every ancestor `transform` for a `foreignObject`'s HTML
    // content the moment ONE descendant establishes a containing block or a
    // paint layer — `position: relative`, a CSS `transform`, `will-change`,
    // `isolation` and `contain` all do it. Measured: the text then paints at the
    // SVG origin instead of inside its frame, a page-wide mislayout in Safari
    // while Chromium looks right. So this wrapper carries no positioning and no
    // CSS transform, and the tracking nudge is a margin: it moves the line
    // without shrinking the width the browser wraps into.
    <foreignObject
      x={el.x}
      y={el.y}
      width={Math.max(1, el.width)}
      height={Math.max(1, el.height)}
      style={{
        overflow: "visible",
        ...(textFillOpacity < 1 ? { opacity: textFillOpacity } : {})
      }}
      data-text-fill={textFill ?? "none"}
      data-text-opacity={textFillOpacity < 1 ? textFillOpacity : undefined}
      data-text-stroke={textStrokeColor}
      data-text-stroke-width={textStrokeWidth}
      data-text-shadow={computedTextShadow || undefined}
      data-font-missing={missingFont || undefined}
      onMouseDown={(e) => ctx.onElementMouseDown(e, el)}
      onDblClick={handleDblClick}
    >
      <div
        style={{
          ...typography,
          display: "flex",
          flexDirection: "column",
          justifyContent: isEditingText ? "flex-start" : verticalAlign,
          paddingTop: editingOffset ? `${editingOffset}px` : undefined,
          marginLeft: alignShift ? `${alignShift}px` : undefined,
          width: "100%",
          height: "100%"
        }}
      >
        <EditableTextContent
          el={el}
          isEditingText={isEditingText}
          ctx={ctx}
          typography={typography}
          textClamp={textClamp}
          maxFontSize={maxFontSize}
          isGradientText={isGradientText}
          topFill={topFill ?? null}
          patternBackground={patternBackground}
          textFill={textFill ?? "transparent"}
          caretColor={caretColor}
            primaryStroke={Boolean(primaryStroke)}
            textStrokeWidth={textStrokeWidth}
            textStrokeColor={textStrokeCssColor}
            noSoftWrap={el.sizing?.width === "max-content"}
          />
      </div>
    </foreignObject>
  );
}
