import type {
  ColorToken,
  ColorTokenValue,
  DocumentMode,
  NumberToken,
  NumberTokenCategory,
  NumberTokenValue,
  TokenAliasRef
} from "../../core/dsl/types";
import { isTokenAliasRef, type TokenLookup } from "../../core/dsl/token-value";
import {
  getColorTokenModeColor,
  getNumberTokenModeValue,
  updateColorTokenWithModes,
  updateNumberTokenWithModes,
  type ColorModePatch
} from "../../core/interactions/mode-ops";
import { parseColorAlpha } from "../../core/geometry/color-utils";
import { tokenAlphaPct } from "../../core/interactions/token-ops";

/**
 * The table's write path: "this token, that value, this mode" reduced to the
 * patch map the mode ops take. Five handlers rebuilt that map by hand, so a
 * rename and a value edit could disagree about an untouched mode's spelling.
 */
function baseModeColorPatches(
  token: ColorToken,
  modes: DocumentMode[],
  baseModeId: string,
  edit?: { id: string; patch?: ColorModePatch | TokenAliasRef },
  tokens?: TokenLookup
): Record<string, ColorTokenValue | ColorModePatch | undefined> {
  const patches: Record<string, ColorTokenValue | ColorModePatch | undefined> = {};
  for (const mode of modes) {
    if (mode.id === baseModeId) continue;
    // The edited mode is written by `edit` alone: re-reading it here would put
    // the old value back over the new one.
    if (edit && mode.id === edit.id) continue;
    const raw = token.modes?.[mode.id];
    if (!raw) continue;
    if (isTokenAliasRef(raw)) {
      patches[mode.id] = { ref: raw.ref };
      continue;
    }
    patches[mode.id] = {
      color: parseColorAlpha(getColorTokenModeColor(token, mode.id, tokens)).hex6,
      opacity: tokenAlphaPct(token, mode.id, tokens) / 100
    };
  }
  if (edit && edit.id !== baseModeId && edit.patch) patches[edit.id] = edit.patch;
  return patches;
}

function baseModeValuePatches(
  token: NumberToken,
  modes: DocumentMode[],
  baseModeId: string,
  edit?: { id: string; value?: NumberTokenValue },
  tokens?: TokenLookup
): Record<string, NumberTokenValue | undefined> {
  const patches: Record<string, NumberTokenValue | undefined> = {};
  for (const mode of modes) {
    if (mode.id === baseModeId) continue;
    if (edit && mode.id === edit.id) continue;
    const raw = token.modes?.[mode.id];
    if (raw === undefined) continue;
    patches[mode.id] = isTokenAliasRef(raw)
      ? { ref: raw.ref }
      : getNumberTokenModeValue(token, mode.id, tokens);
  }
  if (edit && edit.id !== baseModeId && edit.value !== undefined) patches[edit.id] = edit.value;
  return patches;
}

export interface ColorTokenPatch {
  name?: string;
  description?: string;
  /** Base-mode value or alias ref. */
  color?: ColorTokenValue;
  opacity?: number;
  /** One override; an absent `patch` CLEARS that mode back to the base. */
  mode?: { id: string; patch?: ColorModePatch | TokenAliasRef };
}

export function writeColorToken(
  token: ColorToken,
  modes: DocumentMode[],
  baseModeId: string,
  patch: ColorTokenPatch,
  tokens?: TokenLookup
): ColorToken {
  let baseColor: ColorTokenValue;
  let baseOpacity: number | undefined;
  if (isTokenAliasRef(patch.color)) {
    baseColor = { ref: patch.color.ref };
    baseOpacity = undefined;
  } else if (patch.color === undefined && patch.opacity === undefined && isTokenAliasRef(token.value)) {
    baseColor = { ref: token.value.ref };
    baseOpacity = undefined;
  } else {
    baseColor =
      typeof patch.color === "string"
        ? patch.color
        : parseColorAlpha(getColorTokenModeColor(token, baseModeId, tokens)).hex6;
    baseOpacity = patch.opacity ?? tokenAlphaPct(token, baseModeId, tokens) / 100;
  }
  return updateColorTokenWithModes(
    token,
    patch.name ?? token.name,
    baseColor,
    baseModeColorPatches(token, modes, baseModeId, patch.mode, tokens),
    patch.description ?? token.description,
    baseOpacity,
    baseModeId
  );
}

export interface NumberTokenPatch {
  name?: string;
  description?: string;
  category?: NumberTokenCategory;
  /** Base-mode value or alias ref. */
  value?: NumberTokenValue;
  /** One override; an absent `value` CLEARS that mode back to the base. */
  mode?: { id: string; value?: NumberTokenValue };
}

export function writeNumberToken(
  token: NumberToken,
  modes: DocumentMode[],
  baseModeId: string,
  patch: NumberTokenPatch,
  tokens?: TokenLookup
): NumberToken {
  const nextValue: NumberTokenValue =
    patch.value !== undefined
      ? patch.value
      : isTokenAliasRef(token.value)
        ? { ref: token.value.ref }
        : getNumberTokenModeValue(token, baseModeId, tokens);
  return updateNumberTokenWithModes(
    token,
    patch.name ?? token.name,
    patch.category ?? token.category,
    nextValue,
    baseModeValuePatches(token, modes, baseModeId, patch.mode, tokens),
    patch.description ?? token.description,
    baseModeId
  );
}
