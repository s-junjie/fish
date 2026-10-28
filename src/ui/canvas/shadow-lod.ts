/**
 * Which SVG drop shadows are still worth painting at the current zoom.
 *
 * An SVG `filter` reference is charged per ELEMENT per frame and it does not care
 * how big the element is: at one zoom, chips of 24, 56 and 96 document px cost
 * 199.6, 206.4 and 227.7 ms for the same 480 of them, and rewriting every
 * `filter` attribute to `none` — with all 480 `<filter>` DEFINITIONS left in the
 * tree — takes it to 16.7, the frame a document with no effects pays. The cost is
 * following the REFERENCE, not compiling the chain. `docs/CANVAS_PERF.md` §9.
 *
 * What buys it back is therefore dropping the reference, and what makes that
 * invisible is the shadow's own reach: the distance a shadow paints BEYOND the
 * silhouette, `spread + blur * 3 + the larger offset`, which is the same number
 * `CanvasDefs` pads the filter region with. Projected under
 * `MIN_SHADOW_REACH_PX` that band is thinner than the pixels it would land on,
 * and there is nothing left to see. Measured rather than argued — at a 1.4 px
 * reach the difference between painting the shadow and not is 0.87 % of pixels by
 * >=4 and a maximum of 26/255; at a 2.2 px reach the maximum is 78. The floor
 * sits between those two.
 *
 * Screen px, like the 8 px hit slop and `MIN_BACKDROP_SCREEN_PX`: constants that
 * are read side by side should be in one unit.
 */

/** Floor, in screen px, under which a shadow's reach is not painted. */
export const MIN_SHADOW_REACH_PX = 2;

/**
 * Carries the `filter` value the node rendered, so the pass can put it back.
 *
 * Same reason the backdrop one exists in the DOM: the pass owns this attribute
 * while the node owns the render, and anything the node re-renders rewrites it
 * from its own props.
 */
export const SHADOW_CHAIN_ATTR = "data-shadow-chain";

/**
 * The shadow's reach in DOCUMENT units, so the pass can project it without
 * knowing anything about effects.
 */
export const SHADOW_REACH_ATTR = "data-shadow-reach";

interface ReachlessShadow {
  type: string;
  blur?: number;
  spread?: number;
  offset?: { x?: number; y?: number };
}

/**
 * How far past its own shape a single drop shadow paints, in document units.
 *
 * `blur * 3`, not `blur`: a Gaussian's visible edge is about three of them out,
 * which is also what `CanvasDefs` sizes the filter region by. A shadow with no
 * offset and no blur is EXACTLY behind its shape — invisible unless the shape is
 * translucent, so it is given a reach of 0 and left painted.
 */
export function dropShadowReach(ef: ReachlessShadow): number {
  const blur = Math.max(0, ef.blur ?? 0);
  const spread = ef.spread ?? 0;
  const dx = Math.abs(ef.offset?.x ?? 0);
  const dy = Math.abs(ef.offset?.y ?? 0);
  return Math.max(0, spread + blur * 3 + Math.max(dx, dy));
}

/**
 * The marks `applyShadowLod` reads, or none at all.
 *
 * Every effect in the filter has to be a drop shadow, and nothing else may share
 * the filter: a colour adjustment changes the shape's own pixels, a layer blur
 * changes its silhouette, and either survives being scaled down in a way a shadow
 * does not — the colour of a 2 px dot is still the colour of that dot. Those are
 * left until they have been measured the way the shadow has.
 */
export function shadowLodMarks(
  filterAttr: string | undefined,
  svgFilterEffects: readonly ReachlessShadow[],
  colorFilter: unknown
): Record<string, string> {
  if (!filterAttr || colorFilter || svgFilterEffects.length === 0) return {};
  let reach = 0;
  for (const ef of svgFilterEffects) {
    if (ef.type !== "drop-shadow") return {};
    reach = Math.max(reach, dropShadowReach(ef));
  }
  if (reach <= 0) return {};
  return { [SHADOW_CHAIN_ATTR]: filterAttr, [SHADOW_REACH_ATTR]: String(reach) };
}

export function paintsShadow(reachDocumentUnits: number, zoom: number): boolean {
  return reachDocumentUnits * zoom >= MIN_SHADOW_REACH_PX;
}

/**
 * Drop or restore every marked shadow in `root` for the zoom on screen now.
 *
 * Imperative for the reason `applyBackdropLod` is: the alternative is a
 * zoom-derived field on `NodeRenderContext` compared by the node memo, and a memo
 * that re-fires invalidates everything beneath it. Re-queried rather than cached
 * because the cull mounts and unmounts these nodes as the zoom moves.
 */
export function applyShadowLod(root: ParentNode, zoom: number): void {
  for (const el of root.querySelectorAll<SVGElement>(`[${SHADOW_CHAIN_ATTR}]`)) {
    const chain = el.getAttribute(SHADOW_CHAIN_ATTR);
    const reachAttr = el.getAttribute(SHADOW_REACH_ATTR);
    const reach = Number(reachAttr);
    // Asked as "was the attribute there" before it is asked as a number: a
    // missing attribute reads back as null and `Number(null)` is 0, so going
    // straight to `Number` turns every unreadable node into one whose shadow has
    // no reach — which this pass would then switch off.
    // Unreadable means painted: an extra shadow is a cost, a dropped one is a bug.
    if (!chain || reachAttr === null || !Number.isFinite(reach)) continue;
    const paint = paintsShadow(reach, zoom);
    const painted = el.getAttribute("filter") !== "none";
    if (paint === painted) continue;
    el.setAttribute("filter", paint ? chain : "none");
  }
}
