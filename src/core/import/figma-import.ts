/**
 * Figma file → Design DSL.
 *
 * Unlike the HTML importer, this one does not need a layout engine to find out
 * where anything goes: Figma already stores absolute bounds for every node, and
 * its auto-layout is the DSL's auto-layout field for field. So the pipeline is the
 * plain one — map, then MEASURE what came out against what Figma said, and let
 * the same `verifyImport` the HTML importer uses downgrade any container the engine
 * cannot reproduce.
 *
 * That reuse is the point. The DSL's absolute box model is the common ground
 * between "a page laid out by Chromium" and "a file authored by a designer", and
 * one verifier over both is what stops the two importers from disagreeing about
 * what a correct layout is.
 *
 * This is a one-shot conversion, not a runtime: the result is ordinary editable
 * elements, and nothing here ships into the saved document.
 *
 * ONE DOOR. A Figma file arrives as the plugin's export — a `document` in Figma's
 * own file-response shape plus the image bytes beside it — and nothing here
 * fetches anything: `figma-export.ts` unwraps the envelope and this maps it. The
 * REST door (a file key plus a seat-spending token) is gone; `figma-client.ts`
 * with it. See `docs/FIGMA_IMPORT_PLAN.md` §0.
 */

import type { AssetRef, DesignElement, Page } from "../dsl/types";
import { bindStylesByValue } from "./style-binding";
import { verifyImport, type Downgrade } from "./html-verify";
import { buildFigmaPages, promoteFigmaInstances } from "./figma-document";
import { createFigmaTokens } from "./figma-tokens";
import { createFigmaStyles, type FigmaStyleIndex } from "./figma-styles";
import type { NodeWalkState } from "./figma-node";
import { importedDesignSystem } from "./imported-tokens";
import {
  collectFigmaImageRefs,
  emptyFigmaAssetStore,
  figmaAssetStoreFromBlobs,
  figmaAssetStoreFromUris,
  type FigmaAssetStore
} from "./figma-assets";
import {
  DEFAULT_MAX_ELEMENTS,
  type FigmaFileResponse,
  type FigmaGap,
  type FigmaImportOptions,
  type FigmaImportResult,
  type FigmaNode
} from "./figma-types";

export interface ImportFigmaFileOutcome extends FigmaImportResult {
  assets: AssetRef[];
  /**
   * How many pages the payload itself carried, counted BEFORE promotion
   * synthesized anything. `pages.length` cannot answer it: a one-canvas file
   * whose selection holds instances reports two pages, because promotion adds a
   * components page — and "is this one board or several" is the question the
   * landing has to ask (`figma-landing.ts`).
   */
  canvasCount: number;
}

/**
 * Convert a fetched `GET /v1/files/:key` response into pages.
 *
 * Every page is verified, not only the active one: a page the user switches to
 * three clicks later is exactly as wrong as the first one, and finding out then
 * is the worst moment to find out.
 */
export async function importFigmaFile(
  json: FigmaFileResponse | FigmaNode,
  options: FigmaImportOptions = {}
): Promise<ImportFigmaFileOutcome> {
  const maxElements = options.maxElements ?? DEFAULT_MAX_ELEMENTS;

  // All async work before the walk, so the walk stays a pure lookup — the same
  // split `html-assets.ts` exists to enforce.
  const images = await resolveImages(options, json);
  // Only the plugin door publishes variables: REST's `/v1/files` has no member
  // for them at all. A payload carrying none is therefore a file nobody could
  // ASK, not a file without a design system, and it has to mean "bind nothing"
  // rather than "mint a token per colour".
  const declared = json as FigmaFileResponse;

  // Built before the walk so a variable a hundred layers bind is one token:
  // a file's design system is a property of the file, not of each layer.
  const tokens = createFigmaTokens(declared.variables, declared.variableCollections, { tokens: options.tokens });
  // Styles are minted lazily, on the first layer that points at one — a file's
  // style library is the team's, and a board that uses three of forty should not
  // arrive with the other thirty-seven.
  const styles = createFigmaStyles(declared.styles, tokens, {
    styles: options.styles,
    resolve: (ref) => images.idFor(ref)
  });

  const state: NodeWalkState = {
    measured: new Map(),
    gaps: [],
    imageRefs: [],
    elementCount: 0,
    maxElements,
    usedIds: new Set(),
    images,
    tokens,
    styles
  };

  const built = buildFigmaPages(json, state, maxElements);
  if (built.pages.length === 0) throw new Error("That Figma file has no pages");

  // MEASURE BEFORE PROMOTION, and the order is the whole point.
  //
  // `state.measured` is Figma's own canvas position for every node, which is the
  // ground truth only while the tree still IS Figma's tree. Two things break that,
  // and both are silent:
  //
  //   - Promotion replaces an INSTANCE's frame — and everything inside it — with a
  //     link. Measured afterwards, an instance's subtree is never checked at all.
  //   - Promotion's masters are clones laid out on a synthetic page, in a grid of
  //     their own. Measured afterwards, every clone is compared against the
  //     ORIGINAL instance's canvas position and misses by the distance between
  //     the two — a real import of a design with components reported 95
  //     "containers kept their measured position" and a 26000px delta, all of it
  //     describing masters that were never in Figma to begin with.
  //
  // So the tree is verified and repaired first, where every measured box means
  // something, and the relink happens afterwards on geometry that is already
  // settled. Promotion changes which element an instance points at; it does not
  // move anything.
  const downgraded: Downgrade[] = [];
  let maxDelta = 0;
  let maxTextDelta = 0;
  let styleBindings = 0;

  for (const page of built.pages) {
    const verified = verifyImport(page.children, state.measured);
    page.children = verified.elements;
    downgraded.push(...verified.downgraded);
    maxDelta = Math.max(maxDelta, verified.maxDelta);
    maxTextDelta = Math.max(maxTextDelta, verified.maxTextDelta);
  }

  const promoted = promoteFigmaInstances(built.pages);

  const pages = promoted.map((page): Page => {
    const bound = bindStylesByValue(page.children, options.styles ?? []);
    styleBindings += bound.bound;
    return { ...page, children: bound.elements };
  });

  if (pages.every((page) => page.children.length === 0)) {
    throw new Error("That Figma file has no layers on any page");
  }

  return {
    pages,
    activePageIndex: 0,
    elements: pages[0].children,
    assets: images.assets,
    imageFills: images.uris,
    canvasCount: built.pages.length,
    ...(tokens.tokens.length + styles.styles.length > 0
      ? { tokens: importedDesignSystem(tokens.tokens, tokens.colorModes, styles.styles, tokens.numberModes) }
      : {}),
    report: {
      elementCount: state.elementCount,
      pageCount: pages.length,
      downgraded,
      unmapped: [
        ...aggregateGaps(state.gaps),
        ...styleGaps(styles),
        ...imageGaps(images)
      ],
      maxDelta: round2(maxDelta),
      maxTextDelta: round2(maxTextDelta),
      styleBindings,
      tokensCreated: tokens.tokens.length,
      tokenBindings: tokens.bound,
      stylesCreated: styles.styles.length,
      styleLinks: styles.links
    }
  };
}

