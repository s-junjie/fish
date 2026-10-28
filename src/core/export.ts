import { DesignDocument, getActivePage } from "./dsl/types";
import { convertForeignObjectsToSvg } from "./export-text";
import { EXPORT_CHROME_SELECTOR } from "./chrome-markers";
import { bakeTiltedElements } from "./export-tilt";
import { injectFontFaces, pruneUnusedDefs } from "./export-defs";
import { inlineExternalImages } from "./export-images";
import { wrapLinkedElements } from "./export-links";
import {
  allowedIdsForBucket,
  BackdropPlan,
  BackdropTarget,
  deviceMatrix,
  extractBackdropTargets,
  insertBakedBackdrops,
  planBackdropLayers,
  scaledCanvasFilter,
  supportsCanvasFilter,
  targetClipPath
} from "./export-backdrop";

export { convertForeignObjectsToSvg };

export interface ExportBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ExportOptions {
  scale?: number;
  bounds?: ExportBounds;
  allowedElementIds?: Set<string>;
}

/** A backdrop blurred to a bitmap, in root user-space coordinates. */
export interface BakedBackdrop {
  uri: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PreparedSvg {
  svg: SVGSVGElement;
  /** Null when the document has no splittable backdrop, or the canvas cannot filter. */
  plan: BackdropPlan | null;
}

export interface RasterizedExport {
  canvas: HTMLCanvasElement;
  /** One entry per planned backdrop; consumed by the vector export. */
  backdrops: Map<string, BakedBackdrop>;
}

export async function prepareSvgForExport(
  sourceSvg: SVGSVGElement,
  doc: DesignDocument,
  bounds: ExportBounds,
  scale: number = 1,
  allowedElementIds?: Set<string>
): Promise<PreparedSvg> {
  const clone = sourceSvg.cloneNode(true) as SVGSVGElement;
  clone.removeAttribute("style");
  // The editor's pan and zoom ride a stage group rather than the root's style
  // (see `stageTransform` in CanvasArea — a CSS transform anywhere above the
  // canvas costs it every backdrop blur). It is view state like the style was,
  // so it is unwrapped here too: left in place, every export would come back
  // painted through whatever the canvas happened to be showing.
  for (const stage of Array.from(clone.querySelectorAll("[data-stage-transform='true']"))) {
    stage.replaceWith(...Array.from(stage.childNodes));
  }
  // The root carries the workbench's Tailwind layout classes, which mean
  // nothing outside the app and are noise in a file someone will open.
  clone.removeAttribute("class");
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("width", String(bounds.width * scale));
  clone.setAttribute("height", String(bounds.height * scale));
  clone.setAttribute("viewBox", `${bounds.x} ${bounds.y} ${bounds.width} ${bounds.height}`);

  // Strip edit chrome. `data-hit` is the generous click target under every
  // element: invisible, so a raster never showed it, but in a vector file it is
  // a transparent 10px-stroked sibling that swallows clicks and that an importer
  // would faithfully turn into a shape.
  //
  // The second three are the canvas's own definition of painted chrome
  // (`LIVE_CHROME_SELECTOR` in `CanvasArea.tsx`), which is the set the zoom
  // variable is written onto. Leaving them in shipped a copy of the editor's
  // viewport state — `--fish-zoom: 0.53` and the pan offsets — inside the file,
  // where they mean nothing and cannot be re-derived. The two lists are answers
  // to the same question, so they are spelled from one place.
  const overlays = clone.querySelectorAll(EXPORT_CHROME_SELECTOR);
  overlays.forEach((el) => el.remove());

  // Filter elements if allowedElementIds is specified
  if (allowedElementIds && allowedElementIds.size > 0) {
    retainSelection(clone, allowedElementIds);
  }

  // Restore any attribute suppressed by the live viewport's shadow LOD pass, so
  // an export taken at extreme zoom still carries every authored shadow. Clips
  // need no such pass: `applyBackdropLod` never releases one.
  for (const g of Array.from(clone.querySelectorAll("[data-shadow-chain]"))) {
    const chain = g.getAttribute("data-shadow-chain");
    if (chain) g.setAttribute("filter", chain);
  }

  // Backdrop divs first: they have to leave before the `foreignObject` pass,
  // which would otherwise read one as an empty text run. Pruning runs AFTER
  // that pass: a text paints its fill through CSS on the canvas and through
  // `fill="url(#…)"` once converted, so the def is only reachable at the end.
  const targets = extractBackdropTargets(clone);
  injectFontFaces(clone, doc);

  // Convert HTML foreignObjects to pure SVG elements
  convertForeignObjectsToSvg(clone, doc);
  pruneUnusedDefs(clone);

  // Inlining external http/https image hrefs to data URIs ensures the
  // SVG-as-<img> decode during rasterization (PNG) is not blocked by browser CORS sandbox.
  await inlineExternalImages(clone);

  // The perspective tilt, in every format: markup cannot carry a projection
  // (static SVG has no projective transform, and the SVG-as-`<img>` decode
  // this file rasterizes through flattens CSS 3D on SVG elements to an
  // affine), so each tilted layer re-projects into a bitmap here — the one
  // preparation step all four export entry points share. A tilted layer
  // therefore ships as a baked bitmap; untilted layers stay vector.
  await bakeTiltedElements(clone, doc, scale);

  const plan = targets.length > 0 ? planBackdropLayers(clone, targets) : null;
  // LAST, after the plan is computed. Every pass above decides membership by
  // ancestry, and an `<a>` inserted between a group and the root would change
  // what `retainSelection` and the backdrop plan consider a parent.
  wrapLinkedElements(clone);
  return { svg: clone, plan: plan && supportsCanvasFilter() ? plan : null };
}

/**
 * Attributes that make a node paint itself or its subtree. Dropped off a doomed
 * ancestor: `filter` is its shadow, and `data-shadow-chain` is the same reference
 * the export re-applies after this pass — leave that one and the shadow comes
 * back. `style` carries its blend mode; `mask` and `opacity` are its effects.
 */
const SELF_PAINT_ATTRS = ["filter", "opacity", "mask", "style", "data-shadow-chain", "data-shadow-reach"];

/**
 * Reduce the clone to the selected subtrees.
 *
 * Two things make this harder than deleting every node whose id is not in the
 * set. Instance children paint under derived ids (`<instanceId>_<masterNodeId>`)
 * that the selection — enumerated from the document tree — never mints, so
 * membership has to be decided by ancestry. And a doomed node is frequently an
 * ANCESTOR of a kept one: selecting a card inside a page leaves the page itself
 * doomed. Removing it took the whole subtree with it, so every export of a nested
 * selection produced an empty canvas at the right size — the worst kind of export
 * bug, because nothing errors.
 *
 * So a doomed ancestor stays, as a carrier of the transform chain that gives its
 * children their coordinates, minus everything it paints. Stripping it is a walk
 * and not a `<g>` rebuild because a container's own painting is not on the
 * `[data-element-id]` node: the fill, the hit target and the strokes are CHILD
 * nodes. A rebuild that carried the children over carried the background with
 * them, so every selection taken inside a filled frame or card exported that
 * fill across the whole crop — a transparent-background export that was not
 * transparent.
 *
 * The carrier gives up its `data-element-id` for the same reason the old rebuild
 * did: it is the id the backdrop plan keys layers on and reads as a layer-split
 * barrier (`export-backdrop`), and an ancestor that is not in the selection is
 * neither. Leaving it keyed painted a selected frosted panel twice and cost it
 * its blur.
 */
function retainSelection(clone: SVGSVGElement, allowedElementIds: Set<string>): void {
  const isKept = (el: Element): boolean => {
    const id = el.getAttribute("data-element-id");
    return !!id && allowedElementIds.has(id);
  };

  /** Kept itself, or inside a kept subtree — where every node paints. */
  const survives = (el: Element): boolean => {
    for (let node: Element | null = el; node; node = node.parentElement) {
      if (isKept(node)) return true;
    }
    return false;
  };

  const holdsSurvivor = (el: Element): boolean =>
    survives(el) || Array.from(el.querySelectorAll("[data-element-id]")).some(isKept);

  /** Drop the children that paint `el` itself, keeping only the path to the selection. */
  const stripPaint = (el: Element): void => {
    for (const child of Array.from(el.children)) {
      if (survives(child)) continue;
      if (!holdsSurvivor(child)) {
        child.remove();
        continue;
      }
      if (child.hasAttribute("data-element-id")) {
        for (const name of SELF_PAINT_ATTRS) child.removeAttribute(name);
      }
      stripPaint(child);
    }
  };

  for (const g of Array.from(clone.querySelectorAll("[data-element-id]"))) {
    if (survives(g)) continue;
    if (!holdsSurvivor(g)) {
      g.remove();
      continue;
    }
    for (const name of SELF_PAINT_ATTRS) g.removeAttribute(name);
    stripPaint(g);
    g.removeAttribute("data-element-id");
    g.removeAttribute("data-link");
  }
}

/** One `<img>` decode of the whole document, which is all the no-backdrop path needs. */
export async function rasterizeSvg(
  svg: SVGSVGElement,
  bounds: ExportBounds,
  scale: number
): Promise<HTMLCanvasElement> {
  const serializer = new XMLSerializer();
  const svgStr = serializer.serializeToString(svg);
  const svgBlob = new Blob([svgStr], { type: "image/svg+xml;charset=utf-8" });
  const blobUrl = URL.createObjectURL(svgBlob);

  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = (e) => reject(e);
    img.src = blobUrl;
  });

  const canvas = makeCanvas(bounds, scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    URL.revokeObjectURL(blobUrl);
    throw new Error("Failed to get 2D canvas context");
  }

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  URL.revokeObjectURL(blobUrl);

  return canvas;
}

