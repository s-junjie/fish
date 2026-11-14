import { useMemo } from "preact/hooks";
import { Check } from "lucide-react";
import type { ColorToken, DesignToken, NumberToken } from "../../core/dsl/types";
import {
  isTokenAliasRef,
  lookupToken,
  rawTokenSlot,
  toTokenMap,
  wouldTokenAliasCycle
} from "../../core/dsl/token-value";
import { parseColorAlpha } from "../../core/geometry/color-utils";
import { getColorTokenModeColor, getNumberTokenModeValue } from "../../core/interactions/mode-ops";
import { t } from "../../i18n";
import { STYLE_CARD_TRAILING_BG } from "../inspector/StyleCard";
import { renderColorTokenPreview, renderNumberTokenPreview } from "../inspector/StylePreview";
import { TokenPickerPopover } from "../inspector/TokenPickerPopover";

interface TokenAliasPickerProps {
  sourceToken: ColorToken | NumberToken;
  modeId: string;
  baseModeId: string;
  allTokens: DesignToken[];
  anchor: HTMLElement;
  currentRefId?: string;
  onSelect: (targetTokenId: string) => void;
  onDetach?: () => void;
  onClose: () => void;
}

/**
 * Picks a same-type alias target for one slot of a token, filtering out any
 * candidate whose reference graph already reaches `sourceToken`.
 */
export function TokenAliasPicker({
  sourceToken,
  modeId,
  baseModeId,
  allTokens,
  anchor,
  currentRefId,
  onSelect,
  onDetach,
  onClose
}: TokenAliasPickerProps) {
  const tokenMap = useMemo(() => toTokenMap(allTokens), [allTokens]);

  const candidates = useMemo(
    () =>
      allTokens.filter(
        (candidate): candidate is ColorToken | NumberToken =>
          candidate.type === sourceToken.type &&
          !wouldTokenAliasCycle(tokenMap, sourceToken.id, candidate.id)
      ),
    [allTokens, tokenMap, sourceToken.id, sourceToken.type]
  );

  const boundMark = (
    <span className={`${STYLE_CARD_TRAILING_BG} flex h-6 w-6 items-center justify-center text-brand`}>
      <Check size={12} />
    </span>
  );

  const formatSummary = (token: ColorToken | NumberToken): string => {
    const raw = rawTokenSlot(token, modeId, baseModeId);
    const chainedTarget = isTokenAliasRef(raw) ? lookupToken(tokenMap, raw.ref) : undefined;
    if (token.type === "color") {
      const color = getColorTokenModeColor(token, modeId, tokenMap);
      const { hex6, alphaPct } = parseColorAlpha(color);
      const hex = hex6.toUpperCase();
      const val = alphaPct < 100 ? `${hex} · ${alphaPct}%` : hex;
      return chainedTarget ? `\u2192 ${chainedTarget.name} \u00b7 ${val}` : val;
    }
    const val = getNumberTokenModeValue(token, modeId, tokenMap);
    return chainedTarget ? `\u2192 ${chainedTarget.name} \u00b7 ${val}` : String(val);
  };

  return (
    <TokenPickerPopover<ColorToken | NumberToken>
      tokens={candidates}
      matches={(candidate, query) =>
        [candidate.name, formatSummary(candidate)].join(" ").toLowerCase().includes(query)
      }
      row={(candidate) => ({
        id: candidate.id,
        name: candidate.name,
        subtitle: formatSummary(candidate),
        preview:
          candidate.type === "color"
            ? renderColorTokenPreview(candidate, modeId, undefined, tokenMap)
            : renderNumberTokenPreview(candidate.category),
        trailing: candidate.id === currentRefId ? boundMark : undefined
      })}
      anchor={anchor}
      ariaLabel={t("tokens.pickAlias")}
      title={t("tokens.pickAlias")}
      searchPlaceholder={t("tokens.searchAlias")}
      emptyLabel={t("tokens.noAliasTargets")}
      rootAttr={{ "data-token-alias-picker": "1" }}
      searchAttr={{ "data-token-alias-search": "1", name: "alias-search" }}
      detachAttr={{ "data-token-alias-detach": "1" }}
      optionAttr="data-token-alias-option"
      fieldScope="token-alias-picker"
      boundTokenId={currentRefId}
      onDetach={onDetach}
      onSelect={(candidate) => {
        onSelect(candidate.id);
        onClose();
      }}
      onClose={onClose}
    />
  );
}
