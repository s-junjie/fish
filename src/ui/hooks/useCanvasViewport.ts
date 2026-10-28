import { useState, useRef, useCallback, useEffect } from "preact/hooks";
import type { Rect } from "../../core/geometry/bounds";
import { fitRect } from "../../core/geometry/fit";
import { clampZoom, wheelZoomFactor, zoomStep, MIN_ZOOM, MAX_ZOOM, visibleRectOf, centerInRect } from "../../core/geometry/viewport";

/** Breathing room a fit leaves between the content and the panels, in screen px. */
const FIT_MARGIN = 48;

interface Camera {
  zoom: number;
  pan: { x: number; y: number };
}

export function useCanvasViewport() {
  const canvasContainerRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(0.8);
  // The canvas is full-bleed and the side panels float over it, so pan is in
  // window space: x clears the default 240px layer panel or content starts hidden.
  const [pan, setPan] = useState({ x: 390, y: 80 });
  const [isSpacePressed, setIsSpacePressed] = useState(false);
  const [isCanvasPanning, setIsCanvasPanning] = useState(false);
  const isDraggingCanvas = useRef(false);
  const lastMousePos = useRef({ x: 0, y: 0 });

  /**
   * A wheel burst is many events and one frame.
   *
   * Every event used to commit `zoom` + `pan`, so a trackpad tick that Chromium
   * splits into eight events drove eight renders of the canvas, the layer panel
   * and the assets panel. The events are folded into the last one of the frame
   * instead; the folded value is also written to the refs immediately, so a
   * handler that reads the camera between events sees what the user is about to
   * see rather than what was painted.
   */
  const pendingRef = useRef<Camera | null>(null);
  const frameRef = useRef(0);

  // The camera as the event handlers read it. Written on every render AND on
  // every scheduled change, so a gesture computes from where it actually is
  // rather than from the last committed frame — and a render that lands between
  // the schedule and its frame does not drag the refs back to the older state.
  const zoomRef = useRef(zoom);
  const panRef = useRef(pan);
  if (!pendingRef.current) {
    zoomRef.current = zoom;
    panRef.current = pan;
  }

  const flushPending = useCallback(() => {
    frameRef.current = 0;
    const next = pendingRef.current;
    pendingRef.current = null;
    if (!next) return;
    setZoom(next.zoom);
    setPan(next.pan);
  }, []);

  const scheduleCamera = useCallback(
    (next: Camera) => {
      pendingRef.current = next;
      zoomRef.current = next.zoom;
      panRef.current = next.pan;
      if (frameRef.current) return;
      frameRef.current =
        typeof requestAnimationFrame === "function"
          ? requestAnimationFrame(flushPending)
          : (setTimeout(flushPending, 16) as unknown as number);
    },
    [flushPending]
  );

  const currentCamera = useCallback(
    (): Camera => pendingRef.current ?? { zoom: zoomRef.current, pan: panRef.current },
    []
  );

  /** An explicit command (fit, focus, zoom step) owns the camera outright. */
  const commitCamera = useCallback((next: Camera) => {
    pendingRef.current = null;
    zoomRef.current = next.zoom;
    panRef.current = next.pan;
    setZoom(next.zoom);
    setPan(next.pan);
  }, []);

  useEffect(
    () => () => {
      if (frameRef.current) {
        if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(frameRef.current);
        else clearTimeout(frameRef.current);
      }
      frameRef.current = 0;
    },
    []
  );

  /**
   * The container's box, measured once per window size rather than per wheel
   * event: the canvas is a full-bleed layer under floating panels, so its origin
   * only moves when the window does, and a rect read per event is a forced
   * layout in the middle of a gesture.
   */
  const containerRectRef = useRef<DOMRect | null>(null);
  useEffect(() => {
    const invalidate = () => {
      containerRectRef.current = null;
    };
    window.addEventListener("resize", invalidate);
    return () => window.removeEventListener("resize", invalidate);
  }, []);

  const handleWheel = (e: WheelEvent) => {
    e.preventDefault();
    const camera = currentCamera();
    if (e.ctrlKey || e.metaKey) {
      const container = canvasContainerRef.current;
      if (!container) return;
      const rect = (containerRectRef.current ??= container.getBoundingClientRect());
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;

      // External constraint: browser synthesises a ctrlKey wheel with small
      // continuous deltaY for trackpad pinch, but discrete ±100 ticks for a mouse
      // wheel. `wheelZoomFactor` owns the response — including the cap that stops
      // one notch from being a 3.3x jump.
      const zoomFactor = wheelZoomFactor(e.deltaY, e.deltaMode);
      const nextZoom = clampZoom(camera.zoom * zoomFactor);

      const worldX = (mouseX - camera.pan.x) / camera.zoom;
      const worldY = (mouseY - camera.pan.y) / camera.zoom;

      scheduleCamera({
        zoom: nextZoom,
        pan: { x: mouseX - worldX * nextZoom, y: mouseY - worldY * nextZoom }
      });
    } else {
      scheduleCamera({
        zoom: camera.zoom,
        pan: { x: camera.pan.x - e.deltaX, y: camera.pan.y - e.deltaY }
      });
    }
  };

  const startCanvasPan = (clientX: number, clientY: number) => {
    isDraggingCanvas.current = true;
    setIsCanvasPanning(true);
    lastMousePos.current = { x: clientX, y: clientY };
  };

  const updateCanvasPan = (clientX: number, clientY: number) => {
    if (!isDraggingCanvas.current) return false;
    const dx = clientX - lastMousePos.current.x;
    const dy = clientY - lastMousePos.current.y;
    lastMousePos.current = { x: clientX, y: clientY };
    const camera = currentCamera();
    scheduleCamera({ zoom: camera.zoom, pan: { x: camera.pan.x + dx, y: camera.pan.y + dy } });
    return true;
  };

  const endCanvasPan = () => {
    isDraggingCanvas.current = false;
    setIsCanvasPanning(false);
    // The last pointer delta belongs on screen before the gesture is declared
    // over, not one frame later under a released cursor.
    flushPending();
  };

  /**
   * The part of the canvas a fit may use, in the canvas transform's own space
   * (its origin is the container's top-left corner, which is where the panel
   * rects have to be converted to).
   *
   * The canvas is full-bleed and the title bar, the side panels, the dock and
   * the inspector are laid over it, so the window is NOT the viewport — fitting
   * into the window puts the content under a panel. `data-ui-panel` names the
   * edge each one is anchored to, which is the only thing that tells the
   * full-height inspector apart from the dock: both boxes touch three edges of
   * the container, and measuring the overlap alone cannot say which one to give
   * up. A hidden panel keeps its box but is translated off the edge, so its
   * overlap is empty and it drops out here without asking anyone whether it is
   * visible.
   */
  const unobstructedArea = useCallback((): Rect => {
    const container = canvasContainerRef.current;
    const view = container?.getBoundingClientRect();
    const width = view?.width ?? window.innerWidth;
    const height = view?.height ?? window.innerHeight;
    const originX = view?.left ?? 0;
    const originY = view?.top ?? 0;
    let left = 0;
    let top = 0;
    let right = width;
    let bottom = height;
    for (const panel of document.querySelectorAll<HTMLElement>("[data-ui-panel]")) {
      const box = panel.getBoundingClientRect();
      const l = box.left - originX;
      const r = box.right - originX;
      const t = box.top - originY;
      const b = box.bottom - originY;
      if (Math.min(r, right) <= Math.max(l, left) || Math.min(b, bottom) <= Math.max(t, top)) continue;
      if (panel.dataset.uiPanel === "left") left = Math.max(left, r);
      else if (panel.dataset.uiPanel === "right") right = Math.min(right, l);
      else if (panel.dataset.uiPanel === "dock") bottom = Math.min(bottom, t);
      else if (panel.dataset.uiPanel === "top") top = Math.max(top, b);
    }
    return { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
  }, []);

  /**
   * Frame `bounds` (a world-space rect) in the middle of the unobstructed area,
   * as large as it fits. An empty page has no box to frame, so it falls back to
   * 1:1 centred on the viewport — the one reading of "fit" that still means
   * something there.
   */
  const fitBounds = (bounds: Rect | null) => {
    // Presentation fits into an area it measures itself, so the arithmetic lives
    // in `fitRect` rather than here.
    const fit = fitRect(bounds, unobstructedArea(), {
      margin: FIT_MARGIN,
      minZoom: MIN_ZOOM,
      maxZoom: MAX_ZOOM
    });
    if (!fit) return;
    commitCamera({ zoom: fit.zoom, pan: fit.pan });
  };

  // `focusOn` is stable across renders so a caller can depend on it, and it has
  // to read the zoom of the frame it fires in rather than one captured earlier.

  /**
   * Bring world-space `bounds` to the middle of the unobstructed area, zooming
   * out only as far as is needed to make the box fit.
   *
   * Unlike a fit it never magnifies: the point of a locate is to show the user
   * where something is, and a jump that also changed scale leaves them looking
   * at a canvas they no longer recognise. A box too big for the current zoom
   * would be centred on a slice of itself, so that one case does shrink.
   */
  const focusOn = useCallback(
    (bounds: Rect | null) => {
      if (!bounds) return;
      const area = unobstructedArea();
      if (area.width <= 0 || area.height <= 0) return;
      const current = zoomRef.current;
      const usableWidth = Math.max(1, area.width - FIT_MARGIN * 2);
      const usableHeight = Math.max(1, area.height - FIT_MARGIN * 2);
      const fits =
        bounds.width <= 0 || bounds.height <= 0
          ? current
          : clampZoom(Math.min(usableWidth / bounds.width, usableHeight / bounds.height));
      const nextZoom = Math.min(current, fits);
      commitCamera({
        zoom: nextZoom,
        pan: {
          x: area.x + area.width / 2 - (bounds.x + bounds.width / 2) * nextZoom,
          y: area.y + area.height / 2 - (bounds.y + bounds.height / 2) * nextZoom
        }
      });
    },
    [unobstructedArea, commitCamera]
  );

  /**
   * 1:1 about the middle of the unobstructed area: the zoom changes, the thing
   * the user is looking at stays where it is.
   *
   * The camera is read through `currentCamera` rather than as a dependency, and
   * the callback is stable, because the caller is a global key listener that
   * does not re-register on every render. Reading `zoom` / `pan` here would
   * freeze the command at the zoom of whichever render last re-bound the
   * listener: every press would then compute the same destination from the same
   * stale numbers, which is exactly the "keyboard zoom moves once" bug.
   */
  const zoomToActualSize = useCallback(() => {
    const area = unobstructedArea();
    if (area.width <= 0 || area.height <= 0) return;
    const camera = currentCamera();
    const focusX = area.x + area.width / 2;
    const focusY = area.y + area.height / 2;
    const worldX = (focusX - camera.pan.x) / camera.zoom;
    const worldY = (focusY - camera.pan.y) / camera.zoom;
    commitCamera({ zoom: 1, pan: { x: focusX - worldX, y: focusY - worldY } });
  }, [unobstructedArea, currentCamera, commitCamera]);

  /**
   * One rung along `ZOOM_STEPS`, about the middle of the unobstructed area: the
   * zoom changes, the thing the user is looking at stays where it is. A key press
   * or a dock button has no cursor to anchor to, so it takes the same centre the
   * 1:1 command does.
   *
   * Stable, and reads the live camera, for the same reason `zoomToActualSize`
   * does: a `+` held down is one command repeated, and each press has to start
   * from the rung the previous one left behind.
   */
  const zoomByStep = useCallback(
    (direction: 1 | -1) => {
      const area = unobstructedArea();
      if (area.width <= 0 || area.height <= 0) return;
      const camera = currentCamera();
      const focusX = area.x + area.width / 2;
      const focusY = area.y + area.height / 2;
      const next = zoomStep(camera.zoom, direction);
      if (next === camera.zoom) return;
      const worldX = (focusX - camera.pan.x) / camera.zoom;
      const worldY = (focusY - camera.pan.y) / camera.zoom;
      commitCamera({ zoom: next, pan: { x: focusX - worldX * next, y: focusY - worldY * next } });
    },
    [unobstructedArea, currentCamera, commitCamera]
  );

  /**
   * The world rect the user can actually see.
   *
   * The canvas is full-bleed with the panels lying over it, so this is the
   * unobstructed area — the same box zoom-to-fit frames into — rather than the
   * window: a drop aimed at the window centre lands under whichever panel is
   * wider. A squeezed area (panels overlapping on a narrow window) falls back to
   * the window, because a zero-width box centres every drop on its own edge.
   *
   * It reads the camera through the refs rather than as a dependency, so its
   * identity outlives a pan. Anything memoized on it — the layer panel, the
   * assets panel, twelve editor commands, the global key listeners — used to
   * re-render or re-bind on every wheel tick, and each of those rebuilds walked
   * the whole document to answer a question whose answer had not changed.
   */
  const visibleWorldRect = useCallback((): Rect => {
    const raw = unobstructedArea();
    const area =
      raw.width > 0 && raw.height > 0
        ? raw
        : { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight };
    return visibleRectOf(area, zoomRef.current, panRef.current);
  }, [unobstructedArea]);

  /**
   * Where an element of `size` lands when the user gave no position: centred on
   * the canvas they are looking at.
   *
   * Every positionless insert goes through this — an asset card, a plugin panel,
   * a pasted image — so none of them can be filed at a page coordinate the
   * current view does not show. That is the whole failure mode it exists to
   * prevent: the element is in the document, and the user cannot see it.
   */
  const dropTopLeft = useCallback(
    (size: { width: number; height: number }) => centerInRect(visibleWorldRect(), size),
    [visibleWorldRect]
  );

  return {
    canvasContainerRef,
    zoom,
    setZoom,
    pan,
    setPan,
    isSpacePressed,
    setIsSpacePressed,
    isCanvasPanning,
    setIsCanvasPanning,
    isDraggingCanvas,
    handleWheel,
    startCanvasPan,
    updateCanvasPan,
    endCanvasPan,
    fitBounds,
    focusOn,
    zoomByStep,
    zoomToActualSize,
    visibleWorldRect,
    dropTopLeft
  };
}
