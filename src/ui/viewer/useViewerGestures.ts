import { useEffect, useRef } from "preact/hooks";
import type { Rect } from "../../core/geometry/bounds";
import { wheelZoomFactor } from "../../core/geometry/viewport";
import {
  clampCameraPan,
  panCamera,
  zoomCameraAt,
  type ViewerCamera,
  type ViewerSize
} from "./viewer-camera";

/**
 * Touch and wheel for the reader: one finger pans, two pinch, a double tap
 * zooms, a wheel scrolls the board.
 *
 * Pointer Events rather than mouse events, and `touch-action: none` on the host
 * (the caller's job) rather than `preventDefault` on every move — the browser
 * decides what a drag MEANS before the first `pointermove` arrives, so a canvas
 * that only cancels after the fact has already lost the gesture to the page.
 */

const TAP_SLOP_PX = 8;
const TAP_MAX_MS = 350;
const DOUBLE_TAP_MS = 320;
const DOUBLE_TAP_SLOP_PX = 32;

export interface ViewerGestureOptions {
  hostRef: { current: HTMLDivElement | null };
  camera: ViewerCamera;
  size: ViewerSize;
  bounds: Rect | null;
  onChange: (next: ViewerCamera) => void;
  /** A tap the caller consumed (a link). False lets the double-tap detector see it. */
  onTap: (clientX: number, clientY: number) => boolean;
  onDoubleTap: (clientX: number, clientY: number) => void;
  /**
   * A pointer is on the board and the drag belongs to it. The cursor is the
   * only reader of this on a phone-less device, and it is the caller's to draw:
   * this hook owns pointer lifetime, not paint.
   */
  onPanChange?: (panning: boolean) => void;
  /** Wheel callback. If it returns true, the wheel event is consumed and board panning is skipped. */
  onWheel?: (e: WheelEvent) => boolean;
}

interface PinchStart {
  ids: [number, number];
  distance: number;
  midX: number;
  midY: number;
  camera: ViewerCamera;
}

