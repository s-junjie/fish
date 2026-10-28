/**
 * The subset of Figma's node shape this importer reads, plus its own options and
 * report.
 *
 * The field NAMES are the REST API's, because that is the vocabulary both this
 * mapper and the plugin's shim speak — the shim renames the plugin API's spellings
 * into these before the app sees anything (`figma-plugin/collect.js`).
 *
 * The node shape is deliberately open (`[key: string]: unknown`) and every field
 * the mapper does not use is simply absent: Figma's `Node` is one of the widest
 * objects any design tool publishes, it gains members every few weeks, and a
 * closed interface over it would be a compile error on every one of those weeks
 * while teaching nobody anything. What is declared here is exactly what is read.
 */

import type { DesignElement, DesignStyle, DesignToken, Page } from "../dsl/types";
import type { ImportedTokens } from "./html-types";
import type { Rect } from "./html-walk";

export interface FigmaColor {
  r: number;
  g: number;
  b: number;
  a?: number;
}

export interface FigmaColorStop {
  color: FigmaColor;
  position: number;
}

export interface FigmaPaint {
  type?: string;
  visible?: boolean;
  opacity?: number;
  blendMode?: string;
  color?: FigmaColor;
  gradientStops?: FigmaColorStop[];
  gradientTransform?: number[][];
  imageRef?: string;
  /**
   * A video fill's hash — the clip this layer is, and the one thing the plugin
   * API will say about it.
   *
   * Nothing resolves it: there is no `getVideoByHash`, so unlike `imageRef` this
   * is never a lookup that can fail, only a name for a clip that could not
   * travel.
   */
  videoRef?: string;
  scaleMode?: string;
  /**
   * A bitmap's own quarter turn inside its layer, in degrees, Figma's
   * counter-clockwise sense and always a multiple of 90.
   *
   * The FILL/FIT/TILE spelling of turning an image — `imageTransform` is the
   * CROP-only one — so a photograph that reads upright in Figma can be a bitmap
   * turned against a layer that is itself turned, and reading only the layer's
   * angle lands it a quarter turn out.
   */
  rotation?: number;
  /**
   * A CROP's framing: a 2×3 matrix mapping the LAYER's unit square onto the
   * IMAGE's — `[[a, skewX, tx], [skewY, d, ty]]`, read as "the layer shows the
   * image from `(tx, ty)`, `a` of its width and `d` of its height".
   *
   * The layer is the crop window and the matrix says which part of the picture is
   * behind it. Read the other way round — as where the bitmap is painted — every
   * ordinary crop looks like an enormous squash; see `figma-image-fill.ts`.
   */
  imageTransform?: number[][];
  [key: string]: unknown;
}

export interface FigmaEffect {
  type: string;
  visible?: boolean;
  radius?: number;
  color?: FigmaColor;
  offset?: { x: number; y: number };
  spread?: number;
  blendMode?: string;
  [key: string]: unknown;
}

export interface FigmaTypeStyle {
  fontFamily?: string;
  fontPostScriptName?: string;
  fontWeight?: number;
  fontSize?: number;
  letterSpacing?: number;
  lineHeightPx?: number;
  lineHeightPercent?: number;
  textAlignHorizontal?: string;
  textAlignVertical?: string;
  /** How a truncated line ends: `ENDING` means the ellipsis. */
  textTruncation?: string;
  /** How many lines the node shows before it truncates. */
  maxLines?: number;
  italic?: boolean;
  textCase?: string;
  textDecoration?: string;
}

export interface FigmaVectorPath {
  path: string;
  windingRule?: string;
}

/**
 * One grid track, as the plugin API reports it. `FLEX` shares whatever the fixed
 * tracks leave (the DSL's `{ fr }`), `FIXED` is a px `value`, and `HUG` sizes to
 * the track's content — which the DSL's track model has no spelling for, so it is
 * reported rather than guessed at.
 */
export interface FigmaGridTrack {
  type: "FLEX" | "FIXED" | "HUG";
  value?: number;
}

export interface FigmaNode {
  id: string;
  name?: string;
  type: string;
  visible?: boolean;
  opacity?: number;
  blendMode?: string;
  children?: FigmaNode[];

  absoluteBoundingBox?: { x: number; y: number; width: number; height: number };
  /**
   * The node's OWN size, before rotation and scaling — read only alongside
   * `geometry=paths`. It is the box a rotated leaf must be given, because
   * `absoluteBoundingBox` is the bound of the shape once rotated.
   */
  size?: { x: number; y: number };
  constraints?: { vertical?: string; horizontal?: string };
  /** Aspect lock; the DSL spells it `constraints.preserveAspectRatio`. */
  preserveRatio?: boolean;

