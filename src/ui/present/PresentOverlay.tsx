import { useState, useRef, useEffect, useCallback, useMemo } from "preact/hooks";
import { DesignDocument, DesignElement, Page } from "../../core/dsl/types";
import { DEFAULT_CANVAS_BACKGROUND } from "../../core/dsl/defaults";
import { PresentationFrame } from "../../core/presentation/frames";
import { DocumentStage } from "../canvas/DocumentStage";
import { useElementSize } from "../hooks/useElementSize";
import { openLinkFromEvent } from "../link-activation";
import { useDismiss } from "../hooks/useDismiss";
import { useWindowKeydown } from "../hooks/useWindowKeydown";
import { t } from "../../i18n";
import { PresentScaleMode, calculatePresentFit } from "./presentScale";
import { PresentPageEntry, PresentTransition } from "./usePresentation";
import { matchSlides } from "../../core/presentation/morph";
import { morphSlide, slidePaint } from "../../core/presentation/animate";
import { flattenElements } from "../../core/geometry/tree-ops";
import { mapElements } from "../../core/geometry/tree-edit";
import { findElementAtPoint } from "../../core/geometry/tree-hit";
import { canContainerScroll, clampScrollOffset, findScrollableContainersAtPoint } from "../../core/geometry/scroll-bounds";
import { MENU_ITEM_CLASS, MENU_ITEM_ON_CLASS, MENU_SEPARATOR_CLASS, MENU_SURFACE_CLASS } from "../menu-style";
import { LEADER_RULE_CLASS } from "../inspector/SectionHeader";
import { ScaleModeIcon } from "../scale-icons";
import {
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  Check,
  File,
  Maximize,
  Minimize,
  X
} from "lucide-react";

interface PresentOverlayProps {
  frame: PresentationFrame | null;
  index: number;
  total: number;
  transition: PresentTransition;
  /** The page being played — a deck can switch pages without committing one. */
  page: Page;
  /** The pages the deck can switch to, in document order. */
  pages: PresentPageEntry[];
  docRef: { current: DesignDocument };
  onExit: () => void;
  onNext: () => void;
  onPrev: () => void;
  onSelectPage: (pageId: string) => void;
  /**
   * This session's answer for the played page, when the host keeps one instead
   * of writing the document. `undefined` reads the page's own `presentBackground`
   * — the editor's case, where the menu row is the setting itself.
   */
  canvasBackground?: boolean;
  /**
   * Writes `canvas.presentBackground` for the page being played, and absent in a
   * host that may not write the document: the row is then not rendered at all
   * rather than rendered dead.
   */
  onSetCanvasBackground?: (value: boolean) => void;
}

const WHEEL_COOLDOWN_MS = 350;
const AUTO_HIDE_DELAY_MS = 2500;

/** The share of the width that reads as "back" when the slide is clicked. */
const BACK_ZONE = 0.3;

/** The mode's name — the trigger's label, a row's label, and its aria-label. */
function scaleLabel(mode: PresentScaleMode): string {
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
}

/**
 * One row of the deck's menu: the mark, the glyph, the label — the same
 * three-column row the page menu draws, because there is one menu (DESIGN.md
 * §The one menu), not one per control.
 */
function ScaleRow({
  mode,
  active,
  onSelect
}: {
  mode: PresentScaleMode;
  active: PresentScaleMode;
  onSelect: (mode: PresentScaleMode) => void;
}) {
  const on = mode === active;
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={on}
      className={`${MENU_ITEM_CLASS} ${on ? MENU_ITEM_ON_CLASS : ""}`.trim()}
      onClick={() => onSelect(mode)}
    >
      <span className="flex w-3.5 shrink-0 justify-center">
        {on && <Check size={13} className="text-brand group-hover:text-brand-ink" />}
      </span>
      <ScaleModeIcon mode={mode} />
      <span className="min-w-0 flex-1">{scaleLabel(mode)}</span>
    </button>
  );
}

