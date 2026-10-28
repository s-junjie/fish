import type { AssetSearchResult } from "../../core/plugins/types";

const API = "https://pixabay.com/api/";

export type PixabayErrorCode = "invalidKey" | "throttled" | "searchFailed";

/** Messages are codes, not prose: the panel owns the locale. */
export class PixabayError extends Error {
  constructor(readonly code: PixabayErrorCode) {
    super(code);
    this.name = "PixabayError";
  }
}

interface PixabayHit {
  id: number;
  pageURL?: string;
  tags?: string;
  previewURL?: string;
  webformatURL?: string;
  largeImageURL?: string;
  imageWidth?: number;
  imageHeight?: number;
  user?: string;
}

/**
 * Search only. Insertion goes through the host's generic remote-image path, so
 * this module never builds an element or knows where a page's tree lives.
 *
 * Pixabay's free tier is 100 requests per minute, and the panel searches on
 * submit rather than while typing — no client-side spacing is needed here.
 */
export async function searchPixabay(
  apiKey: string,
  query: string,
  limit = 24
): Promise<AssetSearchResult[]> {
  const key = apiKey.trim();
  const q = query.trim();
  if (!key || !q) return [];

  const params = new URLSearchParams({
    key,
    q,
    image_type: "photo",
    safesearch: "true",
    per_page: String(Math.max(3, Math.min(Math.floor(limit) || 24, 200)))
  });

  const res = await fetch(`${API}?${params.toString()}`);
  // Pixabay answers an unknown key with 400, not 401, and says so only in the
  // body — the status is the only reliable signal.
  if (res.status === 400 || res.status === 401) throw new PixabayError("invalidKey");
  if (res.status === 429) throw new PixabayError("throttled");
  if (!res.ok) throw new PixabayError("searchFailed");

  const data = (await res.json()) as { hits?: PixabayHit[] };
  const hits = Array.isArray(data?.hits) ? data.hits : [];

  return hits
    .map((hit) => {
      // `largeImageURL` is 1280px and the best link to keep; `webformatURL`
      // (640px) is the grid thumbnail and the fallback for the document.
      const src = hit.largeImageURL?.trim() || hit.webformatURL?.trim();
      const preview = hit.webformatURL?.trim() || hit.previewURL?.trim();
      if (!src) return null;

      const result: AssetSearchResult = {
        id: `pixabay:${hit.id}`,
        name: hit.tags?.trim() || `Pixabay ${hit.id}`,
        preview,
        src,
        width: hit.imageWidth ?? undefined,
        height: hit.imageHeight ?? undefined,
        credit: {
          name: hit.user?.trim() || "Pixabay",
          url: hit.pageURL?.trim() || "https://pixabay.com",
          license: "Pixabay"
        }
      };
      return result;
    })
    .filter((result): result is AssetSearchResult => result !== null);
}
