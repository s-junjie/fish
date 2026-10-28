import type {
  AssetInsertResult,
  AssetInsertTarget,
  AssetProvider,
  AssetSearchResult
} from "../../core/plugins/types";

const API = "https://commons.wikimedia.org/w/api.php";
const COMMONS_FILE = "https://commons.wikimedia.org/wiki/";
const MAX_PAGE_SIZE = 50;
const DEFAULT_PAGE_SIZE = 24;

interface MetadataValue {
  value?: string;
}

interface WikimediaImageInfo {
  url?: string;
  thumburl?: string;
  descriptionurl?: string;
  width?: number;
  height?: number;
  mime?: string;
  responsiveUrls?: Record<string, string>;
  extmetadata?: Record<string, MetadataValue>;
}

interface WikimediaPage {
  pageid?: number;
  title?: string;
  index?: number;
  imageinfo?: WikimediaImageInfo[];
}

interface WikimediaResponse {
  query?: { pages?: WikimediaPage[] };
}

class WikimediaError extends Error {}

/**
 * `Artist` and `Credit` arrive as HTML fragments. The panel prints them as
 * text, so tags become spaces and the handful of entities that appear in
 * Commons metadata are decoded.
 */
function plainText(value?: string): string {
  if (!value) return "";
  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/\s+/g, " ")
    .trim();
}

/** Wikimedia appends campaign parameters to image URLs; they are not identity. */
function cleanUrl(value?: string): string | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;
  try {
    const url = new URL(raw, COMMONS_FILE);
    for (const key of [...url.searchParams.keys()]) {
      if (key.startsWith("utm_")) url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return raw;
  }
}

function fileName(title?: string): string {
  return plainText(title).replace(/^File:/i, "").replace(/\.[a-z0-9]+$/i, "");
}

function creditOf(page: WikimediaPage, info: WikimediaImageInfo): AssetSearchResult["credit"] {
  const ext = info.extmetadata ?? {};
  const name =
    plainText(ext.Artist?.value) ||
    plainText(ext.Credit?.value) ||
    fileName(page.title) ||
    "Wikimedia Commons";
  const license = plainText(ext.LicenseShortName?.value);
  const url =
    cleanUrl(info.descriptionurl) ||
    `${COMMONS_FILE}${encodeURI((page.title ?? "File:").replace(/ /g, "_"))}`;
  return { name, url, ...(license ? { license } : {}) };
}

export type InsertRemoteImage = (
  result: AssetSearchResult,
  target: AssetInsertTarget
) => Promise<AssetInsertResult>;

export function createWikimediaProvider(insert: InsertRemoteImage): AssetProvider {
  return {
    id: "wikimedia",
    name: "Wikimedia Commons",
    kind: "image",
    remote: true,

    async search(query: string, limit: number = DEFAULT_PAGE_SIZE): Promise<AssetSearchResult[]> {
      const q = query.trim();
      if (!q) return [];

      const pageSize = Math.max(1, Math.min(Math.floor(limit) || DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE));
      const params = new URLSearchParams({
        action: "query",
        format: "json",
        formatversion: "2",
        origin: "*",
        generator: "search",
        gsrsearch: `${q} filetype:bitmap`,
        gsrnamespace: "6",
        gsrlimit: String(pageSize),
        prop: "imageinfo",
        iiprop: "url|size|mime|extmetadata",
        iiurlwidth: "500",
        iiextmetadatafilter: "LicenseShortName|LicenseUrl|Artist|Credit|ObjectName|ImageDescription"
      });

      const res = await fetch(`${API}?${params.toString()}`);
      if (res.status === 429) throw new WikimediaError("assets.throttled");
      if (!res.ok) throw new WikimediaError("assets.searchFailed");
      const data = (await res.json()) as WikimediaResponse;
      const pages = Array.isArray(data?.query?.pages) ? data.query!.pages! : [];

      return pages
        .slice()
        .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
        .flatMap((page): AssetSearchResult[] => {
          const info = page.imageinfo?.[0];
          if (!info) return [];
          if (info.mime && !info.mime.startsWith("image/")) return [];
          // Commons originals are routinely tens of megabytes. The API's 2x
          // thumbnail is the largest link it has already resolved for this file,
          // and is far cheaper to paint than making the document depend on a
          // multi-megabyte original that a slow network may never finish.
          const preview = cleanUrl(info.thumburl);
          const medium = cleanUrl(info.responsiveUrls?.["2"]);
          const src = medium ?? preview;
          if (!src) return [];

          const ext = info.extmetadata ?? {};
          const name =
            plainText(ext.ObjectName?.value) ||
            fileName(page.title) ||
            plainText(ext.ImageDescription?.value) ||
            "Wikimedia Commons image";

          return [
            {
              id: `wikimedia:${page.pageid ?? page.title ?? src}`,
              name,
              preview: preview ?? src,
              src,
              width: info.width,
              height: info.height,
              credit: creditOf(page, info)
            }
          ];
        });
    },

    async insert(result: AssetSearchResult, target: AssetInsertTarget): Promise<AssetInsertResult> {
      return insert(result, target);
    }
  };
}
