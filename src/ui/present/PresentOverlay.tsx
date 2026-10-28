import { useState, useRef, useEffect, useCallback, useMemo } from "preact/hooks";
import { DesignDocument, DesignElement } from "../../core/dsl/types";
import { PresentationFrame } from "../../core/presentation/frames";
import { DocumentStage } from "../canvas/DocumentStage";
import { useElementSize } from "../hooks/useElementSize";
import { openLinkFromEvent } from "../link-activation";
import { useDismiss } from "../hooks/useDismiss";
import { useWindowKeydown } from "../hooks/useWindowKeydown";
import { t } from "../../i18n";
import { PresentScaleMode, calculatePresentFit } from "./presentScale";
import { PresentTransition } from "./usePresentation";
import { matchSlides } from "../../core/presentation/morph";
import { morphSlide, slidePaint } from "../../core/presentation/animate";
import { flattenElements } from "../../core/geometry/tree-ops";
import { MENU_SURFACE_CLASS } from "../menu-style";
import {
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  Check,
  Maximize,
  Minimize,
  X
} from "lucide-react";

interface PresentOverlayProps {
  frame: PresentationFrame | null;
  index: number;
  total: number;
  transition: PresentTransition;
  allElements: DesignElement[];
  docRef: { current: DesignDocument };
  onExit: () => void;
  onNext: () => void;
  onPrev: () => void;
}

const WHEEL_COOLDOWN_MS = 350;
const AUTO_HIDE_DELAY_MS = 2500;

