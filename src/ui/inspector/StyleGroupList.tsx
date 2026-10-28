import { useRef } from "preact/hooks";
import { DesignStyle, Paint, PaintStyle, StyleType } from "../../core/dsl/types";
import { PaintDragGhost } from "../PaintDragGhost";
import { PaintDropIndicator } from "./PaintDropIndicator";
import { getStyleSubtitle, renderStylePreview } from "./StylePreview";
import { StyleCard, STYLE_CARD_TRAILING_BG } from "./StyleCard";
import { paintSwatchBackground } from "./paint-preview";
import { t } from "../../i18n";
import { GripVertical, Plus, Trash2, Edit2 } from "lucide-react";
import { usePaintStackDrag } from "../hooks/usePaintStackDrag";
import { Button } from "../Button";
import { Section } from "./SectionHeader";

interface StyleGroupListProps {
  styleType: StyleType;
  title: string;
  createTitle: string;
  styles: DesignStyle[];
  onCreate: (anchor: HTMLElement) => void;
  onEdit: (style: DesignStyle, anchor: HTMLElement) => void;
  onDelete: (styleId: string) => void;
  /** Rows are in document order, so the slot is a plain insertion index. */
  onReorder: (fromRow: number, insertBeforeRow: number) => void;
  /** Read-only groups (the surface half of Styles) still edit rows, but offer no plus. */
  canCreate?: boolean;
  /** How a card's mark finds the bitmap an image layer names — see `paintImageUri`. */
  imageUri?: (paint: Paint) => string | undefined;
}

/** Behind the checkerboard for a style whose mark has no colour of its own. */
const STYLE_GHOST_FALLBACK = "#242424";

export function StyleGroupList({
  styleType,
  title,
  createTitle,
  styles,
  onCreate,
  onEdit,
  onDelete,
  onReorder,
  canCreate = true,
  imageUri
}: StyleGroupListProps) {
  const listRef = useRef<HTMLDivElement | null>(null);

  const { dragUi, beginDrag } = usePaintStackDrag({
    listRef,
    rowAttr: "data-style-row",
    ghostFor: (uiPos) => {
      const style = styles[uiPos];
      return {
        swatch: paintSwatchBackground(
          style?.styleType === "paint" ? style.paints[0] : undefined,
          STYLE_GHOST_FALLBACK,
          imageUri
        ),
        label: style?.name ?? ""
      };
    },
    onCommit: onReorder
  });

  return (
    <Section
      id={`style-group-${styleType}`}
      title={title}
      trailing={
        canCreate ? (
          <Button
            size="icon"
            data-style-create={styleType}
            type="button"
            onClick={(e) => onCreate(e.currentTarget)}
            title={createTitle}
            aria-label={createTitle}
          >
            <Plus size={13} />
          </Button>
        ) : undefined
      }
    >
      {styles.length > 0 && (
        <div ref={listRef} data-style-group={styleType} className="space-y-1">
          {styles.map((style, uiPos) => {
            const sub = getStyleSubtitle(style);
            return (
              <StyleCard
                key={style.id}
                rowProps={{ "data-style-row": style.id }}
                className={`group ${dragUi?.fromUi === uiPos ? "opacity-40" : ""}`}
                /* The row IS the edit affordance, as a token row is: the design
                   system's Styles half is a management surface, so a card that
                   only opened its editor from a hover-only pencil made the
                   common action (open this style) the hardest one to hit. */
                onClick={(e) => onEdit(style, e.currentTarget)}
                leading={
                  <>
                    <PaintDropIndicator
                      active={!!dragUi && (dragUi.slot === uiPos || (uiPos === styles.length - 1 && dragUi.slot === styles.length))}
                      isLast={uiPos === styles.length - 1}
                      testId="style-drop-indicator"
                    />
                    {styles.length > 1 && (
                      <button
                        type="button"
                        data-style-handle={style.id}
                        title={t("styles.reorder")}
                        onPointerDown={(e) => beginDrag(uiPos, e)}
                        /* The grip lives inside the card that opens the editor:
                           a press that ends here is a grab, not a click. */
                        onClick={(e) => e.stopPropagation()}
                        className="text-ink-muted hover:text-ink p-0 shrink-0 cursor-grab active:cursor-grabbing touch-none -ml-1 -mr-1"
                      >
                        <GripVertical size={12} />
                      </button>
                    )}
                  </>
                }
                preview={renderStylePreview(style, undefined, imageUri)}
                name={style.name}
                subtitle={sub || undefined}
                trailing={
                  /* Each Button wears its own surface so the overlay occludes
                     the subtitle under it (see `STYLE_CARD_TRAILING_BG`). The
                     two `opacity-0`/`group-hover:opacity-100` pair used to live
                     on a single wrapping span, but that span kept them at zero
                     opacity together — fine when both were always-shown-together,
                     wrong when one row had a button and the next didn't, because
                     each row's overlay now lives in its own absolute slot.
                     The pencil stays even though the row itself edits — the same
                     pair a token row carries, so the two lists stay one habit. */
                  <>
                    <Button
                      size="icon"
                      type="button"
                      data-style-edit={style.id}
                      onClick={(e) => {
                        e.stopPropagation();
                        onEdit(style, e.currentTarget);
                      }}
                      title={t("styles.editStyle")}
                      className={`${STYLE_CARD_TRAILING_BG} opacity-0 group-hover:opacity-100 transition-[background-color,opacity] ease-snap duration-micro`}
                    >
                      <Edit2 size={11} />
                    </Button>
                    <Button
                      variant="danger"
                      size="icon"
                      type="button"
                      data-style-delete={style.id}
                      onClick={(e) => {
                        e.stopPropagation();
                        onDelete(style.id);
                      }}
                      title={t("styles.deleteStyle")}
                      className={`${STYLE_CARD_TRAILING_BG} opacity-0 group-hover:opacity-100 transition-[background-color,opacity] ease-snap duration-micro`}
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
    </Section>
  );
}
