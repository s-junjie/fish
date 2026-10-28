import { HtmlEmbedElement } from "../dsl/types";
import { isFrameableUrl } from "../dsl/html-source";
import { createId } from "../id";

/**
 * An html embed has no intrinsic size to measure — a web page is as tall as its
 * content and has no "natural" pixel box the way a video frame does — so unlike
 * a video it opens at a fixed viewport-sized box the author then resizes.
 */
export const DEFAULT_HTML_WIDTH = 1280;
export const DEFAULT_HTML_HEIGHT = 800;

const MAX_HTML_EDGE = 1280;

/**
 * An inlined document lives in the `.fish.html` itself, so a runaway file would
 * be written into every save and every version snapshot. Refused with a message
 * rather than truncated: half a document is a worse artifact than none, and the
 * author can still point at it with `src` if it is served somewhere.
 */
export const MAX_HTML_FILE_BYTES = 8 * 1024 * 1024;

export function computeHtmlTargetSize(
  width: number,
  height: number,
  maxEdge = MAX_HTML_EDGE
): { width: number; height: number } {
  const w = width > 0 ? width : DEFAULT_HTML_WIDTH;
  const h = height > 0 ? height : DEFAULT_HTML_HEIGHT;
  const longest = Math.max(w, h);
  if (longest <= maxEdge) return { width: Math.round(w), height: Math.round(h) };
  const scale = maxEdge / longest;
  return {
    width: Math.max(1, Math.round(w * scale)),
    height: Math.max(1, Math.round(h * scale))
  };
}

/** The host, which is the only name a bare URL offers. */
export function htmlNameFromUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "") || "Web Page";
  } catch {
    return "Web Page";
  }
}

export function htmlNameFromFile(file: File | Blob): string {
  const name = (file as File).name || "";
  const base = name.replace(/\.[^/.]+$/, "").trim();
  return base || "Web Page";
}

export function createHtmlElement(spec: {
  id?: string;
  name?: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
  src?: string;
  srcdoc?: string;
  borderRadius?: HtmlEmbedElement["borderRadius"];
  posterAssetId?: string;
  cachedTitle?: string;
  cachedFavicon?: string;
}): HtmlEmbedElement {
  const { width, height } = computeHtmlTargetSize(
    spec.width ?? DEFAULT_HTML_WIDTH,
    spec.height ?? DEFAULT_HTML_HEIGHT
  );
  return {
    id: spec.id ?? createId("html"),
    type: "html",
    ...(spec.name ? { name: spec.name } : {}),
    x: Math.round(spec.x),
    y: Math.round(spec.y),
    width,
    height,
    ...(spec.src ? { src: spec.src } : {}),
    ...(spec.srcdoc ? { srcdoc: spec.srcdoc } : {}),
    ...(spec.borderRadius !== undefined ? { borderRadius: spec.borderRadius } : {}),
    ...(spec.posterAssetId ? { posterAssetId: spec.posterAssetId } : {}),
    ...(spec.cachedTitle ? { cachedTitle: spec.cachedTitle } : {}),
    ...(spec.cachedFavicon ? { cachedFavicon: spec.cachedFavicon } : {})
  };
}

export function extractHtmlMetadata(html: string): { title?: string; favicon?: string } {
  let title: string | undefined;
  let favicon: string | undefined;

  const titleMatch = /<title[^>]*>([^<]+)<\/title>/i.exec(html);
  if (titleMatch) {
    const raw = titleMatch[1].trim();
    if (raw) title = raw;
  }

  /**
   * Every `<link>` is scanned and `rel` decides.
   *
   * The two known attribute orders used to be two regexes over the tag text, and
   * both read the href as `[^"']+`. A `data:` icon contains the OTHER quote
   * character — this repo's own `index.html` declares
   * `href="data:image/svg+xml,%3Csvg xmlns='http://…'"` — so the capture stopped
   * dead at the first apostrophe and produced `data:image/svg+xml,%3Csvg xmlns=`,
   * a truncated URI that renders as a broken image on the fallback card. Reading
   * the tag's attributes is what respects the quoting.
   */
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    const attrs = tagAttributes(tag);
    const rel = (attrs.get("rel") ?? "").toLowerCase().split(/\s+/);
    // `apple-touch-icon` is a different declaration and is not the tab icon.
    if (!rel.includes("icon")) continue;
    const href = (attrs.get("href") ?? "").trim();
    if (href) {
      favicon = href;
      break;
    }
  }

  return { title, favicon };
}

