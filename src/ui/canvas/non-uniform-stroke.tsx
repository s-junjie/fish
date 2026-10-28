import { cornerRadiiOf } from "../../core/geometry/shape-path";
import { ResolvedStrokeWeights, StrokeDashAttrs } from "../../core/geometry/stroke-utils";

/** The box a per-side stroke is drawn around, and the shape of its corners. */
export interface SideStrokeBox {
  width: number;
  height: number;
  /**
   * Corner radii in TL / TR / BR / BL order, already clamped to what fits the
   * box. Omit for a square-cornered box, which is the historical behaviour and
   * still the common case.
   */
  radii?: [number, number, number, number];
}

type Align = "inside" | "center" | "outside";

/**
 * A per-side border, drawn as one element per side plus one per rounded corner.
 *
 * The corners are the reason this is not four `<line>`s. A uniform stroke goes
 * down `shapeLocalD` — a path that already carries the corner arcs — so it
 * rounds. Four straight lines do not, which is what a per-side border looked
 * like on every rounded rectangle: the edge went around and the corner did not.
 *
 * Each corner here is an arc on the SAME centre as the shape's own corner arc,
 * with its radius moved by the WIDER side's align offset, so the band it paints
 * is exactly the offset curve the shape's corner would produce. Where the two
 * sides meeting at a corner differ there is no width that is both, so the corner
 * takes the larger: the arc rides that side's offset at that width and the
 * narrower edge butts into it — a step, not a blend.
 *
 * Inside and outside still lean on the caller's clip and mask, the same way the
 * uniform path does. A corner whose radius clamps to zero degenerates to a
 * straight diagonal across the boundary, and only the clip or mask keeps that
 * on the side it was asked for.
 *
 * A corner gets an arc only when BOTH sides meeting there are stroked and the
 * shape has a radius there — a single-sided border runs its edge to the corner
 * square, which is what Figma and CSS both draw. Where the two adjacent weights
 * differ there is no width that is both, so the arc takes the larger of the two.
 *
 * Dashes restart on every sub-path, edges and corners alike: that is inherent to
 * painting each piece separately, and it was already true per edge.
 */
export function renderNonUniformStroke(
  weights: ResolvedStrokeWeights,
  box: SideStrokeBox,
  strokeColor: string,
  strokeAlign: Align,
  strokeAttrs: StrokeDashAttrs,
  strokeOpacity: number,
  clipId?: string,
  maskId?: string,
  key?: any
) {
  const { top, right, bottom, left } = weights;
  if (top === 0 && right === 0 && bottom === 0 && left === 0) return null;

  const w = box.width;
  const h = box.height;
  const [tl, tr, br, bl] = cornerRadiiOf(box.radii, w, h);

  // How far the CENTRE of the band sits from the edge: in for inside, out for
  // outside, on it for centre. The whole band moves by this — line and arc
  // alike — so its inner edge stays on the shape boundary.
  const offset = (weight: number): number => (strokeAlign === "inside" ? weight / 2 : strokeAlign === "outside" ? -weight / 2 : 0);

  const offTop = offset(top);
  const offRight = offset(right);
  const offBottom = offset(bottom);
  const offLeft = offset(left);

  /** Does the corner at `r` between two stroked sides carry an arc? */
  const arcs = (r: number, a: number, b: number): boolean => r > 0 && a > 0 && b > 0;

  const tlArc = arcs(tl, top, left);
  const trArc = arcs(tr, top, right);
  const brArc = arcs(br, bottom, right);
  const blArc = arcs(bl, bottom, left);

  const pieces: any[] = [];

  const line = (k: string, x1: number, y1: number, x2: number, y2: number, weight: number) => {
    // Degenerate only when it has no direction at all — an edge is horizontal or
    // vertical by nature, so one zero delta is the normal case.
    if (x1 === x2 && y1 === y2) return;
    pieces.push(
      <line
        key={k}
        x1={round2(x1)}
        y1={round2(y1)}
        x2={round2(x2)}
        y2={round2(y2)}
        stroke={strokeColor}
        strokeWidth={weight}
        {...strokeAttrs}
      />
    );
  };

  /** One corner arc, on the shape's own centre, at the align offset radius. */
  const arc = (k: string, cx: number, cy: number, r: number, sweep: 0 | 1, from: [number, number], to: [number, number], weight: number) => {
    const rr = Math.max(0, r);
    pieces.push(
      <path
        key={k}
        d={`M ${round2(from[0])} ${round2(from[1])} A ${round2(rr)} ${round2(rr)} 0 0 ${sweep} ${round2(to[0])} ${round2(to[1])}`}
        fill="none"
        stroke={strokeColor}
        strokeWidth={weight}
        {...strokeAttrs}
      />
    );
  };

  if (top > 0) line("t", tlArc ? tl : 0, offTop, trArc ? w - tr : w, offTop, top);
  if (bottom > 0) line("b", blArc ? bl : 0, h - offBottom, brArc ? w - br : w, h - offBottom, bottom);
  if (left > 0) line("l", offLeft, tlArc ? tl : 0, offLeft, blArc ? h - bl : h, left);
  if (right > 0) line("r", w - offRight, trArc ? tr : 0, w - offRight, brArc ? h - br : h, right);

  // The corner band is the wider of its two sides, so its radius AND both
  // endpoints ride that side's offset. An endpoint left on the narrower side's
  // offset sits at a different distance from the corner centre than the radius
  // claims, and SVG then re-solves the circle through both points: an arc
  // centred off the corner, cutting across it instead of following it, which
  // the outside mask / inside clip chops into a wedge notch.
  const offTL = offset(Math.max(top, left));
  const offTR = offset(Math.max(top, right));
  const offBR = offset(Math.max(bottom, right));
  const offBL = offset(Math.max(bottom, left));

  if (tlArc) arc("c_tl", tl, tl, tl - offTL, 0, [tl, offTL], [offTL, tl], Math.max(top, left));
  if (trArc) arc("c_tr", w - tr, tr, tr - offTR, 1, [w - tr, offTR], [w - offTR, tr], Math.max(top, right));
  if (brArc) arc("c_br", w - br, h - br, br - offBR, 1, [w - offBR, h - br], [w - br, h - offBR], Math.max(bottom, right));
  if (blArc) arc("c_bl", bl, h - bl, bl - offBL, 0, [offBL, h - bl], [bl, h - offBL], Math.max(bottom, left));

  if (pieces.length === 0) return null;

  if (strokeAlign === "inside") {
    return (
      <g key={key} clipPath={clipId ? `url(#${clipId})` : undefined} opacity={strokeOpacity}>
        {pieces}
      </g>
    );
  }
  if (strokeAlign === "outside") {
    return (
      <g key={key} mask={maskId ? `url(#${maskId})` : undefined} opacity={strokeOpacity}>
        {pieces}
      </g>
    );
  }
  return (
    <g key={key} opacity={strokeOpacity}>
      {pieces}
    </g>
  );
}

const round2 = (n: number): number => Math.round(n * 100) / 100;