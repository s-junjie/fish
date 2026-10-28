/**
 * FISH Capture Chrome Extension — Background Service Worker
 *
 * Runs in the extension background with host_permissions: ["<all_urls>"].
 * Bypasses webpage CORS restrictions to fetch image binaries directly
 * from third-party CDNs (Pinterest, Dribbble, Unsplash, etc.) and
 * convert them into Base64 Data URIs for offline self-contained FISH documents.
 */

const FETCH_TIMEOUT_MS = 8000;
const MAX_IMAGE_BYTES = 15 * 1024 * 1024; // 15 MB safety ceiling per bitmap

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== "object") return;

  if (message.action === "inline-images") {
    inlineAllImages(message.urls || [])
      .then((results) => {
        sendResponse({ success: true, results });
      })
      .catch((err) => {
        sendResponse({ success: false, error: err?.message || String(err), results: {} });
      });
    return true; // Keep message port open for async response
  }

  if (message.action === "inline-single-image") {
    fetchImageAsDataUrl(message.url)
      .then((dataUrl) => {
        sendResponse({ success: true, dataUrl });
      })
      .catch((err) => {
        sendResponse({ success: false, error: err?.message || String(err) });
      });
    return true;
  }
});

/**
 * Concurrently fetch and convert an array of URLs to Base64 Data URIs.
 */
async function inlineAllImages(urls) {
  const results = {};
  if (!Array.isArray(urls) || urls.length === 0) return results;

  const uniqueUrls = Array.from(
    new Set(urls.filter((u) => typeof u === "string" && /^https?:\/\//i.test(u.trim())))
  );

  const concurrency = 8;
  let cursor = 0;

  async function worker() {
    while (cursor < uniqueUrls.length) {
      const idx = cursor++;
      const url = uniqueUrls[idx];
      try {
        const dataUrl = await fetchImageAsDataUrl(url);
        if (dataUrl) {
          results[url] = dataUrl;
        }
      } catch (err) {
        console.warn("FISH: Background fetch skipped for", url, err);
      }
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, uniqueUrls.length) },
    () => worker()
  );
  await Promise.all(workers);
  return results;
}

/**
 * Fetch a single image URL and encode it as a Data URI.
 */
async function fetchImageAsDataUrl(rawUrl) {
  const url = (rawUrl || "").trim();
  if (!url || !/^https?:\/\//i.test(url)) return null;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    // `cache: "force-cache"` leverages images already loaded by the page
    const resp = await fetch(url, {
      signal: controller.signal,
      cache: "force-cache",
      credentials: "omit"
    });
    clearTimeout(timer);

    if (!resp.ok) return null;

    const arrayBuffer = await resp.arrayBuffer();
    if (arrayBuffer.byteLength === 0 || arrayBuffer.byteLength > MAX_IMAGE_BYTES) {
      return null;
    }

    const mime = detectMimeType(resp.headers.get("content-type"), url);
    const base64 = bufferToBase64(arrayBuffer);
    return `data:${mime};base64,${base64}`;
  } catch {
    return null;
  }
}

/**
 * Convert an ArrayBuffer into Base64 safely using chunking to avoid stack limits.
 */
function bufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  const CHUNK_SIZE = 16384;
  let binary = "";
  for (let i = 0; i < len; i += CHUNK_SIZE) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + CHUNK_SIZE, len)));
  }
  return btoa(binary);
}

/**
 * Determine the MIME type from header or URL extension.
 */
function detectMimeType(headerType, url) {
  if (headerType && headerType.startsWith("image/")) {
    return headerType.split(";")[0].trim().toLowerCase();
  }
  const clean = url.split("?")[0].toLowerCase();
  if (clean.endsWith(".png")) return "image/png";
  if (clean.endsWith(".jpg") || clean.endsWith(".jpeg")) return "image/jpeg";
  if (clean.endsWith(".webp")) return "image/webp";
  if (clean.endsWith(".svg")) return "image/svg+xml";
  if (clean.endsWith(".gif")) return "image/gif";
  if (clean.endsWith(".avif")) return "image/avif";
  if (clean.endsWith(".ico")) return "image/x-icon";
  return "image/png";
}
