import { useRef, useState } from "preact/hooks";
import { Plus, Edit2, Trash2, GripVertical, Ruler, SquareRoundCorner, Minus, Maximize2, Type, Sparkles } from "lucide-react";
import type { DesignDocument, NumberToken, NumberTokenCategory } from "../../core/dsl/types";
import {
  addTokenToDoc,
  removeTokenFromDoc,
  updateTokenInDoc
} from "../../core/interactions/style-ops";
import {
  createNumberToken,
  isNumberToken,
  mergeNumberTokenOrder,
  reorderNumberTokens,
  updateNumberToken
} from "../../core/interactions/number-token-ops";
import {
  getActiveNumberMode,
  getDocumentNumberModes,
  switchDocumentNumberMode,
  updateNumberTokenWithModes
} from "../../core/interactions/mode-ops";
import { t } from "../../i18n";
import { Button } from "../Button";
import { Select } from "../Select";
import { Section } from "./SectionHeader";
import { StyleCard, STYLE_CARD_TRAILING_BG } from "./StyleCard";
import { NumberTokenEditorDraft, NumberTokenEditorPanel } from "./NumberTokenEditorPanel";
import { numberModeLabels } from "./mode-labels";
import { PaintDropIndicator } from "./PaintDropIndicator";
import { PaintDragGhost } from "../PaintDragGhost";
import { usePaintStackDrag } from "../hooks/usePaintStackDrag";

interface NumberTokenListProps {
  doc: DesignDocument;
  docRef: { current: DesignDocument };
  commitSnapshot: (newDoc: DesignDocument) => void;
}

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

export function NumberTokenList({ doc, docRef, commitSnapshot }: NumberTokenListProps) {
  const [editingId, setEditingId] = useState<string | "new" | null>(null);
  const editorAnchorRef = useRef<HTMLElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
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

  const { dragUi, beginDrag } = usePaintStackDrag({
    listRef,
    rowAttr: "data-number-token-row",
    ghostFor: (uiPos) => {
      const token = tokens[uiPos];
      return {
        swatch: "rgba(155,164,171,.35)",
        label: token ? `${token.name} (${token.value}px)` : ""
      };
    },
    onCommit: handleReorder
  });

  // The NUMBER axis owns everything in this list: its columns, its active
  // selection, and the ids its values are filed under.
  const modes = getDocumentNumberModes(doc);
  const activeNumberMode = getActiveNumberMode(doc);

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
    <div className="select-none" data-number-tokens="1">
      <Section
        id="number-tokens"
        title={t("tokens.numberTitle")}
        trailing={
          <div className="flex items-center gap-1.5">
            {/* One mode is not a choice: with a single number axis entry the list
                shows that entry's values, and a switcher would name a switch
                nobody can flip. */}
            {modes.length > 1 && (
              <Select
                value={activeNumberMode}
                onChange={(next) => commitSnapshot(switchDocumentNumberMode(docRef.current, next))}
                title={t("tokens.numberMode")}
                aria-label={t("tokens.numberMode")}
                data-number-mode-switcher="1"
                className="w-24"
              >
                {modes.map((mode) => (
                  <option key={mode.id} value={mode.id}>
                    {mode.name}
                  </option>
                ))}
              </Select>
            )}
            <Button
              size="icon"
              type="button"
              data-number-token-new="1"
              title={t("tokens.createNumberAction")}
              aria-label={t("tokens.createNumberAction")}
              onClick={(event) => openEditor("new", event.currentTarget)}
            >
              <Plus size={13} />
            </Button>
          </div>
        }
      >
        {tokens.length === 0 ? null : (
          <div ref={listRef} className="space-y-1" data-number-token-list="1">
            {tokens.map((token, uiPos) => (
                <StyleCard
                  key={token.id}
                  rowProps={{ "data-number-token-row": token.id }}
                  className={`group ${dragUi?.fromUi === uiPos ? "opacity-40" : ""}`}
                  leading={
                    <>
                      <PaintDropIndicator
                        active={
                          !!dragUi &&
                          (dragUi.slot === uiPos ||
                            (uiPos === tokens.length - 1 && dragUi.slot === tokens.length))
                        }
                        isLast={uiPos === tokens.length - 1}
                        testId="number-token-drop-indicator"
                      />
                      {tokens.length > 1 && (
                        <button
                          type="button"
                          data-token-handle={token.id}
                          title={t("styles.reorder")}
                          onPointerDown={(e) => beginDrag(uiPos, e)}
                          className="text-ink-muted hover:text-ink p-0 shrink-0 cursor-grab active:cursor-grabbing touch-none -ml-1 -mr-1"
                        >
                          <GripVertical size={12} />
                        </button>
                      )}
                    </>
                  }
                  preview={
                    <div className="w-6 h-6 rounded-swatch bg-inset border border-rule flex items-center justify-center text-ink-dim shrink-0">
                      <CategoryIcon category={token.category} />
                    </div>
                  }
                  name={token.name}
                  subtitle={`${numberModeLabels(token, modes).join(", ")} · ${t(
                    `tokens.categories.${token.category ?? "spacing"}` as any
                  )}`}
                  onClick={(event) => openEditor(token.id, event.currentTarget)}
                  trailing={
                    <>
                      <Button
                        size="icon"
                        type="button"
                        data-token-edit={token.id}
                        title={t("tokens.editNumberAction")}
                        aria-label={t("tokens.editNumberAction")}
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
                        title={t("tokens.deleteNumberAction")}
                        aria-label={t("tokens.deleteNumberAction")}
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
              ))}
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
        <NumberTokenEditorPanel
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
