import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { ColorToken, DesignElement, DesignDocument, Stroke, StrokeStyle, Paint } from "../../core/dsl/types";
import { DEFAULT_STROKE_ROW } from "./style-draft-defaults";
import { effectiveStrokes, moveStackRow, stackRows } from "../../core/dsl/paint-stack";
import { deepEqual } from "../../core/deep-equal";
import { ColorPanel } from "../ColorPanel";
import { StrokePanel } from "./StrokePanel";
import { ScrubInput } from "../ScrubInput";
import { PaintDragGhost } from "../PaintDragGhost";
import { t } from "../../i18n";
import { Eye, EyeOff, GripVertical, Plus, Minus, SlidersHorizontal } from "lucide-react";
import { PaintDropIndicator } from "./PaintDropIndicator";
import { paintGhostLabel, paintImageUri, paintRowLabel, paintSwatchBackground } from "./paint-preview";
import { STROKE_PAINT_TABS } from "../paint-kind";
import { renderStylePreview } from "./StylePreview";
import { StylePill } from "./StylePill";
import {
  PAINT_ROW_RULE_IDLE,
  PAINT_ROW_RULE_OPEN,
  PAINT_ROW_CLASS
} from "./paint-row-style";
import { addTokenToDoc, bindCompositeStrokeStyle, unbindCompositeStrokeStyle } from "../../core/interactions/style-ops";
import { colorTokenColor } from "../../core/interactions/token-ops";
import { bindNumberTokenToElement, unbindNumberTokenFromElement, findNumberToken } from "../../core/interactions/number-token-ops";
import { NumberTokenPicker } from "./NumberTokenPicker";
import { usePaintStackDrag } from "../hooks/usePaintStackDrag";
import { useStyleBindAction } from "../hooks/useStyleBindAction";
import { isGradientPaint } from "../../core/geometry/gradient-utils";
import { Section } from "./SectionHeader";
import { Button } from "../Button";
import { ColorRow } from "./ColorRow";

/** A stroke paints no image, so this fallback is only ever a safety net. */
const STROKE_SWATCH_FALLBACK = "#000000";

interface StrokeSectionProps {
  /** The whole selection: the stack below is read across all of it. */
  elements: DesignElement[];
  primarySelected: DesignElement | null;
  docRef: { current: DesignDocument };
  onMutate: (updater: (el: DesignElement) => DesignElement, commitImmediately?: boolean) => void;
  onCommitSnapshot: (newDoc: DesignDocument) => void;
  onDragStart: () => void;
  onDragEnd: () => void;
}

