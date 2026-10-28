import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { createPortal } from "preact/compat";
import { Check, Edit2, Link2Off, Plus, Ruler, SquareRoundCorner, Minus, Maximize2, Type, Sparkles } from "lucide-react";
import type { DesignDocument, NumberToken, NumberTokenCategory } from "../../core/dsl/types";
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
import { PanelHeader } from "../PanelHeader";
import { TEXT_FIELD_CLASS } from "../ScrubInput";
import { Select } from "../Select";
import { POPOVER_SURFACE_CLASS } from "../menu-style";
import { useAnchoredPosition, placementStyle } from "../hooks/useAnchoredPosition";
import { useDismiss } from "../hooks/useDismiss";
import { POPOVER_WIDTH } from "./StylePickerPopover";
import { StyleCard, STYLE_CARD_TRAILING_BG } from "./StyleCard";
import { NumberTokenEditorPanel } from "./NumberTokenEditorPanel";

function CategoryIcon({ category }: { category?: NumberTokenCategory }) {
  switch (category) {
    case "radius":
      return <SquareRoundCorner size={12} />;
    case "stroke":
      return <Minus size={12} />;
    case "size":
      return <Maximize2 size={12} />;
    case "typography":
      return <Type size={12} />;
    case "effect":
      return <Sparkles size={12} />;
    case "spacing":
    default:
      return <Ruler size={12} />;
  }
}

interface NumberTokenPickerProps {
  doc: DesignDocument;
  docRef?: { current: DesignDocument };
  anchor: HTMLElement;
  boundTokenId?: string;
  currentValue?: number;
  category?: NumberTokenCategory;
  onSelect: (token: NumberToken) => void;
  onDetach?: () => void;
  onClose: () => void;
  onDocChange?: (newDoc: DesignDocument) => void;
  /** The undo stream for an edit saved from here, so the host sections re-render. */
  onCommitSnapshot?: (newDoc: DesignDocument) => void;
}

