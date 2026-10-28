/**
 * Bake the perspective tilt into a bitmap for raster export.
 *
 * The PNG path rasterizes through an SVG-as-`<img>` decode, and Chromium
 * flattens CSS 3D transforms on SVG elements to an affine approximation there
 * (measured: a 30°-tilted card decodes as a skewed parallelogram) — while
 * static SVG cannot carry a projective transform in any form. So the tilt
 * cannot ship as markup: each tilted layer's flat artwork is rasterized once
 * and warped through the exact closed-form inverse homography per output pixel,
 * then embedded as an image at the projected bounds.
 */

import { DesignDocument, DesignElement, getActivePage } from "./dsl/types";
import { pruneUnusedDefs } from "./export-defs";
import { findElementById } from "./geometry/tree-ops";

const SVG_NS = "http://www.w3.org/2000/svg";

export interface TiltParams {
  ax: number; // radians, about X
  ay: number; // radians, about Y
  d: number; // viewing distance px
}

function tiltOf(el: DesignElement | null, g: SVGGElement): TiltParams | null {
  let rx = el?.rotateX || 0;
  let ry = el?.rotateY || 0;
  let d = el?.perspective && el.perspective > 0 ? el.perspective : 800;
  if (!rx && !ry) {
    const style = g.getAttribute("data-tilt-style") || "";
    const mx = /rotateX\(\s*(-?[\d.]+)deg\s*\)/.exec(style);
    const my = /rotateY\(\s*(-?[\d.]+)deg\s*\)/.exec(style);
    const mp = /perspective\(\s*([\d.]+)px\s*\)/.exec(style);
    if (mx) rx = parseFloat(mx[1]) || 0;
    if (my) ry = parseFloat(my[1]) || 0;
    if (mp) {
      const pd = parseFloat(mp[1]);
      if (pd > 0) d = pd;
    }
  }
  if (!rx && !ry) return null;
  return { ax: (rx * Math.PI) / 180, ay: (ry * Math.PI) / 180, d };
}

function boxOf(el: DesignElement | null, g: SVGGElement): { bx: number; by: number; bw: number; bh: number } | null {
  const attr = (name: string): number => parseFloat(g.getAttribute(name) || "");
  const ax = attr("data-tilt-x");
  const ay = attr("data-tilt-y");
  const aw = attr("data-tilt-width");
  const ah = attr("data-tilt-height");
  const bx = Number.isFinite(ax) ? ax : el?.x;
  const by = Number.isFinite(ay) ? ay : el?.y;
  const bw = Number.isFinite(aw) && aw > 0 ? aw : el ? Math.max(1, el.width) : NaN;
  const bh = Number.isFinite(ah) && ah > 0 ? ah : el ? Math.max(1, el.height) : NaN;
  if (![bx, by, bw, bh].every(Number.isFinite)) return null;
  return { bx: bx!, by: by!, bw, bh };
}

function stripTiltAttrs(el: Element): void {
  el.removeAttribute("data-tilt-flat");
  el.removeAttribute("data-tilt-style");
  el.removeAttribute("data-tilt-x");
  el.removeAttribute("data-tilt-y");
  el.removeAttribute("data-tilt-width");
  el.removeAttribute("data-tilt-height");
}

/**
 * The projection the tilt wrapper paints, pivot at the box centre. Validated
 * against Chromium's own `perspective() rotateX() rotateY()` composition to
 * 0.1px (corner markers, measured): rotateY first, then rotateX, then the
 * perspective divide with `w = 1 - z/d`.
 */
export function makeProjector(bx: number, by: number, bw: number, bh: number, t: TiltParams) {
  const cx = bx + bw / 2;
  const cy = by + bh / 2;
  const cosY = Math.cos(t.ay);
  const sinY = Math.sin(t.ay);
  const cosX = Math.cos(t.ax);
  const sinX = Math.sin(t.ax);
  return (x: number, y: number): [number, number] => {
    const lx = x - cx;
    const ly = y - cy;
    const x1 = lx * cosY;
    const z1 = -lx * sinY;
    const y1 = ly * cosX - z1 * sinX;
    const z2 = ly * sinX + z1 * cosX;
    const denom = t.d - z2;
    if (denom < 1) return [NaN, NaN];
    const s = t.d / denom;
    return [cx + x1 * s, cy + y1 * s];
  };
}

