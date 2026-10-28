import { createId } from "../id";
import { createImageFillElement } from "../dsl/image-fill";
import { MAX_IMAGE_EDGE } from "../interactions/image-loader";
import type { AssetRef } from "../dsl/types";
import type { AssetInsertResult, AssetInsertTarget, AssetSearchResult } from "./types";

/**
 * How long a URL gets to prove it loads before the source is given up on.
 * Generous, because a slow true answer is still an answer and a wrong one costs
 * the user their image.
 */
const LOAD_PROBE_TIMEOUT_MS = 8000;

/**
 * Load a URL in an `<img>` purely to find out whether it resolves, and at what
 * size. Deliberately no `crossOrigin`: reading the pixels would need it, and
 * asking for it would reject every host that serves images without CORS headers
 * — while all we want is the `load` / `error` verdict and the intrinsic size.
 */
export function probeImage(src: string): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    const img = new Image();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (value: { width: number; height: number } | null) => {
      if (timer) clearTimeout(timer);
      resolve(value);
    };
    img.onload = () => settle({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => settle(null);
    timer = setTimeout(() => settle(null), LOAD_PROBE_TIMEOUT_MS);
    img.src = src;
  });
}

/**
 * A remote image is stored as a link, not bytes: the source may be on a
 * third-party origin whose CORS posture is unknown, so `fetch` → blob would fail
 * on an arbitrary share of them.
 *
 * The original is tried first for its resolution and the preview is the fallback
 * rather than the default; a host that referer-gates or retires the original may
 * still serve the source's own thumbnail. The size is read back off the probe,
 * because the dimensions the search API reports describe the original, and a
 * document claiming 1024px over a 600px file is a lie the element is sized from.
 *
 * Both links dead means the work is gone, or this network cannot reach either.
 * Failing is the point: a silent insert writes a URL into the file that nothing
 * will ever paint, and the layer reads as empty forever.
 */
export async function insertRemoteImage(
  result: AssetSearchResult,
  target: AssetInsertTarget
): Promise<AssetInsertResult> {
  const first = result.src?.trim() || result.preview?.trim();
  if (!first) throw new Error("assets.searchFailed");

  let uri = first;
  let size = await probeImage(uri);
  const fallback = result.preview?.trim();
  if (!size && fallback && fallback !== uri) {
    uri = fallback;
    size = await probeImage(uri);
  }
  if (!size) throw new Error("assets.imageUnavailable");

  // The source may ask for a smaller working box; the app's own image ceiling
  // is the hard limit neither the source nor the file can exceed. A cap never
  // enlarges, so a 1280px result still lands at 1280.
  const requested = result.displayMaxDimension;
  const cap = Math.min(requested !== undefined && requested > 0 ? requested : MAX_IMAGE_EDGE, MAX_IMAGE_EDGE);
  const longestEdge = Math.max(size.width, size.height);
  const scale = Math.min(1, cap / longestEdge);
  const asset: AssetRef = {
    id: createId("asset"),
    name: result.name,
    uri,
    width: size.width,
    height: size.height,
    // Projected, not forwarded. `AssetRef.credit` is the DSL and has no
    // `license` field, and normalize hands `credit` through whole, so an extra
    // key would ride into every saved file.
    credit: result.credit && { name: result.credit.name, url: result.credit.url }
  };
  const element = createImageFillElement({
    name: result.name,
    x: Math.round(target.x),
    y: Math.round(target.y),
    width: Math.round(size.width * scale),
    height: Math.round(size.height * scale),
    assetId: asset.id,
    fit: "cover"
  });
  return { element, asset };
}
