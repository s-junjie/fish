import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { createPortal } from "preact/compat";
import { Check, Link2Off, Plus } from "lucide-react";
import type { ColorToken, DesignDocument } from "../../core/dsl/types";
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
import { Button } from "../Button";
import { PanelHeader } from "../PanelHeader";
import { TEXT_FIELD_CLASS } from "../ScrubInput";
import { POPOVER_SURFACE_CLASS } from "../menu-style";
import { useAnchoredPosition, placementStyle } from "../hooks/useAnchoredPosition";
import { useDismiss } from "../hooks/useDismiss";
import { POPOVER_WIDTH } from "./StylePickerPopover";
import { StyleCard, STYLE_CARD_TRAILING_BG } from "./StyleCard";
import { renderColorTokenPreview } from "./StylePreview";
import { TokenEditorPanel } from "./TokenEditorPanel";

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

const VIEWPORT_MARGIN = 8;
const ANCHOR_GAP = 10;
const BOTTOM_MARGIN = 20;

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
  const [filter, setFilter] = useState("");
  const [creating, setCreating] = useState(false);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const anchorRef = useRef<HTMLElement | null>(anchor);
  anchorRef.current = anchor;
  const searchRef = useRef<HTMLInputElement | null>(null);
  const focusedOnceRef = useRef(false);

  const activeTheme = getActiveTheme(doc);
  const tokens = colorTokensOf(doc.tokens);
  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return tokens;
    return tokens.filter((token) =>
      [token.name, colorTokenColor(token, activeTheme)].join(" ").toLowerCase().includes(q)
    );
  }, [tokens, filter, activeTheme]);

  const pos = useAnchoredPosition({
    anchorRef,
    panelRef,
    deps: [filter, tokens.length],
    compute: (anchorEl, panel) => {
      const a = anchorEl.getBoundingClientRect();
      if (a.width === 0 && a.height === 0 && a.top === 0 && a.left === 0) return null;
      const host = anchorEl.closest("[data-effect-panel]") ?? anchorEl.closest("[data-host-popover], [data-style-picker-popover]");
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
    ["[data-token-editor-panel]", "[data-color-panel]"],
    () => creating
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
      aria-label={t("tokens.pick")}
      data-color-token-picker="1"
      data-host-popover="true"
      data-field-tab-scope="color-token-picker"
      style={placementStyle(pos, POPOVER_WIDTH)}
      className={`fixed z-[70] px-2.5 py-3 flex flex-col text-ui select-none max-h-[85vh] overflow-y-auto ${POPOVER_SURFACE_CLASS}`}
    >
      <PanelHeader
        title={t("tokens.pick")}
        onClose={onClose}
        actions={
          <div className="flex items-center gap-1">
            <Button
              size="icon"
              type="button"
              data-token-picker-create="1"
              title={t("tokens.createAction")}
              aria-label={t("tokens.createAction")}
              onClick={() => setCreating(true)}
            >
              <Plus size={12} />
            </Button>
            {boundTokenId && onDetach && (
              <Button
                size="icon"
                type="button"
                data-token-picker-detach="1"
                title={t("tokens.detach")}
                aria-label={t("tokens.detach")}
                onClick={onDetach}
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
          data-token-picker-search="1"
          name="token-search"
          value={filter}
          onInput={(e) => setFilter((e.currentTarget as HTMLInputElement).value)}
          placeholder={t("tokens.search")}
          className={TEXT_FIELD_CLASS}
          spellcheck={false}
        />
      </div>

      <div className="mt-2 space-y-1">
        {filtered.length === 0 ? (
          <p className="px-1 py-3 text-center text-meta text-ink-muted">{t("tokens.noTokens")}</p>
        ) : (
          filtered.map((token) => {
            const color = colorTokenColor(token, activeTheme);
            const { hex6, alphaPct } = parseColorAlpha(color);
            const hex = hex6.toUpperCase();
            const colorLabel = alphaPct < 100 ? `${hex} · ${alphaPct}%` : hex;
            const uses = countTokenUses(doc, token.id);
            return (
              <StyleCard
                key={token.id}
                rowProps={{ "data-color-token-option": token.id }}
                preview={renderColorTokenPreview(token, activeTheme)}
                name={token.name}
                subtitle={`${colorLabel} · ${t("tokens.uses", { n: uses })}`}
                onClick={() => onSelect(token)}
                className="group"
                trailing={
                  boundTokenId === token.id ? (
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

      {creating && (
        <TokenEditorPanel
          token={null}
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
      )}
    </div>,
    document.body
  );
}
