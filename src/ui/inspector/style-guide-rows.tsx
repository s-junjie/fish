import { useState } from "preact/hooks";
import type { DesignDocument, LayoutGuide } from "../../core/dsl/types";
import { t } from "../../i18n";
import { GUIDE_KIND_ICON } from "./layout-guide-fields";
import { LayoutGuidePopover } from "./LayoutGuidePopover";
import { PAINT_ROW_CLASS, PAINT_ROW_RULE_IDLE, PAINT_ROW_RULE_OPEN } from "./paint-row-style";
import { Button } from "../Button";
import { Minus } from "lucide-react";

/** One guide as a row of text — the same wording the layer panel uses. */
/** A nominal box, so `retargetGuide` can seed a fixed band's width. A style has
 *  no frame of its own — the number it seeds is only a starting point, and the
 *  author overrides it in the very next field. */
const GUIDE_BOX = { width: 800, height: 600 };

const noop = () => {};

/** One guide, in the words a designer uses for it. */
function guideLabel(guide: LayoutGuide): string {
  if (guide.kind === "grid") return t("layoutGuide.summary.grid", { size: guide.size ?? 8 });
  return t(guide.kind === "columns" ? "layoutGuide.summary.columns" : "layoutGuide.summary.rows", {
    count: Math.max(1, Math.round(guide.count ?? 1))
  });
}

/**
 * A guide style's body: the fields, one block per guide.
 *
 * There is NO list of guides above them. The fields already start with the kind,
 * and a row that restates "13 columns" over a Count of 13 was a second place to
 * read one fact — it existed only so a style could hold several rulers, which is
 * rare enough to handle inline: each block carries its own remove button beside
 * the kind select, and the `+` in Properties appends.
 */
export function GuideRows({
  guides,
  doc,
  onChange,
  onDragStart = noop,
  onDragEnd = noop
}: {
  guides: LayoutGuide[];
  doc?: DesignDocument;
  onChange: (guides: LayoutGuide[], discrete?: boolean) => void;
  onDragStart?: () => void;
  onDragEnd?: () => void;
}) {
  const [open, setOpen] = useState<{ index: number; anchor: HTMLElement } | null>(null);
  const openIndex = open && open.index < guides.length ? open.index : null;

  return (
    <div className="space-y-1.5" data-style-guide-rows="true">
      {guides.map((guide, index) => {
        const KindIcon = GUIDE_KIND_ICON[guide.kind];
        return (
          <div
            key={index}
            data-style-guide-row={index}
            className={`${PAINT_ROW_CLASS} ${openIndex === index ? PAINT_ROW_RULE_OPEN : PAINT_ROW_RULE_IDLE}`}
          >
            <button
              type="button"
              className="h-full flex-1 min-w-0 flex items-center gap-2 text-left cursor-default"
              aria-expanded={openIndex === index}
              onClick={(e) =>
                setOpen(openIndex === index ? null : { index, anchor: e.currentTarget as HTMLElement })
              }
            >
              <span className="shrink-0 h-3.5 w-3.5 flex items-center text-ink-dim" aria-hidden="true">
                <KindIcon size={16} className="-ml-0.5" />
              </span>
              <span className="truncate text-row text-ink">{guideLabel(guide)}</span>
            </button>
            {guides.length > 1 && (
              <Button
                size="icon"
                type="button"
                data-style-guide-remove={index}
                title={t("layoutGuide.remove")}
                aria-label={t("layoutGuide.remove")}
                onClick={() => {
                  onChange(guides.filter((_, at) => at !== index));
                  setOpen(null);
                }}
              >
                <Minus size={12} />
              </Button>
            )}
          </div>
        );
      })}

      {open && openIndex !== null && (
        <LayoutGuidePopover
          anchor={open.anchor}
          guide={guides[openIndex]}
          box={GUIDE_BOX}
          doc={doc}
          onChange={(next, discrete) =>
            onChange(guides.map((g, i) => (i === openIndex ? next : g)), discrete)
          }
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  );
}
