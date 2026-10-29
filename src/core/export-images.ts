/**
 * Inline external image URLs (http/https) in an export SVG clone to data URIs.
 *
 * Browsers executing an SVG-as-`<img>` decode enforce strict sandbox isolation
 * that blocks all subresource network requests. External `<image href="http...">`
 * references therefore fail to render during rasterization (PNG export).
 * Inlining them into `data:` URIs ensures rasterization sees the image pixels.
 */

import { externalFetch, publicProxyUrl } from "./net/external-fetch";

const FETCH_TIMEOUT_MS = 6000;

function blobToDataUri(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function fetchToDataUri(url: string): Promise<string | null> {
  try {
    const response = await externalFetch(url, { timeoutMs: FETCH_TIMEOUT_MS });
    if (!response.ok) return null;
    return await blobToDataUri(await response.blob());
  } catch {
    return null;
  }
}

async function canvasToDataUri(url: string): Promise<string | null> {
  if (typeof document === "undefined") return null;
  const image = new Image();
  image.crossOrigin = "anonymous";
  const loaded = await new Promise<boolean>((resolve) => {
    let settled = false;
    const settle = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    image.onload = () => settle(true);
    image.onerror = () => settle(false);
    setTimeout(() => settle(false), FETCH_TIMEOUT_MS);
    image.src = url;
  });
  if (!loaded || image.naturalWidth === 0 || image.naturalHeight === 0) return null;

  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.drawImage(image, 0, 0);
  try {
    return canvas.toDataURL("image/png");
  } catch {
    return null;
  }
}

async function fetchViaProxyToDataUri(url: string): Promise<string | null> {
  // Same rule as `embedExternalAsset`: a third-party proxy may only ever see an
  // address the user published. A private host or a signed URL leaves the export
  // with a blank image instead of handing the credential to `wsrv.nl` — and a
  // blank image is visible, which is what makes it reportable.
  const proxyUrl = publicProxyUrl(url);
  if (!proxyUrl) return null;
  try {
    const response = await externalFetch(proxyUrl, { timeoutMs: FETCH_TIMEOUT_MS });
    if (!response.ok) return null;
    return await blobToDataUri(await response.blob());
  } catch {
    return null;
  }
}

export async function resolveImageAsDataUri(url: string): Promise<string | null> {
  const clean = url.trim();
  if (!clean.startsWith("http://") && !clean.startsWith("https://")) return null;
  return (
    (await fetchToDataUri(clean)) ??
    (await canvasToDataUri(clean)) ??
    (await fetchViaProxyToDataUri(clean))
  );
}

/**
 * Replace all external http/https hrefs on `<image>` elements with data URIs.
 */
export async function inlineExternalImages(clone: SVGSVGElement): Promise<void> {
  const images = Array.from(clone.querySelectorAll("image"));
  if (images.length === 0) return;

  const urlsToFetch = new Set<string>();
  for (const img of images) {
    const href = img.getAttribute("href") || img.getAttribute("xlink:href");
    if (href && (href.startsWith("http://") || href.startsWith("https://"))) {
      urlsToFetch.add(href);
    }
  }

  if (urlsToFetch.size === 0) return;

  const cache = new Map<string, string>();
  await Promise.all(
    Array.from(urlsToFetch).map(async (url) => {
      const dataUri = await resolveImageAsDataUri(url);
      if (dataUri) cache.set(url, dataUri);
    })
  );

  for (const img of images) {
    const href = img.getAttribute("href") || img.getAttribute("xlink:href");
    if (href && cache.has(href)) {
      const inlined = cache.get(href)!;
      img.setAttribute("href", inlined);
      if (img.hasAttribute("xlink:href")) {
        img.removeAttribute("xlink:href");
      }
    }
  }
}
