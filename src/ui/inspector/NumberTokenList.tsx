import { useMemo, useRef, useState } from "preact/hooks";
import { toTokenMap } from "../../core/dsl/token-value";
import type { DesignDocument, NumberToken } from "../../core/dsl/types";
import {
  addTokenToDoc,
  removeTokenFromDoc,
  updateTokenInDoc
} from "../../core/interactions/style-ops";
import {
  createNumberToken,
  isNumberToken,
  mergeNumberTokenOrder,
  reorderNumberTokens
} from "../../core/interactions/number-token-ops";
import {
  getActiveNumberMode,
  getDocumentNumberModes,
  getNumberTokenModeValue,
  updateNumberTokenWithModes
} from "../../core/interactions/mode-ops";
import { t } from "../../i18n";
import { TokenList } from "./TokenList";
import { renderNumberTokenPreview } from "./StylePreview";
import { NumberTokenEditorDraft, NumberTokenEditorPanel } from "./NumberTokenEditorPanel";
import { numberModeLabels } from "./mode-labels";

interface NumberTokenListProps {
  doc: DesignDocument;
  docRef: { current: DesignDocument };
  commitSnapshot: (newDoc: DesignDocument) => void;
}

export function NumberTokenList({ doc, docRef, commitSnapshot }: NumberTokenListProps) {
  const [editingId, setEditingId] = useState<string | "new" | null>(null);
  const editorAnchorRef = useRef<HTMLElement | null>(null);
  const tokens = (doc.tokens || []).filter(isNumberToken);
  const editingToken =
    editingId && editingId !== "new"
      ? tokens.find((style) => style.id === editingId) ?? null
      : null;

  const handleReorder = (fromRow: number, insertBeforeRow: number) => {
    const current = (docRef.current.tokens || []).filter(isNumberToken);
    const next = reorderNumberTokens(current, fromRow, insertBeforeRow);
    if (next.length === current.length && next.every((t, i) => t.id === current[i].id)) return;
    commitSnapshot({ ...docRef.current, tokens: mergeNumberTokenOrder(docRef.current.tokens ?? [], next) });
  };

  // The NUMBER axis owns everything in this list: its columns and the ids its values are filed under.
  const modes = getDocumentNumberModes(doc);
  const tokenMap = useMemo(() => toTokenMap(doc.tokens), [doc.tokens]);

  const save = (draft: NumberTokenEditorDraft) => {
    const current = docRef.current;
    const baseModeId = getDocumentNumberModes(current)[0]?.id;
    const modeOverrides = draft.modes ?? draft.darkValue;
    if (editingId === "new") {
      const created = createNumberToken(draft.name, draft.value, draft.category, draft.description);
      const withModes = updateNumberTokenWithModes(
        created,
        draft.name,
        draft.category,
        draft.value,
        modeOverrides,
        draft.description,
        baseModeId
      );
      commitSnapshot(addTokenToDoc(current, withModes));
    } else if (editingToken) {
      const latest = (current.tokens || []).find(
        (entry): entry is NumberToken => isNumberToken(entry) && entry.id === editingToken.id
      );
      if (latest) {
        const updated = updateNumberTokenWithModes(
          latest,
          draft.name,
          draft.category,
          draft.value,
          modeOverrides,
          draft.description,
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
        subtitle: numberModeLabels(token, modes, tokenMap).join(", "),
        preview: renderNumberTokenPreview(token.category),
        ghostSwatch: "rgba(155,164,171,.35)",
        ghostLabel: `${token.name} (${getNumberTokenModeValue(token, getActiveNumberMode(doc), tokenMap)})`
      })}
      rootAttr={{ "data-number-tokens": "1" }}
      sectionId="number-tokens"
      sectionTitle={t("tokens.numberTitle")}
      createTitle={t("tokens.createNumberAction")}
      createAttr={{ "data-number-token-new": "1" }}
      listAttr={{ "data-number-token-list": "1" }}
      rowAttr="data-number-token-row"
      dropTestId="number-token-drop-indicator"
      editTitle={t("tokens.editNumberAction")}
      deleteTitle={t("tokens.deleteNumberAction")}
      onReorder={handleReorder}
      onDelete={(token) => commitSnapshot(removeTokenFromDoc(docRef.current, token.id))}
      onOpen={openEditor}
      onNew={(anchor) => openEditor("new", anchor)}
      editor={
        editingId ? (
          <NumberTokenEditorPanel
            token={editingToken}
            tokens={doc.tokens}
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
