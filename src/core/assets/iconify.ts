/**
 * Iconify transport. Edit-time only — nothing here reaches the artifact, because
 * an icon is flattened into a `path` element on insert and the document then
 * carries plain schema data.
 *
 * Three endpoints, and they are not interchangeable:
 *
 * - `/{prefix}.json?icons=` carries the bodies and is served
 *   `cache-control: public, max-age=604800, immutable`. Send icon names sorted
 *   and it is one cache entry per page of results, so re-searching costs
 *   nothing and there is no reason to cache it ourselves.
 * - `/collection?prefix=` is the name list, and it is the one endpoint with a
 *   live rate limit: hammering it earns a 429 that outlives the tab, while the
 *   other two sit behind the CDN and never rate-limit. It is fetched once and
 *   kept in `localStorage` for a week, which is also why filtering runs here
 *   instead of on the server — every keystroke is a local scan.
 * - `/collections?prefixes=` is free, cached, and returns the licence and author
 *   a set has to carry, so one call covers every set the panel offers.
 *
 * `/search` is deliberately not used: it is the cross-set endpoint, and asking
 * it per keystroke is the one pattern that gets a caller throttled.
 */

const HOSTS = ["https://api.iconify.design", "https://api.simplesvg.com", "https://api.unisvg.com"];

const CACHE_PREFIX = "fish.iconify.";
const COLLECTION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface IconifyIcon {
  body: string;
  /** Set-local width/height; 24 for both sets here, but the field exists. */
  width?: number;
  height?: number;
  left?: number;
  top?: number;
  rotate?: number;
}

export interface IconifyAlias {
  parent: string;
}

interface IconifyBatch {
  prefix?: string;
  width?: number;
  height?: number;
  icons?: Record<string, IconifyIcon>;
  aliases?: Record<string, IconifyAlias>;
  not_found?: string[];
}

/** A set's identity and licence. `/collections` returns this for many at once. */
export interface IconifyCollection {
  prefix: string;
  name: string;
  total: number;
  license?: { title: string; spdx: string; url: string };
  author?: { name: string; url: string };
  homepage?: string;
  height?: number;
  samples?: string[];
}

interface CollectionsResponse {
  collections?: Record<string, IconifyCollection>;
  alias?: Record<string, unknown>;
}

interface CollectionNamesResponse {
  prefix?: string;
  icons?: Record<string, unknown>;
  uncategorized?: string[];
  hidden?: string[];
  categories?: Record<string, string[]>;
  aliases?: Record<string, IconifyAlias>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Read a JSON body, or throw — an HTML error page from a rate limit is not JSON. */
async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) {
    const err = new Error(`${res.status} ${res.statusText} for ${url}`) as Error & { status: number };
    err.status = res.status;
    throw err;
  }
  return (await res.json()) as T;
}

