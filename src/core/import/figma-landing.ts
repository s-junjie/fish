/**
 * Where a converted Figma payload lands in the document that is already open.
 *
 * A paste and a picked file carry the SAME payload and mean different things: a
 * paste is content the designer is placing onto the page they are working on, a
 * picked file is a document arriving beside the one already open. The gesture
 * therefore picks the landing, and the payload's own page structure can
 * override it — a paste of a whole multi-page file still lands as pages,
 * because "onto the current page" cannot mean folding five boards into one.
 *
 * Everything here is pure: the hook keeps the toast, the selection and the
 * viewport, which are the parts that need a live editor.
 */

import {
  AssetRef,
  DesignDocument,
  DesignElement,
  getActivePage,
  updateActivePageElements,
  type Page
} from "../dsl/types";
import { createId } from "../id";
import { remintFragment } from "../interactions/clipboard-fragment";
import { FISH_CLIPBOARD_TAG } from "../interactions/clipboard-payload";
import { relayoutDocumentTree } from "../compile";
import { instanceSizeResolver } from "../interactions/instance-size";
import type { ImportFigmaFileOutcome } from "./figma-import";

export interface FigmaImportLanding {
  doc: DesignDocument;
  /** Every id that landed — the selection an import leaves behind. */
  landedIds: Set<string>;
  /** The landed content, for the view to fit. */
  landed: DesignElement[];
  /** `true` when the content joined the open page instead of pages of its own. */
  ontoCurrentPage: boolean;
}

/**
 * Land an import: onto the open page when a paste carries a single board, onto
 * pages of its own otherwise.
 *
 * Ids are document-wide, so the payload is re-minted into this document's id
 * space whichever way it lands. That is not tidiness: a second paste of the
 * same selection would otherwise land a second copy of every Figma id on a page
 * that already holds the first, and a colliding component id makes every
 * existing instance of it silently resolve to the imported copy. One remap
 * spans every page of the import, because a master synthesized for one canvas
 * is reachable from an instance on another.
 */
function pageHasComponents(page: Page): boolean {
  return page.children.some((el) => el.type === "component" || el.type === "componentSet");
}

function reflowImportedPages(
  doc: DesignDocument,
  importedPages: Page[]
): { pages: Page[]; resolverDoc: DesignDocument } {
  let fullDoc: DesignDocument = {
    ...doc,
    pages: [...(doc.pages ?? []), ...importedPages]
  };

  const pages = [...importedPages];
  for (let i = 0; i < pages.length; i++) {
    if (pageHasComponents(pages[i])) {
      pages[i] = {
        ...pages[i],
        children: relayoutDocumentTree(pages[i].children, instanceSizeResolver(fullDoc))
      };
    }
  }

  fullDoc = {
    ...doc,
    pages: [...(doc.pages ?? []), ...pages]
  };

  for (let i = 0; i < pages.length; i++) {
    if (!pageHasComponents(pages[i])) {
      pages[i] = {
        ...pages[i],
        children: relayoutDocumentTree(pages[i].children, instanceSizeResolver(fullDoc))
      };
    }
  }

  fullDoc = {
    ...doc,
    pages: [...(doc.pages ?? []), ...pages]
  };

  return { pages, resolverDoc: fullDoc };
}

export function landFigmaImport(
  doc: DesignDocument,
  result: ImportFigmaFileOutcome,
  options: { paste: boolean }
): FigmaImportLanding {
  const { pages, assets } = remintPages(doc, result);
  if (pages.length === 0) return { doc, landedIds: new Set(), landed: [], ontoCurrentPage: false };

  const ontoCurrentPage = options.paste && result.canvasCount <= 1;

  if (ontoCurrentPage) {
    // `canvasCount <= 1` means the payload is one board, so the first page is
    // that board and anything after it was synthesized by promotion (the
    // components page) — it still needs a home, because the instances now on
    // the open page resolve their masters by scanning every page.
    const [content, ...extras] = pages;
    const { pages: reflowedExtras, resolverDoc } = reflowImportedPages(doc, asNewPages(doc, extras));
    const resolver = instanceSizeResolver(resolverDoc);
    const pasted = relayoutDocumentTree(content.children, resolver);
    let next = updateActivePageElements(doc, [...getActivePage(doc).children, ...pasted]);
    next = {
      ...next,
      pages: [...next.pages, ...reflowedExtras],
      ...(assets.length > 0 ? { assets: [...(doc.assets ?? []), ...assets] } : {})
    };
    return { doc: next, landedIds: collectIds(pasted), landed: pasted, ontoCurrentPage: true };
  }

  const { pages: reflowedPages } = reflowImportedPages(doc, asNewPages(doc, pages));
  const active = reflowedPages[result.activePageIndex] ?? reflowedPages[0];
  return {
    doc: {
      ...doc,
      pages: [...(doc.pages ?? []), ...reflowedPages],
      activePageId: active.id,
      ...(assets.length > 0 ? { assets: [...(doc.assets ?? []), ...assets] } : {})
    },
    landedIds: collectIds(active.children),
    landed: active.children,
    ontoCurrentPage: false
  };
}

/**
 * Re-mint an import's id space into `doc`'s, page structure intact.
 *
 * `remintFragment` is the clipboard's consumer half — one implementation of
 * "mint a foreign fragment into this document", which is the same problem an
 * import has — and it remaps the references that travel inside a batch
 * (`componentId`, override targets, image-fill assets). It returns one flat
 * list in input order, so the pages are cut back out of it by the lengths they
 * went in with: the mapping is 1:1 and reorders nothing.
 */
function remintPages(
  doc: DesignDocument,
  result: ImportFigmaFileOutcome
): { pages: Page[]; assets: AssetRef[] } {
  const lengths = result.pages.map((page) => page.children.length);
  const fragment = remintFragment(doc, {
    tag: FISH_CLIPBOARD_TAG,
    clipId: createId("clip"),
    elements: result.pages.flatMap((page) => page.children),
    masters: [],
    assets: result.assets,
    styles: []
  });

  const pages: Page[] = [];
  let cursor = 0;
  result.pages.forEach((page, i) => {
    pages.push({ ...page, children: fragment.sources.slice(cursor, cursor + lengths[i]) });
    cursor += lengths[i];
  });
  return { pages, assets: fragment.assets };
}

/**
 * Mint a page id and a name that is not already on the rail.
 *
 * Page ids come from the document's own mint, never from Figma's: the same file
 * imported twice would otherwise land two pages under one id. Suffixed rather
 * than merged, because merging would silently drop the second import's content.
 */
function asNewPages(doc: DesignDocument, pages: Page[]): Page[] {
  const taken = new Set((doc.pages ?? []).map((p) => p.name));
  return pages.map((page) => {
    const name = uniquePageName(page.name, taken);
    taken.add(name);
    return { ...page, id: createId("page"), name };
  });
}

function uniquePageName(wanted: string, taken: Set<string>): string {
  if (!taken.has(wanted)) return wanted;
  let n = 2;
  while (taken.has(`${wanted} ${n}`)) n += 1;
  return `${wanted} ${n}`;
}

function collectIds(elements: DesignElement[]): Set<string> {
  const ids = new Set<string>();
  const walk = (list: DesignElement[]) => {
    for (const el of list) {
      ids.add(el.id);
      const children = (el as { children?: DesignElement[] }).children;
      if (children?.length) walk(children);
    }
  };
  walk(elements);
  return ids;
}
