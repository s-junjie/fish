import { useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import type { ColorToken, DesignDocument, Paint } from "../../core/dsl/types";
import { isGradientPaint, buildCssGradient } from "../../core/geometry/gradient-utils";
import { parseColorAlpha, composeColorAlpha } from "../../core/geometry/color-utils";
import { ColorTokenPicker } from "./ColorTokenPicker";
import { HexInput } from "../HexInput";
import { ScrubInput } from "../ScrubInput";
import { Button } from "../Button";
import { Tag } from "lucide-react";
import { TokenTag } from "../TokenTag";
import { t } from "../../i18n";
import {
  PAINT_ALPHA_CONTAINER_CLASS,
  PAINT_HEX_FIELD_CLASS,
  PAINT_ROW_CLASS,
  PAINT_ROW_RULE_IDLE,
  PAINT_ROW_RULE_OPEN,
  PAINT_SWATCH_CHECKER,
  PAINT_SWATCH_CLASS
} from "./paint-row-style";

export interface ColorRowProps {
  /** Solid hex color or CSS string (e.g. "#FFFFFF", "rgba(0,0,0,0.5)"). */
  color?: string;
  /** Complete paint object if this row represents a fill/stroke paint layer. */
  paint?: Paint;
  /** Token ID if bound to a color token. */
  tokenId?: string;
  /** Document instance to resolve color tokens. */
  doc?: DesignDocument;
  docRef?: { current: DesignDocument };

  /** Custom swatch background override (e.g. for image paint, pattern or gradient). */
  swatchBackground?: string;
  /** Custom label when paint is non-solid (e.g. "Linear", "Radial", "Image", "Pattern"). */
  label?: string;

  /** Whether the row is currently disabled / hidden (reduced opacity). */
  disabled?: boolean;
  /** Whether the row's color panel is currently open (highlight border). */
  isOpen?: boolean;

  /** Whether to show the alpha ScrubInput on raw solid rows (defaults to true). */
  showAlpha?: boolean;
  /** Custom effective alpha percentage (0-100) if different from parsed color alpha. */
  effectiveAlpha?: number;

  /** Called when color/hex/alpha changes. `discrete` is true for a typed or
   *  clicked value, false for a frame of the alpha scrub. */
  onChange?: (nextColor: string, nextAlpha?: number, discrete?: boolean) => void;
  onCommit?: () => void;
  onGestureStart?: () => void;
  onGestureEnd?: () => void;

  /** Swatch click handler to open external color panel (e.g. ColorPanel). */
  onOpenColorPanel?: (anchor: HTMLElement) => void;

  /** Token binding handlers. If provided, Tag and Detach buttons are rendered. */
  onBindToken?: (token: ColorToken) => void;
  onDetachToken?: () => void;

  /** Optional leading element (e.g. drag handle, drop indicator). */
  leading?: ComponentChildren;
  /** Optional trailing element(s) (e.g. visibility toggle, remove button, crosshair). */
  trailing?: ComponentChildren;

  /** Custom data attributes for testing or identifying the row. */
  dataRowId?: string | number;
  dataHexId?: string;
  className?: string;
  hexClassName?: string;
}

export function ColorRow({
  color,
  paint,
  tokenId,
  doc,
  docRef,
  swatchBackground,
  label,
  disabled = false,
  isOpen = false,
  showAlpha = true,
  effectiveAlpha: customAlpha,
  onChange,
  onCommit,
  onGestureStart,
  onGestureEnd,
  onOpenColorPanel,
  onBindToken,
  onDetachToken,
  leading,
  trailing,
  dataRowId,
  dataHexId,
  className = "",
  hexClassName
}: ColorRowProps) {
  const [tokenPickerAnchor, setTokenPickerAnchor] = useState<HTMLElement | null>(null);

  const isSolid = paint ? paint.type === "solid" : true;
  const isImage = paint ? paint.type === "image" : false;
  const rawColor = paint && paint.type === "solid" ? paint.color : (color ?? "#000000");
  const parsed = isSolid ? parseColorAlpha(rawColor) : { hex6: "#FFFFFF", alphaPct: 100 };

  const effectiveAlpha =
    typeof customAlpha === "number"
      ? customAlpha
      : paint && typeof paint.opacity === "number"
      ? Math.round(paint.opacity * 100)
      : parsed.alphaPct;

  const boundToken =
    doc && tokenId
      ? (doc.tokens || []).find(
          (entry): entry is ColorToken => entry.type === "color" && entry.id === tokenId
        )
      : undefined;
  const isMissingToken = Boolean(tokenId && !boundToken);
  const isBound = Boolean(boundToken || isMissingToken);

  let bg = swatchBackground;
  if (!bg) {
    if (paint) {
      if (paint.type === "solid") {
        bg = rawColor;
      } else if (isGradientPaint(paint)) {
        bg = buildCssGradient(paint);
      } else {
        bg = rawColor;
      }
    } else {
      bg = rawColor;
    }
  }

  const handleSwatchClick = (e: MouseEvent) => {
    const el = e.currentTarget as HTMLElement;
    if (isBound && onBindToken) {
      setTokenPickerAnchor((cur) => (cur ? null : el));
    } else if (onOpenColorPanel) {
      onOpenColorPanel(el);
    }
  };

  const handleAlphaChange = (pct: number, discrete?: boolean) => {
    if (!onChange) return;
    if (isSolid) {
      onChange(composeColorAlpha(parsed.hex6, pct), pct, discrete);
    } else {
      onChange(rawColor, pct, discrete);
    }
  };

  const swatchTitle = isBound
    ? (boundToken ? boundToken.name : t("tokens.missing"))
    : t("paint.edit");

  return (
    <>
      <div
        data-paint-row={dataRowId}
        className={`group ${PAINT_ROW_CLASS} ${isOpen ? PAINT_ROW_RULE_OPEN : PAINT_ROW_RULE_IDLE} ${
          disabled ? "opacity-50" : ""
        } ${className}`}
      >
        {leading}

        {/* Swatch Preview with checkerboard backing */}
        <div
          data-paint-swatch={dataRowId}
          onClick={handleSwatchClick}
          className={`${PAINT_SWATCH_CLASS} cursor-pointer`}
          style={PAINT_SWATCH_CHECKER}
          title={swatchTitle}
        >
          <div
            className="absolute inset-0"
            style={{
              background: bg,
              opacity: isSolid ? 1 : effectiveAlpha / 100
            }}
          />
        </div>

        {/* Label / Hex / Token Name */}
        {isBound ? (
          <div className="flex-1 min-w-0 flex items-center">
            <TokenTag
              name={boundToken ? boundToken.name : t("tokens.missing")}
              missing={isMissingToken}
              title={
                boundToken
                  ? `${boundToken.name} (${parsed.hex6.toUpperCase()})`
                  : `${t("tokens.missing")}: ${tokenId}`
              }
              onClick={(e) => {
                if (onBindToken) {
                  setTokenPickerAnchor((cur) => (cur ? null : (e.currentTarget as HTMLElement)));
                }
              }}
              onDblClick={(e) => {
                e.stopPropagation();
                onDetachToken?.();
              }}
              onDetach={onDetachToken}
              tagProps={{
                ...(boundToken ? { "data-paint-token": boundToken.id } : {}),
                ...(isMissingToken ? { "data-paint-token-missing": tokenId } : {})
              }}
              detachProps={
                tokenId ? { "data-paint-token-detach": tokenId } : undefined
              }
            />
          </div>
        ) : isSolid ? (
          <HexInput
            value={parsed.hex6}
            data-hex-input={dataHexId}
            onChange={(nextHex, nextAlpha) => {
              if (onChange) {
                onChange(
                  composeColorAlpha(nextHex, nextAlpha ?? parsed.alphaPct),
                  nextAlpha ?? parsed.alphaPct,
                  true
                );
              }
            }}
            onCommit={onCommit}
            className={`${PAINT_HEX_FIELD_CLASS} ${hexClassName ?? ""}`}
          />
        ) : (
          <button
            type="button"
            onClick={(e) => {
              if (onOpenColorPanel) onOpenColorPanel(e.currentTarget as HTMLElement);
            }}
            className="flex-1 min-w-0 text-left truncate cursor-pointer select-none text-row text-ink-dim hover:text-ink capitalize bg-transparent"
          >
            {label ?? (paint ? paint.type : "")}
          </button>
        )}

        {/* Alpha % Scrub — hide when bound to a token */}
        {!isBound && showAlpha && (!isImage) && (
          <div className={PAINT_ALPHA_CONTAINER_CLASS}>
            <ScrubInput
              compact
              label="%"
              value={effectiveAlpha}
              min={0}
              max={100}
              onChange={handleAlphaChange}
              onDragStart={onGestureStart}
              onDragEnd={onGestureEnd ?? onCommit}
            />
          </div>
        )}

        {/* Token Bind Slot (only when not bound) */}
        {onBindToken && isSolid && !isBound && (
          <Button
            size="icon"
            type="button"
            data-paint-token-bind={dataRowId}
            onClick={(e) => {
              e.stopPropagation();
              setTokenPickerAnchor((cur) => (cur ? null : (e.currentTarget as HTMLElement)));
            }}
            title={t("tokens.bind")}
            aria-label={t("tokens.bind")}
            className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity duration-base ease-snap"
          >
            <Tag size={13} />
          </Button>
        )}

        {trailing}
      </div>

      {doc && tokenPickerAnchor && onBindToken && (
        <ColorTokenPicker
          doc={doc}
          docRef={docRef}
          anchor={tokenPickerAnchor}
          currentColor={parsed.hex6}
          boundTokenId={tokenId}
          onSelect={(token) => {
            onBindToken(token);
            setTokenPickerAnchor(null);
          }}
          onDetach={() => {
            onDetachToken?.();
            setTokenPickerAnchor(null);
          }}
          onClose={() => setTokenPickerAnchor(null)}
        />
      )}
    </>
  );
}
