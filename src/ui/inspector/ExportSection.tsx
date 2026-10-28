import { useMemo, useRef, useState } from "preact/hooks";
import { flushSync } from "preact/compat";
import { DesignDocument, DesignElement, getActivePage } from "../../core/dsl/types";
import { exportCanvasAsBlob, exportCanvasAsSvgBlob, ExportBounds } from "../../core/export";
import { exportBounds } from "./export-bounds";
import { elementAABB } from "../../core/geometry/element-bounds";
import { flattenElements } from "../../core/geometry/tree-ops";
import { worldOriginOf } from "../../core/interactions/component-swap";
import { ExportMirror } from "../canvas/ExportMirror";
import { t } from "../../i18n";
import { Select } from "../Select";
import { Download } from "lucide-react";
import { Section } from "./SectionHeader";
import { ACTION_BUTTON_CLASS, ACTION_BAR_ON, ACTION_BAR_OFF } from "./action-bar-style";
import { ROW_CLASS } from "../row-style";
import { useSettledValue } from "../hooks/useSettledValue";

type ExportFormat = "png" | "svg" | "webp";

interface ExportSectionProps {
  doc: DesignDocument;
  docRef: { current: DesignDocument };
  canvasContainerRef: { current: HTMLDivElement | null };
  selectedElements: DesignElement[];
  primarySelected: DesignElement | null;
}

export function ExportSection({
  doc,
  docRef,
  canvasContainerRef,
  selectedElements,
  primarySelected
}: ExportSectionProps) {
  const [scale, setScale] = useState(1);
  const [format, setFormat] = useState<ExportFormat>("png");
  const [isExporting, setIsExporting] = useState(false);
  const [mirrorMounted, setMirrorMounted] = useState(false);
  const mirrorHostRef = useRef<HTMLDivElement | null>(null);

  /**
   * The crop, computed from the document as it was when it last held still.
   *
   * `exportBounds` measures: it resolves instances and re-runs their layout to
   * find the box a node actually paints into. This line used to run on every
   * render of this panel, and the inspector re-renders once per drag frame — so
   * dragging a layer paid a document-wide measurement per frame, and the FIRST
   * one (cold text metrics) blocked the frame for ~60 ms. That was the pause
   * before an element started following the pointer.
   *
   * A crop size is read, never acted on mid-gesture: nobody clicks Export with a
   * button held down. Trailing the camera by one settle is invisible here, and it
   * is the same rule the stage alignment and the defs already follow.
   */
  const settledDoc = useSettledValue(doc, 120);
  const settledSelection = useSettledValue(selectedElements, 120);
  const bounds: ExportBounds = useMemo(
    () => exportBounds(settledDoc, settledSelection),
    [settledDoc, settledSelection]
  );

  /**
   * The live canvas is missing part of what was asked for.
   *
   * Culling drops anything outside the viewport, and a selection is exempt from
   * it, so this is false for every selection export and true for nearly every
   * full-page export of a page taller than the window. That asymmetry is the
   * point: the mirror costs a full tree build, and this is what keeps that cost
   * off the path where it would buy nothing.
   */
  const liveCanvasIsShort = (): boolean => {
    const live = canvasContainerRef.current?.querySelector("svg");
    if (!live) return true;
    for (const el of flattenElements(getActivePage(doc).children)) {
      const box = elementAABB(el);
      const origin = worldOriginOf(doc, el);
      const x = box.x + origin.x;
      const y = box.y + origin.y;
      if (x > bounds.x + bounds.width || x + box.width < bounds.x) continue;
      if (y > bounds.y + bounds.height || y + box.height < bounds.y) continue;
      if (!live.querySelector(`[data-element-id="${CSS.escape(el.id)}"]`)) return true;
    }
    return false;
  };

  const handleExport = async () => {
    if (!canvasContainerRef.current) return;

    setIsExporting(true);
    let needsMirror = false;
    try {
      const allowedIds = new Set<string>();
      const collectDescendantIds = (el: DesignElement) => {
        allowedIds.add(el.id);
        if ("children" in el && Array.isArray((el as any).children)) {
          for (const child of (el as any).children) {
            collectDescendantIds(child);
          }
        }
      };
      selectedElements.forEach(collectDescendantIds);

      const options = {
        scale,
        bounds,
        allowedElementIds: selectedElements.length > 0 ? allowedIds : undefined
      };

      needsMirror = liveCanvasIsShort();
      let source: HTMLElement | null = canvasContainerRef.current;
      if (needsMirror) {
        flushSync(() => setMirrorMounted(true));
        source = mirrorHostRef.current ?? source;
      }

      const blob =
        format === "svg"
          ? await exportCanvasAsSvgBlob(doc, source, options)
          : await exportCanvasAsBlob(
              doc,
              source,
              options,
              format === "webp" ? "image/webp" : "image/png",
              1.0
            );

      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const baseName = (
        selectedElements.length === 1
          ? primarySelected?.name || primarySelected?.type || "element"
          : selectedElements.length > 1
          ? doc.name || "export"
          : `${doc.name || "canvas"}_${getActivePage(doc).name || "page"}`
      ).replace(/[\\/:*?"<>|]/g, "_");
      a.href = url;
      a.download = `${baseName}${scale > 1 ? `@${scale}x` : ""}.${format}`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error(`Export ${format.toUpperCase()} failed`, err);
    } finally {
      if (needsMirror) flushSync(() => setMirrorMounted(false));
      setIsExporting(false);
    }
  };

  const isFullCanvas = selectedElements.length === 0;

  return (
    <Section
      id="export"
      title={`${t("properties.export")} ${isFullCanvas ? `(${doc.name || "Canvas"})` : ""}`}
      trailing={<span className="text-code text-ink-muted">{bounds.width} × {bounds.height}</span>}
    >
      <div className={ROW_CLASS}>
        <Select value={format} onChange={(v) => setFormat(v as ExportFormat)}>
          <option value="png">PNG</option>
          <option value="webp">WebP</option>
          <option value="svg">SVG</option>
        </Select>
        <Select value={scale} onChange={(v) => setScale(Number(v))}>
          <option value={1}>1x</option>
          <option value={2}>2x</option>
          <option value={3}>3x</option>
        </Select>
        {/* The same 25px field box the two selects beside it wear — it used to
            be `py-1.5` with a `ctl` border, ~30px of button between two 25px
            fields, which is why it read as oversized. */}
        <button
          onClick={handleExport}
          disabled={isExporting}
          className={`${ACTION_BUTTON_CLASS} ${isExporting ? ACTION_BAR_OFF : ACTION_BAR_ON}`}
        >
          <Download size={12} />
          <span>
            {isExporting
              ? t("properties.exporting")
              : format === "svg"
              ? t("properties.exportSvg")
              : format === "webp"
              ? t("properties.exportWebp")
              : t("properties.exportPng")}
          </span>
        </button>
      </div>
      {mirrorMounted && <ExportMirror doc={doc} docRef={docRef} hostRef={mirrorHostRef} />}
    </Section>
  );
}
