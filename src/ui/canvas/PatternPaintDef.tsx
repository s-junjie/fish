import { JSX } from "preact";
import { PatternPaint } from "../../core/dsl/types";
import { patternSvgPaint } from "../../core/geometry/pattern-tile";

/**
 * One pattern paint as an SVG paint server: either a repeating gradient (the
 * stripe motif, no tile to seam) or a tile of shapes the browser repeats.
 *
 * Shared by the fill and stroke def passes so a pattern cannot paint one way
 * behind a fill and another behind an outline.
 */
export function PatternPaintDef({
  id,
  paint,
  width,
  height
}: {
  id: string;
  paint: PatternPaint;
  width: number;
  height: number;
}): JSX.Element | null {
  const def = patternSvgPaint(paint, { width, height });

  if (def.kind === "stripes") {
    const { x1, y1, x2, y2, stops } = def.gradient;
    return (
      <linearGradient
        id={id}
        gradientUnits="userSpaceOnUse"
        spreadMethod="repeat"
        x1={x1}
        y1={y1}
        x2={x2}
        y2={y2}
      >
        {stops.map((s, i) => (
          <stop key={i} offset={s.offset} stopColor={s.color} />
        ))}
      </linearGradient>
    );
  }

  return (
    <pattern
      id={id}
      patternUnits="userSpaceOnUse"
      patternContentUnits="userSpaceOnUse"
      x={def.x}
      y={def.y}
      width={def.width}
      height={def.height}
    >
      {def.background && <rect x={0} y={0} width={def.width} height={def.height} fill={def.background} />}
      {def.shapes.map((s, i) =>
        s.kind === "circle" ? (
          <circle key={i} cx={s.cx} cy={s.cy} r={s.r} fill={s.fill} />
        ) : (
          <rect
            key={i}
            x={s.x}
            y={s.y}
            width={s.width}
            height={s.height}
            fill={s.fill}
            transform={s.rotate !== undefined ? `rotate(${s.rotate})` : undefined}
          />
        )
      )}
    </pattern>
  );
}