/**
 * The single raster entry every export goes through.
 */
export async function renderSvgToCanvas(
  prepared: PreparedSvg,
  bounds: ExportBounds,
  scale: number
): Promise<RasterizedExport> {
  if (!prepared.plan) {
    return { canvas: await rasterizeSvg(prepared.svg, bounds, scale), backdrops: new Map() };
  }
  return await rasterizeLayered(prepared, bounds, scale, prepared.plan);
}

/**
 * Replay the paint order so each backdrop sees what was behind it.
 *
 * Costs one raster per layer, and there is one layer per backdrop. That is left
 * deliberately unoptimized: collapsing layers needs an AABB intersection test
 * against each backdrop, and an AABB is only safe if it accounts for rotation,
 * where the stored box understates the real footprint and an understating test
 * puts an element inside a blur it is not behind. A handful of extra decodes is
 * not worth a class of export that is wrong only at 45 degrees.
 */
async function rasterizeLayered(
  prepared: PreparedSvg,
  bounds: ExportBounds,
  scale: number,
  plan: BackdropPlan
): Promise<RasterizedExport> {
  const width = Math.round(bounds.width * scale);
  const height = Math.round(bounds.height * scale);
  const acc = makeCanvas(bounds, scale);
  const ctx = acc.getContext("2d");
  if (!ctx) throw new Error("Failed to get 2D canvas context");
  const backdrops = new Map<string, BakedBackdrop>();

  ctx.drawImage(await rasterizeSvg(await layerSvg(prepared.svg, plan, 0), bounds, scale), 0, 0);

  for (let i = 0; i < plan.targets.length; i++) {
    const target = plan.targets[i];
    paintBackdrop(ctx, acc, target, bounds, scale);
    backdrops.set(target.id, captureBackdrop(ctx, target, bounds, scale));
    ctx.drawImage(
      await rasterizeSvg(await layerSvg(prepared.svg, plan, i + 1), bounds, scale),
      0,
      0
    );
  }

  return { canvas: acc, backdrops };
}

