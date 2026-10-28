import type { ComponentChildren } from "preact";
import type { PluginHostContext } from "../../core/plugins/plugin-contract";
import type { DesignElement, RectElement } from "../../core/dsl/types";
import type { ImagePaint } from "../../core/dsl/image-fill";
import {
  useState,
  useEffect,
  useRef,
  createId,
  firstImagePaint,
  getActivePage,
  mapElements,
  updateActivePageElements
} from "../_host";
import { SpinnerGlyph } from "../_shared/glyphs";
import { getStrings } from "./i18n";
import {
  type PhotoFxOptions,
  type FxCategory,
  type PatternMode,
  type DitherAlgorithm,
  type ColorMode,
  type TransitionMode,
  type TransitionBlend,
  DEFAULT_OPTIONS,
  COLOR_PRESETS
} from "./engine/types";
import { FILM_PRESETS, type FilmPreset } from "./engine/film";
import { processImageToCanvas, processToDataUri } from "./engine/pipeline";

export interface PhotoFxPluginViewProps {
  context: PluginHostContext;
}

import {
  ChevronDownGlyph,
  ApertureGlyph,
  TransparentGlyph,
  SectionHeader,
  SelectField,
  InstrumentSlider
} from "./FxControls";

/** Tallest the preview box may get; width follows the photo's own ratio below it. */
const PREVIEW_MAX_HEIGHT = 200;

