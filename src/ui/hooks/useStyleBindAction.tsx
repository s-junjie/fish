import { useCallback, useRef, useState } from "preact/hooks";
import type { VNode } from "preact";
import {
  DesignDocument,
  DesignElement,
  DesignStyle,
  StyleType,
  getActivePage,
  updateActivePageElements
} from "../../core/dsl/types";
import { mapElements } from "../../core/geometry/tree-ops";
import { addStyleToDoc, updateStyleInDoc } from "../../core/interactions/style-ops";
import { StylePickerPopover, type CurrentSelectionPreview } from "../inspector/StylePickerPopover";
import { t } from "../../i18n";
import { Library } from "lucide-react";

interface StyleBindParams<S extends DesignStyle> {
  styleType: StyleType;
  /** The style the selection is bound to, or undefined when it carries its own. */
  boundStyle: S | undefined;
  docRef: { current: DesignDocument };
  /** Seeds the picker's "create from selection" draft. */
  currentSelection: CurrentSelectionPreview & { elementId?: string };
  /** Turns a picked style into the element's override. */
  bind: (el: DesignElement, style: S) => DesignElement;
  /** Drops the binding, leaving the style's values behind as a local copy. */
  unbind: (el: DesignElement, bound: S | undefined) => DesignElement;
  onMutate: (updater: (el: DesignElement) => DesignElement, commitImmediately?: boolean) => void;
  onCommitSnapshot: (newDoc: DesignDocument) => void;
  /**
   * Section-specific hook attributes for the button. Fill, Stroke, Effects and
   * Typography all bind the SAME style kind for some pairs, so `styleType`
   * alone cannot tell their buttons apart — and the e2e suites select them by
   * the attribute they had before this was shared.
   */
  triggerProps?: Record<string, string>;
}

const TRIGGER_TITLE: Record<string, string> = {
  paint: "styles.colorStyles",
  stroke: "styles.strokeStyles",
  text: "styles.textStyles",
  effect: "styles.effectStyles"
};

/**
 * The Library button and the picker it opens, for a section that binds one style
 * kind to the selection.
 *
 * Fill, Stroke, Effects and Typography each carried their own copy of this:
 * three refs, an open flag, and — the part that had actually drifted — the
 * twelve lines that write a new or edited style into the document AND bind it
 * in ONE snapshot. A commit that only registered the style left the layer
 * pointing at something the document did not contain, and the four copies were
 * free to differ on whether that happened.
 */
export function useStyleBindAction<S extends DesignStyle>({
  styleType,
  boundStyle,
  docRef,
  currentSelection,
  bind,
  unbind,
  onMutate,
  onCommitSnapshot,
  triggerProps
}: StyleBindParams<S>) {
  const [open, setOpen] = useState(false);
  // The picker positions against whatever last opened it, which may be the
  // button or the bound pill. A ref rather than state because the popover reads
  // it during its own layout effect, and a setState there would loop.
  const anchorRef = useRef<HTMLElement | null>(null);

  const bound = !!boundStyle;

  const toggleFrom = (el: HTMLElement) => {
    anchorRef.current = el;
    setOpen((v) => !v);
  };

  // Stable, so a "collapse everything when the selection changes" effect can
  // depend on it without re-subscribing to itself.
  const close = useCallback(() => setOpen(false), []);

  const commitStyle = (style: DesignStyle) => {
    const existing = (docRef.current.styles || []).find((s) => s.id === style.id);
    let nextDoc = existing
      ? updateStyleInDoc(docRef.current, style)
      : addStyleToDoc(docRef.current, style);
    const elId = currentSelection.elementId;
    if (elId) {
      // Binds off the ACTIVE page's tree, not the document root: a section shown
      // for a selection edits that selection, and the page is where it lives.
      const updated = mapElements(getActivePage(nextDoc).children, (el) =>
        el.id === elId ? bind(el, style as S) : el
      );
      nextDoc = updateActivePageElements(nextDoc, updated);
    }
    onCommitSnapshot(nextDoc);
  };

  const trigger = (
    <button
      ref={(node: HTMLElement | null) => {
        if (node && !anchorRef.current) anchorRef.current = node;
      }}
      type="button"
      data-style-library-trigger={styleType}
      {...triggerProps}
      onClick={(e) => toggleFrom(e.currentTarget)}
      className={`p-0.5 rounded-ctl transition-colors cursor-default ${
        bound ? "text-brand" : "text-ink-dim hover:text-ink"
      }`}
      title={t(TRIGGER_TITLE[styleType] ?? "styles.createStyle")}
      aria-label={t(TRIGGER_TITLE[styleType] ?? "styles.createStyle")}
      aria-expanded={open}
    >
      <Library size={13} />
    </button>
  );

  const picker: VNode | null = open ? (
    <StylePickerPopover
      styleType={styleType}
      doc={docRef.current}
      docRef={docRef}
      boundStyleId={boundStyle?.id}
      availableStyles={docRef.current.styles || []}
      anchorRef={anchorRef}
      currentSelection={currentSelection}
      onSelectStyle={(s) => onMutate((el) => bind(el, s as S), true)}
      onDetachStyle={() => onMutate((el) => unbind(el, boundStyle), true)}
      onSaveStyle={commitStyle}
      onCommitSnapshot={onCommitSnapshot}
      onClose={() => setOpen(false)}
    />
  ) : null;

  return {
    bound,
    trigger,
    picker,
    /** Opens the picker anchored on the bound-style pill instead of the button. */
    openFrom: toggleFrom,
    close
  };
}
