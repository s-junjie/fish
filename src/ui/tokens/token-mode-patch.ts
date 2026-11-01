import type { ColorToken, DocumentMode, NumberToken, NumberTokenCategory } from "../../core/dsl/types";
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
  edit?: { id: string; patch?: ColorModePatch }
): Record<string, ColorModePatch | undefined> {
  const patches: Record<string, ColorModePatch | undefined> = {};
  for (const mode of modes) {
    if (mode.id === baseModeId) continue;
    // The edited mode is written by `edit` alone: re-reading it here would put
    // the old value back over the new one.
    if (edit && mode.id === edit.id) continue;
    if (!token.modes?.[mode.id]) continue;
    patches[mode.id] = {
      color: parseColorAlpha(getColorTokenModeColor(token, mode.id)).hex6,
      opacity: tokenAlphaPct(token, mode.id) / 100
    };
  }
  if (edit && edit.id !== baseModeId && edit.patch) patches[edit.id] = edit.patch;
  return patches;
}

function baseModeValuePatches(
  token: NumberToken,
  modes: DocumentMode[],
  baseModeId: string,
  edit?: { id: string; value?: number }
): Record<string, number | undefined> {
  const patches: Record<string, number | undefined> = {};
  for (const mode of modes) {
    if (mode.id === baseModeId) continue;
    if (edit && mode.id === edit.id) continue;
    if (token.modes?.[mode.id] === undefined) continue;
    patches[mode.id] = getNumberTokenModeValue(token, mode.id);
  }
  if (edit && edit.id !== baseModeId && edit.value !== undefined) patches[edit.id] = edit.value;
  return patches;
}

export interface ColorTokenPatch {
  name?: string;
  description?: string;
  /** Base-mode value. */
  color?: string;
  opacity?: number;
  /** One override; an absent `patch` CLEARS that mode back to the base. */
  mode?: { id: string; patch?: ColorModePatch };
}

export function writeColorToken(
  token: ColorToken,
  modes: DocumentMode[],
  baseModeId: string,
  patch: ColorTokenPatch
): ColorToken {
  return updateColorTokenWithModes(
    token,
    patch.name ?? token.name,
    patch.color ?? parseColorAlpha(getColorTokenModeColor(token, baseModeId)).hex6,
    baseModeColorPatches(token, modes, baseModeId, patch.mode),
    patch.description ?? token.description,
    patch.opacity ?? tokenAlphaPct(token, baseModeId) / 100,
    baseModeId
  );
}

export interface NumberTokenPatch {
  name?: string;
  description?: string;
  category?: NumberTokenCategory;
  /** Base-mode value. */
  value?: number;
  /** One override; an absent `value` CLEARS that mode back to the base. */
  mode?: { id: string; value?: number };
}

export function writeNumberToken(
  token: NumberToken,
  modes: DocumentMode[],
  baseModeId: string,
  patch: NumberTokenPatch
): NumberToken {
  return updateNumberTokenWithModes(
    token,
    patch.name ?? token.name,
    patch.category ?? token.category,
    patch.value ?? getNumberTokenModeValue(token, baseModeId),
    baseModeValuePatches(token, modes, baseModeId, patch.mode),
    patch.description ?? token.description,
    baseModeId
  );
}