export function PresentOverlay({
  frame,
  index,
  total,
  transition,
  page,
  pages,
  docRef,
  onExit,
  onNext,
  onPrev,
  onSelectPage,
  canvasBackground,
  onSetCanvasBackground
}: PresentOverlayProps) {
  const screenRef = useRef<HTMLDivElement>(null);
  const scaleButtonRef = useRef<HTMLButtonElement>(null);
  const scaleMenuRef = useRef<HTMLDivElement>(null);
  const pageButtonRef = useRef<HTMLButtonElement>(null);
  const pageMenuRef = useRef<HTMLDivElement>(null);
  const lastWheelRef = useRef(0);
  const hideTimerRef = useRef<number | null>(null);
  const size = useElementSize(screenRef);

  const [scaleMode, setScaleMode] = useState<PresentScaleMode>("responsive");
  const [scaleMenuOpen, setScaleMenuOpen] = useState(false);
  const [pageMenuOpen, setPageMenuOpen] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(Boolean(document.fullscreenElement));
  const [uiVisible, setUiVisible] = useState(true);
  const [scrollY, setScrollY] = useState(0);
  const [containerScrolls, setContainerScrolls] = useState<Record<string, { x: number; y: number }>>({});

  // Read once: the deck is mounted and unmounted per presentation, and a
  // pointer type cannot change inside one.
  const [touch] = useState(
    () => typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia("(pointer: coarse)").matches
      : false
  );

  // Reset scroll state whenever slide changes
  useEffect(() => {
    setScrollY(0);
    setContainerScrolls({});
  }, [index, frame?.id]);

  /**
   * The elements the PLAYED page paints, flattened.
   *
   * Derived here rather than handed in by the host: a deck can switch pages, and
   * the host's flat list is its own page's — a stage painting one page's slide
   * out of another page's list is exactly the pairing `<defs>` cannot survive.
   * `defs` itself stays document-wide (`CanvasDefs` walks `docRef`), so an
   * instance whose master lives elsewhere still resolves.
   */
  const pageElements = useMemo(() => flattenElements(page.children ?? []), [page]);

  useDismiss(scaleMenuOpen, () => setScaleMenuOpen(false), scaleMenuRef, scaleButtonRef);
  useDismiss(pageMenuOpen, () => setPageMenuOpen(false), pageMenuRef, pageButtonRef);

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
    // A menu that is open holds the chrome on screen: the pointer may leave the
    // deck entirely while reading it, and a control that faded under an open menu
    // takes the menu with it.
    if (!scaleMenuOpen && !pageMenuOpen) {
      hideTimerRef.current = window.setTimeout(() => {
        setUiVisible(false);
      }, AUTO_HIDE_DELAY_MS);
    }
  }, [scaleMenuOpen, pageMenuOpen]);

  useEffect(() => {
    resetAutoHide();
    return () => {
      if (hideTimerRef.current !== null) {
        window.clearTimeout(hideTimerRef.current);
      }
    };
  }, [resetAutoHide, scaleMenuOpen, pageMenuOpen]);

  /**
   * Full screen is a deliberate second press, never a consequence of entering
   * the deck — on any platform. iPhone Safari has no element fullscreen at all,
   * which is why the button is not rendered there rather than rendered dead.
   */
  const canFullscreen =
    typeof document !== "undefined" &&
    typeof document.documentElement.requestFullscreen === "function";

  const toggleFullscreen = useCallback(() => {
    const root = document.documentElement;
    if (!document.fullscreenElement) {
      const request = root.requestFullscreen?.();
      if (request && typeof request.catch === "function") request.catch(() => { });
      return;
    }
    const exit = document.exitFullscreen?.();
    if (exit && typeof exit.catch === "function") exit.catch(() => { });
  }, []);

  const handleExit = useCallback(() => {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => { });
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
      const el = pageElements.find((e) => e.id === vid) as any;
      if (el && el.type === "video" && el.autoplay) {
        v.currentTime = 0;
        v.play().catch(() => { });
      }
    });
  }, [index, frame, pageElements]);

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
    if (!incoming) return pageElements;
    const flatIncoming = flattenElements(incoming);
    const incomingMap = new Map(flatIncoming.map((el) => [el.id, el]));
    const result = pageElements.map((el) => incomingMap.get(el.id) ?? el);
    for (const el of flatIncoming) {
      if (!pageElements.some((e) => e.id === el.id)) {
        result.push(el);
      }
    }
    return result;
  }, [pageElements, incoming]);

  const scrolledElements = useMemo(() => {
    const base = incoming ?? frame?.elements ?? [];
    if (Object.keys(containerScrolls).length === 0) return base;
    return mapElements(base, (el) => {
      const s = containerScrolls[el.id];
      if (s) {
        return { ...el, scrollX: s.x, scrollY: s.y };
      }
      return el;
    });
  }, [incoming, frame?.elements, containerScrolls]);

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

  const selectScale = (mode: PresentScaleMode) => {
    setScaleMode(mode);
    setScaleMenuOpen(false);
  };

  const maxScroll = fit && frame ? Math.max(0, frame.bounds.height * fit.zoom - viewport.height) : 0;

  // Under a mouse a deck is driven by the keyboard and these controls are a
  // reminder; under a thumb they are the whole interface, and 32px is not a
  // target. Same object, two metrics.
  const roundBtn = `flex items-center justify-center rounded-full bg-panel/90 text-ink shadow-modal backdrop-blur hover:bg-raised transition-colors ${touch ? "h-11 w-11" : "h-8 w-8"
    }`;

  /**
   * The backdrop is the PAGE's own statement, not the viewer's: a deck whose
   * slides were drawn on a canvas colour is shown on it, and one that never opted
   * in keeps the paper surface the editor's chrome is tuned to.
   *
   * The menu row that writes that field sits in the same menu as the scale
   * modes, so the deck is the one place the setting is both made and seen —
   * which is what an inspector checkbox two panels away from the effect could
   * never be.
   */
  const pageCanvas = page.canvas ?? docRef.current.canvas;
  const canvasColor =
    pageCanvas?.background?.type === "solid" ? pageCanvas.background.color : DEFAULT_CANVAS_BACKGROUND;
  const usesCanvasBackground = canvasBackground ?? (pageCanvas?.presentBackground === true);
  const presentationBg = usesCanvasBackground ? canvasColor : null;

  return (
    <div
      data-present-overlay="true"
      role="dialog"
      aria-modal="true"
      aria-label={t("present.title")}
      style={presentationBg ? { backgroundColor: presentationBg } : undefined}
      className={`fixed inset-0 z-[100] select-none overflow-hidden ${presentationBg ? "" : "bg-paper"} ${uiVisible ? "cursor-default" : "cursor-none"
        }`}
      onMouseMove={resetAutoHide}
      onPointerDown={resetAutoHide}
      onClick={(e: any) => {
        resetAutoHide();
        if (scaleMenuOpen || pageMenuOpen) {
          setScaleMenuOpen(false);
          setPageMenuOpen(false);
          return;
        }
        const target = e.target as HTMLElement | null;
        if (target && target.closest("foreignObject, video, iframe")) {
          return;
        }
        if (openLinkFromEvent(e)) return;
        // A link still wins in the back zone: it is the only thing on the slide
        // that promised to do something, and a mis-aimed tap that navigated away
        // is worse than one that went to the previous slide.
        if (typeof e.clientX === "number" && e.clientX < window.innerWidth * BACK_ZONE) {
          onPrev();
          return;
        }
        onNext();
      }}
      onWheel={(e: any) => {
        resetAutoHide();

        const target = e.target as HTMLElement | null;
        if (target && target.closest("foreignObject, video, iframe")) {
          return;
        }

        e.preventDefault();

        // 1. Scroll container under cursor if scrollable
        if (fit && frame) {
          const shiftX = paint.inShift.x;
          const shiftY = paint.inShift.y;
          const worldX = (e.clientX - (fit.pan.x + shiftX)) / fit.zoom;
          const worldY = (e.clientY - (fit.pan.y - scrollY + shiftY)) / fit.zoom;

          const hit = findElementAtPoint(scrolledElements, worldX, worldY, { includeLocked: true });
          if (hit && hit.type === "html") {
            return;
          }

          const candidates = findScrollableContainersAtPoint(scrolledElements, worldX, worldY);
          if (candidates.length > 0) {
            for (const cand of candidates) {
              const curX = containerScrolls[cand.id]?.x ?? cand.scrollX ?? 0;
              const curY = containerScrolls[cand.id]?.y ?? cand.scrollY ?? 0;
              const candWithScroll = { ...cand, scrollX: curX, scrollY: curY };
              if (canContainerScroll(candWithScroll, e.deltaX, e.deltaY)) {
                const { scrollX: nextX, scrollY: nextY } = clampScrollOffset(
                  candWithScroll as any,
                  curX + e.deltaX,
                  curY + e.deltaY
                );
                if (nextX !== curX || nextY !== curY) {
                  setContainerScrolls((prev) => ({
                    ...prev,
                    [cand.id]: { x: nextX, y: nextY }
                  }));
                  return;
                }
              }
            }
            return;
          }
        }

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
            same `pageElements` and therefore describe the same things. Give the
            two different element lists and a `url(#…)` would start resolving
            against the other slide's paint. A page switch settles the transition
            first, so the outgoing slide is always one of THIS page's. */}
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
              allElements={pageElements}
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
              elements={scrolledElements}
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

      {/* Top Left Controls: Exit, and which page is playing */}
      <div
        className={`absolute left-4 top-4 z-20 flex items-center gap-2 transition-opacity duration-base ${
          uiVisible ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"
        }`}
        onClick={(e: MouseEvent) => e.stopPropagation()}
      >
        <button
          type="button"
          data-present-exit="true"
          aria-label={t("present.exit")}
          title={`${t("present.exit")} (Esc)`}
          className={roundBtn}
          onClick={handleExit}
        >
          <X size={14} />
        </button>

        {/* A deck is one page at a time, and this is the door between them: the
            exit button is the deck's chrome too, so the page it is showing is
            named beside it rather than left implicit. Absent, not dead, when
            there is only one page to switch to. */}
        {pages.length > 1 && (
          <div className="relative">
            <button
              ref={pageButtonRef}
              type="button"
              data-testid="present-page-trigger"
              aria-label={t("present.pages")}
              aria-expanded={pageMenuOpen}
              className={`flex items-center gap-1.5 rounded-full bg-panel/90 px-3 text-row font-medium text-ink shadow-modal backdrop-blur hover:bg-raised transition-colors ${
                touch ? "h-11" : "h-8"
              }`}
              onClick={() => setPageMenuOpen((open) => !open)}
            >
              <File size={12} className="shrink-0 text-ink-dim" />
              <span className="max-w-[160px] truncate">{page.name}</span>
              <ChevronDown size={12} className="shrink-0 text-ink-dim" />
            </button>

            {pageMenuOpen && (
              <div
                ref={pageMenuRef}
                role="menu"
                aria-label={t("present.pages")}
                className={`${MENU_SURFACE_CLASS} absolute left-0 top-full mt-2 max-h-[50vh] w-56 overflow-y-auto py-1.5`}
              >
                {pages.map((entry) => {
                  const on = entry.id === page.id;
                  return (
                    <button
                      key={entry.id}
                      type="button"
                      role="menuitemradio"
                      aria-checked={on}
                      className={`${MENU_ITEM_CLASS} ${on ? MENU_ITEM_ON_CLASS : ""}`.trim()}
                      onClick={() => {
                        onSelectPage(entry.id);
                        setPageMenuOpen(false);
                      }}
                    >
                      <span className="flex w-3.5 shrink-0 justify-center">
                        {on && <Check size={13} className="text-brand group-hover:text-brand-ink" />}
                      </span>
                      <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Top Right Controls: Scale Options, Fullscreen */}
      <div
        className={`absolute right-4 top-4 z-20 flex items-center gap-2 transition-opacity duration-base ${uiVisible ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"
          }`}
        onClick={(e: MouseEvent) => e.stopPropagation()}
      >
        {/* Scale Mode Picker */}
        <div className="relative">
          <button
            ref={scaleButtonRef}
            type="button"
            data-testid="present-scale-trigger"
            aria-label={scaleLabel(scaleMode)}
            aria-expanded={scaleMenuOpen}
            className={`flex items-center gap-1.5 rounded-full bg-panel/90 px-3 text-row font-medium text-ink shadow-modal backdrop-blur hover:bg-raised transition-colors ${touch ? "h-11" : "h-8"
              }`}
            onClick={() => setScaleMenuOpen((open) => !open)}
          >
            <ScaleModeIcon mode={scaleMode} />
            <span className="max-w-[120px] truncate">{scaleLabel(scaleMode)}</span>
            <ChevronDown size={12} className="text-ink-dim shrink-0" />
          </button>

          {scaleMenuOpen && (
            <div
              ref={scaleMenuRef}
              role="menu"
              aria-label={t("present.viewOptions")}
              className={`${MENU_SURFACE_CLASS} absolute right-0 top-full mt-2`}
            >
              <ScaleRow mode="actual" active={scaleMode} onSelect={selectScale} />
              <ScaleRow mode="responsive" active={scaleMode} onSelect={selectScale} />

              <div className={MENU_SEPARATOR_CLASS} />
              {/* A section header, not a sub-label: `micro` carries its own 9px /
                  0.18em / 600, so the only thing a call site adds is the case. */}
              <div className="flex items-center gap-2 px-2.5 pb-1 pt-0.5">
                <span className="text-micro uppercase text-ink-muted">{t("present.otherScalingOptions")}</span>
                <span aria-hidden="true" className={LEADER_RULE_CLASS} />
              </div>

              <ScaleRow mode="fit-width" active={scaleMode} onSelect={selectScale} />
              <ScaleRow mode="fit" active={scaleMode} onSelect={selectScale} />
              <ScaleRow mode="fill" active={scaleMode} onSelect={selectScale} />

              {/* The deck's one setting. It lives here, in the menu that already
                  owns how the slide meets the screen, rather than as a labelled
                  pill in the fourth corner: it is set once per deck, and a
                  permanent control for a once-per-deck decision is chrome the
                  audience sees on every slide. A host that may not write the
                  document (the phone reader) omits the whole row rather than
                  drawing a row that does nothing. */}
              {onSetCanvasBackground && (
                <>
                  <div className={MENU_SEPARATOR_CLASS} />
                  <button
                    type="button"
                    role="menuitemcheckbox"
                    aria-checked={usesCanvasBackground}
                    data-testid="present-canvas-background"
                    title={t("present.canvasBackgroundHint")}
                    className={`${MENU_ITEM_CLASS} ${usesCanvasBackground ? MENU_ITEM_ON_CLASS : ""}`.trim()}
                    onClick={() => {
                      onSetCanvasBackground(!usesCanvasBackground);
                      setScaleMenuOpen(false);
                    }}
                  >
                    {/* A switch, not a mode: no glyph, so the label starts one
                        column in instead of two. The check's column is kept even
                        when off — a row whose mark appears and disappears would
                        shift its own label. */}
                    <span className="flex w-3.5 shrink-0 justify-center">
                      {usesCanvasBackground && <Check size={13} className="text-brand group-hover:text-brand-ink" />}
                    </span>
                    <span className="min-w-0 flex-1">{t("present.canvasBackground")}</span>
                  </button>
                </>
              )}
            </div>
          )}
        </div>

        {/* Fullscreen Button — absent where the platform has no element fullscreen. */}
        {canFullscreen && (
          <button
            type="button"
            data-testid="present-fullscreen-toggle"
            aria-label={isFullscreen ? t("present.exitFullscreen") : t("present.fullscreen")}
            title={isFullscreen ? `${t("present.exitFullscreen")} (F)` : `${t("present.fullscreen")} (F)`}
            className={roundBtn}
            onClick={toggleFullscreen}
          >
            {isFullscreen ? <Minimize size={14} /> : <Maximize size={14} />}
          </button>
        )}
      </div>

      {/* Streamlined Bottom Right HUD: [<] 1 / 2 [>] */}
      <div
        className={`absolute bottom-5 right-5 z-20 transition-opacity duration-base ${uiVisible ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"
          }`}
        onClick={(e: MouseEvent) => e.stopPropagation()}
      >
        <div className="flex items-center gap-1.5 rounded-full bg-panel/90 px-2 py-1 shadow-modal backdrop-blur border border-rule/40">
          <button
            type="button"
            aria-label={t("present.prev")}
            disabled={index <= 0}
            className={`flex items-center justify-center rounded-full text-ink hover:bg-raised disabled:opacity-30 disabled:pointer-events-none transition-colors ${touch ? "h-11 w-11" : "h-6 w-6"
              }`}
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
            className={`flex items-center justify-center rounded-full text-ink hover:bg-raised disabled:opacity-30 disabled:pointer-events-none transition-colors ${touch ? "h-11 w-11" : "h-6 w-6"
              }`}
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
