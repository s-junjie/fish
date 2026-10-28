import { DesignStyle, Paint, StyleType } from "../../core/dsl/types";
import { t } from "../../i18n";
import { renderStylePreview, getStyleSubtitle } from "./StylePreview";
import { StyleCard, STYLE_CARD_TRAILING_BG } from "./StyleCard";
import { Plus, Search, Check, Edit2, Link2Off } from "lucide-react";
import { TEXT_FIELD_CLASS } from "../ScrubInput";
import { Button } from "../Button";
import { PanelHeader } from "../PanelHeader";

const HEADER_TITLE: Record<string, string> = {
  paint: "styles.colorStyles",
  stroke: "styles.strokeStyles",
  text: "styles.textStyles",
  effect: "styles.effectStyles"
};

interface StyleListViewProps {
  styleType: StyleType;
  boundStyleId?: string;
  styles: DesignStyle[];
  filterText: string;
  onFilterChange: (next: string) => void;
  onSelectStyle: (style: DesignStyle) => void;
  onEdit: (style: DesignStyle) => void;
  onDetachStyle?: () => void;
  onCreate: () => void;
  onClose: () => void;
  /** How a card's mark finds the bitmap an image layer names — see `paintImageUri`. */
  imageUri?: (paint: Paint) => string | undefined;
}

/** The list half of the style picker: search, the cards, and the three header actions. */
export function StyleListView({
  styleType,
  boundStyleId,
  styles,
  filterText,
  onFilterChange,
  onSelectStyle,
  onEdit,
  onDetachStyle,
  onCreate,
  onClose,
  imageUri
}: StyleListViewProps) {
  return (
    <>
      <PanelHeader
        title={t(HEADER_TITLE[styleType] ?? "styles.title")}
        onClose={onClose}
        className="pb-2 border-b border-rule-strong"
        actions={
          <>
            {boundStyleId && onDetachStyle && (
              <Button
                size="icon"
                type="button"
                onClick={() => {
                  onDetachStyle();
                  onClose();
                }}
                title={t("styles.detachStyle")}
                aria-label={t("styles.detachStyle")}
              >
                <Link2Off size={13} />
              </Button>
            )}
            <Button
              size="icon"
              type="button"
              onClick={onCreate}
              title={t("styles.createStyle")}
              aria-label={t("styles.createStyle")}
            >
              <Plus size={14} />
            </Button>
          </>
        }
      />

      {/* No `border-b` here: the search field and the cards below it are one
          continuous filter-and-results block, so a rule between them cut the
          two halves of a single interaction into two separate panels. The gap
          alone (`pb-1` + the list's `pt-2` = 12 px) is enough to read the
          break, and it lets the cards start higher up. */}
      <div className="pt-2 pb-1">
        <div className="relative flex items-center">
          <Search size={11} className="absolute left-2 text-ink-dim pointer-events-none" />
          <input
            type="text"
            name="style-search"
            value={filterText}
            onInput={(e) => onFilterChange((e.target as HTMLInputElement).value)}
            placeholder={t("styles.searchStyles")}
            className={`${TEXT_FIELD_CLASS} pl-6`}
          />
        </div>
      </div>

      {/* `pt-2 space-y-1.5` over the earlier `pt-1 space-y-0.5`: two cards sat 10
          px apart and read as one tall row with a hairline through it, not two
          cards. 6 px gap + the StyleCard's own 4 px internal padding puts two
          cards 14 px apart — enough to read as two rows, not enough to make the
          list airy. Both neighbours were measured and rejected: 4 px
          (`space-y-1`) still looked like the cards were sharing a row, 8 px
          (`space-y-2`) opened a gap wider than the row beat elsewhere in the
          inspector. 6 px is the author's call.

      {/* List container: -mx-2.5 px-2.5 allows the scrollbar to sit at the outer edge
          while cards maintain their full initial width (matching non-scrolling state exactly,
          just like Layer Panel). */}
      <div className="flex-1 overflow-y-auto -mx-2.5 px-2.5 pt-2 space-y-1.5 max-h-60">
        {styles.length === 0 ? (
          <div className="py-6 text-center text-ink-dim text-ui">
            <p>{t("styles.noStyles")}</p>
          </div>
        ) : (
          styles.map((style) => {
            const isBound = style.id === boundStyleId;
            return (
              <StyleCard
                key={style.id}
                rowProps={{
                  "data-style-list-row": style.id,
                  "data-style-list-bound": isBound ? "1" : undefined
                }}
                className="group"
                selected={isBound}
                onClick={() => onSelectStyle(style)}
                preview={renderStylePreview(style, undefined, imageUri)}
                name={style.name}
                subtitle={getStyleSubtitle(style) || undefined}
                trailing={
                  <>
                    {/* The Edit button wears `STYLE_CARD_TRAILING_BG` like the
                       group list's pair, so the overlay occludes the subtitle
                       the same way. `opacity-0 group-hover:opacity-100` moved
                       from a wrapper span to the button itself, because the
                       `Check` next to it has to stay at full opacity (it's the
                       bound-state marker, not a hover affordance) — two
                       children, two opacity answers, no wrapper that has to
                       pick. */}
                    <Button
                      size="icon"
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onEdit(style);
                      }}
                      title={t("styles.editStyle")}
                      aria-label={t("styles.editStyle")}
                      className={`${STYLE_CARD_TRAILING_BG} opacity-0 group-hover:opacity-100 transition-[background-color,opacity] ease-snap duration-micro`}
                    >
                      <Edit2 size={11} />
                    </Button>
                    {isBound && <Check size={12} className="text-brand shrink-0" />}
                  </>
                }
              />
            );
          })
        )}
      </div>
    </>
  );
}
