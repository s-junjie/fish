/**
 * Turn an HTML embed into pixels before the export SVG is serialized.
 *
 * The live canvas shows an iframe; a standalone SVG cannot carry one, and a
 * rasterized SVG-as-<img> cannot run the framed document's scripts. So the
 * export renders the authored HTML itself into a bitmap — a data-URL SVG with
 * the markup in a `foreignObject` is decoded by Chromium, and the result is
 * embedded as a plain `<image>` that every export path can carry.
 *
 * A page that cannot be rendered this way (a cross-origin `src` behind CORS,
 * for example) falls back to the export placeholder, never to the editor's
 * own "click to preview" badge.
 */

import type { DesignDocument, HtmlEmbedElement } from "./dsl/types";
import { getActivePage } from "./dsl/document-ops";
import { sourceUriFor } from "./assets/render-uri";
import { emitEmbedPlaceholder } from "./export-embed-placeholder";
import { resolveHtmlSource } from "./interactions/html-embed-loader";
import { findElementById } from "./geometry/tree-ops";
import { getShapeLocalPath } from "./geometry/gradient-utils";
import { externalFetch } from "./net/external-fetch";

const SVG_NS = "http://www.w3.org/2000/svg";
const XHTML_NS = "http://www.w3.org/1999/xhtml";
const RASTER_TIMEOUT_MS = 4000;
const FETCH_TIMEOUT_MS = 2500;
const MAX_RASTER_EDGE = 4096;

export async function bakeHtmlEmbeds(
  clone: SVGSVGElement,
  doc: DesignDocument,
  scale: number
): Promise<void> {
  const activePage = getActivePage(doc);
  const jobs: Promise<void>[] = [];

  for (const node of Array.from(clone.querySelectorAll<SVGGElement>("[data-element-id]"))) {
    const id = node.getAttribute("data-element-id") || "";
    let el = findElementById(activePage.children, id);
    if (!el || el.type !== "html") {
      // An instance child is painted under a derived id. The frame itself still
      // names its master, so the source survives even when the tree does not.
      const frameId = node.querySelector("iframe[data-html-embed-id]")?.getAttribute("data-html-embed-id");
      const master = frameId ? findElementById(activePage.children, frameId) : null;
      if (master?.type === "html") el = master;
    }
    if (!el || el.type !== "html") continue;

    // The renderer wraps every element's local-space paint in one `<g>`. All of
    // its children are the embed's own presentation — the live frame, a poster,
    // or the resting badge — and none of them belongs in a static export.
    const host = Array.from(node.children).find((c) => c.tagName.toLowerCase() === "g");
    if (!host) continue;
    jobs.push(bakeOne(host, el as HtmlEmbedElement, doc, scale));
  }

  await Promise.all(jobs);
}

async function bakeOne(
  host: Element,
  el: HtmlEmbedElement,
  doc: DesignDocument,
  scale: number
): Promise<void> {
  const uri = await embedRasterUri(el, doc, scale);
  if (!uri) {
    host.replaceChildren(emitEmbedPlaceholder(el));
    return;
  }

  const clipId = `clip-export-html-${el.id}`;
  const root = host.closest("svg");
  let defs = root?.querySelector("defs");
  if (!defs && root) {
    defs = host.ownerDocument.createElementNS(SVG_NS, "defs");
    root.insertBefore(defs, root.firstChild);
  }
  if (!defs) {
    host.replaceChildren(emitEmbedPlaceholder(el));
    return;
  }
  const clip = host.ownerDocument.createElementNS(SVG_NS, "clipPath");
  clip.setAttribute("id", clipId);
  const outline = host.ownerDocument.createElementNS(SVG_NS, "path");
  outline.setAttribute("d", getShapeLocalPath(el));
  clip.appendChild(outline);
  defs.appendChild(clip);

  const image = host.ownerDocument.createElementNS(SVG_NS, "image");
  image.setAttribute("href", uri);
  image.setAttribute("x", "0");
  image.setAttribute("y", "0");
  image.setAttribute("width", String(el.width));
  image.setAttribute("height", String(el.height));
  image.setAttribute("preserveAspectRatio", "none");
  image.setAttribute("clip-path", `url(#${clipId})`);
  host.replaceChildren(image);
}

async function embedRasterUri(
  el: HtmlEmbedElement,
  doc: DesignDocument,
  scale: number
): Promise<string | null> {
  // The authored markup is the authority: a poster captured from a canvas can
  // hold only the canvas, while the same page's text and CSS are in the source.
  const inline = resolveHtmlSource(doc, el.srcdoc);
  if (inline.trim()) {
    const raster = await rasterizeHtml(inline, el.width, el.height, scale);
    if (raster) return raster;
  }

  const poster = (doc.assets || []).find((a) => a.id === el.posterAssetId);
  if (poster?.uri) return sourceUriFor(poster.uri);
  if (!el.src) return null;

  // A cross-origin page cannot be read from this tab. Its own framed snapshot
  // (the poster) is the only copy the export is allowed to have.
  let sameOrigin = false;
  try {
    sameOrigin =
      typeof location === "undefined" ||
      new URL(el.src, location.href).origin === location.origin;
  } catch {
    return null;
  }
  if (!sameOrigin) return null;

  try {
    const response = await externalFetch(el.src, { timeoutMs: FETCH_TIMEOUT_MS });
    if (!response.ok) return null;
    const type = response.headers.get("content-type") || "";
    if (!/html/i.test(type)) return null;
    return rasterizeHtml(await response.text(), el.width, el.height, scale);
  } catch {
    return null;
  }
}

function rasterizeHtml(source: string, width: number, height: number, scale: number): Promise<string | null> {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const fit = Math.min(scale, MAX_RASTER_EDGE / Math.max(w, h));
  const pw = Math.max(1, Math.round(w * fit));
  const ph = Math.max(1, Math.round(h * fit));

  if (typeof DOMParser === "undefined" || typeof Image === "undefined") return Promise.resolve(null);

  return new Promise((resolve) => {
    let settled = false;
    const done = (value: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => done(null), RASTER_TIMEOUT_MS);

    try {
      const parsed = new DOMParser().parseFromString(source, "text/html");
      const root = parsed.documentElement;
      root.setAttribute("xmlns", XHTML_NS);
      root.style.setProperty("width", `${w}px`);
      root.style.setProperty("height", `${h}px`);
      root.style.setProperty("margin", "0");
      if (parsed.body) {
        parsed.body.style.setProperty("width", `${w}px`);
        parsed.body.style.setProperty("height", `${h}px`);
        parsed.body.style.setProperty("margin", "0");
        parsed.body.style.setProperty("box-sizing", "border-box");
      }
      // Scripts cannot run in an SVG image. Leaving their text in place does
      // nothing but risk an XML serializer surprise.
      for (const script of Array.from(root.querySelectorAll("script"))) script.remove();

      const xhtml = new XMLSerializer().serializeToString(root);
      const svg =
        `<svg xmlns="${SVG_NS}" width="${pw}" height="${ph}" viewBox="0 0 ${w} ${h}">` +
        `<foreignObject x="0" y="0" width="${w}" height="${h}">${xhtml}</foreignObject></svg>`;
      const img = new Image();
      img.onload = () => {
        try {
          const canvas = document.createElement("canvas");
          canvas.width = pw;
          canvas.height = ph;
          const ctx = canvas.getContext("2d");
          if (!ctx) return done(null);
          ctx.drawImage(img, 0, 0, pw, ph);
          done(canvas.toDataURL("image/png"));
        } catch {
          done(null);
        }
      };
      img.onerror = () => done(null);
      img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
    } catch {
      done(null);
    }
  });
}
