import type {
  AssetRef,
  DesignDocument,
  DesignElement,
  FontSpec,
  InstanceElement,
  Page
} from "./dsl/types";
import { adoptTopLevelElements, getActivePage } from "./dsl/types";
import { relayoutDocumentTree } from "./compile";
import { documentStem } from "./document-title";
import { createId } from "./id";
import { isContainer } from "./geometry/tree-ops";

/**
 * Bringing an incoming document into a tab that already holds one.
 *
 * Two doors, and they are not variations on each other: a replace makes the
 * incoming document THE document, a merge leaves everything already here alone
 * and appends what arrived as new pages. Everything in this module serves the
 * second, because it is the one that has to write into a document it did not
 * mint — and a document is not a page, so the collision surface is document-wide.
 */

/**
 * Append every page of `incoming` to `doc`, and land on the first of them.
 *
 * Ids are document-wide, not page-local (see `interactions/page-ops.ts`):
 * `findMasterComponent` scans every page, so an appended page that kept the
 * originals' ids turns each imported component into a shadow master and every
 * imported instance binds to whichever one is found first. The whole incoming
 * document is therefore re-id'd as ONE set, which is also what keeps a master on
 * page 1 reachable from an instance on page 4 of the same import — a per-page
 * remap would silently orphan it.
 *
 * A reference that leaves the imported set keeps pointing where it pointed. An
 * instance whose master was never in the file is already dangling, and minting a
 * master for it would invent content the user never imported.
 */
export function mergeDocumentPages(doc: DesignDocument, incomingDoc: DesignDocument): DesignDocument {
  // A single-page document may carry its tree at the top level instead of in a page.
  const incoming = adoptTopLevelElements(incomingDoc);
  const clones = (incoming.pages?.length ? incoming.pages : [synthesizePage(incoming)]).map(clonePage);
  const idMap = new Map<string, string>();
  clones.forEach((page) => page.children.forEach((el) => reid(el, idMap)));
  clones.forEach((page) => page.children.forEach((el) => rebind(el, idMap)));

  const taken = new Set(doc.pages.map((p) => p.name));
  const appended: Page[] = clones.map((page) => {
    const name = uniquePageName(page.name, taken);
    taken.add(name);
    return {
      ...page,
      id: createId("page"),
      name,
      // Only the active page is laid out on load, so a page nobody has visited
      // still carries the coordinates its author wrote — `usePageManagement`.
      children: relayoutDocumentTree(page.children)
    };
  });

  const active = appended[0];
  return {
    ...doc,
    pages: [...doc.pages, ...appended],
    activePageId: active.id,
    assets: mergeById(doc.assets, incoming.assets),
    styles: mergeById(doc.styles, incoming.styles),
    tokens: mergeById(doc.tokens, incoming.tokens),
    fonts: mergeFonts(doc.fonts, incoming.fonts)
  };
}

/** A document whose `pages` was pruned to nothing still has to land somewhere. */
function synthesizePage(incoming: DesignDocument): Page {
  return {
    id: "page_1",
    name: incoming.name || "Page 1",
    canvas: { ...(incoming.canvas as Page["canvas"]) },
    children: getActivePage(incoming).children
  };
}

function clonePage(page: Page): Page {
  return JSON.parse(JSON.stringify(page)) as Page;
}

function reid(node: DesignElement, idMap: Map<string, string>): void {
  const fresh = createId(node.type);
  idMap.set(node.id, fresh);
  node.id = fresh;
  if (isContainer(node)) (node.children || []).forEach((child) => reid(child, idMap));
}

function rebind(node: DesignElement, idMap: Map<string, string>): void {
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
  if (isContainer(node)) (node.children || []).forEach((child) => rebind(child, idMap));
}

/**
 * The imported pages are the only new names, but two pages from one file can
 * carry the same name. Ids are what the page rail keys on, but a rail reading
 * `Page 1, Page 1, Page 2` is a rail nobody can use.
 */
function uniquePageName(wanted: string, taken: Set<string>): string {
  const base = wanted.trim() || "Page";
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base} ${n}`)) n += 1;
  return `${base} ${n}`;
}

/**
 * Union by id, current document first. An id that already exists here wins: the
 * local copy is what every existing element resolves against, and swapping the
 * payload under it would repaint the design the user is looking at.
 */
function mergeById<T extends { id: string }>(
  current: readonly T[] | undefined,
  incoming: readonly T[] | undefined
): T[] | undefined {
  if (!incoming?.length) return current as T[] | undefined;
  const seen = new Set((current ?? []).map((entry) => entry.id));
  const added = incoming.filter((entry) => !seen.has(entry.id));
  return added.length ? [...(current ?? []), ...added] : (current as T[] | undefined);
}

/** Fonts are keyed by family, not id — two declarations would be two rules. */
function mergeFonts(
  current: FontSpec[] | undefined,
  incoming: FontSpec[] | undefined
): FontSpec[] | undefined {
  if (!incoming?.length) return current;
  const families = new Set((current ?? []).map((f) => f.family));
  const added = incoming.filter((f) => !families.has(f.family));
  return added.length ? [...(current ?? []), ...added] : current;
}

/**
 * The name offered by the export picker.
 *
 * `fileName` is the file this tab is editing (see `documentStem`): the sidecar
 * is the same document, so it carries the same name and only the extension
 * differs. Only a tab with no file at all falls back to the DSL's `name`,
 * which is free text and has to be sanitised into something a filesystem takes.
 */
export function documentJsonFileName(doc: DesignDocument, fileName?: string | null): string {
  const stem = documentStem(fileName, null);
  if (stem) return `${stem}.fish.json`;
  const base = (doc.name || "untitled")
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^\w.-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${base || "untitled"}.fish.json`;
}