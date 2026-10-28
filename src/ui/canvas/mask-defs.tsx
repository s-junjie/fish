import {
  DesignElement,
  Paint,
  PaintStack,
  TextElement,
  PathElement,
  RectElement
} from "../../core/dsl/types";
import { getShapeLocalPath, isGradientPaint } from "../../core/geometry/gradient-utils";
import { rectToPathData } from "../../core/compile";
import { paintLayerIndex, topPaint } from "../../core/dsl/paint-stack";
import { elementPivot } from "../../core/geometry/transforms";
import {
  identityMatrix,
  matrixToSvg,
  multiply,
  rotationAroundDeg,
  translation,
  type Matrix2D
} from "../../core/geometry/matrix";
import { resolvedPaintStack, type InstanceBox } from "../../core/interactions/instance-inherit";
import { CANVAS_MASK_KEEP } from "./canvas-colors";
import { resolveStack } from "../../core/font-stack";

/** White in, alpha through: the alpha row `0 0 0 1 0` is the identity on A. */
const ALPHA_TO_LUMINANCE = "0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 1 0";

/**
 * A luminance mask read as its negative: each channel flipped, which flips the
 * brightness (`luminance(1 - c)` is `1 - luminance(c)`), with alpha left alone —
 * the layer still masks only where it paints.
 *
 * Luminance is the only channel `invert` means anything for. Inverted ALPHA
 * would reveal everything the layer does NOT paint, which in a mask is a region
 * nobody asked for rather than a shape; `alpha` mode is left as it is, and the
 * panel does not offer the switch there.
 */
const LUMINANCE_INVERT = "-1 0 0 0 1  0 -1 0 0 1  0 0 -1 0 1  0 0 0 1 0";

/** Whether this mask reads its paint as a negative. Luminance mode only. */
function isInverted(el: DesignElement): boolean {
  return el.maskInvert === true && (el.maskMode ?? "alpha") === "luminance";
}

export interface MaskDefOptions {
  /** The element's RESOLVED box. Null for anything that is not an instance. */
  box: InstanceBox | null;
  /**
   * The element's resolved fill stack — the same array the gradient and pattern
   * defs are indexed against, because a mask layer is looked up by layer
   * position and a filtered index points at the wrong def.
   */
  fills: PaintStack;
}

/**
 * A mask's silhouette, flattened to one matrix per leaf.
 *
 * A `<clipPath>` cannot nest a `<g>` to carry a transform — Chromium draws
 * nothing for one — so the chain is composed into a matrix on the leaf instead
 * of spelled as nested groups. The same walk feeds both defs, which is what
 * keeps a `<mask>` and the `<clipPath>` that replaces it from drifting apart.
 */
interface MaskShape {
  d: string;
  m: Matrix2D;
  clipRule?: "evenodd" | "nonzero";
}

/**
 * `translate(el.x, el.y) rotate(rot, w/2, h/2)` as one matrix — the pair
 * `elementTransform` puts on a node's group and its inner translate, composed in
 * the order the renderer applies them.
 *
 * The rotation is about the element's own centre, which is the pivot relative to
 * its origin once the translate has run. Composing the other way round — the
 * translate outside a rotation about the ABSOLUTE pivot — displaces a rotated
 * child by its own `x`/`y`, which is what a mask frame of rotated glyphs used to
 * draw: the mask came out offset from the artwork it was masking.
 */
function matOf(el: DesignElement): Matrix2D {
  const pivot = elementPivot(el);
  const translate = translation(el.x, el.y);
  const rot = el.rotation || 0;
  return rot ? multiply(translate, rotationAroundDeg(rot, pivot.x - el.x, pivot.y - el.y)) : translate;
}

/** An instance's silhouette is its RESOLVED box — it has no local path of its
 *  own, and an empty path would make the mask fully transparent and hide the
 *  layers behind it. */
function instanceBoxPath(el: DesignElement, box: InstanceBox | null): string | null {
  if (el.type !== "instance" || !box) return null;
  return rectToPathData({
    width: box.width,
    height: box.height,
    borderRadius: box.borderRadius,
    cornerSmoothing: box.cornerSmoothing
  } as RectElement);
}

