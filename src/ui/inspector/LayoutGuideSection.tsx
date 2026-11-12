import { useState } from "preact/hooks";
import { Eye, EyeOff, Minus, Plus } from "lucide-react";
import type {
  ComponentElement,
  DesignDocument,
  DesignElement,
  FrameElement,
  LayoutGuide,
  LayoutGuideStyle
} from "../../core/dsl/types";
import { guideSummary, withLayoutGuides } from "../../core/layout/layout-guides";
import { bindLayoutGuideStyle, unbindLayoutGuideStyle } from "../../core/interactions/style-ops";
import { StylePill } from "./StylePill";
import { renderStylePreview } from "./StylePreview";
import { useStyleBindAction } from "../hooks/useStyleBindAction";
import { PAINT_ROW_CLASS, PAINT_ROW_RULE_IDLE, PAINT_ROW_RULE_OPEN } from "./paint-row-style";
import { Section } from "./SectionHeader";
import { Button } from "../Button";
import { LayoutGuidePopover } from "./LayoutGuidePopover";
import { GUIDE_KIND_ICON } from "./layout-guide-fields";
import { t } from "../../i18n";

type GuidedFrame = FrameElement | ComponentElement;

/**
 * A new guide is a COLUMN rule — the one an author reaches for, and the one the
 * plan opens with: five bands, 20px gutter, no inset.
 */
function newGuide(): LayoutGuide {
  return { kind: "columns", count: 5, align: "stretch", gutter: 20, margin: 0 };
}

/** Showing a guide again DELETES the flag rather than writing `true`: absence is what "drawn" means. */
function toggleVisible(guide: LayoutGuide): LayoutGuide {
  const next = { ...guide };
  if (next.visible === false) delete next.visible;
  else next.visible = false;
  return next;
}

/**
 * The rulers a frame is measured against, as a section of its own.
 *
 * ONE ROW PER GUIDE, and the settings live in a popover anchored to that row —
 * the shape Figma uses, and the reason is the same one the fill and effect rows
 * have: a guide's every field is read against the canvas while you drag it, so
 * nothing here may push the drawing away. The inspector stays one line per ruler.
 *
 * The section sits directly above EXPORT: everything above paints the box, this
 * measures it, and export is what happens next.
 *
 * There is deliberately no empty-state menu of the three kinds: `+` is the entry
 * point, and a set of buttons offering three kinds before the author has decided
 * to have a guide is a question they have not been asked yet.
 *
 * Only a frame or a component has one: a `componentSet` is fitted to its variants
 * on every load, so its box is not stable, and an instance's geometry belongs to
 * its master. Both refusals are reported by the normalizer.
 */