function ScaleModeIcon({ mode }: { mode: PresentScaleMode }) {
  switch (mode) {
    case "actual":
      return (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" className="shrink-0">
          <rect x="1.5" y="2.5" width="13" height="11" rx="2" stroke="currentColor" strokeWidth="1.3" />
          <text x="8" y="10" textAnchor="middle" fontSize="6.5" fontWeight="700" fill="currentColor" fontFamily="monospace">1:1</text>
        </svg>
      );
    case "responsive":
      return (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" className="shrink-0">
          <rect x="1.5" y="2.5" width="13" height="11" rx="2" stroke="currentColor" strokeWidth="1.3" />
          <path d="M5 6 L3.5 8 L5 10 M11 6 L12.5 8 L11 10 M8 4.5 L8 11.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "fit-width":
      return (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" className="shrink-0">
          <rect x="1.5" y="2.5" width="13" height="11" rx="2" stroke="currentColor" strokeWidth="1.3" />
          <path d="M5.5 6 L3.5 8 L5.5 10 M10.5 6 L12.5 8 L10.5 10 M3.5 8 L12.5 8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "fit":
      return (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" className="shrink-0">
          <rect x="1.5" y="2.5" width="13" height="11" rx="2" stroke="currentColor" strokeWidth="1.3" />
          <path d="M6 8 L10 8 M8 6 L8 10 M5 8 L3.5 8 M12.5 8 L11 8 M8 5 L8 3.5 M8 12.5 L8 11" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "fill":
      return (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" className="shrink-0">
          <path d="M2.5 6 L2.5 3.5 C2.5 2.95 2.95 2.5 3.5 2.5 L6 2.5 M10 2.5 L12.5 2.5 C13.05 2.5 13.5 2.95 13.5 3.5 L13.5 6 M13.5 10 L13.5 12.5 C13.5 13.05 13.05 13.5 12.5 13.5 L10 13.5 M6 13.5 L3.5 13.5 C2.95 13.5 2.5 13.05 2.5 12.5 L2.5 10" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
  }
}

export function PresentOverlay({
  frame,
  index,
  total,
  transition,
  allElements,
  docRef,
  onExit,
  onNext,
  onPrev
}: PresentOverlayProps) {
  const screenRef = useRef<HTMLDivElement>(null);
  const scaleButtonRef = useRef<HTMLButtonElement>(null);
  const scaleMenuRef = useRef<HTMLDivElement>(null);
  const lastWheelRef = useRef(0);
  const hideTimerRef = useRef<number | null>(null);
  const size = useElementSize(screenRef);

  const [scaleMode, setScaleMode] = useState<PresentScaleMode>("responsive");
  const [scaleMenuOpen, setScaleMenuOpen] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(Boolean(document.fullscreenElement));
  const [uiVisible, setUiVisible] = useState(true);
  const [scrollY, setScrollY] = useState(0);

  // Reset vertical scroll to top whenever slide changes
  useEffect(() => {
    setScrollY(0);
  }, [index, frame?.id]);

  useDismiss(scaleMenuOpen, () => setScaleMenuOpen(false), scaleMenuRef, scaleButtonRef);

  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(Boolean(document.fullscreenElement));
    };
    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", handleFullscreenChange);
  }, []);

  const resetAutoHide = useCallback(() => {
    setUiVisible(true);
    if (hideTimerRef.current !== null) {
      window.clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
    if (!scaleMenuOpen) {
      hideTimerRef.current = window.setTimeout(() => {
        setUiVisible(false);
      }, AUTO_HIDE_DELAY_MS);
    }
  }, [scaleMenuOpen]);

  useEffect(() => {
    resetAutoHide();
    return () => {
      if (hideTimerRef.current !== null) {
        window.clearTimeout(hideTimerRef.current);
      }
    };
  }, [resetAutoHide, scaleMenuOpen]);

  const toggleFullscreen = useCallback(() => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen().catch(() => {});
    }
  }, []);

  const handleExit = useCallback(() => {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    }
    onExit();
  }, [onExit]);

  // Autoplay videos in the active frame when present mode is on and slide arrives
  useEffect(() => {
    if (!frame || !screenRef.current) return;
    const stageEl = screenRef.current.querySelector('svg[data-present-stage="true"]');
    if (!stageEl) return;
    const videos = stageEl.querySelectorAll("video");
    videos.forEach((v) => {
      const vid = v.getAttribute("data-video-id");
      // Find element in frame
      const el = allElements.find((e) => e.id === vid) as any;
      if (el && el.type === "video" && el.autoplay) {
        v.currentTime = 0;
        v.play().catch(() => {});
      }
    });
  }, [index, frame, allElements]);

  // Keyboard shortcut listeners (F for fullscreen, etc.)
  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.isComposing || (e as any).keyCode === 229) return;
    resetAutoHide();
    if (!e.metaKey && !e.ctrlKey) {
      if (e.key === "f" || e.key === "F") {
        e.preventDefault();
        toggleFullscreen();
      }
    }
  };
  useWindowKeydown(handleKeyDown, [resetAutoHide, toggleFullscreen]);

  const viewport = {
    width: size.width || (typeof window !== "undefined" ? window.innerWidth : 0),
    height: size.height || (typeof window !== "undefined" ? window.innerHeight : 0)
  };

  const resolved = transition.motion;

  // The pairing is computed ONCE per transition, not once per frame: `progress`
  // changes 60 times a second and `matchSlides` walks both trees, so folding it
  // into the paint memo made every frame pay for a match whose answer cannot
  // have changed.
  const morphPair = useMemo(() => {
    const previous = transition.outgoing?.elements[0];
    const target = frame?.elements[0];
    if (resolved?.transition !== "morph" || !previous || !target) return null;
    return { previous, target, match: matchSlides(previous, target) };
  }, [transition.outgoing, frame, resolved?.transition]);

  // What the incoming slide paints. A morph rebuilds its own tree per frame, so
  // it is only built while one is running — at rest the deck renders the
  // document's real elements and nothing is copied.
  const incoming = useMemo<DesignElement[] | null>(() => {
    if (!morphPair) return null;
    return [morphSlide(morphPair.previous, morphPair.target, morphPair.match, transition.progress)];
  }, [morphPair, transition.progress]);

  const stageAllElements = useMemo(() => {
    if (!incoming) return allElements;
    const flatIncoming = flattenElements(incoming);
    const incomingMap = new Map(flatIncoming.map((el) => [el.id, el]));
    const result = allElements.map((el) => incomingMap.get(el.id) ?? el);
    for (const el of flatIncoming) {
      if (!allElements.some((e) => e.id === el.id)) {
        result.push(el);
      }
    }
    return result;
  }, [allElements, incoming]);

  const paint = slidePaint(
    resolved?.transition ?? "none",
    resolved?.direction ?? "right",
    transition.progress,
    viewport.width,
    viewport.height,
    resolved?.reversed ?? false
  );

  const fit = calculatePresentFit(frame?.bounds ?? null, viewport, scaleMode);
  const fitOut = calculatePresentFit(transition.outgoing?.bounds ?? null, viewport, scaleMode);

  const getScaleLabel = (mode: PresentScaleMode) => {
    switch (mode) {
      case "actual":
        return t("present.actualSize");
      case "responsive":
        return t("present.responsive");
      case "fit-width":
        return t("present.fitWidth");
      case "fit":
        return t("present.fitWidthAndHeight");
      case "fill":
        return t("present.fillScreen");
    }
  };

  const selectScale = (mode: PresentScaleMode) => {
    setScaleMode(mode);
    setScaleMenuOpen(false);
  };

  const maxScroll = fit && frame ? Math.max(0, frame.bounds.height * fit.zoom - viewport.height) : 0;

  return (
    <div
      data-present-overlay="true"
      role="dialog"
      aria-modal="true"
      aria-label={t("present.title")}
      className={`fixed inset-0 z-[100] select-none overflow-hidden bg-paper ${
        uiVisible ? "cursor-default" : "cursor-none"
      }`}
      onMouseMove={resetAutoHide}
      onPointerDown={resetAutoHide}
      onClick={(e: any) => {
        resetAutoHide();
        if (scaleMenuOpen) {
          setScaleMenuOpen(false);
          return;
        }
        const target = e.target as HTMLElement | null;
        if (target && target.closest("foreignObject, video, iframe")) {
          return;
        }
        if (!openLinkFromEvent(e)) onNext();
      }}
      onWheel={(e: any) => {
        resetAutoHide();
        e.preventDefault();

        // If content height exceeds viewport, scrolling is strictly used for scrolling content, never turning slides
        if (maxScroll > 0) {
          setScrollY((prev) => Math.min(maxScroll, Math.max(0, prev + e.deltaY)));
          return;
        }

        const now = Date.now();
        if (now - lastWheelRef.current < WHEEL_COOLDOWN_MS) return;
        lastWheelRef.current = now;
        if (e.deltaY > 0) onNext();
        else if (e.deltaY < 0) onPrev();
      }}
    >
      {/* Canvas Slide Viewport */}
      <div ref={screenRef} className="absolute inset-0">
        {/* The slide being left. Mounting a second `DocumentStage` puts a second
            set of `<defs>` in the document, and every id in them is derived from
            an element id — which is only safe because both are built from the
            same `allElements` and therefore describe the same things. Give the
            two different element lists and a `url(#…)` would start resolving
            against the other slide's paint. */}
        {transition.outgoing && fitOut && paint.drawOutgoing && (
          <svg
            data-present-stage="outgoing"
            className="absolute inset-0 h-full w-full"
            style={{
              transform: `translate(${fitOut.pan.x + paint.outShift.x}px, ${fitOut.pan.y + paint.outShift.y}px) scale(${fitOut.zoom})`,
              transformOrigin: "0 0",
              display: "block",
              overflow: "visible",
              opacity: paint.outOpacity,
              zIndex: paint.outAbove ? 2 : 0
            }}
          >
            <DocumentStage
              elements={transition.outgoing.elements}
              allElements={allElements}
              docRef={docRef}
              zoom={fitOut.zoom}
              viewportBox={null}
              assets={docRef.current.assets}
              frameTitles={false}
            />
          </svg>
        )}

        {frame && fit && (
          <svg
            data-present-stage="true"
            className="absolute inset-0 h-full w-full"
            style={{
              transform: `translate(${fit.pan.x + paint.inShift.x}px, ${fit.pan.y - scrollY + paint.inShift.y}px) scale(${fit.zoom})`,
              transformOrigin: "0 0",
              display: "block",
              overflow: "visible",
              opacity: paint.inOpacity,
              zIndex: 1
            }}
          >
            <DocumentStage
              elements={incoming ?? frame.elements}
              allElements={stageAllElements}
              docRef={docRef}
              zoom={fit.zoom}
              viewportBox={null}
              assets={docRef.current.assets}
              frameTitles={false}
            />
          </svg>
        )}
      </div>

      {/* Top Left Controls: Exit Button */}
      <div
        className={`absolute left-4 top-4 z-20 flex items-center transition-opacity duration-base ${
          uiVisible ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"
        }`}
        onClick={(e: MouseEvent) => e.stopPropagation()}
      >
        <button
          type="button"
          data-present-exit="true"
          aria-label={t("present.exit")}
          title={`${t("present.exit")} (Esc)`}
          className="flex h-8 w-8 items-center justify-center rounded-full bg-panel/90 text-ink shadow-modal backdrop-blur hover:bg-raised transition-colors"
          onClick={handleExit}
        >
          <X size={14} />
        </button>
      </div>

      {/* Top Right Controls: Scale Options, Fullscreen */}
      <div
        className={`absolute right-4 top-4 z-20 flex items-center gap-2 transition-opacity duration-base ${
          uiVisible ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"
        }`}
        onClick={(e: MouseEvent) => e.stopPropagation()}
      >
        {/* Scale Mode Picker */}
        <div className="relative">
          <button
            ref={scaleButtonRef}
            type="button"
            data-testid="present-scale-trigger"
            aria-label={getScaleLabel(scaleMode)}
            aria-expanded={scaleMenuOpen}
            className="flex h-8 items-center gap-1.5 rounded-full bg-panel/90 px-3 text-row font-medium text-ink shadow-modal backdrop-blur hover:bg-raised transition-colors"
            onClick={() => setScaleMenuOpen((open) => !open)}
          >
            <ScaleModeIcon mode={scaleMode} />
            <span className="max-w-[120px] truncate">{getScaleLabel(scaleMode)}</span>
            <ChevronDown size={12} className="text-ink-dim shrink-0" />
          </button>

          {scaleMenuOpen && (
            <div
              ref={scaleMenuRef}
              className={`${MENU_SURFACE_CLASS} absolute right-0 top-10 w-56 py-1.5 z-30 shadow-popover`}
            >
              <button
                type="button"
                className={`w-full flex items-center gap-2.5 px-3 py-1.5 text-left text-row hover:bg-raised transition-colors ${
                  scaleMode === "actual" ? "text-brand font-medium" : "text-ink"
                }`}
                onClick={() => selectScale("actual")}
              >
                <div className="w-3.5 flex items-center justify-center shrink-0">
                  {scaleMode === "actual" && <Check size={13} className="text-brand" />}
                </div>
                <ScaleModeIcon mode="actual" />
                <span className="flex-1 truncate">{t("present.actualSize")}</span>
              </button>

              <button
                type="button"
                className={`w-full flex items-center gap-2.5 px-3 py-1.5 text-left text-row hover:bg-raised transition-colors ${
                  scaleMode === "responsive" ? "text-brand font-medium" : "text-ink"
                }`}
                onClick={() => selectScale("responsive")}
              >
                <div className="w-3.5 flex items-center justify-center shrink-0">
                  {scaleMode === "responsive" && <Check size={13} className="text-brand" />}
                </div>
                <ScaleModeIcon mode="responsive" />
                <span className="flex-1 truncate">{t("present.responsive")}</span>
              </button>

              <div className="my-1.5 border-t border-rule" />
              <div className="px-3 py-1 text-micro text-ink-dim uppercase tracking-wider">
                {t("present.otherScalingOptions")}
              </div>

              <button
                type="button"
                className={`w-full flex items-center gap-2.5 px-3 py-1.5 text-left text-row hover:bg-raised transition-colors ${
                  scaleMode === "fit-width" ? "text-brand font-medium" : "text-ink"
                }`}
                onClick={() => selectScale("fit-width")}
              >
                <div className="w-3.5 flex items-center justify-center shrink-0">
                  {scaleMode === "fit-width" && <Check size={13} className="text-brand" />}
                </div>
                <ScaleModeIcon mode="fit-width" />
                <span className="flex-1 truncate">{t("present.fitWidth")}</span>
              </button>

              <button
                type="button"
                className={`w-full flex items-center gap-2.5 px-3 py-1.5 text-left text-row hover:bg-raised transition-colors ${
                  scaleMode === "fit" ? "text-brand font-medium" : "text-ink"
                }`}
                onClick={() => selectScale("fit")}
              >
                <div className="w-3.5 flex items-center justify-center shrink-0">
                  {scaleMode === "fit" && <Check size={13} className="text-brand" />}
                </div>
                <ScaleModeIcon mode="fit" />
                <span className="flex-1 truncate">{t("present.fitWidthAndHeight")}</span>
              </button>

              <button
                type="button"
                className={`w-full flex items-center gap-2.5 px-3 py-1.5 text-left text-row hover:bg-raised transition-colors ${
                  scaleMode === "fill" ? "text-brand font-medium" : "text-ink"
                }`}
                onClick={() => selectScale("fill")}
              >
                <div className="w-3.5 flex items-center justify-center shrink-0">
                  {scaleMode === "fill" && <Check size={13} className="text-brand" />}
                </div>
                <ScaleModeIcon mode="fill" />
                <span className="flex-1 truncate">{t("present.fillScreen")}</span>
              </button>
            </div>
          )}
        </div>

        {/* Fullscreen Button */}
        <button
          type="button"
          data-testid="present-fullscreen-toggle"
          aria-label={isFullscreen ? t("present.exitFullscreen") : t("present.fullscreen")}
          title={isFullscreen ? `${t("present.exitFullscreen")} (F)` : `${t("present.fullscreen")} (F)`}
          className="flex h-8 w-8 items-center justify-center rounded-full bg-panel/90 text-ink shadow-modal backdrop-blur hover:bg-raised transition-colors"
          onClick={toggleFullscreen}
        >
          {isFullscreen ? <Minimize size={14} /> : <Maximize size={14} />}
        </button>
      </div>

      {/* Streamlined Bottom Right HUD: [<] 1 / 2 [>] */}
      <div
        className={`absolute bottom-5 right-5 z-20 transition-opacity duration-base ${
          uiVisible ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"
        }`}
        onClick={(e: MouseEvent) => e.stopPropagation()}
      >
        <div className="flex items-center gap-1.5 rounded-full bg-panel/90 px-2 py-1 shadow-modal backdrop-blur border border-rule/40">
          <button
            type="button"
            aria-label={t("present.prev")}
            disabled={index <= 0}
            className="flex h-6 w-6 items-center justify-center rounded-full text-ink hover:bg-raised disabled:opacity-30 disabled:pointer-events-none transition-colors"
            onClick={(e: MouseEvent) => {
              e.stopPropagation();
              onPrev();
            }}
          >
            <ChevronLeft size={14} />
          </button>

          <span data-present-counter="true" className="px-2 text-row tabular-nums font-medium text-ink">
            {index + 1} / {total}
          </span>

          <button
            type="button"
            aria-label={t("present.next")}
            disabled={index >= total - 1}
            className="flex h-6 w-6 items-center justify-center rounded-full text-ink hover:bg-raised disabled:opacity-30 disabled:pointer-events-none transition-colors"
            onClick={(e: MouseEvent) => {
              e.stopPropagation();
              onNext();
            }}
          >
            <ChevronRight size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}
