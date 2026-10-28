import { useLayoutEffect, useRef, useState } from "preact/hooks";
import { createPortal } from "preact/compat";
import type { ComponentChildren } from "preact";
import { placeCommentPopover, type PinPoint } from "../../core/comments/placement";

export interface CommentPortalProps {
  /** Where the pin is, in WINDOW coordinates. */
  anchor: PinPoint;
  width: number;
  children: ComponentChildren;
}

/** Sub-pixel noise must not re-place (or re-render) the card. */
function samePx(a: number, b: number): boolean {
  return Math.abs(a - b) < 0.5;
}

interface DragState {
  startX: number;
  startY: number;
  offsetX: number;
  offsetY: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * A comment card that is not clipped by the canvas, and that the user can move.
 *
 * The canvas root carries `contain: layout paint`, which both clips its
 * descendants and makes it a stacking context — so a card drawn inside it can
 * never rise above the `z-20` rails, and half of it disappears past an edge.
 * Measured: the Send button of a comment near the right rail was covered by the
 * inspector, and the press landed on the inspector's scroller. A portal to
 * `<body>` plus a clamped `position: fixed` is the whole fix.
 *
 * Dragging is expressed as an offset from that placed position, not as an
 * absolute one: the card keeps its anchor-derived spot when the canvas pans,
 * until the user moves it, and after that the offset carries it along. A card
 * that snapped back to the pin mid-conversation would undo the reason it was
 * moved — reading two comments side by side.
 */
export function CommentPortal({ anchor, width, children }: CommentPortalProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width, height: 0 });
  const [viewport, setViewport] = useState(() => ({
    width: typeof window === "undefined" ? 0 : window.innerWidth,
    height: typeof window === "undefined" ? 0 : window.innerHeight
  }));
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const dragRef = useRef<DragState | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const rect = el.getBoundingClientRect();
      setSize((prev) =>
        samePx(prev.height, rect.height) && samePx(prev.width, rect.width)
          ? prev
          : { width: rect.width, height: rect.height }
      );
    };
    measure();
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    if (observer) observer.observe(el);
    const onResize = () =>
      setViewport({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", onResize);
    };
  }, []);

  const base = placeCommentPopover(anchor, { width, height: size.height }, viewport);

  const onPointerDown = (e: PointerEvent) => {
    const target = e.target as HTMLElement | null;
    if (!target?.closest("[data-comment-drag-handle]")) return;
    // A press on the drag handle must not reach the canvas underneath, and must
    // not blur the textarea the user is typing in.
    e.preventDefault();
    e.stopPropagation();
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      offsetX: offset.x,
      offsetY: offset.y
    };

    const onMove = (move: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      // Clamped against the window, not against the anchor: a window dragged off
      // the screen cannot be dragged back.
      const minX = 8 - base.left;
      const maxX = Math.max(minX, viewport.width - width - 8 - base.left);
      const minY = 8 - base.top;
      const maxY = Math.max(minY, viewport.height - size.height - 8 - base.top);
      setOffset({
        x: clamp(drag.offsetX + (move.clientX - drag.startX), minX, maxX),
        y: clamp(drag.offsetY + (move.clientY - drag.startY), minY, maxY)
      });
    };
    const onUp = () => {
      dragRef.current = null;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const left = base.left + offset.x;
  const top = base.top + offset.y;

  return createPortal(
    <div
      ref={ref}
      data-ui-layer="comment-portal"
      onPointerDown={onPointerDown}
      style={{
        position: "fixed",
        left: `${left}px`,
        top: `${top}px`,
        width: `${width}px`,
        zIndex: 45,
        // Hidden only for the one frame before the height is known: placing a
        // card at a fallback height puts it at the wrong `top` and it jumps.
        visibility: size.height > 0 ? "visible" : "hidden"
      }}
      className="pointer-events-auto animate-pop-in origin-top-left"
    >
      {children}
    </div>,
    document.body
  );
}
