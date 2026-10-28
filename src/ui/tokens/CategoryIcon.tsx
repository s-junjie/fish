import {
  GapHorizontal,
  Layers2,
  Maximize2,
  Minus,
  SquareRoundCorner,
  Type
} from "lucide-react";
import type { NumberTokenCategory } from "../../core/dsl/types";

export const NUMBER_TOKEN_CATEGORIES: NumberTokenCategory[] = [
  "spacing",
  "radius",
  "stroke",
  "size",
  "typography",
  "effect"
];

interface CategoryIconProps {
  category?: NumberTokenCategory;
  size?: number;
  className?: string;
}

export function CategoryIcon({
  category,
  size = 12,
  className = "text-ink-muted shrink-0"
}: CategoryIconProps) {
  switch (category) {
    case "radius":
      return <SquareRoundCorner size={size} className={className} />;
    case "stroke":
      return <Minus size={size} className={className} />;
    case "size":
      return <Maximize2 size={size} className={className} />;
    case "typography":
      return <Type size={size} className={className} />;
    case "effect":
      return <Layers2 size={size} className={className} />;
    case "spacing":
    default:
      return <GapHorizontal size={size} className={className} />;
  }
}
