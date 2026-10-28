import { useRef, useState } from "preact/hooks";
import { Plus, Edit2, Trash2, GripVertical } from "lucide-react";
import type { ColorToken, DesignDocument } from "../../core/dsl/types";
import {
  addTokenToDoc,
  removeTokenFromDoc,
  updateTokenInDoc
} from "../../core/interactions/style-ops";
import {
  colorTokenColor,
  colorTokensOf,
  createColorToken,
  mergeTokenOrder,
  reorderColorTokens,
  updateColorToken
} from "../../core/interactions/token-ops";
import {
  getActiveTheme,
  getDocumentModes,
  updateColorTokenWithModes
} from "../../core/interactions/mode-ops";
import { t } from "../../i18n";
import { Button } from "../Button";
import { Section } from "./SectionHeader";
import { StyleCard, STYLE_CARD_TRAILING_BG } from "./StyleCard";
import { renderColorTokenPreview } from "./StylePreview";
import { TokenEditorPanel, TokenEditorDraft } from "./TokenEditorPanel";
import { colorModeLabels } from "./mode-labels";
import { PaintDropIndicator } from "./PaintDropIndicator";
import { PaintDragGhost } from "../PaintDragGhost";
import { usePaintStackDrag } from "../hooks/usePaintStackDrag";

interface ColorTokenListProps {
  doc: DesignDocument;
  docRef: { current: DesignDocument };
  commitSnapshot: (newDoc: DesignDocument) => void;
}

/**
 * The Tokens tab's list: `doc.tokens` filtered to `type === "color"`. The one
 * way a colour is stored, so what Fill binds and what this lists cannot drift.
 */
