import { insertRemoteImage } from "./remote-image";
import type {
  AssetInsertResult,
  AssetInsertTarget,
  AssetProvider,
  AssetSearchOptions,
  AssetSearchResult
} from "./types";

const API = "https://api.openverse.org/v1/images";
const ATTRIBUTION_HOME = "https://openverse.org";

/**
 * What each licence choice means to this API, in the API's own two parameters.
 * Verified against it rather than against its docs: `license` ORs
 * comma-separated slugs (`cc0,pdm` answers with both), while `license_type`
 * ANDs permissions (`commercial,modification` excludes non-commercial *and*
 * no-derivatives). The words themselves are only legal in `license_type` —
 * `license=commercial` is a 400, not a synonym. `result_count` is read back
 * ignoring the licence filter, so it is never the number to page on.
 */
export const OPENVERSE_LICENSE_FILTERS = {
  all: "",
  unrestricted: "license=cc0,pdm",
  commercial: "license_type=commercial",
  remixable: "license_type=commercial,modification"
} as const;

export type OpenverseLicenseFilter = keyof typeof OPENVERSE_LICENSE_FILTERS;

/**
 * The anonymous tier answers 401 rather than clamping when `page_size` is above
 * 20, so the cap has to be applied before the request is built. The panel asks
 * every provider for `ICON_PAGE_SIZE` (120), which is an icon-set page.
 */
const MAX_PAGE_SIZE = 20;

/**
 * The anonymous tier allows one request per second, and the panel debounces at
 * 250ms — so a pause long enough to think about the next word, and too short to
 * beat the limit, returns 429 on a query the user is still typing. Requests are
 * spaced instead: a queued request costs a fraction of a second, a rejected one
 * costs the round trip and a visible failure.
 */
const MIN_SPACING_MS = 1050;
let lastRequestAt = 0;

async function spaceRequests(): Promise<void> {
  const wait = lastRequestAt + MIN_SPACING_MS - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastRequestAt = Date.now();
}

/**
 * Test seam. The spacing is module state, so a suite that searches repeatedly
 * would otherwise spend a second per call waiting on a limit that is not under
 * test here.
 */
export function __resetOpenverseThrottle(): void {
  lastRequestAt = 0;
}

/** Error messages are i18n keys resolved by the panel. */
class OpenverseError extends Error {}

interface OpenverseImage {
  id: string;
  title?: string | null;
  url?: string | null;
  thumbnail?: string | null;
  creator?: string | null;
  foreign_landing_url?: string | null;
  width?: number | null;
  height?: number | null;
  attribution?: string | null;
  license?: string | null;
  license_version?: string | null;
  mature?: boolean;
}

/**
 * The author alone, so the name reads "Photo by Tim Sullivan" rather than
 * carrying a licence the document has no field for. The licence rides beside it
 * in `license` and the panel shows the two together.
 */
function creditName(image: OpenverseImage): string {
  return image.creator?.trim() || image.title?.trim() || "Unknown";
}

/**
 * "by-nc-sa" + "4.0" -> "CC BY-NC-SA 4.0".
 *
 * Two slugs are not CC licences at all, so they get their own names rather than
 * a "CC" prefix that would claim a brand neither carries: `cc0` is the CC
 * dedication and `pdm` is Wikimedia's Public Domain Mark.
 */
function licenceLabel(license?: string | null, version?: string | null): string {
  const id = license?.trim().toLowerCase();
  if (!id) return "";
  const suffix = version?.trim() ? ` ${version.trim()}` : "";
  if (id === "cc0") return `CC0${suffix}`;
  if (id === "pdm") return `Public domain${suffix}`;
  return `CC ${id.toUpperCase().replace(/^CC/, "")}${suffix}`;
}

function creditOf(image: OpenverseImage): AssetSearchResult["credit"] {
  const licence = licenceLabel(image.license, image.license_version);
  return {
    name: creditName(image),
    url: image.foreign_landing_url?.trim() || ATTRIBUTION_HOME,
    ...(licence ? { license: licence } : {})
  };
}

export const openverseProvider: AssetProvider = {
  id: "openverse",
  name: "Openverse",
  nameKey: "assets.sourceOpenverse",
  kind: "image",

  /**
   * `remote`, which is what keeps the panel from spending a request on an empty
   * query. This source needs no credential of its own.
   */
  remote: true,

  async search(
    query: string,
    limit: number = MAX_PAGE_SIZE,
    _offset: number = 0,
    options?: AssetSearchOptions
  ): Promise<AssetSearchResult[]> {
    const q = query.trim();
    if (!q) return [];

    const pageSize = Math.max(1, Math.min(Math.floor(limit) || MAX_PAGE_SIZE, MAX_PAGE_SIZE));
    const key = options?.license as OpenverseLicenseFilter | undefined;
    const filter = key ? OPENVERSE_LICENSE_FILTERS[key] : undefined;
    const url =
      `${API}/?q=${encodeURIComponent(q)}&page_size=${pageSize}&mature=false` +
      (filter ? `&${filter}` : "");

    await spaceRequests();
    const res = await fetch(url);
    if (res.status === 429 || res.status === 403) throw new OpenverseError("assets.throttled");
    if (!res.ok) throw new OpenverseError("assets.searchFailed");
    const data = (await res.json()) as { results?: OpenverseImage[] };
    const images = Array.isArray(data?.results) ? data.results : [];

    return images
      .filter((image) => image.mature !== true)
      .map((image) => {
        // The proxy on the API's own origin, not the source CDN: upstream hosts
        // disagree about hotlinking, and a grid cell that renders "broken" is
        // worse than a slightly softer preview.
        const preview = image.thumbnail?.trim() || undefined;
        return {
          id: `openverse:${image.id}`,
          name: image.title?.trim() || image.creator?.trim() || "Openverse image",
          preview,
          // Full size for the document; falls back to the proxy when the source
          // never published a direct URL.
          src: image.url?.trim() || preview,
          width: image.width ?? undefined,
          height: image.height ?? undefined,
          credit: creditOf(image)
        };
      })
      .filter((result) => result.src);
  },

  /**
   * Reference storage, and the URL it stores is the part that matters.
   *
   * A `.fish.html` keeps a *link*, so the one it keeps has to be a link a
   * browser can actually open. `url` is whatever host the work came from, and
   * those hosts referer-gate hotlinking, sit behind networks that block them,
   * or retire the path years later — measured here: all three Flickr results
   * failed to load while the API's own proxy served the same three at 600px
   * without complaint. The proxy is the same origin as the search that found the
   * work, which makes it the one link already known to resolve.
   *
   * So the original is tried first, for its resolution, and the proxy is the
   * fallback rather than the default. This is also why the size is read back off
   * the probe: `width`/`height` from the API describe the original, and a
   * document claiming 1024px over a 600px file is a lie the insert then sizes
   * the element from.
   *
   * Embedding the bytes instead would sidestep all of it, and cannot: the
   * originals are on third-party origins whose CORS posture is unknown, so
   * `fetch` → blob fails on an arbitrary share of them.
   *
   * Attribution is the obligation, and `credit` carries it.
   */
  async insert(result: AssetSearchResult, target: AssetInsertTarget): Promise<AssetInsertResult> {
    return insertRemoteImage(result, target);
  }
};
