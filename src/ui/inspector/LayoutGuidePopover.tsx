import { useRef } from "preact/hooks";
import { createPortal } from "preact/compat";
import type { DesignDocument, LayoutGuide } from "../../core/dsl/types";
import type { GuideBox } from "../../core/layout/layout-guides";
import { PanelHeader } from "../PanelHeader";
import { POPOVER_SURFACE_CLASS } from "../menu-style";
import { LayoutGuideFields } from "./layout-guide-fields";
import { useAnchoredPosition, placementStyle, sidePanelCompute } from "../hooks/useAnchoredPosition";
import { useDismiss } from "../hooks/useDismiss";
import { t } from "../../i18n";

export const GUIDE_POPOVER_WIDTH = 240;

/**
 * One guide's settings, floating beside the row that opened it.
 *
 * A guide's every field is read against the canvas ("drag the gutter, watch the
 * bands"), so none of them may sit in a panel that pushes the drawing away. That
 * is the whole reason this is a popover anchored to its row rather than a block
 * that expands inside the inspector — the row keeps its place, the numbers stay
 * beside the drawing, and the inspector stays one line per ruler.
 *
 * The fields themselves are `LayoutGuideFields`, shared with the style editor in
 * the design system so the two cannot ask for the same numbers differently.
 */
export function LayoutGuidePopover({
  anchor,
  guide,
  box,
  doc,
  onChange,
  onDragStart,
  onDragEnd,
  onClose
}: {
  anchor: HTMLElement;
  guide: LayoutGuide;
  box: GuideBox;
  doc?: DesignDocument;
  onChange: (next: LayoutGuide, commit?: boolean) => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const anchorRef = useRef<HTMLElement | null>(anchor);
  anchorRef.current = anchor;

  const pos = useAnchoredPosition({
    anchorRef,
    panelRef,
    deps: [guide],
    compute: sidePanelCompute(GUIDE_POPOVER_WIDTH, 320)
  });
  useDismiss(true, onClose, panelRef, anchorRef);

  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-label={t("layoutGuide.title")}
      data-layout-guide-popover={guide.kind}
      data-host-popover="true"
      style={placementStyle(pos, GUIDE_POPOVER_WIDTH)}
      className={`fixed z-[70] px-2.5 py-2 flex flex-col gap-1.5 text-ui select-none ${POPOVER_SURFACE_CLASS}`}
    >
      {/* The title is the SECTION, not the kind: the kind is the first control
          under it, and a heading that repeats the value below it is a second
          place to read the same word. */}
      <PanelHeader title={t("layoutGuide.title")} onClose={onClose} />
      <LayoutGuideFields
        guide={guide}
        box={box}
        doc={doc}
        onChange={onChange}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
      />
    </div>,
    document.body
  );
}
