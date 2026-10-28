import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import {
  ColorToken,
  DesignElement,
  DesignDocument,
  ImagePaint,
  Paint,
  PaintStyle,
  TextElement,
  getActivePage,
  updateActivePageElements
} from "../../core/dsl/types";
import { mapElements } from "../../core/geometry/tree-ops";
import { moveStackRow, stackRows } from "../../core/dsl/paint-stack";
import { DEFAULT_ELEMENT_COLOR } from "../../core/dsl/defaults";
import { deepEqual } from "../../core/deep-equal";
import { loadImageFromFile } from "../../core/interactions/image-loader";
import { ColorPanel } from "../ColorPanel";
import { ScrubInput } from "../ScrubInput";
import { HexInput } from "../HexInput";
import { PaintDragGhost } from "../PaintDragGhost";
import { parseColorAlpha, composeColorAlpha } from "../../core/geometry/color-utils";
import { t } from "../../i18n";
import { Eye, EyeOff, GripVertical, Link2Off, Plus, Minus, Tag } from "lucide-react";
import { StylePill } from "./StylePill";
import { PaintDropIndicator } from "./PaintDropIndicator";
import { renderStylePreview } from "./StylePreview";
import {
  paintGhostLabel,
  paintImageUri,
  paintRowLabel,
  paintSwatchBackground,
  IMAGE_SWATCH_FALLBACK
} from "./paint-preview";
import {
  PAINT_HEX_FIELD_CLASS,
  PAINT_ROW_RULE_IDLE,
  PAINT_ROW_RULE_OPEN,
  PAINT_ROW_CLASS,
  PAINT_SWATCH_CHECKER,
  PAINT_SWATCH_CLASS
} from "./paint-row-style";
import { addTokenToDoc, bindFillStyle, unbindFillStyle } from "../../core/interactions/style-ops";
import { colorTokenColor } from "../../core/interactions/token-ops";
import { ColorTokenPicker } from "./ColorTokenPicker";
import { applySpanStyleToRange, spanStyleAt } from "../../core/interactions/text-spans";
import type { ActiveTextRange } from "../hooks/useInlineEditing";
import { setGradientEditTarget } from "../hooks/gradient-edit";
import {
  beginImageCrop,
  getImageCropTarget,
  setImageCropTarget,
  useImageCropTarget
} from "../hooks/image-crop-edit";
import { clearImagePaintOpenRequest, useImagePaintOpenRequest } from "../hooks/image-paint-open";
import { usePaintStackDrag } from "../hooks/usePaintStackDrag";
import { useStyleBindAction } from "../hooks/useStyleBindAction";
import { isGradientPaint } from "../../core/geometry/gradient-utils";
import { Section } from "./SectionHeader";
import { Button } from "../Button";
import { ColorRow } from "./ColorRow";

interface FillSectionProps {
  primarySelected: DesignElement | null;
  /** The whole selection: the stack below is read across all of it. */
  elements: DesignElement[];
  /** A live run selection, bound to the text it was made in. */
  activeSelection?: ActiveTextRange | null;
  docRef: { current: DesignDocument };
  onMutate: (updater: (el: DesignElement) => DesignElement, commitImmediately?: boolean) => void;
  onCommitSnapshot: (newDoc: DesignDocument) => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  /** Says why a refused action was refused; crop has three such reasons. */
  onHint?: (message: string) => void;
}

