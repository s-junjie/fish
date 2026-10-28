import { PAINT_DROP_INDICATOR_CLASS } from "./paint-row-style";

interface PaintDropIndicatorProps {
  /** Whether the pending slot falls at this row's boundary at all. */
  active: boolean;
  /** The last row draws the line BELOW itself — the slot past every row. */
  isLast: boolean;
  testId?: string;
}

/**
 * The line that shows where a dragged row will land. A row owns two insertion
 * points, the gap above it and the gap below it, and only one is ever pending —
 * so the slot is compared once here rather than as two near-identical conditionals
 * at each of the three call sites.
 */
export function PaintDropIndicator({ active, isLast, testId = "paint-drop-indicator" }: PaintDropIndicatorProps) {
  if (!active) return null;
  return (
    <div
      data-testid={testId}
      className={`${PAINT_DROP_INDICATOR_CLASS} ${isLast ? "-bottom-[3px]" : "-top-[3px]"}`}
    />
  );
}
