import { useState } from "preact/hooks";
import type { ColorToken, DesignDocument, Paint, Stroke, TextStyleDeclaration, TextDecorationLine } from "../../core/dsl/types";
import { parseColorAlpha } from "../../core/geometry/color-utils";
import { paintRowLabel, paintSwatchBackground, paintImageUri, IMAGE_SWATCH_FALLBACK } from "./paint-preview";
import { stackRows } from "../../core/dsl/paint-stack";
import { t } from "../../i18n";
import { DEFAULT_FONT_FAMILY } from "../../core/font-stack";
import { StrokePanel } from "./StrokePanel";
import { ColorRow } from "./ColorRow";
import { NumberTokenPicker } from "./NumberTokenPicker";
import { findNumberToken, numberTokenPropValue } from "../../core/interactions/number-token-ops";
import { addTokenToDoc } from "../../core/interactions/style-ops";
import { colorTokenColor } from "../../core/interactions/token-ops";
import { ScrubInput } from "../ScrubInput";
import { TypographyFields, type TypographyNumberProp } from "./typography-fields";
import { Eye, EyeOff, Minus, SlidersHorizontal } from "lucide-react";
import { Button } from "../Button";
import { DECORATION_LINES, hasDecoration, toggledDecoration } from "../../core/dsl/text-decoration";

export function DraftPaintRows({
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

export function DraftTextRows({
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
    prop: TypographyNumberProp;
    anchor: HTMLElement;
  } | null>(null);

  const bindings = textStyle.tokenBindings;
  const tokenName = (prop: TypographyNumberProp) => {
    const boundId = bindings?.[prop];
    return boundId && doc ? findNumberToken(doc.tokens ?? [], boundId)?.name : undefined;
  };

  const withoutBinding = (prop: TypographyNumberProp) => {
    const next = { ...bindings };
    delete next[prop];
    return Object.keys(next).length > 0 ? next : undefined;
  };

  /** Typing into a bound field detaches it: the draft now holds a value, and a
      binding it did not author would overwrite that value on the next sync. */
  const apply = (patch: Partial<TextStyleDeclaration>) => {
    const touched = (["fontSize", "lineHeight", "letterSpacing"] as const).find((key) => key in patch);
    onChange(
      touched && bindings?.[touched] ? { ...patch, tokenBindings: withoutBinding(touched) } : patch
    );
  };

  return (
    <div className="space-y-2 text-ui">
      <TypographyFields
        fontFamily={textStyle.fontFamily || DEFAULT_FONT_FAMILY}
        fontWeight={textStyle.fontWeight || 400}
        fontSize={textStyle.fontSize || 16}
        lineHeight={textStyle.lineHeight}
        letterSpacing={textStyle.letterSpacing}
        textTransform={textStyle.textTransform}
        tokens={{
          fontSize: { name: tokenName("fontSize"), onDetach: bindings?.fontSize ? () => apply({ tokenBindings: withoutBinding("fontSize") }) : undefined },
          lineHeight: { name: tokenName("lineHeight"), onDetach: bindings?.lineHeight ? () => apply({ tokenBindings: withoutBinding("lineHeight") }) : undefined },
          letterSpacing: { name: tokenName("letterSpacing"), onDetach: bindings?.letterSpacing ? () => apply({ tokenBindings: withoutBinding("letterSpacing") }) : undefined }
        }}
        onOpenTokenPicker={(prop, anchor) => setTokenPicker({ prop, anchor })}
        onChange={apply}
        showCase
        decoration={{
          values: [
            ...(textStyle.fontStyle === "italic" ? ["italic"] : []),
            ...DECORATION_LINES.filter((line) => hasDecoration(textStyle.textDecoration, line))
          ],
          onToggle: (value, next) => {
            if (value === "italic") {
              apply({ fontStyle: next ? "italic" : undefined });
              return;
            }
            const lines = toggledDecoration(textStyle.textDecoration, value as TextDecorationLine, next);
            apply({ textDecoration: lines.length > 0 ? lines : undefined });
          }
        }}
      />

      {doc && tokenPicker && (
        <NumberTokenPicker
          doc={doc}
          docRef={docRef}
          anchor={tokenPicker.anchor}
          boundTokenId={bindings?.[tokenPicker.prop]}
          category="typography"
          onSelect={(tok) => {
            if (docRef && !docRef.current.tokens?.some((t) => t.id === tok.id)) {
              docRef.current = addTokenToDoc(docRef.current, tok);
            }
            const nextBindings = { ...(bindings || {}), [tokenPicker.prop]: tok.id };
            onChange({
              [tokenPicker.prop]: numberTokenPropValue(tokenPicker.prop, tok.value),
              tokenBindings: nextBindings
            });
            setTokenPicker(null);
          }}
          onDetach={() => {
            apply({ tokenBindings: withoutBinding(tokenPicker.prop) });
            setTokenPicker(null);
          }}
          onCommitSnapshot={onCommitTokenEdit}
          onClose={() => setTokenPicker(null)}
        />
      )}
    </div>
  );
}

export function DraftStrokeRows({
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