export function PhotoFxPluginView({ context }: PhotoFxPluginViewProps) {
  const { ui, docRef, primarySelected, commitSnapshot, notify, locale } = context;
  const { Button, ColorField, checkerboardStyle } = ui;
  const strings = getStrings(locale);

  const [options, setOptions] = useState<PhotoFxOptions>({ ...DEFAULT_OPTIONS });
  const [applyMode, setApplyMode] = useState<"new-layer" | "replace">("new-layer");
  const [loading, setLoading] = useState(false);
  const [processing, setProcessing] = useState(false);

  // Preview zoom & pan
  const [previewZoom, setPreviewZoom] = useState(1);
  const [panOffset, setPanOffset] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const panStartRef = useRef({ x: 0, y: 0, startPanX: 0, startPanY: 0 });

  const previewCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const previewFrameRef = useRef<HTMLDivElement | null>(null);
  const loadedImageRef = useRef<HTMLImageElement | null>(null);
  const optionsRef = useRef(options);
  const renderPreviewRef = useRef<(img: HTMLImageElement, opt: PhotoFxOptions) => void>(() => {});

  // The preview box takes the photo's own ratio: a 16:9 frame letterboxes or crops
  // every portrait, and the crop reads as a wrong result rather than a small one.
  const [imageAspect, setImageAspect] = useState<number | null>(null);

  // Identify selected image fill & asset
  const imageFill = primarySelected ? firstImagePaint(primarySelected) ?? null : null;
  const currentAsset = imageFill
    ? (docRef.current.assets || []).find((a) => a.id === imageFill.assetId)
    : null;

  const activeImageUri = imageFill && currentAsset?.uri ? currentAsset.uri : null;
  const hasImage = Boolean(activeImageUri);

  // Load image when active URI changes
  useEffect(() => {
    if (!activeImageUri) {
      loadedImageRef.current = null;
      return;
    }

    setLoading(true);
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      loadedImageRef.current = img;
      setImageAspect(img.naturalWidth / img.naturalHeight);
      setLoading(false);
      triggerPreview(img, options);
    };
    img.onerror = () => {
      loadedImageRef.current = null;
      setLoading(false);
    };
    img.src = activeImageUri;
  }, [activeImageUri]);

  const triggerPreview = (img: HTMLImageElement | null, opt: PhotoFxOptions) => {
    if (!img || !previewCanvasRef.current || !primarySelected) return;
    // Render into device pixels, not CSS pixels. A 280px bitmap shown in a 250px
    // box on a 2x display is upscaled 1.8x, which blurs every bar edge into a
    // grey smear — the screen pattern reads soft even though the mask is hard.
    const frame = previewFrameRef.current;
    const frameW = frame?.clientWidth || previewCanvasRef.current.clientWidth || 240;
    const frameH =
      frame?.clientHeight || Math.round(frameW / (imageAspect || img.naturalWidth / img.naturalHeight));
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    // Zoom re-renders instead of only scaling the bitmap: CSS-scaling a 320px
    // canvas is the fastest way to make a hard screen look like a soft one, and
    // zoom is exactly where the ruling gets judged.
    const scale = Math.min(4, Math.max(1, previewZoom));
    const maxDimension = Math.min(
      1536,
      Math.max(240, Math.round(Math.max(frameW, frameH) * dpr * scale))
    );
    // Grid must keep the same frequency relative to the element on canvas, so the
    // preview shows the ruling the applied result will print at.
    processImageToCanvas(img, previewCanvasRef.current, opt, maxDimension, primarySelected.width);
  };
  renderPreviewRef.current = triggerPreview;
  optionsRef.current = options;

  // The frame resizes with the photo's ratio after load; re-render at the new size.
  useEffect(() => {
    const frame = previewFrameRef.current;
    if (!frame || typeof ResizeObserver === "undefined") return;
    let last = "";
    const observer = new ResizeObserver(() => {
      const key = `${frame.clientWidth}x${frame.clientHeight}`;
      if (key === last) return;
      last = key;
      const img = loadedImageRef.current;
      if (img) renderPreviewRef.current(img, optionsRef.current);
    });
    observer.observe(frame);
    return () => observer.disconnect();
  }, [hasImage, imageAspect]);

  useEffect(() => {
    const img = loadedImageRef.current;
    if (img) renderPreviewRef.current(img, optionsRef.current);
  }, [previewZoom]);

  const updateOpt = <K extends keyof PhotoFxOptions>(key: K, val: PhotoFxOptions[K]) => {
    const next = { ...options, [key]: val };
    setOptions(next);
    if (loadedImageRef.current) {
      triggerPreview(loadedImageRef.current, next);
    }
  };

  const applyPreset = (dark: string, light: string) => {
    const next = { ...options, darkColor: dark, lightColor: light, colorMode: "duotone" as const };
    setOptions(next);
    if (loadedImageRef.current) {
      triggerPreview(loadedImageRef.current, next);
    }
  };

  const applyFilmPreset = (preset: FilmPreset) => {
    const next: PhotoFxOptions = {
      ...options,
      filmPreset: preset.id,
      filmGrain: preset.grain,
      filmVignette: preset.vignette,
      filmWarmth: preset.warmth,
      filmFade: preset.fade,
      filmLightLeak: preset.lightLeak
    };
    setOptions(next);
    if (loadedImageRef.current) {
      triggerPreview(loadedImageRef.current, next);
    }
  };

  const handleApply = async () => {
    if (!loadedImageRef.current || !primarySelected) return;

    try {
      setProcessing(true);
      const activePage = getActivePage(docRef.current);
      const pageChildren = activePage.children || [];

      // High-res bitmap PNG asset (fast, reliable, zero DOM/SVG stall)
      const result = await processToDataUri(
        loadedImageRef.current,
        options,
        2048,
        primarySelected.width
      );

      const baseName = currentAsset?.name || primarySelected.name || "photo";
      const newAsset = {
        id: createId("asset"),
        name: `${baseName}-fx.png`,
        mimeType: "image/png",
        uri: result.uri,
        width: result.width,
        height: result.height
      };

      let nextElements: DesignElement[];

      if (applyMode === "replace") {
        nextElements = mapElements(pageChildren, (el) => {
          if (el.id !== primarySelected.id) return el;
          const nextFills = (el.fills || []).map((f) => {
            const paint = f as ImagePaint;
            if (paint.type !== "image" || paint.assetId !== imageFill?.assetId) return f;
            return { ...paint, assetId: newAsset.id };
          });
          return { ...el, fills: nextFills };
        });
      } else {
        // Place directly ON TOP of current element on canvas
        const newRectEl: RectElement = {
          id: createId("rect"),
          name: `${primarySelected.name || "Layer"} (Photo FX)`,
          type: "rect",
          x: primarySelected.x,
          y: primarySelected.y,
          width: primarySelected.width,
          height: primarySelected.height,
          rotation: (primarySelected as any).rotation,
          fills: [
            {
              type: "image",
              assetId: newAsset.id,
              // Keep the source layer's framing: forcing "fill" stretches a
              // cover-cropped photo and moves every face off its crop.
              fit: imageFill?.fit ?? "cover",
              ...(imageFill?.focalPoint ? { focalPoint: imageFill.focalPoint } : {}),
              enabled: true
            }
          ]
        };

        const idx = pageChildren.findIndex((el) => el.id === primarySelected.id);
        if (idx >= 0) {
          nextElements = [
            ...pageChildren.slice(0, idx + 1),
            newRectEl,
            ...pageChildren.slice(idx + 1)
          ];
        } else {
          nextElements = [...pageChildren, newRectEl];
        }
      }

      const nextAssets = [...(docRef.current.assets || []), newAsset];
      commitSnapshot(
        updateActivePageElements({ ...docRef.current, assets: nextAssets }, nextElements)
      );
      notify("Photo FX applied successfully");
    } catch (err: any) {
      notify(err?.message || "Failed to apply effect");
    } finally {
      setProcessing(false);
    }
  };

  // Wheel zoom handler for preview
  const handlePreviewWheel = (e: WheelEvent) => {
    e.preventDefault();
    const delta = e.deltaY < 0 ? 0.25 : -0.25;
    setPreviewZoom((cur) => {
      const next = Math.max(1, Math.min(4, Number((cur + delta).toFixed(2))));
      if (next === 1) setPanOffset({ x: 0, y: 0 });
      return next;
    });
  };

  const handlePointerDown = (e: PointerEvent) => {
    if (previewZoom <= 1 || e.button !== 0) return;
    setIsPanning(true);
    panStartRef.current = {
      x: e.clientX,
      y: e.clientY,
      startPanX: panOffset.x,
      startPanY: panOffset.y
    };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: PointerEvent) => {
    if (!isPanning) return;
    const dx = (e.clientX - panStartRef.current.x) / previewZoom;
    const dy = (e.clientY - panStartRef.current.y) / previewZoom;
    setPanOffset({
      x: panStartRef.current.startPanX + dx,
      y: panStartRef.current.startPanY + dy
    });
  };

  const handlePointerUp = (e: PointerEvent) => {
    if (!isPanning) return;
    setIsPanning(false);
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {}
  };

  if (!primarySelected || !hasImage) {
    return (
      <div className="p-3 flex flex-col justify-between font-sans h-full box-border" data-fish-plugin="fish.photo-fx">
        <div className="py-12 flex flex-col items-center justify-center text-center gap-2">
          <div className="w-10 h-10 rounded-ctl bg-surface border border-rule flex items-center justify-center text-ink-muted">
            <ApertureGlyph size={18} />
          </div>
          <div className="text-ui font-medium text-ink">
            Photo FX
          </div>
          <div className="text-row text-ink-dim max-w-[220px] leading-snug">
            {strings.selectImageHint}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full select-none font-sans text-ui text-ink" data-fish-plugin="fish.photo-fx">
      {/* 1. FIXED TOP: Live Zoomable Preview Box (Pinned, never scrolls) */}
      <div className="p-3 pb-2 flex-none flex justify-center">
        <div
          ref={previewFrameRef}
          className={`relative rounded-ctl overflow-hidden border border-rule bg-inset select-none ${
            previewZoom > 1 ? (isPanning ? "cursor-grabbing" : "cursor-grab") : ""
          }`}
          style={{
            aspectRatio: `${imageAspect ?? 16 / 9}`,
            width: "100%",
            maxWidth: Math.round(PREVIEW_MAX_HEIGHT * (imageAspect ?? 16 / 9))
          }}
          onWheel={handlePreviewWheel}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onDblClick={() => {
            setPreviewZoom((z) => (z > 1 ? 1 : 2));
            setPanOffset({ x: 0, y: 0 });
          }}
        >
          <div className="absolute inset-0 opacity-20" style={checkerboardStyle} />

          {/* Scaled & Panned Canvas Wrapper */}
          <div
            style={{
              transform: `scale(${previewZoom}) translate(${panOffset.x}px, ${panOffset.y}px)`,
              transformOrigin: "center center",
              transition: isPanning ? "none" : "transform 0.12s ease-out"
            }}
            className="absolute inset-0"
          >
            <canvas ref={previewCanvasRef} className="w-full h-full block" />
          </div>

          {loading && (
            <div className="absolute top-2 left-2 p-1 rounded-sm bg-panel border border-rule">
              <SpinnerGlyph size={12} className="animate-spin text-ink-dim" />
            </div>
          )}

          {/* Zoom Control Badge */}
          <div className="absolute top-2 right-2 flex items-center gap-1 bg-panel/85 backdrop-blur-sm border border-rule rounded-sm px-1 py-0.5 text-unit text-ink-dim shadow-sm z-10">
            <button
              type="button"
              onClick={() => {
                setPreviewZoom((z) => {
                  const next = Math.max(1, Number((z - 0.5).toFixed(1)));
                  if (next === 1) setPanOffset({ x: 0, y: 0 });
                  return next;
                });
              }}
              className="hover:text-ink px-1 cursor-pointer font-mono font-medium"
              title="Zoom out"
            >
              -
            </button>
            <span
              className="font-mono tabular-nums text-ink px-1 cursor-pointer"
              onClick={() => {
                setPreviewZoom(1);
                setPanOffset({ x: 0, y: 0 });
              }}
              title="Reset zoom (100%)"
            >
              {Math.round(previewZoom * 100)}%
            </span>
            <button
              type="button"
              onClick={() => setPreviewZoom((z) => Math.min(4, Number((z + 0.5).toFixed(1))))}
              className="hover:text-ink px-1 cursor-pointer font-mono font-medium"
              title="Zoom in"
            >
              +
            </button>
          </div>
        </div>
      </div>

      {/* 2. SCROLLABLE MIDDLE: Settings and Sliders */}
      <div className="flex-1 overflow-y-auto px-3 pb-3 space-y-2.5">
        {/* Style Category Picker */}
        <div className="grid grid-cols-4 gap-1 p-0.5 bg-inset border border-rule rounded-swatch text-row">
          <button
            type="button"
            onClick={() => updateOpt("fxCategory", "print")}
            className={`py-1 rounded-sm text-center font-medium transition-colors cursor-pointer ${
              options.fxCategory === "print"
                ? "bg-panel text-ink shadow-xs border border-rule/50"
                : "text-ink-dim hover:text-ink"
            }`}
          >
            Print
          </button>
          <button
            type="button"
            onClick={() => updateOpt("fxCategory", "film")}
            className={`py-1 rounded-sm text-center font-medium transition-colors cursor-pointer ${
              options.fxCategory === "film"
                ? "bg-panel text-ink shadow-xs border border-rule/50"
                : "text-ink-dim hover:text-ink"
            }`}
          >
            Film
          </button>
          <button
            type="button"
            onClick={() => updateOpt("fxCategory", "glitch")}
            className={`py-1 rounded-sm text-center font-medium transition-colors cursor-pointer ${
              options.fxCategory === "glitch"
                ? "bg-panel text-ink shadow-xs border border-rule/50"
                : "text-ink-dim hover:text-ink"
            }`}
          >
            Glitch
          </button>
          <button
            type="button"
            onClick={() => updateOpt("fxCategory", "mosaic")}
            className={`py-1 rounded-sm text-center font-medium transition-colors cursor-pointer ${
              options.fxCategory === "mosaic"
                ? "bg-panel text-ink shadow-xs border border-rule/50"
                : "text-ink-dim hover:text-ink"
            }`}
          >
            Mosaic
          </button>
        </div>

        {/* 1. PRINT SETTINGS */}
        {options.fxCategory === "print" && (
          <>
            {/* Pattern Section */}
            <SectionHeader title={strings.mode} />

            {/* Mode Dropdown */}
            <div className="flex items-center justify-between h-[25px]">
              <span className="text-meta text-ink-dim">{strings.mode}</span>
              <div className="w-40">
                <SelectField
                  value={options.mode}
                  onChange={(val) => {
                    const nextMode = val as PatternMode;
                    if ((nextMode === "lines" || nextMode === "bars") && options.angle === 45) {
                      setOptions((prev) => ({ ...prev, mode: nextMode, angle: 0 }));
                    } else {
                      updateOpt("mode", nextMode);
                    }
                  }}
                >
                  <option value="dots">{strings.modeDots}</option>
                  <option value="lines">{strings.modeLines}</option>
                  <option value="bars">{strings.modeBars}</option>
                  <option value="crosshatch">{strings.modeCrosshatch}</option>
                  <option value="dither">{strings.modeDither}</option>
                </SelectField>
              </div>
            </div>

            {/* Dither Algorithm Dropdown (conditional on dither mode) */}
            {options.mode === "dither" && (
              <div className="flex items-center justify-between h-[25px]">
                <span className="text-meta text-ink-dim">{strings.ditherType}</span>
                <div className="w-40">
                  <SelectField
                    value={options.ditherAlgo}
                    onChange={(val) => updateOpt("ditherAlgo", val as DitherAlgorithm)}
                  >
                    <option value="floyd">{strings.ditherFloyd}</option>
                    <option value="atkinson">{strings.ditherAtkinson}</option>
                    <option value="bayer4">{strings.ditherBayer4}</option>
                    <option value="bayer8">{strings.ditherBayer8}</option>
                  </SelectField>
                </div>
              </div>
            )}

            {/* Grid Geometry Controls (Instrument-styled sliders) */}
            {options.mode !== "dither" && (
              <>
                <InstrumentSlider
                  label={
                    options.mode === "lines" || options.mode === "bars"
                      ? strings.stripeSpacing
                      : strings.dotSize
                  }
                  value={options.gridSize}
                  min={4}
                  max={40}
                  step={1}
                  unit="px"
                  onChange={(val) => updateOpt("gridSize", val)}
                />

                <InstrumentSlider
                  label={strings.angle}
                  value={options.angle}
                  min={0}
                  max={90}
                  step={5}
                  unit="°"
                  onChange={(val) => updateOpt("angle", val)}
                />
              </>
            )}

            {/* Tuning Controls */}
            <InstrumentSlider
              label={strings.contrast}
              value={options.contrast}
              min={0.5}
              max={2.2}
              step={0.1}
              formatValue={(val) => `${val.toFixed(1)}×`}
              onChange={(val) => updateOpt("contrast", val)}
            />

            {options.mode === "bars" && (
              <>
                <InstrumentSlider
                  label={strings.barLevel}
                  value={options.barLevel}
                  min={0.4}
                  max={1}
                  step={0.02}
                  formatValue={(val) => `${Math.round(val * 100)}%`}
                  onChange={(val) => updateOpt("barLevel", val)}
                />
                <InstrumentSlider
                  label={strings.barFalloff}
                  value={options.barFalloff}
                  min={0.5}
                  max={6}
                  step={0.1}
                  formatValue={(val) => `${val.toFixed(1)}×`}
                  onChange={(val) => updateOpt("barFalloff", val)}
                />
              </>
            )}

            <div className="flex items-center justify-between h-[25px]">
              <span className="text-meta text-ink-dim">{strings.invert}</span>
              <button
                type="button"
                onClick={() => updateOpt("invert", !options.invert)}
                className={`h-[25px] px-2.5 rounded-swatch text-row border transition-colors ${
                  options.invert
                    ? "border-brand text-brand bg-brand-wash"
                    : "border-rule text-ink-dim hover:text-ink bg-inset"
                }`}
              >
                {options.invert ? "ON" : "OFF"}
              </button>
            </div>

            {/* Transition / Fade Section */}
            <SectionHeader title={strings.transition} />

            <div className="flex items-center justify-between h-[25px]">
              <span className="text-meta text-ink-dim">{strings.transitionMode}</span>
              <div className="w-40">
                <SelectField
                  value={options.transitionMode}
                  onChange={(val) => updateOpt("transitionMode", val as TransitionMode)}
                >
                  <option value="none">{strings.transNone}</option>
                  <option value="horizontal">{strings.transHorizontal}</option>
                  <option value="vertical">{strings.transVertical}</option>
                  <option value="twoEnds">{strings.transTwoEnds}</option>
                  <option value="radial">{strings.transRadial}</option>
                </SelectField>
              </div>
            </div>

            {options.transitionMode !== "none" && (
              <>
                <div className="flex items-center justify-between h-[25px]">
                  <span className="text-meta text-ink-dim">{strings.transitionBlend}</span>
                  <div className="w-40">
                    <SelectField
                      value={options.transitionBlend}
                      onChange={(val) => updateOpt("transitionBlend", val as TransitionBlend)}
                    >
                      <option value="overlay">{strings.blendOverlay}</option>
                      <option value="reveal">{strings.blendReveal}</option>
                      <option value="fade">{strings.blendFade}</option>
                    </SelectField>
                  </div>
                </div>

                <InstrumentSlider
                  label={strings.transSpread}
                  value={Math.round(options.transitionSpread * 100)}
                  min={10}
                  max={100}
                  step={5}
                  unit="%"
                  onChange={(val) => updateOpt("transitionSpread", val / 100)}
                />

                <div className="flex items-center justify-between h-[25px]">
                  <span className="text-meta text-ink-dim">{strings.transInvert}</span>
                  <button
                    type="button"
                    onClick={() => updateOpt("transitionInvert", !options.transitionInvert)}
                    className={`h-[25px] px-2.5 rounded-swatch text-row border transition-colors ${
                      options.transitionInvert
                        ? "border-brand text-brand bg-brand-wash"
                        : "border-rule text-ink-dim hover:text-ink bg-inset"
                    }`}
                  >
                    {options.transitionInvert ? "ON" : "OFF"}
                  </button>
                </div>
              </>
            )}
          </>
        )}

        {/* 2. FILM SETTINGS */}
        {options.fxCategory === "film" && (
          <>
            <SectionHeader title="Film Stock" />
            <div className="grid grid-cols-3 gap-1.5 pt-0.5">
              {FILM_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => applyFilmPreset(preset)}
                  className={`flex flex-col items-center justify-center p-2 rounded-ctl border text-center transition-all cursor-pointer ${
                    options.filmPreset === preset.id
                      ? "bg-brand/10 border-brand text-ink shadow-xs"
                      : "bg-surface border-rule hover:border-rule-strong text-ink-dim hover:text-ink"
                  }`}
                >
                  <span className="text-row font-medium leading-tight truncate w-full">
                    {preset.name}
                  </span>
                  <span className="text-micro font-mono text-ink-muted mt-0.5 opacity-80">
                    {preset.tag}
                  </span>
                </button>
              ))}
            </div>

            <SectionHeader title="Emulsion & Optics" />
            <InstrumentSlider
              label="Film Grain"
              value={options.filmGrain}
              min={0}
              max={100}
              step={1}
              unit="%"
              onChange={(val) => updateOpt("filmGrain", val)}
            />
            <InstrumentSlider
              label="Vignette"
              value={options.filmVignette}
              min={0}
              max={100}
              step={1}
              unit="%"
              onChange={(val) => updateOpt("filmVignette", val)}
            />
            <InstrumentSlider
              label="Warmth"
              value={options.filmWarmth}
              min={-50}
              max={50}
              step={1}
              unit=""
              onChange={(val) => updateOpt("filmWarmth", val)}
            />
            <InstrumentSlider
              label="Matte Fade"
              value={options.filmFade}
              min={0}
              max={50}
              step={1}
              unit="%"
              onChange={(val) => updateOpt("filmFade", val)}
            />
            <InstrumentSlider
              label="Light Leak"
              value={options.filmLightLeak}
              min={0}
              max={100}
              step={1}
              unit="%"
              onChange={(val) => updateOpt("filmLightLeak", val)}
            />
          </>
        )}

        {/* 3. GLITCH SETTINGS */}
        {options.fxCategory === "glitch" && (
          <>
            <SectionHeader title="Glitch Parameters" />
            <InstrumentSlider
              label="RGB Split"
              value={options.rgbSplit}
              min={0}
              max={40}
              step={1}
              unit="px"
              onChange={(val) => updateOpt("rgbSplit", val)}
            />
            <InstrumentSlider
              label="CRT Scanlines"
              value={options.scanlines}
              min={0}
              max={100}
              step={5}
              unit="%"
              onChange={(val) => updateOpt("scanlines", val)}
            />
            <InstrumentSlider
              label="Slice Shift"
              value={options.sliceShift}
              min={0}
              max={50}
              step={1}
              unit="px"
              onChange={(val) => updateOpt("sliceShift", val)}
            />
          </>
        )}

        {/* 4. MOSAIC SETTINGS */}
        {options.fxCategory === "mosaic" && (
          <>
            <SectionHeader title="Mosaic Parameters" />
            <InstrumentSlider
              label="Block Size"
              value={options.mosaicBlockSize}
              min={4}
              max={64}
              step={2}
              unit="px"
              onChange={(val) => updateOpt("mosaicBlockSize", val)}
            />
          </>
        )}

        {/* Color Section (Print, Glitch, Mosaic) */}
        {options.fxCategory !== "film" && (
          <>
            <SectionHeader title={strings.colorMode} />

        <div className="flex items-center justify-between h-[25px]">
          <span className="text-meta text-ink-dim">{strings.colorMode}</span>
          <div className="w-40">
            <SelectField
              value={options.colorMode}
              onChange={(val) => updateOpt("colorMode", val as ColorMode)}
            >
              <option value="duotone">{strings.duotone}</option>
              <option value="original">{strings.originalColor}</option>
            </SelectField>
          </div>
        </div>

        {options.colorMode === "duotone" && (
          <>
            {/* Palettes */}
            <div className="flex items-center justify-between h-[25px]">
              <span className="text-meta text-ink-dim">{strings.presets}</span>
              <div className="flex items-center gap-1.5">
                {COLOR_PRESETS.map((p) => {
                  const active = options.darkColor === p.dark && options.lightColor === p.light;
                  return (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => applyPreset(p.dark, p.light)}
                      title={p.id}
                      className={`h-5 w-6 rounded-swatch overflow-hidden flex border transition-all ${
                        active ? "border-brand ring-1 ring-brand" : "border-rule hover:border-rule-strong"
                      }`}
                    >
                      <span className="w-1/2 h-full" style={{ backgroundColor: p.dark }} />
                      <span className="w-1/2 h-full" style={{ backgroundColor: p.light }} />
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Ink Color - Uses Host App Native ColorField */}
            <div className="flex items-center justify-between h-[25px]">
              <span className="text-meta text-ink-dim w-20 flex-none">{strings.darkColor}</span>
              <div className="w-44 flex-none">
                {ColorField ? (
                  <ColorField
                    value={options.darkColor}
                    panelTitle={strings.darkColor}
                    doc={docRef.current}
                    onChange={(val) => updateOpt("darkColor", val)}
                  />
                ) : (
                  <label className="flex items-center gap-2 px-2 h-[25px] bg-inset rounded-swatch border border-rule cursor-pointer hover:border-rule-strong">
                    <span
                      className="w-3.5 h-3.5 rounded-sm border border-rule-strong"
                      style={{ backgroundColor: options.darkColor }}
                    />
                    <span className="text-row font-mono text-ink uppercase">
                      {options.darkColor}
                    </span>
                    <input
                      type="color"
                      value={options.darkColor}
                      onInput={(e) => updateOpt("darkColor", (e.target as HTMLInputElement).value)}
                      className="sr-only"
                    />
                  </label>
                )}
              </div>
            </div>

            {/* Paper Color & Transparent Toggle - Uses Host App Native ColorField */}
            <div className="flex items-center justify-between h-[25px]">
              <span className="text-meta text-ink-dim w-20 flex-none">{strings.lightColor}</span>
              <div className="flex items-center gap-1.5 w-44 flex-none justify-end">
                <div className={`flex-1 min-w-0 transition-opacity ${options.transparentBg ? "opacity-30 pointer-events-none" : ""}`}>
                  {ColorField ? (
                    <ColorField
                      value={options.lightColor}
                      panelTitle={strings.lightColor}
                      doc={docRef.current}
                      onChange={(val) => updateOpt("lightColor", val)}
                    />
                  ) : (
                    <label className="flex items-center gap-2 px-2 h-[25px] bg-inset rounded-swatch border border-rule cursor-pointer hover:border-rule-strong">
                      <span
                        className="w-3.5 h-3.5 rounded-sm border border-rule-strong"
                        style={{ backgroundColor: options.lightColor }}
                      />
                      <span className="text-row font-mono text-ink uppercase">
                        {options.lightColor}
                      </span>
                      <input
                        type="color"
                        value={options.lightColor}
                        onInput={(e) => updateOpt("lightColor", (e.target as HTMLInputElement).value)}
                        className="sr-only"
                      />
                    </label>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => updateOpt("transparentBg", !options.transparentBg)}
                  title={`${strings.transparentBg}: ${options.transparentBg ? "ON" : "OFF"}`}
                  className={`h-[25px] w-[25px] flex items-center justify-center rounded-swatch border transition-colors cursor-pointer flex-none ${
                    options.transparentBg
                      ? "border-brand text-brand bg-brand-wash shadow-sm"
                      : "border-rule text-ink-dim hover:text-ink bg-inset hover:border-rule-strong"
                  }`}
                >
                  <TransparentGlyph size={13} />
                </button>
              </div>
            </div>
          </>
        )}
          </>
        )}

        {/* Destination Section */}
        <SectionHeader title={strings.applyMode} />

        <div className="flex items-center justify-between h-[25px]">
          <span className="text-meta text-ink-dim">{strings.applyMode}</span>
          <div className="w-40">
            <SelectField
              value={applyMode}
              onChange={(val) => setApplyMode(val as any)}
            >
              <option value="new-layer">{strings.asNewLayer}</option>
              <option value="replace">{strings.replaceCurrent}</option>
            </SelectField>
          </div>
        </div>
      </div>

      {/* 3. FIXED FOOTER: Commit Action Button */}
      <div className="p-3 border-t border-rule bg-panel flex items-center justify-end flex-none">
        <Button
          variant="primary"
          onClick={handleApply}
          disabled={!hasImage || processing}
          className="w-full justify-center"
        >
          {processing ? (
            <span className="flex items-center gap-1.5">
              <SpinnerGlyph size={14} className="animate-spin" />
              {strings.processing}
            </span>
          ) : (
            strings.applyBtn
          )}
        </Button>
      </div>
    </div>
  );
}
