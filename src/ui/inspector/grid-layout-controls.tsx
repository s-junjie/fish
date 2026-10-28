import type { AutoLayout, FrameElement } from "../../core/dsl/types";
import { equalGridRowHeight, gridCellWidth, gridColumnCount, gridRowCount, inFlowChildren, resolveTracks, trackFr, trackPx } from "../../core/compile";
import type { TrackSize } from "../../core/dsl/types";
import { ScrubInput } from "../ScrubInput";
import { SegmentedControl } from "../SegmentedControl";
import { ArrowDown, ArrowRight, Check, ChevronDown, SlidersHorizontal, GapHorizontal, GapVertical } from "lucide-react";
import { useCallback, useRef, useState } from "preact/hooks";
import { t } from "../../i18n";
import { useDismiss } from "../hooks/useDismiss";
import { PanelHeader } from "../PanelHeader";
import { ACTION_BUTTON_CLASS, ACTION_BAR_ON } from "./action-bar-style";
import { MENU_OPTION_CLASS, MENU_OPTION_NAME_CLASS, MENU_OPTION_NAME_ON_CLASS, MENU_OPTION_NOTE_CLASS, POPOVER_SURFACE_CLASS } from "../menu-style";
import { POPOVER_WIDTH } from "./StylePickerPopover";
import { useAnchoredPosition, placementStyle } from "../hooks/useAnchoredPosition";
import { createPortal } from "preact/compat";
import { spacingScrubHooks } from "../hooks/spacing-scrub";
import { FieldDropdown } from "./FieldDropdown";
import { PadMode, PadTuple } from "./pad-fields";
import { SUB_LABEL_CLASS } from "../label-tier";
import { ROW_SPREAD_CLASS } from "../row-style";
import { layoutOf } from "../../core/dsl/layout-flat";
import { LayoutPaddingBlock, StepperRow, pairs, refitTracks, round2 } from "./layout-controls-shared";

/**
 * One axis' tracks, with the switch that gets you there.
 *
 * The switch is ALWAYS rendered, and that is a fix rather than a flourish: the
 * fields used to appear only when the document already HAD tracks, and nothing
 * in the UI could create them — so a capability every import needs was
 * reachable only from an imported document. Choosing `Tracks` materialises the
 * division already on screen, so the switch never moves anything.
 */
