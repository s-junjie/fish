import { Link2, X } from "lucide-react";
import type { ColorToken, NumberToken } from "../../core/dsl/types";
import {
  isTokenAliasRef,
  lookupToken,
  rawTokenSlot,
  tryColorTokenValue,
  tryNumberTokenValue,
  type TokenLookup
} from "../../core/dsl/token-value";
import { parseColorAlpha } from "../../core/geometry/color-utils";
import { getColorTokenModeColor, getNumberTokenModeValue } from "../../core/interactions/mode-ops";
import { tokenAlphaPct } from "../../core/interactions/token-ops";
import { t } from "../../i18n";
import { HexInput } from "../HexInput";
import { ScrubInput } from "../ScrubInput";
import { PAINT_SWATCH_CHECKER, PAINT_SWATCH_CLASS } from "../inspector/paint-row-style";

interface ColorModeCellProps {
  token: ColorToken;
  modeId: string;
  baseModeId: string;
  tokenMap: TokenLookup;
  width: number;
  hasOverride: boolean;
  onPickColor: (tokenId: string, modeId: string, el: HTMLElement) => void;
  onColorChange: (token: ColorToken, modeId: string, hex: string, opacity?: number, discrete?: boolean) => void;
  onOpenAliasPicker: (token: ColorToken, modeId: string, el: HTMLElement) => void;
  onDetachAlias: (token: ColorToken, modeId: string) => void;
  /** A drag's frames are transient; the pair makes the whole drag one undo step. */
  onDragStart?: () => void;
  onDragEnd?: () => void;
}

