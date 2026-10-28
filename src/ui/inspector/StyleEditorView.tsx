import type { RefObject } from "preact";
import { useState } from "preact/hooks";
import type { ColorToken, DesignDocument, Effect, Paint, PaintStyle, Stroke, StyleType, TextStyleDeclaration, TextDecorationLine } from "../../core/dsl/types";
import { parseColorAlpha, composeColorAlpha } from "../../core/geometry/color-utils";
import { cssBlurFilter } from "../../core/css-encode";
import { paintRowLabel, paintSwatchBackground, paintImageUri, IMAGE_SWATCH_FALLBACK } from "./paint-preview";
import { PaintStackSwatch } from "../PaintStackSwatch";
import { stackRows } from "../../core/dsl/paint-stack";
import { t } from "../../i18n";
import { DEFAULT_FONT_FAMILY, resolveStack } from "../../core/font-stack";
import { StrokePanel } from "./StrokePanel";
import { ColorRow } from "./ColorRow";
import { NumberTokenPicker } from "./NumberTokenPicker";
import { findNumberToken, numberTokenPropValue } from "../../core/interactions/number-token-ops";
import { addTokenToDoc } from "../../core/interactions/style-ops";
import { colorTokenColor } from "../../core/interactions/token-ops";
import { Select } from "../Select";
import { ScrubInput } from "../ScrubInput";
import { LineHeightField } from "./LineHeightField";
import { LetterSpacingField } from "./LetterSpacingField";
import { FontFamilyPicker } from "./FontFamilyPicker";
import { EffectRows } from "../EffectRows";
import { Plus, Eye, EyeOff, Minus, Italic, Underline, Strikethrough, SlidersHorizontal } from "lucide-react";
import { TEXT_FIELD_CLASS } from "../ScrubInput";
import { Button } from "../Button";
import { SUB_LABEL_CLASS } from "../label-tier";
import { NEW_SOLID, DEFAULT_STROKE_ROW } from "./style-draft-defaults";
import { SegmentedControl, ToggleGroup } from "../SegmentedControl";
import { DECORATION_LINES, hasDecoration, toggledDecoration } from "../../core/dsl/text-decoration";
import { ROW_CLASS, ROW_SPREAD_GAP_CLASS } from "../row-style";
export interface StyleDrafts {
  paints: Paint[];
  strokes: Stroke[];
  /** A text style's declarations — type only, no ink (see `TextStyleDeclaration`). */
  textStyle: TextStyleDeclaration;
  effects: Effect[];
}

interface StyleEditorViewProps {
  styleType: StyleType;
  doc?: DesignDocument;
  docRef?: { current: DesignDocument };
  name: string;
  description: string;
  drafts: StyleDrafts;
  setDrafts: (updater: (cur: StyleDrafts) => StyleDrafts) => void;
  editing: boolean;
  nameInputRef: RefObject<HTMLInputElement>;
  activePaintPicker: { index: number; anchor: HTMLElement } | null;
  setActivePaintPicker: (next: { index: number; anchor: HTMLElement } | null) => void;
  effectMenuAnchor: HTMLElement | null;
  setEffectMenuAnchor: (next: HTMLElement | null) => void;
  onNameChange: (next: string) => void;
  onDescriptionChange: (next: string) => void;
  onSubmit: (e?: Event) => void;
  onCancel: () => void;
  /** The design-system tab edits in place; a banner preview is not part of that. */
  showPreview?: boolean;
  /** The undo stream for a token edit saved from the draft's token picker. */
  onCommitSnapshot?: (newDoc: DesignDocument) => void;
}

/**
 * The editor half of the style picker: name and description, a banner preview,
 * and editable rows for whichever kind of style is being made.
 */
