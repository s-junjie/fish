import { useMemo, useRef, useState } from "preact/hooks";
import { flushSync } from "preact/compat";
import { DesignDocument, DesignElement } from "../../core/dsl/types";
import { getActivePage } from "../../core/dsl/document-ops";
import { exportCanvasAsBlob, exportCanvasAsSvgBlob, ExportBounds } from "../../core/export";
import { exportBounds } from "./export-bounds";
import { exportNames, exportUnits, paintedElements } from "./export-units";
import { elementAABB } from "../../core/geometry/element-bounds";
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
}

export function ExportSection({
  doc,
  docRef,
  canvasContainerRef,
  selectedElements
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
   * find the box a node actually paints into. That measurement used to run on
   * every render of this panel, and the inspector re-renders once per drag frame
   * — so dragging a layer paid a document-wide measurement per frame, and the
   * FIRST one (cold text metrics) blocked the frame for ~60 ms. That was the
   * pause before an element started following the pointer.
   *
   * A crop size is read, never acted on mid-gesture: nobody clicks Export with a
   * button held down. Trailing the camera by one settle is invisible here, and it
   * is the same rule the stage alignment and the defs already follow.
   */
  const settledDoc = useSettledValue(doc, 120);
  /**
   * What this press writes out: one file per selected layer.
   *
   * The panel used to crop the whole selection into a single image, which for two
   * frames meant a file the size of the empty gap between them. `bounds` is only
   * the size of ONE unit, so a multi-selection has no single number to show and
   * the header says how many files there are instead.
   *
   * Read LIVE while the crop below is read settled: the unit list is a tree walk
   * over the selection, not a measurement, and a stale one would name the wrong
   * SET of files — a different failure from a crop that trails a drag by a beat.
   */
  const units = useMemo(() => exportUnits(doc, selectedElements), [doc, selectedElements]);
  const bounds: ExportBounds | null = useMemo(
    () => (units.length > 1 ? null : exportBounds(settledDoc, units)),
    [settledDoc, units]
  );

  /**
   * The live canvas is missing part of what was asked for.
   *
   * Culling drops anything outside the viewport, and a selection is exempt from
   * it, so this is false for every selection export and true for nearly every
   * full-page export of a page taller than the window. That asymmetry is the
   * point: the mirror costs a full tree build, and this is what keeps that cost
   * off the path where it would buy nothing.
   *
   * Asked per unit. A single box around the whole batch is the union of boxes
   * that can be far apart, and a culled layer in the gap between two exported
   * frames is not missing from EITHER file — it used to arm the mirror for a
   * batch that the live canvas could have served whole.
   *
   * A layer the canvas never painted proves nothing about culling, so the walk
   * below runs over `paintedElements` — it drops hidden subtrees for exactly the
   * reason the renderer does.
   */
  const liveCanvasIsShort = (crops: readonly ExportBounds[]): boolean => {
    const live = canvasContainerRef.current?.querySelector("svg");
    if (!live) return true;
    // Measured once for the batch: the boxes do not depend on the crop, and a
    // batch of fifty units would otherwise walk the page fifty times.
    const probes = paintedElements(getActivePage(doc).children).map((el) => {
      const box = elementAABB(el);
      const origin = worldOriginOf(doc, el);
      return { id: el.id, x: box.x + origin.x, y: box.y + origin.y, width: box.width, height: box.height };
    });
    return crops.some((crop) =>
      probes.some(
        (p) =>
          p.x <= crop.x + crop.width &&
          p.x + p.width >= crop.x &&
          p.y <= crop.y + crop.height &&
          p.y + p.height >= crop.y &&
          !live.querySelector(`[data-element-id="${CSS.escape(p.id)}"]`)
      )
    );
  };

  /** Every id a unit paints through — the export keeps these and drops the rest. */
  const subtreeIds = (el: DesignElement): Set<string> => {
    const ids = new Set<string>();
    const walk = (node: DesignElement) => {
      ids.add(node.id);
      if ("children" in node && Array.isArray((node as any).children)) {
        for (const child of (node as any).children) walk(child);
      }
    };
    walk(el);
    return ids;
  };

  const download = (blob: Blob, name: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleExport = async () => {
    if (!canvasContainerRef.current) return;

    setIsExporting(true);
    let needsMirror = false;
    try {
      // No selection is the whole canvas: one picture, named after the page.
      const batch: (DesignElement | null)[] = units.length > 0 ? [...units] : [null];
      const names =
        units.length > 0
          ? exportNames(units)
          : [`${doc.name || "canvas"}_${getActivePage(doc).name || "page"}`];
      const crops: ExportBounds[] =
        units.length > 0 ? units.map((unit) => exportBounds(doc, [unit])) : [exportBounds(doc, [])];

      needsMirror = liveCanvasIsShort(crops);
      let source: HTMLElement | null = canvasContainerRef.current;
      if (needsMirror) {
        flushSync(() => setMirrorMounted(true));
        source = mirrorHostRef.current ?? source;
      }

      for (const [i, unit] of batch.entries()) {
        const options = {
          scale,
          bounds: crops[i],
          allowedElementIds: unit ? subtreeIds(unit) : undefined
        };
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
        download(blob, `${names[i]}${scale > 1 ? `@${scale}x` : ""}.${format}`);
      }
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
      trailing={
        <span className="text-code text-ink-muted">
          {bounds ? `${bounds.width} × ${bounds.height}` : t("properties.exportFiles", { n: units.length })}
        </span>
      }
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
