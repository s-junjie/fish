import { useRef } from "preact/hooks";
import type { ComponentChildren } from "preact";
import { Plus, Edit2, Trash2, GripVertical } from "lucide-react";
import { t } from "../../i18n";
import { Button } from "../Button";
import { Section } from "./SectionHeader";
import { StyleCard, STYLE_CARD_TRAILING_BG } from "./StyleCard";
import { PaintDropIndicator } from "./PaintDropIndicator";
import { PaintDragGhost } from "../PaintDragGhost";
import { usePaintStackDrag } from "../hooks/usePaintStackDrag";

/** One row, resolved: the colour list and the number list differ only in here. */
export interface TokenListRow {
  id: string;
  name: string;
  subtitle: string;
  /** The 24px mark at the top of the card — a swatch, or a category glyph. */
  preview: ComponentChildren;
  /** What the drag ghost shows instead of the row. */
  ghostSwatch: string;
  ghostLabel: string;
}

interface TokenListProps<T> {
  tokens: T[];
  row: (token: T) => TokenListRow;
  /** Attributes and copy the two axes name differently. */
  rootAttr: Record<string, string>;
  sectionId: string;
  sectionTitle: string;
  createTitle: string;
  createAttr: Record<string, string>;
  listAttr: Record<string, string>;
  rowAttr: string;
  dropTestId: string;
  editTitle: string;
  deleteTitle: string;
  onReorder: (fromRow: number, insertBeforeRow: number) => void;
  onDelete: (token: T) => void;
  onOpen: (id: string, anchor: HTMLElement) => void;
  onNew: (anchor: HTMLElement) => void;
  /** The editor, portalled by the caller: identity, not layout, is per-axis. */
  editor?: ComponentChildren;
}

/**
 * The Tokens tab's list, in the one shape both axes wear. The two lists were 75%
 * the same code and had drifted: only one carried the `stopPropagation` that
 * keeps a grip press from also opening the card's editor.
 */
export function TokenList<T>({
  tokens,
  row,
  rootAttr,
  sectionId,
  sectionTitle,
  createTitle,
  createAttr,
  listAttr,
  rowAttr,
  dropTestId,
  editTitle,
  deleteTitle,
  onReorder,
  onDelete,
  onOpen,
  onNew,
  editor
}: TokenListProps<T>) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const rows = tokens.map(row);

  const { dragUi, beginDrag } = usePaintStackDrag({
    listRef,
    rowAttr,
    ghostFor: (uiPos) => {
      const at = rows[uiPos];
      return { swatch: at?.ghostSwatch ?? "transparent", label: at?.ghostLabel ?? "" };
    },
    onCommit: onReorder
  });

  return (
    <div className="select-none" {...rootAttr}>
      <Section
        id={sectionId}
        title={sectionTitle}
        trailing={
          <Button
            size="icon"
            type="button"
            {...createAttr}
            title={createTitle}
            aria-label={createTitle}
            onClick={(event) => onNew(event.currentTarget)}
          >
            <Plus size={13} />
          </Button>
        }
      >
        {tokens.length === 0 ? null : (
          <div ref={listRef} className="space-y-1" {...listAttr}>
            {rows.map((item, uiPos) => (
              <StyleCard
                key={item.id}
                rowProps={{ [rowAttr]: item.id }}
                className={`group ${dragUi?.fromUi === uiPos ? "opacity-40" : ""}`}
                leading={
                  <>
                    <PaintDropIndicator
                      active={
                        !!dragUi &&
                        (dragUi.slot === uiPos ||
                          (uiPos === rows.length - 1 && dragUi.slot === rows.length))
                      }
                      isLast={uiPos === rows.length - 1}
                      testId={dropTestId}
                    />
                    {rows.length > 1 && (
                      <button
                        type="button"
                        data-token-handle={item.id}
                        title={t("styles.reorder")}
                        onPointerDown={(e) => beginDrag(uiPos, e)}
                        /* The grip sits inside the card that opens the editor: a
                           press that ends here is a grab, not a click. */
                        onClick={(e) => e.stopPropagation()}
                        className="text-ink-muted hover:text-ink p-0 shrink-0 cursor-grab active:cursor-grabbing touch-none -ml-1 -mr-1"
                      >
                        <GripVertical size={12} />
                      </button>
                    )}
                  </>
                }
                preview={item.preview}
                name={item.name}
                subtitle={item.subtitle}
                onClick={(event) => onOpen(item.id, event.currentTarget)}
                trailing={
                  <>
                    <Button
                      size="icon"
                      type="button"
                      data-token-edit={item.id}
                      title={editTitle}
                      aria-label={editTitle}
                      className={`${STYLE_CARD_TRAILING_BG} opacity-0 group-hover:opacity-100 transition-[background-color,opacity] ease-snap duration-micro`}
                      onClick={(event) => {
                        event.stopPropagation();
                        onOpen(item.id, event.currentTarget);
                      }}
                    >
                      <Edit2 size={11} />
                    </Button>
                    <Button
                      variant="danger"
                      size="icon"
                      type="button"
                      data-token-delete-row={item.id}
                      title={deleteTitle}
                      aria-label={deleteTitle}
                      className={`${STYLE_CARD_TRAILING_BG} opacity-0 group-hover:opacity-100 transition-[background-color,opacity] ease-snap duration-micro`}
                      onClick={(event) => {
                        event.stopPropagation();
                        onDelete(tokens[uiPos]);
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

      {editor}
    </div>
  );
}
