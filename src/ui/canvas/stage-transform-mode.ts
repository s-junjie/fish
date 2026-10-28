import { DesignElement } from "../../core/dsl/types";
import { isContainer } from "../../core/geometry/tree-ops";

/**
 * Whether the page's pan/zoom has to ride `[data-stage-transform]` — an SVG
 * `transform` ATTRIBUTE on a `<g>` — instead of a composited CSS `transform` on
 * the root `<svg>`.
 *
 * `docs/LESSONS_LEARNED.md` #166: Chromium drops every `backdrop-filter` inside
 * an `<svg>` as soon as (a) a `mix-blend-mode` other than `normal` appears in
 * that `<svg>` AND (b) anything above it moves it by transform — a CSS transform
 * on the `<svg>` itself, the SVG `transform` attribute on it, or one on an HTML
 * wrapper. A `<g transform>` inside is not the viewport, so the backdrop root is
 * left alone and the blur survives. `isolation`, `contain`, `will-change`,
 * `filter` and a nested `<svg>` do not restore it.
 *
 * Neither half alone is enough: with no backdrop blur in the page there is
 * nothing for the bug to drop, and with no blend mode it never fires. So the
 * composited path is the default and the group is the exception, and the
 * exception is what costs — the attribute write re-rasterises the SVG where the
 * CSS one only re-composites: measured 33.4 ms/frame vs 16.7 ms at 52.8k mounted
 * nodes, three alternating rounds against a no-write control.
 *
 * The answer is deliberately coarse — one page-wide yes/no, not per element —
 * because the transform is one value for the whole canvas, and a page that might
 * need the group has to take it for every frame of the gesture.
 */

/** Effect types the renderer turns into a `backdrop-filter` (SvgNodeRenderer). */
function isBackdropEffect(type: string): boolean {
  return type === "backdrop-blur" || type === "liquid-glass";
}

function hasBlend(paints: unknown): boolean {
  if (!Array.isArray(paints)) return false;
  for (const paint of paints) {
    const mode = (paint as { blendMode?: string } | null)?.blendMode;
    if (mode && mode !== "normal") return true;
  }
  return false;
}

export function pageNeedsBackdropSafeStage(elements: readonly DesignElement[]): boolean {
  // Explicit stack, not recursion: a real page nests a component five or more
  // levels deep and this runs on the unmemoized pass of every render.
  const stack: DesignElement[] = [...elements];
  let backdrop = false;
  let blend = false;
  while (stack.length > 0) {
    const el = stack.pop()!;
    if (el.blendMode && el.blendMode !== "normal") blend = true;
    if (hasBlend(el.fills) || hasBlend(el.strokes)) blend = true;
    for (const effect of el.effects ?? []) {
      if (effect.enabled === false) continue;
      if (isBackdropEffect(effect.type)) backdrop = true;
    }
    if (backdrop && blend) return true;
    if (isContainer(el) && el.children) for (const child of el.children) stack.push(child);
  }
  return false;
}
