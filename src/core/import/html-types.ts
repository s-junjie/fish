import type { AssetRef, DesignElement, DesignStyle, DesignToken, DocumentMode, ImagePaint } from "../dsl/types";

export interface ImportOptions {
  /** The width the page is laid out at. The import is a snapshot OF this width. */
  viewportWidth?: number;
  /**
   * The height the page is laid out at.
   *
   * A page written against `100vh` — which is most app chrome — is as tall as
   * this, and `height: 100%` chains resolve against it. The host's own box is set
   * from it, so the import does not silently depend on the window it ran in.
   */
  viewportHeight?: number;
  /** Name for the frame the whole page is imported into. */
  rootName?: string;
  /**
   * The document's own styles, so imported paint that already matches one binds
   * to it instead of arriving as a duplicate literal.
   */
  styles?: readonly DesignStyle[];
  /** The document's own tokens, so a second import reuses a token it already made. */
  tokens?: readonly DesignToken[];
  /** Abort signal to cancel an in-flight import cleanly. */
  signal?: AbortSignal;
  /**
   * Ids the target document already owns.
   *
   * An element's own HTML `id` becomes its element id, so an import appended to
   * a page that already holds that anchor has to give way — uniqueness is
   * document-wide, and a repeated id makes the second element unreachable.
   */
  takenIds?: Iterable<string>;
  /** Live progress reporter for long imports. */
  onProgress?: (stage: "mount" | "assets" | "measure" | "build", percent?: number) => void;
}

export interface ImportReport {
  elementCount: number;
  /** Containers that declared a layout the engine could not reproduce, and by how much. */
  downgraded: Array<{ id: string; name: string; maxDelta: number }>;
  /**
   * Every declaration this import could not carry across — a CSS property, a
   * pseudo, a `@font-face`, an `id` — with the DOM path it came from.
   * Deliberately not silent: the gap list is driven by this, and a dropped
   * property nobody records is a gap nobody can close.
   */
  unmapped: Array<{ path: string; property: string; value: string }>;
  /**
   * The DOM path each produced element came from, so a caller can line the
   * import up against the page it was measured from. Traceability rather than
   * content — the document itself carries no source markup.
   */
  sources: Array<{ id: string; path: string }>;
  /**
   * Largest box difference between the import and the page it was measured from,
   * after the engine's own layout has run. The number that says whether the
   * import reproduced the page, rather than merely produced elements.
   */
  maxDelta: number;
  /** The same measure over text boxes only — what a leaked font stack shows up as. */
  maxTextDelta: number;
  /** Fill / stroke / effect bindings made onto the document's existing styles. */
  styleBindings: number;
  /** Design tokens minted from the page's own custom properties. */
  tokensCreated: number;
  /** Element properties bound to one of those tokens instead of a literal. */
  tokenBindings: number;
}

/** An image paint with everything but the bytes: the framing CSS decided. */
export type MissingPaint = Omit<ImagePaint, "assetId" | "type">;

/**
 * A bitmap the page drew but whose bytes never arrived.
 *
 * The framing is solved from the CSS, which is read whether or not the file
 * could be — so supplying the asset later is a matter of adding an id. The one
 * exception is a crop: `object-position` is a fraction of the overflow, and the
 * overflow needs the bitmap's own size, so the position rides along and the crop
 * is solved the moment the folder supplies one.
 */
export interface MissingAsset {
  /** The element whose fill stack is waiting for the picture. */
  elementId: string;
  /** The URL as the page wrote it, which is what a picked folder is matched against. */
  url: string;
  paint: MissingPaint;
  position?: { x: number; y: number };
}

/** What the page's own token system became, for the caller to file on the document. */
export interface ImportedTokens {
  /** One FISH token per custom property the page referenced: colour and number. */
  tokens: DesignToken[];
  /** Named styles minted alongside them (a Figma colour style is one of these). */
  styles: DesignStyle[];
  /** Colour modes the page declared beyond the base one, empty when it declared none. */
  modes: DocumentMode[];
  /** Number modes the import declared beyond the base one; absent when it declared none. */
  numberModes?: DocumentMode[];
}

export interface ImportResult {
  elements: DesignElement[];
  /** Bitmaps inlined as data URIs, for the caller to register on the document. */
  assets: AssetRef[];
  /** Bitmaps referenced but not readable, in the order the walk met them. */
  missing: MissingAsset[];
  /** Tokens the page declared, to be added to the document with its elements. */
  tokens?: ImportedTokens;
  report: ImportReport;
}

export const DEFAULT_VIEWPORT_WIDTH = 1280;
export const DEFAULT_VIEWPORT_HEIGHT = 900;
