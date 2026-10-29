import { AssetRef, DesignDocument, DesignElement, VideoElement } from "../dsl/types";
import { getActivePage } from "../dsl/types";
import { createId } from "../id";
import { flattenElements } from "../geometry/tree-ops";
import { externalFetch } from "../net/external-fetch";

export const MAX_VIDEO_EDGE = 640;

export interface LoadedVideoData {
  asset: AssetRef;
  element: VideoElement;
}

export interface ParsedVideoEmbed {
  isEmbed: boolean;
  platform?: "youtube" | "vimeo" | "bilibili" | "dailymotion" | "direct";
  embedUrl: string;
  videoId?: string;
  defaultTitle?: string;
}

export function computeVideoTargetSize(
  width: number,
  height: number,
  maxEdge = MAX_VIDEO_EDGE
): { width: number; height: number } {
  const w = width > 0 ? width : 640;
  const h = height > 0 ? height : 360;
  const longest = Math.max(w, h);
  if (longest <= maxEdge) return { width: w, height: h };
  const scale = maxEdge / longest;
  return {
    width: Math.max(1, Math.round(w * scale)),
    height: Math.max(1, Math.round(h * scale))
  };
}

export function parseVideoUrl(rawUrl: string): ParsedVideoEmbed {
  const urlStr = rawUrl.trim();
  if (!urlStr) {
    return { isEmbed: false, platform: "direct", embedUrl: urlStr };
  }

  try {
    const u = new URL(urlStr);
    const host = u.hostname.toLowerCase();

    // YouTube: watch?v=, youtu.be, embed, shorts, live
    if (host.includes("youtube.com") || host.includes("youtu.be")) {
      let videoId = "";
      if (host.includes("youtu.be")) {
        videoId = u.pathname.slice(1).split("/")[0].split("?")[0];
      } else if (u.pathname.startsWith("/embed/")) {
        videoId = u.pathname.split("/embed/")[1].split("/")[0].split("?")[0];
      } else if (u.pathname.startsWith("/shorts/")) {
        videoId = u.pathname.split("/shorts/")[1].split("/")[0].split("?")[0];
      } else if (u.pathname.startsWith("/live/")) {
        videoId = u.pathname.split("/live/")[1].split("/")[0].split("?")[0];
      } else {
        videoId = u.searchParams.get("v") || "";
      }

      if (videoId) {
        return {
          isEmbed: true,
          platform: "youtube",
          videoId,
          embedUrl: `https://www.youtube-nocookie.com/embed/${videoId}`,
          defaultTitle: "YouTube Video"
        };
      }
    }

    // Vimeo: vimeo.com/123456789 or player.vimeo.com/video/123456789
    if (host.includes("vimeo.com")) {
      const match = u.pathname.match(/(?:videos?\/)?(\d+)/);
      if (match && match[1]) {
        const videoId = match[1];
        return {
          isEmbed: true,
          platform: "vimeo",
          videoId,
          embedUrl: `https://player.vimeo.com/video/${videoId}`,
          defaultTitle: "Vimeo Video"
        };
      }
    }

    // Bilibili: /video/BV... or /video/av...
    if (host.includes("bilibili.com")) {
      const bvMatch = u.pathname.match(/\/video\/(BV[\w\d]+)/i) || u.searchParams.get("bvid");
      const avMatch = u.pathname.match(/\/video\/av(\d+)/i) || u.searchParams.get("aid");
      if (bvMatch) {
        const bvid = typeof bvMatch === "string" ? bvMatch : bvMatch[1];
        return {
          isEmbed: true,
          platform: "bilibili",
          videoId: bvid,
          embedUrl: `https://player.bilibili.com/player.html?bvid=${bvid}&page=1&high_quality=1&as_wide=1`,
          defaultTitle: "Bilibili Video"
        };
      } else if (avMatch) {
        const aid = typeof avMatch === "string" ? avMatch : avMatch[1];
        return {
          isEmbed: true,
          platform: "bilibili",
          videoId: `av${aid}`,
          embedUrl: `https://player.bilibili.com/player.html?aid=${aid}&page=1&high_quality=1&as_wide=1`,
          defaultTitle: "Bilibili Video"
        };
      }
    }

    // Dailymotion: dailymotion.com/video/x... or dai.ly/x...
    if (host.includes("dailymotion.com") || host.includes("dai.ly")) {
      let videoId = "";
      if (host.includes("dai.ly")) {
        videoId = u.pathname.slice(1).split("/")[0];
      } else {
        const match = u.pathname.match(/\/video\/([a-zA-Z0-9]+)/);
        if (match) videoId = match[1];
      }
      if (videoId) {
        return {
          isEmbed: true,
          platform: "dailymotion",
          videoId,
          embedUrl: `https://www.dailymotion.com/embed/video/${videoId}`,
          defaultTitle: "Dailymotion Video"
        };
      }
    }
  } catch {
    // Ignore invalid URL
  }

  return { isEmbed: false, platform: "direct", embedUrl: urlStr };
}

