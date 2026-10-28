/**
 * `backdrop-filter` for the export.
 *
 * The canvas paints a frosted panel as a `<div style="backdrop-filter: blur(8px)">`
 * inside a `<foreignObject>`, because Chromium refuses `backdrop-filter` on
 * native SVG tags. The raster path loads the exported SVG through an `<img>`,
 * which has no layout engine, so that div is deleted — and with it every
 * background blur in the document.
 *
 * It cannot be rescued inside SVG. A filter primitive can only reach
 * `SourceGraphic` and `SourceAlpha`; the `BackgroundImage` input that would mean
 * "what is behind me" is specified and never implemented. So the only way to keep
 * the effect is to stop asking SVG for it and replay the paint order by hand:
 *
 *   L₀                      everything painted before the first backdrop
 *   blur(L₀) clipped to T₀  T₀'s backdrop
 *   L₁                      T₀ itself, plus everything up to T₁
 *   blur(·) clipped to T₁    T₁'s backdrop
 *   L₂ …
 *
 * Each layer holds a disjoint set of elements, so nothing is composited twice —
 * the failure mode of a prefix/suffix split, where translucent content is drawn
 * again on top of itself and reads darker than the canvas.
 *
 * What this cannot reproduce: `feDisplacementMap` refraction, which has no
 * canvas 2D equivalent, and `mix-blend-mode` other than `normal`, whose blending
 * partner is in another raster. Both are dropped rather than approximated.
 */

const SVG_NS = "http://www.w3.org/2000/svg";