function TrackAxis({
  axis,
  sizes,
  equalTracks,
  resolved,
  onDragStart,
  onDragEnd,
  onChange
}: {
  axis: "column" | "row";
  sizes?: TrackSize[];
  /** The equal division currently on screen, as an editable list. */
  equalTracks: number[];
  /** What `sizes` comes to in px right now, so freezing a track freezes the box. */
  resolved: number[];
  onDragStart: () => void;
  onDragEnd: () => void;
  /** `discrete` again separates the unit toggle from the size scrub above it. */
  onChange: (sizes: TrackSize[] | undefined, discrete?: boolean) => void;
}) {
  const explicit = Array.isArray(sizes) && sizes.length > 0;
  const list = sizes as TrackSize[];
  const replace = (index: number, track: TrackSize, discrete?: boolean) =>
    onChange(list.map((s, i) => (i === index ? track : s)), discrete);
  // One menu at a time, and which TRACK it belongs to is state rather than a
  // ref: the menu has to render, so it is dismissed the way every other menu is
  // — by the same gestures, from the same hook.
  const [openUnit, setOpenUnit] = useState<number | null>(null);
  const menuHost = useRef<HTMLDivElement>(null);
  useDismiss(openUnit !== null, useCallback(() => setOpenUnit(null), []), menuHost);
  return (
    <div className="space-y-1.5" data-stack-tracks={axis} ref={menuHost}>
      <div className={ROW_SPREAD_CLASS}>
        <span className={`${SUB_LABEL_CLASS} block`}>
          {axis === "column" ? t("stack.tracksColumns") : t("stack.tracksRows")}
        </span>
        <SegmentedControl<"equal" | "custom">
          value={explicit ? "custom" : "equal"}
          /* Equal and a list of equal `fr` weights are the same arrangement:
             both re-divide the content box whenever the frame is resized, and a
             list of equal px numbers only looks like one until something moves.
             So choosing `Tracks` materialises the SHARE already on screen, which
             also makes the stepper that follows behave — a track added to an `fr`
             list takes one share (see `refitTracks`) rather than the mean of the
             numbers it happened to resolve to. */
          onChange={(mode) => onChange(mode === "custom" ? equalTracks.map(() => ({ fr: 1 })) : undefined, true)}
          items={[
            { value: "equal", label: t("stack.tracksEqual"), attrs: { "data-stack-tracks-mode": `${axis}-equal` } },
            { value: "custom", label: t("stack.tracksCustom"), attrs: { "data-stack-tracks-mode": `${axis}-custom` } }
          ]}
        />
      </div>
      {explicit && (
        <div className="space-y-1">
          {pairs(list).map((pair) => (
            /* Two per row, not three. At three, a track's field was ~90px while
               the unit menu needs 216 — and a row is also what the menu hangs
               from, so it lands under the button that opened it instead of off
               one edge of the panel. */
            <div className="relative grid grid-cols-2 gap-1" key={pair[0].index}>
              {pair.map(({ track, index }) => {
                const weight = trackFr(track);
                const isFr = weight > 0 || typeof track !== "number";
                return (
                  <ScrubInput
                    key={index}
                    label={String(index + 1)}
                    value={isFr ? weight : (trackPx(track) ?? 0)}
                    /* A weight is a ratio, so it moves in tenths: `1fr` to `2fr`
                       in one drag steps over everything in between, and 3:2 is a
                       proportion anyone actually designs. A pixel track keeps a
                       whole-pixel step and cannot reach 0 — the engine floors a
                       cell at 1px anyway, so a field that accepted 0 would show
                       a number the canvas is not painting. */
                    step={isFr ? 0.1 : 1}
                    min={isFr ? 0.1 : 1}
                    max={isFr ? 24 : 4000}
                    onDragStart={onDragStart}
                    onDragEnd={onDragEnd}
                    onChange={(v) => replace(index, isFr ? { fr: Math.max(0.1, v) } : Math.max(1, v))}
                    /* The number in the well is a WEIGHT, so the one thing this
                       row cannot say for itself is how wide the track is now. */
                    title={
                      isFr
                        ? t("stack.trackWeightHint", { weight, px: Math.round(resolved[index] ?? 0) })
                        : t("stack.trackFixedHint", { px: Math.round(trackPx(track) ?? 0) })
                    }
                    /* The unit is the whole difference between "this many pixels
                       at any size" and "this share of what is left", and it is a
                       MENU rather than a second field: the two spellings are the
                       same number with a different meaning, so a second box would
                       only ever disagree with the first. A menu rather than a
                       toggle because the two sides are not symmetric — freezing
                       to px keeps the box where it is, while going to fr
                       rearranges the row — and a menu is where the sentence
                       saying so belongs. Same two-line option row as the size
                       menu's Fixed / Fill, so a unit reads as that kind of
                       choice rather than as a suffix. */
                    trailing={
                      <span className="flex-none flex items-center">
                        <button
                          type="button"
                          data-stack-track-unit={isFr ? "fr" : "px"}
                          aria-expanded={openUnit === index}
                          onClick={() => setOpenUnit(openUnit === index ? null : index)}
                          className="pl-[2px] pr-[6px] flex items-center gap-px text-meta text-ink-muted hover:text-brand cursor-default select-none"
                        >
                          {isFr ? "fr" : "px"}
                          <ChevronDown size={9} />
                        </button>
                      </span>
                    }
                  />
                );
              })}
              {pair.some((p) => p.index === openUnit) && (() => {
                const open = pair.find((p) => p.index === openUnit)!;
                const isFr = trackFr(open.track) > 0 || typeof open.track !== "number";
                return (
                  <FieldDropdown data-track-unit-menu={axis}>
                    {(["px", "fr"] as const).map((unit) => {
                      const on = unit === "fr" ? isFr : !isFr;
                      return (
                        <button
                          key={unit}
                          type="button"
                          data-track-unit-option={unit}
                          onClick={() => {
                            if (unit !== (isFr ? "fr" : "px")) {
                              // px freezes at what the track resolves to, so the
                              // box does not jump; fr is a share from here on.
                              replace(open.index, unit === "fr" ? { fr: 1 } : round2(resolved[open.index] ?? 0), true);
                            }
                            setOpenUnit(null);
                          }}
                          className={MENU_OPTION_CLASS}
                        >
                          <span className="flex items-center gap-2 w-full">
                            <span className={on ? MENU_OPTION_NAME_ON_CLASS : MENU_OPTION_NAME_CLASS}>
                              {unit}
                            </span>
                            {on && <Check size={11} className={`${MENU_OPTION_NAME_ON_CLASS} flex-none`} />}
                          </span>
                          <span className={MENU_OPTION_NOTE_CLASS}>
                            {t(unit === "fr" ? "stack.trackUnitFr" : "stack.trackUnitPx")}
                          </span>
                        </button>
                      );
                    })}
                  </FieldDropdown>
                );
              })()}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export interface GridLayoutControlsProps {
  frame: FrameElement;
  pad: PadTuple;
  padMode: PadMode;
  setPaddingMode: (m: PadMode) => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  onLayout: (
    patch: Partial<AutoLayout>,
    commit?: boolean,
    tokenBindingsPatch?: Record<string, string | undefined>
  ) => void;
}

export function GridLayoutControls({
  frame,
  pad,
  padMode,
  setPaddingMode,
  onDragStart,
  onDragEnd,
  onLayout
}: GridLayoutControlsProps) {
  const layout = layoutOf(frame)!;
  const [pt, pr] = pad;
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const advancedRef = useRef<HTMLDivElement | null>(null);
  const advancedTrigger = useRef<HTMLButtonElement | null>(null);
  useDismiss(advancedOpen, useCallback(() => setAdvancedOpen(false), []), advancedRef, advancedTrigger);

  /* Beside the trigger, not under it. Anchored to the button's own left edge and
     flipped right when the inspector rail leaves no room, which is the placement
     the style picker already uses — this is the fifth component that wanted it
     (`useAnchoredPosition`'s note names the other four). Portalled because the
     inspector rail is `absolute` + `overflow-hidden`, which clipped this panel
     against the rail's bottom edge whenever it opened near the bottom. */
  const advancedPos = useAnchoredPosition({
    anchorRef: advancedTrigger,
    panelRef: advancedRef,
    deps: [advancedOpen],
    compute: (anchor, panel) => {
      const a = anchor.getBoundingClientRect();
      let left = a.left - POPOVER_WIDTH - 10;
      if (left < 8) left = Math.min(a.right + 10, window.innerWidth - POPOVER_WIDTH - 8);
      left = Math.max(8, left);
      const height = panel.offsetHeight || 220;
      const top = Math.max(8, Math.min(a.top, window.innerHeight - height - 20));
      return { left, top };
    }
  });

  const isMasonry = layout.masonry === true;
  const authoredW = frame.width ?? 0;
  const authoredH = frame.height ?? 0;
  const contentW = Math.max(0, authoredW - pr - pad[3]);
  const contentH = Math.max(0, authoredH - pad[0] - pad[2]);
  const rowInfo = gridRowCount(layout, contentW, inFlowChildren(frame.children ?? []).length);
  // The equal division that is on screen RIGHT NOW, in both axes. The switch to
  // explicit tracks materialises exactly this, so choosing it cannot move
  // anything — which is the only reason a one-click switch into a forty-number
  // editor is a reasonable thing to offer.
  const columnTracks = new Array(gridColumnCount(layout, contentW)).fill(gridCellWidth(layout, contentW));
  const rowTracks = new Array(rowInfo.rows).fill(equalGridRowHeight(layout, contentH, rowInfo.rows));
  const isAuto = (layout.columnsMode ?? "fixed") === "auto";
  const colGap = layout.columnGap ?? layout.gap ?? 0;
  const rowGap = layout.rowGap ?? layout.gap ?? 0;
  const scrub = { onDragStart, onDragEnd } as const;

  /* The count the layout pass will actually use, which is the track list's
     length when there is one. Both steppers write through these so the number in
     the box and the number of track fields below it cannot disagree. */
  const columns = layout.columnSizes?.length || Math.round(layout.columns ?? 2) || 2;
  const rows = layout.rowSizes?.length || Math.round(layout.rows ?? 0);

  const setColumnCount = (n: number, discrete?: boolean) => {
    const count = Math.max(1, Math.round(n));
    if (!layout.columnSizes?.length) return onLayout({ columns: count }, discrete);
    onLayout({ columns: count, columnSizes: refitTracks(layout.columnSizes, count, contentW, colGap) }, discrete);
  };

  const setRowCount = (n: number, discrete?: boolean) => {
    const count = Math.max(0, Math.round(n));
    if (!layout.rowSizes?.length) return onLayout({ rows: count > 0 ? count : undefined }, discrete);
    const tracks = refitTracks(layout.rowSizes, Math.max(1, count), contentH, rowGap);
    onLayout({ rows: tracks.length, rowSizes: tracks }, discrete);
  };

  return (
    <div className="relative space-y-2.5 pt-1">
      <div className={ROW_SPREAD_CLASS}>
        <span className={SUB_LABEL_CLASS}>{t("stack.masonry")}</span>
        <SegmentedControl<boolean>
          value={isMasonry}
          onChange={(v) =>
            // Enabling masonry makes `rows` meaningless, so it goes now rather than
            // surviving hidden and reviving later.
            onLayout({ masonry: v || undefined, rows: v ? undefined : layout.rows }, true)
          }
          items={[
            { value: true, label: t("stack.yes") },
            { value: false, label: t("stack.no") }
          ]}
        />
      </div>

      {!isAuto && (
        <StepperRow
          label={t("stack.columns")}
          value={columns}
          min={1}
          max={12}
          axis="columns"
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          onChange={setColumnCount}
        />
      )}

      {/* Each axis' tracks sit under that axis' count, not in a block of their
          own further down: "Cols 3" then "Column tracks" reads as one thought,
          and a control below the fold is a control a user reports as missing —
          which is exactly how this one was reported. */}
      {!isMasonry && (
        <TrackAxis
          axis="column"
          sizes={layout.columnSizes}
          equalTracks={columnTracks}
          resolved={resolveTracks(layout.columnSizes ?? [], contentW, colGap)}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          onChange={(sizes, discrete) =>
            onLayout(
              sizes
                ? { columnSizes: sizes, columns: sizes.length }
                : { columnSizes: undefined, columns: layout.columnSizes?.length },
              discrete
            )
          }
        />
      )}

      {!isMasonry && (
        <StepperRow
          label={t("stack.rows")}
          value={rows}
          min={layout.rowSizes?.length ? 1 : 0}
          max={24}
          axis="rows"
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          onChange={setRowCount}
        />
      )}

      {!isMasonry && (
        <TrackAxis
          axis="row"
          sizes={layout.rowSizes}
          equalTracks={rowTracks}
          resolved={resolveTracks(layout.rowSizes ?? [], contentH, rowGap)}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          onChange={(sizes, discrete) =>
            onLayout(
              sizes
                ? { rowSizes: sizes, rows: sizes.length }
                : { rowSizes: undefined, rows: layout.rowSizes?.length },
              discrete
            )
          }
        />
      )}

      {/* Both axes, always. The link/unlink toggle was a fourth way to spell the
          same two numbers: it hid one field behind a ⊕/⊖ button whose icon read
          as "add / remove" rather than "one value or two", and it cost a click
          before you could see that the two axes were already different. */}
      <div className="flex items-center justify-between gap-1">
        <span className={`${SUB_LABEL_CLASS} shrink-0`}>{t("stack.gap")}</span>
        <div className="flex items-center gap-1 flex-1 justify-end">
          <ScrubInput label={<GapHorizontal size={12} />} title={t("stack.gap")} value={colGap} min={0}
            {...spacingScrubHooks({ elementId: frame.id, kind: "gap", sides: [], axis: "x" }, onDragStart, onDragEnd)}
            onChange={(v) => onLayout({ columnGap: v })} />
          <ScrubInput label={<GapVertical size={12} />} title={t("stack.gap")} value={rowGap} min={0}
            {...spacingScrubHooks({ elementId: frame.id, kind: "gap", sides: [], axis: "y" }, onDragStart, onDragEnd)}
            onChange={(v) => onLayout({ rowGap: v })} />
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
      />

      <button
        type="button"
        ref={advancedTrigger}
        onClick={() => setAdvancedOpen((p) => !p)}
        aria-expanded={advancedOpen}
        className={`${ACTION_BUTTON_CLASS} ${ACTION_BAR_ON} w-full`}
      >
        <SlidersHorizontal size={12} />
        {t("stack.advanced")}
      </button>

      {advancedOpen &&
        createPortal(
          /* A POPOVER, not a menu. This panel holds controls rather than rows,
             and the two wear different surfaces by DESIGN.md: a menu is `surface`
             because its rows sit on an open plate, a content popover is `panel`.
             `FieldDropdown` hard-writes `rounded-panel border-rule` and is the
             menu-adjacent option list. */
          <div
            ref={advancedRef}
            role="dialog"
            aria-label={t("stack.advancedLayout")}
            style={placementStyle(advancedPos, POPOVER_WIDTH)}
            className={`fixed px-3 py-3 flex flex-col space-y-2.5 select-none overflow-y-auto ${POPOVER_SURFACE_CLASS}`}
          >
          <PanelHeader title={t("stack.advancedLayout")} onClose={() => setAdvancedOpen(false)} />

          <div className={ROW_SPREAD_CLASS}>
            <span className={SUB_LABEL_CLASS}>{t("stack.columns")}</span>
            <SegmentedControl<boolean>
              value={isAuto}
              onChange={(auto) => onLayout({ columnsMode: auto ? "auto" : "fixed" }, true)}
              items={[
                { value: false, label: t("stack.columnsFixed") },
                { value: true, label: t("stack.columnsAuto") }
              ]}
            />
          </div>

          {isAuto && (
            <ScrubInput
              label={t("stack.widthMin")}
              value={layout.columnWidthMin ?? 100}
              min={20}
              {...scrub}
              onChange={(v) => onLayout({ columnWidthMin: Math.max(1, v) })}
            />
          )}

          <div className={ROW_SPREAD_CLASS}>
            <span className={SUB_LABEL_CLASS}>{t("stack.placement")}</span>
            <div className="flex bg-raised p-0.5 rounded-ctl border border-rule-strong">
              <button
                type="button"
                onClick={() => onLayout({ placement: "row" }, true)}
                aria-pressed={(layout.placement ?? "row") === "row"}
                className={`px-2 py-0.5 rounded-ctl text-ui transition-colors ${(layout.placement ?? "row") === "row" ? "bg-raised text-ink" : "text-ink-dim hover:text-ink"}`}
                title={t("stack.placementRow")}
              >
                <ArrowRight size={13} />
              </button>
              <button
                type="button"
                onClick={() => onLayout({ placement: "column" }, true)}
                aria-pressed={layout.placement === "column"}
                className={`px-2 py-0.5 rounded-ctl text-ui transition-colors ${layout.placement === "column" ? "bg-raised text-ink" : "text-ink-dim hover:text-ink"}`}
                title={t("stack.placementColumn")}
              >
                <ArrowDown size={13} />
              </button>
            </div>
          </div>

          <div className={ROW_SPREAD_CLASS}>
            <span className={SUB_LABEL_CLASS}>{t("stack.cellAlign")}</span>
            <SegmentedControl<string>
              value={layout.cellAlign ?? "stretch"}
              onChange={(v) => onLayout({ cellAlign: v as typeof layout.cellAlign }, true)}
              items={[
                { value: "stretch", label: t("stack.cellStretch") },
                { value: "start", label: t("stack.alignStart") },
                { value: "center", label: t("stack.alignCenter") },
                { value: "end", label: t("stack.alignEnd") }
              ]}
            />
          </div>
          </div>,
          document.body
        )}
    </div>
  );
}
