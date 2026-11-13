import { useEffect, useRef, useState } from "preact/hooks";
import { createPortal } from "preact/compat";
import type { ComponentChildren } from "preact";
import { X } from "lucide-react";
import { t } from "../i18n";
import type { PluginResizeMode } from "../core/plugins/plugin-contract";
import {
  clampWindowPosition,
  clampWindowSize,
  resizeWindowRect,
  type ResizeDirection,
  type WindowRect,
  type WindowViewport
} from "./floating-window-geometry";

export interface FloatingWindowProps {
  title: string;
  icon?: ComponentChildren;
  onClose: () => void;
  children: ComponentChildren;
  initialX?: number;
  initialY?: number;
  width?: number;
  height?: number;
  minWidth?: number;
  minHeight?: number;
  resize?: PluginResizeMode;
  zIndexClass?: string;
}

function getViewport(): WindowViewport {
  if (typeof window === "undefined") return { width: 1280, height: 800 };
  return { width: window.innerWidth, height: window.innerHeight };
}

/**
 * Shared draggable & resizable workbench floating window.
 *
 * Stacking: docks/rails (20) < toolbars/notices (40) < plugin windows (45) <
 * tokens table (46) < titlebar & context/popover menus (50) < inspector panels
 * (60) < pickers (70-90) < presenting (100).
 *
 * Portaled to `document.body` so windows opened from inside docked rails (e.g.
 * TokensTablePanel inside the z-20 inspector) share the exact same root stacking
 * layer as plugin windows, always below ContextMenu and TitleBar.
 */
