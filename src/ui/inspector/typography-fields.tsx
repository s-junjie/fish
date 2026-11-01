import type { LetterSpacing, LineHeight, TextDecorationLine, TextStyleDeclaration } from "../../core/dsl/types";
import { DEFAULT_FONT_FAMILY } from "../../core/font-stack";
import { t } from "../../i18n";
import { ScrubInput } from "../ScrubInput";
import { SegmentedControl, ToggleGroup } from "../SegmentedControl";
import { Select } from "../Select";
import { SUB_LABEL_CLASS } from "../label-tier";
import { ROW_SPREAD_GAP_CLASS } from "../row-style";
import { Italic, Underline, Strikethrough, Minus } from "lucide-react";
import { FontFamilyPicker } from "./FontFamilyPicker";
import { LineHeightField } from "./LineHeightField";
import { LetterSpacingField } from "./LetterSpacingField";
import { MIXED_LABEL } from "./mixed";

export type TypographyNumberProp = "fontSize" | "lineHeight" | "letterSpacing";

export type TypographyMixed = Partial<
  Record<"fontFamily" | "fontWeight" | "fontSize" | "lineHeight" | "letterSpacing", boolean>
>;

export type TypographyTokens = Partial<
  Record<TypographyNumberProp, { name?: string; onDetach?: () => void }>
>;

/** A style is the same type a layer wears, so it offers the same weights — the
 *  editor's list used to stop at 400–700, which meant it could not build a style
 *  from a layer wearing Light. */
const WEIGHT_OPTIONS: Array<[number, string]> = [
  [300, "weightLight"],
  [400, "weightRegular"],
  [500, "weightMedium"],
  [600, "weightSemiBold"],
  [700, "weightBold"],
  [800, "weightExtraBold"]
];

/** Italic / underline / strike, as one row of independent toggles. */
export function DecorationRow({
  values,
  onToggle
}: {
  values: string[];
  onToggle: (value: string, next: boolean) => void;
}) {
  return (
    <div className={ROW_SPREAD_GAP_CLASS}>
      <span className={`${SUB_LABEL_CLASS} shrink-0`}>{t("typography.decoration")}</span>
      <ToggleGroup<string>
        className="flex-1"
        values={values}
        onToggle={onToggle}
        items={[
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
        ]}
      />
    </div>
  );
}

/** Text transform: none / AA / aa / Aa. */
export function CaseRow({
  value,
  onChange
}: {
  value?: TextStyleDeclaration["textTransform"];
  onChange: (next: TextStyleDeclaration["textTransform"]) => void;
}) {
  return (
    <div className={ROW_SPREAD_GAP_CLASS}>
      <span className={`${SUB_LABEL_CLASS} shrink-0`}>{t("typography.case")}</span>
      <SegmentedControl<string>
        className="flex-1"
        value={value || "none"}
        onChange={(v) => onChange(v === "none" ? undefined : (v as TextStyleDeclaration["textTransform"]))}
        items={[
          { value: "none", icon: <Minus size={11} />, title: t("typography.caseNone"), grow: true },
          { value: "uppercase", label: "AA", title: t("typography.caseUpper"), grow: true },
          { value: "lowercase", label: "aa", title: t("typography.caseLower"), grow: true },
          { value: "capitalize", label: "Aa", title: t("typography.caseTitle"), grow: true }
        ]}
      />
    </div>
  );
}