  clipsContent?: boolean;
  cornerRadius?: number;
  rectangleCornerRadii?: number[];
  cornerSmoothing?: number;

  fills?: FigmaPaint[];
  strokes?: FigmaPaint[];
  strokeWeight?: number;
  /** Per-side weights, present only when the designer set them individually. */
  individualStrokeWeights?: { top?: number; right?: number; bottom?: number; left?: number };
  strokeAlign?: string;
  strokeDashes?: number[];
  strokeCap?: string;
  strokeJoin?: string;
  effects?: FigmaEffect[];

  fillGeometry?: FigmaVectorPath[];
  strokeGeometry?: FigmaVectorPath[];
  fillWeight?: number;

  characters?: string;
  style?: FigmaTypeStyle;
  characterStyleOverrides?: number[];
  /** One entry per run of `characterStyleOverrides`; only present where it differs. */
  styleOverrideTable?: Record<string, FigmaTypeStyle>;
  textAutoResize?: string;
  /**
   * Truncation, as the PLUGIN API spells it: on the text node, where REST keeps
   * it in `TypeStyle`. Both are read — see `figma-text.ts` — so the two doors
   * agree about a truncated label whichever one the bytes came through.
   */
  textTruncation?: string;
  maxLines?: number;

  layoutMode?: string;
  itemSpacing?: number;
  counterAxisSpacing?: number;
  paddingTop?: number;
  paddingRight?: number;
  paddingBottom?: number;
  paddingLeft?: number;
  primaryAxisAlignItems?: string;
  counterAxisAlignItems?: string;
  primaryAxisAlignContent?: string;
  /** `AUTO` on an axis means the frame hugs its content — the DSL's `fit-content`. */
  primaryAxisSizingMode?: string;
  counterAxisSizingMode?: string;
  layoutWrap?: string;
  layoutAlign?: string;
  layoutGrow?: number;
  layoutPositioning?: string;
  layoutSizingHorizontal?: string;
  layoutSizingVertical?: string;
  /** Explicit bounds, present only where the designer set them. */
  minWidth?: number;
  maxWidth?: number;
  minHeight?: number;
  maxHeight?: number;

  // GRID auto-layout (`layoutMode: "GRID"`). Only applicable to a grid frame; a
  // flex frame does not carry them. Verified against the Figma REST OpenAPI
  // (`TypeLayoutGrid`) and the plugin API's `GridLayoutMixin`, which spell every
  // one of these the same.
  gridRowCount?: number;
  gridColumnCount?: number;
  gridRowGap?: number;
  gridColumnGap?: number;
  /** The CSS `grid-template-columns` string. REST's only per-track sizing. */
  gridColumnsSizing?: string;
  /** The CSS `grid-template-rows` string. REST's only per-track sizing. */
  gridRowsSizing?: string;
  /** How this node's grid cell aligns it on the horizontal axis. */
  gridChildHorizontalAlign?: string;
  gridChildVerticalAlign?: string;
  gridRowSpan?: number;
  gridColumnSpan?: number;
  /** 0-based, unlike the DSL's 1-based `layoutCell` indices. */
  gridRowAnchorIndex?: number;
  gridColumnAnchorIndex?: number;

  /**
   * The plugin API's per-track sizing, which REST does not publish: an array of
   * `{ type: "FLEX" | "FIXED" | "HUG", value?: number }` per row / column. The
   * shim carries it verbatim; the mapper reads it in preference to the CSS
   * strings when both doors could have supplied them.
   */
  gridRowSizes?: FigmaGridTrack[];
  gridColumnSizes?: FigmaGridTrack[];

  componentId?: string;
  /** `isMask`, not `mask` — reading the short name silently matches nothing. */
  isMask?: boolean;
  maskType?: string;

  /**
   * The 2D transform of the node relative to its parent, and the ONLY place a
   * flip appears: there is no `flipX` / `flipY` on a node. Present only when the
   * request passes `geometry=paths`.
   */
  relativeTransform?: number[][];
  rotation?: number;

  /**
   * Figma's own slide transition, VERBATIM — the plugin is the only door that can
   * read one, and it has no REST spelling to be renamed into. `figma-slide.ts`
   * says what it becomes.
   */
  slideTransition?: { style?: string; duration?: number; curve?: string; timing?: { type?: string; delay?: number } };

  /**
   * The variable bindings on this node, in Figma's own shape.
   *
   * A scalar property carries one alias and a paint channel (`fills`, `strokes`,
   * `effects`) carries an ARRAY of them, indexed by paint — the same index the
   * paint array uses, with `null` where a paint is not bound. Carried verbatim
   * because an id is only a name here: which FISH token it becomes, and what a
   * bound-but-undefined variable means, is the app's call (`figma-tokens.ts`).
   */
  boundVariables?: Record<string, FigmaVariableAlias | Array<FigmaVariableAlias | null> | null>;

