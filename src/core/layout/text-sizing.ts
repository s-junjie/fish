import { AutoLayoutFields, DesignElement, LetterSpacing, LineHeight, TextElement, TextStyle } from "../dsl/types";
import { layoutOf } from "../dsl/layout-flat";
import { resolveAxis } from "../geometry/resolve-axis";
import { measureText, TextMeasureSpec } from "../geometry/text-measure";
import { isContainer } from "../geometry/tree-ops";
import { textFontStatus } from "../fonts/font-status";

/**
 * The document's precision, applied to every size this engine measures.
 *
 * Every writer in the codebase rounds geometry to two decimals, so a measurement kept
 * at full float precision and then rounded by someone else is the only way a value ends
 * up different depending on which code path touched it. Whole pixels were the trap
 * here: the Scale tool BAKES its factor into geometry, so scaling a design to a tenth
 * produced boxes of 27.6px, and a `fit-content` frame measured back at 28px by this
 * rounding. Growing it to full size then read 280 off that 28 — a permanent 1.4%
 * stretch on every nested frame, and the frame ended up wider than the parent holding
 * it. A scale a user can undo by scaling back has to survive the round trip through
 * here, so nothing measured may be rounded below the document's own precision.
 */
const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Resolves the DSL `LineHeight` to the px line box the engine measures and paints.
 *
 * The unit lives in the value, so there is nothing to infer:
 * - a bare number is a MULTIPLIER → `fontSize × ratio`
 * - `"24px"` is absolute → `24`
 * - absent → a size-tiered default (1.12× display ≥72px / 1.25× subheading 36–71px
 *   / 1.38× body <36px), which is also what CSS `normal` normalized to.
 *
 * No ratio floor: a tight display leading of `0.9` is a legal `LineHeight` and is
 * honoured as written. The old `Math.max(1.05, ratio)` existed only to keep a
 * small absolute px from being read as a ratio, and that whole guessing game is
 * gone.
 */
export function resolveDynamicLineHeight(fontSize: number, lineHeight?: LineHeight): number {
  if (lineHeight !== undefined) {
    if (typeof lineHeight === "number") return round2(fontSize * lineHeight);
    const px = Number.parseFloat(lineHeight);
    if (Number.isFinite(px) && px > 0) return round2(px);
  }

  if (fontSize >= 72) {
    return round2(fontSize * 1.12);
  } else if (fontSize >= 36) {
    return round2(fontSize * 1.25);
  } else {
    return round2(fontSize * 1.38);
  }
}

/**
 * Resolves the DSL `LetterSpacing` to the px tracking the engine measures and
 * paints. The unit lives in the value (see `LetterSpacing`):
 * - a bare number is PIXELS → kept as written (may be negative)
 * - `"2px"` is absolute → `2`
 * - `"0.05em"` is relative → `fontSize × 0.05`, so it tracks a size change
 * - absent → `0`, CSS's initial tracking
 *
 * `em` resolves against the size the run is actually set in, which is the
 * span's own size when it overrides the element's (see `textSpec`).
 */
export function resolveLetterSpacing(fontSize: number, letterSpacing?: LetterSpacing): number {
  if (letterSpacing === undefined) return 0;
  if (typeof letterSpacing === "number") return letterSpacing;
  const value = Number.parseFloat(letterSpacing);
  if (!Number.isFinite(value)) return 0;
  return letterSpacing.endsWith("em") ? round2(fontSize * value) : value;
}

export function textSpec(style: TextStyle, spans?: TextElement["spans"]): TextMeasureSpec {
  let maxFontSize = style.fontSize;
  if (spans && spans.length > 0) {
    for (const span of spans) {
      if (span.style?.fontSize && span.style.fontSize > maxFontSize) {
        maxFontSize = span.style.fontSize;
      }
    }
  }
  return {
    fontFamily: style.fontFamily,
    fontSize: style.fontSize,
    fontWeight: style.fontWeight ?? "normal",
    // Both are widths, not paints: the italic face has its own advances, and the
    // cased string is what the canvas actually paints. Leaving either out sized
    // the box from characters nobody was looking at.
    fontStyle: style.fontStyle === "italic" ? "italic" : undefined,
    textTransform: style.textTransform && style.textTransform !== "none" ? style.textTransform : undefined,
    lineHeight: resolveDynamicLineHeight(maxFontSize, style.lineHeight),
    letterSpacing: resolveLetterSpacing(style.fontSize, style.letterSpacing),
    // Carried on the spec rather than applied per call site: every layout pass
    // measures through here, and a clamp applied at only some of them would size
    // the same text differently depending on who asked.
    maxLines: style.maxLines,
    spans: spans?.map((s) => ({
      text: s.text,
      style: s.style ? {
        fontFamily: s.style.fontFamily,
        fontSize: s.style.fontSize,
        fontWeight: s.style.fontWeight,
        fontStyle: s.style.fontStyle,
        letterSpacing:
          s.style.letterSpacing !== undefined
            ? resolveLetterSpacing(s.style.fontSize ?? style.fontSize, s.style.letterSpacing)
            : undefined
      } : undefined
    }))
  };
}

