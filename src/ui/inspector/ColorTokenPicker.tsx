import { useMemo, useState } from "preact/hooks";
import { Check } from "lucide-react";
import type { ColorToken, DesignDocument } from "../../core/dsl/types";
import { isTokenAliasRef, lookupToken, rawTokenSlot, toTokenMap } from "../../core/dsl/token-value";
import {
  colorTokenColor,
  colorTokensOf,
  countTokenUses,
  createColorToken
} from "../../core/interactions/token-ops";
import { addTokenToDoc } from "../../core/interactions/style-ops";
import { getActiveTheme, getDocumentModes, updateColorTokenWithModes } from "../../core/interactions/mode-ops";
import { parseColorAlpha } from "../../core/geometry/color-utils";
import { t } from "../../i18n";
import { POPOVER_WIDTH } from "./StylePickerPopover";
import { STYLE_CARD_TRAILING_BG } from "./StyleCard";
import { renderColorTokenPreview } from "./StylePreview";
import { TokenEditorPanel } from "./TokenEditorPanel";
import { TokenPickerPopover } from "./TokenPickerPopover";

interface ColorTokenPickerProps {
  doc: DesignDocument;
  docRef?: { current: DesignDocument };
  anchor: HTMLElement;
  boundTokenId?: string;
  currentColor?: string;
  onSelect: (token: ColorToken) => void;
  onDetach?: () => void;
  onClose: () => void;
}

/**
 * The per-property picker behind a colour field. It lists colour tokens only —
 * a Color Style is a whole stack and belongs in the section's Library picker.
 * It is anchored and sized like StylePickerPopover so the two fields read as the
 * same kind of control.
 */
export function ColorTokenPicker({
  doc,
  docRef,
  anchor,
  boundTokenId,
  currentColor,
  onSelect,
  onDetach,
  onClose
}: ColorTokenPickerProps) {
  const [creating, setCreating] = useState(false);
  const activeTheme = getActiveTheme(doc);
  const allTokens = doc.tokens || [];
  const tokenMap = useMemo(() => toTokenMap(allTokens), [allTokens]);
  const baseModeId = getDocumentModes(doc)[0]?.id;
  const tokens = colorTokensOf(doc.tokens);

  return (
    <TokenPickerPopover<ColorToken>
      tokens={tokens}
      matches={(token, query) => {
        const raw = rawTokenSlot(token, activeTheme, baseModeId);
        const targetName = isTokenAliasRef(raw) ? lookupToken(tokenMap, raw.ref)?.name ?? "" : "";
        return [token.name, targetName, colorTokenColor(token, activeTheme, tokenMap)]
          .join(" ")
          .toLowerCase()
          .includes(query);
      }}
      row={(token) => {
        const color = colorTokenColor(token, activeTheme, tokenMap);
        const { hex6, alphaPct } = parseColorAlpha(color);
        const hex = hex6.toUpperCase();
        const colorLabel = alphaPct < 100 ? `${hex} · ${alphaPct}%` : hex;
        const uses = countTokenUses(doc, token.id);
        const raw = rawTokenSlot(token, activeTheme, baseModeId);
        const target = isTokenAliasRef(raw) ? lookupToken(tokenMap, raw.ref) : undefined;
        const valueSummary = target ? `\u2192 ${target.name} \u00b7 ${colorLabel}` : colorLabel;
        return {
          id: token.id,
          name: token.name,
          subtitle: `${valueSummary} · ${t("tokens.uses", { n: uses })}`,
          preview: renderColorTokenPreview(token, activeTheme, undefined, tokenMap),
          trailing:
            boundTokenId === token.id ? (
              <span className={`${STYLE_CARD_TRAILING_BG} flex h-6 w-6 items-center justify-center text-brand`}>
                <Check size={12} />
              </span>
            ) : undefined
        };
      }}
      anchor={anchor}
      ariaLabel={t("tokens.pick")}
      title={t("tokens.pick")}
      createTitle={t("tokens.createAction")}
      searchPlaceholder={t("tokens.search")}
      emptyLabel={t("tokens.noTokens")}
      rootAttr={{ "data-color-token-picker": "1" }}
      searchAttr={{ "data-token-picker-search": "1", name: "token-search" }}
      createAttr={{ "data-token-picker-create": "1" }}
      detachAttr={{ "data-token-picker-detach": "1" }}
      optionAttr="data-color-token-option"
      fieldScope="color-token-picker"
      hostSelector='[data-effect-panel], [data-host-popover], [data-style-picker-popover]'
      boundTokenId={boundTokenId}
      onDetach={onDetach}
      onCreate={() => setCreating(true)}
      onSelect={onSelect}
      onClose={onClose}
      keepOpenFor={["[data-token-editor-panel]", "[data-color-panel]"]}
      nestedOpen={() => creating}
      editor={(panelRef) =>
        creating ? (
          <TokenEditorPanel
            token={null}
            tokens={(docRef ? docRef.current : doc).tokens}
            modes={getDocumentModes(docRef ? docRef.current : doc)}
            initialColor={currentColor}
            anchorRef={panelRef}
            onSave={(draft) => {
              const baseModeId = getDocumentModes(docRef ? docRef.current : doc)[0]?.id;
              const created = createColorToken(draft.name, draft.color, draft.description);
              const token = updateColorTokenWithModes(
                created,
                draft.name,
                draft.color,
                draft.modes ?? draft.darkColor,
                draft.description,
                undefined,
                baseModeId
              );
              if (docRef && !docRef.current.tokens?.some((entry) => entry.id === token.id)) {
                docRef.current = addTokenToDoc(docRef.current, token);
              }
              onSelect(token);
              setCreating(false);
            }}
            onClose={() => setCreating(false)}
          />
        ) : null
      }
    />
  );
}