/**
 * Exact closed-form inverse of `makeProjector` (adjugate of the lower-triangular
 * 3x3 homography `H = P(d) * Rx(ax) * Ry(ay)`). Maps a projected point `(xp, yp)`
 * back to its flat parent-space point `(x, y)`.
 */
export function makeInverseProjector(bx: number, by: number, bw: number, bh: number, t: TiltParams) {
  const cx = bx + bw / 2;
  const cy = by + bh / 2;
  const cosY = Math.cos(t.ay);
  const sinY = Math.sin(t.ay);
  const cosX = Math.cos(t.ax);
  const sinX = Math.sin(t.ax);
  const det = cosX * cosY;
  if (Math.abs(det) < 1e-9) return (): [number, number] => [NaN, NaN];
  const pu = cosX / det;
  const qu = (-sinY * sinX) / det;
  const qv = cosY / det;
  const wu = -sinY / (t.d * det);
  const wv = (cosY * sinX) / (t.d * det);
  const minW = 1 / t.d;
  return (xp: number, yp: number): [number, number] => {
    const u = xp - cx;
    const v = yp - cy;
    const w = 1 + wu * u + wv * v;
    if (w < minW) return [NaN, NaN];
    const invW = 1 / w;
    return [cx + pu * u * invW, cy + (qu * u + qv * v) * invW];
  };
}

export interface WarpGeometry {
  bx: number;
  by: number;
  bw: number;
  bh: number;
  pl: number;
  pt: number;
  ox: number;
  oy: number;
  k: number;
  tilt: TiltParams;
}

/**
 * Continuous per-pixel inverse homography with alpha-weighted bilinear filtering.
 *
 * Why not a subdivided affine `ctx.clip()` + `ctx.drawImage()` grid: Canvas 2D
 * antialiases the un-dilated `drawImage` sub-rectangle edges under a slanted
 * transform (two abutting 50%-coverage edges composite to 75% alpha, leaving a
 * 25% transparent crack along every grid line) and a 3-point affine leaves the
 * 4th quad corner open. Sampling the continuous inverse projection directly
 * eliminates all subdivision seams and avoids thousands of polygon clip masks.
 */
