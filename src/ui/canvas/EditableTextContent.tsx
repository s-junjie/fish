import { useEffect, useRef, useLayoutEffect } from "preact/hooks";
import { TextElement, Paint } from "../../core/dsl/types";
import { buildCssGradient } from "../../core/geometry/gradient-utils";
import { resolveDynamicLineHeight, resolveLetterSpacing } from "../../core/compile";
import { textDecorationCss, effectiveDecoration } from "../../core/dsl/text-decoration";
import { resolveStack } from "../../core/font-stack";
import type { TextEditRange } from "../../core/interactions/text-spans";
import {
  getEditableText,
  getInputTargetOffsets,
  getTextSelectionOffsets,
  setTextSelectionOffsets,
  TRAILING_SENTINEL
} from "./text-dom-selection";
import { NodeRenderContext } from "./NodeRenderContext";

export interface EditableTextContentProps {
  el: TextElement;
  isEditingText: boolean;
  ctx: NodeRenderContext;
  typography: any;
  /** Line-count clamp, or undefined when the box shows everything. */
  textClamp?: Record<string, unknown>;
  maxFontSize: number;
  isGradientText: boolean;
  topFill: Paint | null;
  /** A pattern layer's CSS form, already sized and positioned for this box. */
  patternBackground?: string;
  /** What the glyphs are painted with. `transparent` when the text has no ink. */
  textFill: string;
  /** The editing caret's colour, which must stay visible on an ink-less text. */
  caretColor: string;
  primaryStroke: boolean;
  textStrokeWidth: number;
  textStrokeColor: string;
  /**
   * Set by a `max-content` text, whose box was measured to hold its longest
   * line unwrapped. Declared HERE, on the element that holds the characters:
   * `white-space` is a shorthand for `text-wrap-mode`, so the `pre-line` this
   * component already writes would reset an inherited `nowrap` — which is
   * exactly how the first attempt at this fix did nothing.
   */
  noSoftWrap?: boolean;
}

/**
 * The input types whose replacement range `getTargetRanges` describes in the
 * coordinates of the text BEFORE the edit. Anything else — a spellcheck rewrite,
 * an undo, a format command — either has no range or a range that means
 * something else, and the derived edit answers better than a mis-read one.
 */
const SPLICE_INPUT_TYPES = /^(insert|delete)/;

/**
 * The run keys a `TextSpan` can carry, in a FIXED order.
 *
 * `JSON.stringify(style)` would depend on the order the keys were inserted in,
 * and a run rebuilt by the reconciler can insert them in a different one — an
 * unstable signature means an unstable key, which is the whole thing being
 * fixed here.
 */
const SPAN_KEY_KEYS = [
  "fontFamily",
  "fontSize",
  "fontWeight",
  "fontStyle",
  "letterSpacing",
  "color",
  "textDecoration"
] as const;

