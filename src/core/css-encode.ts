import { resolveDynamicLineHeight } from "./compile";
import type { LineHeight } from "./dsl/types";

/**
 * Single source for DSL -> CSS value encoding. The canvas renderer and the HTML
 * exporter must read the same numbers, or export drifts from what was designed.
 */

const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

/**
 * A DSL blur RADIUS onto CSS `blur()`, whose argument is a Gaussian standard
 * deviation: sigma = radius / 2 (Skia's and Figma's convention, the same one
 * `liquid-glass` calibrates Frost against).
 *
 * Writing the radius through unchanged paints every backdrop twice as strong as
 * the SVG path, which renders the same number as `stdDeviation = blur / 2`.
 */
export function cssBlurFilter(blur: number): string {
  return `blur(${Math.max(0, blur) / 2}px)`;
}

/**
 * The DSL value is already CSS-shaped, so this is close to a passthrough: a
 * multiplier stays a unitless number (surviving a font-size change), `"24px"`
 * stays px. An absent value becomes the engine's resolved default as a unitless
 * ratio — not `normal`, whose font-dependent value the engine cannot measure.
 */
export function cssLineHeight(fontSize: number, lineHeight?: LineHeight): string {
  if (typeof lineHeight === "string") return lineHeight;
  if (typeof lineHeight === "number") return String(round6(lineHeight));
  return String(round6(resolveDynamicLineHeight(fontSize) / fontSize));
}