export function warpProjective(
  srcPixels: Uint8ClampedArray,
  srcW: number,
  srcH: number,
  outPixels: Uint8ClampedArray,
  outW: number,
  outH: number,
  geom: WarpGeometry
): void {
  const { bx, by, bw, bh, pl, pt, ox, oy, k, tilt } = geom;
  const cosY = Math.cos(tilt.ay);
  const sinY = Math.sin(tilt.ay);
  const cosX = Math.cos(tilt.ax);
  const sinX = Math.sin(tilt.ax);
  const det = cosX * cosY;
  if (Math.abs(det) < 1e-9 || srcW < 2 || srcH < 2) return;

  const cx = bx + bw / 2;
  const cy = by + bh / 2;
  const pu = cosX / det;
  const qu = (-sinY * sinX) / det;
  const qv = cosY / det;
  const wu = -sinY / (tilt.d * det);
  const wv = (cosY * sinX) / (tilt.d * det);

  const du = 1 / k;
  const dv = 1 / k;
  const u0 = ox - cx + 0.5 * du;
  const v0 = oy - cy + 0.5 * dv;
  const cxSrc = (cx - pl) * k - 0.5;
  const cySrc = (cy - pt) * k - 0.5;

  const dWx = wu * du;
  const dAx = cxSrc * dWx + pu * k * du;
  const dBx = cySrc * dWx + qu * k * du;
  const minW = 1 / tilt.d;
  const maxSx = srcW - 1.000001;
  const maxSy = srcH - 1.000001;

  const src32 = new Uint32Array(srcPixels.buffer, srcPixels.byteOffset, srcW * srcH);
  const out32 = new Uint32Array(outPixels.buffer, outPixels.byteOffset, outW * outH);

  for (let py = 0; py < outH; py++) {
    const v = v0 + py * dv;
    const wRow = 1 + wu * u0 + wv * v;
    const aRow = cxSrc * wRow + pu * k * u0;
    const bRow = cySrc * wRow + qu * k * u0 + qv * k * v;

    // Solve the 5 linear bounds inequalities in `px` once per scanline so the
    // inner loop only visits pixels that land inside `[0, srcW - 1) × [0, srcH - 1)`.
    let lo = 0;
    let hi = outW - 1;
    let c0 = wRow - minW;
    let c1 = dWx;
    if (c1 > 1e-12) lo = Math.max(lo, Math.ceil(-c0 / c1));
    else if (c1 < -1e-12) hi = Math.min(hi, Math.floor(-c0 / c1));
    else if (c0 < 0) continue;

    c0 = aRow;
    c1 = dAx;
    if (c1 > 1e-12) lo = Math.max(lo, Math.ceil(-c0 / c1));
    else if (c1 < -1e-12) hi = Math.min(hi, Math.floor(-c0 / c1));
    else if (c0 < 0) continue;

    c0 = maxSx * wRow - aRow;
    c1 = maxSx * dWx - dAx;
    if (c1 > 1e-12) lo = Math.max(lo, Math.ceil(-c0 / c1));
    else if (c1 < -1e-12) hi = Math.min(hi, Math.floor(-c0 / c1));
    else if (c0 < 0) continue;

    c0 = bRow;
    c1 = dBx;
    if (c1 > 1e-12) lo = Math.max(lo, Math.ceil(-c0 / c1));
    else if (c1 < -1e-12) hi = Math.min(hi, Math.floor(-c0 / c1));
    else if (c0 < 0) continue;

    c0 = maxSy * wRow - bRow;
    c1 = maxSy * dWx - dBx;
    if (c1 > 1e-12) lo = Math.max(lo, Math.ceil(-c0 / c1));
    else if (c1 < -1e-12) hi = Math.min(hi, Math.floor(-c0 / c1));
    else if (c0 < 0) continue;

    if (lo > hi) continue;

    let w = wRow + lo * dWx;
    let a = aRow + lo * dAx;
    let b = bRow + lo * dBx;
    let outIdx = py * outW + lo;

    for (let px = lo; px <= hi; px++, outIdx++) {
      const invW = 1 / w;
      const sx = a * invW;
      const sy = b * invW;
      w += dWx;
      a += dAx;
      b += dBx;

      const x0 = sx | 0;
      const y0 = sy | 0;
      if (x0 < 0 || x0 >= srcW - 1 || y0 < 0 || y0 >= srcH - 1) continue;

      const idx = y0 * srcW + x0;
      const c00 = src32[idx];
      const c10 = src32[idx + 1];
      const c01 = src32[idx + srcW];
      const c11 = src32[idx + srcW + 1];

      if ((c00 | c10 | c01 | c11) === 0) continue;
      if (c00 === c10 && c00 === c01 && c00 === c11) {
        out32[outIdx] = c00;
        continue;
      }

      const fx = ((sx - x0) * 256 + 0.5) | 0;
      const fy = ((sy - y0) * 256 + 0.5) | 0;
      const ifx = 256 - fx;
      const ify = 256 - fy;
      const w00 = ifx * ify;
      const w10 = fx * ify;
      const w01 = ifx * fy;
      const w11 = fx * fy;

      if (((c00 & c10 & c01 & c11) >>> 24) === 255) {
        const r =
          ((c00 & 0xff) * w00 +
            (c10 & 0xff) * w10 +
            (c01 & 0xff) * w01 +
            (c11 & 0xff) * w11 +
            32768) >>>
          16;
        const g =
          (((c00 >>> 8) & 0xff) * w00 +
            ((c10 >>> 8) & 0xff) * w10 +
            ((c01 >>> 8) & 0xff) * w01 +
            ((c11 >>> 8) & 0xff) * w11 +
            32768) >>>
          16;
        const bl =
          (((c00 >>> 16) & 0xff) * w00 +
            ((c10 >>> 16) & 0xff) * w10 +
            ((c01 >>> 16) & 0xff) * w01 +
            ((c11 >>> 16) & 0xff) * w11 +
            32768) >>>
          16;
        out32[outIdx] = (0xff000000 | (bl << 16) | (g << 8) | r) >>> 0;
        continue;
      }

      const a00 = c00 >>> 24;
      const a10 = c10 >>> 24;
      const a01 = c01 >>> 24;
      const a11 = c11 >>> 24;
      const wa00 = w00 * a00;
      const wa10 = w10 * a10;
      const wa01 = w01 * a01;
      const wa11 = w11 * a11;
      const aSum = wa00 + wa10 + wa01 + wa11;
      if (aSum === 0) continue;

      const alpha = (aSum + 32768) >>> 16;
      const invA = 1 / aSum;
      const r =
        (((c00 & 0xff) * wa00 +
          (c10 & 0xff) * wa10 +
          (c01 & 0xff) * wa01 +
          (c11 & 0xff) * wa11) *
          invA +
          0.5) |
        0;
      const g =
        ((((c00 >>> 8) & 0xff) * wa00 +
          ((c10 >>> 8) & 0xff) * wa10 +
          ((c01 >>> 8) & 0xff) * wa01 +
          ((c11 >>> 8) & 0xff) * wa11) *
          invA +
          0.5) |
        0;
      const bl =
        ((((c00 >>> 16) & 0xff) * wa00 +
          ((c10 >>> 16) & 0xff) * wa10 +
          ((c01 >>> 16) & 0xff) * wa01 +
          ((c11 >>> 16) & 0xff) * wa11) *
          invA +
          0.5) |
        0;
      out32[outIdx] = ((alpha << 24) | (bl << 16) | (g << 8) | r) >>> 0;
    }
  }
}

