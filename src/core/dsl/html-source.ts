/**
 * What an `html` element may be told to fetch, and where that is decided.
 *
 * The renderer drops `src` straight into an iframe, and a document is not
 * necessarily one this app wrote: `dsl.md` publishes `html`/`src` as a DSL
 * field that an external agent sets through `./fish compose`, and any `.fish.html`
 * arriving from elsewhere is untrusted input like any other. So the scheme is
 * checked where the document is read, not only where the picker offers it —
 * `javascript:` and `data:` must not survive a load just because nobody typed
 * them into the inspector.
 *
 * Only http(s) passes. A `file://` URL is unreachable from a page the browser
 * already loaded, and a `data:` URL is a document rather than a location; the
 * local file path is the `srcdoc` one.
 *
 * The sandbox on the frame (`HTML_EMBED_SANDBOX`) is the other half of this and
 * is deliberately stricter: even a fetched `https://` page is denied
 * `allow-same-origin`, so it runs in an opaque origin and cannot reach this
 * app's DOM, `localStorage`, or the IndexedDB behind it.
 */
export function isFrameableUrl(text: string): boolean {
  const trimmed = text.trim();
  if (!/^https?:\/\//i.test(trimmed)) return false;
  try {
    new URL(trimmed);
    return true;
  } catch {
    return false;
  }
}