async function layerSvg(
  base: SVGSVGElement,
  plan: BackdropPlan,
  layer: number
): Promise<SVGSVGElement> {
  const clone = base.cloneNode(true) as SVGSVGElement;
  retainSelection(clone, allowedIdsForBucket(plan, layer));
  return clone;
}

function paintBackdrop(
  ctx: CanvasRenderingContext2D,
  acc: HTMLCanvasElement,
  target: BackdropTarget,
  bounds: ExportBounds,
  scale: number
): void {
  const width = acc.width;
  const height = acc.height;

  const temp = makeCanvas(bounds, scale);
  const tctx = temp.getContext("2d");
  if (!tctx) return;
  tctx.filter = scaledCanvasFilter(target.filter, scale);
  tctx.drawImage(acc, 0, 0);
  tctx.filter = "none";

  const matrix = deviceMatrix(target, bounds.x, bounds.y, scale);
  const path = targetClipPath(target);

  // A frosted panel shows the blurred backdrop, never the sharp one behind it,
  // so the clipped region is replaced rather than drawn over. The clip is fixed
  // in device space as soon as it is set, which is why the transform can go back
  // to identity before the clear and the blit.
  ctx.save();
  ctx.setTransform(matrix);
  ctx.clip(path);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.drawImage(temp, 0, 0);
  ctx.restore();
}