/** One element's own silhouette, in its local space. */
function ownGeometry(el: DesignElement, box: InstanceBox | null): MaskShape[] | null {
  const d = instanceBoxPath(el, box) ?? getShapeLocalPath(el);
  if (!d) return null;
  return [{ d, m: identityMatrix(), clipRule: el.type === "path" ? (el as PathElement).fillRule : undefined }];
}

/**
 * A fill-less CONTAINER's own shape: the geometry of everything it draws.
 *
 * Figma masks such a frame by its contents, and that is the idiom behind a
 * tinted icon or gradient text — the frame paints nothing itself, so the layer
 * underneath rides the glyphs. Only GEOMETRY can carry a mask: Chromium paints a
 * path inside a `<mask>` and paints nothing at all for `<text>` or a
 * `foreignObject` there (or in a `clipPath`), and a text node here is a
 * `foreignObject`. So the body is built from each leaf's shape — a text leaf
 * contributing the outline Figma shipped with it (`fillGeometry` → `outline`),
 * which is exact, needs no font, and cannot drift from the design.
 *
 * Returns null when the subtree holds anything that cannot be a shape (an html
 * embed, a video, a text with no outline), because an empty mask would hide the
 * layer beneath it — a worse failure than the outline box this replaces.
 */
function contentsGeometry(el: DesignElement, box: InstanceBox | null): MaskShape[] | null {
  const children = (el as { children?: DesignElement[] }).children;
  if (!children?.length) return null;
  const out: MaskShape[] = [];
  for (const child of children) {
    // An invisible layer draws nothing, so it covers nothing — including
    // itself. It used to null the whole subtree, which fell back to the
    // container's box and masked by a rectangle nothing had asked for.
    if (child.visible === false) continue;
    const sub = shapeGeometry(child, null);
    if (!sub) return null;
    const m = matOf(child);
    for (const s of sub) out.push({ ...s, m: multiply(m, s.m) });
  }
  return out.length > 0 ? out : null;
}

/** One element's silhouette, or null when it has none that can be drawn. */
function shapeGeometry(el: DesignElement, box: InstanceBox | null): MaskShape[] | null {
  if (el.type === "text") {
    // A text node paints through a `foreignObject`, which a mask does not
    // render, so its geometry is the glyph outline Figma shipped with it —
    // exact, font-free, and the same shape the live `<text>` covers.
    const outline = (el as TextElement).outline;
    return outline?.d ? [{ d: outline.d, m: identityMatrix(), clipRule: outline.fillRule }] : null;
  }
  if (el.type === "html" || el.type === "video") return null;
  if ((el as { children?: DesignElement[] }).children?.length) {
    const inner = contentsGeometry(el, null);
    if (inner) return inner;
  }
  return ownGeometry(el, box);
}

/** The geometry a mask draws: its own outline when it paints a fill stack, and
 *  what it contains when it paints nothing. The same choice `maskContent`
 *  makes, kept beside it so the clip and the mask cannot disagree. */
function maskGeometry(el: DesignElement, fills: PaintStack, box: InstanceBox | null): MaskShape[] | null {
  const active = fills.filter((f) => f && f.enabled !== false);
  return active.length > 0 ? ownGeometry(el, box) : shapeGeometry(el, box);
}

/**
 * Whether a mask can be stated as a CLIP rather than a `<mask>`.
 *
 * Chromium makes any element carrying a mask a *backdrop root*, so a
 * `backdrop-filter` inside one samples an empty backdrop and paints nothing: a
 * frosted panel lost its blur the moment a mask layer covered it. A `clip-path`
 * is not a backdrop root — measured, `scratch/probe-backdrop-mask.mjs` — so a
 * mask whose coverage is 0 or 1 everywhere can be restated as one and the
 * backdrop survives.
 *
 * Anything else — a gradient, a photo, a translucent fill, the layer's own
 * opacity, a text with no outline, an instance whose fills are resolved
 * elsewhere — keeps the `<mask>` it has always been.
 */
export function maskLayerBlur(el: DesignElement, box: InstanceBox | null = null): number {
  const effects = (box ? box.effects : el.effects) || [];
  let maxBlur = 0;
  for (const ef of effects) {
    if (ef.enabled === false) continue;
    if (ef.type === "layer-blur" && typeof ef.blur === "number" && ef.blur > maxBlur) {
      maxBlur = ef.blur;
    }
  }
  return maxBlur;
}