/** One request, tried against each mirror in turn. A 404 is not worth retrying. */
async function request<T>(path: string): Promise<T> {
  let lastError: unknown;
  for (const host of HOSTS) {
    try {
      return await getJson<T>(host + path);
    } catch (err) {
      lastError = err;
      const status = (err as { status?: number }).status;
      if (status === 404) break;
      await sleep(120);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/**
 * Iconify caps a URL, so a long name list has to travel in batches. 150 is well
 * inside the limit for the 24-unit sets here and keeps each batch to one CDN
 * cache entry.
 */
const BATCH = 150;

function readCache<T>(key: string): T | undefined {
  try {
    const raw = globalThis.localStorage?.getItem(CACHE_PREFIX + key);
    return raw ? (JSON.parse(raw) as T) : undefined;
  } catch {
    return undefined;
  }
}

function writeCache(key: string, value: unknown): void {
  try {
    globalThis.localStorage?.setItem(CACHE_PREFIX + key, JSON.stringify(value));
  } catch {
    // A full or disabled storage quota costs a refetch, not a broken panel.
  }
}

const collectionsCache = new Map<string, IconifyCollection[]>();
const namesCache = new Map<string, string[]>();
const inFlight = new Map<string, Promise<unknown>>();

/** Collapse concurrent callers onto one request; the entry is dropped on
 * rejection so a failure is a refetch, never a cached fact. */
function once<T>(key: string, run: () => Promise<T>): Promise<T> {
  const existing = inFlight.get(key);
  if (existing) return existing as Promise<T>;
  const p = run().finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}

/** Metadata for the sets the panel offers, in one request. */
export function fetchCollections(prefixes: string[]): Promise<IconifyCollection[]> {
  const key = prefixes.join(",");
  const cached = collectionsCache.get(key);
  if (cached) return Promise.resolve(cached);
  return once(`collections:${key}`, async () => {
    const res = await request<CollectionsResponse>(
      `/collections?prefixes=${prefixes.map(encodeURIComponent).join(",")}`
    );
    const list = prefixes.map((p) => res.collections?.[p]).filter((c): c is IconifyCollection => !!c);
    if (list.length > 0) collectionsCache.set(key, list);
    return list;
  });
}

/** Every icon name in a set, cached for a week because the endpoint is live. */
export function fetchIconNames(prefix: string): Promise<string[]> {
  const cached = namesCache.get(prefix);
  if (cached) return Promise.resolve(cached);
  return once(`names:${prefix}`, async () => {
    const cacheKey = `names:${prefix}`;
    const stored = readCache<{ at: number; names: string[] }>(cacheKey);
    if (stored && Date.now() - stored.at < COLLECTION_TTL_MS) {
      namesCache.set(prefix, stored.names);
      return stored.names;
    }
    const res = await request<CollectionNamesResponse>(`/collection?prefix=${encodeURIComponent(prefix)}`);
    const names = [
      ...(res.uncategorized || []),
      ...(res.hidden || []),
      ...Object.values(res.categories || {}).flat(),
      ...Object.keys(res.aliases || {})
    ];
    const unique = [...new Set(names)].sort();
    namesCache.set(prefix, unique);
    writeCache(cacheKey, { at: Date.now(), names: unique });
    return unique;
  });
}

export interface IconifyBodies {
  /** Name to body, with alias parents alongside the names that point at them. */
  icons: Record<string, IconifyIcon>;
  /** Name to the name its body actually arrived under. */
  aliases: Record<string, IconifyAlias>;
  /** Set box, from the first response that carried one. */
  width?: number;
  height?: number;
  notFound: string[];
}

/**
 * Bodies for a page of names. Names are sorted before they are sent: the CDN
 * keys on the whole URL, so the same page in the same order is one immutable
 * entry no matter what the user typed to get there.
 */
export function fetchIconBodies(prefix: string, names: string[]): Promise<IconifyBodies> {
  if (names.length === 0) return Promise.resolve({ icons: {}, aliases: {}, notFound: [] });
  const sorted = [...names].sort();
  return once(`bodies:${prefix}:${sorted.join(",")}`, async () => {
    const icons: Record<string, IconifyIcon> = {};
    const aliases: Record<string, IconifyAlias> = {};
    const notFound: string[] = [];
    let width: number | undefined;
    let height: number | undefined;

    for (let i = 0; i < sorted.length; i += BATCH) {
      const batch = sorted.slice(i, i + BATCH);
      const res = await request<IconifyBatch>(
        `/${encodeURIComponent(prefix)}.json?icons=${batch.map(encodeURIComponent).join(",")}`
      );
      width = width ?? res.width;
      height = height ?? res.height;
      Object.assign(icons, res.icons || {});
      Object.assign(aliases, res.aliases || {});
      notFound.push(...(res.not_found || []));
    }

    return { icons, aliases, width, height, notFound };
  });
}

/** An alias is answered with its parent's body under the parent's name, so
 * `home` has to be read back out of `house` or it looks like a 404. */
export function resolveAlias(
  name: string,
  batch: Pick<IconifyBodies, "icons" | "aliases">
): IconifyIcon | undefined {
  const direct = batch.icons[name];
  if (direct) return direct;
  const parent = batch.aliases[name]?.parent;
  return parent ? batch.icons[parent] : undefined;
}

/** Test seam: the panel never needs to clear these, but a test does. */
export function __resetIconifyCaches(): void {
  collectionsCache.clear();
  namesCache.clear();
  inFlight.clear();
}
