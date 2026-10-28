import { createPortal } from "preact/compat";
import { PAINT_SWATCH_CHECKER } from "./inspector/paint-row-style";

interface PaintDragGhostProps {
  x: number;
  y: number;
  width: number;
  swatch: string;
  label: string;
  /** Paint rows show a hex, which reads as code; named rows (styles) must not. */
  mono?: boolean;
}

/** Floating row replica that follows the pointer during paint-stack reorder. */
export function PaintDragGhost({ x, y, width, swatch, label, mono = true }: PaintDragGhostProps) {
  return createPortal(
    <div
      className="fixed z-50 pointer-events-none"
      style={{ left: x, top: y, width, transform: "translate(-4px, -14px)" }}
    >
      <div className="flex items-center gap-1.5 bg-surface border border-paint-row-rule-open rounded-ctl px-1.5 py-1 shadow-popover opacity-90">
        <div
          className="relative w-5 h-5 rounded-ctl border border-rule-strong overflow-hidden shrink-0"
          style={PAINT_SWATCH_CHECKER}
        >
          <div className="absolute inset-0" style={{ background: swatch }} />
        </div>
        <span
          className={`flex-1 min-w-0 text-meta text-ink truncate ${mono ? "uppercase" : ""}`}
        >
          {label}
        </span>
      </div>
    </div>,
    document.body
  );
}