export function maskIsClip(el: DesignElement, box: InstanceBox | null = null): boolean {
  return clipShapes(el, box) !== null;
}

function clipShapes(el: DesignElement, box: InstanceBox | null): MaskShape[] | null {
  // A clip states one silhouette; an inverted luminance mask states soft
  // coverage (a gradient read backwards), which no fill-rule can. It stays a
  // `<mask>`, and loses the backdrop-blur pass a clip would have bought.
  if (isInverted(el)) return null;
  if (typeof el.opacity === "number" && el.opacity <= 0) return [];
  if (typeof el.opacity === "number" && el.opacity < 1) return null;
  if (maskLayerBlur(el, box) > 0) return null;
  const fills = resolvedPaintStack(el, box);
  const active = fills.filter((f) => f && f.enabled !== false);
  if (active.length > 0 && active.every((f) => typeof f.opacity === "number" && f.opacity <= 0)) {
    return [];
  }
  // A clip has one coverage. Alpha mode normalizes the content to white with its
  // alpha intact, so an opaque solid is fully on whatever its colour.
  if (!active.every((f) => f.type === "solid" && (f.opacity ?? 1) === 1)) return null;
  // Luminance reads the paint's own brightness instead, where only white is.
  if (el.maskMode === "luminance" && !active.every((f) => f.type === "solid" && String(f.color).toUpperCase() === CANVAS_MASK_KEEP)) {
    return null;
  }
  const geo = maskGeometry(el, fills, box);
  if (!geo) return null;
  const m = matOf(el);
  return geo.map((s) => ({ ...s, m: multiply(m, s.m) }));
}

/**
 * The `<clipPath>` for a mask that {@link maskIsClip} accepts, or null when it
 * has to stay a `<mask>`.
 *
 * `userSpaceOnUse`, like the `<mask>` it replaces and like the `clip_<id>` defs
 * beside it: the region is the referencing element's own space, so the mask
 * lands on the artwork whatever the zoom.
 */
export function maskClipDef(el: DesignElement, box: InstanceBox | null = null): preact.VNode | null {
  const shapes = clipShapes(el, box);
  if (!shapes) return null;
  return (
    <clipPath id={`clip_mask_${el.id}`} clipPathUnits="userSpaceOnUse">
      {shapes.map((s, i) => (
        <path key={i} d={s.d} transform={matrixToSvg(s.m)} clipRule={s.clipRule} />
      ))}
    </clipPath>
  );
}

/**
 * The `<mask>` for a layer with `isMask`.
 *
 * The content is the element's OWN paint — its fill stack, at the same layer
 * indices the renderer uses — so an image fill becomes a mask by being an image.
 * It used to be a hardcoded `#FFFFFF` stencil of the outline, which silently
 * discarded every fill: an image-filled mask revealed 100% of its siblings.
 *
 * `alpha` mode cannot simply paint the image and let SVG do the rest, because
 * `<mask>` is luminance-based: a black pixel would read as fully hidden and a
 * mid-grey as half. So the content is normalized to white with its alpha intact
 * by `maskAlphaFilterDef` below, and luminance × alpha collapses to alpha. The
 * alternative, `mask-type: alpha`, is ignored by enough SVG consumers
 * (Illustrator among them) that an exported file would not match the canvas.
 */
