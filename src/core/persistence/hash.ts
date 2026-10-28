export function stableHash(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * `stableHash` with the result remembered for the exact string it hashed.
 *
 * Documents carry their bitmaps inline, so the same 5 MB `data:` URI is hashed
 * again on every snapshot and every identity check — 39.6 MB of base64 in the
 * measured file, 226 ms of main thread per save. The strings are immutable and
 * carried across commits by reference, so the cache never goes stale; it is
 * capped rather than unbounded because a session that pastes many one-off
 * images would otherwise retain every URI it ever saw.
 */
const hashCache = new Map<string, string>();
const HASH_CACHE_LIMIT = 4096;

export function cachedHash(str: string): string {
  const hit = hashCache.get(str);
  if (hit !== undefined) return hit;
  const hash = stableHash(str);
  if (hashCache.size >= HASH_CACHE_LIMIT) hashCache.clear();
  hashCache.set(str, hash);
  return hash;
}
