import { useMemo, useRef, useState } from "preact/hooks";
import {
  DesignElement,
  DesignDocument,
  Paint,
  ColorToken,
  PaintStyle,
  getActivePage,
  updateActivePageElements
} from "../core/dsl/types";
import {
  boundFillStyleFor,
  applyPaintToSelection,
  collectSelectedColors,
  elementIndexOf,
  SelectedColor,
  selectedColorCss
} from "../core/interactions/selected-colors";
import { colorTokenColor } from "../core/interactions/token-ops";
import { mapElements } from "../core/geometry/tree-ops";
import { ColorPanel } from "./ColorPanel";
import { COLOR_TABS, PaintTab } from "./paint-kind";
import { StylePickerPopover } from "./inspector/StylePickerPopover";
import { StylePill } from "./inspector/StylePill";
import { renderStylePreview } from "./inspector/StylePreview";
import { ColorRow } from "./inspector/ColorRow";
import { paintImageUri } from "./inspector/paint-preview";
import {
  addStyleToDoc,
  addTokenToDoc,
  bindFillStyle,
  unbindFillStyle,
  updateStyleInDoc
} from "../core/interactions/style-ops";
import { t } from "../i18n";
import { Crosshair } from "lucide-react";
import { Section } from "./inspector/SectionHeader";

/**
 * The palette of a whole selection, one row per colour.
 *
 * Each color row is represented identically to Fill and Stroke rows via `ColorRow`.
 * Tokens, raw hexes, gradients, and patterns are rendered in a unified layout without
 * distinction between fill and stroke channels.
 */

/** A pattern row edits a pattern, so its panel offers the pattern tab as well. */
const PATTERN_EDIT_TABS: PaintTab[] = [...COLOR_TABS, "pattern"];

interface SelectedColorsProps {
  /** The SELECTION, walked as subtrees for the palette. */
  elements: DesignElement[];
  docRef: { current: DesignDocument };
  /** Selects every layer carrying the colour, replacing the current selection. */
  onSelectByColor?: (ids: string[]) => void;
  /**
   * Writes the document. `discrete === false` is one frame of a gesture, which
   * must land transiently or every step of an opacity scrub becomes its own undo.
   */
  onWrite: (newDoc: DesignDocument, discrete?: boolean) => void;
  onDragStart?: () => void;
  onDragEnd?: () => void;
}

