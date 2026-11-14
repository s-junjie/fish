import { useMemo, useState } from "preact/hooks";
import { Check, Edit2 } from "lucide-react";
import type { DesignDocument, NumberToken, NumberTokenCategory } from "../../core/dsl/types";
import { isTokenAliasRef, lookupToken, rawTokenSlot, toTokenMap } from "../../core/dsl/token-value";
import {
  countNumberTokenUses,
  createNumberToken,
  isNumberToken
} from "../../core/interactions/number-token-ops";
import { addTokenToDoc, updateTokenInDoc } from "../../core/interactions/style-ops";
import {
  getActiveNumberMode,
  getDocumentNumberModes,
  getNumberTokenModeValue,
  updateNumberTokenWithModes
} from "../../core/interactions/mode-ops";
import { t } from "../../i18n";
import { Button } from "../Button";
import { Select } from "../Select";
import { NUMBER_TOKEN_CATEGORIES } from "../tokens/CategoryIcon";
import { STYLE_CARD_TRAILING_BG } from "./StyleCard";
import { renderNumberTokenPreview } from "./StylePreview";
import { NumberTokenEditorPanel } from "./NumberTokenEditorPanel";
import { TokenPickerPopover } from "./TokenPickerPopover";

interface NumberTokenPickerProps {
  doc: DesignDocument;
  docRef?: { current: DesignDocument };
  anchor: HTMLElement;
  boundTokenId?: string;
  currentValue?: number;
  category?: NumberTokenCategory;
  onSelect: (token: NumberToken & { value: number }) => void;
  onDetach?: () => void;
  onClose: () => void;
  onDocChange?: (newDoc: DesignDocument) => void;
  /** The undo stream for an edit saved from here, so the host sections re-render. */
  onCommitSnapshot?: (newDoc: DesignDocument) => void;
}