/**
 * The same pixels as a bitmap the vector export can embed.
 *
 * Captured at one image pixel per user unit regardless of the export scale: the
 * source is already blurred, so a larger bitmap would cost bytes and resolve
 * nothing. Rotated backdrops come out as their bounding box, which is fine for a
 * bitmap that is about to be blurred.
 */
function captureBackdrop(
  ctx: CanvasRenderingContext2D,
  target: BackdropTarget,
  bounds: ExportBounds,
  scale: number
): BakedBackdrop {
  const matrix = deviceMatrix(target, bounds.x, bounds.y, 1);
  const corners = [
    [0, 0],
    [target.width, 0],
    [target.width, target.height],
    [0, target.height]
  ].map(([x, y]) => ({
    x: matrix.a * x + matrix.c * y + matrix.e,
    y: matrix.b * x + matrix.d * y + matrix.f
  }));
  const minX = Math.min(...corners.map((p) => p.x));
  const minY = Math.min(...corners.map((p) => p.y));
  const boxW = Math.max(1, Math.max(...corners.map((p) => p.x)) - minX);
  const boxH = Math.max(1, Math.max(...corners.map((p) => p.y)) - minY);

  const out = document.createElement("canvas");
  out.width = Math.ceil(boxW);
  out.height = Math.ceil(boxH);
  const octx = out.getContext("2d");
  if (!octx) return { uri: "", x: minX, y: minY, width: boxW, height: boxH };
  octx.imageSmoothingEnabled = true;
  octx.imageSmoothingQuality = "high";
  octx.drawImage(
    ctx.canvas,
    minX * scale,
    minY * scale,
    boxW * scale,
    boxH * scale,
    0,
    0,
    out.width,
    out.height
  );

  return { uri: out.toDataURL("image/png"), x: minX, y: minY, width: boxW, height: boxH };
}

function makeCanvas(bounds: ExportBounds, scale: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bounds.width * scale));
  canvas.height = Math.max(1, Math.round(bounds.height * scale));
  return canvas;
}

/** Everything the three exporters need, resolved once from the live canvas. */
interface PreparedExport {
  prepared: PreparedSvg;
  bounds: ExportBounds;
  scale: number;
}

async function prepareExport(
  doc: DesignDocument,
  container: HTMLElement | null,
  options?: ExportOptions
): Promise<PreparedExport> {
  if (!container) throw new Error("Canvas container element is required");
  const svgEl = container.querySelector("svg");
  if (!svgEl) throw new Error("SVG element not found in canvas container");

  const scale = options?.scale || 1;
  const activePage = getActivePage(doc);
  const pageCanvas = activePage.canvas || doc.canvas;
  const bounds: ExportBounds = options?.bounds || {
    x: 0,
    y: 0,
    width: pageCanvas.width ?? doc.canvas.width ?? 1080,
    height: pageCanvas.height ?? doc.canvas.height ?? 1080
  };

  const prepared = await prepareSvgForExport(svgEl, doc, bounds, scale, options?.allowedElementIds);
  return {
    prepared,
    bounds,
    scale
  };
}

export async function exportCanvasAsDataUrl(
  doc: DesignDocument,
  container: HTMLElement | null,
  options?: ExportOptions
): Promise<string> {
  const { prepared, bounds, scale } = await prepareExport(doc, container, options);
  const { canvas } = await renderSvgToCanvas(prepared, bounds, scale);
  return canvas.toDataURL("image/png");
}

/**
 * The vector the raster is made from, so the export is the same drawing in two
 * formats rather than two drawings. Everything the engine resolved — tokens to
 * hex, `fill-rule`, blend modes, the `foreignObject` to `<text>` rewrite — is
 * already on the DOM by the time this is called.
 *
 * Async because a frosted backdrop cannot be written as markup: `backdrop-filter`
 * is honoured by no SVG consumer and a `<foreignObject>` by fewer still, so the
 * blur is baked into a clipped bitmap. That needs the same raster pass the PNG
 * needs, and the pass has to see the layers in order.
 */
