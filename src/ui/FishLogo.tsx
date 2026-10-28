import { MARK, MARK_CELLS } from "./fish-mark";

interface FishLogoProps {
  /** Size in pixels (width and height). Defaults to 18. */
  size?: number;
  className?: string;
  /** Whether to force LOD single dot mode (default: true when size <= 16). */
  lod?: boolean;
}

/**
 * FISH brand mark: 3×3 grid of the brand's own cell — one square, corner at 1/18 of
 * its side, nine of them, the middle one lit. The same square is the i's dot in the
 * wordmark, so the mark and the tag are built from one shape. The geometry lives in
 * `fish-mark.ts`; this only decides colour and which cell is lit.
 *
 * In compact contexts (<= 16px) it reduces to the lit cell on its own (LOD) — the
 * same square, not a circle, so the mark never changes shape as it shrinks.
 */
export function FishLogo({ size = 18, className = "", lod }: FishLogoProps) {
  const isLod = lod ?? size <= 16;

  if (isLod) {
    // The lit cell, scaled to read at 16px rather than to the grid's proportions.
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 16 16"
        fill="none"
        aria-hidden="true"
        className={className}
      >
        <rect x={5.4} y={5.4} width={5.2} height={5.2} rx={5.2 / 18} className="fill-brand" />
      </svg>
    );
  }

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${MARK.box} ${MARK.box}`}
      fill="none"
      aria-hidden="true"
      className={className}
    >
      {MARK_CELLS.map((cell) => (
        <rect
          key={`${cell.x}-${cell.y}`}
          x={cell.x}
          y={cell.y}
          width={MARK.cell}
          height={MARK.cell}
          rx={MARK.rx}
          className={cell.lit ? "fill-brand" : "fill-ink opacity-90"}
        />
      ))}
    </svg>
  );
}
