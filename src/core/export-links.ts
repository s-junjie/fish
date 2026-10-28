const SVG_NS = "http://www.w3.org/2000/svg";
const LINK_ATTRIBUTE = "data-link";

/**
 * Turn the renderer's `data-link` marker into a real SVG `<a>`.
 *
 * The marker is what the app's own click handling resolves against, and it means
 * nothing in a file someone opens on its own — so the export replaces it, one
 * wrapper per linked group, rather than shipping an inert attribute. `target` is
 * set because a link in an exported diagram is almost never meant to navigate
 * away from it; HTML's `rel` rides along even though SVG has no such attribute,
 * because the same file is often re-embedded in a page that does.
 *
 * `href` alone, not `xlink:href` beside it: a namespaced attribute with no
 * `xmlns:xlink` declaration on the root makes the file invalid XML, and an
 * invalid SVG loaded as an image is a blank one. `href` is SVG 2 and is what
 * every browser that can open this file reads.
 *
 * Nested links are kept, not flattened: an SVG `<a>` is a container, and the
 * innermost one is what a click hits — the same rule the canvas's own
 * nearest-ancestor lookup follows.
 */
export function wrapLinkedElements(root: Element): void {
  // Collected before any splice: `querySelectorAll` is static, but the DOM it was
  // read from is not, and document order is what makes an outer link wrap first.
  for (const node of Array.from(root.querySelectorAll(`[${LINK_ATTRIBUTE}]`))) {
    const href = node.getAttribute(LINK_ATTRIBUTE);
    node.removeAttribute(LINK_ATTRIBUTE);
    const parent = node.parentNode;
    const doc = node.ownerDocument;
    if (!href || !parent || !doc) continue;
    const anchor = doc.createElementNS(SVG_NS, "a");
    anchor.setAttribute("href", href);
    anchor.setAttribute("target", "_blank");
    anchor.setAttribute("rel", "noopener noreferrer");
    parent.insertBefore(anchor, node);
    anchor.appendChild(node);
  }
}