/**
 * The hosts that render as a player frame, each with the path that makes it one.
 *
 * Matching `host + path` as one substring reads like an allowlist and is not
 * one: `https://example.com/?r=youtube.com/embed/` contains the string, and
 * answering true renders an inert `<video>` as a live unsandboxed frame that can
 * script, pop up, and navigate the top window. The two halves have to be
 * checked as what they are.
 */
const IFRAME_VIDEO_HOSTS: Array<{ host: string; path: string }> = [
  { host: "youtube.com", path: "/embed/" },
  { host: "youtube-nocookie.com", path: "/embed/" },
  { host: "player.vimeo.com", path: "/video/" },
  { host: "player.bilibili.com", path: "/player.html" },
  { host: "dailymotion.com", path: "/embed/video/" }
];

/** A registrable host and its subdomains, but not a host that merely ends with the same letters. */
function hostIs(hostname: string, base: string): boolean {
  return hostname === base || hostname.endsWith(`.${base}`);
}

export function isIframeVideoUrl(url: string): boolean {
  if (!url) return false;
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  const hostname = parsed.hostname.toLowerCase();
  return IFRAME_VIDEO_HOSTS.some(
    (entry) => hostIs(hostname, entry.host) && parsed.pathname.startsWith(entry.path)
  );
}

export function isVideoUrl(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.startsWith("data:video/")) return true;
  if (!/^https?:\/\/[^\s$.?#].[^\s]*$/i.test(trimmed)) {
    return false;
  }
  const parsed = parseVideoUrl(trimmed);
  if (parsed.isEmbed) return true;
  return (
    /\.(mp4|webm|ogg|mov|m4v)(\?.*)?$/i.test(trimmed) ||
    /(video\.|videos\.|stream\.|watch\?v=|\/video\/|\/videos\/)/i.test(trimmed)
  );
}

export function isVideoFile(file: File | Blob): boolean {
  const type = (file as File).type || "";
  if (type.startsWith("video/")) return true;
  const name = (file as File).name || "";
  return /\.(mp4|webm|ogg|mov|m4v)$/i.test(name);
}

/**
 * A URI that is a video BY ITSELF. Deliberately narrower than `isVideoUrl`,
 * which answers "should pasting this make a video element?" and guesses from
 * substrings (`/video/`, `watch?v=`) that an image URL also contains; an asset
 * already on the document has a shape we know, so the extension is all we need
 * to read it from. The `data:` short-circuit stops a `.png` in a data URI from
 * being read as a filename.
 */
export function isVideoAssetUri(uri: string): boolean {
  const trimmed = (uri || "").trim();
  if (trimmed.startsWith("data:")) return trimmed.startsWith("data:video/");
  return /\.(mp4|webm|ogg|mov|m4v)(\?.*)?$/i.test(trimmed);
}

/**
 * Whether an asset on the document is a video. The element scan runs FIRST
 * because it is the only answer that survives an extensionless URL: everything
 * the panel does with the answer (draw a frame or an icon, insert one element
 * kind or the other) has to agree with what a video element on the canvas
 * already points at.
 */
export function isVideoAsset(doc: DesignDocument, asset: AssetRef): boolean {
  return videoAssetIds(doc).has(asset.id) || isVideoAssetUri(asset.uri);
}

/**
 * Every asset on the document that is a video, by id.
 *
 * The per-asset form walks every page of the document, and the assets panel asks
 * it once per card: 107 cards × 1,841 elements per frame, on a panel that is
 * only open while the user pans. One walk per document answers all of them, and
 * the document object is replaced on every commit so the set cannot go stale.
 */
const videoIdsCache = new WeakMap<DesignDocument, Set<string>>();

export function videoAssetIds(doc: DesignDocument): Set<string> {
  const hit = videoIdsCache.get(doc);
  if (hit) return hit;
  const ids = new Set<string>();
  const pages = doc.pages && doc.pages.length > 0 ? doc.pages : [];
  const roots = pages.length > 0 ? pages.map((p) => p.children) : [getActivePage(doc).children || []];
  for (const root of roots) {
    for (const el of flattenElements(root)) {
      if (el.type === "video" && (el as VideoElement).assetId) ids.add((el as VideoElement).assetId);
    }
  }
  for (const asset of doc.assets ?? []) {
    if (isVideoAssetUri(asset.uri)) ids.add(asset.id);
  }
  videoIdsCache.set(doc, ids);
  return ids;
}

export function extractVideoNameFromUrl(url: string): string {
  try {
    const pathname = new URL(url).pathname;
    const segments = pathname.split("/").filter(Boolean);
    if (segments.length > 0) {
      const last = segments[segments.length - 1];
      const clean = decodeURIComponent(last).replace(/\.[^/.]+$/, "");
      if (clean) return clean;
    }
  } catch {
    // Ignore URL parse failure.
  }
  return "Video";
}

