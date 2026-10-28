import { createPortal } from "preact/compat";

/** How deep the stack behind the dragged row may get, however big the selection. */
const MAX_DEPTH = 3;
/** Diagonal step of one card, which is what reads as "more behind this". */
const CARD_STEP = 5;

interface LayerDragGhostProps {
  /** Rows behind the dragged row's own image, already capped. */
  depth: number;
  /** Where the dragged row's own image is anchored. */
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The stack behind a layer row's drag image.
 *
 * The browser's own drag image is a snapshot of the row the pointer went down
 * on, which is exactly why a three-row selection used to announce itself as one
 * layer. That image cannot be replaced — it is the only thing that follows the
 * pointer without the app drawing its own ghost — so the count is carried by
 * cards BEHIND it: the same card shape, stepped down and right, blank, which is
 * how a stack of objects reads at a glance.
 *
 * Blank on purpose: the front card is the real row, with its name, and a name
 * repeated down a stack is noise at drag speed.
 */
export function LayerDragGhost({ depth, x, y, width, height }: LayerDragGhostProps) {
  if (depth <= 0) return null;

  return createPortal(
    <div data-layer-drag-stack="true" data-layer-drag-stack-depth={depth} className="fixed z-50 pointer-events-none" style={{ left: x, top: y }}>
      {/* Back to front, so the card nearest the pointer is painted last. */}
      {Array.from({ length: depth }, (_, i) => depth - i).map((step) => (
        <div
          key={step}
          data-layer-drag-card="true"
          /* `raised` + `rule-strong`, not the quieter pair: only a 5px sliver of
             each card is ever visible behind the image in front of it, and on
             `panel` a `surface` card with a `rule` edge was there and gone. */
          className="absolute left-0 top-0 bg-raised border border-rule-strong rounded-ctl"
          style={{
            width,
            height,
            transform: `translate(${step * CARD_STEP}px, ${step * CARD_STEP}px)`
          }}
        />
      ))}
    </div>,
    document.body
  );
}

/** How many cards a selection of this size gets behind its own image. */
export function stackDepthFor(rowCount: number): number {
  return Math.min(Math.max(rowCount - 1, 0), MAX_DEPTH);
}