/**
 * Turns a text element's `fit-content` / `max-content` axes into real numbers.
 *
 * `availableWidth` is the box the caller lays it out in; `null` means unbounded,
 * which is the case outside a layout parent. Unbounded collapses `fit-content`
 * onto `max-content` — measuring against the element's own current width would
 * make the box shrink-only, since every measurement would clamp to the previous
 * measurement's result.
 *
 * Idempotent: re-resolving an already-sized element returns the same box.
 */
/**
 * Whether the stored box is the only thing keeping this text's layout intact.
 *
 * True only when the text names a family this machine cannot paint AND at least
 * one axis would be re-measured the moment it can. A box the author pinned on
 * both axes never goes through `measureText`, so there is nothing to protect:
 * freezing it would take the caret away and preserve nothing.
 *
 * Canvas editing (`useInlineEditing`) gates all missing fonts; this predicate
 * specifically controls whether layout re-measurement is frozen.
 */
export function textSizingIsFrozen(el: TextElement): boolean {
  // An on-path text is sized by the renderer's glyph measurement, not by a box.
  if (el.onPath?.pathId) return false;
  if (!(el.width > 0 && el.height > 0)) return false;
  if (!textFontStatus(el)) return false;
  return resolveAxis(el, null, "width") !== "fixed" || resolveAxis(el, null, "height") !== "fixed";
}

export function resolveTextSizing(textEl: TextElement, availableWidth: number | null): TextElement {
  // A box the author sized in a font this machine does not have is not ours to
  // re-measure. The substitute's advances are a different design, so measuring
  // would overwrite the layout the file was made in — and only on the machines
  // that cannot show it, which is the worst possible place to lose it. The stored
  // box IS the author's; it thaws when the family arrives, because the answer
  // comes from `textFontStatus` rather than a flag set here.
  if (textSizingIsFrozen(textEl)) return textEl;
  const widthMode = resolveAxis(textEl, null, "width");
  const heightMode = resolveAxis(textEl, null, "height");
  if (widthMode === "fixed" && heightMode === "fixed") return textEl;

  const spec = textSpec(textEl.style, textEl.spans);
  const wrapLimit = availableWidth ?? Infinity;
  let width = textEl.width;
  if (widthMode === "max-content") {
    width = measureText(textEl.content, spec, Infinity).width;
  } else if (widthMode === "fit-content") {
    width = measureText(textEl.content, spec, wrapLimit).width;
  }
  // The spec carries `maxLines`, so the clamp on a line count — and the
  // never-wrap reading of `1` — is already in both of these numbers.
  const height =
    heightMode === "fit-content"
      ? measureText(textEl.content, spec, width).height
      : textEl.height;

  return width === textEl.width && height === textEl.height ? textEl : { ...textEl, width, height };
}

/**
 * The element with its `fit-content` / `max-content` axes filled in. The layout
 * passes cover children of auto-layout frames; this covers everything else (a
 * text sitting directly on the canvas), and the Inspector reads it so a
 * read-only axis never shows a stale number.
 */
export function resolveElementSizing(el: DesignElement): DesignElement {
  return el.type === "text" ? resolveTextSizing(el, null) : el;
}

/**
 * The height `content` occupies inside `el`'s own box. The on-canvas editor sizes
 * its textarea with this instead of the committed `el.height`, so a draft that is
 * longer than what was last committed still renders at the size it will have once
 * committed. Wraps at `el.width`, which is the width the box is painted at.
 */
export function measureTextBlockHeight(el: TextElement, content: string): number {
  // Without the clamp, because this sizes the box the author TYPES in: a live
  // editor that hides the line the caret is on is not the settled paint, and
  // `maxLines` describes the settled paint.
  const { maxLines: _ignored, ...spec } = textSpec(el.style, el.spans);
  return measureText(content, spec, Math.max(1, el.width)).height;
}

/**
 * Bakes the measured size of every `fit-content` text into the tree. Children of
 * an auto-layout container are skipped — `applyAutoLayout` already wrote their
 * resolved box — so this exists for text no layout owns: canvas level, or inside
 * a plain frame. Without it the painted box, the selection bounds and the
 * Inspector all keep showing whatever size the text was created with.
 *
 * Returns the same array when nothing moved, so structural sharing survives.
 */
export function syncTextSizing(elements: DesignElement[]): DesignElement[] {
  return syncTextList(elements, false);
}

function syncTextList(elements: DesignElement[], insideLayout: boolean): DesignElement[] {
  let changed = false;
  const next = elements.map((el) => {
    if (el.type === "text") {
      if (insideLayout) return el;
      const resolved = resolveElementSizing(el);
      if (resolved !== el) changed = true;
      return resolved;
    }
    if (isContainer(el) && el.children?.length) {
      const children = syncTextList(el.children, Boolean(layoutOf(el as AutoLayoutFields)));
      if (children !== el.children) {
        changed = true;
        return { ...el, children };
      }
    }
    return el;
  });
  return changed ? next : elements;
}
