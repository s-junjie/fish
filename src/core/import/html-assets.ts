/**
 * External bytes, pulled into the document as data URIs.
 *
 * The walk is synchronous and the disk is not, so every URL the page references
 * is resolved BEFORE the walk starts and the walk only ever looks up an answer.
 * Assets are minted here rather than in the walk for the same reason: one owner
 * means one place that decides what an asset is called and whether its bytes
 * arrived at all.
 *
 * Anything that could not be read is kept with the reason it failed, because
 * "the image is missing" and "the image is on another origin and the server
 * does not allow reading it" are different problems with different fixes, and
 * an import that reports neither is an import that looks like it worked.
 */

import type { AssetRef } from "../dsl/types";
import { createId } from "../id";
import { backgroundImageUrls } from "./css-values";

export interface AssetHint {
  name: string;
  width: number;
  height: number;
}

export interface AssetStore {
  /**
   * The asset for a URL the page referenced, or `undefined` when its bytes could
   * not be brought across. `hint` names and sizes the asset the first time it is
   * used, since only the element knows the box it was drawn in.
   */
  idFor(url: string, hint?: AssetHint): string | undefined;
  /** Why `idFor` said no. Empty when the URL was never attempted. */
  reason(url: string): string;
  /**
   * The URL in the page's OWN spelling.
   *
   * A computed `background-image` is resolved against whatever document the
   * import host is — the app's own location — so `assets/hero.jpg` comes back as
   * `file:///…/dist/assets/hero.jpg`, a URL that exists nowhere. Undoing that
   * resolution is what lets a folder the user picks later be matched by path.
   */
  normalize(url: string): string;
  /** `@font-face` src URLs, none of which are inlined — reported, not dropped. */
  fontSources: string[];
  assets: AssetRef[];
}

const FETCH_TIMEOUT = 10000;

export async function collectAssets(root: Element, signal?: AbortSignal): Promise<AssetStore> {
  if (signal?.aborted) throw new DOMException("Import aborted", "AbortError");
  const assets: AssetRef[] = [];
  const byId = new Map<string, AssetRef>();
  const idByUri = new Map<string, string>();
  const idByUrl = new Map<string, string>();
  const reasons = new Map<string, string>();

  // The host's own directory is the one every relative URL in the page has been
  // resolved against, so it is also the one to strip.
  const base = typeof document !== "undefined" ? document.baseURI : "";
  const baseDir = base.slice(0, base.lastIndexOf("/") + 1);
  const normalize = (url: string): string =>
    baseDir && url.startsWith(baseDir) ? url.slice(baseDir.length) || url : url;

  const register = (uri: string): string => {
    const existing = idByUri.get(uri);
    if (existing) return existing;
    const id = createId("asset");
    idByUri.set(uri, id);
    const asset: AssetRef = { id, name: "image", uri };
    assets.push(asset);
    byId.set(id, asset);
    return id;
  };

  await Promise.all(
    referencedUrls(root).map(async (url) => {
      if (signal?.aborted) return;
      const outcome = await inline(url, signal);
      if ("uri" in outcome) idByUrl.set(normalize(url), register(outcome.uri));
      else reasons.set(normalize(url), outcome.reason);
    })
  );

  return {
    idFor(url, hint) {
      const id = idByUrl.get(normalize(url));
      if (!id) return undefined;
      if (hint) {
        const asset = byId.get(id);
        if (asset && asset.name === "image") {
          asset.name = hint.name;
          if (hint.width > 0) asset.width = Math.round(hint.width);
          if (hint.height > 0) asset.height = Math.round(hint.height);
        }
      }
      return id;
    },
    reason: (url) => reasons.get(normalize(url)) ?? "",
    normalize,
    fontSources: fontSources(root),
    assets
  };
}

/**
 * The URL to remember an `<img>` by.
 *
 * The page's OWN spelling wins whenever it is a relative path: `currentSrc` is
 * that path resolved against whatever document the import host happens to be —
 * the app's own location — which is a URL that exists nowhere and that no folder
 * the user picks can match. A `srcset` candidate has no authored relative form,
 * so there the browser's choice is all there is.
 */
