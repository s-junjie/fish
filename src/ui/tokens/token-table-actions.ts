import type {
  ColorToken,
  DesignDocument,
  DocumentMode,
  NumberToken,
  NumberTokenCategory
} from "../../core/dsl/types";
import { lookupToken, toTokenMap } from "../../core/dsl/token-value";
import { parseColorAlpha } from "../../core/geometry/color-utils";
import {
  deleteDocumentMode,
  deleteDocumentNumberMode,
  getColorTokenModeColor,
  getNumberTokenModeValue,
  renameDocumentMode,
  renameDocumentNumberMode
} from "../../core/interactions/mode-ops";
import { removeTokenFromDoc, updateTokenInDoc } from "../../core/interactions/style-ops";
import { tokenAlphaPct } from "../../core/interactions/token-ops";
import {
  writeColorToken,
  writeNumberToken,
  type ColorTokenPatch,
  type NumberTokenPatch
} from "./token-mode-patch";

export type AnyTableToken = ColorToken | NumberToken;

export interface TokensTableActionContext {
  variant: "color" | "number";
  docRef: { current: DesignDocument };
  modes: DocumentMode[];
  baseModeId: string;
  commitSnapshot: (newDoc: DesignDocument) => void;
  /**
   * A VALUE edit lands one of two ways: discrete (a typed number, a hex commit,
   * a click) records a step of its own, a drag frame is written transiently so
   * the gesture's end is the one step the drag costs. Recording every frame put
   * a pixel per entry on the stack and evicted the state before the drag, which
   * read as "this panel cannot be undone".
   */
  writeDoc: (newDoc: DesignDocument, discrete?: boolean) => void;
}

