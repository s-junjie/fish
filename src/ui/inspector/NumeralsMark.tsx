const BAR_HEIGHT = 4;
const BAR_RADIUS = 0.7;
const ROW_TOP = 1.2;
const ROW_BOTTOM = 5.9;

/** Three digits, one advance each — the same three x positions in both rows. */
const TABULAR = [0.6, 4.4, 8.2].map((x) => ({ x, w: 2.6 }));

/**
 * Three digits whose widths differ per row, which is the whole of the effect: the
 * right edge of digit one and the left edge of digit three land in different
 * places in the two rows, and a reader sees the columns break.
 */
const PROPORTIONAL = [
  [
    { x: 0.6, w: 1.8 },
    { x: 3.6, w: 3.2 },
    { x: 8.0, w: 2.4 }
  ],
  [
    { x: 0.6, w: 2.8 },
    { x: 4.6, w: 2.0 },
    { x: 7.8, w: 3.0 }
  ]
];

export function NumeralsMark({ tabular }: { tabular: boolean }) {
  const rows = tabular ? [TABULAR, TABULAR] : PROPORTIONAL;
  return (
    <svg width={12} height={11} viewBox="0 0 12 11" aria-hidden="true" fill="currentColor">
      {rows.map((bars, row) =>
        bars.map((bar) => (
          <rect
            key={`${row}-${bar.x}`}
            x={bar.x}
            y={row === 0 ? ROW_TOP : ROW_BOTTOM}
            width={bar.w}
            height={BAR_HEIGHT}
            rx={BAR_RADIUS}
          />
        ))
      )}
    </svg>
  );
}
