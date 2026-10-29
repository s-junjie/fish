import { render, h } from "preact";
import type { DesignDocument, DesignElement, ComponentElement, InstanceElement } from "../core/dsl/types";
import { flattenElements } from "../core/geometry/tree-ops";
import { findMasterComponent } from "../core/interactions/component-inventory";
import { buildReferenceRegistry } from "./canvas/reference-registry";
import { renderNodeList } from "./canvas/SvgNodeRenderer";
import { CanvasDefs } from "./canvas/CanvasDefs";
import { thumbnailContext } from "./assets/asset-cards";
import { findThumbnailTargetFrame } from "../core/thumbnail-target";
import { convertForeignObjectsToSvg } from "../core/export-text";
import { restoreSourceUris } from "../core/assets/render-uri";
import { DEFAULT_CANVAS_BACKGROUND } from "../core/dsl/defaults";

/**
 * The cover frame, painted as one standalone SVG.
 *
 * Two readers: the preview block that goes into a saved file (inline), and the
 * snapshot that rasterizes this same art to WebP. Keeping it in one function is
 * what makes the fallback honest — if the raster is missing or fails, the file
 * carries exactly the picture the snapshot would have shown.
 */
export interface ThumbnailArt {
  svg: string;
  width: number;
  height: number;
  background: string;
}

export function thumbnailBackground(doc: DesignDocument): string {
  return typeof doc.canvas?.background === "object" && doc.canvas.background.type === "solid"
    ? doc.canvas.background.color
    : DEFAULT_CANVAS_BACKGROUND;
}

export function buildThumbnailSvg(doc: DesignDocument): ThumbnailArt | null {
  if (typeof document === "undefined") return null;
  const targetFrame = findThumbnailTargetFrame(doc);
  if (!targetFrame) return null;

  const bw = Math.max(1, targetFrame.width || 1);
  const bh = Math.max(1, targetFrame.height || 1);
  const x = targetFrame.x || 0;
  const y = targetFrame.y || 0;

  // Instances paint their children under derived ids, which the page tree never
  // mints, so the master components they are made of have to ride along or the
  // cover's symbols come out empty.
  const own = flattenElements([targetFrame]);
  const ids = new Set(own.map((e) => e.id));
  const masters: ComponentElement[] = [];
  let frontier: DesignElement[] = own;
  for (let depth = 0; depth < 4 && frontier.length > 0; depth++) {
    const next: DesignElement[] = [];
    for (const e of frontier) {
      if (e.type !== "instance") continue;
      const cid = (e as InstanceElement).componentId;
      if (!cid || ids.has(cid)) continue;
      const master = findMasterComponent(doc, cid);
      if (!master) continue;
      ids.add(cid);
      masters.push(master);
      next.push(master);
    }
    frontier = next;
  }
  const defElements = masters.length > 0 ? [...own, ...flattenElements(masters)] : own;

  const docRef = { current: doc };
  const ctx = thumbnailContext(docRef);
  ctx.registry = buildReferenceRegistry(doc);

  const container = document.createElement("div");
  try {
    render(
      h(
        "svg",
        {
          xmlns: "http://www.w3.org/2000/svg",
          // Anchored to the FRAME, never to the page: the frame is painted at its
          // page position, so the origin is moved into a `transform` instead.
          viewBox: `0 0 ${bw} ${bh}`,
          style: "width:100%;height:100%;max-width:100vw;max-height:100vh;display:block",
          preserveAspectRatio: "xMidYMid meet"
        },
        h(CanvasDefs, {
          allElements: defElements,
          viewportBox: null,
          selectedIds: new Set<string>(),
          assets: doc.assets
        }),
        h("g", { transform: `translate(${-x}, ${-y})` }, renderNodeList([targetFrame], ctx, true))
      ),
      container
    );

    // The canvas paints text as HTML inside a `foreignObject`. That is a
    // deliberate trade the editor can make and a cover cannot: WebKit gives a
    // *positioned* wrapper inside a scaled `foreignObject` its own paint offset
    // in CSS pixels rather than the SVG's, so the cover's text landed a few
    // hundred units away from its own artwork while every shape stayed put —
    // a thumbnail that reads as broken in Safari and fine in Chrome. The export
    // already answers this by re-laying the same runs out as native `<text>`,
    // so this reuses that instead of a second implementation.
    //
    // It is also what makes rasterizing possible at all: an SVG loaded as an
    // `<img>` will not lay out a `foreignObject`, so a snapshot of the HTML form
    // would come back as a picture of the frame's empty background.
    const svg = container.querySelector("svg");
    if (svg) {
      try {
        convertForeignObjectsToSvg(svg as unknown as SVGSVGElement, doc);
      } catch (err) {
        console.warn("FISH: preview text could not be converted to SVG text:", err);
      }
      try {
        restoreSourceUris(svg);
      } catch (err) {
        console.warn("FISH: failed to restore source URIs for thumbnail:", err);
      }
    }

    const markup = container.innerHTML;
    if (!markup || !markup.includes("<svg")) return null;

    return { svg: markup, width: bw, height: bh, background: thumbnailBackground(doc) };
  } finally {
    render(null, container);
  }
}