interface TypographyFieldsProps {
  fontFamily?: string;
  /** CSS-shaped on purpose: a draft style and a layer share the same declaration. */
  fontWeight?: TextStyleDeclaration["fontWeight"];
  fontSize?: number;
  lineHeight?: LineHeight;
  letterSpacing?: LetterSpacing;
  textTransform?: TextStyleDeclaration["textTransform"];
  /** Fields whose value disagrees across a multi-selection. */
  mixed?: TypographyMixed;
  /** Bound number tokens, one slot per numeric field. */
  tokens?: TypographyTokens;
  onOpenTokenPicker?: (prop: TypographyNumberProp, anchor: HTMLElement) => void;
  onDragStart?: () => void;
  onDragEnd?: () => void;
  /**
   * `commit=false` while a scrub is in flight: the caller batches those into one
   * undo step, exactly as the inspector's own fields do.
   */
  onChange: (patch: Partial<TextStyleDeclaration>, commit: boolean) => void;
  /** The armed decoration toggles. The caller reads them, because a live run
      selection answers for the range rather than for the layer. */
  decoration?: { values: string[]; onToggle: (value: string, next: boolean) => void };
  /** The case row. A text style owns it, and so does a text layer. */
  showCase?: boolean;
}

/**
 * The type block — family, weight, size, line height, tracking, and optionally
 * decoration and case — for both places that place it: the inspector's Typography
 * section and the text-style editor's draft rows. What legitimately differs
 * (Mixed, range scoping, token bindings, undo batching) is a prop.
 */
export function TypographyFields({
  fontFamily,
  fontWeight = 400,
  fontSize,
  lineHeight,
  letterSpacing,
  textTransform,
  mixed = {},
  tokens = {},
  onOpenTokenPicker,
  onDragStart,
  onDragEnd,
  onChange,
  decoration,
  showCase = false
}: TypographyFieldsProps) {
  const picker = (prop: TypographyNumberProp) =>
    onOpenTokenPicker ? (anchor: HTMLElement) => onOpenTokenPicker(prop, anchor) : undefined;

  return (
    <>
      {/* No label above the family: the field already carries the family's name,
          and a second line saying "Font" is the same information twice. */}
      <div>
        <FontFamilyPicker
          value={fontFamily || DEFAULT_FONT_FAMILY}
          mixed={mixed.fontFamily}
          onChange={(family) => onChange({ fontFamily: family }, true)}
        />
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Select
          value={mixed.fontWeight ? "" : fontWeight}
          onChange={(val) => onChange({ fontWeight: Number(val) }, true)}
        >
          {mixed.fontWeight && (
            <option value="" disabled>
              {MIXED_LABEL}
            </option>
          )}
          {WEIGHT_OPTIONS.map(([weight, key]) => (
            <option key={weight} value={weight}>
              {t(`typography.${key}` as any)}
            </option>
          ))}
        </Select>

        <ScrubInput
          label={t("typography.size")}
          value={mixed.fontSize ? undefined : fontSize}
          mixed={mixed.fontSize}
          min={1}
          tokenName={tokens.fontSize?.name}
          onDetachToken={tokens.fontSize?.onDetach}
          onOpenTokenPicker={picker("fontSize")}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          onChange={(size) => onChange({ fontSize: size }, false)}
        />
      </div>

      <div className="grid grid-cols-2 gap-2">
        <LineHeightField
          value={mixed.lineHeight ? undefined : lineHeight}
          fontSize={fontSize || 16}
          mixed={mixed.lineHeight}
          tokenName={tokens.lineHeight?.name}
          onDetachToken={tokens.lineHeight?.onDetach}
          onOpenTokenPicker={picker("lineHeight")}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          onChange={(lh) => onChange({ lineHeight: lh }, false)}
        />
        <LetterSpacingField
          value={mixed.letterSpacing ? undefined : letterSpacing}
          mixed={mixed.letterSpacing}
          tokenName={tokens.letterSpacing?.name}
          onDetachToken={tokens.letterSpacing?.onDetach}
          onOpenTokenPicker={picker("letterSpacing")}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          onChange={(ls) => onChange({ letterSpacing: ls }, false)}
        />
      </div>

      {decoration && <DecorationRow values={decoration.values} onToggle={decoration.onToggle} />}

      {showCase && (
        <CaseRow
          value={textTransform}
          onChange={(next) => onChange({ textTransform: next }, true)}
        />
      )}
    </>
  );
}