export async function exportCanvasAsSvgString(
  doc: DesignDocument,
  container: HTMLElement | null,
  options?: ExportOptions
): Promise<string> {
  const { prepared, bounds, scale } = await prepareExport(doc, container, options);
  if (prepared.plan) {
    const { backdrops } = await renderSvgToCanvas(prepared, bounds, scale);
    insertBakedBackdrops(prepared.svg, prepared.plan, backdrops);
  }
  return new XMLSerializer().serializeToString(prepared.svg);
}

export async function exportCanvasAsSvgBlob(
  doc: DesignDocument,
  container: HTMLElement | null,
  options?: ExportOptions
): Promise<Blob> {
  const markup = await exportCanvasAsSvgString(doc, container, options);
  return new Blob([markup], { type: "image/svg+xml;charset=utf-8" });
}

export async function exportCanvasAsBlob(
  doc: DesignDocument,
  container: HTMLElement | null,
  options?: ExportOptions,
  mimeType: string = "image/png",
  quality: number = 1.0
): Promise<Blob> {
  const { prepared, bounds, scale } = await prepareExport(doc, container, options);
  const { canvas } = await renderSvgToCanvas(prepared, bounds, scale);

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error("Canvas toBlob produced null"));
      },
      mimeType,
      quality
    );
  });
}

/**
 * Bake the export scale into a PNG's `pHYs` chunk so it re-imports at its design
 * size.
 *
 * `image-loader` sizes a pasted image as `naturalPixels / density`, and reads
 * `density` from the filename (`@2x`) or from `pHYs` DPI. The Export panel gets
 * the scale from its filename; a clipboard PNG has no name, so without this it
 * pastes at Nx — a 2x copy lands twice as big as the layer it came from. Writing
 * `density` here makes the paste path divide by it, which is the "paste at 0.5x"
 * the copy asks for. An existing `pHYs` is replaced, never duplicated.
 */
export async function withPngDensity(blob: Blob, scale: number): Promise<Blob> {
  if (scale <= 1) return blob;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const isPng =
    bytes.length > 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47;
  if (!isPng) return blob;

  let off = 8;
  const chunks: { type: string; start: number; end: number }[] = [];
  let ihdrEnd = -1;
  let existingPhys = -1;
  while (off + 8 <= bytes.length) {
    const len = ((bytes[off] << 24) | (bytes[off + 1] << 16) | (bytes[off + 2] << 8) | bytes[off + 3]) >>> 0;
    const type = String.fromCharCode(bytes[off + 4], bytes[off + 5], bytes[off + 6], bytes[off + 7]);
    const end = off + 8 + len + 4;
    if (type === "IHDR") ihdrEnd = end;
    if (type === "pHYs") existingPhys = off;
    chunks.push({ type, start: off, end });
    if (type === "IEND" || end > bytes.length) break;
    off = end;
  }
  if (ihdrEnd < 0) return blob;

  const ppu = Math.round(2835 * scale); // 72 DPI == 2835 pixels per metre
  const data = new Uint8Array(9);
  data[0] = (ppu >>> 24) & 0xff;
  data[1] = (ppu >>> 16) & 0xff;
  data[2] = (ppu >>> 8) & 0xff;
  data[3] = ppu & 0xff;
  data[4] = (ppu >>> 24) & 0xff;
  data[5] = (ppu >>> 16) & 0xff;
  data[6] = (ppu >>> 8) & 0xff;
  data[7] = ppu & 0xff;
  data[8] = 1; // unit: metres

  const chunk = new Uint8Array(21);
  chunk[0] = 0; chunk[1] = 0; chunk[2] = 0; chunk[3] = 9;
  chunk[4] = 0x70; chunk[5] = 0x48; chunk[6] = 0x59; chunk[7] = 0x73; // "pHYs"
  chunk.set(data, 8);
  const crc = pngCrc32(chunk.subarray(4, 17));
  chunk[17] = (crc >>> 24) & 0xff;
  chunk[18] = (crc >>> 16) & 0xff;
  chunk[19] = (crc >>> 8) & 0xff;
  chunk[20] = crc & 0xff;

  const parts: Uint8Array[] = [bytes.subarray(0, 8), bytes.subarray(8, ihdrEnd), chunk];
  for (const c of chunks) {
    if (c.type === "IHDR" || c.start === existingPhys) continue;
    parts.push(bytes.subarray(c.start, c.end));
  }
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let p = 0;
  for (const part of parts) {
    out.set(part, p);
    p += part.length;
  }
  return new Blob([out], { type: "image/png" });
}

const PNG_CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function pngCrc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = PNG_CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