/**
 * A style this import could not express, named.
 *
 * A GRID style is the common case: the DSL's grid is a layout its container
 * carries rather than a named preset, so there is nothing for a layer to point
 * at. Recorded rather than dropped — the same discipline every other gap gets.
 */
function styleGaps(styles: FigmaStyleIndex): FigmaGap[] {
  return styles.unsupported.map((style) => ({
    id: style.id,
    name: style.name,
    property: `style:${style.styleType.toLowerCase()}`
  }));
}

async function resolveImages(options: FigmaImportOptions, json: FigmaFileResponse | FigmaNode): Promise<FigmaAssetStore> {
  // Bytes the caller already has win, and cost nothing: a bundle captured once —
  // a plugin's dump, a fixture beside a test — is imported as many times as a
  // designer needs, with no network at all.
  //
  // Raw bytes before inline URIs, because they are the only ones that can still
  // be made smaller: a data URI has already paid base64 and has already been
  // parsed out of a 99MB JSON string by the time anyone offers it.
  if (options.imageBlobs) {
    return figmaAssetStoreFromBlobs(collectFigmaImageRefs(json), options.imageBlobs, (done, total) =>
      options.onProgress?.("images", done, total)
    );
  }
  if (options.imageFills) return figmaAssetStoreFromUris(collectFigmaImageRefs(json), options.imageFills);
  return emptyFigmaAssetStore();
}

/**
 * Name the images that did not arrive, in the two ways that differ.
 *
 * Each of these is a document that will LOOK wrong, so each is stated rather
 * than left to be discovered by scrolling: refs past the inline limit kept a box
 * and lost their paint, and refs the export carried no bytes for lost their paint
 * outright. The second is a picture that never appears at all — which is exactly
 * the case that used to import in total silence, with `assets: []` and no gap
 * recorded.
 */
function imageGaps(store: FigmaAssetStore): FigmaGap[] {
  const gaps: FigmaGap[] = [];

  if (store.skipped.length > 0) {
    gaps.push({
      id: "figma-images-skipped",
      name: "Image fills past the inline limit",
      property: "image:notInlined",
      count: store.skipped.length,
      value: `${store.skipped[0].reason}. Those layers keep their box and lose their paint.`
    });
  }

  if (store.failed.length > 0) {
    gaps.push({
      id: "figma-images-unresolved",
      name: "Image fills with no bytes",
      property: "image:unresolved",
      count: store.failed.length,
      value: store.failed[0].reason
    });
  }

  return gaps;
}

/**
 * Collapse the gap list by property.
 *
 * A file with three hundred diagonal lines would otherwise report three hundred
 * rows saying the same thing, which is a report nobody reads. One row per KIND of
 * gap, carrying how many layers it hit and one example to find, is the form that
 * tells the designer whether the import lost something.
 */
function aggregateGaps(gaps: FigmaGap[]): FigmaGap[] {
  const byProperty = new Map<string, { count: number; sample: FigmaGap }>();
  for (const g of gaps) {
    const existing = byProperty.get(g.property);
    if (existing) existing.count += 1;
    else byProperty.set(g.property, { count: 1, sample: g });
  }
  return [...byProperty.values()]
    .sort((a, b) => b.count - a.count)
    .map(({ count, sample }) => ({ ...sample, count }));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export type { DesignElement };