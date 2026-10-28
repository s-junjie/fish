import { ComponentChildren } from "preact";
import { DesignElement, TearEffect, Paint } from "../../core/dsl/types";
import { edgeFor } from "../../core/geometry/edge";
import { hexToRgb, isValidHex } from "../../core/geometry/color-utils";
import { CANVAS_ON_SELECT, CANVAS_EDGE_PAPER, CANVAS_EDGE_SHADOW } from "./canvas-colors";

/**
 * A broken edge, drawn as stratified vector paper.
 *
 * One generated curve is used as the clip boundary and the seam, so the two
 * cannot drift apart. What sits along that seam is the profile's `finish`: the
 * torn break steps three opaque, terraced paper plies outward from warm stone to
 * bright ivory whenever its fibres are above zero; a scallop or zigzag leaves a
 * clean cut.
 *
 * Order matters twice over. The plies sit UNDER the clipped artwork, so the top
 * sheet cleanly overlaps their inner edge; and the clip is on the content group,
 * never on the group wearing the element's `filter`: SVG applies the filter
 * first and the clip after, so a clip on the same node as a drop shadow erases
 * the shadow entirely (measured, not assumed).
 *
 * A piece cut out of a sheet carries TWO breaks, so the clips NEST: each keeps
 * its own side, and the piece is what survives both.
 */

/** Mix two hex colours in sRGB. */
function mixHex(a: string, b: string, t: number): string {
  if (!isValidHex(a) || !isValidHex(b)) return a;
  const ca = hexToRgb(a);
  const cb = hexToRgb(b);
  const ch = (x: number, y: number) => Math.round(x + (y - x) * t);
  return `#${[ch(ca.r, cb.r), ch(ca.g, cb.g), ch(ca.b, cb.b)].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * The paper stock a break exposes.
 *
 * A printed photograph or gradient sits on paper stock (`CANVAS_EDGE_PAPER`),
 * even when the layer stack keeps a dark placeholder solid underneath the image.
 * A solid-coloured card tints its pulp slightly (14%) toward the surface dye
 * while staying high-value fibrous paper — never dark mud outside a light rim.
 */
function paperColor(fills: Paint[] | undefined): string {
  const active = (fills || []).filter((f) => f && f.enabled !== false);
  const top = active[active.length - 1];
  if (!top || top.type !== "solid") return CANVAS_EDGE_PAPER;
  return mixHex(CANVAS_EDGE_PAPER, top.color, 0.05);
}

/**
 * One clip per edge: the silhouette is the box with one side replaced by the
 * generated break — or, for a hole, the box with a closed break knocked out of
 * it. The knocked-out form is two subpaths in one `d`, so the fill rule has to
 * say which side of the contour is paper; `evenodd` is that rule, and it is what
 * makes the hole see-through rather than a painted patch.
 */
export function edgeClipDefs(el: DesignElement, edges: TearEffect[], w: number, h: number) {
  return edges.map((edge, i) => {
    const g = edgeFor(el.id, i, el.x, el.y, w, h, edge);
    return (
      <clipPath key={`edge_${el.id}_${i}`} id={`edge_${el.id}_${i}`} clipPathUnits="userSpaceOnUse">
        <path d={g.region} clipRule={edge.form === "hole" ? "evenodd" : undefined} />
      </clipPath>
    );
  });
}

interface ShellProps {
  el: DesignElement;
  edges: TearEffect[];
  w: number;
  h: number;
  fills?: Paint[];
  children: ComponentChildren;
}

export function EdgeShell({ el, edges, w, h, fills, children }: ShellProps) {
  const pulpBase = paperColor(fills);
  const ply1Fill = mixHex(pulpBase, CANVAS_ON_SELECT, 0.68);
  const ply2Fill = mixHex(pulpBase, CANVAS_EDGE_SHADOW, 0.05);
  const ply3Fill = mixHex(pulpBase, CANVAS_EDGE_SHADOW, 0.14);
  const ply1Stroke = mixHex(pulpBase, CANVAS_EDGE_SHADOW, 0.19);
  const ply2Stroke = mixHex(pulpBase, CANVAS_EDGE_SHADOW, 0.27);
  const ply3Stroke = mixHex(pulpBase, CANVAS_EDGE_SHADOW, 0.35);
  const geoms = edges.map((edge, i) => ({
    edge,
    g: edgeFor(el.id, i, el.x, el.y, w, h, edge)
  }));

  const curveId = (i: number) => `ec_${el.id}_${i}`;

  let body: ComponentChildren = (
    <>
      {children}
      {geoms.map((_, i) => (
        <use
          key={`seam_${i}`}
          href={`#${curveId(i)}`}
          stroke={ply1Stroke}
          strokeWidth={0.55}
          opacity={0.45}
          strokeLinecap="round"
        />
      ))}
    </>
  );
  for (let i = geoms.length - 1; i >= 0; i--) {
    body = <g clipPath={`url(#edge_${el.id}_${i})`}>{body}</g>;
  }

  return (
    <g data-edge={el.id}>
      <defs>
        {geoms.map(({ g }, i) => (
          <path key={curveId(i)} id={curveId(i)} d={g.curve} fill="none" />
        ))}
      </defs>
      {geoms.map(({ g }, i) =>
        g.veil ? (
          <path
            key={`veil_${i}`}
            d={g.veil}
            fill={ply3Fill}
            stroke={ply3Stroke}
            strokeWidth={0.55}
            strokeLinejoin="round"
          />
        ) : null
      )}
      {geoms.map(({ g }, i) =>
        g.ply ? (
          <path
            key={`ply_${i}`}
            d={g.ply}
            fill={ply2Fill}
            stroke={ply2Stroke}
            strokeWidth={0.55}
            strokeLinejoin="round"
          />
        ) : null
      )}
      {geoms.map(({ g }, i) =>
        g.fringe ? (
          <path
            key={`fringe_${i}`}
            d={g.fringe}
            fill={ply1Fill}
            stroke={ply1Stroke}
            strokeWidth={0.55}
            strokeLinejoin="round"
          />
        ) : null
      )}
      {body}
    </g>
  );
}
