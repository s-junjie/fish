import { MorphPair } from "../../core/presentation/morph";
import { CANVAS_GUIDE, CANVAS_SELECT } from "./canvas-colors";

interface MorphPairOverlayProps {
  pairs: MorphPair[];
  /** World position of the outgoing slide, added to its own layers' local boxes. */
  fromOrigin: { x: number; y: number };
  toOrigin: { x: number; y: number };
  zoom: number;
  /** The pair hovered in the inspector's list. */
  highlightId?: string | null;
}

/**
 * The lines between what a layer was and what it becomes.
 *
 * They are drawn in `CANVAS_GUIDE` — the same grey as a gradient handle's
 * dashed guides, because that is what they are: a guide, not an object, and
 * never a fourth accent. A highlighted pair goes to `CANVAS_SELECT`, the
 * selection blue, because the moment the pointer is on its row the pair IS the
 * thing chosen.
 *
 * This is the one thing about morph that FISH can show and Keynote cannot: a
 * deck is several artboards on one canvas, so the two halves of a pair sit in
 * the same space at the same time and the pairing is a fact you can look at
 * rather than a guess you have to play to find out about.
 */
export function MorphPairOverlay({
  pairs,
  fromOrigin,
  toOrigin,
  zoom,
  highlightId
}: MorphPairOverlayProps) {
  if (pairs.length === 0) return null;

  return (
    <g data-morph-pairs="true" className="pointer-events-none select-none">
      {pairs.map((pair) => {
        const highlighted = highlightId != null && (pair.fromId === highlightId || pair.toId === highlightId);
        const stroke = highlighted ? CANVAS_SELECT : CANVAS_GUIDE;
        const width = (highlighted ? 1.5 : 1) / zoom;
        const cap = (highlighted ? 4 : 3) / zoom;

        const x1 = fromOrigin.x + pair.from.x + pair.from.width / 2;
        const y1 = fromOrigin.y + pair.from.y + pair.from.height / 2;
        const x2 = toOrigin.x + pair.to.x + pair.to.width / 2;
        const y2 = toOrigin.y + pair.to.y + pair.to.height / 2;

        return (
          <g key={`${pair.fromId}->${pair.toId}`}>
            <line
              x1={x1}
              y1={y1}
              x2={x2}
              y2={y2}
              stroke={stroke}
              strokeWidth={width}
              strokeDasharray={`${4 / zoom} ${3 / zoom}`}
            />
            <rect x={x1 - cap / 2} y={y1 - cap / 2} width={cap} height={cap} fill={stroke} />
            <rect x={x2 - cap / 2} y={y2 - cap / 2} width={cap} height={cap} fill={stroke} />
          </g>
        );
      })}
    </g>
  );
}
