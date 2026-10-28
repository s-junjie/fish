import type { ComponentChildren } from "preact";
import { useRef } from "../_host";

export function ChevronDownGlyph({ size = 12, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

export function ApertureGlyph({ size = 18, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" />
      <line x1="14.31" y1="8" x2="20.05" y2="17.94" />
      <line x1="9.69" y1="8" x2="21.17" y2="8" />
      <line x1="7.38" y1="12" x2="13.12" y2="2.06" />
      <line x1="9.69" y1="16" x2="3.95" y2="6.06" />
      <line x1="14.31" y1="16" x2="2.83" y2="16" />
      <line x1="16.62" y1="12" x2="10.88" y2="21.94" />
    </svg>
  );
}

export function TransparentGlyph({ size = 13, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      className={className}
      aria-hidden="true"
    >
      <rect x="2" y="2" width="12" height="12" rx="1.5" stroke="currentColor" strokeWidth="1.25" />
      <rect x="2.5" y="2.5" width="5.5" height="5.5" fill="currentColor" opacity="0.85" />
      <rect x="8" y="8" width="5.5" height="5.5" fill="currentColor" opacity="0.85" />
    </svg>
  );
}

export function SectionHeader({ title }: { title: string }) {
  return (
    <div className="flex items-center gap-2 pt-2.5 pb-1">
      <span className="text-micro font-semibold uppercase tracking-[0.18em] text-ink-muted">
        {title}
      </span>
      <div className="flex-1 h-px bg-rule" />
    </div>
  );
}

export interface SelectFieldProps {
  value: string;
  onChange: (val: string) => void;
  children: ComponentChildren;
  className?: string;
}

export function SelectField({ value, onChange, children, className = "" }: SelectFieldProps) {
  return (
    <div className={`relative inline-flex items-center w-full ${className}`}>
      <select
        value={value}
        onChange={(e) => onChange((e.target as HTMLSelectElement).value)}
        className="w-full appearance-none h-[25px] bg-inset rounded-swatch pl-2 pr-6 text-row text-ink focus:outline-none cursor-default transition-colors duration-micro ease-snap disabled:opacity-50 truncate"
      >
        {children}
      </select>
      <ChevronDownGlyph size={12} className="absolute right-1.5 pointer-events-none text-ink-dim" />
    </div>
  );
}

export interface InstrumentSliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  formatValue?: (val: number) => string;
  onChange: (val: number) => void;
}

/**
 * Standard FISH drafting-instrument slider conforming to DESIGN.md:
 * 6px inset well, amber fill, 11px square ink chip knob.
 */
export function InstrumentSlider({
  label,
  value,
  min,
  max,
  step = 1,
  unit = "",
  formatValue,
  onChange
}: InstrumentSliderProps) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const dragging = useRef(false);

  const computeValue = (clientX: number) => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return value;
    const pct = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    const raw = min + pct * (max - min);
    const stepped = Math.round(raw / step) * step;
    return Math.min(max, Math.max(min, Number(stepped.toFixed(2))));
  };

  const clampedVal = Math.min(max, Math.max(min, value));
  const pct = ((clampedVal - min) / (max - min)) * 100;
  const display = formatValue ? formatValue(value) : `${value}${unit}`;

  return (
    <div className="flex items-center justify-between h-[25px]">
      <span className="text-meta text-ink-dim w-20 flex-none">{label}</span>
      <div className="flex items-center gap-2 flex-1 pl-2">
        <div
          ref={trackRef}
          className="relative flex-1 h-3 flex items-center cursor-ew-resize touch-none select-none"
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            dragging.current = true;
            (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
            onChange(computeValue(e.clientX));
          }}
          onPointerMove={(e) => {
            if (!dragging.current) return;
            onChange(computeValue(e.clientX));
          }}
          onPointerUp={(e) => {
            if (!dragging.current) return;
            dragging.current = false;
            try {
              (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
            } catch {}
          }}
        >
          {/* Well Track */}
          <div className="relative w-full h-1.5 rounded-[1px] bg-inset overflow-hidden">
            {/* Amber Fill */}
            <div
              className="absolute inset-y-0 left-0 bg-brand rounded-[1px]"
              style={{ width: `${pct}%` }}
            />
          </div>
          {/* 11px Square Knob (conforms to DESIGN.md Instrument Amber) */}
          <div
            className="absolute top-1/2 w-[11px] h-[11px] -mt-[5.5px] -ml-[5.5px] rounded-[1px] bg-ink shadow-[0_1px_3px_rgba(0,0,0,0.6)] pointer-events-none"
            style={{ left: `${pct}%` }}
          />
        </div>
        <span className="text-row tabular-nums font-mono text-ink w-10 text-right flex-none">
          {display}
        </span>
      </div>
    </div>
  );
}
