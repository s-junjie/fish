/**
 * Device pixels per document pixel, for the canvas at `zoom`.
 *
 * The canvas draws in document units and the browser magnifies it, so anything
 * whose quality is a LENGTH has to be built for the scale it is displayed at
 * rather than for the document unit. Two things are, and both were built for 1:1
 * and showed their own grid at every other zoom: the Liquid Glass bitmaps (baked
 * canvases) and a conic gradient (a fan of sectors whose count is a chord-error
 * budget in pixels). It is one quantity, so it is one function.
 *
 * Quantised to a ladder because it is part of a cache key and the canvas
 * re-renders on every wheel tick — a continuous value would rebuild the material
 * several times per pinch and throw each intermediate away. Rounding up is the
 * only safe direction.
 */
const SCALES = [1, 1.5, 2, 3, 4, 6, 8] as const;

export function deviceScale(zoom: number): number {
  const device = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
  const target = Math.max(1, zoom || 1) * Math.max(1, device);
  for (const s of SCALES) if (s >= target) return s;
  return SCALES[SCALES.length - 1];
}

/**
 * The same quantity with no ceiling, rounded up to a power of two.
 *
 * `deviceScale` stops at 8 because it sizes rasters, and a bitmap that large is
 * already the limit. This one exists for `feMorphology`, whose radius Chromium
 * silently clamps at 256 DEVICE pixels (`CanvasDefs`): the cap has to be divided
 * by the real scale, and on a 2x display 8x zoom is 16, not 8. Rounding up is
 * still the only safe direction — a chunk that is too large is a spread that is
 * silently short again.
 *
 * Powers of two rather than the rung ladder so the value still only changes a
 * handful of times across the whole zoom range: `CanvasDefs` compares its props
 * by value and must not rebuild `<defs>` on every wheel tick.
 */
export function pixelScale(zoom: number): number {
  const device = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
  const target = Math.max(1, zoom || 1) * Math.max(1, device);
  return 2 ** Math.ceil(Math.log2(target));
}