export function measureVideoIntrinsicSize(
  blobOrUrl: Blob | string,
  signal?: AbortSignal
): Promise<{ width: number; height: number; duration: number }> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ width: 640, height: 360, duration: 0 });
      return;
    }

    const video = document.createElement("video");
    video.preload = "metadata";
    video.muted = true;
    const isBlob = typeof blobOrUrl !== "string";
    const srcUrl = isBlob ? URL.createObjectURL(blobOrUrl) : blobOrUrl;

    const cleanup = () => {
      if (isBlob) URL.revokeObjectURL(srcUrl);
      video.removeAttribute("src");
      video.load();
    };

    const onAbort = () => {
      cleanup();
      resolve({ width: 640, height: 360, duration: 0 });
    };

    signal?.addEventListener("abort", onAbort, { once: true });

    video.onloadedmetadata = () => {
      signal?.removeEventListener("abort", onAbort);
      const width = video.videoWidth || 640;
      const height = video.videoHeight || 360;
      const duration = Number.isFinite(video.duration) ? video.duration : 0;
      cleanup();
      resolve({ width, height, duration });
    };

    video.onerror = () => {
      signal?.removeEventListener("abort", onAbort);
      cleanup();
      resolve({ width: 640, height: 360, duration: 0 });
    };

    video.src = srcUrl;
  });
}

export function createVideoElement(spec: {
  id?: string;
  name?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  assetId: string;
  autoplay?: boolean;
  loop?: boolean;
  muted?: boolean;
  controls?: boolean;
}): VideoElement {
  return {
    id: spec.id ?? createId("video"),
    type: "video",
    ...(spec.name ? { name: spec.name } : {}),
    x: Math.round(spec.x),
    y: Math.round(spec.y),
    width: Math.round(spec.width),
    height: Math.round(spec.height),
    assetId: spec.assetId,
    autoplay: spec.autoplay ?? false,
    loop: spec.loop ?? true,
    muted: spec.muted ?? true,
    controls: spec.controls ?? true,
    constraints: { preserveAspectRatio: true }
  };
}

function blobToDataUri(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Failed to read video file"));
    reader.onload = () => resolve(reader.result as string);
    reader.readAsDataURL(blob);
  });
}

export async function loadVideoFromFile(
  file: File | Blob,
  worldX = 0,
  worldY = 0,
  defaultName = "Video"
): Promise<LoadedVideoData> {
  const { width: naturalW, height: naturalH, duration } = await measureVideoIntrinsicSize(file);
  const { width, height } = computeVideoTargetSize(naturalW, naturalH, MAX_VIDEO_EDGE);

  const dataUri = await blobToDataUri(file);
  const assetId = createId("asset");
  const name = (file as File).name ? (file as File).name.replace(/\.[^/.]+$/, "") : defaultName;

  const asset: AssetRef = {
    id: assetId,
    name,
    uri: dataUri,
    width: naturalW,
    height: naturalH,
    duration
  };

  const element = createVideoElement({
    name,
    x: worldX,
    y: worldY,
    width,
    height,
    assetId,
    loop: true,
    muted: true,
    controls: true
  });

  return { asset, element };
}

export async function loadVideoFromUrl(
  url: string,
  worldX = 0,
  worldY = 0,
  defaultName?: string,
  signal?: AbortSignal
): Promise<LoadedVideoData> {
  const cleanUrl = url.trim();
  if (!cleanUrl) {
    throw new Error("URL is empty");
  }

  const parsed = parseVideoUrl(cleanUrl);
  const targetUri = parsed.isEmbed ? parsed.embedUrl : cleanUrl;

  let naturalW = 1920;
  let naturalH = 1080;
  let duration = 0;

  if (parsed.isEmbed) {
    // 16:9 standard resolution for web platform video embed
    naturalW = 1920;
    naturalH = 1080;
    duration = 0;
  } else {
    const size = await measureVideoIntrinsicSize(targetUri, signal);
    naturalW = size.width;
    naturalH = size.height;
    duration = size.duration;
  }

  const { width, height } = computeVideoTargetSize(naturalW, naturalH, MAX_VIDEO_EDGE);
  const name = defaultName || parsed.defaultTitle || extractVideoNameFromUrl(cleanUrl);
  const assetId = createId("asset");

  const asset: AssetRef = {
    id: assetId,
    name,
    uri: targetUri,
    width: naturalW,
    height: naturalH,
    ...(duration > 0 ? { duration } : {})
  };

  const element = createVideoElement({
    name,
    x: worldX,
    y: worldY,
    width,
    height,
    assetId,
    loop: true,
    muted: true,
    controls: true
  });

  return { asset, element };
}

export async function embedExternalVideoAsset(asset: AssetRef): Promise<AssetRef> {
  const url = asset.uri?.trim() || "";
  if (!url || (!url.startsWith("http://") && !url.startsWith("https://")) || isIframeVideoUrl(url)) {
    return asset;
  }

  const response = await externalFetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch video: ${response.statusText}`);
  }
  const blob = await response.blob();
  const dataUri = await blobToDataUri(blob);
  const { width, height, duration } = await measureVideoIntrinsicSize(blob);

  return {
    ...asset,
    uri: dataUri,
    width: width || asset.width,
    height: height || asset.height,
    duration: duration || asset.duration
  };
}
