import type { AutoLayout, DesignDocument, FrameElement } from "../../core/dsl/types";
import { ScrubInput } from "../ScrubInput";
import { SegmentedControl } from "../SegmentedControl";
import { AlignmentPicker } from "./AlignmentPicker";
import { GapHorizontal, GapVertical } from "lucide-react";
import { useState } from "preact/hooks";
import { t } from "../../i18n";
import { findNumberToken } from "../../core/interactions/number-token-ops";
import { addTokenToDoc } from "../../core/interactions/style-ops";
import { NumberTokenPicker } from "./NumberTokenPicker";
import { spacingScrubHooks } from "../hooks/spacing-scrub";
import { PadMode, PadTuple } from "./pad-fields";
import { SUB_LABEL_CLASS } from "../label-tier";
import { ROW_SPREAD_CLASS } from "../row-style";
import { layoutOf } from "../../core/dsl/layout-flat";
import { flexCrossAlignReason } from "../../core/layout/flex-layout";
import { LayoutPaddingBlock } from "./layout-controls-shared";

const JUSTIFY_OPTIONS = [
  { value: "start", label: t("stack.distributeStart") },
  { value: "center", label: t("stack.distributeCenter") },
  { value: "end", label: t("stack.distributeEnd") },
  { value: "space-between", label: t("stack.distributeSpaceBetween") },
  { value: "space-around", label: t("stack.distributeSpaceAround") },
  { value: "space-evenly", label: t("stack.distributeSpaceEvenly") }
] as const;

const ALIGN_OPTIONS = [
  { value: "start", label: t("stack.alignStart") },
  { value: "center", label: t("stack.alignCenter") },
  { value: "end", label: t("stack.alignEnd") },
  { value: "stretch", label: t("stack.alignStretch") }
] as const;

export interface FlexLayoutControlsProps {
  frame: FrameElement;
  doc?: DesignDocument;
  docRef?: { current: DesignDocument };
  pad: PadTuple;
  padMode: PadMode;
  setPaddingMode: (m: PadMode) => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  /** Relayout runs inside, so every write here is a real layout change. */
  onLayout: (
    patch: Partial<AutoLayout>,
    commit?: boolean,
    tokenBindingsPatch?: Record<string, string | undefined>
  ) => void;
  /** The undo stream for a token edit saved from the gap/pad token pickers. */
  onCommitSnapshot?: (newDoc: DesignDocument) => void;
}

