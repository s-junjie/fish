import type { AssetRef, DesignElement } from "../dsl/types";

export interface AssetCredit {
  name: string;
  url: string;
  /**
   * Edit-time only, and deliberately not part of `AssetRef.credit`: the panel
   * shows it while the user is choosing, and a provider projects it away when it
   * writes the document. `license` is the one field with no reason to outlive
   * the panel — the source URL is what a reader of the file follows, and
   * restating a licence in every saved document buys nothing the link does not.
   */
  license?: string;
}

/**
 * How an icon's geometry is painted, which is a property of the set rather than
 * of the panel: an outline set arrives as stroke-only geometry and a solid set
 * as a fill, and a preview that draws both as outlines renders half the icons
 * as nothing. Omitted means the outline reading — stroke, 2 wide, round caps and
 * joins — so an existing stroke-style provider needs to say nothing.
 */
export interface IconRenderSpec {
  mode: "stroke" | "fill";
  fillRule?: "nonzero" | "evenodd";
  strokeWidth?: number;
  cap?: "butt" | "round" | "square";
  join?: "miter" | "round" | "bevel";
}

/**
 * Narrowing a search beyond its text and its page size. A value is a
 * *provider-local* key rather than a vocabulary, so a source whose own idea of
 * filtering does not include licences ignores the field instead of translating
 * it.
 */
export interface AssetSearchOptions {
  license?: string;
}

export interface AssetSearchResult {
  /** Provider-local id, e.g. "lucide:zap". */
  id: string;
  name: string;
  tags?: string[];
  /** Inline stroke geometry (icon path data in a 24x24 local box); the panel
   * renders it live as SVG. Mutually exclusive with `preview`. */
  iconPaths?: string[];
  /** Paint for `iconPaths`. Omitted means stroke, 2 wide, round caps and joins. */
  iconRender?: IconRenderSpec;
  /** Thumbnail URL (remote or data URI) for image-backed results. */
  preview?: string;
  /** Full-resolution source the provider downloads on insert. */
  src?: string;
  width?: number;
  height?: number;
  /**
   * The source's preferred starting size, as a cap on the element's longest
   * edge. Placement is a source decision — a 24px icon set and a 1280px photo
   * do not belong on the canvas at the same size. Omitted means "place at the
   * file's natural size", bounded by the app's own `MAX_IMAGE_EDGE` (4096).
   */
  displayMaxDimension?: number;
  credit?: AssetCredit;
  /** Endpoint the provider must hit once the photo is actually used. */
  downloadUrl?: string;
}

export interface AssetInsertTarget {
  x: number;
  y: number;
}

export interface AssetInsertResult {
  element: DesignElement;
  asset?: AssetRef;
}

/**
 * How many results one window of the grid asks for. The panel and the providers
 * share it because the panel has to know how far it can page — the arithmetic
 * is `page * ICON_PAGE_SIZE`, and a provider that slices on a different size
 * would hand back the same icon twice on the second screen.
 */
export const ICON_PAGE_SIZE = 120;

/**
 * Edit-time asset source. Providers live in the workbench only — inserting
 * writes plain schema data (elements + optional AssetRef) into the document,
 * so the artifact never loads provider code.
 */
export interface AssetProvider {
  id: string;
  name: string;
  /** i18n key for `name`; the panel prefers it and falls back to the literal. */
  nameKey?: string;
  kind: "icon" | "image";
  /**
   * Async because remote providers hit the network. `offset` names a position
   * in the *provider's* ordering, not a page number: the panel hands back the
   * window it has not shown yet, and a provider that does not implement paging
   * just ignores both arguments.
   */
  search(
    query: string,
    limit?: number,
    offset?: number,
    options?: AssetSearchOptions
  ): Promise<AssetSearchResult[]>;
  insert(
    result: AssetSearchResult,
    target: AssetInsertTarget
  ): AssetInsertResult | Promise<AssetInsertResult>;
  /**
   * Network-backed. The panel holds these back on an empty query, because a
   * remote source asked for an editorial feed it has no answer for spends a
   * request to say so.
   */
  remote?: boolean;
}

/** Drag/click payload routed from the Assets panel to the canvas. */
export interface AssetInsertPayload {
  providerId?: string;
  result?: AssetSearchResult;
  /**
   * A plugin-owned source has no entry in `OFFICIAL_PROVIDERS`, so it asks the
   * host to insert the result through the generic remote-image path instead.
   */
  insert?: "remote-image";
  assetId?: string;
  /** Document component to place as a new instance. */
  componentId?: string;
}

export const ASSET_MIME = "application/x-fish-asset";