export function NumberTokenPicker({
  doc,
  docRef,
  anchor,
  boundTokenId,
  currentValue,
  category: initialCategory,
  onSelect,
  onDetach,
  onClose,
  onDocChange,
  onCommitSnapshot
}: NumberTokenPickerProps) {
  const [activeCategory, setActiveCategory] = useState<NumberTokenCategory | "all">(
    initialCategory ?? "all"
  );
  const [creating, setCreating] = useState(false);
  /** The token whose editor is over the list. Null while creating. */
  const [editingTokenId, setEditingTokenId] = useState<string | null>(null);

  // The NUMBER axis decides which value a number token shows here.
  const activeTheme = getActiveNumberMode(doc);
  const tokens = (doc.tokens || []).filter(isNumberToken);
  const filteredByCategory =
    activeCategory === "all"
      ? tokens
      : tokens.filter((tok) => (tok.category ?? "spacing") === activeCategory);

  const allTokens = doc.tokens || [];
  const tokenMap = useMemo(() => toTokenMap(allTokens), [allTokens]);
  const baseModeId = getDocumentNumberModes(doc)[0]?.id;

  return (
    <TokenPickerPopover<NumberToken>
      tokens={filteredByCategory}
      matches={(tok, query) => {
        const val = getNumberTokenModeValue(tok, activeTheme, tokenMap);
        const raw = rawTokenSlot(tok, activeTheme, baseModeId);
        const targetName = isTokenAliasRef(raw) ? lookupToken(tokenMap, raw.ref)?.name ?? "" : "";
        return [tok.name, targetName, tok.category, `${val}px`, String(val)]
          .join(" ")
          .toLowerCase()
          .includes(query);
      }}
      row={(tok) => {
        const isBound = tok.id === boundTokenId;
        const uses = countNumberTokenUses(doc, tok.id);
        const modeVal = getNumberTokenModeValue(tok, activeTheme, tokenMap);
        const raw = rawTokenSlot(tok, activeTheme, baseModeId);
        const target = isTokenAliasRef(raw) ? lookupToken(tokenMap, raw.ref) : undefined;
        const valSummary = target ? `\u2192 ${target.name} \u00b7 ${modeVal}` : `${modeVal}`;
        const boundMark = (
          <span className={`${STYLE_CARD_TRAILING_BG} flex h-6 w-6 items-center justify-center text-brand`}>
            <Check size={12} />
          </span>
        );
        return {
          id: tok.id,
          name: tok.name,
          subtitle: `${valSummary} · ${t("tokens.uses", { n: uses })}`,
          preview: renderNumberTokenPreview(tok.category),
          /* The edit button wears `STYLE_CARD_TRAILING_BG` and hides until hover
             exactly like the style list's card trailing; the bound check beside
             it stays up so the binding state is never mistaken for the
             affordance. */
          trailing: docRef ? (
            <>
              <Button
                size="icon"
                type="button"
                title={t("tokens.editNumberAction")}
                aria-label={t("tokens.editNumberAction")}
                onClick={(e) => {
                  e.stopPropagation();
                  setEditingTokenId(tok.id);
                }}
                className={`${STYLE_CARD_TRAILING_BG} opacity-0 group-hover:opacity-100 transition-[background-color,opacity] ease-snap duration-micro`}
              >
                <Edit2 size={11} />
              </Button>
              {isBound && boundMark}
            </>
          ) : isBound ? (
            boundMark
          ) : undefined
        };
      }}
      anchor={anchor}
      ariaLabel={t("tokens.pickNumber")}
      title={t("tokens.pickNumber")}
      createTitle={t("tokens.createNumberAction")}
      searchPlaceholder={t("tokens.searchNumbers")}
      emptyLabel={tokens.length === 0 ? t("tokens.emptyNumbers") : t("tokens.noMatches")}
      rootAttr={{ "data-number-token-picker": "1" }}
      searchAttr={{ "data-number-token-picker-search": "1", name: "number-token-search" }}
      createAttr={{ "data-number-token-picker-create": "1" }}
      detachAttr={{ "data-number-token-picker-detach": "1" }}
      optionAttr="data-number-token-option"
      fieldScope="number-token-picker"
      hostSelector="[data-number-token-picker], [data-host-popover], [data-style-picker-popover]"
      boundTokenId={boundTokenId}
      onDetach={
        onDetach
          ? () => {
              onDetach();
              onClose();
            }
          : undefined
      }
      onCreate={() => setCreating(true)}
      extraControls={
        <Select
          value={activeCategory}
          onChange={(cat) => setActiveCategory(cat as NumberTokenCategory | "all")}
          className="w-full"
        >
          <option value="all">{t("tokens.categories.all")}</option>
          {NUMBER_TOKEN_CATEGORIES.map((cat) => (
            <option key={cat} value={cat}>
              {t(`tokens.categories.${cat}`)}
            </option>
          ))}
        </Select>
      }
      extraDeps={[activeCategory, creating, editingTokenId]}
      onSelect={(tok) => {
        onSelect({ ...tok, value: getNumberTokenModeValue(tok, activeTheme, allTokens) });
        onClose();
      }}
      onClose={onClose}
      keepOpenFor={["[data-number-token-editor-panel]"]}
      nestedOpen={() => creating || editingTokenId !== null}
      editor={(panelRef) => {
        if (!(creating || editingTokenId) || !docRef) return null;
        const editing =
          editingTokenId && !creating
            ? ((docRef.current.tokens || []).find(
                (entry): entry is NumberToken => isNumberToken(entry) && entry.id === editingTokenId
              ) ?? null)
            : null;
        if (!creating && !editing) return null;
        return (
          <NumberTokenEditorPanel
            key={creating ? "new" : editingTokenId ?? "edit"}
            token={editing}
            tokens={docRef.current.tokens}
            modes={getDocumentNumberModes(docRef.current)}
            anchorRef={panelRef}
            initialValue={editing ? undefined : currentValue}
            initialCategory={
              editing
                ? undefined
                : activeCategory !== "all"
                  ? activeCategory
                  : initialCategory ?? "spacing"
            }
            onSave={(draft) => {
              const current = docRef.current;
              if (editing) {
                const updated = updateNumberTokenWithModes(
                  editing,
                  draft.name,
                  draft.category,
                  draft.value,
                  draft.modes ?? draft.darkValue,
                  draft.description,
                  getDocumentNumberModes(current)[0]?.id
                );
                // The cascade (styles, dual storage, relayout) is why the save
                // routes through the core op rather than a raw token swap.
                const nextDoc = updateTokenInDoc(current, updated);
                if (onCommitSnapshot) onCommitSnapshot(nextDoc);
                else docRef.current = nextDoc;
                setEditingTokenId(null);
                onClose();
              } else {
                const baseModeId = getDocumentNumberModes(current)[0]?.id;
                const created = createNumberToken(draft.name, draft.value, draft.category, draft.description);
                const newToken = updateNumberTokenWithModes(
                  created,
                  draft.name,
                  draft.category,
                  draft.value,
                  draft.modes ?? draft.darkValue,
                  draft.description,
                  baseModeId
                );
                docRef.current = addTokenToDoc(current, newToken);
                if (onDocChange) onDocChange(addTokenToDoc(doc, newToken));
                onSelect({
                  ...newToken,
                  value: getNumberTokenModeValue(newToken, activeTheme, docRef.current.tokens)
                });
                setCreating(false);
                onClose();
              }
            }}
            onClose={() => {
              setCreating(false);
              setEditingTokenId(null);
            }}
          />
        );
      }}
    />
  );
}