export function ColorTokenList({ doc, docRef, commitSnapshot }: ColorTokenListProps) {
  const [editingId, setEditingId] = useState<string | "new" | null>(null);
  const editorAnchorRef = useRef<HTMLElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const tokens = colorTokensOf(doc.tokens);
  const editingToken = editingId && editingId !== "new"
    ? tokens.find((style) => style.id === editingId) ?? null
    : null;

  const handleReorder = (fromRow: number, insertBeforeRow: number) => {
    const current = colorTokensOf(docRef.current.tokens);
    const next = reorderColorTokens(current, fromRow, insertBeforeRow);
    if (next.length === current.length && next.every((t, i) => t.id === current[i].id)) return;
    commitSnapshot({ ...docRef.current, tokens: mergeTokenOrder(docRef.current.tokens ?? [], next) });
  };

  const { dragUi, beginDrag } = usePaintStackDrag({
    listRef,
    rowAttr: "data-token-row",
    ghostFor: (uiPos) => {
      const token = tokens[uiPos];
      return {
        swatch: colorTokenColor(token),
        label: token?.name ?? ""
      };
    },
    onCommit: handleReorder
  });

  const activeTheme = getActiveTheme(doc);
  const modes = getDocumentModes(doc);

  const save = (draft: TokenEditorDraft) => {
    const current = docRef.current;
    const baseModeId = getDocumentModes(current)[0]?.id;
    const modeOverrides = draft.modes ?? draft.darkColor;
    if (editingId === "new") {
      const created = createColorToken(draft.name, draft.color, draft.description);
      const withModes = updateColorTokenWithModes(
        created,
        draft.name,
        draft.color,
        modeOverrides,
        draft.description,
        undefined,
        baseModeId
      );
      commitSnapshot(addTokenToDoc(current, withModes));
    } else if (editingToken) {
      const latest = (current.tokens ?? []).find(
        (entry): entry is ColorToken => entry.type === "color" && entry.id === editingToken.id
      );
      if (latest) {
        const updated = updateColorTokenWithModes(
          latest,
          draft.name,
          draft.color,
          modeOverrides,
          draft.description,
          undefined,
          baseModeId
        );
        commitSnapshot(updateTokenInDoc(current, updated));
      }
    }
    setEditingId(null);
  };

  const openEditor = (id: string | "new", anchor: HTMLElement) => {
    editorAnchorRef.current = anchor;
    setEditingId(id);
  };

  return (
    <div className="select-none" data-color-tokens="1">
      <Section
        id="color-tokens"
        title={t("tokens.title")}
        trailing={
          <Button
            size="icon"
            type="button"
            data-token-new="1"
            title={t("tokens.createAction")}
            aria-label={t("tokens.createAction")}
            onClick={(event) => openEditor("new", event.currentTarget)}
          >
            <Plus size={13} />
          </Button>
        }
      >
        {tokens.length === 0 ? null : (
          <div ref={listRef} className="space-y-1" data-token-list="1">
            {tokens.map((token, uiPos) => {
              const modeLabels = colorModeLabels(token, modes);
              return (
                <StyleCard
                  key={token.id}
                  rowProps={{ "data-token-row": token.id }}
                  className={`group ${dragUi?.fromUi === uiPos ? "opacity-40" : ""}`}
                  leading={
                    <>
                      <PaintDropIndicator
                        active={!!dragUi && (dragUi.slot === uiPos || (uiPos === tokens.length - 1 && dragUi.slot === tokens.length))}
                        isLast={uiPos === tokens.length - 1}
                        testId="token-drop-indicator"
                      />
                      {tokens.length > 1 && (
                        <button
                          type="button"
                          data-token-handle={token.id}
                          title={t("styles.reorder")}
                          onPointerDown={(e) => beginDrag(uiPos, e)}
                          /* The grip sits inside the card that opens the editor:
                             a press that ends here is a grab, not a click — the
                             same guard the style rows carry. */
                          onClick={(e) => e.stopPropagation()}
                          className="text-ink-muted hover:text-ink p-0 shrink-0 cursor-grab active:cursor-grabbing touch-none -ml-1 -mr-1"
                        >
                          <GripVertical size={12} />
                        </button>
                      )}
                    </>
                  }
                  preview={renderColorTokenPreview(token, activeTheme)}
                  name={token.name}
                  subtitle={modeLabels.join(", ")}
                  onClick={(event) => openEditor(token.id, event.currentTarget)}
                  trailing={
                    <>
                      <Button
                        size="icon"
                        type="button"
                        data-token-edit={token.id}
                        title={t("tokens.editAction")}
                        aria-label={t("tokens.editAction")}
                        className={`${STYLE_CARD_TRAILING_BG} opacity-0 group-hover:opacity-100 transition-[background-color,opacity] ease-snap duration-micro`}
                        onClick={(event) => {
                          event.stopPropagation();
                          openEditor(token.id, event.currentTarget);
                        }}
                      >
                        <Edit2 size={11} />
                      </Button>
                      <Button
                        variant="danger"
                        size="icon"
                        type="button"
                        data-token-delete-row={token.id}
                        title={t("tokens.deleteAction")}
                        aria-label={t("tokens.deleteAction")}
                        className={`${STYLE_CARD_TRAILING_BG} opacity-0 group-hover:opacity-100 transition-[background-color,opacity] ease-snap duration-micro`}
                        onClick={(event) => {
                          event.stopPropagation();
                          commitSnapshot(removeTokenFromDoc(docRef.current, token.id));
                        }}
                      >
                        <Trash2 size={11} />
                      </Button>
                    </>
                  }
                />
              );
            })}
          </div>
        )}
      </Section>

      {dragUi && (
        <PaintDragGhost
          x={dragUi.x}
          y={dragUi.y}
          width={dragUi.width}
          swatch={dragUi.swatch}
          label={dragUi.label}
          mono={false}
        />
      )}

      {editingId && (
        <TokenEditorPanel
          key={editingId}
          token={editingToken}
          modes={modes}
          anchorRef={editorAnchorRef}
          onSave={save}
          onClose={() => setEditingId(null)}
        />
      )}
    </div>
  );
}
