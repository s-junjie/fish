import { MARK, MARK_CELLS } from "./fish-mark";

interface FishLogoProps {
  /** Size in pixels (width and height). Defaults to 18. */
  size?: number;
  className?: string;
  /** Whether to force LOD single dot mode (default: true when size <= 16). */
  lod?: boolean;
  /** Whether the mark is highlighted (e.g. when an update is detected). */
  highlight?: boolean;
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
/** Clockwise perimeter marquee order for the 3×3 cells:
 * 0(TL) → 1(TC) → 2(TR) → 3(MR) → 4(BR) → 5(BC) → 6(BL) → 7(ML)
 * -1 is the center cell.
 */
const MARQUEE_STEPS = [0, 1, 2, 7, -1, 3, 6, 5, 4] as const;

export function FishLogo({ size = 18, className = "", lod, highlight }: FishLogoProps) {
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
        className={`${className} ${highlight ? "drop-shadow-[0_0_6px_rgba(232,163,61,0.7)]" : ""}`}
      >
        <rect
          x={5.4}
          y={5.4}
          width={5.2}
          height={5.2}
          rx={5.2 / 18}
          className={`fill-brand ${highlight ? "animate-pulse" : ""}`}
        />
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
      {highlight && (
        <style>{`
          @keyframes fish-marquee {
            0%, 11% {
              fill: #e8a33d;
              opacity: 1;
              filter: drop-shadow(0 0 2px rgba(232, 163, 61, 0.85));
            }
            12.5%, 100% {
              fill: #ECF3F8;
              opacity: 0.9;
              filter: none;
            }
          }
          .fish-cell-marquee {
            animation: fish-marquee 5.6s infinite ease-in-out;
          }
        `}</style>
      )}

      {MARK_CELLS.map((cell, index) => {
        const step = MARQUEE_STEPS[index];
        const isCenter = cell.lit;

        if (highlight) {
          if (isCenter) {
            return (
              <rect
                key={`${cell.x}-${cell.y}`}
                x={cell.x}
                y={cell.y}
                width={MARK.cell}
                height={MARK.cell}
                rx={MARK.rx}
                className="fill-ink opacity-90"
              />
            );
          }
          const delayMs = -(8 - step) * 700;
          return (
            <rect
              key={`${cell.x}-${cell.y}`}
              x={cell.x}
              y={cell.y}
              width={MARK.cell}
              height={MARK.cell}
              rx={MARK.rx}
              className="fill-ink opacity-90 fish-cell-marquee"
              style={{ animationDelay: `${delayMs}ms` }}
            />
          );
        }

        return (
          <rect
            key={`${cell.x}-${cell.y}`}
            x={cell.x}
            y={cell.y}
            width={MARK.cell}
            height={MARK.cell}
            rx={MARK.rx}
            className={cell.lit ? "fill-brand" : "fill-ink opacity-90"}
          />
        );
      })}
    </svg>
  );
}
