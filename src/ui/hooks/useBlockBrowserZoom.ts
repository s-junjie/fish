import { useEffect } from "preact/hooks";

/**
 * Stops a trackpad pinch from zooming the whole application.
 *
 * The canvas owns the wheel already, so a pinch there is the canvas zoom. The side
 * panels have no wheel handler of their own, which leaves the browser's own
 * page-zoom as the default action — and page zoom scales the panels, the toolbars
 * and the canvas together, so a pinch aimed at a layer list resizes the entire UI.
 * There is nothing sensible to zoom into a panel, so the gesture is swallowed
 * document-wide.
 *
 * `ctrlKey` is what the browser synthesises for a two-finger pinch, and a real
 * Ctrl+wheel means the same thing to the user. A two-finger scroll arrives without
 * it and is left alone, so panels still scroll.
 *
 * The listener is non-passive because `preventDefault` is ignored on a passive
 * wheel listener, and it is registered on `document` rather than on a panel: a
 * gesture that starts on a row and drags off it still has to be ours.
 */
export function useBlockBrowserZoom() {
  useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) e.preventDefault();
    };
    document.addEventListener("wheel", onWheel, { passive: false });
    return () => document.removeEventListener("wheel", onWheel);
  }, []);
}