const VIEWPORT_MARGIN = 8;
const ANCHOR_GAP = 10;
const BOTTOM_MARGIN = 20;

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
  const [filter, setFilter] = useState("");
  const [activeCategory, setActiveCategory] = useState<NumberTokenCategory | "all">(
    initialCategory ?? "all"
  );
  const [creating, setCreating] = useState(false);
  /** The token whose editor is over the list. Null while creating. */
  const [editingTokenId, setEditingTokenId] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const anchorRef = useRef<HTMLElement | null>(anchor);
  anchorRef.current = anchor;
  const searchRef = useRef<HTMLInputElement | null>(null);
  const focusedOnceRef = useRef(false);

  // The NUMBER axis decides which value a number token shows here.
  const activeTheme = getActiveNumberMode(doc);
  const tokens = (doc.tokens || []).filter(isNumberToken);
  const filtered = useMemo(() => {
    let list = tokens;
    if (activeCategory !== "all") {
      list = list.filter((tok) => (tok.category ?? "spacing") === activeCategory);
    }
    const q = filter.trim().toLowerCase();
    if (!q) return list;
    return list.filter((tok) => {
      const val = getNumberTokenModeValue(tok, activeTheme);
      return [tok.name, tok.category, `${val}px`, String(val)].join(" ").toLowerCase().includes(q);
    });
  }, [tokens, activeCategory, filter, activeTheme]);

  const pos = useAnchoredPosition({
    anchorRef,
    panelRef,
    deps: [filter, activeCategory, tokens.length, creating, editingTokenId],
    compute: (anchorEl, panel) => {
      const a = anchorEl.getBoundingClientRect();
      if (a.width === 0 && a.height === 0 && a.top === 0 && a.left === 0) return null;
      const host =
        anchorEl.closest("[data-number-token-picker]") ??
        anchorEl.closest("[data-host-popover], [data-style-picker-popover]");
      const bounds = host ? host.getBoundingClientRect() : a;
      let left = bounds.left - POPOVER_WIDTH - ANCHOR_GAP;
      if (left < VIEWPORT_MARGIN) {
        left = Math.min(bounds.right + ANCHOR_GAP, window.innerWidth - POPOVER_WIDTH - VIEWPORT_MARGIN);
      }
      left = Math.max(VIEWPORT_MARGIN, left);

      const height = panel.offsetHeight || 280;
      const fitsBelow = a.top + height <= window.innerHeight - BOTTOM_MARGIN;
      const fitsAbove = a.top - height >= VIEWPORT_MARGIN;
      const top = fitsBelow
        ? a.top
        : fitsAbove
          ? a.top - height
          : Math.max(VIEWPORT_MARGIN, window.innerHeight - height - BOTTOM_MARGIN);
      return { left, top };
    }
  });

  useDismiss(
    true,
    onClose,
    panelRef,
    anchorRef,
    ["[data-number-token-editor-panel]"],
    () => creating || editingTokenId !== null
  );

  useEffect(() => {
    if (focusedOnceRef.current || !pos) return;
    focusedOnceRef.current = true;
    searchRef.current?.focus();
  }, [pos]);

  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-label={t("tokens.pickNumber")}
      data-number-token-picker="1"
      data-host-popover="true"
      data-field-tab-scope="number-token-picker"
      style={placementStyle(pos, POPOVER_WIDTH)}
      className={`fixed z-[70] px-2.5 py-3 flex flex-col text-ui select-none max-h-[85vh] overflow-y-auto ${POPOVER_SURFACE_CLASS}`}
    >
      <PanelHeader
        title={t("tokens.pickNumber")}
        onClose={onClose}
        actions={
          <div className="flex items-center gap-1">
            <Button
              size="icon"
              type="button"
              data-number-token-picker-create="1"
              title={t("tokens.createNumberAction")}
              aria-label={t("tokens.createNumberAction")}
              onClick={() => setCreating(true)}
            >
              <Plus size={12} />
            </Button>
            {boundTokenId && onDetach && (
              <Button
                size="icon"
                type="button"
                data-number-token-picker-detach="1"
                title={t("tokens.detach")}
                aria-label={t("tokens.detach")}
                onClick={() => {
                  onDetach();
                  onClose();
                }}
              >
                <Link2Off size={12} />
              </Button>
            )}
          </div>
        }
      />

      <div className="mt-2">
        <input
          ref={searchRef}
          data-number-token-picker-search="1"
          name="number-token-search"
          value={filter}
          onInput={(e) => setFilter((e.currentTarget as HTMLInputElement).value)}
          placeholder={t("tokens.searchNumbers")}
          className={TEXT_FIELD_CLASS}
          spellcheck={false}
        />
      </div>

      <div className="mt-1.5">
        <Select
          value={activeCategory}
          onChange={(cat) => setActiveCategory(cat as NumberTokenCategory | "all")}
          className="w-full"
        >
          <option value="all">{t("tokens.categories.all")}</option>
          <option value="spacing">{t("tokens.categories.spacing")}</option>
          <option value="radius">{t("tokens.categories.radius")}</option>
          <option value="stroke">{t("tokens.categories.stroke")}</option>
          <option value="size">{t("tokens.categories.size")}</option>
          <option value="typography">{t("tokens.categories.typography")}</option>
          <option value="effect">{t("tokens.categories.effect")}</option>
        </Select>
      </div>

      <div className="mt-2 space-y-1">
        {filtered.length === 0 ? (
          <p className="px-1 py-3 text-center text-meta text-ink-muted">
            {tokens.length === 0 ? t("tokens.emptyNumbers") : t("tokens.noMatches")}
          </p>
        ) : (
          filtered.map((tok) => {
            const isBound = tok.id === boundTokenId;
            const uses = countNumberTokenUses(doc, tok.id);
            const modeVal = getNumberTokenModeValue(tok, activeTheme);
            return (
              <StyleCard
                key={tok.id}
                rowProps={{ "data-number-token-option": tok.id }}
                preview={
                  <div className="w-6 h-6 rounded-swatch bg-inset border border-rule flex items-center justify-center text-ink-dim shrink-0">
                    <CategoryIcon category={tok.category} />
                  </div>
                }
                name={tok.name}
                subtitle={`${modeVal}px · ${t("tokens.uses", { n: uses })}`}
                onClick={() => {
                  onSelect({ ...tok, value: modeVal });
                  onClose();
                }}
                className="group"
                trailing={
                  docRef ? (
                    <>
                    {/* The edit button wears `STYLE_CARD_TRAILING_BG` and hides
                        until hover exactly like the style list's card trailing
                        (`StyleListView`); the bound check beside it stays up so
                        the binding state is never mistaken for the affordance. */}
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
                    {isBound && (
                      <span className={`${STYLE_CARD_TRAILING_BG} flex h-6 w-6 items-center justify-center text-brand`}>
                        <Check size={12} />
                      </span>
                    )}
                  </>
                ) : isBound ? (
                  <span className={`${STYLE_CARD_TRAILING_BG} flex h-6 w-6 items-center justify-center text-brand`}>
                    <Check size={12} />
                  </span>
                ) : undefined
                }
              />
            );
          })
        )}
      </div>

      {(creating || editingTokenId) && docRef && (() => {
        const editing =
          editingTokenId && !creating
            ? ((docRef.current.tokens || []).find(
                (entry): entry is NumberToken => isNumberToken(entry) && entry.id === editingTokenId
              ) ?? null)
            : null;
        if (creating || editing) {
          return (
            <NumberTokenEditorPanel
              key={creating ? "new" : editingTokenId}
              token={editing}
              modes={getDocumentNumberModes(docRef.current)}
              anchorRef={panelRef}
              initialValue={editing ? undefined : currentValue}
              initialCategory={editing ? undefined : (activeCategory !== "all" ? activeCategory : (initialCategory ?? "spacing"))}
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
                  onSelect({ ...newToken, value: getNumberTokenModeValue(newToken, activeTheme) });
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
        }
        return null;
      })()}
    </div>,
    document.body
  );
}