  /**
   * Which published style each styleable channel of this node points at.
   *
   * A style is NOT a token: a token is a value with modes, a style is a named
   * bundle of values a designer applies. Figma keeps them apart and so does the
   * DSL (`fillStyleId` / `textStyleId` / `effectStyleId` / `strokeStyleId` beside
   * `tokenBindings`), which is why both channels are carried for one node.
   *
   * The plugin shim writes this from `fillStyleId` and friends; REST already
   * spells it `styles`. Either way the values are ids into the file's `styles`.
   */
  styles?: FigmaNodeStyles;

  [key: string]: unknown;
}

/** The style ids a node carries, one per channel — only the ones it actually has. */
export interface FigmaNodeStyles {
  fill?: string;
  stroke?: string;
  text?: string;
  effect?: string;
  grid?: string;
}

/**
 * One published Figma style, with its VALUES.
 *
 * REST's `file.styles` is only a directory — `{ key, name, styleType }` per id —
 * because the values live on the layers that use them. The plugin can read the
 * definitions, so those are what this carries: a style whose values are unknown
 * cannot become a FISH style without inventing them.
 *
 * A style's own fields can be bound to variables (a colour style whose fill is a
 * semantic variable, a text style whose size is a number token), which is why
 * `boundVariables` travels with the definition rather than only with the node.
 */
export interface FigmaStyle {
  id: string;
  key?: string;
  name?: string;
  /** Normalized to `PAINT` | `TEXT` | `EFFECT` | `GRID` — REST calls paint `FILL`. */
  styleType?: string;
  remote?: boolean;
  paints?: FigmaPaint[];
  effects?: FigmaEffect[];
  /** A TEXT style's own typography, in the same spelling `TypeStyle` uses. */
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: number;
  italic?: boolean;
  lineHeightPx?: number;
  lineHeightPercent?: number;
  letterSpacing?: number;
  textCase?: string;
  textDecoration?: string;
  /** The ink a text style paints with, when it publishes one. */
  fills?: FigmaPaint[];
  boundVariables?: Record<string, FigmaVariableAlias | Array<FigmaVariableAlias | null> | null>;
  [key: string]: unknown;
}

/** `{ type: "VARIABLE_ALIAS", id }` — Figma's own spelling, on both APIs. */
export interface FigmaVariableAlias {
  type?: "VARIABLE_ALIAS";
  id: string;
}

/** What a variable holds in one mode: a raw value, or a pointer at another variable. */
export type FigmaVariableValue = FigmaVariableAlias | FigmaColor | string | number | boolean;

/**
 * One Figma variable, as `getLocalVariablesAsync()` / REST report it.
 *
 * `valuesByMode` is the whole point of carrying it: a mode's value lives beside
 * the mode's ID, and only the collection says which ID is the default and what
 * the others are CALLED — so the three have to travel together.
 */
export interface FigmaVariable {
  id: string;
  name?: string;
  key?: string;
  remote?: boolean;
  /** `COLOR` | `FLOAT` | `STRING` | `BOOLEAN` — the kind the resolved value has. */
  resolvedType?: string;
  variableCollectionId?: string;
  valuesByMode?: Record<string, FigmaVariableValue>;
}

export interface FigmaVariableMode {
  modeId: string;
  name?: string;
}

/** A variable collection: the modes a variable's values are filed under. */
export interface FigmaVariableCollection {
  id: string;
  name?: string;
  /** The mode whose value is the variable's own — the base, in FISH's terms. */
  defaultModeId?: string;
  modes?: FigmaVariableMode[];
}

/** `GET /v1/files/:key`. Only the members the mapper reads are declared. */
export interface FigmaFileResponse {
  name?: string;
  document: FigmaNode;
  components?: Record<string, { key: string; name: string; description: string }>;
  componentSets?: Record<string, { key: string; name: string; description: string }>;
  /**
   * The file's published styles.
   *
   * TWO SHAPES, ONE ROLE. REST hands back a directory keyed by style key with no
   * values (`{ key, name, styleType }`), because on that door the values live on
   * the layers that use them. The plugin reads the definitions themselves, so it
   * sends an array. `figma-styles.ts` decides which of the two it was given; a
   * directory alone cannot become FISH styles without inventing values.
   */
  styles?: Record<string, FigmaStyle> | FigmaStyle[];
  /**
   * The file's variables, as the plugin door carries them. REST's `/v1/files`
   * does not publish variables at all, so an export without this key is not a
   * file without a design system — it is a file this door could not ask about.
   */
  variables?: FigmaVariable[];
  /** The collections those variables belong to, with the modes their values use. */
  variableCollections?: FigmaVariableCollection[];
  lastModified?: string;
  version?: string;
  schemaVersion?: number;
  thumbnailUrl?: string;
  [key: string]: unknown;
}

