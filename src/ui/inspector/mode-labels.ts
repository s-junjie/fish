import type { BaseToken, ColorToken, DocumentMode, NumberToken } from "../../core/dsl/types";
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

export function colorModeLabels(token: ColorToken, modes: DocumentMode[]): string[] {
  return modesHoldingValue(token, modes).map((mode) => {
    const { hex6, alphaPct } = parseColorAlpha(getColorTokenModeColor(token, mode.id));
    const hex = hex6.toUpperCase();
    return alphaPct < 100 ? `${hex}${DOT}${alphaPct}%` : hex;
  });
}

export function numberModeLabels(token: NumberToken, modes: DocumentMode[]): string[] {
  return modesHoldingValue(token, modes).map(
    (mode) => `${getNumberTokenModeValue(token, mode.id)}px`
  );
}
