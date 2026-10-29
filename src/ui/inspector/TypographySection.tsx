import { useState } from "preact/hooks";
import { TextElement, DesignElement, DesignDocument, TextStyleDefinition, TextStyle, TextDecorationLine } from "../../core/dsl/types";
import { LineHeightField } from "./LineHeightField";
import { LetterSpacingField } from "./LetterSpacingField";
import { ScrubInput } from "../ScrubInput";
import { SegmentedControl, ToggleGroup } from "../SegmentedControl";
import { Select } from "../Select";
import { FontFamilyPicker } from "./FontFamilyPicker";
import { NumeralsMark } from "./NumeralsMark";
import { t } from "../../i18n";
import { AlignLeft, AlignCenter, AlignRight, AlignVerticalJustifyStart, AlignVerticalJustifyCenter, AlignVerticalJustifyEnd, Italic, Underline, Strikethrough, Minus, ArrowDownFromLine, Unlink } from "lucide-react";
import { Button } from "../Button";
import { StylePill } from "./StylePill";
import { DEFAULT_FONT_FAMILY } from "../../core/font-stack";
import { renderStylePreview } from "./StylePreview";
import { addTokenToDoc, bindTextStyle, unbindTextStyle } from "../../core/interactions/style-ops";
import {
  bindNumberTokenToElement,
  findNumberToken,
  unbindNumberTokenFromElement
} from "../../core/interactions/number-token-ops";
import { NumberTokenPicker } from "./NumberTokenPicker";
import { applySpanStyleToRange, spanRangeHasDecoration, spanRangeIsItalic, spanStyleAt, toggleSpanDecoration } from "../../core/interactions/text-spans";
import type { ActiveTextRange } from "../hooks/useInlineEditing";
import { DECORATION_LINES, hasDecoration, toggledDecoration } from "../../core/dsl/text-decoration";
import { useStyleBindAction } from "../hooks/useStyleBindAction";
import { Section } from "./SectionHeader";
import { TEXT_FIELD_CLASS } from "../ScrubInput";
import { SUB_LABEL_CLASS } from "../label-tier";
import { MIXED_LABEL, resolveAcross } from "./mixed";
import { ROW_SPREAD_CLASS, ROW_SPREAD_GAP_CLASS } from "../row-style";

interface TypographySectionProps {
  textElement: TextElement;
  /** A live run selection, bound to the text it was made in. */
  activeSelection?: ActiveTextRange | null;
  docRef: { current: DesignDocument };
  /** The whole selection: every field below is resolved across all of it. */
  elements: DesignElement[];
  /** Narrowed to the text variant on the way in: the section only renders for one. */
  onMutate: (updater: (el: DesignElement) => DesignElement, commitImmediately?: boolean) => void;
  onCommitSnapshot: (newDoc: DesignDocument) => void;
  onDragStart: () => void;
  onDragEnd: () => void;
}