export function SelectedColorsStrip({
  elements,
  docRef,
  onSelectByColor,
  onWrite,
  onDragStart,
  onDragEnd
}: SelectedColorsProps) {
  const [editing, setEditing] = useState<{ layerId: string; anchor: HTMLElement } | null>(null);
  const [picking, setPicking] = useState<string | null>(null);
  const styleAnchorRef = useRef<HTMLElement | null>(null);

  const doc = docRef.current;
  // Both walks are over the whole page and both run on every render of the
  // inspector — a hover in the strip must not re-flatten 1,841 nodes.
  const colors = useMemo(() => collectSelectedColors(doc, elements), [doc, elements]);
  const elementIndex = useMemo(() => elementIndexOf(doc), [doc]);
  if (colors.length === 0) return null;
  const editingColor = editing ? colors.find((c) => c.elementIds[0] === editing.layerId) ?? null : null;
  const pickingColor = picking ? colors.find((c) => c.elementIds[0] === picking) ?? null : null;
  const pickingStyle = pickingColor ? boundFillStyleFor(doc, pickingColor, elementIndex) : null;

  const imageUri = paintImageUri(docRef.current);

  const apply = (color: SelectedColor, nextPaint: Paint, discrete = true, allowKindChange = false) => {
    const doc = docRef.current;
    const all = getActivePage(doc).children;
    const next = applyPaintToSelection(doc, all, color, nextPaint, { allowKindChange });
    if (next === all) return;
    onWrite(updateActivePageElements(doc, next), discrete);
  };

  const handleBindToken = (color: SelectedColor, token: ColorToken) => {
    const existing = (docRef.current.tokens || []).some((t) => t.id === token.id);
    let doc = docRef.current;
    if (!existing) {
      doc = addTokenToDoc(doc, token);
      docRef.current = doc;
    }
    const all = getActivePage(doc).children;
    const next = applyPaintToSelection(doc, all, color, {
      type: "solid",
      color: colorTokenColor(token, doc.activeTheme),
      tokenId: token.id
    });
    if (next !== all) {
      onWrite(updateActivePageElements(doc, next), true);
    }
  };

  const handleDetachToken = (color: SelectedColor) => {
    const doc = docRef.current;
    const all = getActivePage(doc).children;
    const currentColor = color.kind === "solid" ? color.hex : "#000000";
    const next = applyPaintToSelection(doc, all, color, {
      type: "solid",
      color: currentColor
    });
    if (next !== all) {
      onWrite(updateActivePageElements(doc, next), true);
    }
  };

  const writeStyle = (color: SelectedColor, change: (el: DesignElement) => DesignElement) => {
    const ids = new Set(color.elementIds);
    const all = getActivePage(docRef.current).children;
    const next = mapElements(all, (el) => (ids.has(el.id) ? change(el) : el));
    if (next === all) return;
    onWrite(updateActivePageElements(docRef.current, next), true);
  };

  /* Only a FILL wears a paint style here: a stroke row has no style pointer, so
     a stroke colour's only design-system link is its TOKEN. */
  const styleOpsFor = (_color: SelectedColor) => ({
    bind: (el: DesignElement, s: PaintStyle) => bindFillStyle(el, s),
    unbind: (el: DesignElement, s?: PaintStyle) => unbindFillStyle(el, s)
  });

  return (
    <>
      <Section
        id="selected-colors"
        title={t("selectedColors.title")}
        className="space-y-1.5"
        data-selected-colors="true"
      >
        {colors.map((color) => {
          const style = boundFillStyleFor(doc, color, elementIndex);
          const rowKey = color.tokenId ? `token:${color.tokenId}` : `${color.kind}:${color.hex}`;
          const selectByColor = onSelectByColor && (
            <button
              type="button"
              data-select-by-color="true"
              onClick={() => onSelectByColor(color.elementIds)}
              className="flex-none rounded-ctl p-1 text-ink-dim opacity-0 transition-opacity duration-base ease-snap hover:bg-raised hover:text-ink focus:opacity-100 group-hover:opacity-100"
              title={t("selectedColors.selectUsing", { n: color.count })}
              aria-label={t("selectedColors.selectUsing", { n: color.count })}
            >
              <Crosshair size={12} />
            </button>
          );

          if (style) {
            return (
              <StylePill
                key={rowKey}
                rowProps={{ "data-selected-color-row": style.id }}
                styleName={style.name}
                preview={renderStylePreview(style, "w-4 h-4", imageUri)}
                selectTitle={t("selectedColors.editStyle")}
                onSelect={(el) => {
                  styleAnchorRef.current = el;
                  setPicking(color.elementIds[0]);
                }}
                onUnlink={() => writeStyle(color, (el) => styleOpsFor(color).unbind(el, style))}
                unlinkTitle={t("styles.detachStyle")}
                trailing={selectByColor}
              />
            );
          }

          return (
            <ColorRow
              key={rowKey}
              dataRowId={color.tokenId ?? (color.kind === "solid" ? color.hex : color.kind)}
              dataHexId={`selection-${color.elementIds[0]}`}
              color={selectedColorCss(color)}
              paint={color.paint}
              tokenId={color.tokenId}
              doc={docRef.current}
              showAlpha={color.kind === "solid"}
              effectiveAlpha={color.alpha}
              label={color.kind === "solid" ? undefined : t(`selectedColors.kind.${color.kind}`)}
              onOpenColorPanel={(anchor) => {
                setEditing({ layerId: color.elementIds[0], anchor });
              }}
              onBindToken={(token) => handleBindToken(color, token)}
              onDetachToken={() => handleDetachToken(color)}
              onChange={(nextColor) => {
                if (color.kind === "solid") {
                  apply(color, { type: "solid", color: nextColor }, true);
                }
              }}
              onGestureStart={onDragStart}
              onGestureEnd={onDragEnd}
              trailing={selectByColor}
            />
          );
        })}
      </Section>

      {editing && editingColor && (
        <ColorPanel
          title={editingColor.channel === "stroke" ? t("paint.stroke") : t("paint.fill")}
          paint={editingColor.paint}
          anchor={editing.anchor}
          doc={docRef.current}
          docRef={docRef}
          tabs={editingColor.kind === "pattern" ? PATTERN_EDIT_TABS : COLOR_TABS}
          assets={docRef.current.assets}
          onChange={(paint, discrete, cause) => apply(editingColor, paint, discrete, cause === "kind")}
          onGestureStart={onDragStart}
          onGestureEnd={onDragEnd}
          onClose={() => setEditing(null)}
        />
      )}

      {pickingColor && pickingStyle && (
        <StylePickerPopover
          styleType="paint"
          doc={docRef.current}
          docRef={docRef}
          boundStyleId={pickingStyle.id}
          availableStyles={docRef.current.styles || []}
          anchorRef={styleAnchorRef}
          currentSelection={{ type: "paint", paints: pickingStyle.paints, elementIds: pickingColor.elementIds }}
          onSelectStyle={(s) => writeStyle(pickingColor, (el) => styleOpsFor(pickingColor).bind(el, s as PaintStyle))}
          onDetachStyle={() => writeStyle(pickingColor, (el) => styleOpsFor(pickingColor).unbind(el, pickingStyle))}
          onSaveStyle={(style) => {
            const existing = (docRef.current.styles || []).find((s) => s.id === style.id);
            let nextDoc = existing
              ? updateStyleInDoc(docRef.current, style)
              : addStyleToDoc(docRef.current, style);
            const ids = new Set(pickingColor.elementIds);
            const updated = mapElements(getActivePage(nextDoc).children, (el) =>
              ids.has(el.id) ? styleOpsFor(pickingColor).bind(el, style as PaintStyle) : el
            );
            nextDoc = updateActivePageElements(nextDoc, updated);
            onWrite(nextDoc, true);
          }}
          onClose={() => setPicking(null)}
        />
      )}
    </>
  );
}
