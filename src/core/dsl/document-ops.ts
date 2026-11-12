import { DEFAULT_CANVAS_BACKGROUND } from "./defaults";
import type {
  DesignDocument,
  Page,
  CanvasSpec,
  DesignElement,
  FrameElement,
  ComponentElement,
  InstanceElement,
  RectElement,
  VideoElement,
  HtmlEmbedElement,
  PolygonElement,
  StarElement
} from "./types";

/**
 * The types that STORE `borderRadius` — the four whose interfaces declare it.
 * Named in one place because a corner-radius control gated on the wrong list
 * silently disappears for three of them: polygon and star are the ones that do
 * NOT, storing a single `cornerRadius` instead.
 */
export function isBorderRadiusHolder(
  el: DesignElement
): el is FrameElement | ComponentElement | InstanceElement | RectElement | VideoElement | HtmlEmbedElement {
  return (
    el.type === "rect" ||
    el.type === "frame" ||
    el.type === "component" ||
    el.type === "instance" ||
    el.type === "video" ||
    el.type === "html"
  );
}

/**
 * The types that declare or support `cornerSmoothing`: shapes (rect, polygon, star),
 * containers (frame, component) and projections (instance).
 */
export function hasCornerSmoothing(
  el: DesignElement
): el is FrameElement | RectElement | PolygonElement | StarElement | ComponentElement | InstanceElement {
  return (
    el.type === "rect" ||
    el.type === "frame" ||
    el.type === "polygon" ||
    el.type === "star" ||
    el.type === "component" ||
    el.type === "instance"
  );
}

/**
 * The page the user is looking at.
 *
 * `pages[i].children` is the ONLY storage for a page's tree. A single-page
 * document may write that tree at the top level instead; `adoptTopLevelElements`
 * is the single place that shape is understood, and the reader runs it, so
 * nothing downstream has a second array to keep in step.
 */
export function getActivePage(doc: DesignDocument): Page {
  if (!doc.pages || doc.pages.length === 0) {
    return {
      id: "page_default",
      name: "Page 1",
      canvas: doc.canvas || { unit: "px", background: { type: "solid", color: DEFAULT_CANVAS_BACKGROUND } },
      children: []
    };
  }
  return doc.pages.find((p) => p.id === doc.activePageId) || doc.pages[0];
}

export function updateActivePage(
  doc: DesignDocument,
  updater: (page: Page) => Partial<Page>
): DesignDocument {
  const activePage = getActivePage(doc);
  const activeId = activePage.id;
  const pages = doc.pages && doc.pages.length > 0 ? doc.pages : [activePage];
  const updatedPages = pages.map((p) => (p.id === activeId ? { ...p, ...updater(p) } : p));

  return {
    ...doc,
    pages: updatedPages,
    activePageId: activeId
  };
}

export function updateActivePageElements(
  doc: DesignDocument,
  elements: DesignElement[]
): DesignDocument {
  return updateActivePage(doc, () => ({ children: elements }));
}

/**
 * Writes one page's canvas BY ID.
 *
 * The page a deck is playing is not necessarily the document's active page: the
 * presentation switches pages without committing `activePageId`, so a write keyed
 * on "the active page" lands on the wrong canvas — the one behind the deck rather
 * than the one being presented.
 *
 * The document's canvas is the base of the merge rather than the page's alone, so
 * a page whose canvas predates a field — an imported file, a fixture — gains that
 * field's document value instead of writing a canvas with no `background`.
 */
export function updatePageCanvas(
  doc: DesignDocument,
  pageId: string,
  patch: Partial<CanvasSpec>
): DesignDocument {
  const pages = doc.pages && doc.pages.length > 0 ? doc.pages : [getActivePage(doc)];
  return {
    ...doc,
    pages: pages.map((p) =>
      p.id === pageId ? { ...p, canvas: { ...doc.canvas, ...p.canvas, ...patch } } : p
    )
  };
}

/**
 * A tree written at the top level — a fixture, a plugin payload, a single-page
 * document — is given to the first page. An explicit page always wins, so
 * running this on a paged document is a no-op.
 *
 * This is the adoption gate, not a second store: the key is read once, on the
 * way in, and never written back out.
 */
export function adoptTopLevelElements(doc: DesignDocument): DesignDocument {
  const raw = doc as DesignDocument & { elements?: unknown };
  if (!("elements" in raw)) return doc;
  const { elements: topLevel, ...rest } = raw;
  const clean = rest as DesignDocument;
  if (!Array.isArray(topLevel) || topLevel.length === 0) return clean;
  if (!clean.pages || clean.pages.length === 0) {
    return {
      ...clean,
      pages: [{ id: "page_1", name: "Page 1", canvas: clean.canvas, children: topLevel as DesignElement[] }],
      activePageId: "page_1"
    };
  }
  if (clean.pages.some((p) => p.children && p.children.length > 0)) return clean;
  const pages = clean.pages.slice();
  pages[0] = { ...pages[0], children: topLevel as DesignElement[] };
  return { ...clean, pages };
}
