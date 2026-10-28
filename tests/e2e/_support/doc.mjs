/**
 * The active page's tree, read the way the editor reads it.
 *
 * `getDoc()` hands back the document itself: a page's tree lives in
 * `pages[i].children` and nowhere else. A probe that wants "the elements on the
 * canvas" therefore asks the page — inside `page.evaluate` that is
 * `window.__FISH_BRIDGE__.getElements()`, and on the Node side this is the same
 * reading of an already-fetched document.
 */
export function activeElements(doc) {
  const pages = doc.pages || [];
  const page = pages.find((p) => p.id === doc.activePageId) || pages[0];
  return page ? page.children : [];
}
