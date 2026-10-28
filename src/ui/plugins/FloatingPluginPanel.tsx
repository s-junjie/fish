import { useState, useRef, useEffect } from "preact/hooks";
import type { ComponentChildren } from "preact";
import { X } from "lucide-react";
import { t } from "../../i18n";
import type { PluginResizeMode, PluginAttribution } from "../../core/plugins/plugin-contract";

interface FloatingPluginPanelProps {
  pluginId?: string;
  title: string;
  onClose: () => void;
  children: ComponentChildren;
  initialX?: number;
  initialY?: number;
  width?: number;
  height?: number;
  minWidth?: number;
  minHeight?: number;
  resize?: PluginResizeMode;
  attribution?: PluginAttribution | PluginAttribution[];
}

export function FloatingPluginPanel({
  pluginId,
  title,
  onClose,
  children,
  initialX = 120,
  initialY = 80,
  width = 340,
  height,
  minWidth = 280,
  minHeight = 240,
  resize = "none",
  attribution
}: FloatingPluginPanelProps) {
  const attributionList = attribution
    ? Array.isArray(attribution)
      ? attribution
      : [attribution]
    : [];

  const [pos, setPos] = useState({ x: initialX, y: initialY });
  const hasFixedOrResizableHeight = Boolean(height || resize === "vertical" || resize === "both");

  const [size, setSize] = useState({
    width: width || 340,
    height: height || 480
  });

  useEffect(() => {
    setSize({
      width: width || 340,
      height: height || 480
    });
  }, [width, height]);

  const posRef = useRef(pos);
  posRef.current = pos;
  const sizeRef = useRef(size);
  sizeRef.current = size;

  const isDraggingRef = useRef(false);
  const dragStartRef = useRef({ mouseX: 0, mouseY: 0, startX: 0, startY: 0 });

  const isResizingRef = useRef(false);
  const resizeModeRef = useRef<"both" | "width" | "height">("both");
  const resizeStartRef = useRef({ mouseX: 0, mouseY: 0, startW: 0, startH: 0 });

  useEffect(() => {
    const onPointerMove = (e: PointerEvent) => {
      if (isDraggingRef.current) {
        const dx = e.clientX - dragStartRef.current.mouseX;
        const dy = e.clientY - dragStartRef.current.mouseY;
        const curW = sizeRef.current.width;
        setPos({
          x: Math.max(10, Math.min(window.innerWidth - curW - 10, dragStartRef.current.startX + dx)),
          y: Math.max(10, Math.min(window.innerHeight - 80, dragStartRef.current.startY + dy))
        });
      } else if (isResizingRef.current) {
        const dx = e.clientX - resizeStartRef.current.mouseX;
        const dy = e.clientY - resizeStartRef.current.mouseY;
        const curX = posRef.current.x;
        const curY = posRef.current.y;
        const maxW = Math.max(minWidth, window.innerWidth - curX - 16);
        const maxH = Math.max(minHeight, window.innerHeight - curY - 16);

        const mode = resizeModeRef.current;
        const nextW = mode === "height"
          ? sizeRef.current.width
          : Math.max(minWidth, Math.min(maxW, resizeStartRef.current.startW + dx));
        const nextH = mode === "width"
          ? sizeRef.current.height
          : Math.max(minHeight, Math.min(maxH, resizeStartRef.current.startH + dy));

        setSize({ width: Math.round(nextW), height: Math.round(nextH) });
      }
    };

    const onPointerUp = () => {
      isDraggingRef.current = false;
      isResizingRef.current = false;
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };
  }, [minWidth, minHeight]);

  const handleHeaderPointerDown = (e: PointerEvent) => {
    if ((e.target as HTMLElement).closest("button")) return;
    isDraggingRef.current = true;
    dragStartRef.current = {
      mouseX: e.clientX,
      mouseY: e.clientY,
      startX: pos.x,
      startY: pos.y
    };
  };

  const handleResizePointerDown = (e: PointerEvent, mode: "both" | "width" | "height") => {
    e.stopPropagation();
    e.preventDefault();
    isResizingRef.current = true;
    resizeModeRef.current = mode;
    resizeStartRef.current = {
      mouseX: e.clientX,
      mouseY: e.clientY,
      startW: sizeRef.current.width,
      startH: sizeRef.current.height
    };
  };

  /**
   * Stacking, in the one order the shell uses: docks and rails (20) < toolbars
   * and notices (40) < **this panel (45)** < menus and popovers (50,60) <
   * pickers (70-90) < presenting (100).
   *
   * The panel is a window over the workspace, so it covers the toolbar it was
   * opened from — but never a menu. A right-click menu, an inspector popover, the
   * title bar's save menu and the Resources popover are all things the user
   * reaches for while a panel is open, and at 60 (the inspector's own floating
   * tier, settled by DOM order) it swallowed all of them.
   */
  return (
    <div
      style={{
        left: `${pos.x}px`,
        top: `${pos.y}px`,
        width: `${size.width}px`,
        height: hasFixedOrResizableHeight ? `${size.height}px` : undefined
      }}
      className="fixed z-[45] bg-panel border border-rule-strong shadow-popover rounded-panel flex flex-col overflow-hidden font-sans select-none animate-pop-in"
    >
      {/* Header with drag handle */}
      <div
        onPointerDown={handleHeaderPointerDown}
        className="flex items-center justify-between px-3 h-9 border-b border-rule cursor-move bg-surface text-ink font-sans text-ui font-medium flex-none"
      >
        <span className="truncate">{title}</span>
        <button
          type="button"
          onClick={onClose}
          className="flex items-center justify-center w-6 h-6 rounded-ctl text-ink-dim hover:text-ink hover:bg-raised transition-colors"
          title={t("common.close")}
          aria-label={t("common.close")}
        >
          <X size={13} />
        </button>
      </div>

      {/* Content */}
      <div
        data-fish-plugin={pluginId}
        className="flex-1 overflow-y-auto min-h-0 relative"
      >
        {children}
      </div>

      {/* Unified attribution footer */}
      {attributionList.length > 0 && (
        <div
          className={`px-3 py-1.5 border-t border-rule flex items-center justify-end gap-2 flex-none bg-surface/30 select-none ${
            resize === "both" ? "pr-5" : ""
          }`}
        >
          {attributionList.map((attr, idx) => (
            <span key={attr.url} className="inline-flex items-center gap-2">
              {idx > 0 && <span className="text-ink-muted/40 select-none">·</span>}
              <a
                href={attr.url}
                target="_blank"
                rel="noopener noreferrer"
                className="relative z-10 text-micro text-ink-muted hover:text-ink transition-colors"
              >
                {attr.name}
              </a>
            </span>
          ))}
        </div>
      )}

      {/* Vertical-only resize handle (e.g. icon explorer) */}
      {resize === "vertical" && (
        <div
          onPointerDown={(e) => handleResizePointerDown(e, "height")}
          className="absolute bottom-0 inset-x-0 h-2.5 cursor-ns-resize flex items-center justify-center group hover:bg-brand/10 transition-colors"
          aria-hidden="true"
        >
          <div className="w-8 h-1 rounded-full bg-rule-strong group-hover:bg-ink-dim transition-colors" />
        </div>
      )}

      {/* Both sides resize handles (e.g. openverse) */}
      {resize === "both" && (
        <>
          {/* Right edge */}
          <div
            onPointerDown={(e) => handleResizePointerDown(e, "width")}
            className="absolute top-9 bottom-3 right-0 w-1.5 cursor-ew-resize hover:bg-brand/20 transition-colors"
            aria-hidden="true"
          />
          {/* Bottom edge */}
          <div
            onPointerDown={(e) => handleResizePointerDown(e, "height")}
            className="absolute bottom-0 left-0 right-3 h-1.5 cursor-ns-resize hover:bg-brand/20 transition-colors"
            aria-hidden="true"
          />
          {/* Bottom-right corner */}
          <div
            onPointerDown={(e) => handleResizePointerDown(e, "both")}
            className="absolute bottom-0 right-0 w-3.5 h-3.5 cursor-nwse-resize flex items-end justify-end p-0.5 z-10 select-none text-ink-muted/50 hover:text-ink transition-colors"
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
    </div>
  );
}
