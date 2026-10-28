import { Paint } from "../core/dsl/types";
import { paintStackLayers } from "../core/geometry/gradient-utils";
import { PAINT_SWATCH_CHECKER } from "./inspector/paint-row-style";

interface PaintStackSwatchProps {
  paints?: readonly Paint[];
  imageUri?: (paint: Paint) => string | undefined;
  className?: string;
}

/**
 * Previews a paint stack the way the canvas composites it: every layer stacked,
 * bottom-first, over a checkerboard so translucency reads as translucency.
 */
export function PaintStackSwatch({ paints, imageUri, className = "w-4 h-4" }: PaintStackSwatchProps) {
  const layers = paintStackLayers(paints, imageUri);
  return (
    <div
      data-paint-stack-swatch=""
      className={`${className} rounded-ctl border border-rule-strong shrink-0 relative overflow-hidden`}
      style={PAINT_SWATCH_CHECKER}
    >
      {layers.map((layer, i) => (
        <div
          key={i}
          className="absolute inset-0"
          style={{ background: layer.background, opacity: layer.opacity }}
        />
      ))}
    </div>
  );
}
