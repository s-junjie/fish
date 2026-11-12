import type { DesignDocument, Effect, LayoutGuide, Paint, Stroke, TextStyleDeclaration } from "../../core/dsl/types";
import { cssBlurFilter } from "../../core/css-encode";
import { paintImageUri } from "./paint-preview";
import { PaintStackSwatch } from "../PaintStackSwatch";
import { t } from "../../i18n";
import { resolveStack } from "../../core/font-stack";
import { DEFAULT_GUIDE_COLOR } from "../../core/layout/layout-guides";

export function GuideBanner({ guides }: { guides: LayoutGuide[] }) {
  const colour = guides[0]?.color ?? DEFAULT_GUIDE_COLOR;
  return (
    <div className="w-full h-20 rounded-ctl border border-rule-strong bg-inset flex items-stretch gap-1 p-2">
      {Array.from({ length: Math.min(8, Math.max(1, guides.length * 4)) }).map((_, index) => (
        <div key={index} className="flex-1 rounded-[1px]" style={{ background: colour }} />
      ))}
    </div>
  );
}

export function StrokeBanner({ strokes }: { strokes: Stroke[] }) {
  const top = strokes.find((s) => s.enabled !== false);
  const color = top?.color || (top?.paint?.type === "solid" ? top.paint.color : "#D9D9D9");
  return (
    <div className="w-full h-20 rounded-ctl border border-rule-strong bg-inset flex items-center justify-center p-3">
      <div
        className="w-16 h-10 rounded-ctl"
        style={{
          borderWidth: `${Math.min(top?.width || 1, 8)}px`,
          borderColor: color,
          borderStyle: top?.style === "dashed" ? "dashed" : "solid"
        }}
      />
    </div>
  );
}

export function PaintBanner({ paints, doc }: { paints: Paint[]; doc?: DesignDocument }) {
  /* `PaintStackSwatch`, not a third copy of the layer loop. The banner and the
     style card's mark are the same object at two sizes, and the banner was the
     one place that composited the stack itself — without an `imageUri`, so an
     image fill previewed as an empty checkerboard (which is why this read as
     "no preview at all"). The swatch already stacks solid/gradient/image/pattern
     bottom-first over the checker, with each layer's alpha. */
  return <PaintStackSwatch paints={paints} imageUri={paintImageUri(doc)} className="w-full h-24" />;
}

export function TextBanner({ style }: { style: TextStyleDeclaration }) {
  return (
    /* `inset`, not `panel`: the popover this sits in is `panel` (POPOVER_SURFACE_CLASS),
       so a `panel` banner measured the same rgb as its own container and the
       preview had no plate under it. One step DOWN reads as a well. */
    <div className="w-full h-20 rounded-ctl border border-rule-strong bg-inset flex items-center justify-center p-3 text-center overflow-hidden">
      <span
        className="text-ink"
        style={{
          fontFamily: resolveStack(style.fontFamily),
          fontWeight: style.fontWeight,
          fontSize: Math.min(style.fontSize || 16, 24)
        }}
      >
        {t("styles.previewText")}
      </span>
    </div>
  );
}

export function EffectBanner({ effects }: { effects: Effect[] }) {
  const active = effects.filter((e) => e.enabled !== false);
  const shadows = active
    .map((e) => {
      if (e.type !== "drop-shadow" && e.type !== "inner-shadow") return null;
      const inset = e.type === "inner-shadow" ? "inset " : "";
      const spread = e.spread ? `${e.spread}px ` : "";
      return `${inset}${e.offset?.x ?? 0}px ${e.offset?.y ?? 0}px ${e.blur ?? 0}px ${spread}${e.color || "rgba(0,0,0,0.4)"}`;
    })
    .filter((s): s is string => !!s)
    .join(", ");
  const layerBlur = active.find((e) => e.type === "layer-blur")?.blur ?? 0;

  /* The tile IS the caster — the same move `EffectRows` makes, and for the same
     reason: a shadow with no object on it is not a preview, it is a smudge. The
     sparkle that used to sit in the middle added nothing the tile was not
     already saying, and it was the only thing in this banner that did not scale
     with the effect. */
  return (
    <div className="w-full h-20 rounded-ctl border border-rule-strong bg-inset flex items-center justify-center">
      <div
        className="w-12 h-12 rounded-ctl bg-raised"
        style={{ boxShadow: shadows || undefined, filter: layerBlur ? cssBlurFilter(layerBlur) : undefined }}
      />
    </div>
  );
}
