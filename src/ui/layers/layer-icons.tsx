import { DesignElement, ComponentElement, FrameElement, PaintStack } from "../../core/dsl/types";
import { firstImagePaint } from "../../core/dsl/image-fill";
import { layoutOf } from "../../core/dsl/layout-flat";
import { expectNever } from "../../core/exhaustive";
import { ComponentMark, InstanceMark, VariantMark, VariantSetMark } from "../ComponentMark";
import {
  Square,
  Circle,
  Minus,
  Type,
  Frame,
  MoveUpRight,
  Hexagon,
  Star,
  Spline,
  Image as ImageIcon,
  Video as VideoIcon,
  Code
} from "lucide-react";

/**
 * The glyph that names what KIND of layer this is.
 *
 * `size` defaults to the 13px a layer ROW draws. The rail footer's context line
 * sets 11px: the same glyph list, at a readout's scale — one function rather
 * than a second switch that could fall behind it.
 *
 * `tone` is how loudly the glyph speaks its kind. The layer list earns its
 * amber auto-layout frames and violet components — kind is the thing being read
 * there, row after row. A one-line footer does not: every glyph in the strip
 * already sits at 11px beside at most eleven characters, and a third colour
 * family in that little room would be noise, so `neutral` drops the colour
 * classes and each icon inherits whatever its crumb's text is wearing. Every
 * glyph here paints `currentColor` (lucide by default, the marks and the three
 * frame grids by their own attribute), so inheritance is real, not approximate.
 */
export function getElementIcon(el: DesignElement, size = 13, tone: "kind" | "neutral" = "kind") {
  const ink = tone === "neutral" ? "shrink-0" : "shrink-0 text-ink-dim";
  const brand = tone === "neutral" ? ink : "shrink-0 text-brand";
  const component = tone === "neutral" ? ink : "shrink-0 text-component";

  // An image is a fill, so the icon reads the layer stack: a rect that is
  // really a photo must not be indistinguishable from a plain rectangle.
  if (firstImagePaint(el as { fills?: PaintStack })) {
    return <ImageIcon size={size} className={ink} />;
  }
  const kind = el.type;
  switch (kind) {
    case "frame": {
      const frameEl = el as FrameElement;
      const flat = layoutOf(frameEl);
      if (flat) {
        if (flat.mode === "grid") {
          return (
            <svg width={size} height={size} viewBox="0 0 14 14" fill="none" className={brand}>
              <rect x="1" y="1" width="12" height="12" rx="2.5" stroke="currentColor" strokeWidth="1.5" />
              <line x1="1" y1="7" x2="13" y2="7" stroke="currentColor" strokeWidth="1.5" />
              <line x1="7" y1="1" x2="7" y2="13" stroke="currentColor" strokeWidth="1.5" />
            </svg>
          );
        }
        if (flat.direction === "row") {
          return (
            <svg width={size} height={size} viewBox="0 0 14 14" fill="none" className={brand}>
              <rect x="1" y="1" width="12" height="12" rx="2.5" stroke="currentColor" strokeWidth="1.5" />
              <line x1="7" y1="1" x2="7" y2="13" stroke="currentColor" strokeWidth="1.5" />
            </svg>
          );
        }
        return (
          <svg width={size} height={size} viewBox="0 0 14 14" fill="none" className={brand}>
            <rect x="1" y="1" width="12" height="12" rx="2.5" stroke="currentColor" strokeWidth="1.5" />
            <line x1="1" y1="7" x2="13" y2="7" stroke="currentColor" strokeWidth="1.5" />
          </svg>
        );
      }
      return <Frame size={size} className={ink} />;
    }
    case "component":
      /* A member of a variant set reads as the single solid diamond; a free
         master keeps the four-diamond mark. */
      if ((el as ComponentElement).setId) {
        return <VariantMark size={size} className={component} />;
      }
      return <ComponentMark size={size} className={component} />;
    case "componentSet":
      return <VariantSetMark size={size} className={component} />;
    case "instance":
      return <InstanceMark size={size} className={component} />;
    case "rect":
      return <Square size={size} className={ink} />;
    case "ellipse":
      return <Circle size={size} className={ink} />;
    case "line":
      return <Minus size={size} className={ink} />;
    case "arrow":
      return <MoveUpRight size={size} className={ink} />;
    case "polygon":
      return <Hexagon size={size} className={ink} />;
    case "star":
      return <Star size={size} className={ink} />;
    case "path":
      return <Spline size={size} className={ink} />;
    case "text":
      return <Type size={size} className={ink} />;
    case "video":
      return <VideoIcon size={size} className={ink} />;
    case "html":
      return <Code size={size} className={ink} />;
    default:
      expectNever(kind);
      return <Square size={size} className={ink} />;
  }
}