/** Document mutation handlers for `TokensTable`: mode edits, aliases, renames, deletes. */
export function createTokensTableActions({
  variant,
  docRef,
  modes,
  baseModeId,
  commitSnapshot,
  writeDoc
}: TokensTableActionContext) {
  const latestMap = () => toTokenMap(docRef.current.tokens);

  const findLatest = (tokenId: string): AnyTableToken | undefined => {
    const entry = lookupToken(latestMap(), tokenId);
    return entry && entry.type === variant ? (entry as AnyTableToken) : undefined;
  };

  const commitRenameToken = (token: AnyTableToken, nextName: string) => {
    const clean = nextName.trim();
    if (!clean || clean === token.name) return;
    const latest = findLatest(token.id);
    if (!latest) return;
    const map = latestMap();
    commitSnapshot(
      updateTokenInDoc(
        docRef.current,
        latest.type === "color"
          ? writeColorToken(latest, modes, baseModeId, { name: clean }, map)
          : writeNumberToken(latest, modes, baseModeId, { name: clean }, map)
      )
    );
  };

  const changeCategory = (token: NumberToken, newCat: NumberTokenCategory) => {
    const latest = findLatest(token.id);
    if (!latest || latest.type !== "number") return;
    commitSnapshot(
      updateTokenInDoc(
        docRef.current,
        writeNumberToken(latest, modes, baseModeId, { category: newCat }, latestMap())
      )
    );
  };

  const commitRenameMode = (modeId: string, nextName: string) => {
    const clean = nextName.trim();
    if (!clean) return;
    commitSnapshot(
      variant === "color"
        ? renameDocumentMode(docRef.current, modeId, clean)
        : renameDocumentNumberMode(docRef.current, modeId, clean)
    );
  };

  const resetColorMode = (token: ColorToken, modeId: string) => {
    if (modeId === baseModeId) return;
    const latest = findLatest(token.id);
    if (!latest || latest.type !== "color") return;
    if (!latest.modes || !(modeId in latest.modes)) return;
    commitSnapshot(
      updateTokenInDoc(
        docRef.current,
        writeColorToken(latest, modes, baseModeId, { mode: { id: modeId } }, latestMap())
      )
    );
  };

  const changeColor = (
    token: ColorToken,
    modeId: string,
    hex: string,
    opacity?: number,
    discrete?: boolean
  ) => {
    if (!hex || !hex.trim()) {
      if (modeId !== baseModeId) resetColorMode(token, modeId);
      return;
    }
    const latest = findLatest(token.id);
    if (!latest || latest.type !== "color") return;
    const map = latestMap();

    const cleanHex = parseColorAlpha(hex).hex6;
    const patch: ColorTokenPatch =
      modeId === baseModeId
        ? /* The cell always reports an alpha; an absent one means the typed hex
             replaced the whole value, so the base mode goes opaque. */
          { color: cleanHex, opacity: opacity ?? 1 }
        : {
            mode: {
              id: modeId,
              patch: {
                color: cleanHex,
                opacity: opacity !== undefined ? opacity : tokenAlphaPct(latest, modeId, map) / 100
              }
            }
          };
    const nextDoc = updateTokenInDoc(docRef.current, writeColorToken(latest, modes, baseModeId, patch, map));
    writeDoc(nextDoc, discrete);
  };

  const resetNumberMode = (token: NumberToken, modeId: string) => {
    if (modeId === baseModeId) return;
    const latest = findLatest(token.id);
    if (!latest || latest.type !== "number") return;
    if (!latest.modes || !(modeId in latest.modes)) return;
    commitSnapshot(
      updateTokenInDoc(
        docRef.current,
        writeNumberToken(latest, modes, baseModeId, { mode: { id: modeId } }, latestMap())
      )
    );
  };

  const changeNumberValue = (
    token: NumberToken,
    modeId: string,
    val: number,
    discrete?: boolean
  ) => {
    if (Number.isNaN(val)) {
      if (modeId !== baseModeId) resetNumberMode(token, modeId);
      return;
    }
    const latest = findLatest(token.id);
    if (!latest || latest.type !== "number") return;
    const patch: NumberTokenPatch =
      modeId === baseModeId ? { value: val } : { mode: { id: modeId, value: val } };
    const nextDoc = updateTokenInDoc(
      docRef.current,
      writeNumberToken(latest, modes, baseModeId, patch, latestMap())
    );
    writeDoc(nextDoc, discrete);
  };

  const bindAlias = (token: AnyTableToken, modeId: string, targetTokenId: string) => {
    const latest = findLatest(token.id);
    if (!latest) return;
    const map = latestMap();
    const ref = { ref: targetTokenId };
    const updated =
      latest.type === "color"
        ? writeColorToken(
            latest,
            modes,
            baseModeId,
            modeId === baseModeId ? { color: ref } : { mode: { id: modeId, patch: ref } },
            map
          )
        : writeNumberToken(
            latest,
            modes,
            baseModeId,
            modeId === baseModeId ? { value: ref } : { mode: { id: modeId, value: ref } },
            map
          );
    commitSnapshot(updateTokenInDoc(docRef.current, updated));
  };

  const detachAlias = (token: AnyTableToken, modeId: string) => {
    const latest = findLatest(token.id);
    if (!latest) return;
    const map = latestMap();
    if (latest.type === "color") {
      const resolved = getColorTokenModeColor(latest, modeId, map);
      const { hex6, alphaPct } = parseColorAlpha(resolved);
      const opacity = alphaPct / 100;
      const patch: ColorTokenPatch =
        modeId === baseModeId
          ? { color: hex6, opacity }
          : { mode: { id: modeId, patch: { color: hex6, opacity } } };
      commitSnapshot(
        updateTokenInDoc(docRef.current, writeColorToken(latest, modes, baseModeId, patch, map))
      );
      return;
    }
    const resolved = getNumberTokenModeValue(latest, modeId, map);
    const patch: NumberTokenPatch =
      modeId === baseModeId ? { value: resolved } : { mode: { id: modeId, value: resolved } };
    commitSnapshot(
      updateTokenInDoc(docRef.current, writeNumberToken(latest, modes, baseModeId, patch, map))
    );
  };

  const deleteToken = (tokenId: string) => {
    commitSnapshot(removeTokenFromDoc(docRef.current, tokenId));
  };

  const deleteMode = (modeId: string) => {
    if (modes.length <= 1) return;
    commitSnapshot(
      variant === "color"
        ? deleteDocumentMode(docRef.current, modeId)
        : deleteDocumentNumberMode(docRef.current, modeId)
    );
  };

  return {
    commitRenameToken,
    changeCategory,
    commitRenameMode,
    changeColor,
    changeNumberValue,
    bindAlias,
    detachAlias,
    deleteToken,
    deleteMode
  };
}
