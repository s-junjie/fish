/**
 * Transport format for HTML snippets copied from the FISH Chrome extension or
 * external tools and pasted into FISH.
 *
 * Symmetrical to `figma-export.ts`: when a designer copies an element or page
 * in the Chrome extension, the clipboard receives a single JSON envelope with a
 * signature tag. A paste in FISH recognizes it ahead of foreign plain text and
 * routes it into the HTML import engine.
 */

export const FISH_HTML_CLIP_FORMAT = "fish-html-clip";
export const FISH_HTML_CLIP_SIGNATURE = "<!-- FISH_HTML_CLIP_V1 -->";

export interface FishHtmlClipPayload {
  format: "fish-html-clip";
  version: "0.1";
  html: string;
  title?: string;
  url?: string;
  mode?: "element" | "page";
}

export function stripClipboardWrappers(text: string): string {
  let cur = text.trim();
  let prev = "";
  while (cur !== prev) {
    prev = cur;
    cur = cur
      .replace(/^<!--((?!-->)[\s\S])*?-->\s*/, "")
      .replace(/\s*<!--((?!-->)[\s\S])*?-->$/, "")
      .replace(/^<meta\b[^>]*>\s*/i, "")
      .trim();
  }
  return cur;
}

export function isHtmlClipText(text: string): boolean {
  if (!text) return false;
  const trimmed = text.trim();
  if (trimmed.startsWith(FISH_HTML_CLIP_SIGNATURE)) return true;
  if (trimmed.includes(FISH_HTML_CLIP_FORMAT)) {
    try {
      const parsed = JSON.parse(trimmed);
      return Boolean(
        parsed &&
          parsed.format === FISH_HTML_CLIP_FORMAT &&
          typeof parsed.html === "string" &&
          parsed.html.trim().length > 0
      );
    } catch {
      // not JSON
    }
  }

  // Defer iframe embed snippets to the iframe embed loader
  if (/<iframe\b/i.test(trimmed)) {
    return false;
  }

  const cleaned = stripClipboardWrappers(trimmed);

  // Full HTML document
  if (/^<!DOCTYPE\s+html/i.test(cleaned) || /^<html[\s>]/i.test(cleaned)) {
    return true;
  }
  // SVG markup
  if (/^<svg\b[\s\S]*<\/svg>$/i.test(cleaned)) {
    return true;
  }
  // Standard block HTML container tag or sibling elements
  if (/^<(div|section|article|header|footer|nav|main|aside|table|form|figure|p|ul|ol|button)\b[\s\S]*<\/[a-zA-Z0-9_-]+>$/i.test(cleaned)) {
    return true;
  }
  return false;
}

export function parseHtmlClip(text: string): {
  html: string;
  title: string;
  mode: "element" | "page";
  url?: string;
} {
  const trimmed = text.trim();
  if (trimmed.startsWith(FISH_HTML_CLIP_SIGNATURE)) {
    const rawHtml = trimmed.slice(FISH_HTML_CLIP_SIGNATURE.length).trim();
    return {
      html: rawHtml,
      title: "Imported Element",
      mode: "element"
    };
  }
  if (trimmed.includes(FISH_HTML_CLIP_FORMAT)) {
    try {
      const parsed = JSON.parse(trimmed) as FishHtmlClipPayload;
      if (parsed.format === FISH_HTML_CLIP_FORMAT && parsed.html) {
        return {
          html: parsed.html,
          title: parsed.title?.trim() || "Imported HTML",
          mode: parsed.mode ?? "element",
          url: parsed.url
        };
      }
    } catch {
      // not valid json
    }
  }

  const cleaned = stripClipboardWrappers(trimmed);

  if (/^<!DOCTYPE\s+html/i.test(cleaned) || /^<html[\s>]/i.test(cleaned)) {
    const titleMatch = cleaned.match(/<title[^>]*>([^<]+)<\/title>/i);
    return {
      html: cleaned,
      title: titleMatch ? titleMatch[1].trim() : "Imported Page",
      mode: "page"
    };
  }
  if (/^<svg\b/i.test(cleaned)) {
    return {
      html: cleaned,
      title: "Imported SVG",
      mode: "element"
    };
  }
  if (/^<(div|section|article|header|footer|nav|main|aside|table|form|figure|p|ul|ol|button)\b/i.test(cleaned)) {
    return {
      html: cleaned,
      title: "Imported Component",
      mode: "element"
    };
  }
  throw new Error("Invalid FISH HTML clipboard payload");
}

export function createHtmlClipPayload(
  html: string,
  options: { title?: string; url?: string; mode?: "element" | "page" } = {}
): string {
  const payload: FishHtmlClipPayload = {
    format: FISH_HTML_CLIP_FORMAT,
    version: "0.1",
    html,
    title: options.title || "Imported Element",
    url: options.url,
    mode: options.mode ?? "element"
  };
  return JSON.stringify(payload);
}
