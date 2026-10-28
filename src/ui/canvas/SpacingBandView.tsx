import { SpacingBand } from "../../core/geometry/spacing-bands";
import { CANVAS_CORAL, CANVAS_MARGIN, CANVAS_ON_SELECT, withAlpha } from "./canvas-colors";
import { CANVAS_CHROME_TEXT } from "./canvas-text";

/**
 * One spacing band: a tinted region with its live pixel size in a pill.
 *
 * Shared by the two places that say the same thing — the gap pill dragged on the
 * canvas and the inspector's padding / margin / gap scrub. They were separate
 * drawings, which is how the canvas gap band ended up in rose-500 while the pill
 * labelling it was coral; one component is the only way they cannot drift again.
 *
 * `tone` is the only difference between them:
 *  - `coral` — a filled wash. Padding and gap are the container's own geometry,
 *    measured in the accent that already means "the spacing you are holding".
 *  - `guide` — an outlined, dashed wash in the neutral. Margin is the space a
 *    child claims AROUND itself, which is structure rather than a measurement,
 *    and the palette's other two saturated meanings (blue = chosen, coral =
 *    geometry) are both already spoken for. The dashed neutral also separates it
 *    from padding at a glance, so the two never have to be told apart by hue alone.
 */

/** The thinnest a band may draw, so a value of 0 is still a readout and not nothing. */
const MIN_THICKNESS = 2.5;

export function SpacingBandView({ band, zoom }: { band: SpacingBand; zoom: number }) {
  const floor = MIN_THICKNESS / zoom;
  // Expand about the band's own centre, not its corner: at 0 the padding edge,
  // the margin edge and the gap seam all sit exactly ON an element's border, so
  // a hairline straddling that centre is where the boundary actually is.
  const w = Math.max(band.width, floor);
  const h = Math.max(band.height, floor);
  const x = band.cx - w / 2;
  const y = band.cy - h / 2;

  const label = band.label;
  const labelH = 13 / zoom;
  const labelW = (label.length * 6 + 9) / zoom;
  const strokeW = 1 / zoom;
  const isMargin = band.tone === "margin";
  const accent = isMargin ? CANVAS_MARGIN : CANVAS_CORAL;

  return (
    <g pointerEvents="none">
      <rect
        data-spacing-band={band.tone}
        data-spacing-label-value={label}
        x={x}
        y={y}
        width={w}
        height={h}
        fill={withAlpha(accent, isMargin ? 0.2 : 0.18)}
        stroke={withAlpha(accent, isMargin ? 0.85 : 0.65)}
        strokeWidth={strokeW}
        strokeDasharray={isMargin ? `${4 / zoom} ${3 / zoom}` : undefined}
      />
      <g transform={`translate(${band.cx}, ${band.cy})`}>
        <rect
          x={-labelW / 2}
          y={-labelH / 2}
          width={labelW}
          height={labelH}
          rx={labelH / 2}
          ry={labelH / 2}
          fill={accent}
          stroke={CANVAS_ON_SELECT}
          strokeWidth={strokeW}
        />
        <text
          data-spacing-label={band.tone}
          x={0}
          y={0}
          textAnchor="middle"
          dominantBaseline="middle"
          fontSize={9 / zoom}
          fontFamily={CANVAS_CHROME_TEXT}
          fontWeight={600}
          fill={CANVAS_ON_SELECT}
        >
          {label}
        </text>
      </g>
    </g>
  );
}