export interface FigmaImportOptions {
  /** Name for the imported page, when the caller has one (the file's own name). */
  rootName?: string;
  /**
   * The document's own styles, so imported paint that already matches one binds
   * to it instead of arriving as a duplicate literal.
   */
  styles?: readonly DesignStyle[];
  /** The document's own tokens, so a second import reuses a token it already made. */
  tokens?: readonly DesignToken[];
  /**
   * Reject this many elements and give up, rather than building a tree that
   * takes the tab down. Figma files are unbounded and the API will happily
   * return a 200 for one that would take minutes to walk.
   */
  maxElements?: number;
  /**
   * `imageRef` → URI, resolved with NO network call at all.
   *
   * This is what makes an import repeatable for free: a file response captured
   * once carries everything the mapping needs except the bytes, and a caller
   * that already has them — a saved bundle, a Figma plugin's dump, a corpus
   * checked in beside a test — hands them over here. Without it the only way to
   * see a photograph is to spend another API call, which on a seat-based rate
   * limit is the whole month's budget.
   */
  imageFills?: Readonly<Record<string, string>>;
  /**
   * `imageRef` → raw bytes, for a caller holding a folder rather than a string.
   *
   * The zip the Figma plugin writes, unpacked. Preferred over {@link imageFills}
   * when both are possible, because these bytes go through the app's own image
   * policy before they become an asset and a data URI does not:
   * one real export was 38 photographs and 99.6MB of inline base64.
   */
  imageBlobs?: ReadonlyMap<string, Blob>;
  /**
   * Told what the import is doing, so a caller with a spinner can say which.
   *
   * Resizing and re-encoding a bundle's images is the slow part of a Figma
   * import and it happens with nothing on screen: one export was 38 photographs
   * and 99.6MB of bytes, and a dialog showing a spinner and no words is
   * indistinguishable from one that has hung.
   */
  onProgress?: (stage: "images", done: number, total: number) => void;
}

export interface FigmaGap {
  /** The Figma node id the gap came from, so it can be found in Figma itself. */
  id: string;
  name: string;
  /** The Figma property or node type that did not carry across. */
  property: string;
  value?: string;
  /** How many layers this one kind of gap hit. Absent before aggregation. */
  count?: number;
}

export interface FigmaImportReport {
  /** Top-level element count across every page produced. */
  elementCount: number;
  pageCount: number;
  /**
   * Containers that declared a Figma auto-layout the engine could not reproduce,
   * and by how much. Same meaning as the HTML importer's `downgraded`, from the
   * same `verifyImport` pass — Figma's auto-layout is the DSL's, so a container
   * that cannot reproduce it is a real gap rather than a guess.
   */
  downgraded: Array<{ id: string; name: string; maxDelta: number }>;
  /**
   * Everything this import could not carry across, named rather than dropped.
   * Driven by `tests/figma-import.test.ts` and by the same discipline the HTML
   * importer is held to: a gap nobody records is a gap nobody can close.
   */
  unmapped: FigmaGap[];
  /**
   * Largest box difference between the import and Figma's own bounds, after the
   * engine's layout has run.
   */
  maxDelta: number;
  maxTextDelta: number;
  styleBindings: number;
  /** Design tokens minted from the file's own variables. */
  tokensCreated: number;
  /** Figma styles turned into FISH styles, values and token links included. */
  stylesCreated: number;
  /** Layers that point at one of those styles (`fillStyleId` and friends). */
  styleLinks: number;
  /** Layer properties bound to one of those tokens instead of a literal. */
  tokenBindings: number;
}

export interface FigmaImportResult {
  /** One FISH page per Figma `CANVAS`, plus the synthesized component masters. */
  pages: Page[];
  /** Index into `pages` the document should open on. */
  activePageIndex: number;
  /** Elements of the active page, for the caller that commits `pages`. */
  elements: DesignElement[];
  /**
   * Every resolved `imageRef` → the URI its bytes (or URL) ended up at, so a
   * caller can hand the same map back as {@link FigmaImportOptions.imageFills}
   * and import this file again without touching the network.
   */
  imageFills: Record<string, string>;
  /** Tokens the file declared, to be added to the document with its pages. */
  tokens?: ImportedTokens;
  report: FigmaImportReport;
}

/** How far the content's origin is pulled back to the page margin, in px. */
export const FIGMA_PAGE_MARGIN = 40;

export const DEFAULT_MAX_ELEMENTS = 20000;

export type { Rect };