/** An http(s) page, framed live. */
export function loadHtmlFromUrl(url: string, worldX = 0, worldY = 0): HtmlEmbedElement {
  const clean = url.trim();
  if (!clean) throw new Error("URL is empty");
  if (!isFrameableUrl(clean)) {
    throw new Error("Only http:// and https:// pages can be framed");
  }
  return createHtmlElement({
    name: htmlNameFromUrl(clean),
    x: worldX,
    y: worldY,
    src: clean,
    cachedTitle: htmlNameFromUrl(clean)
  });
}

/**
 * A local `.html`, read as text and inlined.
 *
 * This is the only route to a local file: a page loaded from `file://` is an
 * opaque origin with no URL that names a sibling, so an iframe cannot be pointed
 * at one. The text is stored on the element and rendered through `srcdoc`, which
 * is also what keeps the document self-contained once it is saved.
 */
export async function loadHtmlFromFile(
  file: File | Blob,
  worldX = 0,
  worldY = 0
): Promise<HtmlEmbedElement> {
  if (file.size > MAX_HTML_FILE_BYTES) {
    throw new Error(
      `File is ${(file.size / 1024 / 1024).toFixed(1)} MB; the inline limit is ${
        MAX_HTML_FILE_BYTES / 1024 / 1024
      } MB`
    );
  }
  const srcdoc = await file.text();
  if (!srcdoc.trim()) throw new Error("File is empty");
  const meta = extractHtmlMetadata(srcdoc);
  const name = meta.title || htmlNameFromFile(file);
  // A relative icon in an inlined document points at a sibling that no longer
  // exists beside the srcdoc, and a `data:` URI with no payload (`data:,`, the
  // idiom for "I have no icon, stop asking") draws nothing — both would paint a
  // broken image on the card, so only an inlined image is kept.
  const declaredFavicon = meta.favicon;
  const cachedFavicon =
    declaredFavicon && /^data:image\//i.test(declaredFavicon) ? declaredFavicon : undefined;
  return createHtmlElement({
    name,
    x: worldX,
    y: worldY,
    srcdoc,
    cachedTitle: meta.title,
    cachedFavicon
  });
}

/**
 * The `<iframe>` out of an embed snippet pasted from a site's share dialog.
 *
 * A scanner rather than `DOMParser`: this module is unit-tested under Node,
 * where there is no parser to reach for, and the input is one tag rather than a
 * document. Only `src` and the two size attributes are read — `allow`,
 * `allowfullscreen` and `sandbox` have no field to land in and are dropped, so a
 * pasted snippet cannot hand a framed page a permission the author never chose.
 */
export function parseEmbedCode(text: string): { src: string; width?: number; height?: number } | null {
  // Commented-out markup first: a whole page pasted in carries dead `<iframe>`s,
  // and the live one is not always the first match.
  const tag = iframeTagText(text.replace(/<!--[\s\S]*?-->/g, ""));
  if (!tag) return null;

  const attrs = tagAttributes(tag);
  const raw = (attrs.get("src") ?? "").trim();
  // `//host/path` is how a share dialog writes a page it has no scheme for.
  const src = raw.startsWith("//") ? `https:${raw}` : raw;
  if (!isFrameableUrl(src)) return null;

  return { src, width: pixelAttribute(attrs.get("width")), height: pixelAttribute(attrs.get("height")) };
}

/** The tag's own text, quotes respected so a `>` inside a value cannot end it. */
function iframeTagText(text: string): string | null {
  const open = /<iframe(?=[\s/>])/i.exec(text);
  if (!open) return null;
  let quote: string | null = null;
  for (let i = open.index + open[0].length; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ">") {
      return text.slice(open.index, i);
    }
  }
  return null;
}

const ATTRIBUTE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;

function tagAttributes(tag: string): Map<string, string> {
  const attrs = new Map<string, string>();
  for (const m of tag.matchAll(ATTRIBUTE)) attrs.set(m[1].toLowerCase(), m[2] ?? m[3] ?? m[4] ?? "");
  return attrs;
}

/** `560` or `560px`; a `100%` has no pixel answer and falls back to the default. */
function pixelAttribute(value: string | undefined): number | undefined {
  const m = /^(\d+(?:\.\d+)?)(?:px)?$/i.exec((value ?? "").trim());
  const n = m ? Number.parseFloat(m[1]) : 0;
  return n > 0 ? Math.round(n) : undefined;
}

/** A pasted embed snippet, framed at the size its own attributes ask for. */
export function loadHtmlFromEmbedCode(text: string, worldX = 0, worldY = 0): HtmlEmbedElement {
  const parsed = parseEmbedCode(text);
  if (!parsed) throw new Error("No <iframe> with an http(s) page in the pasted code");
  return createHtmlElement({
    name: htmlNameFromUrl(parsed.src),
    x: worldX,
    y: worldY,
    width: parsed.width,
    height: parsed.height,
    src: parsed.src
  });
}
