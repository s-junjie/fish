import type { ComponentChildren } from "preact";

const DIAMOND_PATHS = [
  "M12 1 16.5 5.5 12 10 7.5 5.5Z",
  "M1 12 5.5 7.5 10 12 5.5 16.5Z",
  "M14 12 18.5 7.5 23 12 18.5 16.5Z",
  "M12 14 16.5 18.5 12 23 7.5 18.5Z"
] as const;

interface MarkProps {
  /** Edge length of the square box the mark is drawn in. */
  size?: number;
  className?: string;
  /** Placement, for the canvas: the mark sits in a counter-scaled group whose
   *  coordinates are screen pixels, so x/y are plain attributes rather than the
   *  zoom arithmetic they used to carry. */
  x?: number;
  y?: number;
}

function Mark({ size, className, x, y, children }: MarkProps & { children: ComponentChildren }) {
  return (
    <svg width={size} height={size} x={x} y={y} viewBox="0 0 14 14" fill="none" className={className}>
      {children}
    </svg>
  );
}

function FilledDiamonds({ size, className }: MarkProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className}>
      {DIAMOND_PATHS.map((d) => (
        <path key={d} d={d} fill="currentColor" />
      ))}
    </svg>
  );
}

export function ComponentMark({ size = 13, className = "", x, y }: MarkProps) {
  return (
    <g transform={x === undefined && y === undefined ? undefined : `translate(${x ?? 0}, ${y ?? 0})`}>
      <FilledDiamonds size={size} className={className} />
    </g>
  );
}

export function VariantSetMark({ size = 13, className = "", x, y }: MarkProps) {
  return (
    <g transform={x === undefined && y === undefined ? undefined : `translate(${x ?? 0}, ${y ?? 0})`}>
      <FilledDiamonds size={size} className={className} />
    </g>
  );
}

/** A single variant member inside a set — the solid twin of InstanceMark. */
export function VariantMark({ size = 13, className = "", x, y }: MarkProps) {
  return (
    <g transform={x === undefined && y === undefined ? undefined : `translate(${x ?? 0}, ${y ?? 0})`}>
      <Mark size={size} className={className}>
        <path d="M7 2 12 7 7 12 2 7Z" fill="currentColor" />
      </Mark>
    </g>
  );
}

/** The hollow twin of the component mark — filled vs hollow IS the distinction,
 *  so it has to be drawn to the same 14px box to read as one family. */
export function InstanceMark({ size = 13, className = "" }: MarkProps) {
  return (
    <Mark size={size} className={className}>
      <path d="M7 2 12 7 7 12 2 7Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </Mark>
  );
}
