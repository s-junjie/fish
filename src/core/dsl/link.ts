/**
 * The URL a layer carries, and the schemes it is allowed to use.
 *
 * Stored as one absolute URL string on the element. Deliberately not an object:
 * there is one axis to set — where it goes — and the opening side always uses a
 * new tab, so a `target` field would be a constant nothing reads. `link` is the
 * canonical spelling; `href` / `linkUrl` are absorbed by normalize.
 */

/** The only schemes a stored link may use. */
const LINK_SCHEMES: ReadonlySet<string> = new Set(["http:", "https:", "mailto:", "tel:"]);

const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

function parseLink(raw: string): URL | null {
  if (HAS_SCHEME.test(raw)) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return null;
    }
    // An unsupported scheme is REFUSED, not sanitized. `javascript:` and `data:`
    // reach `window.open` on the click path, and a scheme the document author
    // cannot be trusted with is not a link — the whole point of storing one is
    // that opening it is safe.
    return LINK_SCHEMES.has(url.protocol) ? url : null;
  }
  // No scheme: "example.com/pricing" is what a person types into the field, so it
  // is read as https rather than refused. A bare word is not a host and is dropped.
  if (!raw.includes(".")) return null;
  try {
    const url = new URL(`https://${raw}`);
    return url.hostname.includes(".") ? url : null;
  } catch {
    return null;
  }
}

/** The absolute URL to store, or `undefined` when the value is not a link. */
export function normalizeLink(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  return parseLink(trimmed)?.href;
}