export interface BackdropTarget {
  /** The `<g data-element-id>` that carried the div. */
  group: Element;
  id: string;
  /** CSS filter chain with `url(#…)` parts already removed. */
  filter: string;
  /** Shape path in the element's own box, or null when the div was unclipped. */
  clipPathD: string | null;
  /** The div's box, in the same space `clipPathD` is relative to. */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BackdropPlan {
  /** Paint order. Index in this array IS the layer a target's blur belongs to. */
  targets: BackdropTarget[];
  /** elementId -> the layer it is rasterized in. */
  buckets: Map<string, number>;
  layerCount: number;
}

const PX_LENGTH = /(-?[\d.]+)px/g;
// `path('…')`, optionally with a geometry box. The renderer appends `margin-box`
// when it has grown the div past its clip: a grown div's border box no longer
// starts at the shape, so the path is re-anchored to the MARGIN box — which, for
// a div grown by a negative margin on every side, is exactly the element's own
// box, the one recorded below off the `foreignObject`. Any other geometry box
// would put the path somewhere else and is refused rather than guessed at.
const CLIP_PATH = /^path\((['"])([\s\S]*)\1\)(?:\s+([a-z-]+))?$/;
const FILTER_URL = /url\([^)]*\)/g;

/**
 * Pull every backdrop div off the clone and report what it was painting.
 *
 * Runs before the `foreignObject` -> `<text>` pass, which is what keeps a frosted
 * panel from being read as a text run and exported as one line of whitespace.
 */
export function extractBackdropTargets(clone: SVGSVGElement): BackdropTarget[] {
  const targets: BackdropTarget[] = [];

  for (const fo of Array.from(clone.querySelectorAll("foreignObject"))) {
    const painted = fo.firstElementChild;
    if (!painted) continue;
    const style = inlineStyle(painted);
    const inlineBd = style["backdrop-filter"] || style["-webkit-backdrop-filter"];
    const raw =
      (inlineBd && inlineBd !== "none" ? inlineBd : null) ||
      painted.getAttribute("data-backdrop-chain");
    if (!raw) continue;

    const group = fo.closest("[data-element-id]");
    const id = group?.getAttribute("data-element-id");
    // Without a keyed group the div has nothing to key a layer on, and a layer
    // it cannot be placed in is a layer it cannot be drawn in.
    if (!group || !id) {
      fo.remove();
      continue;
    }

    const clip = CLIP_PATH.exec((style["clip-path"] || "").trim());
    const geometryBox = clip?.[3];
    targets.push({
      group,
      id,
      filter: raw.replace(FILTER_URL, "").replace(/\s+/g, " ").trim(),
      clipPathD: clip && (geometryBox === undefined || geometryBox === "margin-box") ? clip[2] : null,
      x: numAttr(fo, "x"),
      y: numAttr(fo, "y"),
      width: numAttr(fo, "width"),
      height: numAttr(fo, "height")
    });
    fo.remove();
  }

  return targets;
}

/**
 * Split the clone into layers, or return null when there is nothing to split.
 *
 * Two invariants decide an element's layer. It must be painted after every
 * backdrop that precedes it, or its own pixels end up inside that blur. And an
 * ancestor carrying group paint — opacity, a filter, a mask, a clip, a blend mode
 * — cannot be straddled across two rasters, because unwrapping it to keep its
 * transform (`retainSelection`) drops that paint. So a group-painted subtree is
 * pushed wholly into the latest layer any of its members needs; its members that
 * had no reason to move are unaffected, because an element overlapping no
 * backdrop region is in the same place in every layer.
 */
export function planBackdropLayers(
  clone: SVGSVGElement,
  targets: BackdropTarget[]
): BackdropPlan | null {
  if (targets.length === 0) return null;

  const splittable = targets.filter((t) => !hasBarrierAncestor(t.group, clone));
  if (splittable.length === 0) return null;

  const all = Array.from(clone.querySelectorAll("*"));
  const order = new Map<Element, number>();
  all.forEach((el, i) => order.set(el, i));

  const keyed = all.filter((el) => el.hasAttribute("data-element-id"));
  const keyedSet = new Set(keyed);
  const targetOrder = splittable.map((t) => order.get(t.group) ?? -1);

  // Paint-order floor: past the last backdrop at or before this element. A
  // backdrop is in that set for itself — its own content has to land in the layer
  // drawn *after* its blur, or its translucent fill is in the accumulation and
  // gets blurred into itself.
  const floor = new Map<Element, number>();
  for (const el of keyed) {
    const at = order.get(el)!;
    let need = 0;
    for (let i = 0; i < targetOrder.length; i++) {
      if (targetOrder[i] >= 0 && targetOrder[i] <= at) need = i + 1;
    }
    floor.set(el, need);
  }

  // Deepest requirement anywhere under each node, children before parents.
  const sub = new Map<Element, number>();
  for (let i = all.length - 1; i >= 0; i--) {
    const el = all[i];
    const m = Math.max(keyedSet.has(el) ? floor.get(el)! : 0, sub.get(el) ?? 0);
    sub.set(el, m);
    const parent = el.parentElement;
    if (parent) sub.set(parent, Math.max(sub.get(parent) ?? 0, m));
  }

  const buckets = new Map<string, number>();
  let highest = 0;
  const stack: Array<{ el: Element; inherited: number }> = [{ el: clone, inherited: 0 }];
  while (stack.length > 0) {
    const { el, inherited } = stack.pop()!;
    const forced = blocksLayerSplit(el) ? Math.max(inherited, sub.get(el) ?? 0) : inherited;
    const layer = Math.max(keyedSet.has(el) ? floor.get(el)! : 0, forced);
    const id = el.getAttribute("data-element-id");
    if (id) {
      buckets.set(id, layer);
      if (layer > highest) highest = layer;
    }
    for (let child = el.lastElementChild; child; child = child.previousElementSibling) {
      stack.push({ el: child, inherited: forced });
    }
  }

  return { targets: splittable, buckets, layerCount: highest + 1 };
}

export function allowedIdsForBucket(plan: BackdropPlan, layer: number): Set<string> {
  const ids = new Set<string>();
  for (const [id, bucket] of plan.buckets) if (bucket === layer) ids.add(id);
  return ids;
}

/**
 * Element-local coordinates -> device pixels of an export canvas.
 *
 * The clone is detached, so `getCTM()` is unavailable and the transform is
 * composed from the attribute list. The renderer only ever writes `translate`
 * and `rotate`, both of which `consolidate()` handles; the string fallback exists
 * for environments with no SVG transform list.
 */
export function deviceMatrix(target: BackdropTarget, originX: number, originY: number, scale: number): DOMMatrix {
  let m = new DOMMatrix();
  for (let node: Element | null = target.group; node && node.tagName !== "svg"; node = node.parentElement) {
    const local = transformOf(node);
    if (local) m = local.multiply(m);
  }
  return new DOMMatrix()
    .translate(-originX, -originY)
    .scale(scale)
    .multiply(m)
    .translate(target.x, target.y);
}

export function targetClipPath(target: BackdropTarget): Path2D {
  return new Path2D(target.clipPathD ?? `M0,0 H${target.width} V${target.height} H0 Z`);
}

/** A box in the target's own space, for cropping a bake. */
export function targetBox(target: BackdropTarget): { x: number; y: number; width: number; height: number } {
  return { x: target.x, y: target.y, width: target.width, height: target.height };
}

/**
 * `ctx.filter` resolves lengths against the destination canvas, and the chain
 * the renderer wrote resolves them against SVG user space. No transform in the
 * canvas pipeline scales, but the export scale does, so the radius is restated
 * rather than copied.
 */
export function scaledCanvasFilter(css: string, scale: number): string {
  if (scale === 1) return css;
  return css.replace(PX_LENGTH, (_, n: string) => `${parseFloat(n) * scale}px`);
}

export function supportsCanvasFilter(): boolean {
  if (typeof document === "undefined") return false;
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return false;
  ctx.filter = "blur(2px)";
  const ok = ctx.filter === "blur(2px)";
  ctx.filter = "none";
  return ok;
}

/**
 * Stand the blurred backdrops back up as clipped bitmaps.
 *
 * A raster bake is the only form of this effect that survives outside a browser:
 * `backdrop-filter` is honoured by nothing that reads an SVG file, and a
 * `<foreignObject>` is honoured by nothing at all. The backdrop is blurred, so
 * nothing vector is lost that the eye could resolve.
 */
export function insertBakedBackdrops(
  clone: SVGSVGElement,
  plan: BackdropPlan,
  patches: Map<string, { uri: string; x: number; y: number; width: number; height: number }>
): void {
  const defs = clone.querySelector("defs");
  if (!defs) return;

  plan.targets.forEach((target, i) => {
    const patch = patches.get(target.id);
    if (!patch) return;
    const clipId = `bd_clip_${target.id}_${i}`;
    const matrix = deviceMatrix(target, 0, 0, 1);

    const clip = clone.ownerDocument.createElementNS(SVG_NS, "clipPath");
    clip.setAttribute("id", clipId);
    clip.setAttribute("clipPathUnits", "userSpaceOnUse");
    const shape = clone.ownerDocument.createElementNS(SVG_NS, "path");
    shape.setAttribute("d", target.clipPathD ?? `M0,0 H${target.width} V${target.height} H0 Z`);
    shape.setAttribute("transform", `translate(${target.x}, ${target.y})`);
    clip.appendChild(shape);
    defs.appendChild(clip);

    const holder = clone.ownerDocument.createElementNS(SVG_NS, "g");
    holder.setAttribute("transform", `matrix(${matrix.a} ${matrix.b} ${matrix.c} ${matrix.d} ${matrix.e} ${matrix.f})`);
    holder.setAttribute("clip-path", `url(#${clipId})`);

    const image = clone.ownerDocument.createElementNS(SVG_NS, "image");
    image.setAttribute("href", patch.uri);
    image.setAttribute("x", String(patch.x));
    image.setAttribute("y", String(patch.y));
    image.setAttribute("width", String(patch.width));
    image.setAttribute("height", String(patch.height));
    image.setAttribute("preserveAspectRatio", "none");
    holder.appendChild(image);

    // Where the div was: first child, so it stays behind the element's own paint.
    target.group.insertBefore(holder, target.group.firstChild);
  });
}

/**
 * Paint that cannot survive being drawn in two different rasters.
 *
 * Opacity, a filter, a mask and a blend mode all resolve against whatever is
 * already on the canvas beneath the group, so two halves of one group composite
 * to something other than the whole. A clip is different in a way that is easy to
 * get backwards: `retainSelection` unwraps a doomed node into a bare `<g>` that
 * keeps only its `transform`, but it only ever unwraps nodes that carry a
 * `data-element-id`. A clip sitting on an unkeyed group — which is where a frame
 * puts it, on the `<g>` that wraps its children — is copied into every layer
 * whole, and clips each one to the same region. Treating it as a blocker cost
 * every frosted panel inside a clipping frame its blur.
 */
function blocksLayerSplit(el: Element): boolean {
  if (el.tagName === "svg" || el.tagName === "foreignObject") return false;
  const opacity = el.getAttribute("opacity");
  if (opacity !== null && parseFloat(opacity) < 1) return true;
  if (el.getAttribute("filter")) return true;
  if (el.getAttribute("mask")) return true;
  if (el.getAttribute("clip-path") && el.hasAttribute("data-element-id")) return true;
  return blendModeIsLive(el.getAttribute("style"));
}

/**
 * Whether the element asks for a blend other than the default.
 *
 * Written as a capture rather than `mix-blend-mode\s*:\s*(?!normal\b)`: a negative
 * lookahead after `\s*` is satisfied by backtracking that `\s*` to zero width, so
 * the lookahead then sees the space and the test passes for `normal` too. Since
 * the renderer puts `mix-blend-mode: normal` on every element group, that mistake
 * marks the entire tree as unsplittable and silently drops every nested frosted
 * panel from the export while the top-level ones keep working.
 */
export function blendModeIsLive(style: string | null): boolean {
  if (!style) return false;
  const declared = /mix-blend-mode\s*:\s*([^;]+)/i.exec(style);
  if (!declared) return false;
  const value = declared[1].trim().toLowerCase();
  return value !== "normal" && value !== "inherit" && value !== "initial" && value !== "unset";
}

function hasBarrierAncestor(group: Element, root: Element): boolean {
  for (let node = group.parentElement; node && node !== root; node = node.parentElement) {
    if (blocksLayerSplit(node)) return true;
  }
  return false;
}

function transformOf(el: Element): DOMMatrix | null {
  const list = (el as SVGGElement).transform;
  const consolidated = list?.baseVal?.consolidate?.();
  // `consolidate()` hands back the legacy `SVGMatrix`, which `DOMMatrix.multiply`
  // refuses. Only reachable once a backdrop sits under something that carries a
  // transform, which is why a top-level panel exports fine either way.
  if (consolidated) return DOMMatrix.fromMatrix(consolidated.matrix);
  return parseTransform(el.getAttribute("transform"));
}

const TRANSLATE = /translate\(\s*(-?[\d.e+-]+)[ ,]+(-?[\d.e+-]+)\s*\)/;
const ROTATE = /rotate\(\s*(-?[\d.e+-]+)(?:[ ,]+(-?[\d.e+-]+)[ ,]+(-?[\d.e+-]+))?\s*\)/;

function parseTransform(value: string | null): DOMMatrix | null {
  if (!value) return null;
  let m = new DOMMatrix();
  let found = false;
  const t = TRANSLATE.exec(value);
  if (t) {
    m = m.translate(parseFloat(t[1]), parseFloat(t[2]));
    found = true;
  }
  const r = ROTATE.exec(value);
  if (r) {
    m = new DOMMatrix()
      .translate(r[2] ? parseFloat(r[2]) : 0, r[3] ? parseFloat(r[3]) : 0)
      .rotate(parseFloat(r[1]))
      .translate(r[2] ? -parseFloat(r[2]) : 0, r[3] ? -parseFloat(r[3]) : 0)
      .multiply(m);
    found = true;
  }
  return found ? m : null;
}

function inlineStyle(el: Element): Record<string, string> {
  const out: Record<string, string> = {};
  const attr = el.getAttribute("style");
  if (!attr) return out;
  for (const decl of attr.split(";")) {
    const sep = decl.indexOf(":");
    if (sep <= 0) continue;
    out[decl.slice(0, sep).trim().toLowerCase()] = decl.slice(sep + 1).trim();
  }
  return out;
}

function numAttr(el: Element, name: string): number {
  const v = parseFloat(el.getAttribute(name) || "");
  return Number.isFinite(v) ? v : 0;
}