function loadImage(xml: string): Promise<HTMLImageElement> {
  const blob = new Blob([xml], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const img = new Image();
  return new Promise<HTMLImageElement>((resolve, reject) => {
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("tilt bake: artwork raster decode failed"));
    img.src = url;
  }).finally(() => URL.revokeObjectURL(url));
}

/** Margin around the flat box the bake raster must cover, per side. */
interface Pad { left: number; top: number; right: number; bottom: number }

/**
 * The exact paint extent, read off the layer's own `<filter>` region rather
 * than re-estimated: `computeFilterRegion` already padded for every shadow,
 * spread and stroke when the def was emitted, and its coordinates are in the
 * same parent space as the flat box. No filter — a minimal bleed for strokes.
 */
function bakePad(svg: SVGSVGElement, g: SVGGElement, bx: number, by: number, bw: number, bh: number): Pad {
  const min: Pad = { left: 8, top: 8, right: 8, bottom: 8 };
  const filterAttr = g.getAttribute("filter") || (g.querySelector("[filter]") as SVGGElement | null)?.getAttribute("filter");
  const id = filterAttr?.match(/url\(#([^)]+)\)/)?.[1];
  if (!id) return min;
  // ids are engine-generated (`filter_<elid>`), no need for CSS escaping
  const def = svg.querySelector(`defs #${id}`);
  if (!def) return min;
  const rx = parseFloat(def.getAttribute("x") || "");
  const ry = parseFloat(def.getAttribute("y") || "");
  const rw = parseFloat(def.getAttribute("width") || "");
  const rh = parseFloat(def.getAttribute("height") || "");
  if (![rx, ry, rw, rh].every(Number.isFinite)) return min;
  return {
    left: Math.max(min.left, bx - rx),
    top: Math.max(min.top, by - ry),
    right: Math.max(min.right, rx + rw - (bx + bw)),
    bottom: Math.max(min.bottom, ry + rh - (by + bh))
  };
}

function tiltNestingDepth(g: Element): number {
  let depth = 0;
  for (let p = g.parentElement; p; p = p.parentElement) {
    if (p.hasAttribute("data-tilt-flat")) depth++;
  }
  return depth;
}

export async function bakeTiltedElements(svg: SVGSVGElement, doc: DesignDocument, scale: number): Promise<void> {
  const flats = Array.from(svg.querySelectorAll<SVGGElement>("[data-tilt-flat]"));
  if (flats.length === 0) return;
  const activePage = getActivePage(doc);
  const serializer = new XMLSerializer();
  const k = Math.min(4, Math.max(2, scale));

  const bakeOne = async (g: SVGGElement): Promise<void> => {
    const elId = g.getAttribute("data-tilt-flat") || "";
    const el = elId ? findElementById(activePage.children, elId) : null;
    const t = tiltOf(el, g);
    const box = boxOf(el, g);
    if (!t || !box) {
      stripTiltAttrs(g);
      return;
    }

    const { bx, by, bw, bh } = box;
    const pad = bakePad(svg, g, bx, by, bw, bh);
    const project = makeProjector(bx, by, bw, bh, t);

    // Snap both the flat source box and the projected destination box outward
    // to the `1 / k` pixel grid so `srcW = fw * k` and `outW = ow * k` are exact
    // integers without aspect-ratio stretch or subpixel resampling offsets.
    const pl0 = Math.floor((bx - pad.left) * k);
    const pt0 = Math.floor((by - pad.top) * k);
    const srcW = Math.max(2, Math.ceil((bx + bw + pad.right) * k) - pl0);
    const srcH = Math.max(2, Math.ceil((by + bh + pad.bottom) * k) - pt0);
    const pl = pl0 / k;
    const pt = pt0 / k;
    const fw = srcW / k;
    const fh = srcH / k;
    const pr = pl + fw;
    const pb = pt + fh;

    const corners = [
      project(pl, pt),
      project(pr, pt),
      project(pr, pb),
      project(pl, pb)
    ];
    if (corners.some((p) => !isFinite(p[0]) || !isFinite(p[1]))) {
      stripTiltAttrs(g);
      return;
    }
    const minX = Math.min(...corners.map((p) => p[0]));
    const maxX = Math.max(...corners.map((p) => p[0]));
    const minY = Math.min(...corners.map((p) => p[1]));
    const maxY = Math.max(...corners.map((p) => p[1]));
    const ox0 = Math.floor(minX * k);
    const oy0 = Math.floor(minY * k);
    const outW = Math.max(1, Math.ceil(maxX * k) - ox0);
    const outH = Math.max(1, Math.ceil(maxY * k) - oy0);
    const ox = ox0 / k;
    const oy = oy0 / k;
    const ow = outW / k;
    const oh = outH / k;

    const standalone = document.createElementNS(SVG_NS, "svg");
    standalone.setAttribute("xmlns", SVG_NS);
    standalone.setAttribute("viewBox", `${pl} ${pt} ${fw} ${fh}`);
    standalone.setAttribute("width", String(srcW));
    standalone.setAttribute("height", String(srcH));
    const defs = svg.querySelector("defs");
    if (defs) standalone.appendChild(defs.cloneNode(true));
    const artwork = g.cloneNode(true) as SVGElement;
    stripTiltAttrs(artwork);
    standalone.appendChild(artwork);
    // Drop unrelated page `<pattern>` images, filters, and unused `@font-face`
    // blocks before serializing so each tilted layer only decodes its own defs.
    pruneUnusedDefs(standalone);
    if (!standalone.querySelector("text")) {
      standalone.querySelector("style[data-export-fonts]")?.remove();
    }

    let srcImg: HTMLImageElement;
    try {
      srcImg = await loadImage(serializer.serializeToString(standalone));
    } catch {
      stripTiltAttrs(g);
      return;
    }

    const srcCanvas = document.createElement("canvas");
    srcCanvas.width = srcW;
    srcCanvas.height = srcH;
    const sctx = srcCanvas.getContext("2d");
    const out = document.createElement("canvas");
    out.width = outW;
    out.height = outH;
    const ctx = out.getContext("2d");
    if (!sctx || !ctx) {
      stripTiltAttrs(g);
      return;
    }

    sctx.imageSmoothingEnabled = true;
    sctx.imageSmoothingQuality = "high";
    sctx.drawImage(srcImg, 0, 0, srcW, srcH);
    const srcData = sctx.getImageData(0, 0, srcW, srcH);
    const outData = ctx.createImageData(outW, outH);

    warpProjective(srcData.data, srcW, srcH, outData.data, outW, outH, {
      bx,
      by,
      bw,
      bh,
      pl,
      pt,
      ox,
      oy,
      k,
      tilt: t
    });

    ctx.putImageData(outData, 0, 0);

    const img = document.createElementNS(SVG_NS, "image");
    img.setAttribute("x", String(ox));
    img.setAttribute("y", String(oy));
    img.setAttribute("width", String(ow));
    img.setAttribute("height", String(oh));
    img.setAttribute("preserveAspectRatio", "none");
    img.setAttribute("href", out.toDataURL("image/png"));
    g.replaceWith(img);
  };

  // Process nested tilted elements inner-first; siblings at the same depth run
  // concurrently so multiple tilted layers decode their SVGs in parallel.
  const byDepth = new Map<number, SVGGElement[]>();
  for (const g of flats) {
    const d = tiltNestingDepth(g);
    const list = byDepth.get(d) || [];
    list.push(g);
    byDepth.set(d, list);
  }
  const depths = Array.from(byDepth.keys()).sort((a, b) => b - a);
  for (const d of depths) {
    await Promise.all((byDepth.get(d) || []).map(bakeOne));
  }

  // Re-prune the outer SVG so `<pattern>` / `<filter>` defs consumed only by
  // the now-baked tilted layers are not serialized and decoded a second time.
  pruneUnusedDefs(svg);
}