export function StyleEditorView({
  styleType,
  doc,
  docRef,
  name,
  description,
  drafts,
  setDrafts,
  editing,
  nameInputRef,
  activePaintPicker,
  setActivePaintPicker,
  effectMenuAnchor,
  setEffectMenuAnchor,
  onNameChange,
  onDescriptionChange,
  onSubmit,
  onCancel,
  showPreview = true,
  onCommitSnapshot
}: StyleEditorViewProps) {
  return (
    <form onSubmit={onSubmit} className="flex flex-col space-y-3">
      {showPreview && (
        <StyleBannerPreview styleType={styleType} drafts={drafts} doc={doc ?? docRef?.current} />
      )}

      <div className="space-y-2">
        <div className={ROW_CLASS}>
          <span className={`${SUB_LABEL_CLASS} w-16 shrink-0`}>{t("styles.styleName")}</span>
          <input
            ref={nameInputRef}
            type="text"
            name="style-name"
            value={name}
            onInput={(e) => onNameChange((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => {
              if (e.isComposing || (e as any).keyCode === 229) return;
              if (e.key === "Enter") onSubmit();
            }}
            className={`flex-1 ${TEXT_FIELD_CLASS}`}
          />
        </div>

        <div className={ROW_CLASS}>
          <span className={`${SUB_LABEL_CLASS} w-16 shrink-0`}>{t("styles.styleDescription")}</span>
          <input
            type="text"
            name="style-description"
            value={description}
            onInput={(e) => onDescriptionChange((e.target as HTMLInputElement).value)}
            placeholder={t("styles.styleDescriptionPlaceholder")}
            className={`flex-1 ${TEXT_FIELD_CLASS}`}
          />
        </div>
      </div>

      <div className="pt-2 border-t border-rule-strong flex items-center justify-between">
        <span className={SUB_LABEL_CLASS}>{t("styles.properties")}</span>
        {/* No plus on a text style: its properties are the fixed type set below
            (family, weight, size, line height, tracking), and the only thing a
            plus could have added was an effect — which a text style does not
            own. Effects belong to the layer, or to an effect style. */}
        {(styleType === "paint" || styleType === "stroke" || styleType === "effect") && (
          <Button
            size="icon"
            type="button"
            data-style-add-layer={styleType}
            onClick={(e) => {
              if (styleType === "paint") {
                setDrafts((cur) => ({ ...cur, paints: [...cur.paints, { ...NEW_SOLID }] }));
              } else if (styleType === "stroke") {
                setDrafts((cur) => ({ ...cur, strokes: [...cur.strokes, { ...DEFAULT_STROKE_ROW }] }));
              } else {
                setEffectMenuAnchor(e.currentTarget as HTMLElement);
              }
            }}
            title={styleType === "paint" ? t("paint.addFill") : styleType === "stroke" ? t("paint.addStroke") : t("effects.add")}
            aria-label={styleType === "paint" ? t("paint.addFill") : styleType === "stroke" ? t("paint.addStroke") : t("effects.add")}
          >
            <Plus size={14} />
          </Button>
        )}
      </div>

      {styleType === "paint" && (
        <DraftPaintRows
          paints={drafts.paints}
          doc={doc}
          docRef={docRef}
          activePicker={activePaintPicker}
          onPick={setActivePaintPicker}
          onRemove={(idx) =>
            setDrafts((cur) => ({
              ...cur,
              paints: cur.paints.filter((_, i) => i !== idx)
            }))
          }
          onToggle={(idx, enabled) =>
            setDrafts((cur) => {
              const next = [...cur.paints];
              next[idx] = { ...next[idx], enabled };
              return { ...cur, paints: next };
            })
          }
          onAlpha={(idx, pct) =>
            setDrafts((cur) => {
              const p = cur.paints[idx];
              const next = [...cur.paints];
              if (p.type === "solid") {
                const nextSolid: Paint = {
                  ...p,
                  color: composeColorAlpha(parseColorAlpha(p.color).hex6, pct)
                };
                delete (nextSolid as any).opacity;
                next[idx] = nextSolid;
              } else {
                next[idx] = { ...p, opacity: pct / 100 };
              }
              return { ...cur, paints: next };
            })
          }
          onHex={(idx, hex, alphaPct) =>
            setDrafts((cur) => {
              const next = [...cur.paints];
              const p = next[idx];
              if (p.type === "solid") {
                const nextSolid: Paint = { ...p, color: composeColorAlpha(hex, alphaPct) };
                delete (nextSolid as any).opacity;
                next[idx] = nextSolid;
              } else {
                next[idx] = p;
              }
              return { ...cur, paints: next };
            })
          }
          onBindToken={(idx, token) => {
            if (docRef && !docRef.current.tokens?.some((t) => t.id === token.id)) {
              docRef.current = addTokenToDoc(docRef.current, token);
            }
            const color = colorTokenColor(token);
            setDrafts((cur) => {
              const next = [...cur.paints];
              const p = next[idx];
              if (p && p.type === "solid") {
                next[idx] = { ...p, tokenId: token.id, color };
              }
              return { ...cur, paints: next };
            });
          }}
          onDetachToken={(idx) => {
            setDrafts((cur) => {
              const next = [...cur.paints];
              const p = next[idx];
              if (p && p.type === "solid" && p.tokenId) {
                const { tokenId: _, ...rest } = p;
                next[idx] = rest as Paint;
              }
              return { ...cur, paints: next };
            });
          }}
        />
      )}

      {styleType === "text" && (
        <DraftTextRows
          textStyle={drafts.textStyle}
          doc={doc}
          docRef={docRef}
          onChange={(patch) =>
            setDrafts((cur) => ({ ...cur, textStyle: { ...cur.textStyle, ...patch } }))
          }
          onCommitTokenEdit={(nextDoc) => {
            if (docRef) {
              docRef.current = nextDoc;
              if (onCommitSnapshot) onCommitSnapshot(nextDoc);
            }
          }}
        />
      )}

      {styleType === "stroke" && (
        <DraftStrokeRows
          strokes={drafts.strokes}
          doc={doc}
          docRef={docRef}
          activePicker={activePaintPicker}
          onPick={setActivePaintPicker}
          onRemove={(idx) =>
            setDrafts((cur) => ({
              ...cur,
              strokes: cur.strokes.filter((_, i) => i !== idx)
            }))
          }
          onToggle={(idx, enabled) =>
            setDrafts((cur) => {
              const next = [...cur.strokes];
              next[idx] = { ...next[idx], enabled };
              return { ...cur, strokes: next };
            })
          }
          onUpdateStroke={(idx, patch) =>
            setDrafts((cur) => {
              const next = [...cur.strokes];
              next[idx] = { ...next[idx], ...patch };
              return { ...cur, strokes: next };
            })
          }
        />
      )}

      {styleType === "effect" && (
        <EffectRows
          effects={drafts.effects}
          doc={doc}
          docRef={docRef}
          onChange={(next) => setDrafts((cur) => ({ ...cur, effects: next }))}
          keepAtLeastOne
        />
      )}

      <div className="pt-2 border-t border-rule-strong flex items-center justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          size="text"
          onClick={onCancel}
        >
          {t("common.cancel")}
        </Button>
        <Button
          type="submit"
          variant="primary"
          size="text"
        >
          {editing ? t("styles.editStyleAction") : t("styles.createStyleAction")}
        </Button>
      </div>
    </form>
  );
}

function DraftPaintRows({
  paints,
  doc,
  docRef,
  activePicker,
  onPick,
  onRemove,
  onToggle,
  onAlpha,
  onHex,
  onBindToken,
  onDetachToken
}: {
  paints: Paint[];
  doc?: DesignDocument;
  docRef?: { current: DesignDocument };
  activePicker: { index: number; anchor: HTMLElement } | null;
  onPick: (next: { index: number; anchor: HTMLElement } | null) => void;
  onRemove: (index: number) => void;
  onToggle: (index: number, enabled: boolean) => void;
  onAlpha: (index: number, pct: number) => void;
  onHex: (index: number, hex: string, alphaPct: number) => void;
  onBindToken?: (index: number, token: ColorToken) => void;
  onDetachToken?: (index: number) => void;
}) {
  const imageUri = paintImageUri(doc ?? docRef?.current);
  return (
    <div className="space-y-1.5">
      {stackRows(paints).map(({ item: p, index: idx }) => {
        const isSolid = p.type === "solid";
        const isEnabled = p.enabled !== false;
        const isOpen = activePicker?.index === idx;
        const parsed = isSolid ? parseColorAlpha(p.color) : { hex6: "#000000", alphaPct: 100 };
        const effectiveAlpha =
          typeof p.opacity === "number" ? Math.round(p.opacity * 100) : (isSolid ? parsed.alphaPct : 100);

        return (
          <ColorRow
            key={idx}
            dataRowId={idx}
            paint={p}
            tokenId={isSolid ? p.tokenId : undefined}
            doc={doc}
            docRef={docRef}
            disabled={!isEnabled}
            isOpen={isOpen}
            swatchBackground={paintSwatchBackground(p, IMAGE_SWATCH_FALLBACK, imageUri)}
            label={paintRowLabel(p)}
            showAlpha={true}
            effectiveAlpha={effectiveAlpha}
            onChange={(nextColor, nextAlpha) => {
              if (isSolid) {
                const parsedColor = parseColorAlpha(nextColor);
                onHex(idx, parsedColor.hex6, nextAlpha ?? parsedColor.alphaPct);
              } else {
                onAlpha(idx, nextAlpha ?? 100);
              }
            }}
            onOpenColorPanel={(anchor) => onPick({ index: idx, anchor })}
            onBindToken={onBindToken ? (token) => onBindToken(idx, token) : undefined}
            onDetachToken={onDetachToken ? () => onDetachToken(idx) : undefined}
            trailing={
              <>
                <Button
                  size="icon"
                  type="button"
                  onClick={() => onToggle(idx, !isEnabled)}
                  title={isEnabled ? t("paint.hideFill") : t("paint.showFill")}
                  aria-label={isEnabled ? t("paint.hideFill") : t("paint.showFill")}
                >
                  {isEnabled ? <Eye size={12} /> : <EyeOff size={12} />}
                </Button>

                {paints.length > 1 && (
                  <Button
                    size="icon"
                    type="button"
                    onClick={() => {
                      onRemove(idx);
                      if (activePicker?.index === idx) onPick(null);
                    }}
                    title={t("paint.removeFill")}
                    aria-label={t("paint.removeFill")}
                  >
                    <Minus size={12} />
                  </Button>
                )}
              </>
            }
          />
        );
      })}
    </div>
  );
}

function DraftTextRows({
  textStyle,
  doc,
  docRef,
  onChange,
  onCommitTokenEdit
}: {
  textStyle: TextStyleDeclaration;
  doc?: DesignDocument;
  docRef?: { current: DesignDocument };
  onChange: (patch: Partial<TextStyleDeclaration>) => void;
  /** The edit drafts here are the style form's undo unit; a token edit inside
      the picker is a document-level save instead (docRef-only path). */
  onCommitTokenEdit: (newDoc: DesignDocument) => void;
}) {
  const [tokenPicker, setTokenPicker] = useState<{
    prop: "fontSize" | "lineHeight" | "letterSpacing";
    anchor: HTMLElement;
  } | null>(null);

  const resolveTokenName = (prop: "fontSize" | "lineHeight" | "letterSpacing") => {
    const boundId = textStyle.tokenBindings?.[prop];
    return boundId && doc ? findNumberToken(doc.tokens ?? [], boundId)?.name : undefined;
  };

  const handleDetach = (prop: "fontSize" | "lineHeight" | "letterSpacing") => {
    const next = { ...textStyle.tokenBindings };
    delete next[prop];
    onChange({ tokenBindings: Object.keys(next).length > 0 ? next : undefined });
  };

  return (
    <div className="space-y-2 text-ui">
      <FontFamilyPicker
        value={textStyle.fontFamily || DEFAULT_FONT_FAMILY}
        onChange={(fontFamily) => onChange({ fontFamily })}
      />
      <div className="grid grid-cols-2 gap-2">
        <Select value={String(textStyle.fontWeight || 400)} onChange={(val) => onChange({ fontWeight: Number(val) })}>
          <option value="400">{t("typography.weightRegular")}</option>
          <option value="500">{t("typography.weightMedium")}</option>
          <option value="600">{t("typography.weightSemiBold")}</option>
          <option value="700">{t("typography.weightBold")}</option>
        </Select>
        <ScrubInput
          label={t("typography.size")}
          value={textStyle.fontSize || 16}
          min={1}
          tokenName={resolveTokenName("fontSize")}
          onDetachToken={textStyle.tokenBindings?.fontSize ? () => handleDetach("fontSize") : undefined}
          onOpenTokenPicker={(anchor) => setTokenPicker({ prop: "fontSize", anchor })}
          onChange={(val) => {
            if (textStyle.tokenBindings?.fontSize) {
              const next = { ...textStyle.tokenBindings };
              delete next.fontSize;
              onChange({ fontSize: val, tokenBindings: Object.keys(next).length > 0 ? next : undefined });
            } else {
              onChange({ fontSize: val });
            }
          }}
        />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <LineHeightField
          value={textStyle.lineHeight}
          fontSize={textStyle.fontSize || 16}
          tokenName={resolveTokenName("lineHeight")}
          onDetachToken={textStyle.tokenBindings?.lineHeight ? () => handleDetach("lineHeight") : undefined}
          onOpenTokenPicker={(anchor) => setTokenPicker({ prop: "lineHeight", anchor })}
          onChange={(lh) => {
            if (textStyle.tokenBindings?.lineHeight) {
              const next = { ...textStyle.tokenBindings };
              delete next.lineHeight;
              onChange({ lineHeight: lh, tokenBindings: Object.keys(next).length > 0 ? next : undefined });
            } else {
              onChange({ lineHeight: lh });
            }
          }}
        />
        <LetterSpacingField
          value={textStyle.letterSpacing}
          tokenName={resolveTokenName("letterSpacing")}
          onDetachToken={textStyle.tokenBindings?.letterSpacing ? () => handleDetach("letterSpacing") : undefined}
          onOpenTokenPicker={(anchor) => setTokenPicker({ prop: "letterSpacing", anchor })}
          onChange={(ls) => {
            if (textStyle.tokenBindings?.letterSpacing) {
              const next = { ...textStyle.tokenBindings };
              delete next.letterSpacing;
              onChange({ letterSpacing: ls, tokenBindings: Object.keys(next).length > 0 ? next : undefined });
            } else {
              onChange({ letterSpacing: ls });
            }
          }}
        />
      </div>

      <div className={ROW_SPREAD_GAP_CLASS}>
        <span className={`${SUB_LABEL_CLASS} shrink-0`}>{t("typography.decoration")}</span>
        <ToggleGroup<string>
          className="flex-1"
          values={[
            ...(textStyle.fontStyle === "italic" ? ["italic"] : []),
            ...DECORATION_LINES.filter((line) => hasDecoration(textStyle.textDecoration, line))
          ]}
          onToggle={(value, next) => {
            if (value === "italic") {
              onChange({ fontStyle: next ? "italic" : undefined });
              return;
            }
            const lines = toggledDecoration(textStyle.textDecoration, value as TextDecorationLine, next);
            onChange({ textDecoration: lines.length > 0 ? lines : undefined });
          }}
          items={[
            { value: "italic", icon: <Italic size={11} />, title: t("typography.styleItalic"), grow: true },
            { value: "underline", icon: <Underline size={11} />, title: t("typography.decorationUnderline"), grow: true },
            { value: "line-through", icon: <Strikethrough size={11} />, title: t("typography.decorationStrikethrough"), grow: true }
          ]}
        />
      </div>

      <div className={ROW_SPREAD_GAP_CLASS}>
        <span className={`${SUB_LABEL_CLASS} shrink-0`}>{t("typography.case")}</span>
        <SegmentedControl<string>
          className="flex-1"
          value={textStyle.textTransform || "none"}
          onChange={(v) =>
            onChange({ textTransform: v === "none" ? undefined : (v as TextStyleDeclaration["textTransform"]) })
          }
          items={[
            { value: "none", icon: <Minus size={11} />, title: t("typography.caseNone"), grow: true },
            { value: "uppercase", label: "AA", title: t("typography.caseUpper"), grow: true },
            { value: "lowercase", label: "aa", title: t("typography.caseLower"), grow: true },
            { value: "capitalize", label: "Aa", title: t("typography.caseTitle"), grow: true }
          ]}
        />
      </div>

      {doc && tokenPicker && (
        <NumberTokenPicker
          doc={doc}
          docRef={docRef}
          anchor={tokenPicker.anchor}
          boundTokenId={textStyle.tokenBindings?.[tokenPicker.prop]}
          category="typography"
          onSelect={(tok) => {
            if (docRef && !docRef.current.tokens?.some((t) => t.id === tok.id)) {
              docRef.current = addTokenToDoc(docRef.current, tok);
            }
            const nextBindings = { ...(textStyle.tokenBindings || {}), [tokenPicker.prop]: tok.id };
            onChange({
              [tokenPicker.prop]: numberTokenPropValue(tokenPicker.prop, tok.value),
              tokenBindings: nextBindings
            });
            setTokenPicker(null);
          }}
          onDetach={() => {
            handleDetach(tokenPicker.prop);
            setTokenPicker(null);
          }}
          onCommitSnapshot={onCommitTokenEdit}
          onClose={() => setTokenPicker(null)}
        />
      )}
    </div>
  );
}

function DraftStrokeRows({
  strokes,
  doc,
  docRef,
  activePicker,
  onPick,
  onRemove,
  onToggle,
  onUpdateStroke
}: {
  strokes: Stroke[];
  doc?: DesignDocument;
  docRef?: { current: DesignDocument };
  activePicker: { index: number; anchor: HTMLElement } | null;
  onPick: (next: { index: number; anchor: HTMLElement } | null) => void;
  onRemove: (index: number) => void;
  onToggle: (index: number, enabled: boolean) => void;
  onUpdateStroke: (index: number, patch: Partial<Stroke>, discrete?: boolean) => void;
}) {
  /* Cap, join, miter, dashes, alignment and per-side weights are the LINE's
     settings, not the paint's, so they live in the same panel the layer inspector
     opens (`StrokePanel`) rather than a second spelling of them here. */
  const [settings, setSettings] = useState<{ index: number; anchor: HTMLElement } | null>(null);
  const imageUri = paintImageUri(doc ?? docRef?.current);

  return (
    <div className="space-y-1.5">
      {strokes.map((stroke, idx) => {
        const isEnabled = stroke.enabled !== false;
        const isOpen = activePicker?.index === idx;
        const strokeColor = stroke.color || "#000000";
        const strokePaint: Paint = stroke.paint || { type: "solid", color: strokeColor };

        const visTitle = isEnabled ? t("paint.hideStroke") : t("paint.showStroke");
        const remTitle = t("paint.removeStroke");
        return (
          <ColorRow
            key={idx}
            dataRowId={idx}
            paint={strokePaint}
            color={strokeColor}
            doc={doc}
            docRef={docRef}
            disabled={!isEnabled}
            isOpen={isOpen}
            swatchBackground={paintSwatchBackground(strokePaint, strokeColor, imageUri)}
            label={paintRowLabel(strokePaint)}
            showAlpha={false}
            hexClassName="max-w-[48px] shrink"
            // A row follows the token named on the CANONICAL slot (`stroke.tokenId`)
            // or, for documents written before it, on the nested solid paint.
            tokenId={stroke.tokenId ?? (strokePaint.type === "solid" ? strokePaint.tokenId : undefined)}
            trailing={
              <>
                <button
                  type="button"
                  data-stroke-settings={idx}
                  onClick={(e) => {
                    e.stopPropagation();
                    setSettings((cur) =>
                      cur?.index === idx ? null : { index: idx, anchor: e.currentTarget as HTMLElement }
                    );
                  }}
                  className="text-ink-dim hover:text-ink p-0.5 rounded-ctl hover:bg-raised transition-colors cursor-default shrink-0"
                  title={t("paint.settings")}
                  aria-label={t("paint.settings")}
                >
                  <SlidersHorizontal size={12} />
                </button>
                <div className="w-14 shrink-0">
                  <ScrubInput
                    compact
                    label="W"
                    value={stroke.width || 1}
                    min={0}
                    onChange={(w) => onUpdateStroke(idx, { width: w })}
                  />
                </div>
                <Button
                  size="icon"
                  type="button"
                  onClick={() => onToggle(idx, !isEnabled)}
                  title={visTitle}
                  aria-label={visTitle}
                >
                  {isEnabled ? <Eye size={12} /> : <EyeOff size={12} className="text-ink-muted" />}
                </Button>
                <Button
                  size="icon"
                  type="button"
                  onClick={() => onRemove(idx)}
                  title={remTitle}
                  aria-label={remTitle}
                >
                  <Minus size={12} />
                </Button>
              </>
            }
            onChange={(nextColor) => {
              onUpdateStroke(idx, {
                color: nextColor,
                paint: { type: "solid", color: nextColor }
              });
            }}
            onOpenColorPanel={(anchor) => {
              onPick(isOpen ? null : { index: idx, anchor });
            }}
            onBindToken={(token) => {
              if (docRef && !docRef.current.tokens?.some((t) => t.id === token.id)) {
                docRef.current = addTokenToDoc(docRef.current, token);
              }
              const color = colorTokenColor(token, docRef?.current?.activeTheme);
              onUpdateStroke(idx, {
                color,
                tokenId: token.id,
                paint: { type: "solid", color, tokenId: token.id }
              });
            }}
            onDetachToken={() => {
              const next = { ...stroke, paint: { type: "solid" as const, color: strokeColor } };
              delete next.tokenId;
              onUpdateStroke(idx, next);
            }}
          />
        );
      })}

      {settings && strokes[settings.index] && (
        <StrokePanel
          stroke={strokes[settings.index]}
          anchor={settings.anchor}
          onClose={() => setSettings(null)}
          onChange={(patch, discrete) =>
            onUpdateStroke(settings.index, { ...strokes[settings.index], ...patch }, discrete)
          }
          onGestureStart={() => {}}
          onGestureEnd={() => {}}
        />
      )}
    </div>
  );
}

function StyleBannerPreview({
  styleType,
  drafts,
  doc
}: {
  styleType: StyleType;
  drafts: StyleDrafts;
  doc?: DesignDocument;
}) {
  if (styleType === "paint") return <PaintBanner paints={drafts.paints} doc={doc} />;
  if (styleType === "stroke") return <StrokeBanner strokes={drafts.strokes} />;
  if (styleType === "text") return <TextBanner style={drafts.textStyle} />;
  return <EffectBanner effects={drafts.effects} />;
}

function StrokeBanner({ strokes }: { strokes: Stroke[] }) {
  const top = strokes.find((s) => s.enabled !== false);
  const color = top?.color || (top?.paint?.type === "solid" ? top.paint.color : "#D9D9D9");
  return (
    <div className="w-full h-20 rounded-ctl border border-rule-strong bg-inset flex items-center justify-center p-3">
      <div
        className="w-16 h-10 rounded-ctl"
        style={{
          borderWidth: `${Math.min(top?.width || 1, 8)}px`,
          borderColor: color,
          borderStyle: top?.style === "dashed" ? "dashed" : "solid"
        }}
      />
    </div>
  );
}

function PaintBanner({ paints, doc }: { paints: Paint[]; doc?: DesignDocument }) {
  /* `PaintStackSwatch`, not a third copy of the layer loop. The banner and the
     style card's mark are the same object at two sizes, and the banner was the
     one place that composited the stack itself — without an `imageUri`, so an
     image fill previewed as an empty checkerboard (which is why this read as
     "no preview at all"). The swatch already stacks solid/gradient/image/pattern
     bottom-first over the checker, with each layer's alpha. */
  return <PaintStackSwatch paints={paints} imageUri={paintImageUri(doc)} className="w-full h-24" />;
}

function TextBanner({ style }: { style: TextStyleDeclaration }) {
  return (
    /* `inset`, not `panel`: the popover this sits in is `panel` (POPOVER_SURFACE_CLASS),
       so a `panel` banner measured the same rgb as its own container and the
       preview had no plate under it. One step DOWN reads as a well. */
    <div className="w-full h-20 rounded-ctl border border-rule-strong bg-inset flex items-center justify-center p-3 text-center overflow-hidden">
      <span
        className="text-ink"
        style={{
          fontFamily: resolveStack(style.fontFamily),
          fontWeight: style.fontWeight,
          fontSize: Math.min(style.fontSize || 16, 24)
        }}
      >
        {t("styles.previewText")}
      </span>
    </div>
  );
}

function EffectBanner({ effects }: { effects: Effect[] }) {
  const active = effects.filter((e) => e.enabled !== false);
  const shadows = active
    .map((e) => {
      if (e.type !== "drop-shadow" && e.type !== "inner-shadow") return null;
      const inset = e.type === "inner-shadow" ? "inset " : "";
      const spread = e.spread ? `${e.spread}px ` : "";
      return `${inset}${e.offset?.x ?? 0}px ${e.offset?.y ?? 0}px ${e.blur ?? 0}px ${spread}${e.color || "rgba(0,0,0,0.4)"}`;
    })
    .filter((s): s is string => !!s)
    .join(", ");
  const layerBlur = active.find((e) => e.type === "layer-blur")?.blur ?? 0;

  /* The tile IS the caster — the same move `EffectRows` makes, and for the same
     reason: a shadow with no object on it is not a preview, it is a smudge. The
     sparkle that used to sit in the middle added nothing the tile was not
     already saying, and it was the only thing in this banner that did not scale
     with the effect. */
  return (
    <div className="w-full h-20 rounded-ctl border border-rule-strong bg-inset flex items-center justify-center">
      <div
        className="w-12 h-12 rounded-ctl bg-raised"
        style={{ boxShadow: shadows || undefined, filter: layerBlur ? cssBlurFilter(layerBlur) : undefined }}
      />
    </div>
  );
}