/** The value editor inside a colour-token mode cell: literal swatch+hex+% or compact alias pill. */
export function ColorModeCell({
  token,
  modeId,
  baseModeId,
  tokenMap,
  width,
  hasOverride,
  onPickColor,
  onColorChange,
  onOpenAliasPicker,
  onDetachAlias,
  onDragStart,
  onDragEnd
}: ColorModeCellProps) {
  const rawSlot = rawTokenSlot(token, modeId, baseModeId);
  const isAlias = isTokenAliasRef(rawSlot);
  const resolved = isAlias ? tryColorTokenValue(token, modeId, tokenMap) : undefined;
  const resolvedColor = resolved ?? getColorTokenModeColor(token, modeId, tokenMap);
  const currentHex6 = parseColorAlpha(resolvedColor).hex6;
  const currentOpacity = isAlias
    ? parseColorAlpha(resolvedColor).alphaPct / 100
    : tokenAlphaPct(token, modeId, tokenMap) / 100;

  if (isAlias) {
    const targetCandidate = lookupToken(tokenMap, rawSlot.ref);
    const targetToken = targetCandidate?.type === "color" ? targetCandidate : undefined;
    const isBroken = !targetToken || resolved === undefined;
    const label = targetToken ? targetToken.name : t("tokens.brokenAlias");
    const title = isBroken
      ? t("tokens.brokenAlias")
      : `${targetToken.name} (${currentHex6.toUpperCase()})`;

    return (
      <td
        className="px-3 py-1.5 align-middle shrink-0 border-l border-rule"
        style={{ width: `${width}px`, minWidth: `${width}px` }}
      >
        <div
          className={`flex items-center gap-1.5 h-7 px-1.5 rounded-swatch border transition-colors min-w-0 group/cell relative ${
            isBroken
              ? "bg-inset border-measure-coral"
              : !hasOverride
                ? "bg-inset/40 hover:bg-inset/70 border-rule/40 hover:border-rule"
                : "bg-inset/60 hover:bg-inset border-rule/50 hover:border-rule"
          }`}
        >
          <button
            type="button"
            style={PAINT_SWATCH_CHECKER}
            onClick={(e) => onOpenAliasPicker(token, modeId, e.currentTarget)}
            className={`${PAINT_SWATCH_CLASS} ${
              !hasOverride ? "opacity-40 hover:opacity-100" : ""
            } transition-opacity cursor-pointer shrink-0`}
            title={title}
            aria-label={title}
          >
            <span
              className="block w-full h-full"
              style={{ backgroundColor: currentHex6, opacity: currentOpacity }}
            />
          </button>

          <button
            type="button"
            data-token-alias-pill={modeId}
            onClick={(e) => onOpenAliasPicker(token, modeId, e.currentTarget)}
            title={title}
            className={`flex-1 min-w-0 flex items-center gap-1 h-5 px-1.5 rounded-swatch bg-raised border text-left transition-colors cursor-pointer ${
              isBroken
                ? "border-measure-coral text-measure-coral"
                : "border-rule hover:border-brand/60 text-ink"
            } ${!hasOverride && !isBroken ? "opacity-60 hover:opacity-100" : ""}`}
          >
            <Link2
              size={10}
              className={`shrink-0 ${isBroken ? "text-measure-coral" : "text-brand"}`}
            />
            <span className="truncate text-meta">{label}</span>
          </button>

          {hasOverride && (
            <button
              type="button"
              data-token-alias-detach={modeId}
              onClick={(e) => {
                e.stopPropagation();
                onDetachAlias(token, modeId);
              }}
              title={t("tokens.unlinkAlias")}
              aria-label={t("tokens.unlinkAlias")}
              className="p-0.5 rounded-swatch text-ink-muted hover:text-ink hover:bg-raised transition-colors shrink-0 cursor-pointer"
            >
              <X size={10} />
            </button>
          )}
        </div>
      </td>
    );
  }

  return (
    <td
      className="px-3 py-1.5 align-middle shrink-0 border-l border-rule"
      style={{ width: `${width}px`, minWidth: `${width}px` }}
    >
      <div className="flex items-center gap-1.5 h-7 px-1.5 rounded-swatch bg-inset/60 hover:bg-inset border border-rule/50 hover:border-rule focus-within:border-brand focus-within:bg-inset transition-colors min-w-0 group/cell relative">
        <button
          type="button"
          style={PAINT_SWATCH_CHECKER}
          onClick={(e) => onPickColor(token.id, modeId, e.currentTarget)}
          className={`${PAINT_SWATCH_CLASS} ${
            !hasOverride ? "opacity-40 hover:opacity-100" : ""
          } transition-opacity cursor-pointer shrink-0`}
          title={currentHex6}
          aria-label={currentHex6}
        >
          <span
            className="block w-full h-full"
            style={{ backgroundColor: currentHex6, opacity: currentOpacity }}
          />
        </button>

        <div className="flex-1 min-w-0">
          <HexInput
            value={currentHex6}
            onChange={(nextHex, nextAlpha) => {
              onColorChange(
                token,
                modeId,
                nextHex,
                nextAlpha !== undefined ? nextAlpha / 100 : currentOpacity,
                true
              );
            }}
            className={`w-full bg-transparent text-code uppercase focus:outline-none tabular-nums ${
              !hasOverride ? "text-ink-muted/50" : "text-ink"
            }`}
          />
        </div>

        <div className="w-14 shrink-0">
          <ScrubInput
            compact
            label="%"
            value={Math.round(currentOpacity * 100)}
            min={0}
            max={100}
            onDragStart={onDragStart}
            onDragEnd={onDragEnd}
            onChange={(pct, discrete) => {
              onColorChange(token, modeId, currentHex6, pct / 100, discrete);
            }}
            className={!hasOverride ? "opacity-50 hover:opacity-100" : ""}
          />
        </div>

        <button
          type="button"
          data-token-alias-trigger={modeId}
          onClick={(e) => {
            e.stopPropagation();
            onOpenAliasPicker(token, modeId, e.currentTarget);
          }}
          title={t("tokens.linkAlias")}
          aria-label={t("tokens.linkAlias")}
          className="opacity-0 group-hover/cell:opacity-100 focus:opacity-100 p-0.5 rounded-swatch text-ink-muted hover:text-brand hover:bg-raised transition-all shrink-0 cursor-pointer"
        >
          <Link2 size={10} />
        </button>
      </div>
    </td>
  );
}

interface NumberModeCellProps {
  token: NumberToken;
  modeId: string;
  baseModeId: string;
  tokenMap: TokenLookup;
  width: number;
  hasOverride: boolean;
  onValueChange: (token: NumberToken, modeId: string, val: number, discrete?: boolean) => void;
  onOpenAliasPicker: (token: NumberToken, modeId: string, el: HTMLElement) => void;
  onDetachAlias: (token: NumberToken, modeId: string) => void;
  /** A drag's frames are transient; the pair makes the whole drag one undo step. */
  onDragStart?: () => void;
  onDragEnd?: () => void;
}

