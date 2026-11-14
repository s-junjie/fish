import type { BaseToken, ColorToken, DocumentMode, NumberToken } from "../../core/dsl/types";
import { isTokenAliasRef, lookupToken, rawTokenSlot, type TokenLookup } from "../../core/dsl/token-value";
import {
  getColorTokenModeColor,
  getNumberTokenModeValue
} from "../../core/interactions/mode-ops";
import { parseColorAlpha } from "../../core/geometry/color-utils";

/**
 * No spaces around the dot: in a mono face every space is a full cell, and the
 * dot's own side bearings already separate it from the hex.
 */
const DOT = "\u00b7";

/**
 * One readout per mode that actually holds a value. A mode with no override
 * inherits the base value, so listing it would repeat the same number twice.
 */
function modesHoldingValue(token: BaseToken, modes: DocumentMode[]): DocumentMode[] {
  const baseModeId = modes[0]?.id;
  return modes.filter((mode) => mode.id === baseModeId || token.modes?.[mode.id] !== undefined);
}

function aliasPrefix(token: ColorToken | NumberToken, modeId: string, baseModeId: string | undefined, tokens?: TokenLookup): string | undefined {
  const raw = rawTokenSlot(token, modeId, baseModeId);
  if (!isTokenAliasRef(raw)) return undefined;
  const target = tokens ? lookupToken(tokens, raw.ref) : undefined;
  return `\u2192 ${target?.name ?? raw.ref}`;
}

export function colorModeLabels(token: ColorToken, modes: DocumentMode[], tokens?: TokenLookup): string[] {
  const baseModeId = modes[0]?.id;
  return modesHoldingValue(token, modes).map((mode) => {
    const { hex6, alphaPct } = parseColorAlpha(getColorTokenModeColor(token, mode.id, tokens));
    const hex = hex6.toUpperCase();
    const resolved = alphaPct < 100 ? `${hex}${DOT}${alphaPct}%` : hex;
    const alias = aliasPrefix(token, mode.id, baseModeId, tokens);
    return alias ? `${alias} (${resolved})` : resolved;
  });
}

export function numberModeLabels(token: NumberToken, modes: DocumentMode[], tokens?: TokenLookup): string[] {
  const baseModeId = modes[0]?.id;
  return modesHoldingValue(token, modes).map((mode) => {
    const resolved = String(getNumberTokenModeValue(token, mode.id, tokens));
    const alias = aliasPrefix(token, mode.id, baseModeId, tokens);
    return alias ? `${alias} (${resolved})` : resolved;
  });
}