export function StrokeSection({
  elements,
  primarySelected,
  docRef,
  onMutate,
  onCommitSnapshot,
  onDragStart,
  onDragEnd
}: StrokeSectionProps) {
  const [open, setOpen] = useState<{ index: number; anchor: HTMLElement } | null>(null);
  const [settingsOpen, setSettingsOpen] = useState<{ index: number; anchor: HTMLElement } | null>(null);
  const [strokeWidthPicker, setStrokeWidthPicker] = useState<{ index: number; anchor: HTMLElement } | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const selectedId = primarySelected?.id;
  const boundStrokeWidthId = primarySelected?.tokenBindings?.strokeWidth;
  const boundStrokeWidthToken = boundStrokeWidthId ? findNumberToken(docRef.current.tokens ?? [], boundStrokeWidthId) : undefined;

  // Every hook must run before the early return, so `strokes` is derived here.
  const strokes: Stroke[] = primarySelected
    ? ((primarySelected as any).strokes || [])
    : [];
  const hasStrokes = strokes.length > 0;

  /**
   * Whether the selection's stroke stacks actually agree — the Fill section's rule,
   * for the same reason: a stack has no Mixed, so a differing selection gets Figma's
   * one sentence and a `+` that replaces, rather than the primary's rows presented
   * as the selection's.
   */
  const stacksMixed = useMemo(() => {
    if (elements.length < 2) return false;
    const read = (el: DesignElement) => effectiveStrokes(el) ?? [];
    const first = read(elements[0]);
    return elements.some((el) => !deepEqual(read(el), first));
  }, [elements]);
  const rows = stackRows(strokes);

  const paintOf = (stroke: Stroke): Paint =>
    stroke.paint || { type: "solid", color: stroke.color || STROKE_SWATCH_FALLBACK };

  /**
   * The STROKE style the whole stack wears.
   *
   * Only a stroke style can own a stroke: the four style kinds are independent,
   * and a row has no style pointer of its own — its colour is a value or a
   * colour token. So this is the one binding this section reads.
   */
  const elementStrokeStyleId = (primarySelected as { strokeStyleId?: string | null } | null)
    ?.strokeStyleId;
  const boundStrokeStyle = elementStrokeStyleId
    ? ((docRef.current.styles || []).find(
        (s) => s.id === elementStrokeStyleId && s.styleType === "stroke"
      ) as StrokeStyle | undefined)
    : undefined;

  /** The URI an image layer needs to preview, as the pill's mark does. */
  const imageUriOf = paintImageUri(docRef.current);

  const sectionStyleBind = useStyleBindAction<StrokeStyle>({
    styleType: "stroke",
    boundStyle: boundStrokeStyle,
    docRef,
    currentSelection: {
      type: "stroke",
      elementId: selectedId,
      strokes: strokes.length ? strokes : [DEFAULT_STROKE_ROW]
    },
    bind: bindCompositeStrokeStyle,
    unbind: unbindCompositeStrokeStyle,
    onMutate,
    onCommitSnapshot
  });

  useEffect(() => {
    setOpen(null);
    setSettingsOpen(null);
    sectionStyleBind.close();
  }, [selectedId, sectionStyleBind.close]);

  const { dragUi, beginDrag } = usePaintStackDrag({
    listRef,
    rowAttr: "data-paint-row",
    ghostFor: (uiPos) => {
      const stroke = rows[uiPos]?.item;
      if (!stroke) return { swatch: STROKE_SWATCH_FALLBACK, label: "" };
      return {
        swatch: paintSwatchBackground(paintOf(stroke), STROKE_SWATCH_FALLBACK, imageUriOf),
        label: paintGhostLabel(paintOf(stroke))
      };
    },
    onCommit: (fromUi, insertBeforeUi) => {
      const next = moveStackRow(strokes, fromUi, insertBeforeUi);
      if (!next.some((s, i) => s !== strokes[i])) return;
      setOpen(null);
      setSettingsOpen(null);
      onMutate((el) => ({ ...el, strokes: next } as any), true);
    }
  });

  if (!primarySelected || primarySelected.type === "video" || primarySelected.type === "html") return null;

  /**
   * The `color` mirror a paint leaves behind.
   *
   * `paint` is authoritative, but the shorthand is what older readers (and the
   * SVG writer's fallback) still consult, so every paint this section writes
   * keeps it in step.
   */
  const legacyColorOf = (paint: Paint): string =>
    paint.type === "solid"
      ? paint.color
      : paint.type === "pattern"
        ? paint.foreground
        : (paint as { from?: string }).from || STROKE_SWATCH_FALLBACK;

  const handleAddStroke = () => {
    /* A new row copies the TOP row's PAINT — the colour it is showing — not a
       default black. A row has no style pointer to carry: the only thing a row
       can follow is a colour token, and that comes along with the paint. */
    const lastStroke = strokes[strokes.length - 1];
    const lastPaint = lastStroke ? paintOf(lastStroke) : undefined;
    const newStroke: Stroke = {
      color: lastPaint ? legacyColorOf(lastPaint) : STROKE_SWATCH_FALLBACK,
      width: 1,
      style: "solid",
      align: "inside",
      enabled: true,
      ...(lastPaint && lastPaint.type !== "solid" ? { paint: lastPaint } : {}),
      ...(lastStroke?.tokenId ? { tokenId: lastStroke.tokenId } : {})
    };
    const base = stacksMixed ? [] : (primarySelected ? strokes : []);
    const nextStrokes = [...base, newStroke];
    onMutate((el) => ({ ...el, strokes: nextStrokes } as any), true);
  };

  const handleUpdateStroke = (index: number, nextStroke: Stroke, commit = false) => {
    const nextStrokes = [...strokes];
    nextStrokes[index] = nextStroke;
    onMutate((el) => {
      let nextEl = { ...el, strokes: nextStrokes } as any;
      if (nextStroke.width !== strokes[index]?.width && el.tokenBindings?.strokeWidth) {
        nextEl = unbindNumberTokenFromElement(nextEl, "strokeWidth");
      }
      return nextEl;
    }, commit);
  };

  const handleToggleEnabled = (index: number) => {
    const nextStrokes = [...strokes];
    const cur = nextStrokes[index];
    nextStrokes[index] = { ...cur, enabled: cur.enabled === false ? true : false };
    onMutate((el) => ({ ...el, strokes: nextStrokes } as any), true);
  };

  const handleDeleteStroke = (index: number) => {
    if (open?.index === index) setOpen(null);
    if (settingsOpen?.index === index) setSettingsOpen(null);
    const nextStrokes = strokes.filter((_, i) => i !== index);
    onMutate((el) => ({ ...el, strokes: nextStrokes } as any), true);
  };

  const openPanel = (index: number, anchor: HTMLElement) => {
    setOpen((cur) => (cur && cur.index === index ? null : { index, anchor }));
  };

  const handleBindToken = (index: number, token: ColorToken) => {
    const stroke = strokes[index];
    if (!stroke) return;
    const exists = (docRef.current.tokens || []).some((t) => t.id === token.id);
    if (!exists) {
      docRef.current = addTokenToDoc(docRef.current, token);
    }
    const color = colorTokenColor(token, docRef.current.activeTheme);
    handleUpdateStroke(
      index,
      {
        ...stroke,
        color,
        // A row's colour can follow a TOKEN — a value. It cannot follow a style:
        // a stroke is owned by a stroke style or by nothing.
        tokenId: token.id,
        paint: { type: "solid", color, tokenId: token.id }
      },
      true
    );
  };

  const openStroke = open ? strokes[open.index] : undefined;

  /** Drop one row's colour TOKEN, keeping the colour it is showing. */
  const detachRowToken = (index: number) => {
    const stroke = strokes[index];
    if (!stroke) return;
    const next: Stroke = { ...stroke };
    delete next.tokenId;
    if (next.paint && next.paint.type === "solid") {
      const paint = { ...next.paint } as { tokenId?: string };
      delete paint.tokenId;
      next.paint = paint as Stroke["paint"];
    }
    handleUpdateStroke(index, next, true);
  };

  /* The pieces a row is made of, written once: a bound row is a two-line CARD
     and a free one is a single line, and the width, the settings, the eye and
     the minus are the same controls on both. Two copies would drift — this
     section's job is already to keep one row's paint and geometry agreeing. */
  const strokeGrip = (uiPos: number, idx: number) =>
    rows.length > 1 ? (
      <button
        type="button"
        data-paint-handle={idx}
        title={t("paint.reorder")}
        onPointerDown={(e) => beginDrag(uiPos, e)}
        className="text-ink-muted hover:text-ink p-0 shrink-0 cursor-grab active:cursor-grabbing touch-none -ml-1 -mr-1"
      >
        <GripVertical size={12} />
      </button>
    ) : null;

  const strokeWidth = (idx: number, stroke: Stroke) => (
    <div className={`${boundStrokeWidthToken ? "w-28" : "w-16"} shrink-0 transition-all`}>
      <ScrubInput
        compact
        label={
          stroke.side === "top"
            ? "T"
            : stroke.side === "bottom"
            ? "B"
            : stroke.side === "left"
            ? "L"
            : stroke.side === "right"
            ? "R"
            : stroke.side === "custom"
            ? "C"
            : "W"
        }
        value={stroke.width || 1}
        min={0}
        tokenName={boundStrokeWidthToken?.name}
        onDetachToken={
          boundStrokeWidthId
            ? () => onMutate((el) => unbindNumberTokenFromElement(el, "strokeWidth"), true)
            : undefined
        }
        onOpenTokenPicker={(anchor) => setStrokeWidthPicker({ index: idx, anchor })}
        title={
          stroke.side === "top"
            ? t("paint.topStrokeWidth")
            : stroke.side === "bottom"
            ? t("paint.bottomStrokeWidth")
            : stroke.side === "left"
            ? t("paint.leftStrokeWidth")
            : stroke.side === "right"
            ? t("paint.rightStrokeWidth")
            : undefined
        }
        onDragStart={onDragStart}
        onDragEnd={() => {
          onDragEnd();
          onCommitSnapshot(docRef.current);
        }}
        onChange={(w) => {
          handleUpdateStroke(idx, { ...stroke, width: w });
        }}
      />
    </div>
  );

  const strokeSettings = (idx: number) => (
    <button
      type="button"
      data-stroke-settings={idx}
      onClick={(e) => {
        e.stopPropagation();
        setSettingsOpen((cur) =>
          cur?.index === idx ? null : { index: idx, anchor: e.currentTarget as HTMLElement }
        );
      }}
      className="text-ink-dim hover:text-ink p-0.5 rounded-ctl hover:bg-raised transition-colors cursor-default shrink-0"
      title={t("paint.settings")}
      aria-label={t("paint.settings")}
    >
      <SlidersHorizontal size={12} />
    </button>
  );

  const strokeVisibility = (idx: number, isEnabled: boolean) => (
    <Button
      size="icon"
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        handleToggleEnabled(idx);
      }}
      title={isEnabled ? t("paint.hideStroke") : t("paint.showStroke")}
    >
      {isEnabled ? <Eye size={12} /> : <EyeOff size={12} />}
    </Button>
  );

  const strokeRemove = (idx: number) => (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        if (settingsOpen?.index === idx) setSettingsOpen(null);
        handleDeleteStroke(idx);
      }}
      className="text-ink-dim hover:text-measure-coral p-0.5 rounded-ctl hover:bg-raised transition-colors cursor-default"
      title={t("paint.removeStroke")}
    >
      <Minus size={12} />
    </button>
  );

  const addTitle = boundStrokeStyle ? t("paint.managedByStyleStroke") : t("paint.addStroke");

  return (
    <Section
      id="stroke"
      title={t("properties.stroke")}
      trailing={
        <>
          {sectionStyleBind.trigger}
          {sectionStyleBind.picker}
          <Button
            size="icon"
            type="button"
            onClick={handleAddStroke}
            disabled={!!boundStrokeStyle}
            title={addTitle}
            aria-label={addTitle}
          >
            <Plus size={13} />
          </Button>
        </>
      }
    >

      {/* A paint style owns a ROW's paint and nothing else — width, dash, side
          and position stay with the row (`bindStrokeStyle` keeps them, and
          `tests/styles.test.ts` pins that). So the binding lives IN the row, as
          the colour cell itself: the stack is the thing that has several
          colours, and one pill above it could only ever say "all of them are
          this style". A mixed selection still wins, because the rows below are
          the primary's and drawing them as the selection's is the misreport the
          sentence exists to avoid. */}
      {stacksMixed ? (
        <p data-paint-mixed="stroke" className="text-ui text-ink-muted">
          {t("properties.mixedContent")}
        </p>
      ) : boundStrokeStyle ? (
        <StylePill
          rowProps={{ "data-stroke-style-pill": boundStrokeStyle.id }}
          styleName={boundStrokeStyle.name}
          preview={renderStylePreview(boundStrokeStyle, "w-4 h-4", imageUriOf)}
          subtitle={boundStrokeStyle.strokes.map((s) => `${s.width}px`).join(", ")}
          selectTitle={t("styles.editStyle")}
          onSelect={sectionStyleBind.openFrom}
          onUnlink={() => onMutate((el) => unbindCompositeStrokeStyle(el, boundStrokeStyle), true)}
          unlinkTitle={t("styles.detachStyle")}
        />
      ) : hasStrokes && (
        <div ref={listRef} data-paint-stack="stroke" className="space-y-1.5">
          {rows.map(({ item: stroke, index: idx }, uiPos) => {
            const isEnabled = stroke.enabled !== false;
            const isOpen = open?.index === idx;
            const isSettingsOpen = settingsOpen?.index === idx;
            const strokePaint = paintOf(stroke);
            const isSolid = strokePaint.type === "solid";
            const isEditable = isSolid || isGradientPaint(strokePaint) || strokePaint.type === "pattern";
            const swatchBackground = paintSwatchBackground(
              strokePaint,
              stroke.color || STROKE_SWATCH_FALLBACK,
              imageUriOf
            );
            const dropIndicator = (
              <PaintDropIndicator
                active={!!dragUi && (dragUi.slot === uiPos || (uiPos === rows.length - 1 && dragUi.slot === rows.length))}
                isLast={uiPos === rows.length - 1}
              />
            );
            const stateClass = `${isOpen || isSettingsOpen ? PAINT_ROW_RULE_OPEN : PAINT_ROW_RULE_IDLE} ${
              !isEnabled ? "opacity-50" : ""
            } ${dragUi?.fromUi === uiPos ? "opacity-40" : ""}`;

            return (
              <div key={idx}>
                  <ColorRow
                    dataRowId={idx}
                    dataHexId={`stroke-${idx}`}
                    paint={strokePaint}
                    color={stroke.color}
                    /* This row's colour TOKEN, never its style pointer: a bound
                       row is the pill above, so reaching a ColorRow means the
                       colour is a value — either the row's `tokenId` or the
                       paint's own. */
                    tokenId={
                      stroke.tokenId ??
                      (strokePaint.type === "solid" ? strokePaint.tokenId : undefined)
                    }
                    doc={docRef.current}
                    disabled={!isEnabled}
                    isOpen={isOpen || isSettingsOpen}
                    showAlpha={false}
                    hexClassName="max-w-[48px] shrink"
                    swatchBackground={swatchBackground}
                    label={paintRowLabel(strokePaint)}
                    className={dragUi?.fromUi === uiPos ? "opacity-40" : ""}
                    leading={
                      <>
                        {dropIndicator}
                        {strokeGrip(uiPos, idx)}
                      </>
                    }
                    trailing={
                      <>
                        {strokeWidth(idx, stroke)}
                        {strokeSettings(idx)}
                        {strokeVisibility(idx, isEnabled)}
                        {strokeRemove(idx)}
                      </>
                    }
                    onChange={(nextColor) => {
                      handleUpdateStroke(idx, {
                        ...stroke,
                        color: nextColor,
                        paint: { type: "solid", color: nextColor }
                      });
                    }}
                    onCommit={() => onCommitSnapshot(docRef.current)}
                    onGestureStart={onDragStart}
                    onGestureEnd={onDragEnd}
                    onOpenColorPanel={(anchor) => {
                      if (isEditable) openPanel(idx, anchor);
                    }}
                    onBindToken={(token) => handleBindToken(idx, token)}
                    onDetachToken={() => detachRowToken(idx)}
                  />
              </div>
            );
          })}
        </div>
      )}

      {settingsOpen && strokes[settingsOpen.index] && (
        <StrokePanel
          stroke={strokes[settingsOpen.index]}
          anchor={settingsOpen.anchor}
          onClose={() => setSettingsOpen(null)}
          onChange={(patch, discrete) =>
            handleUpdateStroke(settingsOpen.index, { ...strokes[settingsOpen.index], ...patch }, discrete)
          }
          onCommit={() => onCommitSnapshot(docRef.current)}
          onGestureStart={onDragStart}
          onGestureEnd={onDragEnd}
          elementType={primarySelected.type}
        />
      )}

      {open && openStroke && (
        <ColorPanel
          title={t("paint.stroke")}
          paint={paintOf(openStroke)}
          anchor={open.anchor}
          doc={docRef.current}
          docRef={docRef}
          tabs={STROKE_PAINT_TABS}
          onChange={(next, discrete) => {
            handleUpdateStroke(open.index, {
              ...openStroke,
              paint: next,
              color: legacyColorOf(next)
            }, discrete);
          }}
          onGestureStart={onDragStart}
          onGestureEnd={onDragEnd}
          onClose={() => setOpen(null)}
        />
      )}

      {dragUi && (
        <PaintDragGhost
          x={dragUi.x}
          y={dragUi.y}
          width={dragUi.width}
          swatch={dragUi.swatch}
          label={dragUi.label}
        />
      )}

      {strokeWidthPicker && (
        <NumberTokenPicker
          doc={docRef.current}
          docRef={docRef}
          anchor={strokeWidthPicker.anchor}
          boundTokenId={boundStrokeWidthId}
          currentValue={strokes[strokeWidthPicker.index]?.width || 1}
          category="stroke"
          onSelect={(tok) => {
            if (!docRef.current.tokens?.some((t) => t.id === tok.id)) {
              docRef.current = addTokenToDoc(docRef.current, tok);
            }
            onMutate((el) => {
              const bound = bindNumberTokenToElement(el, "strokeWidth", tok.id, tok.value);
              const nextStrokes = ((bound as any).strokes || []).map((s: Stroke) =>
                ({ ...s, width: tok.value })
              );
              return { ...bound, strokes: nextStrokes };
            }, true);
            setStrokeWidthPicker(null);
          }}
          onDetach={() => {
            onMutate((el) => unbindNumberTokenFromElement(el, "strokeWidth"), true);
            setStrokeWidthPicker(null);
          }}
          onCommitSnapshot={onCommitSnapshot}
          onClose={() => setStrokeWidthPicker(null)}
        />
      )}
    </Section>
  );
}
