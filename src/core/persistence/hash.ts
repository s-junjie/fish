export function stableHash(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * Longest string `cachedHash` will remember by value.
 *
 * The cache was introduced for the strings a document repeats on every
 * snapshot, and the expensive one is not a string at all — it is a whole
 * bitmap: `data:image/png;base64,…` runs to megabytes, and the measured file
 * carries 39.6 MB of them. A `Map` keyed by that string keeps the bitmap alive
 * for as long as the entry survives, which is "until 4,096 other keys arrive"
 * — gigabytes for a session that pastes many images and then deletes them.
 * Small strings (page JSON, text content) are bounded by `MAX_CACHED_CHARS`, so
 * they stay worth caching; big ones go through `objectHash`, whose key is the
 * object that owns the string.
 */
const MAX_CACHED_CHARS = 65_536;
/** Ceiling on everything the literal cache holds: 4,096 entries of 64 KB each. */
const MAX_CACHED_TOTAL_CHARS = 4_000_000;
const MAX_CACHED_ENTRIES = 4096;

let cachedChars = 0;
const hashCache = new Map<string, string>();

/**
 * `stableHash` with the result remembered for the exact string it hashed.
 *
 * Documents carry their bitmaps inline, so the same page JSON is hashed again
 * on every snapshot and every identity check. The strings are immutable and
 * carried across commits by reference, so the cache never goes stale; it is
 * capped rather than unbounded because a session that pastes many one-off
 * images would otherwise retain every string it ever saw.
 */
export function cachedHash(str: string): string {
  if (str.length > MAX_CACHED_CHARS) return stableHash(str);
  const hit = hashCache.get(str);
  if (hit !== undefined) return hit;
  const hash = stableHash(str);
  if (hashCache.size >= MAX_CACHED_ENTRIES || cachedChars + str.length > MAX_CACHED_TOTAL_CHARS) {
    hashCache.clear();
    cachedChars = 0;
  }
  hashCache.set(str, hash);
  cachedChars += str.length;
  return hash;
}

const objectHashes = new WeakMap<object, { str: string; hash: string }>();

/**
 * `cachedHash` for a bulky string an object owns — an `AssetRef`'s bitmap URI.
 *
 * Keying the digest by the owner is what makes it releasable: an asset ref
 * survives across commits, so the second snapshot of an unchanged image costs
 * nothing, and once the document (and the undo entries) let go of the ref, the
 * WeakMap lets the digest and the bitmap go with it.
 *
 * The string is compared before the entry is reused. Same object, different
 * bytes is a real case (a replaced image), and returning the old digest there
 * would file a new bitmap under the old one's key.
 */
export function objectHash(owner: object, str: string): string {
  if (str.length <= MAX_CACHED_CHARS) return cachedHash(str);
  const cached = objectHashes.get(owner);
  // By reference on the fast path: both sides are the same string object, and
  // comparing 5 MB of base64 by value would cost as much as hashing it.
  if (cached && cached.str === str) return cached.hash;
  const hash = stableHash(str);
  objectHashes.set(owner, { str, hash });
  return hash;
}