export function useViewerGestures(options: ViewerGestureOptions) {
  // One ref for every live value: the listeners are bound once, because rebinding
  // on each camera commit would drop a pointer that is mid-gesture.
  const latest = useRef(options);
  latest.current = options;

  const pinchRef = useRef<PinchStart | null>(null);
  const lastTapRef = useRef<{ time: number; x: number; y: number } | null>(null);

  useEffect(() => {
    const host = latest.current.hostRef.current;
    if (!host) return;

    const pointers = new Map<number, { x: number; y: number }>();
    let startClientX = 0;
    let startClientY = 0;
    let startTime = 0;
    let lastClientX = 0;
    let lastClientY = 0;
    let maxPointers = 0;

    const local = (clientX: number, clientY: number) => {
      const rect = host.getBoundingClientRect();
      return { x: clientX - rect.left, y: clientY - rect.top };
    };

    const commit = (next: ViewerCamera) => {
      const { bounds, size } = latest.current;
      latest.current.onChange(clampCameraPan(next, bounds, size));
    };

    const beginPinch = () => {
      const ids = [...pointers.keys()].slice(0, 2) as [number, number];
      const a = pointers.get(ids[0])!;
      const b = pointers.get(ids[1])!;
      pinchRef.current = {
        ids,
        distance: Math.max(1, Math.hypot(b.x - a.x, b.y - a.y)),
        midX: (a.x + b.x) / 2,
        midY: (a.y + b.y) / 2,
        camera: latest.current.camera
      };
    };

    const onPointerDown = (e: PointerEvent) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      pointers.set(e.pointerId, local(e.clientX, e.clientY));
      if (pointers.size > maxPointers) maxPointers = pointers.size;
      try {
        host.setPointerCapture(e.pointerId);
      } catch {
        // A pointer that is already gone throws; the gesture still works without it.
      }
      if (pointers.size === 1) {
        startClientX = lastClientX = e.clientX;
        startClientY = lastClientY = e.clientY;
        startTime = performance.now();
        pinchRef.current = null;
        // A press, not a move: the same press is how a tap starts, and a hand
        // that only closes once the board has already moved is a hand that
        // arrives late. Released below, when the last pointer leaves.
        latest.current.onPanChange?.(true);
      } else if (pointers.size === 2) {
        beginPinch();
      }
    };

    const onPointerMove = (e: PointerEvent) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, local(e.clientX, e.clientY));

      const pinch = pinchRef.current;
      if (pinch && pointers.size >= 2) {
        const a = pointers.get(pinch.ids[0]);
        const b = pointers.get(pinch.ids[1]);
        if (!a || !b) return;
        const distance = Math.max(1, Math.hypot(b.x - a.x, b.y - a.y));
        // The anchor is the camera the pinch BEGAN with: `zoomCameraAt` applies
        // its factor to the zoom it is handed, so feeding it the live one would
        // compound the ratio on every move.
        const settled = zoomCameraAt(pinch.camera, pinch.midX, pinch.midY, distance / pinch.distance);
        commit({
          zoom: settled.zoom,
          pan: {
            x: settled.pan.x + ((a.x + b.x) / 2 - pinch.midX),
            y: settled.pan.y + ((a.y + b.y) / 2 - pinch.midY)
          }
        });
        return;
      }

      if (pointers.size !== 1) return;
      const dx = e.clientX - lastClientX;
      const dy = e.clientY - lastClientY;
      if (dx === 0 && dy === 0) return;
      lastClientX = e.clientX;
      lastClientY = e.clientY;
      commit(panCamera(latest.current.camera, dx, dy));
    };

    const endPointer = (e: PointerEvent, cancelled: boolean) => {
      if (!pointers.delete(e.pointerId)) return;
      if (pointers.size >= 2) {
        beginPinch();
        return;
      }
      if (pointers.size === 1) {
        // Lifting one finger of a pinch continues as a pan from the survivor,
        // which has not moved since — so the next delta must be measured from it.
        pinchRef.current = null;
        const rect = host.getBoundingClientRect();
        const rest = [...pointers.values()][0];
        lastClientX = rest.x + rect.left;
        lastClientY = rest.y + rect.top;
        return;
      }

      pinchRef.current = null;
      latest.current.onPanChange?.(false);
      const isTap =
        !cancelled &&
        maxPointers === 1 &&
        Math.hypot(e.clientX - startClientX, e.clientY - startClientY) <= TAP_SLOP_PX &&
        performance.now() - startTime <= TAP_MAX_MS;
      maxPointers = 0;
      if (!isTap) return;

      if (latest.current.onTap(e.clientX, e.clientY)) {
        lastTapRef.current = null;
        return;
      }
      const now = performance.now();
      const last = lastTapRef.current;
      if (
        last &&
        now - last.time <= DOUBLE_TAP_MS &&
        Math.hypot(e.clientX - last.x, e.clientY - last.y) <= DOUBLE_TAP_SLOP_PX
      ) {
        lastTapRef.current = null;
        latest.current.onDoubleTap(e.clientX, e.clientY);
        return;
      }
      lastTapRef.current = { time: now, x: e.clientX, y: e.clientY };
    };

    const onPointerUp = (e: PointerEvent) => endPointer(e, false);
    const onPointerCancel = (e: PointerEvent) => endPointer(e, true);

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const camera = latest.current.camera;
      if (e.ctrlKey || e.metaKey) {
        const point = local(e.clientX, e.clientY);
        commit(zoomCameraAt(camera, point.x, point.y, wheelZoomFactor(e.deltaY, e.deltaMode)));
        return;
      }
      if (latest.current.onWheel?.(e)) return;
      commit(panCamera(camera, -e.deltaX, -e.deltaY));
    };

    const onContextMenu = (e: Event) => e.preventDefault();

    host.addEventListener("pointerdown", onPointerDown);
    host.addEventListener("pointermove", onPointerMove);
    host.addEventListener("pointerup", onPointerUp);
    host.addEventListener("pointercancel", onPointerCancel);
    host.addEventListener("wheel", onWheel, { passive: false });
    host.addEventListener("contextmenu", onContextMenu);
    return () => {
      host.removeEventListener("pointerdown", onPointerDown);
      host.removeEventListener("pointermove", onPointerMove);
      host.removeEventListener("pointerup", onPointerUp);
      host.removeEventListener("pointercancel", onPointerCancel);
      host.removeEventListener("wheel", onWheel);
      host.removeEventListener("contextmenu", onContextMenu);
    };
  }, []);
}
