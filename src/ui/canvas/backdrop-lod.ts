/**
 * Which backdrop blurs are still worth painting at the current zoom.
 *
 * A `backdrop-filter` is charged per ELEMENT per frame, not per area: at one
 * zoom, 480 chips of 16, 40 and 72 document px — 1.6, 4.0 and 7.2 screen px —
 * cost 0.374, 0.374 and 0.379 ms/frame each, and writing `backdrop-filter: none`
 * on the lot takes 190.1 ms down to 16.5. The price is the filter and nothing
 * else: removing the `foreignObject` instead costs the same as disabling it, and
 * a plain document padded to 8,647 nodes still ticks at 16.7 ms, so neither the
 * HTML element nor the node count is what is being paid for. The runs are in
 * `docs/CANVAS_PERF.md` §8.
 *
 * A footprint too small to show a blur is therefore pure loss — and it is loss
 * exactly where it hurts, because far out is where a large file puts every panel
 * at once. Below `MIN_BACKDROP_SCREEN_PX` on its SHORT edge a Gaussian has no
 * structure left to read, so the element keeps its own fill, which is what it
 * looks like at that size anyway.
 *
 * Screen px, like the 8px hit slop and the 11px frame label in `style.css`, not
 * device px: the three are read side by side, and a dpr-dependent one would have
 * to justify itself on its own.
 */

/** Short-edge floor, in screen px, under which a backdrop is not painted. */
export const MIN_BACKDROP_SCREEN_PX = 8;

/**
 * Long-edge ceiling, in device px, for the offscreen textures this pass charges
 * for: a backdrop's own `cc::RenderSurfaceImpl`, and the `kClipPathMask` its
 * nearest clipping ancestor rasterizes. Both run into Metal/Skia's 8,192 px
 * texture limit; 7,680 keeps the margin.
 */
export const MAX_DEVICE_TEXTURE_PX = 7680;

/**
 * Device-pixel area ceiling above which Chromium's compositor drops a
 * `<foreignObject>` `backdrop-filter` surface or exhausts `TileManager` memory
 * (measured threshold: ~2,020,000 device px² at dpr=2).
 */
export const MAX_BACKDROP_DEVICE_AREA = 2_000_000;

/**
 * Marks the painted half of a backdrop branch, and carries the chain it was
 * authored with.
 *
 * The value has to be in the DOM because the pass below OWNS the inline
 * property while the node owns the render: a node that re-runs rewrites
 * `backdrop-filter` from its own props, and the pass needs the authored chain
 * back to decide whether to disable it again. Reading it off the attribute also
 * keeps the two from drifting — the same argument that keeps `CanvasDefs` and
 * the nodes agreeing about a filter id.
 */
export const BACKDROP_CHAIN_ATTR = "data-backdrop-chain";

/**
 * Marks a container `<g clip-path="url(#clip_...)">` and its long-edge span in
 * document units, so the pass below can tell whether a backdrop nested under it
 * sits inside a mask too large to trust.
 *
 * The clip itself is never released. Clipping is the document's structure and
 * survives any zoom — the mask is rasterized at the culled size, measured clean
 * to 38,400 device px — while a nested `backdrop-filter` under an oversized mask
 * is the part Chromium flattens to a rectangle. So the blur yields, not the clip.
 */
export const CLIP_CHAIN_ATTR = "data-clip-chain";
export const CLIP_SPAN_ATTR = "data-clip-span";

function deviceScale(): number {
  return typeof window !== "undefined" ? Math.max(1, window.devicePixelRatio || 1) : 1;
}

export function paintsBackdrop(worldWidth: number, worldHeight: number, zoom: number): boolean {
  if (Math.min(worldWidth, worldHeight) * zoom < MIN_BACKDROP_SCREEN_PX) return false;
  const dpr = deviceScale();
  const devW = worldWidth * zoom * dpr;
  const devH = worldHeight * zoom * dpr;
  return Math.max(devW, devH) <= MAX_DEVICE_TEXTURE_PX && devW * devH <= MAX_BACKDROP_DEVICE_AREA;
}

/** Whether a clip mask `span` document units long still fits the texture ceiling. */
export function clipMaskFits(span: number, zoom: number): boolean {
  return span * zoom * deviceScale() <= MAX_DEVICE_TEXTURE_PX;
}

/**
 * Whether any clipping ancestor would rasterize a mask over the ceiling.
 *
 * An unreadable span reads as "fits": painting a blur that turns out to be a
 * cost is recoverable, and dropping one that was going to render is the bug this
 * whole module exists to avoid.
 */
function underOversizedClip(el: Element, zoom: number): boolean {
  let clip = el.closest(`[${CLIP_CHAIN_ATTR}]`);
  while (clip) {
    const span = Number(clip.getAttribute(CLIP_SPAN_ATTR));
    if (Number.isFinite(span) && span > 0 && !clipMaskFits(span, zoom)) return true;
    clip = clip.parentElement?.closest(`[${CLIP_CHAIN_ATTR}]`) ?? null;
  }
  return false;
}

/**
 * Disable or restore every backdrop div in `root` for the zoom that is on screen
 * right now.
 *
 * Imperative, and on purpose: the alternative is a zoom-derived value in
 * `NodeRenderContext` compared by the node memo, which is a whole-subtree
 * re-render per rung for every frame that contains any glass — the trap §5
 * already paid for. Here the write lands on the one div it concerns and the
 * invalidation stops there, which is the same shape as the painted-chrome pass
 * in `CanvasArea`.
 *
 * Called after EVERY render rather than on a zoom change, because a node that
 * re-renders puts its filter back and nothing else would notice. Re-queried
 * rather than cached for the reason the cull gives: mounting and unmounting
 * frames changes the set, and the query itself measures free.
 */
export function applyBackdropLod(root: ParentNode, zoom: number): void {
  for (const div of root.querySelectorAll<HTMLElement>(`[${BACKDROP_CHAIN_ATTR}]`)) {
    // The box the blur is clipped to is the `foreignObject` around it, and its
    // authored width/height is the painted box in document units — no
    // `getBoundingClientRect`, so this never forces a layout.
    const box = div.parentElement;
    const width = Number(box?.getAttribute("width"));
    const height = Number(box?.getAttribute("height"));
    const authored = div.getAttribute(BACKDROP_CHAIN_ATTR);
    // A backdrop whose box cannot be read is left alone: painting an extra blur
    // is a cost, silently dropping one is a bug.
    if (!authored || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) continue;
    const paint = paintsBackdrop(width, height, zoom) && !underOversizedClip(div, zoom);
    // Read as "is it painted", not as "is it the chain I would write": the CSSOM
    // re-serialises what it is given, so a glass chain carrying `url(#...)` can
    // come back with the url quoted. Comparing chains would differ every render
    // and write every render; `none` is a value only this pass ever sets.
    const painted = div.style.backdropFilter !== "none";
    if (paint === painted) continue;
    const next = paint ? authored : "none";
    div.style.backdropFilter = next;
    // The prefix has no camelCase accessor in the DOM lib; the property is
    // spelled out. Both are needed — the node sets both.
    div.style.setProperty("-webkit-backdrop-filter", next);
  }
}