export function FillSection({
  elements,
  primarySelected,
  activeSelection,
  docRef,
  onMutate,
  onCommitSnapshot,
  onDragStart,
  onDragEnd,
  onHint
}: FillSectionProps) {
  const [open, setOpen] = useState<{ index: number; anchor: HTMLElement } | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const cropTarget = useImageCropTarget();
  const paintOpenRequest = useImagePaintOpenRequest();

  const selectedId = primarySelected?.id;
  // An embed owns its whole box: what is painted inside it is the framed page,
  // so a fill behind it would be invisible and the control would lie.
  const supported =
    !!primarySelected &&
    primarySelected.type !== "line" &&
    primarySelected.type !== "arrow" &&
    primarySelected.type !== "video" &&
    primarySelected.type !== "html";

  // Every hook below must run before the early return, so `fills` is derived here.
  const fills: Paint[] = supported ? ((primarySelected as any).fills || []) : [];
  const hasFills = fills.length > 0;

  /**
   * Whether the selection's stacks actually agree.
   *
   * Figma's rule, and the reason it is the only one available: a paint stack has
   * no Mixed. Three layers with two red fills each have no first fill to show and
   * no row to edit, and drawing the primary's two rows would present one layer's
   * stack as the selection's while `+` appended to a layer nobody asked about. So
   * when they differ the section says so and offers the one edit that IS
   * meaningful — `+`, which replaces every layer with one new fill.
   */
  const stacksMixed = useMemo(() => {
    if (elements.length < 2) return false;
    const first = (elements[0] as { fills?: Paint[] }).fills ?? [];
    return elements.some((el) => !deepEqual((el as { fills?: Paint[] }).fills ?? [], first));
  }, [elements]);

  /**
   * The colour of the selected CHARACTERS, when there is one.
   *
   * A run carries its own colour and the canvas paints it over the layer's, so
   * with a range armed the section has to read and write THAT — otherwise the
   * swatch shows the paragraph's colour while the edit lands on the run (or on
   * the paragraph, which is the bug this closes). The layer the run's colour
   * stands in for is the top-most one, because that is the layer the canvas uses
   * as the text's own colour.
   */
  const textEl = primarySelected?.type === "text" ? (primarySelected as TextElement) : null;
  const runRange =
    textEl && activeSelection && activeSelection.elementId === textEl.id && activeSelection.start < activeSelection.end
      ? activeSelection
      : null;
  const topSolidIndex = fills.reduce((top, f, i) => (f.type === "solid" && f.enabled !== false ? i : top), -1);
  const runColor = textEl && runRange ? spanStyleAt(textEl, runRange.start)?.color : undefined;
  const displayFills: Paint[] =
    runColor !== undefined && topSolidIndex >= 0
      ? fills.map((f, i) =>
          i === topSolidIndex ? { ...f, color: runColor, tokenId: undefined } : f
        )
      : fills;
  const rows = stackRows(displayFills);

  const boundStyle = (docRef.current.styles || []).find(
    (s) => s.id === primarySelected?.fillStyleId && s.styleType === "paint"
  ) as PaintStyle | undefined;

  /** The colour token a solid row follows, if it still exists in the document. */
  const tokenFor = (paint: Paint): ColorToken | undefined => {
    if (paint.type !== "solid" || !paint.tokenId) return undefined;
    return (docRef.current.tokens || []).find(
      (entry): entry is ColorToken => entry.type === "color" && entry.id === paint.tokenId
    );
  };

  const imageUri = paintImageUri(docRef.current);

  /**
   * This row is the one the canvas is cropping.
   *
   * Three things have to agree, and the third is the one that is easy to forget:
   * the store's target, the row it names, and the DOCUMENT actually being in crop
   * framing. Undoing the commit that entered crop leaves `fit: "cover"` behind
   * with the target still set, and a panel that kept offering Reset crop over a
   * framing the canvas is not cropping would be describing a mode that is not on.
   */
  const openImageCropActive =
    !!open &&
    !!primarySelected &&
    !!cropTarget &&
    cropTarget.elId === primarySelected.id &&
    cropTarget.paintIndex === open.index &&
    (displayFills[open.index] as ImagePaint | undefined)?.fit === "crop";

  const styleBind = useStyleBindAction<PaintStyle>({
    styleType: "paint",
    boundStyle,
    docRef,
    currentSelection: {
      type: "paint",
      elementId: selectedId,
      paints: fills.length > 0 ? fills : [{ type: "solid", color: DEFAULT_ELEMENT_COLOR }]
    },
    bind: (el, style) => bindFillStyle(el, style),
    unbind: (el, bound) => unbindFillStyle(el, bound),
    onMutate,
    onCommitSnapshot
  });
  const closePicker = styleBind.close;

  useEffect(() => {
    setOpen(null);
    closePicker();
  }, [selectedId, closePicker]);

  const { dragUi, beginDrag } = usePaintStackDrag({
    listRef,
    rowAttr: "data-paint-row",
    ghostFor: (uiPos) => {
      const fill = rows[uiPos]?.item;
      if (!fill) return { swatch: IMAGE_SWATCH_FALLBACK, label: "" };
      return {
        swatch: paintSwatchBackground(fill, IMAGE_SWATCH_FALLBACK, imageUri),
        label: paintGhostLabel(fill)
      };
    },
    onCommit: (fromUi, insertBeforeUi) => {
      const next = moveStackRow(fills, fromUi, insertBeforeUi);
      if (!next.some((f, i) => f !== fills[i])) return;
      setOpen(null);
      onMutate((el) => ({ ...el, fills: next }), true);
    }
  });

  // The open gradient row IS the on-canvas lever's target: while this panel is
  // up, the canvas hides the transform box and shows the gradient handles for
  // exactly this paint. Any other state (closed, solid row, other element)
  // clears it, so plain selection keeps its resize handles.
  //
  // Above the early return on purpose: this used to sit after it, so selecting a
  // line and then a rect changed the hook count between renders. Nothing threw —
  // Preact only warns in dev — but `options.__r` rebuilds the hook list every
  // render, so the effect below was being scheduled against a list one entry
  // shorter than the render that created it.
  const openPaint = open ? displayFills[open.index] : undefined;
  const openIsGradient = !!open && isGradientPaint(openPaint);
  useEffect(() => {
    if (open && openIsGradient && primarySelected) {
      setGradientEditTarget({ elId: primarySelected.id, paintIndex: open.index });
    } else {
      setGradientEditTarget(null);
    }
    return () => setGradientEditTarget(null);
  }, [open?.index, openIsGradient, selectedId]);

  /**
   * Crop mode is entered from two places that cannot see each other: this row's
   * Crop segment, where the row is already open, and a canvas double-click, where
   * it is not. The store is the one fact both can read, so the panel follows it —
   * opening the bitmap's own row, which is where Reset crop lives. A row whose
   * swatch is not mounted leaves the canvas chrome alone rather than dropping the
   * mode on the floor.
   */
  useEffect(() => {
    if (!cropTarget || !primarySelected || cropTarget.elId !== primarySelected.id) return;
    const swatch = listRef.current?.querySelector<HTMLElement>(
      `[data-paint-swatch="${cropTarget.paintIndex}"]`
    );
    if (!swatch) return;
    setOpen((cur) =>
      cur && cur.index === cropTarget.paintIndex ? cur : { index: cropTarget.paintIndex, anchor: swatch }
    );
  }, [cropTarget?.elId, cropTarget?.paintIndex, selectedId]);

  /**
   * A canvas double-click opens this row without entering (or leaving) any
   * framing: the panel is the destination, and the fit it was already showing is
   * what the panel reports.
   */
  useEffect(() => {
    if (!paintOpenRequest || !primarySelected || paintOpenRequest.elId !== primarySelected.id) return;
    const swatch = listRef.current?.querySelector<HTMLElement>(
      `[data-paint-swatch="${paintOpenRequest.paintIndex}"]`
    );
    if (!swatch) return;
    setOpen({ index: paintOpenRequest.paintIndex, anchor: swatch });
    clearImagePaintOpenRequest();
  }, [paintOpenRequest, selectedId]);

  /**
   * …and leaving the row leaves the mode. The row is where the mode's own
   * controls live, so a panel closed (or moved to another fill) under an active
   * crop would leave a canvas full of handles and no way to reset them.
   */
  useEffect(() => {
    if (!open || !primarySelected) {
      setImageCropTarget(null);
      return;
    }
    const cur = getImageCropTarget();
    if (cur && (cur.elId !== primarySelected.id || cur.paintIndex !== open.index)) {
      setImageCropTarget(null);
    }
  }, [open?.index, selectedId]);

  if (!supported) return null;

  /**
   * On a mixed selection this REPLACES rather than appends: the one edit that
   * makes sense across differing stacks is to give them all the same one, and
   * appending a second fill to layers that already disagree would only add a
   * third disagreement.
   */
  const handleAddFill = () => {
    const newFill: Paint = { type: "solid", color: DEFAULT_ELEMENT_COLOR };
    onMutate((el) => ({
      ...el,
      fillEnabled: true,
      fills: stacksMixed ? [newFill] : [...(el as { fills?: Paint[] }).fills ?? [], newFill]
    }), true);
  };

  const handleUpdateFill = (index: number, nextPaint: Paint, discrete?: boolean) => {
    // A colour picked while characters are selected is the RUN's colour. Only the
    // colour: a gradient or a bitmap cannot describe a run, so those keep writing
    // the layer even with a range armed.
    if (runRange && index === topSolidIndex && nextPaint.type === "solid") {
      onMutate(
        (el) => applySpanStyleToRange(el as TextElement, runRange, { color: nextPaint.color }),
        discrete
      );
      return;
    }
    const nextFills = [...fills];
    nextFills[index] = nextPaint;
    onMutate((el) => ({
      ...el,
      fillEnabled: true,
      fills: nextFills
    }), discrete);
  };

  const handleToggleEnabled = (index: number) => {
    const nextFills = [...fills];
    const cur = nextFills[index];
    nextFills[index] = { ...cur, enabled: cur.enabled === false ? true : false };
    onMutate((el) => ({
      ...el,
      fills: nextFills
    }), true);
  };

  const handleDeleteFill = (index: number) => {
    if (open?.index === index) setOpen(null);
    onMutate((el) => ({
      ...el,
      fills: fills.filter((_, i) => i !== index)
    }), true);
  };

  /**
   * What opening a row means for the canvas.
   *
   * A row already framed by the document IS the crop mode's state, so opening it
   * hands the chrome back without committing anything — `beginImageCrop` is the
   * way IN (it writes `fit: "crop"`), and re-writing a framing the document
   * already carries would charge an undo step for a click that edited nothing.
   * Arm on the OPENING only: Escape leaves crop while the row stays up, and an
   * effect that re-armed on every render would refuse to let the mode go.
   */
  const openPanel = (index: number, anchor: HTMLElement) => {
    const opening = !(open && open.index === index);
    setOpen(opening ? { index, anchor } : null);
    if (!opening || !primarySelected) return;
    const paint = fills[index];
    // A locked layer has no crop mode at all (`beginImageCrop` refuses it), so a
    // row that re-armed the chrome would describe a mode the layer cannot have.
    if (primarySelected.locked) return;
    if (paint?.type === "image" && paint.fit === "crop") {
      setImageCropTarget({ elId: primarySelected.id, paintIndex: index });
    }
  };

  /**
   * Token references live on the LAYER's paint, not on a run: a run only carries
   * a materialised `color`. Sending a detach through the run write path therefore
   * removed nothing and left the token bound while characters were selected.
   */
  const updateLayerFill = (index: number, nextPaint: Paint) => {
    onMutate((el) => {
      const layers = [...(((el as { fills?: Paint[] }).fills) ?? [])];
      if (!layers[index]) return el;
      layers[index] = nextPaint;
      return { ...el, fillEnabled: true, fills: layers };
    }, true);
  };

  const handleBindToken = (index: number, token: ColorToken) => {
    const fill = fills[index];
    if (!fill || fill.type !== "solid") return;
    const exists = (docRef.current.tokens || []).some((t) => t.id === token.id);
    if (!exists) {
      docRef.current = addTokenToDoc(docRef.current, token);
    }
    const nextFill: Paint = {
      ...fill,
      tokenId: token.id,
      color: colorTokenColor(token, docRef.current.activeTheme)
    };
    delete (nextFill as any).opacity;
    // Binding a token makes the covered characters follow the layer again. A run
    // that had its own colour would otherwise keep painting over the token.
    const inheritRange = runRange && index === topSolidIndex ? runRange : null;
    onMutate((el) => {
      const layers = [...(((el as { fills?: Paint[] }).fills) ?? [])];
      if (!layers[index]) return el;
      layers[index] = nextFill;
      const next = { ...el, fillEnabled: true, fills: layers };
      return inheritRange
        ? applySpanStyleToRange(next as TextElement, inheritRange, { color: undefined })
        : next;
    }, true);
  };

  const handleDetachToken = (index: number) => {
    const fill = fills[index];
    if (!fill || fill.type !== "solid" || !fill.tokenId) return;
    const { tokenId: _tokenId, ...rest } = fill;
    updateLayerFill(index, rest as Paint);
  };

  /**
   * Adopt a locally picked file as the open layer's bitmap. The new asset and
   * the re-pointed layer land in ONE snapshot: committing the asset list alone
   * would leave a document whose paint references an asset that is not in it.
   */
  const handleUploadImage = async (file: File) => {
    if (!primarySelected || !open) return;
    const index = open.index;
    const elementId = primarySelected.id;
    try {
      const { asset } = await loadImageFromFile(file, 0, 0, file.name);
      const withAsset: DesignDocument = {
        ...docRef.current,
        assets: [...(docRef.current.assets || []), asset]
      };
      const elements = mapElements(getActivePage(withAsset).children, (el) => {
        if (el.id !== elementId) return el;
        const layers = [...(((el as any).fills as Paint[]) || [])];
        const cur = layers[index];
        layers[index] =
          cur && cur.type === "image"
            ? { ...cur, assetId: asset.id }
            : { type: "image", assetId: asset.id, fit: "cover" };
        return { ...el, fillEnabled: true, fills: layers };
      });
      onCommitSnapshot(updateActivePageElements(withAsset, elements));
    } catch (err) {
      console.error("Failed to add image asset:", err);
    }
  };

  const addTitle = boundStyle ? t("paint.managedByStyle") : t("paint.addFill");

  return (
    <Section
      id="fills"
      title={t("properties.fills")}
      trailing={
        <>
          {styleBind.trigger}
          {styleBind.picker}
          <Button
            size="icon"
            onClick={handleAddFill}
            disabled={!!boundStyle}
            title={addTitle}
            aria-label={addTitle}
          >
            <Plus size={13} />
          </Button>
        </>
      }
    >

      {/* Bound Style Pill */}
      {stacksMixed ? (
        /* Figma's line for a mixed stack: no rows, and the header's `+` is the
           edit. One sentence beats a fabricated stack — the alternative is the
           primary's rows presented as the selection's, which is a control that
           looks editable and is not. */
        <p data-paint-mixed="fill" className="text-ui text-ink-muted">
          {t("properties.mixedContent")}
        </p>
      ) : boundStyle ? (
        <StylePill
          styleName={boundStyle.name}
          preview={renderStylePreview(boundStyle, "w-4 h-4", imageUri)}
          selectTitle={t("styles.editStyle")}
          onSelect={styleBind.openFrom}
          onUnlink={() => onMutate((el) => unbindFillStyle(el, boundStyle), true)}
          unlinkTitle={t("styles.detachStyle")}
        />
      ) : hasFills && (
        <div ref={listRef} data-paint-stack="fill" className="space-y-1.5">
          {rows.map(({ item: fill, index: idx }, uiPos) => {
            const isEnabled = fill.enabled !== false;
            const isOpen = open?.index === idx;
            const isSolid = fill.type === "solid";
            const isImage = fill.type === "image";
            const isEditable =
              isSolid || isImage || isGradientPaint(fill) || fill.type === "pattern";
            const boundToken = tokenFor(fill);
            const isMissingToken = isSolid && !!fill.tokenId && !boundToken;
            const parsed = isSolid ? parseColorAlpha(fill.color) : { hex6: "#FFFFFF", alphaPct: 100 };
            const effectiveAlpha = typeof fill.opacity === "number"
              ? Math.round(fill.opacity * 100)
              : (isSolid ? parsed.alphaPct : 100);

            const imageAsset = isImage
              ? (docRef.current.assets || []).find((a) => a.id === fill.assetId)
              : undefined;

            // The thumbnail's SIZE comes with its URI: `paintSwatchBackground`
            // answers `url(...) center / cover`. A bare `url(uri)` here painted
            // the asset's top-left corner at its natural pixels — a 14px swatch
            // of sky, not a thumbnail — because `background` defaults to `auto`
            // size at `0 0`.
            const swatchBackground = paintSwatchBackground(fill, IMAGE_SWATCH_FALLBACK, imageUri);
            const rowLabel = paintRowLabel(fill, imageAsset?.name);

            return (
              <ColorRow
                key={idx}
                dataRowId={idx}
                dataHexId={`fill-${idx}`}
                paint={fill}
                tokenId={fill.type === "solid" ? fill.tokenId : undefined}
                doc={docRef.current}
                disabled={!isEnabled}
                isOpen={isOpen}
                showAlpha={true}
                effectiveAlpha={effectiveAlpha}
                swatchBackground={swatchBackground}
                label={rowLabel}
                className={dragUi?.fromUi === uiPos ? "opacity-40" : ""}
                leading={
                  <>
                    <PaintDropIndicator
                      active={!!dragUi && (dragUi.slot === uiPos || (uiPos === rows.length - 1 && dragUi.slot === rows.length))}
                      isLast={uiPos === rows.length - 1}
                    />
                    {rows.length > 1 && (
                      <button
                        type="button"
                        data-paint-handle={idx}
                        title={t("paint.reorder")}
                        onPointerDown={(e) => beginDrag(uiPos, e)}
                        className="text-ink-muted hover:text-ink p-0 shrink-0 cursor-grab active:cursor-grabbing touch-none -ml-1 -mr-1"
                      >
                        <GripVertical size={12} />
                      </button>
                    )}
                  </>
                }
                trailing={
                  <>
                    <Button
                      size="icon"
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleToggleEnabled(idx);
                      }}
                      title={isEnabled ? t("paint.hideFill") : t("paint.showFill")}
                    >
                      {isEnabled ? <Eye size={12} /> : <EyeOff size={12} />}
                    </Button>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDeleteFill(idx);
                      }}
                      className="text-ink-dim hover:text-measure-coral p-0.5 rounded-ctl hover:bg-raised transition-colors cursor-default"
                      title={t("paint.removeFill")}
                    >
                      <Minus size={12} />
                    </button>
                  </>
                }
                onChange={(nextColor, nextAlpha) => {
                  if (isSolid) {
                    const nextFill: Paint = {
                      ...fill,
                      color: nextColor
                    };
                    delete (nextFill as any).opacity;
                    handleUpdateFill(idx, nextFill);
                  } else {
                    handleUpdateFill(idx, {
                      ...fill,
                      opacity: (nextAlpha ?? effectiveAlpha) / 100
                    });
                  }
                }}
                onCommit={() => onCommitSnapshot(docRef.current)}
                onGestureStart={onDragStart}
                onGestureEnd={onDragEnd}
                onOpenColorPanel={(anchor) => {
                  if (isEditable) openPanel(idx, anchor);
                }}
                onBindToken={(token) => handleBindToken(idx, token)}
                onDetachToken={() => handleDetachToken(idx)}
              />
            );
          })}
        </div>
      )}

      {open && openPaint && (
        <ColorPanel
          title={t("paint.fill")}
          paint={openPaint}
          anchor={open.anchor}
          doc={docRef.current}
          docRef={docRef}
          onChange={(next, discrete) => handleUpdateFill(open.index, next, discrete)}
          onGestureStart={onDragStart}
          onGestureEnd={onDragEnd}
          onClose={() => setOpen(null)}
          assets={docRef.current.assets}
          onUploadImage={handleUploadImage}
          cropActive={openImageCropActive}
          onEnterCrop={
            primarySelected
              ? () => {
                  void beginImageCrop({
                    docRef,
                    commitSnapshot: onCommitSnapshot,
                    target: { elId: primarySelected.id, paintIndex: open.index },
                    hint: onHint
                  });
                }
              : undefined
          }
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
    </Section>
  );
}
