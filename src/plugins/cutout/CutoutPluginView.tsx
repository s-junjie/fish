import type { PluginHostContext } from "../../core/plugins/plugin-contract";
import type { DesignElement } from "../../core/dsl/types";
import type { ImagePaint } from "../../core/dsl/image-fill";
import { useState, createId, firstImagePaint, getActivePage, mapElements, updateActivePageElements } from "../_host";
import { CheckGlyph, ScissorsGlyph, SpinnerGlyph, UndoGlyph } from "../_shared/glyphs";
import { removeBackground } from "./u2netp-runner";
import { cutoutStrings as i18n } from "./i18n";

export interface CutoutPluginViewProps {
  context: PluginHostContext;
}

type ImagePaintWithOrigin = ImagePaint & { _originalAssetId?: string };

/**
 * `targetId` may sit at any depth — a frame's child is not a page child — so the
 * tree is walked rather than mapped over the top level.
 */
function swapFillAsset(
  elements: DesignElement[],
  targetId: string,
  fromAssetId: string,
  toAssetId: string,
  rememberOriginal: boolean
): DesignElement[] {
  return mapElements(elements, (el) => {
    if (el.id !== targetId) return el;
    const nextFills = (el.fills || []).map((f) => {
      const paint = f as ImagePaintWithOrigin;
      if (paint.type !== "image" || paint.assetId !== fromAssetId) return f;
      const { _originalAssetId, ...rest } = paint;
      return {
        ...rest,
        assetId: toAssetId,
        ...(rememberOriginal ? { _originalAssetId: _originalAssetId || fromAssetId } : {})
      };
    });
    return { ...el, fills: nextFills };
  });
}

export function CutoutPluginView({ context }: CutoutPluginViewProps) {
  const { ui, docRef, primarySelected, commitSnapshot, notify } = context;
  const { Button, checkerboardStyle } = ui;

  const [loading, setLoading] = useState(false);
  const [statusText, setStatusText] = useState<string>("");
  const [resultUri, setResultUri] = useState<string | null>(null);

  // 1. Identify current selected image fill and asset
  const imageFill = primarySelected ? firstImagePaint(primarySelected) ?? null : null;
  const currentAsset = imageFill
    ? (docRef.current.assets || []).find((a) => a.id === imageFill.assetId)
    : null;

  const hasImage = Boolean(imageFill && currentAsset?.uri);

  const handleRunCutout = async () => {
    if (!currentAsset?.uri || !primarySelected || !imageFill) return;

    try {
      setLoading(true);
      setStatusText(i18n.statusPreparing);

      const res = await removeBackground(currentAsset.uri, (stage, detail) => {
        if (stage === "downloading") setStatusText(i18n.statusDownloading);
        else if (stage === "initializing") setStatusText(i18n.statusInitializing);
        else if (stage === "processing") setStatusText(i18n.statusProcessing);
        else if (stage === "done") setStatusText(i18n.statusDone);
        else if (detail) setStatusText(detail);
      });

      setResultUri(res.uri);

      // Auto-apply to layer
      const newAsset = {
        id: createId("asset"),
        name: `${currentAsset.name || "image"}-cutout.png`,
        mimeType: "image/png",
        uri: res.uri,
        width: res.width,
        height: res.height
      };

      const nextElements = swapFillAsset(
        getActivePage(docRef.current).children || [],
        primarySelected.id,
        imageFill.assetId,
        newAsset.id,
        true
      );

      const nextAssets = [...(docRef.current.assets || []), newAsset];

      commitSnapshot(
        updateActivePageElements({ ...docRef.current, assets: nextAssets }, nextElements)
      );

      notify(i18n.successHint);
    } catch (err: any) {
      console.error("Cutout error:", err);
      setStatusText(i18n.failed);
      notify(i18n.failed);
    } finally {
      setLoading(false);
    }
  };

  const originalAssetId = (imageFill as ImagePaintWithOrigin | null)?._originalAssetId;
  const canRevert = Boolean(originalAssetId && (docRef.current.assets || []).some((a) => a.id === originalAssetId));

  const handleRevertOriginal = () => {
    if (!originalAssetId || !primarySelected || !imageFill) return;

    const nextElements = swapFillAsset(
      getActivePage(docRef.current).children || [],
      primarySelected.id,
      imageFill.assetId,
      originalAssetId,
      false
    );

    commitSnapshot(updateActivePageElements(docRef.current, nextElements));

    setResultUri(null);
    notify(i18n.revertHint);
  };

  if (!hasImage) {
    return (
      <div className="p-3 flex flex-col justify-between font-sans h-full box-border">
        <div className="py-8 flex flex-col items-center justify-center text-center gap-2">
          <div className="w-10 h-10 rounded-full bg-surface border border-rule flex items-center justify-center text-ink-muted">
            <ScissorsGlyph size={18} />
          </div>
          <div className="text-ui font-medium text-ink">
            {i18n.noSelectionTitle}
          </div>
          <div className="text-ui text-ink-dim max-w-[220px]">
            {i18n.noSelectionDesc}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-3 flex flex-col gap-3 font-sans h-full box-border">
      {/* Thumbnail and info preview */}
      <div className="relative rounded-ctl overflow-hidden border border-rule bg-inset aspect-video flex items-center justify-center flex-none">
        {/* Transparent checkerboard background */}
        <div
          className="absolute inset-0 opacity-20"
          style={checkerboardStyle}
        />
        <img
          src={resultUri || currentAsset?.uri}
          alt={i18n.previewAlt}
          className="relative max-h-full max-w-full object-contain"
        />
        {resultUri && (
          <div className="absolute top-1.5 right-1.5 px-1.5 py-0.5 rounded-ctl bg-surface border border-rule text-micro text-brand font-medium flex items-center gap-1">
            <CheckGlyph size={10} />
            <span>{i18n.applied}</span>
          </div>
        )}
      </div>

      <div className="flex items-center justify-between text-row text-ink-dim flex-none">
        <span className="truncate max-w-[150px]">{currentAsset?.name || "image"}</span>
        <span className="font-mono text-readout">
          {currentAsset?.width && currentAsset?.height ? `${currentAsset.width}×${currentAsset.height}` : ""}
        </span>
      </div>

      {/* Action button: using host injected Button component */}
      <div className="flex flex-col gap-2 flex-none">
        <Button
          variant="primary"
          size="field"
          block
          disabled={loading}
          onClick={handleRunCutout}
          className="gap-1.5"
        >
          {loading ? (
            <>
              <SpinnerGlyph size={13} className="animate-spin" />
              <span>{statusText || i18n.processing}</span>
            </>
          ) : (
            <>
              <ScissorsGlyph size={13} />
              <span>{i18n.actionButton}</span>
            </>
          )}
        </Button>

        {canRevert && !loading && (
          <Button
            variant="bar"
            block
            onClick={handleRevertOriginal}
            className="gap-1.5"
          >
            <UndoGlyph size={12} />
            <span>{i18n.revertButton}</span>
          </Button>
        )}
      </div>
    </div>
  );
}