export function TypographySection({
  textElement,
  elements,
  activeSelection,
  docRef,
  onMutate,
  onCommitSnapshot,
  onDragStart,
  onDragEnd
}: TypographySectionProps) {
  const [tokenPicker, setTokenPicker] = useState<{
    prop: "fontSize" | "lineHeight" | "letterSpacing";
    anchor: HTMLElement;
  } | null>(null);

  const boundStyle = (docRef.current.styles || []).find(
    (s) => s.id === textElement?.textStyleId && s.styleType === "text"
  ) as TextStyleDefinition | undefined;

  const styleBind = useStyleBindAction<TextStyleDefinition>({
    styleType: "text",
    boundStyle,
    docRef,
    currentSelection: {
      type: "text",
      elementId: textElement?.id,
      textStyle: {
        ...(textElement.style || {
          fontFamily: DEFAULT_FONT_FAMILY,
          fontSize: 16,
          fontWeight: 400,
          color: "#000000"
        }),
        ...(textElement.tokenBindings ? { tokenBindings: textElement.tokenBindings } : {})
      }
    },
    bind: (el, style) => bindTextStyle(el as TextElement, style) as DesignElement,
    unbind: (el, bound) => unbindTextStyle(el as TextElement, bound) as DesignElement,
    onMutate,
    onCommitSnapshot,
    triggerProps: { "data-text-style-trigger": "1" }
  });

  const textStyle = textElement.style || {};
  let currentFont = textStyle.fontFamily || DEFAULT_FONT_FAMILY;
  let currentWeight = textStyle.fontWeight || 400;
  let currentSize = textStyle.fontSize || 24;
  let currentLetterSpacing = textStyle.letterSpacing || 0;

  const hasRangeSelection = Boolean(
    activeSelection &&
    // The id is the whole guard: a range is only ever a range of ONE text, and
    // the panel is showing this one. Without it, a range the author made in
    // another text — which now outlives its editor on purpose — would be read
    // here as a live selection for a text it has nothing to do with.
    activeSelection.elementId === textElement?.id &&
    typeof activeSelection.start === "number" &&
    typeof activeSelection.end === "number" &&
    activeSelection.start < activeSelection.end
  );

  /**
   * The selection, bound once, as the thing every read and write below narrows on.
   *
   * It exists so the three style toggles cannot disagree with themselves about
   * whether a selection is in play: reading the element while writing the range (or
   * the other way round) is a control that shows one state and produces another,
   * and the write path is a different function from the read path here.
   *
   * Clamped to what the text holds NOW. The panel outlives the keystroke that made
   * the range, so a range whose text has since got shorter would otherwise arm
   * run-scoped controls that write past the end and change nothing — a panel
   * offering an edit that silently does not happen.
   */
  const contentLength = (textElement.content || "").length;
  const clampedRange = hasRangeSelection
    ? {
      elementId: activeSelection!.elementId,
      start: Math.min(activeSelection!.start, contentLength),
      end: Math.min(activeSelection!.end, contentLength)
    }
    : null;
  const rangeSelection = clampedRange && clampedRange.start < clampedRange.end ? clampedRange : null;

  // What the fields SHOW, read the same way the writes are scoped: a run that
  // declares a key overrides the paragraph's, and a run that says nothing shows
  // the paragraph's — which is what the canvas paints there.
  const runStyle = rangeSelection ? spanStyleAt(textElement, rangeSelection.start) : undefined;
  if (runStyle) {
    if (runStyle.fontFamily) currentFont = runStyle.fontFamily;
    if (runStyle.fontWeight) currentWeight = runStyle.fontWeight as number;
    if (runStyle.fontSize) currentSize = runStyle.fontSize;
    if (runStyle.letterSpacing !== undefined) currentLetterSpacing = runStyle.letterSpacing;
  }

  const currentAlign = textStyle.align || "left";
  const currentVAlign = textStyle.verticalAlign || "top";

  /**
   * A bound text style owns the TYPE, and that is a fixed set (`TEXT_STYLE_KEYS`)
   * — not "whatever this style happens to declare". Per-key gating made the same
   * field move between the two panels from one style to the next, so nobody could
   * tell which panel owned a value.
   *
   * What the style does not own stays here: alignment, figures, truncation. What
   * it does not own is also refused by `normalizeStyles`, so a hand-written style
   * cannot quietly take one of them back.
   */
  const styleOwnsType = Boolean(boundStyle);

  /**
   * Per-field agreement across a multi-selection — Figma's rule.
   *
   * Every typography field resolves INDEPENDENTLY: a selection of two runs where
   * only the size differs shows Mixed on the size and a real number everywhere
   * else. Treating the block as one thing and blanking all of it — or, worse,
   * showing the primary's values for all of it — throws away the edits the panel
   * can actually make. A run selection is not in play across several layers, so
   * these only apply when there is more than one.
   */
  const multi = elements.length > 1;
  const styleOf = (el: DesignElement) => ((el as TextElement).style || {}) as TextStyle;
  const agreed = <T,>(pick: (st: TextStyle) => T) =>
    multi ? resolveAcross(elements, (el) => pick(styleOf(el))).mixed : false;
  const mixedFont = agreed((st) => st.fontFamily || DEFAULT_FONT_FAMILY);
  const mixedWeight = agreed((st) => st.fontWeight || 400);
  const mixedSize = agreed((st) => st.fontSize || 24);
  const mixedLineHeight = agreed((st) => st.lineHeight);
  const mixedLetterSpacing = agreed((st) => st.letterSpacing || 0);
  const mixedAlign = agreed((st) => st.align || "left");
  const mixedVAlign = agreed((st) => st.verticalAlign || "top");
  const mixedDecoration = (line: string) =>
    agreed((st) => hasDecoration(st.textDecoration, line as TextDecorationLine));
  const mixedFigures = agreed((st) => st.fontVariantNumeric || "normal");
  // Off is the absence of a line count, not a third value of it: `maxLines`
  // unset is the only spelling of "show everything".
  const truncateMode =
    textStyle.maxLines === undefined
      ? "off"
      : textStyle.textOverflow === "ellipsis"
        ? "ellipsis"
        : "clip";

  const setStyle = (partial: Partial<TextStyle>, commit = true) =>
    onMutate((el) => ({ ...el, style: { ...((el as TextElement).style || {}), ...partial } }), commit);

  const applyStyleUpdate = (partial: Partial<TextStyle>, commitImmediately = true) => {
    if (rangeSelection) {
      onMutate((el) => applySpanStyleToRange(el as TextElement, rangeSelection, partial), commitImmediately);
    } else {
      setStyle(partial, commitImmediately);
    }
  };

  /**
   * Which of the three style toggles are armed.
   *
   * Read from the RANGE when there is one, not from the element. With a selection
   * live the element's own style is only the base a run overrides, so showing a
   * toggle as armed because the paragraph is italic — while pressing it would write
   * `normal` onto the selected run — is a button that lies about what it is about
   * to do. `spanRangeIsItalic` / `spanRangeHasDecoration` answer for the selection
   * and fall through to the element for runs that say nothing, so the read and the
   * write come from the same definition of "the range".
   */
  const armedStyleValues: string[] = DECORATION_LINES.filter((l) =>
    rangeSelection ? spanRangeHasDecoration(textElement, rangeSelection, l) : hasDecoration(textStyle.textDecoration, l)
  );
  if (rangeSelection ? spanRangeIsItalic(textElement, rangeSelection) : textStyle.fontStyle === "italic") {
    armedStyleValues.push("italic");
  }

  /**
   * A toggle that only SOME of the selection has is drawn unarmed.
   *
   * `ToggleGroup` has no Mixed state, and unarmed is the honest one: pressing an
   * unarmed toggle turns it ON for everyone, which is the direction that resolves
   * the disagreement. Drawing it armed would offer the press that switches it OFF
   * on half the selection — a button whose second press is a different button.
   */
  const allHave = (line: TextDecorationLine) =>
    rangeSelection
      ? spanRangeHasDecoration(textElement, rangeSelection, line)
      : hasDecoration(textStyle.textDecoration, line);
  if (multi) {
    const disagreed = new Set<string>();
    if (mixedDecoration("italic")) disagreed.add("italic");
    for (const l of DECORATION_LINES) {
      if (mixedDecoration(l) && allHave(l)) disagreed.add(l);
    }
    for (const d of disagreed) {
      const at = armedStyleValues.indexOf(d);
      if (at !== -1) armedStyleValues.splice(at, 1);
    }
  }

  const toggleFontStyle = (next: boolean) => {
    // Normal on a run overrides paragraph italics; on element, undefined is normal.
    applyStyleUpdate({ fontStyle: next ? "italic" : rangeSelection ? "normal" : undefined }, true);
  };

  const toggleDecoration = (line: TextDecorationLine, next: boolean) => {
    if (rangeSelection) {
      // Straight to the interaction rather than through a partial style: setting a
      // partial would replace the whole list, so turning one line on over a range
      // that is half struck through would spread the strikethrough onto the half
      // that never had it. A toggle has to know what is there first.
      onMutate((el) => toggleSpanDecoration(el as TextElement, rangeSelection, line), true);
      return;
    }
    // An empty list on the element is the same state as the absent key — there is
    // no situation-derived default for a decoration — so it is written as the
    // absent key. Only a RUN keeps `[]`, where it means "no lines here" against a
    // paragraph that draws one.
    const lines = toggledDecoration(textStyle.textDecoration, line, next);
    applyStyleUpdate({ textDecoration: lines.length > 0 ? lines : undefined }, true);
  };

  const decorationItems = [
    {
      value: "italic",
      icon: <Italic size={11} />,
      title: t("typography.styleItalic"),
      grow: true,
      attrs: { "data-typography-toggle": "italic" }
    },
    {
      value: "underline",
      icon: <Underline size={11} />,
      title: t("typography.decorationUnderline"),
      grow: true,
      attrs: { "data-typography-toggle": "underline" }
    },
    {
      value: "line-through",
      icon: <Strikethrough size={11} />,
      title: t("typography.decorationStrikethrough"),
      grow: true,
      attrs: { "data-typography-toggle": "line-through" }
    }
  ];

  return (
    /* `data-typography-section`: the section-level hook the e2e suite reads to
       prove the STANDARD typography block is what an instance child gets. It was
       reading a `data-typography-content` field that no longer exists — text
       content is edited on the canvas, not in this panel. */
    <Section
      id="typography"
      title={t("properties.typography")}
      data-typography-section="true"
      trailing={
        <>
          {styleBind.trigger}
          {styleBind.picker}
        </>
      }
    >

      {/* Bound Style Pill */}
      {boundStyle && (
        <StylePill
          rowProps={{ "data-text-style-pill": boundStyle.id }}
          styleName={boundStyle.name}
          preview={renderStylePreview(boundStyle, "w-4 h-4")}
          subtitle={`${boundStyle.style.fontFamily || DEFAULT_FONT_FAMILY} · ${boundStyle.style.fontSize || 16}px`}
          selectTitle={t("styles.editStyle")}
          onSelect={styleBind.openFrom}
          onUnlink={() => onMutate((el) => unbindTextStyle(el as TextElement, boundStyle) as DesignElement, true)}
          unlinkTitle={t("styles.detachStyle")}
        />
      )}

      {/* The TYPE controls belong to the bound style — the next sync copies the
          style's value over whatever was typed here, so a control for one would be
          a button that undoes itself. The set is fixed (`TEXT_STYLE_KEYS`), not
          "whatever this style declares": a per-key rule moved the same field
          between the two panels from one style to the next. */}
      {!styleOwnsType && (
        <>
          {/* Font family. No label above it: the field already carries the family
              name, and a second line saying "Font" above a control that reads
              "System UI" is the same information twice in two voices. */}
          <div>
            <FontFamilyPicker
              value={currentFont}
              mixed={mixedFont}
              onChange={(fontFamily) => {
                applyStyleUpdate({ fontFamily }, true);
              }}
            />
          </div>

          {/* Font Weight & Size */}
          <div className="grid grid-cols-2 gap-2">
            <Select
              value={mixedWeight ? "" : currentWeight}
              onChange={(val) => applyStyleUpdate({ fontWeight: Number(val) }, true)}
            >
              {mixedWeight && (
                <option value="" disabled>
                  {MIXED_LABEL}
                </option>
              )}
              {[
                [300, "weightLight"],
                [400, "weightRegular"],
                [500, "weightMedium"],
                [600, "weightSemiBold"],
                [700, "weightBold"],
                [800, "weightExtraBold"]
              ].map(([w, k]) => (
                <option key={w} value={w}>{t(`typography.${k}` as any)}</option>
              ))}
            </Select>

            <ScrubInput
              label={t("typography.size")}
              value={mixedSize ? undefined : currentSize}
              mixed={mixedSize}
              min={1}
              tokenName={
                textElement.tokenBindings?.fontSize
                  ? findNumberToken(docRef.current.tokens ?? [], textElement.tokenBindings.fontSize)?.name
                  : undefined
              }
              onDetachToken={
                textElement.tokenBindings?.fontSize
                  ? () => onMutate((el) => unbindNumberTokenFromElement(el, "fontSize"), true)
                  : undefined
              }
              onOpenTokenPicker={(anchor) => setTokenPicker({ prop: "fontSize", anchor })}
              onDragStart={onDragStart}
              onDragEnd={onDragEnd}
              onChange={(sz) => applyStyleUpdate({ fontSize: sz }, false)}
            />
          </div>

          {/* Line Height & Letter Spacing */}
          <div className="grid grid-cols-2 gap-2">
            <LineHeightField
              value={mixedLineHeight ? undefined : textElement.style?.lineHeight}
              fontSize={currentSize}
              mixed={mixedLineHeight}
              tokenName={
                textElement.tokenBindings?.lineHeight
                  ? findNumberToken(docRef.current.tokens ?? [], textElement.tokenBindings.lineHeight)?.name
                  : undefined
              }
              onDetachToken={
                textElement.tokenBindings?.lineHeight
                  ? () => onMutate((el) => unbindNumberTokenFromElement(el, "lineHeight"), true)
                  : undefined
              }
              onOpenTokenPicker={(anchor) => setTokenPicker({ prop: "lineHeight", anchor })}
              onDragStart={onDragStart}
              onDragEnd={onDragEnd}
              onChange={(lh) => setStyle({ lineHeight: lh }, false)}
            />
            <LetterSpacingField
              value={mixedLetterSpacing ? undefined : currentLetterSpacing}
              mixed={mixedLetterSpacing}
              tokenName={
                textElement.tokenBindings?.letterSpacing
                  ? findNumberToken(docRef.current.tokens ?? [], textElement.tokenBindings.letterSpacing)?.name
                  : undefined
              }
              onDetachToken={
                textElement.tokenBindings?.letterSpacing
                  ? () => onMutate((el) => unbindNumberTokenFromElement(el, "letterSpacing"), true)
                  : undefined
              }
              onOpenTokenPicker={(anchor) => setTokenPicker({ prop: "letterSpacing", anchor })}
              onDragStart={onDragStart}
              onDragEnd={onDragEnd}
              onChange={(letterSpacing) => applyStyleUpdate({ letterSpacing }, false)}
            />
          </div>
        </>
      )}

      {/* Alignment: Horizontal & Vertical. The layer's — a style places type, not
          the box — so these stay even when a style is bound. */}
      <div className="grid grid-cols-2 gap-2">
        <SegmentedControl<string>
          className="w-full"
          value={mixedAlign ? "" : currentAlign}
          onChange={(v) => setStyle({ align: v as any })}
          items={[
            { value: "left", icon: <AlignLeft size={12} />, title: t("alignText.left"), grow: true },
            { value: "center", icon: <AlignCenter size={12} />, title: t("alignText.center"), grow: true },
            { value: "right", icon: <AlignRight size={12} />, title: t("alignText.right"), grow: true }
          ]}
        />

        <SegmentedControl<"top" | "middle" | "bottom">
          className="w-full"
          value={mixedVAlign ? ("" as "top") : currentVAlign}
          onChange={(verticalAlign) => setStyle({ verticalAlign })}
          items={[
            { value: "top", icon: <AlignVerticalJustifyStart size={12} />, title: t("alignText.top"), grow: true },
            { value: "middle", icon: <AlignVerticalJustifyCenter size={12} />, title: t("alignText.middle"), grow: true },
            { value: "bottom", icon: <AlignVerticalJustifyEnd size={12} />, title: t("alignText.bottom"), grow: true }
          ]}
        />
      </div>

      {/* Decoration (italic / underline / strikethrough) & Numerals (tabular) */}
      <div className="space-y-2">
        {/* One row, three INDEPENDENT toggles.
            They used to be two rows and two different kinds of control: `Aa`/`AI`
            for italic (a toggle, and it had to be, since italic composes with
            everything) and `none`/`U`/`S` for decoration (a picker, and it had to
            be, since `textDecoration` was a single-value enum). Two rows said
            "these are two different things" about two things that are not, and the
            picker said "you may have one" about two lines CSS lets you have
            together. Both halves of that are now the same arity, and the merge is
            what forced the DSL to catch up: see `TextDecorationLine`. */}
        {!styleOwnsType && (
          <div className={ROW_SPREAD_GAP_CLASS}>
            {/* "Decoration", not "Style": the section already has a Style pill above
                it that means a TEXT STYLE, and two rows both labelled Style — one
                meaning "which named style is this bound to", the other meaning "which
                lines does this draw" — is the same word doing two jobs a row apart.
                The row is the one the user named it when they asked for the merge. */}
            <span className={`${SUB_LABEL_CLASS} shrink-0`}>{t("typography.decoration")}</span>
            <ToggleGroup<string>
              className="flex-1"
              values={armedStyleValues}
              onToggle={(value, next) =>
                value === "italic"
                  ? toggleFontStyle(next)
                  : toggleDecoration(value as TextDecorationLine, next)
              }
              items={decorationItems}
            />
          </div>
        )}

        {/* Case (Text Transform) — the style owns it (the style editor has the row),
            and it sits with the other text decorations rather than after the
            layer-only rows below. */}
        {!styleOwnsType && (
          <div className={ROW_SPREAD_GAP_CLASS}>
            <span className={`${SUB_LABEL_CLASS} shrink-0`}>{t("typography.case")}</span>
            <SegmentedControl<string>
              className="flex-1"
              value={textElement.style?.textTransform || "none"}
              onChange={(v) => setStyle({ textTransform: v === "none" ? undefined : (v as any) })}
              items={[
                { value: "none", icon: <Minus size={11} />, title: t("typography.caseNone"), grow: true },
                { value: "uppercase", label: "AA", title: t("typography.caseUpper"), grow: true },
                { value: "lowercase", label: "aa", title: t("typography.caseLower"), grow: true },
                { value: "capitalize", label: "Aa", title: t("typography.caseTitle"), grow: true }
              ]}
            />
          </div>
        )}

        {/* Figures are the layer's: a text style has no control for them. */}
        <div className={ROW_SPREAD_GAP_CLASS}>
          <span className={`${SUB_LABEL_CLASS} shrink-0`}>{t("typography.figures")}</span>
          <SegmentedControl<string>
            className="flex-1"
            value={mixedFigures ? "" : textStyle.fontVariantNumeric === "tabular-nums" ? "tabular-nums" : "normal"}
            onChange={(v) => {
              onMutate((el) => {
                const style = { ...((el as TextElement).style || {}) };
                if (v === "tabular-nums") style.fontVariantNumeric = "tabular-nums";
                else delete style.fontVariantNumeric;
                return { ...el, style };
              }, true);
            }}
            items={[
              {
                value: "normal",
                icon: <NumeralsMark tabular={false} />,
                title: t("typography.figuresProportional"),
                grow: true,
                attrs: { "data-typography-figures": "normal" }
              },
              {
                value: "tabular-nums",
                icon: <NumeralsMark tabular />,
                title: t("typography.figuresTabular"),
                grow: true,
                attrs: { "data-typography-figures": "tabular-nums" }
              }
            ]}
          />
        </div>

        {/* A line count and what the cut line shows are one control: the overflow
            rule is read only when there is something to cut, so offering it alone
            would be offering a setting that changes nothing. Also the layer's. */}
        <div className={ROW_SPREAD_GAP_CLASS}>
          <span className={`${SUB_LABEL_CLASS} shrink-0`}>{t("typography.truncate")}</span>
          <SegmentedControl<string>
            className="flex-1"
            value={truncateMode}
            onChange={(v) =>
              setStyle(
                v === "off"
                  ? { maxLines: undefined, textOverflow: undefined }
                  : { maxLines: textStyle.maxLines ?? 2, textOverflow: v as any }
              )
            }
            items={[
              {
                value: "off",
                icon: <Minus size={11} />,
                title: t("typography.truncateOff"),
                grow: true,
                attrs: { "data-typography-truncate": "off" }
              },
              {
                value: "clip",
                icon: <ArrowDownFromLine size={11} />,
                title: t("typography.truncateClip"),
                grow: true,
                attrs: { "data-typography-truncate": "clip" }
              },
              {
                value: "ellipsis",
                label: "…",
                title: t("typography.truncateEllipsis"),
                grow: true,
                attrs: { "data-typography-truncate": "ellipsis" }
              }
            ]}
          />
        </div>

        {textStyle.maxLines !== undefined && (
          <ScrubInput
            label={t("typography.truncateLines")}
            value={textStyle.maxLines ?? 1}
            min={1}
            onDragStart={onDragStart}
            onDragEnd={onDragEnd}
            onChange={(l) => setStyle({ maxLines: Math.max(1, Math.round(l)) }, false)}
          />
        )}
      </div>

      {/* Text on Path */}
      {textElement.onPath && (
        <div className="pt-2 border-t border-rule-strong space-y-1.5">
          <div className={ROW_SPREAD_CLASS}>
            <span className={SUB_LABEL_CLASS}>{t("typography.pathOffset")}</span>
            {/* A row's control is an icon button, like the instance's own detach:
                a `text-ui` label beside a 9.5px sub-label read as a heading, and
                `danger` is hover-only — coral at rest is a panel of errors. */}
            <Button
              variant="danger"
              size="icon"
              data-path-detach="true"
              title={t("typography.detachFromPath")}
              aria-label={t("typography.detachFromPath")}
              onClick={() => {
                onMutate((el) => {
                  const { onPath: _, ...rest } = el as TextElement;
                  return rest as TextElement;
                }, true);
              }}
            >
              <Unlink size={12} />
            </Button>
          </div>
          <ScrubInput
            label="%"
            value={textElement.onPath?.startOffset || 0}
            min={0}
            max={100}
            onDragStart={onDragStart}
            onDragEnd={onDragEnd}
            onChange={(startOffset) =>
              onMutate((el) => ({ ...el, onPath: { ...(el as TextElement).onPath!, startOffset } }))
            }
          />
          <SegmentedControl<"out" | "in">
            className="w-full"
            value={textElement.onPath?.side === "in" ? "in" : "out"}
            onChange={(side) =>
              onMutate((el) => ({ ...el, onPath: { ...(el as TextElement).onPath!, side } }))
            }
            items={[
              { value: "out", label: t("typography.pathSideOut"), title: t("typography.pathSideOutHint"), grow: true },
              { value: "in", label: t("typography.pathSideIn"), title: t("typography.pathSideInHint"), grow: true }
            ]}
          />
        </div>
      )}

      {tokenPicker && (
        <NumberTokenPicker
          doc={docRef.current}
          docRef={docRef}
          anchor={tokenPicker.anchor}
          category="typography"
          boundTokenId={textElement.tokenBindings?.[tokenPicker.prop]}
          currentValue={
            tokenPicker.prop === "fontSize"
              ? currentSize
              : tokenPicker.prop === "letterSpacing"
                ? typeof currentLetterSpacing === "number"
                  ? currentLetterSpacing
                  : parseFloat(String(currentLetterSpacing)) || 0
                : typeof textElement.style?.lineHeight === "number"
                  ? textElement.style.lineHeight
                  : parseFloat(String(textElement.style?.lineHeight || currentSize)) || 0
          }
          onSelect={(token) => {
            if (!docRef.current.tokens?.some((t) => t.id === token.id)) {
              docRef.current = addTokenToDoc(docRef.current, token);
            }
            onMutate((el) => bindNumberTokenToElement(el, tokenPicker.prop, token.id, token.value), true);
            setTokenPicker(null);
          }}
          onDetach={() => {
            onMutate((el) => unbindNumberTokenFromElement(el, tokenPicker.prop), true);
            setTokenPicker(null);
          }}
          onCommitSnapshot={onCommitSnapshot}
          onClose={() => setTokenPicker(null)}
        />
      )}
    </Section>
  );
}