/** The value editor inside a number-token mode cell: a single scrubber or compact alias pill. */
export function NumberModeCell({
  token,
  modeId,
  baseModeId,
  tokenMap,
  width,
  hasOverride,
  onValueChange,
  onOpenAliasPicker,
  onDetachAlias,
  onDragStart,
  onDragEnd
}: NumberModeCellProps) {
  const rawSlot = rawTokenSlot(token, modeId, baseModeId);
  const isAlias = isTokenAliasRef(rawSlot);
  const resolved = isAlias ? tryNumberTokenValue(token, modeId, tokenMap) : undefined;
  const currentVal = resolved ?? getNumberTokenModeValue(token, modeId, tokenMap);

  if (isAlias) {
    const targetCandidate = lookupToken(tokenMap, rawSlot.ref);
    const targetToken = targetCandidate?.type === "number" ? targetCandidate : undefined;
    const isBroken = !targetToken || resolved === undefined;
    const label = targetToken ? targetToken.name : t("tokens.brokenAlias");
    const title = isBroken ? t("tokens.brokenAlias") : `${targetToken.name} (${currentVal})`;

    return (
      <td
        className="px-3 py-1.5 align-middle shrink-0 border-l border-rule"
        style={{ width: `${width}px`, minWidth: `${width}px` }}
      >
        <div
          className={`flex items-center gap-1 h-7 px-1.5 rounded-swatch border transition-colors min-w-0 max-w-[160px] group/cell relative ${
            isBroken
              ? "bg-inset border-measure-coral"
              : !hasOverride
                ? "bg-inset/40 hover:bg-inset/70 border-rule/40 hover:border-rule"
                : "bg-inset/60 hover:bg-inset border-rule/50 hover:border-rule"
          }`}
        >
          <button
            type="button"
            data-token-alias-pill={modeId}
            onClick={(e) => onOpenAliasPicker(token, modeId, e.currentTarget)}
            title={title}
            className={`flex-1 min-w-0 flex items-center gap-1 h-5 px-1.5 rounded-swatch bg-raised border text-left transition-colors cursor-pointer ${
              isBroken
                ? "border-measure-coral text-measure-coral"
                : "border-rule hover:border-brand/60 text-ink"
            } ${!hasOverride && !isBroken ? "opacity-60 hover:opacity-100" : ""}`}
          >
            <Link2
              size={10}
              className={`shrink-0 ${isBroken ? "text-measure-coral" : "text-brand"}`}
            />
            <span className="truncate text-meta">{label}</span>
            {resolved !== undefined && (
              <span className="text-micro font-mono tabular-nums text-ink-muted shrink-0">
                {resolved}
              </span>
            )}
          </button>

          {hasOverride && (
            <button
              type="button"
              data-token-alias-detach={modeId}
              onClick={(e) => {
                e.stopPropagation();
                onDetachAlias(token, modeId);
              }}
              title={t("tokens.unlinkAlias")}
              aria-label={t("tokens.unlinkAlias")}
              className="p-0.5 rounded-swatch text-ink-muted hover:text-ink hover:bg-raised transition-colors shrink-0 cursor-pointer"
            >
              <X size={10} />
            </button>
          )}
        </div>
      </td>
    );
  }

  return (
    <td
      className="px-3 py-1.5 align-middle shrink-0 border-l border-rule"
      style={{ width: `${width}px`, minWidth: `${width}px` }}
    >
      <div className="flex items-center gap-1 h-7 px-1.5 rounded-swatch bg-inset/60 hover:bg-inset border border-rule/50 hover:border-rule focus-within:border-brand focus-within:bg-inset transition-colors w-fit max-w-[136px] group/cell relative">
        <div className="flex-1 min-w-0">
          <ScrubInput
            compact
            label=""
            value={currentVal}
            onDragStart={onDragStart}
            onDragEnd={onDragEnd}
            onChange={(num, discrete) => onValueChange(token, modeId, num, discrete)}
            className={`w-full bg-transparent ${!hasOverride ? "opacity-50 hover:opacity-100" : ""}`}
          />
        </div>

        <button
          type="button"
          data-token-alias-trigger={modeId}
          onClick={(e) => {
            e.stopPropagation();
            onOpenAliasPicker(token, modeId, e.currentTarget);
          }}
          title={t("tokens.linkAlias")}
          aria-label={t("tokens.linkAlias")}
          className="opacity-0 group-hover/cell:opacity-100 focus:opacity-100 p-0.5 rounded-swatch text-ink-muted hover:text-brand hover:bg-raised transition-all shrink-0 cursor-pointer"
        >
          <Link2 size={10} />
        </button>
      </div>
    </td>
  );
}
