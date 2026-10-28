import type { ComponentChildren } from "preact";
import { BaseStyle, ColorToken, DesignStyle, EffectStyle, Paint, PaintStack, PaintStyle, StrokeStyle, TextStyleDefinition } from "../../core/dsl/types";
import { PaintStackSwatch } from "../PaintStackSwatch";
import { topPaint } from "../../core/dsl/paint-stack";
import { gradientKindLongLabel, isGradientKind } from "../paint-kind";
import { t } from "../../i18n";
import { Type, Layers2 } from "lucide-react";
import { DEFAULT_FONT_FAMILY } from "../../core/font-stack";

function GlyphTile({ children, className }: { children: ComponentChildren; className: string }) {
  return (
    <div className={`${className} flex shrink-0 items-center justify-center rounded-ctl bg-rule text-ink-dim`}>
      {children}
    </div>
  );
}

/**
 * The one renderer for a style's mark. A paint style shows its stack; text and
 * effect have no colour of their own and get a glyph — and which glyph, at which
 * size, in which grey used to be decided separately at each of the six call
 * sites, three of them spelling the tile a different shade.
 */
export function renderStylePreview(
  style: DesignStyle,
  // 14px, the paint swatch's own size: the mark a style shows is the same object
  // as the swatch beside a hex, and three call sites were asking for 16 and 20.
  sizeClass = "w-3.5 h-3.5",
  imageUri?: (paint: Paint) => string | undefined,
  theme?: string
): ComponentChildren {
  if (style.styleType === "paint") {
    const paints = (style as PaintStyle).paints;
    return (
      <PaintStackSwatch
        paints={paints}
        className={sizeClass}
        imageUri={imageUri}
      />
    );
  }
  if (style.styleType === "stroke") {
    const strokeStyle = style as StrokeStyle;
    const top = strokeStyle.strokes?.[0];
    const color = top?.color || (top?.paint?.type === "solid" ? top.paint.color : undefined);
    return (
      <GlyphTile className={sizeClass}>
        <div
          className="w-2.5 h-2.5 rounded-xs border"
          style={{ borderColor: color || "currentColor", borderWidth: "1.5px" }}
        />
      </GlyphTile>
    );
  }
  return (
    <GlyphTile className={sizeClass}>
      {style.styleType === "text" ? <Type size={11} /> : <Layers2 size={11} />}
    </GlyphTile>
  );
}

export function getStyleSubtitle(style: DesignStyle): string {
  if (style.styleType === "text") {
    const s = (style as TextStyleDefinition).style;
    return `${s.fontFamily || DEFAULT_FONT_FAMILY} · ${s.fontSize || 14}px`;
  }
  if (style.styleType === "paint") {
    const p = topPaint((style as PaintStyle).paints);
    return p && isGradientKind(p.type) ? gradientKindLongLabel(p.type) : (style.description || "");
  }
  if (style.styleType === "stroke") {
    return style.description || t("styles.strokeCount", { n: (style as StrokeStyle).strokes.length });
  }
  if (style.styleType === "effect") {
    return t("styles.effectCount", { n: (style as EffectStyle).effects.length });
  }
  return (style as BaseStyle).description || "";
}

/** A colour token's mark: the one colour it holds, drawn as a one-paint stack. */
export function renderColorTokenPreview(token: ColorToken, theme?: string, sizeClass = "w-3.5 h-3.5") {
  const color = theme && token.modes?.[theme] ? token.modes[theme] : token.value;
  const paints: PaintStack = [{ type: "solid", color }];
  return <PaintStackSwatch paints={paints} className={sizeClass} />;
}