export function FlexLayoutControls({
  frame,
  doc,
  docRef,
  pad,
  padMode,
  setPaddingMode,
  onDragStart,
  onDragEnd,
  onLayout,
  onCommitSnapshot
}: FlexLayoutControlsProps) {
  const [gapPickerAnchor, setGapPickerAnchor] = useState<HTMLElement | null>(null);
  const [padPickerAnchor, setPadPickerAnchor] = useState<HTMLElement | null>(null);
  const layout = layoutOf(frame)!;
  const boundGapId = frame.tokenBindings?.gap;
  const boundGapToken = doc ? findNumberToken(doc.tokens ?? [], boundGapId) : undefined;
  const isMissingToken = Boolean(boundGapId && !boundGapToken);
  const boundPadId = frame.tokenBindings?.padding;
  const boundPadToken = doc ? findNumberToken(doc.tokens ?? [], boundPadId) : undefined;

  const isRow = layout.direction === "row";
  const isWrap = layout.wrap === "wrap";
  // `gap` is the uniform fallback; each axis reads its own field first. A row's
  // between-items gap is the COLUMN gap and its between-lines gap is the row gap,
  // a column swaps them — the same mapping the engine uses.
  const mainGap = (isRow ? layout.columnGap : layout.rowGap) ?? layout.gap ?? 0;
  const crossGap = (isRow ? layout.rowGap : layout.columnGap) ?? layout.gap ?? 0;
  // The gap fields wear an axis icon rather than an X/Y letter: the icon is also
  // the scrub handle, and a well whose handle is the space between two things
  // needs no reading of a letter that means "position" elsewhere in the panel.
  const mainGapIcon = isRow ? <GapHorizontal size={12} /> : <GapVertical size={12} />;
  const crossGapIcon = isRow ? <GapVertical size={12} /> : <GapHorizontal size={12} />;

  // A hugging cross axis is sized by its own lines, so there is no slack to hand
  // out; one line has nothing to divide; and lines taller than the frame have
  // eaten it already. In all three the engine reads `freeCross` as 0, so the menu
  // is disabled and says which one it is.
  //
  // The question is asked OF the engine rather than re-derived here: a second
  // derivation from stored coordinates disagrees with the pass on every child
  // whose envelope is not its stored box — a turned child is the common case —
  // and that disagreement is a control that is enabled and does nothing.
  const alignContentReason = flexCrossAlignReason(frame);
  const alignContentInert = alignContentReason !== null;
  const alignContentHint = alignContentReason
    ? t(
        alignContentReason === "hug"
          ? "stack.alignContentHug"
          : alignContentReason === "one-line"
            ? "stack.alignContentOneLine"
            : "stack.alignContentNoRoom",
        { axis: isRow ? "height" : "width" }
      )
    : "";

  return (
    <div className="space-y-2.5 pt-1">
      <div className={ROW_SPREAD_CLASS}>
        <span className={SUB_LABEL_CLASS}>{t("stack.distribute")}</span>
        <AlignmentPicker
          kind="justify"
          className="w-36"
          attrs={{ "data-stack-justify": "true" }}
          label={t("stack.distribute")}
          value={layout.justify ?? "start"}
          options={JUSTIFY_OPTIONS}
          onChange={(val) => onLayout({ justify: val as "start" }, true)}
        />
      </div>

      <div className={ROW_SPREAD_CLASS}>
        <span className={SUB_LABEL_CLASS}>{t("stack.align")}</span>
        <AlignmentPicker
          kind="align"
          className="w-36"
          attrs={{ "data-stack-align": "true" }}
          label={t("stack.align")}
          value={layout.align ?? "start"}
          options={ALIGN_OPTIONS}
          onChange={(val) => onLayout({ align: val as "start" }, true)}
        />
      </div>

      <div className={ROW_SPREAD_CLASS}>
        <span className={SUB_LABEL_CLASS}>{t("stack.wrap")}</span>
        <SegmentedControl<string>
          value={layout.wrap ?? "nowrap"}
          onChange={(w) => onLayout({ wrap: w as "nowrap" | "wrap" }, true)}
          items={[
            { value: "nowrap", label: t("stack.no") },
            { value: "wrap", label: t("stack.yes") }
          ]}
        />
      </div>

      {/* `align-content` hands out the cross-axis slack BETWEEN lines, so it can
          only move something when there is slack and more than one line. A frame
          that hugs its cross axis has none by definition, and one line has
          nothing to divide — in both cases the menu is disabled and says why,
          instead of accepting a choice that cannot be seen. */}
      {isWrap && (
        <div className="space-y-1">
          <div className={ROW_SPREAD_CLASS}>
            <span className={SUB_LABEL_CLASS}>{t("stack.alignContent")}</span>
            <AlignmentPicker
              kind="align-content"
              className="w-36"
              attrs={{ "data-stack-align-content": "true" }}
              label={t("stack.alignContent")}
              disabled={alignContentInert}
              value={layout.alignContent ?? "start"}
              options={JUSTIFY_OPTIONS}
              onChange={(val) => onLayout({ alignContent: val as "start" }, true)}
            />
          </div>
          {alignContentInert && (
            <p className="text-meta text-ink-muted leading-snug">{alignContentHint}</p>
          )}
        </div>
      )}

      {/* One gap field, plus a second only when wrapping made the two axes
          different things. The first writes the uniform shorthand, which clears
          any per-axis override — the same "one number, or two" the grid rows
          spell with two boxes, without the link toggle that read as add/remove. */}
      <div className="flex items-center justify-between gap-1">
        <span className={`${SUB_LABEL_CLASS} shrink-0`}>{t("stack.gap")}</span>
        <div className="flex items-center gap-1 flex-1 justify-end">
          <span className="contents" data-stack-gap="true">
            <ScrubInput
              label={mainGapIcon}
              title={t("stack.gap")}
              value={mainGap}
              min={0}
              tokenName={boundGapToken?.name ?? (isMissingToken ? t("tokens.missing") : undefined)}
              onOpenTokenPicker={doc ? (anchor) => setGapPickerAnchor(anchor) : undefined}
              onDetachToken={boundGapId ? () => onLayout({}, true, { gap: undefined }) : undefined}
              {...spacingScrubHooks(
                { elementId: frame.id, kind: "gap", sides: [], axis: isRow ? "x" : "y" },
                onDragStart,
                onDragEnd
              )}
              onChange={(gap) => onLayout({ gap, columnGap: undefined, rowGap: undefined }, false, { gap: undefined })}
            />
          </span>
          {isWrap && (
            <span className="contents" data-stack-line-gap="true">
              <ScrubInput
                label={crossGapIcon}
                title={t("stack.lineGap")}
                value={crossGap}
                min={0}
                {...spacingScrubHooks(
                  { elementId: frame.id, kind: "gap", sides: [], axis: isRow ? "y" : "x" },
                  onDragStart,
                  onDragEnd
                )}
                onChange={(v) => onLayout(isRow ? { rowGap: v } : { columnGap: v })}
              />
            </span>
          )}
        </div>
      </div>

      <LayoutPaddingBlock
        frame={frame}
        pad={pad}
        padMode={padMode}
        setPaddingMode={setPaddingMode}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onLayout={onLayout}
        token={{ boundId: boundPadId, name: boundPadToken?.name, onDetach: () => onLayout({}, true, { padding: undefined }) }}
        onOpenTokenPicker={doc ? (anchor) => setPadPickerAnchor(anchor) : undefined}
        onDetachToken={() => onLayout({}, true, { padding: undefined })}
      />

      {gapPickerAnchor && doc && (
        <NumberTokenPicker
          doc={doc}
          docRef={docRef}
          anchor={gapPickerAnchor}
          boundTokenId={boundGapId}
          currentValue={mainGap}
          category="spacing"
          onSelect={(tok) => {
            if (docRef && !docRef.current.tokens?.some((t) => t.id === tok.id)) {
              docRef.current = addTokenToDoc(docRef.current, tok);
            }
            onLayout({ gap: tok.value, columnGap: undefined, rowGap: undefined }, true, {
              gap: tok.id
            });
          }}
          onDetach={() => onLayout({}, true, { gap: undefined })}
          onCommitSnapshot={onCommitSnapshot}
          onClose={() => setGapPickerAnchor(null)}
        />
      )}

      {padPickerAnchor && doc && (
        <NumberTokenPicker
          doc={doc}
          docRef={docRef}
          anchor={padPickerAnchor}
          boundTokenId={boundPadId}
          currentValue={pad[0]}
          category="spacing"
          onSelect={(tok) => {
            if (docRef && !docRef.current.tokens?.some((t) => t.id === tok.id)) {
              docRef.current = addTokenToDoc(docRef.current, tok);
            }
            onLayout({ padding: [tok.value, tok.value, tok.value, tok.value] }, true, {
              padding: tok.id
            });
            setPadPickerAnchor(null);
          }}
          onDetach={() => {
            onLayout({}, true, { padding: undefined });
            setPadPickerAnchor(null);
          }}
          onCommitSnapshot={onCommitSnapshot}
          onClose={() => setPadPickerAnchor(null)}
        />
      )}
    </div>
  );
}