function maskRegion(
  el: DesignElement,
  box: InstanceBox | null = null
): { x: number; y: number; width: number; height: number } {
  const blur = maskLayerBlur(el, box);
  const w = Math.max(64, box ? box.width : el.width || 64);
  const h = Math.max(64, box ? box.height : el.height || 64);
  const rotPad = el.rotation ? Math.ceil(Math.hypot(w, h) * 0.5) : 0;
  // Blur and rotation are what the stencil needs, plus 16px of anti-aliasing
  // slack for a silhouette clipped AT the region, and the reach back to the
  // parent's origin for content built from local coordinates.
  //
  // An inverted LUMINANCE mask needs none of it changed: `brightness × alpha` is
  // zero wherever the layer paints nothing, so the inversion cannot reveal
  // anything outside the region — only the brightness inside it is read
  // backwards.
  const pad = Math.ceil(blur * 2) + rotPad + 16;
  const minX = Math.floor(Math.min(0, el.x) - pad);
  const minY = Math.floor(Math.min(0, el.y) - pad);
  const maxX = Math.ceil(Math.max(w, el.x + w) + pad);
  const maxY = Math.ceil(Math.max(h, el.y + h) + pad);
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export function maskLayerDef(el: DesignElement, opts: MaskDefOptions): preact.VNode {
  const opacity = typeof el.opacity === "number" ? el.opacity : 1;
  const inverted = isInverted(el);
  const blur = maskLayerBlur(el, opts.box);
  const region = maskRegion(el, opts.box);
  // The stencil turns on the same pivot the artwork does, or a rotated mask
  // stops covering the layer it was masking.
  const pivot = elementPivot(el);
  const filtered = inverted || el.maskMode !== "luminance" || blur > 0;

  return (
    <mask
      id={`mask_layer_${el.id}`}
      maskUnits="userSpaceOnUse"
      x={region.x}
      y={region.y}
      width={region.width}
      height={region.height}
    >
      {/* The filter rides an UNTRANSFORMED group, with the stencil's own translate
          one level in. A `userSpaceOnUse` filter region is read in the user space
          of the element carrying the filter, so hanging it on the translated group
          put the region at the layer's origin TWICE — measured, an inverted mask
          then inverted only part of its paint. Opacity stays out here because a
          filter runs before the opacity of the element it is on — the channel is
          inverted first and scaled second, which is what `opacity` has always
          meant on a mask. */}
      <g opacity={opacity < 1 ? opacity : undefined} filter={filtered ? `url(#maskalpha_${el.id})` : undefined}>
        <g transform={`translate(${el.x}, ${el.y}) rotate(${el.rotation || 0} ${pivot.x - el.x} ${pivot.y - el.y})`}>
          {maskContent(el, opts)}
        </g>
      </g>
    </mask>
  );
}

/**
 * What a mask paints, in the mask element's OWN local space.
 *
 * Shared by both defs: a `<mask>` and the CSS mask a backdrop div wears have to
 * be the same shape, and two builders would be two answers to that question.
 */
function maskContent(el: DesignElement, opts: MaskDefOptions): preact.VNode {
  const { box, fills } = opts;
  const active = fills.filter((f) => f && f.enabled !== false);

  // An instance has no local path of its own — `getShapeLocalPath` returns ""
  // for it, which made every instance mask fully transparent and hid the
  // siblings behind it. Its resolved box is the rectangle, exactly as the
  // instance's own clip path builds it.
  const shapeLocalD = instanceBoxPath(el, box) ?? getShapeLocalPath(el);

  // Index by position in the RESOLVED stack, which is what the gradient and
  // pattern defs are keyed by.
  const layerIndex = (f: Paint, fallback: number): number => paintLayerIndex(fills, f, fallback);

  if (el.type === "text") {
    // Text paints one colour, so the top-most layer wins — the same choice the
    // renderer makes for a text node on canvas. `style.color` is deliberately
    // NOT in the fallback: it is the field an author writes text colour in, not
    // a paint store, and reading it here made a text whose stack said `[]` cut
    // its siblings to black instead of masking by its own glyphs
    // (LESSONS_LEARNED §206).
    const style = (el as TextElement).style;
    const top = topPaint(active);
    const fill =
      (top && top.type === "solid"
        ? top.color
        : top && (isGradientPaint(top))
          ? `url(#grad_fill_${el.id}_${layerIndex(top, 0)})`
          : undefined) ||
      CANVAS_MASK_KEEP;
    return (
      <text
        x={0}
        y={style?.fontSize || 24}
        fontSize={style?.fontSize || 24}
        fontFamily={resolveStack(style?.fontFamily)}
        fontWeight={style?.fontWeight || 400}
        fill={fill}
        fillOpacity={typeof top?.opacity === "number" ? top.opacity : 1}
      >
        {(el as TextElement).content}
      </text>
    );
  }

  if (active.length === 0) {
    // Nothing painted still masks by its OUTLINE, which is what an `isMask` layer
    // with an empty fill stack has always meant — except when the layer is a
    // container that draws something, which is Figma's standard way to write a
    // mask: a fill-less frame of glyphs with the tint under it clipped to them.
    // The frame's box was a lie with a visible consequence, an iOS tab bar's tint
    // arriving as a solid block sitting on top of the icon and the label.
    const geo = shapeGeometry(el, box);
    return geo ? (
      <>
        {geo.map((s, i) => (
          <path key={i} d={s.d} fill={CANVAS_MASK_KEEP} transform={matrixToSvg(s.m)} clipRule={s.clipRule} />
        ))}
      </>
    ) : (
      <path d={shapeLocalD} fill={CANVAS_MASK_KEEP} />
    );
  }

  return (
    <>
      {active.map((f, idx) => {
        let fillVal = "none";
        if (f.type === "solid") {
          fillVal = f.color;
        } else if (isGradientPaint(f)) {
          fillVal = `url(#grad_fill_${el.id}_${layerIndex(f, idx)})`;
        } else if (f.type === "image") {
          fillVal = `url(#pat_${el.id}_${layerIndex(f, idx)})`;
        } else if (f.type === "pattern") {
          fillVal = `url(#pat_${el.id}_${layerIndex(f, idx)})`;
        }
        return (
          <path
            key={idx}
            d={shapeLocalD}
            fill={fillVal}
            fillOpacity={typeof f.opacity === "number" ? f.opacity : 1}
            fillRule={el.type === "path" ? (el as PathElement).fillRule : undefined}
          />
        );
      })}
    </>
  );
}

/**
 * The alpha-to-luminance adapter for one `alpha`-mode mask, or null in
 * `luminance` mode (where the paint's own brightness is the mask and there is
 * nothing to normalize).
 *
 * `userSpaceOnUse` matches the `<mask>` region exactly: a bbox-relative filter
 * region collapses to nothing for a zero-area shape, and the result would be a
 * mask that hides everything.
 */
export function maskAlphaFilterDef(el: DesignElement, box: InstanceBox | null = null): preact.VNode | null {
  const blur = maskLayerBlur(el, box);
  // Luminance needs no adapter: brightness IS the mask — unless it is read as a
  // negative, or blurred, both of which are work this filter has to do.
  const matrix =
    el.maskMode === "luminance" ? (isInverted(el) ? LUMINANCE_INVERT : null) : ALPHA_TO_LUMINANCE;
  if (!matrix && blur <= 0) return null;
  const region = maskRegion(el, box);
  const filterProps = {
    id: `maskalpha_${el.id}`,
    filterUnits: "userSpaceOnUse" as const,
    x: region.x,
    y: region.y,
    width: region.width,
    height: region.height,
    colorInterpolationFilters: "sRGB" as const
  };

  if (!matrix) return <filter {...filterProps}><feGaussianBlur stdDeviation={blur / 2} /></filter>;

  return (
    <filter {...filterProps}>
      {blur > 0 ? (
        <>
          <feColorMatrix type="matrix" values={matrix} result="mask_alpha" />
          <feGaussianBlur in="mask_alpha" stdDeviation={blur / 2} />
        </>
      ) : (
        <feColorMatrix type="matrix" values={matrix} />
      )}
    </filter>
  );
}

/**
 * Resolves the local clip geometry of `maskEl` so a backdrop-filter
 * `<foreignObject>` can be clipped via CSS `clip-path: path(...) margin-box`
 * outside `<g mask="...">` without using CSS `mask-image` (which corrupts
 * Chromium's compositor RenderSurface inside zoomed SVG `<foreignObject>`s).
 */
export function maskBackdropClip(
  maskEl: DesignElement,
  box: InstanceBox | null = null
): { x: number; y: number; width: number; height: number; clipD: string; transform?: string } | null {
  // A clip-path can only say "inside the shape", and an inverted mask keeps by
  // brightness rather than by outline. The backdrop host is skipped rather than
  // clipped the wrong way round; the sibling keeps its own fill and loses the
  // live blur.
  if (isInverted(maskEl)) return null;
  const w = Math.max(1, box ? box.width : maskEl.width);
  const h = Math.max(1, box ? box.height : maskEl.height);
  const clipD = instanceBoxPath(maskEl, box) ?? getShapeLocalPath(maskEl);
  if (!clipD) return null;
  const pivot = elementPivot(maskEl, w, h);
  const transform = maskEl.rotation ? `rotate(${maskEl.rotation} ${pivot.x} ${pivot.y})` : undefined;
  return { x: maskEl.x, y: maskEl.y, width: w, height: h, clipD, transform };
}