export function imageSource(img: HTMLImageElement): string {
  const authored = img.getAttribute("src") || "";
  if (authored && !/^[a-z][a-z0-9+.-]*:/i.test(authored) && !authored.startsWith("//")) return authored;
  return img.currentSrc || authored;
}

/** Every URL the tree draws from, whether as an `<img>` or as a background layer. */
function referencedUrls(root: Element): string[] {
  const urls = new Set<string>();

  for (const img of Array.from(root.querySelectorAll("img"))) {
    const src = imageSource(img);
    if (src) urls.add(src);
  }

  // Materialised pseudo-elements are ordinary elements by now, so their copied
  // backgrounds are found the same way the page's own are.
  for (const el of Array.from(root.querySelectorAll("*"))) {
    for (const url of backgroundImageUrls(getComputedStyle(el).backgroundImage)) urls.add(url);
  }

  return [...urls].filter(isReadable);
}

function isReadable(url: string): boolean {
  const value = url.trim();
  if (!value) return false;
  // `url(#id)` is a reference to something already in the document, not a resource.
  if (value.startsWith("#")) return false;
  if (value.startsWith("about:")) return false;
  return !/^(javascript|vbscript|data:text\/html)/i.test(value);
}

type Inline = { uri: string } | { reason: string };

async function inline(url: string, signal?: AbortSignal): Promise<Inline> {
  if (signal?.aborted) return { reason: "aborted" };
  const value = url.trim();
  if (value.startsWith("data:")) return { uri: value };

  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(value)?.[1]?.toLowerCase();
  if (!scheme) {
    return {
      reason:
        "relative path — the document arrived as text, so there is no base URL to resolve it against"
    };
  }
  if (scheme === "blob" || scheme === "file") {
    const bytes = await readViaFetch(value, signal);
    return bytes ? { uri: bytes } : { reason: `could not read a ${scheme}: URL` };
  }
  if (scheme !== "http" && scheme !== "https") {
    return { reason: `unsupported scheme "${scheme}:"` };
  }

  const bytes = (await readViaFetch(value, signal)) ?? (await readViaCanvas(value, signal));
  // A cross-origin bitmap whose server sends no `Access-Control-Allow-Origin`
  // cannot be read at all: the bytes are unreachable from script, so a data URI
  // is not merely missing, it is impossible.
  return bytes ? { uri: bytes } : { reason: "could not be read (network failure, or cross-origin without CORS headers)" };
}

async function readViaFetch(url: string, signal?: AbortSignal): Promise<string | null> {
  if (signal?.aborted) return null;
  try {
    const combinedSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT)])
      : AbortSignal.timeout(FETCH_TIMEOUT);
    const response = await fetch(url, { signal: combinedSignal });
    if (!response.ok) return null;
    return await blobToDataUri(await response.blob());
  } catch {
    return null;
  }
}

/**
 * The fallback for a source `fetch` could not take: an `<img>` loads without
 * CORS, and drawing it to a canvas re-encodes it — but only when the server
 * allowed the read, which `toDataURL` enforces by throwing on a tainted canvas.
 */
async function readViaCanvas(url: string, signal?: AbortSignal): Promise<string | null> {
  if (signal?.aborted) return null;
  const image = new Image();
  image.crossOrigin = "anonymous";
  const loaded = await new Promise<boolean>((resolve) => {
    let settled = false;
    const settle = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    if (signal) {
      signal.addEventListener("abort", () => settle(false), { once: true });
    }
    image.onload = () => settle(true);
    image.onerror = () => settle(false);
    setTimeout(() => settle(false), FETCH_TIMEOUT);
    image.src = url;
  });
  if (signal?.aborted || !loaded || image.naturalWidth === 0 || image.naturalHeight === 0) return null;

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

function blobToDataUri(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/** The `src` URLs of every `@font-face` the page declares. */
function fontSources(root: Element): string[] {
  const out = new Set<string>();
  for (const style of Array.from(root.querySelectorAll("style"))) {
    const css = style.textContent ?? "";
    for (const block of css.matchAll(/@font-face\s*\{([^}]*)\}/g)) {
      for (const url of backgroundImageUrls(block[1])) out.add(url);
    }
  }
  return [...out];
}
