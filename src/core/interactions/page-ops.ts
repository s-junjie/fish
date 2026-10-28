import type { DesignDocument, DesignElement, InstanceElement, Page } from "../dsl/types";
import { updateActivePage } from "../dsl/types";
import { createId } from "../id";
import { isContainer } from "../geometry/tree-ops";
import { normalizePageViewport, type PageViewport } from "../geometry/viewport";
import { stripDerivedMarkers } from "./instance-resolve";

/**
 * Copy a page's elements into ids of their own.
 *
 * Ids are document-wide unique, not page-local: `findMasterComponent` scans
 * every page for a component id, so a copy that kept the originals made each
 * duplicate a shadow master. An instance living on the copy resolved to the
 * *first* page's component instead — editing the original silently restyled the
 * duplicate. Copying ids verbatim also made `findElementById` permanently blind
 * to the second element with that id.
 *
 * The instances rebind to their page-local masters, matching what duplicating a
 * page in Figma does: the copy is self-contained rather than a view of the
 * original. An instance whose master is NOT part of the copied set keeps
 * pointing at it — that is a reference to something the page never owned, and
 * rewriting it would be inventing a master that does not exist.
 */
export function duplicatePageElements(elements: readonly DesignElement[]): DesignElement[] {
  const copies = elements.map((el) => stripDerivedMarkers(structuredCopy(el)));
  const idMap = new Map<string, string>();

  const reid = (node: DesignElement) => {
    const fresh = createId(node.type);
    idMap.set(node.id, fresh);
    node.id = fresh;
    if (isContainer(node)) (node.children || []).forEach(reid);
  };
  copies.forEach(reid);

  const rebind = (node: DesignElement) => {
    if (node.type === "instance") {
      const mapped = idMap.get((node as InstanceElement).componentId);
      if (mapped) (node as InstanceElement).componentId = mapped;
    }
    // A text run anchored to a path stays anchored only if the path came along.
    const onPath = (node as unknown as { onPath?: { pathId?: string } }).onPath;
    if (onPath && typeof onPath.pathId === "string") {
      const mapped = idMap.get(onPath.pathId);
      if (mapped) onPath.pathId = mapped;
    }
    if (isContainer(node)) (node.children || []).forEach(rebind);
  };
  copies.forEach(rebind);

  return copies;
}

function structuredCopy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

/**
 * The document as it should be written to a file: the page the user is on, seen
 * from the view they are on it with.
 *
 * Folding the viewport in at the write is the only way it can be right. Storing
 * it as the user pans would put every wheel tick on the undo stack and make a
 * file dirty that nothing but the camera has changed; leaving it to the page
 * switch is what made a document saved without ever leaving its page reopen at
 * the default zoom.
 */
export function withActivePageViewport(doc: DesignDocument, viewport: PageViewport): DesignDocument {
  const stored = normalizePageViewport(viewport);
  if (!stored) return doc;
  return updateActivePage(doc, (p) => ({ metadata: { ...(p.metadata ?? {}), viewport: stored } }));
}

/** A page copy with its own id, name, and freshly minted element ids. */
export function duplicatePage(page: Page): Page {
  return {
    id: createId("page"),
    name: `${page.name} Copy`,
    canvas: { ...page.canvas },
    children: duplicatePageElements(page.children),
    ...(page.metadata ? { metadata: { ...page.metadata } } : {})
  };
}