export function EditableTextContent({
  el,
  isEditingText,
  ctx,
  typography,
  textClamp,
  maxFontSize,
  isGradientText,
  topFill,
  patternBackground,
  textFill,
  caretColor,
  primaryStroke,
  textStrokeWidth,
  textStrokeColor,
  noSoftWrap
}: EditableTextContentProps) {
  const savedSelectionRef = useRef<{ start: number; end: number } | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const isComposingRef = useRef(false);
  const isEditingRef = useRef(isEditingText);
  isEditingRef.current = isEditingText;

  /**
   * What the NEXT `input` event replaced, taken from the `beforeinput` that
   * precedes it. Consumed by the first `input` after it and by nothing else, so a
   * stale range can never be attached to a later keystroke.
   */
  const pendingEditRef = useRef<TextEditRange | null>(null);

  useLayoutEffect(() => {
    const node = rootRef.current;
    const s = savedSelectionRef.current;
    if (!isEditingText || !node || !s) return;
    // Only move the caret when the render actually displaced it. The re-render
    // rebuilds the runs, so the browser can lose the position — but when it did
    // not (the ordinary keystroke, where the caret never left the text node) a
    // forced `removeAllRanges` + `addRange` is churn that fights the IME for no
    // gain.
    const current = getTextSelectionOffsets(node);
    if (current && current.start === s.start && current.end === s.end) return;
    setTextSelectionOffsets(node, s.start, s.end);
  });

  /**
   * Drop the `<br>` contentEditable inserts for a caret on an empty last line.
   *
   * The model's line breaks live in the text nodes (Enter, paste and drop are
   * all intercepted), so these elements are never content — but Preact did not
   * put them there and will not remove them, and each one painted a line the box
   * never measured. Left alone they outlive the edit, so the settled text is
   * shifted by phantom blank lines it does not have.
   */
  useLayoutEffect(() => {
    const node = rootRef.current;
    if (!node) return;
    for (const br of Array.from(node.querySelectorAll("br"))) br.remove();
  });

  /**
   * `beforeinput` is attached by hand rather than through an `onBeforeInput` prop:
   * the registered type is exactly `beforeinput`, and a framework's generic
   * `onX` → `addEventListener(x)` mapping is not guaranteed to spell it that way.
   */
  useEffect(() => {
    const node = rootRef.current;
    if (!node) return;
    const onBeforeInput = (e: InputEvent) => {
      pendingEditRef.current = null;
      if (!isEditingRef.current) return;
      // A composition is editing a string that is not in the model yet; its
      // target ranges describe the composing region, not a splice of the text the
      // reconciler is holding.
      if (isComposingRef.current || e.isComposing) return;
      if (!SPLICE_INPUT_TYPES.test(e.inputType || "")) return;
      pendingEditRef.current = getInputTargetOffsets(node, e.getTargetRanges?.() ?? null);
    };
    node.addEventListener("beforeinput", onBeforeInput as EventListener);
    return () => node.removeEventListener("beforeinput", onBeforeInput as EventListener);
  }, []);

  const saveSel = (sel: { start: number; end: number }) => {
    savedSelectionRef.current = sel;
    ctx.onTextSelect?.(sel);
  };

  // A range is an editing concept: only the open editor has one. Reported from
  // the settled paint it is a range nobody asked for — the browser's own word
  // selection from a double click on the canvas — and the inspector takes it for
  // a live run, so the next panel write splits the text into spans instead of
  // writing the element.
  const handleSelection = (target: HTMLElement) => {
    if (!isEditingText) return;
    const sel = getTextSelectionOffsets(target);
    if (sel) saveSel(sel);
  };

  /**
   * The draft a DOM string stands for.
   *
   * A trailing newline has no caret of its own — there is no character after it
   * to hold one — so the editor appends a zero-width space to give it one. Only
   * the one THIS component appended is taken back off; the old code stripped
   * every `\u200b` in the string, which is a character the author may have typed.
   */
  const draftOf = (raw: string): string => {
    const text = raw.replace(/\r\n/g, "\n");
    return text.endsWith(TRAILING_SENTINEL) ? text.slice(0, -1) : text;
  };

  const handleInput = (target: HTMLElement) => {
    handleSelection(target);
    const edit = pendingEditRef.current;
    pendingEditRef.current = null;
    ctx.setCanvasTextDraft(draftOf(getEditableText(target)), edit ?? undefined);
  };

  /**
   * Replaces the current selection from the MODEL side.
   *
   * The splice is known here — the offsets are read before anything moves — so it
   * goes to the reconciler instead of being re-derived from the two strings, and
   * the caret is put after what was inserted.
   */
  const insertText = (inserted: string) => {
    const node = rootRef.current;
    const sel = node ? getTextSelectionOffsets(node) : null;
    const cur = ctx.canvasTextDraft ?? el.content ?? "";
    const s = sel?.start ?? cur.length;
    const e = sel?.end ?? cur.length;
    saveSel({ start: s + inserted.length, end: s + inserted.length });
    ctx.setCanvasTextDraft(cur.slice(0, s) + inserted + cur.slice(e), { start: s, end: e });
  };

  const stopIfEditing = (e: MouseEvent) => isEditingText && e.stopPropagation();

  /**
   * A run's React key: its STYLE, plus which occurrence of that style it is.
   *
   * The index was the key, and an index is not an identity — inserting a run at
   * the front renumbers every later run, so React tore down and rebuilt the DOM
   * nodes of runs whose style never changed. The browser's caret lives in one of
   * those nodes, and a rebuilt node is a caret with nowhere to be. Two neighbours
   * with the same style still have to be told apart, which is what the occurrence
   * count is for.
   */
  const runKeySeen = new Map<string, number>();
  const runKey = (style: Record<string, unknown> | undefined): string => {
    const sig = SPAN_KEY_KEYS.map((k) => `${k}=${JSON.stringify((style as any)?.[k] ?? null)}`).join(",");
    const n = runKeySeen.get(sig) ?? 0;
    runKeySeen.set(sig, n + 1);
    return `${sig}#${n}`;
  };

  /** The sentinel, but only where it is needed: after a trailing newline. */
  const needsSentinel = Boolean(isEditingText && (ctx.canvasTextDraft || "").endsWith("\n"));
  const withTrailingSentinel = (text: string): string =>
    needsSentinel ? text + TRAILING_SENTINEL : text;

  return (
    <div
      ref={(node) => {
        rootRef.current = node;
        if (isEditingText) (ctx.canvasTextInputRef as any).current = node;
      }}
      contentEditable={isEditingText}
      tabIndex={isEditingText ? 0 : undefined}
      onCompositionStart={() => { isComposingRef.current = true; }}
      onCompositionEnd={(e) => { isComposingRef.current = false; handleInput(e.currentTarget); }}
      onInput={(e) => { if (!isComposingRef.current && !(e as any).isComposing) handleInput(e.currentTarget); }}
      onMouseUp={(e) => handleSelection(e.currentTarget)}
      onKeyUp={(e) => handleSelection(e.currentTarget)}
      onKeyDown={(e) => {
        if (isComposingRef.current || (e as any).isComposing) return;
        if (e.key === "Enter" || e.code === "Enter") {
          e.preventDefault();
          if (e.metaKey || e.ctrlKey) ctx.onCommitCanvasText();
          else insertText("\n");
        } else if (e.key === "Backspace") {
          // The trailing sentinel is a caret HOST, not a character: with the
          // caret on the empty line a trailing newline made, the browser's own
          // Backspace would delete the sentinel first, changing nothing in the
          // model and needing a second press for the break. Delete the break.
          const node = rootRef.current;
          const sel = node ? getTextSelectionOffsets(node) : null;
          const cur = ctx.canvasTextDraft || "";
          if (sel && sel.start === sel.end && sel.start === cur.length && cur.endsWith("\n")) {
            e.preventDefault();
            saveSel({ start: cur.length - 1, end: cur.length - 1 });
            ctx.setCanvasTextDraft(cur.slice(0, -1), { start: cur.length - 1, end: cur.length });
          }
        } else if (e.key === "Escape") {
          e.preventDefault();
          ctx.onCancelCanvasText();
        }
      }}
      onPaste={(e) => {
        e.preventDefault();
        insertText(e.clipboardData?.getData("text/plain") || "");
      }}
      // A drop is the contentEditable's own gesture and it inserts the browser's
      // markup — spans and divs React does not know about, which the next render
      // cannot reconcile and `innerText` silently folds back into the draft. The
      // plain text it carried is the whole of what a text layer can hold, so it
      // goes in through the one door every other insertion uses.
      onDragOver={(e) => { if (isEditingText) e.preventDefault(); }}
      onDrop={(e) => {
        if (!isEditingText) return;
        e.preventDefault();
        e.stopPropagation();
        insertText(e.dataTransfer?.getData("text/plain") || "");
      }}
      onBlur={ctx.onCommitCanvasText}
      onMouseDown={stopIfEditing}
      onDblClick={stopIfEditing}
      style={{
        ...typography,
        // After `typography`, because `white-space` there is a shorthand for
        // `text-wrap-mode` and would put the wrap back. A string with no
        // authored break needs none of `pre-line`, so `nowrap` states both
        // halves at once on every engine; one that has breaks keeps them and
        // only lifts the soft wrap.
        ...(noSoftWrap
          ? String(el.content ?? "").includes("\n")
            ? { textWrap: "nowrap" as const }
            : { whiteSpace: "nowrap" as const }
          : {}),
        lineHeight: `${resolveDynamicLineHeight(maxFontSize, el.style?.lineHeight)}px`,
        ...(patternBackground || (isGradientText && topFill)
          ? {
            background: patternBackground ?? buildCssGradient(topFill!),
            WebkitBackgroundClip: "text",
            backgroundClip: "text",
            WebkitTextFillColor: "transparent",
            color: "transparent"
          }
          : {
            color: textFill,
            caretColor
          }),
        width: "100%",
        outline: "none",
        cursor: isEditingText ? "text" : "default",
        // Selectable only while it is being edited. A settled text left
        // `user-select: text` painted its own highlight after every double click
        // on the canvas and kept it there — nothing clears a browser selection
        // the app never made.
        userSelect: isEditingText ? "text" : "none",
        WebkitTextStroke: primaryStroke ? `${textStrokeWidth}px ${textStrokeColor}` : undefined,
        // A clamp is for the settled paint only: while the node is editable the
        // author has to see the text they are typing, and a hidden overflow would
        // swallow the caret the moment it passed the limit.
        ...(isEditingText ? {} : (textClamp ?? {}))
      }}
    >
      {el.spans && el.spans.length > 0 ? (
        el.spans.map((span, sIdx) => {
          const spanStyle = span.style || {};
          const spanColor = spanStyle.color ? spanStyle.color : undefined;
          const last = sIdx === el.spans!.length - 1;
          return (
            <span
              key={runKey(spanStyle)}
              style={{
                fontFamily: spanStyle.fontFamily ? resolveStack(spanStyle.fontFamily) : undefined,
                fontSize: spanStyle.fontSize ? `${spanStyle.fontSize}px` : undefined,
                fontWeight: spanStyle.fontWeight,
                // `font-style` was missing here while the type, the normalizer and
                // the SVG export all carried it — so a run marked italic in the
                // document painted upright on canvas and italic in the export.
                fontStyle: spanStyle.fontStyle,
                // `0` is a value on a run — "no tracking here" against a spaced
                // paragraph — so the absence test is `!== undefined`, not falsy.
                // `em` resolves against the run's own size, which is the element's
                // when the run set none.
                letterSpacing:
                  spanStyle.letterSpacing !== undefined
                    ? `${resolveLetterSpacing(spanStyle.fontSize ?? (el.style?.fontSize || 24), spanStyle.letterSpacing)}px`
                    : undefined,
                color: spanColor,
                // Each run draws its OWN line, which is the element's unless the
                // run said something — `[]` included, and that is the point: a run
                // with no lines must not inherit the paragraph's, and it cannot
                // un-inherit it from inside (an inner `text-decoration: none`
                // leaves an ancestor's underline painted; measured, 263 of 276 px
                // still dark). So the element's line is kept off the container
                // whenever there are runs, in `typography` below.
                textDecoration: textDecorationCss(effectiveDecoration(spanStyle.textDecoration, el.style?.textDecoration))
              }}
            >
              {/* The sentinel lives on the run the text ENDS in, or a run-bearing
                  text would be the one text that cannot put a caret on its own
                  last, empty line. */}
              {last && needsSentinel ? withTrailingSentinel(span.text) : span.text}
            </span>
          );
        })
      ) : isEditingText ? (
        withTrailingSentinel(ctx.canvasTextDraft)
      ) : (
        el.content
      )}
    </div>
  );
}