export function LayoutGuideSection({
  primarySelected,
  doc,
  docRef,
  onMutate,
  onCommitSnapshot,
  onDragStart,
  onDragEnd
}: {
  primarySelected: DesignElement | null;
  doc: DesignDocument;
  docRef: { current: DesignDocument };
  onMutate: (updater: (el: DesignElement) => DesignElement, commitImmediately?: boolean) => void;
  onCommitSnapshot: (doc: DesignDocument) => void;
  onDragStart: () => void;
  onDragEnd: () => void;
}) {
  const [open, setOpen] = useState<{ frameId: string; index: number; anchor: HTMLElement } | null>(null);

  const frame =
    primarySelected && (primarySelected.type === "frame" || primarySelected.type === "component")
      ? (primarySelected as GuidedFrame)
      : null;
  const guides = frame?.layoutGuides ?? [];
  const boundStyle = frame?.layoutGuideStyleId
    ? ((doc.styles ?? []).find((style) => style.id === frame.layoutGuideStyleId) as LayoutGuideStyle | undefined)
    : undefined;

  /**
   * The style action every other appearance section has: the same Library button,
   * the same picker, the same create-then-apply commit. A guide has no binding
   * channel, so "apply" is a copy and `boundStyle` is always undefined — the
   * button reads as unbound, which is the truth.
   */
  const styleAction = useStyleBindAction<LayoutGuideStyle>({
    styleType: "layoutGuide",
    boundStyle,
    docRef,
    currentSelection: { type: "layoutGuide", guides, ...(frame ? { elementId: frame.id } : {}) },
    // Binding writes the id AND the ruler, the way a fill style writes
    // `fillStyleId` and `fills`: from then on the style is the source, and editing
    // it in the design system moves this frame too.
    bind: bindLayoutGuideStyle,
    // Unlinking keeps the guides: a detached ruler goes on measuring.
    unbind: (el) => unbindLayoutGuideStyle(el),
    onMutate,
    onCommitSnapshot,
    triggerProps: { "data-layout-guide-styles": "true" },
    closeOnSelect: true
  });

  if (!frame) return null;

  const write = (next: LayoutGuide[], commit = true) => onMutate((el) => withLayoutGuides(el, next), commit);
  const patch = (index: number, next: LayoutGuide, commit = false) =>
    write(
      guides.map((guide, at) => (at === index ? next : guide)),
      commit
    );

  // Resolved at render rather than closed in an effect: a popover whose row no
  // longer exists has nothing to point at, and the selection may already be on
  // another frame by the time this runs.
  const openIndex = open && open.frameId === frame.id && open.index < guides.length ? open.index : null;

  return (
    <Section
      id="layout-guide"
      title={t("layoutGuide.title")}
      className="space-y-1.5"
      trailing={
        <>
          {styleAction.trigger}
          {!boundStyle && (
            <Button
              size="icon"
              type="button"
              data-layout-guide-add="true"
              title={t("layoutGuide.add")}
              aria-label={t("layoutGuide.add")}
              onClick={() => {
                write([...guides, newGuide()]);
                setOpen(null);
              }}
            >
              <Plus size={13} />
            </Button>
          )}
        </>
      }
    >
      {boundStyle ? (
        <StylePill
          rowProps={{ "data-layout-guide-style-pill": boundStyle.id }}
          styleName={boundStyle.name}
          preview={renderStylePreview(boundStyle, "w-4 h-4")}
          subtitle={t("styles.guideCount", { n: boundStyle.guides.length })}
          selectTitle={t("styles.editStyle")}
          onSelect={styleAction.openFrom}
          onUnlink={() => onMutate((el) => unbindLayoutGuideStyle(el), true)}
          unlinkTitle={t("styles.detachStyle")}
        />
      ) : guides.map((guide, index) => {
        const summary = guideSummary(guide, frame);
        const KindIcon = GUIDE_KIND_ICON[guide.kind];
        return (
          // The same card a fill / stroke / effect row is: one bordered row, the
          // controls that act on it inside it. A guide is a thing in a list, not a
          // disclosure widget — no chevron, the whole row opens its settings.
          <div
            key={`${index}:${guide.kind}`}
            data-layout-guide-row={guide.kind}
            className={`${PAINT_ROW_CLASS} ${openIndex === index ? PAINT_ROW_RULE_OPEN : PAINT_ROW_RULE_IDLE}`}
          >
            <button
              type="button"
              data-layout-guide-summary={guide.kind}
              aria-expanded={openIndex === index}
              onClick={(e) => {
                const anchor = e.currentTarget as HTMLElement;
                setOpen(openIndex === index ? null : { frameId: frame.id, index, anchor });
              }}
              className={`h-full flex-1 min-w-0 flex items-center gap-2 text-left cursor-default ${
                guide.visible === false ? "opacity-50" : ""
              }`}
            >
              {/* A 24-viewBox glyph at 14 draws ~12px of ink; the fill row's
                  swatch above is a full 14px block, so at 14 the mark reads as
                  undersized and inset. Same slot, the icon at 16. */}
              <span className="shrink-0 h-3.5 w-3.5 flex items-center text-ink-dim" aria-hidden="true">
                <KindIcon size={16} className="-ml-0.5" />
              </span>
              <span className="truncate text-row text-ink">{t(summary.key, summary.vars)}</span>
            </button>
            <button
              type="button"
              data-layout-guide-eye={guide.kind}
              title={guide.visible === false ? t("layoutGuide.show") : t("layoutGuide.hide")}
              aria-label={guide.visible === false ? t("layoutGuide.show") : t("layoutGuide.hide")}
              onClick={() => patch(index, toggleVisible(guide), true)}
              className="shrink-0 p-1 rounded-ctl text-ink-dim hover:text-ink hover:bg-raised transition-colors cursor-default"
            >
              {guide.visible === false ? <EyeOff size={13} /> : <Eye size={13} />}
            </button>
            <button
              type="button"
              data-layout-guide-remove={guide.kind}
              title={t("layoutGuide.remove")}
              aria-label={t("layoutGuide.remove")}
              onClick={() => {
                write(guides.filter((_, at) => at !== index));
                setOpen(null);
              }}
              className="shrink-0 p-1 rounded-ctl text-ink-dim hover:text-ink hover:bg-raised transition-colors cursor-default"
            >
              <Minus size={13} />
            </button>
          </div>
        );
      })}

      {styleAction.picker}

      {open && openIndex !== null && (
        <LayoutGuidePopover
          anchor={open.anchor}
          guide={guides[openIndex]}
          box={frame}
          doc={doc}
          onChange={(next, commit) => patch(openIndex, next, commit)}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          onClose={() => setOpen(null)}
        />
      )}
    </Section>
  );
}
