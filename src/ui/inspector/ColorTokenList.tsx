import { useRef, useState } from "preact/hooks";
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
  reorderColorTokens
} from "../../core/interactions/token-ops";import {
  getActiveTheme,
  getDocumentModes,
  updateColorTokenWithModes
} from "../../core/interactions/mode-ops";
import { t } from "../../i18n";
import { TokenList } from "./TokenList";
import { renderColorTokenPreview } from "./StylePreview";
import { TokenEditorPanel, TokenEditorDraft } from "./TokenEditorPanel";
import { colorModeLabels } from "./mode-labels";

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
    <TokenList
      tokens={tokens}
      row={(token) => ({
        id: token.id,
        name: token.name,
        subtitle: colorModeLabels(token, modes).join(", "),
        preview: renderColorTokenPreview(token, activeTheme),
        ghostSwatch: colorTokenColor(token),
        ghostLabel: token.name
      })}
      rootAttr={{ "data-color-tokens": "1" }}
      sectionId="color-tokens"
      sectionTitle={t("tokens.title")}
      createTitle={t("tokens.createAction")}
      createAttr={{ "data-token-new": "1" }}
      listAttr={{ "data-token-list": "1" }}
      rowAttr="data-token-row"
      dropTestId="token-drop-indicator"
      editTitle={t("tokens.editAction")}
      deleteTitle={t("tokens.deleteAction")}
      onReorder={handleReorder}
      onDelete={(token) => commitSnapshot(removeTokenFromDoc(docRef.current, token.id))}
      onOpen={openEditor}
      onNew={(anchor) => openEditor("new", anchor)}
      editor={
        editingId ? (
          <TokenEditorPanel
            key={editingId}
            token={editingToken}
            modes={modes}
            anchorRef={editorAnchorRef}
            onSave={save}
            onClose={() => setEditingId(null)}
          />
        ) : null
      }
    />
  );
}