export function FloatingWindow({
  title,
  icon,
  onClose,
  children,
  initialX = 120,
  initialY = 80,
  width = 340,
  height,
  minWidth = 280,
  minHeight = 240,
  resize = "none",
  zIndexClass = "z-[45]"
}: FloatingWindowProps) {
  const hasExplicitHeight = Boolean(height !== undefined || resize === "vertical" || resize === "both");
  const targetWidth = width || 340;
  const targetHeight = height || 480;

  const [size, setSize] = useState(() =>
    clampWindowSize({ width: targetWidth, height: targetHeight }, getViewport(), { minWidth, minHeight })
  );
  const [pos, setPos] = useState(() =>
    clampWindowPosition(
      { x: initialX, y: initialY },
      { width: size.width, height: hasExplicitHeight ? size.height : undefined },
      getViewport(),
      { fitHeight: hasExplicitHeight }
    )
  );

  const posRef = useRef(pos);
  posRef.current = pos;
  const sizeRef = useRef(size);
  sizeRef.current = size;
  const boundsRef = useRef({ minWidth, minHeight });
  boundsRef.current = { minWidth, minHeight };

  useEffect(() => {
    const nextSize = clampWindowSize(
      { width: targetWidth, height: targetHeight },
      getViewport(),
      { minWidth, minHeight }
    );
    setSize(nextSize);
    setPos((prev) =>
      clampWindowPosition(
        prev,
        { width: nextSize.width, height: hasExplicitHeight ? nextSize.height : undefined },
        getViewport(),
        { fitHeight: hasExplicitHeight }
      )
    );
  }, [targetWidth, targetHeight, minWidth, minHeight, hasExplicitHeight]);

  const isDraggingRef = useRef(false);
  const dragStartRef = useRef({ mouseX: 0, mouseY: 0, startX: 0, startY: 0 });

  const isResizingRef = useRef(false);
  const resizeStartRef = useRef<{
    mouseX: number;
    mouseY: number;
    direction: ResizeDirection;
    startRect: WindowRect;
  }>({
    mouseX: 0,
    mouseY: 0,
    direction: "se",
    startRect: { x: 0, y: 0, width: 0, height: 0 }
  });

  useEffect(() => {
    const onPointerMove = (e: PointerEvent) => {
      if (isDraggingRef.current) {
        const dx = e.clientX - dragStartRef.current.mouseX;
        const dy = e.clientY - dragStartRef.current.mouseY;
        setPos(
          clampWindowPosition(
            {
              x: dragStartRef.current.startX + dx,
              y: dragStartRef.current.startY + dy
            },
            sizeRef.current,
            getViewport()
          )
        );
      } else if (isResizingRef.current) {
        const dx = e.clientX - resizeStartRef.current.mouseX;
        const dy = e.clientY - resizeStartRef.current.mouseY;
        const nextRect = resizeWindowRect(
          resizeStartRef.current.startRect,
          { dx, dy },
          resizeStartRef.current.direction,
          getViewport(),
          boundsRef.current
        );
        setPos({ x: nextRect.x, y: nextRect.y });
        setSize({ width: nextRect.width, height: nextRect.height });
      }
    };

    const endGesture = () => {
      isDraggingRef.current = false;
      isResizingRef.current = false;
    };

    const onWindowResize = () => {
      setPos((prev) => clampWindowPosition(prev, sizeRef.current, getViewport()));
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", endGesture);
    window.addEventListener("pointercancel", endGesture);
    window.addEventListener("resize", onWindowResize);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", endGesture);
      window.removeEventListener("pointercancel", endGesture);
      window.removeEventListener("resize", onWindowResize);
    };
  }, []);

  const handleHeaderPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest("button, input, select, a, [data-no-drag]")) return;
    e.preventDefault();
    isDraggingRef.current = true;
    dragStartRef.current = {
      mouseX: e.clientX,
      mouseY: e.clientY,
      startX: posRef.current.x,
      startY: posRef.current.y
    };
  };

  const handleResizePointerDown = (e: PointerEvent, direction: ResizeDirection) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    isResizingRef.current = true;
    resizeStartRef.current = {
      mouseX: e.clientX,
      mouseY: e.clientY,
      direction,
      startRect: {
        x: posRef.current.x,
        y: posRef.current.y,
        width: sizeRef.current.width,
        height: sizeRef.current.height
      }
    };
  };

  const canResizeH = resize === "horizontal" || resize === "both";
  const canResizeV = resize === "vertical" || resize === "both";
  const canResizeCorners = resize === "both";

  return createPortal(
    <div
      data-floating-window="true"
      style={{
        left: `${pos.x}px`,
        top: `${pos.y}px`,
        width: `${size.width}px`,
        height: hasExplicitHeight ? `${size.height}px` : undefined
      }}
      className={`fixed ${zIndexClass} bg-panel border border-rule-strong shadow-popover rounded-panel flex flex-col overflow-hidden font-sans select-none animate-pop-in`}
    >
      {/* Header with drag handle */}
      <div
        data-floating-window-header="true"
        onPointerDown={handleHeaderPointerDown}
        className="flex items-center justify-between px-3 h-10 border-b border-rule cursor-move bg-surface text-ink font-sans flex-none gap-2"
      >
        <div className="flex items-center gap-2 min-w-0">
          {icon}
          <span className="text-ui font-medium truncate">{title}</span>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="flex items-center justify-center w-6 h-6 rounded-ctl text-ink-dim hover:text-ink hover:bg-raised transition-colors shrink-0"
          title={t("common.close")}
          aria-label={t("common.close")}
        >
          <X size={13} />
        </button>
      </div>

      {/* Isolate internal sticky/content z-indexes from the window resize chrome */}
      <div className="flex-1 flex flex-col min-h-0 overflow-hidden relative z-0">
        {children}
      </div>

      {/* Vertical edges */}
      {canResizeV && (
        <>
          <div
            data-resize-edge="n"
            onPointerDown={(e) => handleResizePointerDown(e, "n")}
            className={`absolute top-0 ${canResizeCorners ? "left-2.5 right-2.5" : "inset-x-0"} h-1.5 cursor-ns-resize z-20`}
            aria-hidden="true"
          />
          {canResizeCorners ? (
            <div
              data-resize-edge="s"
              onPointerDown={(e) => handleResizePointerDown(e, "s")}
              className="absolute bottom-0 left-2.5 right-3.5 h-1.5 cursor-ns-resize z-20"
              aria-hidden="true"
            />
          ) : (
            <div
              data-resize-edge="s"
              onPointerDown={(e) => handleResizePointerDown(e, "s")}
              className="absolute bottom-0 inset-x-0 h-2.5 cursor-ns-resize z-20 flex items-center justify-center group"
              aria-hidden="true"
            >
              <div className="w-8 h-1 rounded-full bg-rule-strong group-hover:bg-ink-dim transition-colors" />
            </div>
          )}
        </>
      )}

      {/* Horizontal edges */}
      {canResizeH && (
        <>
          <div
            data-resize-edge="w"
            onPointerDown={(e) => handleResizePointerDown(e, "w")}
            className={`absolute left-0 ${canResizeCorners ? "top-2.5 bottom-2.5" : "inset-y-0"} w-1.5 cursor-ew-resize z-20`}
            aria-hidden="true"
          />
          <div
            data-resize-edge="e"
            onPointerDown={(e) => handleResizePointerDown(e, "e")}
            className={`absolute right-0 ${canResizeCorners ? "top-2.5 bottom-3.5" : "inset-y-0"} w-1.5 cursor-ew-resize z-20`}
            aria-hidden="true"
          />
        </>
      )}

      {/* Corners */}
      {canResizeCorners && (
        <>
          <div
            data-resize-edge="nw"
            onPointerDown={(e) => handleResizePointerDown(e, "nw")}
            className="absolute top-0 left-0 w-2.5 h-2.5 cursor-nwse-resize z-30"
            aria-hidden="true"
          />
          <div
            data-resize-edge="ne"
            onPointerDown={(e) => handleResizePointerDown(e, "ne")}
            className="absolute top-0 right-0 w-2.5 h-2.5 cursor-nesw-resize z-30"
            aria-hidden="true"
          />
          <div
            data-resize-edge="sw"
            onPointerDown={(e) => handleResizePointerDown(e, "sw")}
            className="absolute bottom-0 left-0 w-2.5 h-2.5 cursor-nesw-resize z-30"
            aria-hidden="true"
          />
          <div
            data-resize-edge="se"
            onPointerDown={(e) => handleResizePointerDown(e, "se")}
            className="absolute bottom-0 right-0 w-3.5 h-3.5 cursor-nwse-resize z-30 flex items-end justify-end p-0.5 select-none text-ink-muted/50 hover:text-ink transition-colors"
            aria-hidden="true"
          >
            <svg width="7" height="7" viewBox="0 0 7 7" fill="none" className="pointer-events-none">
              <path
                d="M6 1L1 6M6 3.5L3.5 6M6 6H6.01"
                stroke="currentColor"
                strokeWidth="1.2"
                strokeLinecap="round"
              />
            </svg>
          </div>
        </>
      )}
    </div>,
    document.body
  );
}
