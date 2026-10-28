import { DEFAULT_CANVAS_BACKGROUND } from "./defaults";
import type { PATTERN_ALIGNMENTS, PATTERN_MOTIFS, PATTERN_TILE_TYPES } from "./schema-enums";

export type DesignElement =
  | FrameElement
  | ComponentElement
  | ComponentSetElement
  | InstanceElement
  | TextElement
  | RectElement
  | EllipseElement
  | PolygonElement
  | StarElement
  | PathElement
  | LineElement
  | ArrowElement
  | VideoElement
  | HtmlEmbedElement;

export type ContainerElement = FrameElement | ComponentElement | ComponentSetElement;

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

export interface FontSpec {
  family: string;
  src?: string;
  weight?: number | "normal" | "bold";
  style?: "normal" | "italic";
}

export interface Page {
  id: string;
  name: string;
  canvas: CanvasSpec;
  children: DesignElement[];
  metadata?: {
    viewport?: { x: number; y: number; zoom: number };
    [key: string]: unknown;
  };
}

export type DocumentVersion = string;

export interface DesignDocument {
  $schema?: string;
  docId?: string;
  version: DocumentVersion;
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  canvas: CanvasSpec;
  pages: Page[];
  activePageId: string;
  styles?: DesignStyle[];
  /** The value table, one id space of its own beside `styles`. */
  tokens?: DesignToken[];
  assets?: AssetRef[];
  fonts?: FontSpec[];
  thumbnailNodeId?: string;
  /**
   * Free-form provenance, preserved verbatim including keys this build has never
   * heard of. Nothing reads a key inside it — not the engine, not the CLI.
   *
   * The design intent is deliberately *not* here. It lives in the files beside
   * the document (`design.md`, `mood.md`), because that is where it
   * can be authored, revised, diffed and reviewed as text, and because it
   * outlives any one document. A key parked in here could be none of those, and
   * a key that cannot be read is a key that cannot be checked.
   */
  metadata?: Record<string, unknown>;
  /**
   * CSS custom properties, resolved into every `var()` in the document at
   * normalize time. Keys may be written with or without the leading `--`;
   * values are strings or numbers. This is the one place a `var(--x)` can be
   * defined — there is no per-element scope.
   */
  variables?: Record<string, string | number>;
  /**
   * Active COLOUR token mode ('light', 'dark', or a custom mode identifier).
   * Defaults to the first entry of `modes`.
   */
  activeTheme?: "light" | "dark" | string;
  /**
   * Available modes for COLOUR tokens. A chromatic axis: a colour answers to
   * light/dark/brand, so `ColorToken.modes` is keyed by these ids.
   */
  modes?: DocumentMode[];
  /**
   * Active NUMBER token mode ('default', 'compact', 'mobile'…). Defaults to the
   * first entry of `numberModes`. Independent of `activeTheme`: brightness and
   * spatial density are two axes, and a surface can be dark AND compact.
   */
  activeNumberMode?: string;
  /**
   * Available modes for NUMBER tokens. A spatial axis: a radius or a gap answers
   * to density and breakpoint, not to colour, so `NumberToken.modes` is keyed by
   * these ids and never by `modes`.
   */
  numberModes?: DocumentMode[];
  [key: string]: unknown;
}

export interface DocumentMode {
  id: string;
  name: string;
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

export interface CanvasSpec {
  width?: number;
  height?: number;
  background: Paint;
  unit: "px";
}

export type CornerRadius = number | [number, number, number, number];

export interface DropShadowEffect {
  type: "drop-shadow";
  color: string;
  offset: { x: number; y: number };
  blur: number;
  spread?: number;
  blendMode?: BlendMode;
  enabled?: boolean;
  tokenId?: string;
  tokenBindings?: Record<string, string>;
}

export interface InnerShadowEffect {
  type: "inner-shadow";
  color: string;
  offset: { x: number; y: number };
  blur: number;
  spread?: number;
  blendMode?: BlendMode;
  enabled?: boolean;
  tokenId?: string;
  tokenBindings?: Record<string, string>;
}

export interface LayerBlurEffect {
  type: "layer-blur";
  blur: number;
  enabled?: boolean;
  tokenBindings?: Record<string, string>;
}

export interface BackdropBlurEffect {
  type: "backdrop-blur";
  blur: number;
  enabled?: boolean;
  tokenBindings?: Record<string, string>;
}

/**
 * Apple's Liquid Glass, authored on Figma's parameter surface.
 *
 * Figma's glass effect and Apple's material are one target rather than two —
 * Apple's own iOS 27 UI kit is built with Figma's glass effect — so every field
 * here is one of Figma's nine, under Figma's name, with Figma's range. The unit
 * of each is in `core/dsl/liquid-glass.ts`, which also owns the defaults and the
 * geometry both renderers read.
 *
 * `saturation` and `brightness` are gone. They came from a third-party reverse
 * engineering of the material, neither Figma nor Apple has them, and a flat
 * `brightness(1.08)` lift is most of why the effect read as a fogged window: the
 * official illustration leaves the interior at the backdrop's own level.
 */
export interface LiquidGlassEffect {
  type: "liquid-glass";
  /** Frost — how much the backdrop is blurred, 0-100, taken 1:1 as a px radius. */
  frost: number;
  /** Refraction, 0-100 — strength of the distortion along the curved edge. */
  refraction: number;
  /** Depth, 1-90 — how far the curved edge reaches inward from the border, in px. */
  depth: number;
  /** Dispersion, 0-100 — chromatic split along the curved edge. */
  dispersion: number;
  /** Light angle, -180 to 180 degrees; 0 is light from the top. */
  lightAngle: number;
  /** Light intensity, 0-100 — brightness of the light the rim projects. */
  lightIntensity: number;
  /** Splay, 0-100 — how far that light spreads across the glass. */
  splay: number;
  enabled?: boolean;
  tokenBindings?: Record<string, string>;
}

/**
 * There is one shadow, not two.
 *
 * A `drop-shadow` on a text element paints as a CSS `text-shadow` — the glyphs
 * are the shape it casts — so the old separate `text-shadow` effect type said
 * nothing the renderer did not already decide by looking at the element. It is
 * still ACCEPTED as input (`normalizeEffects` folds it onto `drop-shadow` and
 * reports the fold), but it is not a member here: a second spelling of one
 * effect is a second thing to keep in sync everywhere.
 */
export type Effect =
  | DropShadowEffect
  | InnerShadowEffect
  | LayerBlurEffect
  | BackdropBlurEffect
  | LiquidGlassEffect
  | TearEffect;

/**
 * A break along one side of an element's box — or, with `hole`, a closed one
 * punched through the sheet.
 *
 * Five `profile`s share one kernel: each replaces a single scalar field — how
 * far the boundary moves inward at distance `t` along it — and everything else
 * (sampling, the curve, the clip, the scale and determinism contracts) belongs
 * to the kernel, not to the profile. A profile that needs no field of its own
 * declares none: a scallop and a zigzag are fully described by `scale`.
 *
 * `seed` is the break's identity, not a random number: the same seed renders the
 * same break on canvas, in an export and on the next machine. Two layers broken
 * from the same sheet share a seed, so their edges are the same curve seen from
 * either side.
 */
export interface TearCommon {
  /**
   * Which side of the box the break replaces. Required by an open break, and
   * absent from a hole — a loop has no side, and nothing about it is anchored to
   * one.
   */
  side?: EdgeSide;
  /**
   * Where the break sits across its axis, 0..1. Absent means the box edge the
   * side names (1 for `right`/`bottom`, 0 for `left`/`top`).
   *
   * A break at the edge is measured INWARD from it, so the silhouette never
   * leaves the box; a break inside the box is centred on this guide, which is
   * what lets two pieces of one sheet share a cut and close the seam.
   *
   * A PAIR puts the break's two ends at different positions, which tilts it: the
   * first number is the end where the side starts (the top edge of a left/right
   * break, the left edge of a top/bottom one), the second the end at the far
   * corner. The break still spans the side; only its two ends move across.
   */
  at?: number | [number, number];
  /** Wavelength of the coarsest feature, in px. Scales the whole break.
   *  For the periodic profiles this IS the pitch. `0` is a straight cut. */
  scale: number;
  seed: number;
  /**
   * Which of the three forms this tear is. Absent means `"edge"`.
   *
   * A loop's seam sits at the middle of the box's top edge and does not move: it
   * is the one point where the mirrored field turns around, not a control.
   */
  form?: TearForm;
  /**
   * A loop's margin from the box, as a PERCENTAGE of the way in from each edge:
   * `0` leaves no sheet at all (the whole box is cut away), `100` leaves no loop
   * at all. One number for all four sides, or `[top, right, bottom, left]`
   * (CSS's order, the same one `borderWidthsOf` reads) to place the loop
   * off-centre or give it another shape. Absent means a margin wide enough for
   * the tear to fit in.
   */
  inset?: number | EdgeInsets;
}

/** A loop's four margins, as percentages: top, right, bottom, left. */
export type EdgeInsets = [number, number, number, number];

/**
 * Which of the three things a tear is.
 *
 * `"edge"` replaces one side of the box (the default); `"hole"` closes the same
 * break into a loop and keeps the sheet around it; `"scrap"` keeps only the piece
 * inside that loop. The two loop forms read `inset`, the edge form reads `side`
 * and `at` — but all three share one slot, so the settings of the form that is
 * not showing are kept.
 */
export type TearForm = "edge" | "hole" | "scrap";

/**
 * The torn break's own fields.
 *
 * `fiber` is the whole show: 0 is a clean break, and any value above it steps
 * the terraced paper plies out of the break, scaled by how far the fibres stray.
 */
export interface TornFields {
  /** 0-1: how much of the two finer octaves rides on the coarse one. */
  roughness: number;
  /** 0-1: how far the fibres stray outside the edge. 0 = clean break. */
  fiber: number;
}

/**
 * An edge before it is resolved: every profile-specific field is optional and
 * the profile itself defaults to `torn`, which is what keeps a document written
 * against the old `torn-edge` spelling valid without a migration pass.
 */
export interface TearInput extends TearCommon {
  profile?: EdgeProfile;
  roughness?: number;
  fiber?: number;
}

/** The pre-rename spelling of `TearInput`. The tear tests still build one this way. */
export type TornEdge = TearInput;

export type EdgeSide = "top" | "right" | "bottom" | "left";

/**
 * Which scalar field replaces the edge.
 *
 * A profile is chosen once and written down; adding one means writing its field
 * function, not adding a second effect type with another nine places to keep in
 * step. `EDGE_PROFILES` is the vocabulary; `schema-enums.ts` is its runtime copy.
 */
export type EdgeProfile = "torn" | "scallop" | "zigzag";

/**
 * How a profile finishes the seam it produces.
 *
 * `paper` steps terraced plies outward from the break. `none` leaves a clean cut.
 */
export type EdgeFinish = "none" | "paper";

/**
 * An edge, as an effect.
 *
 * It is the one effect that is not a filter: it clips the layer's silhouette and
 * paints the broken edge, so it is applied around the artwork rather than to it.
 * Listing it here anyway is deliberate — the EFFECTS section is where a designer
 * looks for "what happens to this layer", it already owns the stack's order,
 * enable switch and style copying, and two breaks on different sides compose
 * (two clips, intersected).
 *
 * A member declares exactly the fields its profile owns, so narrowing on
 * `profile` is what tells the inspector which sliders apply. That is worth more
 * than one flat struct with every field optional, which would let a scallop
 * carry a fibre value nothing could read.
 */
export interface TearEffectMeta {
  type: "tear";
  enabled?: boolean;
  tokenId?: string;
  tokenBindings?: Record<string, string>;
}

export type TearEffect = TearCommon &
  TearEffectMeta &
  (
    | ({ profile: "torn" } & TornFields)
    | ({ profile: "scallop" })
    | ({ profile: "zigzag" })
  );

export interface ColorFilter {
  /** Exposure in stops; every channel is multiplied by 2^exposure. 0 = neutral. */
  exposure?: number;
  brightness?: number; // 1 = 100%
  contrast?: number;   // 1 = 100%
  saturation?: number; // 1 = 100%
  hueRotate?: number;  // in degrees, e.g. 0-360
  temperature?: number;
  tint?: number;
  highlights?: number;
  shadows?: number;
  grayscale?: number;  // 0-1
  invert?: number;     // 0-1
}

/**
 * One column or row track: a px length, or a share of what is left over.
 *
 * A plain number is px and means it at every frame size — it is what the browser
 * measured, and there is no ratio left in it to redistribute. `{ fr }` is CSS's
 * `fr`: its share of the content box once the fixed tracks and the gaps are
 * taken out, which is the one spelling that still describes the grid after the
 * frame has been dragged wider.
 */
export type TrackSize = number | { fr: number };

export interface AutoLayout {
  mode: "flex" | "grid";
  /** Flex only; grid placement uses `placement`. Absent reads as CSS's `row`. */
  direction?: "row" | "column";
  gap?: number;
  padding?: number | [number, number, number, number]; // [top, right, bottom, left] or uniform
  justify?: "start" | "center" | "end" | "space-between" | "space-around" | "space-evenly";
  /** Flex cross-axis: how each ITEM sits in its line. Absent reads as CSS's `stretch`. */
  align?: "start" | "center" | "end" | "stretch";
  /**
   * Flex only: position the wrapped LINES inside the container along the cross
   * axis — CSS `align-content`. This is the second cross-axis level, not a
   * container-wide `align`: `align` places each item within its line, this places
   * the lines. It has nothing to distribute without `wrap`, so it is read only
   * there. Absent reads as `start` — unlike `align`, CSS's implicit `stretch`
   * is NOT inherited here; `stretch` is accepted when it IS written, and grows
   * every line equally to fill the container (CSS's own meaning).
   */
  alignContent?: "start" | "center" | "end" | "stretch" | "space-between" | "space-around" | "space-evenly";
  wrap?: "nowrap" | "wrap";
  columns?: number;
  rows?: number;
  /**
   * Explicit column tracks. Wins over `columns`, which is the equal-division
   * shorthand: `290px 1fr 300px` is three widths and no number of equal cells.
   *
   * Each track says its own answer to a RESIZE: a px track keeps its width and a
   * `{ fr }` track takes a share of what is left, so a grid that was measured
   * with fr in it still behaves like the page it came from — and one that was
   * measured in px stays exactly as it was measured.
   */
  columnSizes?: TrackSize[];
  /**
   * Explicit row tracks. Wins over `rows`. Absent means the rows are derived
   * from the children, which is what an implicit grid does.
   */
  rowSizes?: TrackSize[];
  /**
   * Per-axis gap overriding `gap`, in both modes — CSS `column-gap` / `row-gap`.
   * In a flex row `columnGap` is the main-axis gap and `rowGap` the gap between
   * wrapped lines; in a column the two swap, exactly as CSS maps them.
   */
  columnGap?: number;
  rowGap?: number;
  cellAlign?: "stretch" | "start" | "center" | "end";
  placement?: "row" | "column";
  /** Masonry flow: each child lands in the currently-shortest column. */
  masonry?: boolean;
  /** Whether `columns` is fixed or derived from `columnWidthMin`. */
  columnsMode?: "fixed" | "auto";
  columnWidthMin?: number;
}


export interface AutoLayoutFields {
  /** CSS `display`: the auto-layout mode. Absent means no auto-layout. */
  display?: "flex" | "grid";
  "flex-direction"?: "row" | "column";
  "justify-content"?: "flex-start" | "center" | "flex-end" | "space-between" | "space-around" | "space-evenly";
  /** Flex `align-items`, or grid `cell-align` (the stored mode decides which). */
  "align-items"?: "flex-start" | "center" | "flex-end" | "start" | "end" | "stretch";
  "align-content"?: "flex-start" | "center" | "flex-end" | "stretch" | "space-between" | "space-around" | "space-evenly";
  "flex-wrap"?: "nowrap" | "wrap";
  gap?: number;
  "row-gap"?: number;
  "column-gap"?: number;
  padding?: number | [number, number, number, number]; // [top, right, bottom, left] or uniform
  /** A track count, or explicit track sizes — CSS `grid-template-columns`. */
  "grid-template-columns"?: number | TrackSize[];
  "grid-template-rows"?: number | TrackSize[];
  "grid-auto-flow"?: "row" | "column";
  /** Masonry flow: each child lands in the currently-shortest column. */
  masonry?: boolean;
  /** Whether `grid-template-columns` is a fixed count or derived from `column-width-min`. */
  "columns-mode"?: "fixed" | "auto";
  "column-width-min"?: number;
}

/**
 * Where a child sits in its grid parent, for the children auto-flow would put
 * somewhere else — CSS `grid-column` / `grid-row`.
 *
 * Both indices are 1-BASED, matching the grid line numbers CSS itself uses, so a
 * value read off `grid-column: 2 / 4` is written the same way here. An absent
 * axis is auto-placed, and the two are independent: a child that only says
 * `columnSpan: 2` spans two tracks and is still flowed into place, which is the
 * common case (a field that takes the rest of the row).
 *
 * Ignored where nothing is placing the child, the same reach as
 * `align-self`: absolute, hidden, or in a parent with no grid layout.
 */
export interface LayoutCell {
  column?: number;
  row?: number;
  columnSpan?: number;
  rowSpan?: number;
}


export type SizeMode = "fixed" | "fit-content" | "max-content" | "fill";

export interface ElementSizing {
  /**
   * An absent axis reads as `"fixed"`, and is the container's to decide: a grid
   * cell stretches an axis nobody spoke for, which is CSS's `auto`. `"fixed"`
   * written down is the pin — "the number on the element is the size" — and is
   * the only declaration a cell or an `align-self: "stretch"` cannot override.
   */
  width?: SizeMode;
  height?: Exclude<SizeMode, "max-content">;
  /**
   * Bounds on the axis, in px — CSS's `min-width` / `max-width` and their
   * heights.
   *
   * They are the answer to "how big may this get when its size is DERIVED":
   * a `fill` child in a frame that is dragged wider stops at `maxWidth`, which
   * is the whole point of the "content block, centred, with a limited line
   * width" idiom. A fixed size is not clamped by them — the number in the
   * document is already the answer, and a field that disagrees with the box it
   * renders is worse than one that does nothing.
   */
  minWidth?: number;
  maxWidth?: number;
  minHeight?: number;
  maxHeight?: number;
}

export type ElementType =
  | "frame"
  | "component"
  | "componentSet"
  | "instance"
  | "text"
  | "rect"
  | "ellipse"
  | "polygon"
  | "star"
  | "path"
  | "line"
  | "arrow"
  | "video"
  | "html";

export type SlideTransition = "none" | "dissolve" | "push" | "slide" | "morph";

export type SlideEasing = "linear" | "ease-in" | "ease-out" | "ease-in-out";

/** The edge the incoming frame travels FROM. Only `push` and `slide` read it. */
export type SlideDirection = "left" | "right" | "up" | "down";

/**
 * How this frame LEAVES — the transition into the next slide in deck order.
 * Figma Slides stores it the same way, so a transition crosses the import door
 * on the slide that owns it.
 *
 * Stepping back over the edge replays the arriving slide's declaration in
 * reverse: `resolveStep` owns that reading.
 *
 * Absent means cut, which is what every frame does already — so a deck that
 * sets nothing stays byte-for-byte the document it was.
 *
 * The numbers in here are USER CONTENT, not workbench chrome. `durationMs` is
 * not a `DESIGN.md` motion token: that scale exists for the tool's own
 * feedback, which someone holds all day, and a deck is watched once.
 */
export interface SlideSpec {
  transition?: SlideTransition;
  durationMs?: number;
  easing?: SlideEasing;
  direction?: SlideDirection;
}

/**
 * Carried by every type that presents as a slide: the three containers, plus
 * `html` — a framed page is a screenful in its own right, so it is a slide on
 * its own rather than something that has to be wrapped in a frame to be shown.
 */
export interface SlideHost {
  slide?: SlideSpec;
}

export interface BaseElement {
  id: string;
  type: ElementType;
  name?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation?: number;
  flipX?: boolean;
  flipY?: boolean;
  /**
   * Perspective tilt about the box's horizontal axis, degrees. Rendered as a
   * CSS 3D transform — a projection, not an affine map — so the outline is a
   * general quad and the Matrix2D machinery does not see it.
   */
  rotateX?: number;
  /** Perspective tilt about the box's vertical axis, degrees. See `rotateX`. */
  rotateY?: number;
  /** Perspective viewing distance in px; smaller is stronger. Absent means 800. */
  perspective?: number;
  opacity?: number;
  sizing?: ElementSizing;
  /**
   * The share this child's `fill` takes of its flex parent's leftover main-axis
   * space — CSS `flex-grow`. Only read where the child fills the main axis; its
   * own `sizing` states WHETHER it fills (≈ `flex-basis: 0`), this states HOW
   * MUCH. Absent and `1` are the equal split every fill child already had, so a
   * document that never writes it is unchanged: two fills in a 300 row stay
   * 150/150, and `2` beside an implicit `1` comes out 200/100.
   */
  "flex-grow"?: number;
  position?: "absolute";
  /**
   * This child's own cross-axis alignment inside its layout parent, overriding
   * the container's `layout.align` (flex) / `layout.cellAlign` (grid) for this
   * element alone — CSS `align-self`.
   *
   * It exists because the container's `align` is a single statement about all of
   * its children, and a real layout regularly needs one child to disagree: a
   * full-width row with one centred badge, a stack whose heading sits left while
   * its caption is centred. Without it the only ways to say that were to wrap the
   * child in a frame or to give the container no layout at all, and the second
   * one throws away the container's reorderability to express one child's offset.
   *
   * `"start"` is a VALUE here, not the absence of one: it means "align to the
   * start whatever the container says", which is not the same as inheriting.
   * Absent is the only spelling of "inherit".
   *
   * `"stretch"` sizes the child to the cross axis rather than moving it, so it
   * also decides the child's own size — the same thing `sizing: "fill"` says on
   * that axis, said from the container's side.
   */
  "align-self"?: "flex-start" | "center" | "flex-end" | "stretch";
  /**
   * Space this child reserves around itself inside its layout parent — CSS
   * `margin`, in `[top, right, bottom, left]` or as one number for all four.
   *
   * Read only where a container is placing the element, the same reach as
   * `align-self`: on an out-of-flow child (`position: "absolute"`), a
   * hidden one, or a child of a frame with no layout, it says nothing, because
   * nothing is placing it.
   *
   * SIGNED, unlike `layout.padding`. A negative margin is how CSS pulls a child
   * back over its neighbour, and it is the only way to say "overlap by exactly
   * this much" without taking the child out of the flow — the DSL has no other
   * spelling for a deliberate overlap between siblings in a stack.
   *
   * The difference from `layout.gap`: a gap is one number for the whole
   * container and sits BETWEEN items; a margin belongs to one child and sits
   * around it, including at the container's own edges. Use the gap when the
   * spacing is a property of the stack, and a margin when it is a property of
   * the thing — a card with extra breathing room, or one item that has to be
   * nudged off the rhythm.
   */
  margin?: number | [number, number, number, number];
  /**
   * This child's track placement inside a grid parent — CSS `grid-column` /
   * `grid-row`. Read only by a grid pass, and only where that pass is placing
   * the child at all.
   */
  "grid-area"?: LayoutCell;
  visible?: boolean;
  locked?: boolean;
  blendMode?: BlendMode;
  fillEnabled?: boolean;
  fills?: PaintStack;
  fillStyleId?: string | null;
  strokes?: Stroke[];
  strokeStyleId?: string | null;
  isMask?: boolean;
  maskMode?: MaskMode;
  /**
   * Reads this mask's brightness as its negative — a photo masks by its
   * negative, dark pixels revealing and bright ones hiding.
   *
   * `luminance` only. In `alpha` mode the flag is ignored, because inverting
   * transparency would reveal everything the layer does not paint, which is a
   * region rather than a shape.
   */
  maskInvert?: boolean;
  effects?: Effect[];
  effectStyleId?: string | null;
  adjust?: ColorFilter;
  /**
   * Sides of the box replaced by torn-paper breaks, in the element's own local
   * coordinates. At most one per side; two of them bound a piece cut out of a
   * sheet (see `splitAlongTear`).
   *
   * Geometry, not an effect: the silhouette is clipped, so it holds for a photo,
   * a solid fill, type or a whole frame alike, and exports as a plain `<path>`.
   * The value lives on the element rather than in a mask layer because a mask
   * would be a second object the user has to select, move and delete.
   */
  constraints?: LayoutConstraints;
  /**
   * Absolute URL opened in a NEW TAB when this layer is clicked in a viewing
   * surface — presentation, `?view=canvas`, and an exported SVG. Never in the
   * editor, where a click selects: a canvas that navigates is not editable.
   *
   * `undefined` means no link. Normalization keeps only http / https / mailto /
   * tel and absolutizes a bare host (`example.com` → `https://example.com/`),
   * so nothing has to parse this again before opening it.
   */
  link?: string;
  metadata?: Record<string, unknown>;
  tokenBindings?: Record<string, string>;
  /** Explicit COLOUR token mode override for this container and its subtree (e.g. "dark"). */
  themeMode?: string;
  /** Explicit NUMBER token mode override for this container and its subtree (e.g. "compact"). */
  numberMode?: string;
  __masterNodeId?: string;
  /** Outermost instance a resolved clone belongs to. Only ever set on clones. */
  __instanceId?: string;
  /**
   * Masters already expanded on the path that produced this clone, outermost
   * first. A nested instance whose master is already in here would expand into
   * itself, so resolution stops there. Only ever set on clones.
   */
  __masterChain?: readonly string[];
}


export interface FrameElement extends BaseElement, SlideHost, AutoLayoutFields {
  type: "frame";
  children: DesignElement[];
  /** Ordered background paint stack (first layer bottom-most). */
  fills?: PaintStack;
  clipContent?: boolean;
  borderRadius?: CornerRadius;
  isThumbnail?: boolean;
  /**
   * Corner character on top of `borderRadius`, 0..1 — Figma's second corner
   * control, which it offers on frames as well as rectangles. 0 (default) keeps
   * the circular arc; higher makes the corner fuller, toward a squircle.
   */
  cornerSmoothing?: number;
}

export type OverridableProperty =
  | "content"
  | "style"
  /**
   * The per-run styles of a text — `TextSpan[]`.
   *
   * A range edit (bolding two words of a headline) writes `spans`, not `style`,
   * so leaving it out of this union made the panel's range scope a promise the
   * engine could not keep: the edit was diffed to nothing and the clone kept
   * painting the master's uniform run.
   */
  | "spans"
  | "fills"
  | "strokes"
  | "effects"
  | "adjust"
  | "borderRadius"
  | "cornerSmoothing"
  | "blendMode"
  /**
   * Where the layer points. Overridable for the same reason `visible` is: it is
   * behaviour rather than geometry, and a layer inside a component is exactly
   * where one instance's link has to differ from the master's — a nav item
   * component whose every instance goes somewhere else.
   */
  | "link"
  | "visible"
  | "opacity"
  /**
   * The whole fill stack, on or off — `false` kills it without deleting it.
   *
   * A paint decision like `borderRadius`, not geometry, which is what makes it
   * the instance's to own. An earlier property list advertised it as overridable
   * while this union never carried it, so the promise was one the engine could
   * not keep: pasting a style copied from a layer whose fill was switched off
   * wrote the colours and left the switch behind, so a layer that should have
   * shown no paint showed paint. The read-back case is the same defect seen from
   * the other end.
   */
  | "fillEnabled"
  | "assetId"
  /**
   * Locked inside THIS instance only. A nested instance is otherwise picked up
   * by every click on the outer one, and there is no way to say "not this child"
   * without it — the master owns the child, so the flag cannot live there.
   */
  | "locked"
  /**
   * Whether the layer clips what it contains. Clipping is a paint decision like
   * `borderRadius`, not geometry: it cannot move a child, so an instance may own
   * it. In Figma it is overridable for the same reason.
   */
  | "clipContent"
  /**
   * A nested instance's own master. Swapping it from the OUTSIDE (where the
   * nested node is a resolved clone) is the only way to re-point it, so this is
   * the one property an override writes onto an `instance`-typed node
   * (`swapNestedInstance` in `core/interactions/component-ops.ts`).
   */
  | "componentId"
  /**
   * Which local style a node is bound to.
   *
   * Overridable for one reason: "unlink" has to be an edit the instance can KEEP.
   * Detaching a style only ever DELETED the id, and a deleted id on a resolved
   * clone is not an override — `diffOverridable` saw no change to any paint, wrote
   * nothing, and the detach button reported success while changing nothing. The
   * user was left unable to give one child of one instance their own colour or
   * their own style, with the only way out being to detach the whole instance.
   */
  | "fillStyleId"
  | "strokeStyleId"
  | "textStyleId"
  | "effectStyleId"
  /**
   * A node's numeric token bindings, as a bag merged per key like `style`.
   *
   * Binding a radius / type-size / stroke-width token on an instance child is a
   * paint-level decision, not geometry, and the value it materialises is already
   * resolved per mode — withholding it only made the binding pill on such a node
   * throw the derived-child lock.
   */
  | "tokenBindings"
  /**
   * The mode a container's subtree materialises in. A dark card inside a light
   * page is a decision about THAT instance, so it has to be storable on the
   * clone; without it the inspector's mode menu was the one control that could
   * be clicked and could not land.
   */
  | "themeMode"
  /** The same, on the NUMBER axis: a compact card inside a comfortable page. */
  | "numberMode"
  ;

/**
 * Exhaustive on purpose: adding a member to `OverridableProperty` without
 * listing it here is a compile error, and listing something that is not a member
 * is too. Four hand-written copies of this list used to drift — the readers had
 * 14 entries while the writers had 18, so the four style bindings below were
 * written as overrides and silently filtered out by `normalize` on the next
 * load. The other copies now import `OVERRIDABLE_PROPERTIES` instead of
 * restating it, and `tests/version-consistency.test.ts` holds it against the
 * schema.
 */
const OVERRIDABLE_PROPERTY_MAP: Record<OverridableProperty, true> = {
  content: true,
  style: true,
  spans: true,
  fills: true,
  strokes: true,
  effects: true,
  adjust: true,
  borderRadius: true,
  cornerSmoothing: true,
  blendMode: true,
  link: true,
  visible: true,
  opacity: true,
  fillEnabled: true,
  assetId: true,
  locked: true,
  clipContent: true,
  componentId: true,
  fillStyleId: true,
  strokeStyleId: true,
  textStyleId: true,
  effectStyleId: true,
  tokenBindings: true,
  themeMode: true,
  numberMode: true
};

export const OVERRIDABLE_PROPERTIES = Object.keys(
  OVERRIDABLE_PROPERTY_MAP
) as readonly OverridableProperty[];

export interface ComponentOverride {
  targetId: string;
  property: OverridableProperty;
  value: unknown;
}

export interface ComponentElement extends BaseElement, SlideHost, AutoLayoutFields {
  type: "component";
  children: DesignElement[];
  fills?: PaintStack;
  clipContent?: boolean;
  borderRadius?: CornerRadius;
  cornerSmoothing?: number;
  /**
   * The `componentSet` node this variant belongs to, or a bare id with no node
   * behind it.
   *
   * The second reading is what a document written before the set became a node
   * holds, and it is still produced whenever a set is dissolved (ungroup, a paste
   * that split it, a hoisted master). Readers must not require the node: the
   * grouping is still legible, it just has no box and no property table of its own.
   */
  setId?: string;
  /**
   * This variant's coordinates in the set — Figma's `variantProperties`, one
   * `{ [property]: value }` per member. Every property the SET declares appears
   * here: a member with no value for one is a hole in the matrix, which is
   * exactly what Figma leaves visible rather than papering over.
   */
  variantProperties?: Record<string, string>;
}

/**
 * The container a set of variants lives in — Figma's COMPONENT_SET.
 *
 * A set is a node rather than a shared id for one reason: a canvas that holds a
 * loose master per variant grows a layer every time the author adds a variant,
 * with nothing on it saying which layers belong together. It also gives the set
 * somewhere to keep its OWN name, and — the reason the value lists live here
 * rather than being recomputed from the members — somewhere to keep its property
 * table. Figma's `variantGroupProperties` does exactly this: the set declares each
 * property and every value it may take, and the members carry only their own
 * coordinates. A value nobody has used yet is still a legal choice, which is what
 * lets an instance dropdown offer `Variant 3` before anyone has drawn it.
 *
 * The box is derived from the children (`fitComponentSet`), so a set cannot be
 * resized by hand — Figma does not let you either. There is no `layout` and no
 * `clipContent`: the variants are freely positioned and stay visible outside a
 * shrunken set, exactly as Figma leaves them.
 */
export interface ComponentSetElement extends BaseElement, SlideHost {
  type: "componentSet";
  children: DesignElement[];
  /** Figma's collapse: the set paints its first variant and nothing else. */
  collapsed?: boolean;
  /**
   * Figma's `variantGroupProperties`: `{ State: ["Default", "Hover"] }`.
   *
   * The order is the author's, and it is what decides the column order of the
   * matrix in the inspector. A property no member happens to use is still here —
   * that is the difference between this and the old reading, which inferred the
   * table from the members and therefore could not offer a value that did not
   * exist yet.
   */
  variantGroupProperties?: Record<string, string[]>;
  /** Nothing clips a set — Figma leaves a variant visible outside a collapsed one. */
  clipContent?: undefined;
}

/**
 * An instance is a projection of one variant.
 *
 * Everything an instance can change lives in `overrides` — keyed on a layer of its
 * master, one overridable property per entry. There is deliberately no second
 * channel: Figma's named text / boolean / instance-swap properties were removed
 * because each of them was sugar over a layer override that already worked
 * (`content`, `visible`, `componentId`), and the two channels meant two rules for
 * "what does this instance own", two sets of repairs, and a property vocabulary
 * with two meanings in it. See `docs/LESSONS_LEARNED.md` §110.
 */
export interface InstanceElement extends BaseElement {
  type: "instance";
  componentId: string;
  overrides?: ComponentOverride[];
  borderRadius?: CornerRadius;
  cornerSmoothing?: number;
  /**
   * `undefined` inherits the master's. Every field here is an override, not a
   * definition — see `resolveInstanceBox` in `core/interactions/instance-inherit.ts`
   * for the one rule that resolves them.
   */
  clipContent?: boolean;
  /**
   * The user sized THIS instance by hand. Without it the instance keeps following
   * its master's box — `propagateMasterSize` copies a resized master onto every
   * instance that never set its own.
   * Reset dropped this flag along with the other overrides.
   */
  sizeOverride?: true;
  /**
   * This instance is a proportional SCALE of its master, not merely a resized
   * box. Both factors multiply every length inside the master's subtree — type
   * size, padding, gap, radii, stroke weights, shadow blur and the coordinates
   * themselves — so the instance reads as the same design at another size rather
   * than the same design reflowed into a smaller box. Absent means 1:1.
   *
   * It has to be STORED and cannot be recovered from `width / master.width`:
   * the same box is also what a plain resize produces, and a resize must leave
   * the contents to the constraints. `width`/`height` are written beside it as
   * master × this, so everything that reads a box sees the scaled one.
   */
  instanceScale?: { x: number; y: number };
}

export interface TextElement extends BaseElement {
  type: "text";
  content: string;
  style: TextStyle;
  spans?: TextSpan[];
  textStyleId?: string | null;

  /**
   * The glyphs as a path, in the element's own coordinates.
   *
   * Not decoration and not a second source of truth: it is the SHAPE of the text,
   * kept so a text can act as geometry. A mask needs geometry — Chromium paints
   * a path inside a `<mask>` and paints nothing for a `foreignObject`, which is
   * how every text node here is drawn — so a mask frame holding words had nothing
   * to mask by. A Figma file arrives with this outline already in it
   * (`fillGeometry`), measured on the designer's machine in the design's own
   * coordinates, which is strictly better than re-deriving it from whatever
   * font happens to be installed here.
   *
   * Optional and never required: `content` + `style` still paint the text, and
   * the outline is what a mask reads. Editing the text does not update it —
   * "Outline text" (the editor command) is the deliberate way to replace a text
   * with its shape.
   */
  outline?: {
    /** SVG path data, same dialect as a `path` element's `d`. */
    d: string;
    /** `evenodd` where the outline's holes are wound the other way. */
    fillRule?: "nonzero" | "evenodd";
  };

  onPath?: {
    pathId: string;
    /** Percentage of the path's LENGTH from its start, 0-100. Not pixels: the
     * renderer emits it as an SVG `startOffset` percentage. */
    startOffset?: number;
    /** Which side of the shape the run sits on. Default "out" (outside the edge).
     *
     * Chromium does not honour SVG2's own `side` attribute, so "in" is achieved
     * by traversing the guide the other way — glyphs hang to the LEFT of travel,
     * so a reversed path puts them on the other side — and by reversing the
     * string to match, which is what keeps the run reading forwards around the
     * curve. Reverse the path alone and the text reads backwards.
     *
     * A target the reversal cannot handle faithfully (two subpaths) renders on
     * the outside instead; see `reversePathData`.
     *
     * Only these two values are read. Anything else — including the `"left"` /
     * `"right"` an author may guess from the word "side" — is dropped, and the
     * run renders on the path's default side. */
    side?: "in" | "out";
  };
}

export interface VideoElement extends BaseElement {
  type: "video";
  assetId: string;
  autoplay?: boolean;
  loop?: boolean;
  muted?: boolean;
  controls?: boolean;
  posterAssetId?: string;
  borderRadius?: CornerRadius;
}

/**
 * A live web page on the canvas, framed the way a video embed is.
 *
 * The source is stored on the ELEMENT rather than as an `AssetRef`, which is
 * where a video keeps its own. An asset's `uri` is read as a bitmap everywhere
 * else — the assets panel paints it into an `<img>`, the colour panel offers the
 * first asset with a `uri` as an image fill — so a document payload parked there
 * surfaces as a broken picture in both, and the fix would be a filter in each.
 * Keeping it here leaves the whole asset path meaning what it says.
 */
export interface HtmlEmbedElement extends BaseElement, SlideHost {
  type: "html";
  /**
   * An http(s) page to frame. A site that refuses framing (`X-Frame-Options`,
   * `Content-Security-Policy: frame-ancestors`) renders blank — that refusal is
   * the remote server's, and nothing here can override it.
   */
  src?: string;
  /**
   * A whole HTML document, inlined so the file stays self-contained. Rendered
   * through the iframe's `srcdoc`, which is why a local `.html` can be embedded
   * at all: a browser gives a `file://` page no URL that names a sibling file,
   * so the only door to one is a file picker and the text it returns.
   */
  srcdoc?: string;
  borderRadius?: CornerRadius;
  /**
   * Asset ID pointing to an inlined PNG/WebP snapshot of the rendered page.
   * Rendered on canvas when the embed is in resting (unselected) state.
   */
  posterAssetId?: string;
  /**
   * Keep the live frame mounted while the layer is NOT selected.
   *
   * The default is the opposite because a frame is expensive: an unselected
   * embed shows its poster so a page of them costs one raster each instead of
   * N running documents. This opts a single embed out of that trade, for a
   * page whose whole point is that it is moving — an animation, a clock, a
   * scroll-driven thing that a frozen poster cannot stand in for.
   *
   * It never hands the pointer over; see `SvgHtmlEmbedNode` for why a live
   * preview that hit-tests would be a layer that cannot be dragged.
   */
  alwaysLive?: boolean;
  /**
   * Title / description cached from <title> tag for fallback cards
   * when cross-origin prevents raster snapshot.
   */
  cachedTitle?: string;
  cachedFavicon?: string;
}

export interface RectElement extends BaseElement {
  type: "rect";
  fills?: PaintStack;
  borderRadius?: CornerRadius;
  /**
   * Corner character as a fraction, 0..1, on top of `borderRadius` — Figma's
   * second corner control. 0 (default) keeps the circular arc the radius has
   * always drawn; higher makes the corner fuller, toward a squircle. Shape-wide,
   * so it is ignored when the four radii differ (Figma defines smoothing the
   * same way).
   */
  cornerSmoothing?: number;
}

export interface EllipseElement extends BaseElement {
  type: "ellipse";
  fills?: PaintStack;
  /** Swept angle in degrees, clockwise from top centre; 360 (default) is a full ellipse. */
  sweep?: number;
  /** Inner radius as a fraction of rx (0..0.99); 0 (default) is solid, above that carves a ring. */
  innerRadius?: number;
  /** Where the sweep starts, in degrees clockwise from top centre. Default 0. */
  startAngle?: number;
  /** Angular gap split across both ends of the sweep, so stacked arcs keep a seam. Default 0. */
  gap?: number;
}

/**
 * Regular polygon inscribed in the element's box, first vertex at top center,
 * clockwise. Compile expands it into a path node with generated geometry, so
 * fill/stroke/hit-testing ride the existing path pipeline.
 */
export interface PolygonElement extends BaseElement {
  type: "polygon";
  /** Vertex count, clamped to 3..24 by normalize. */
  sides: number;
  /** How far each corner is cut back, in px. Scales with the box. 0 (default) is sharp. */
  cornerRadius?: number;
  /** Corner character, 0..1. 0 is a circular arc, 0.6 is Figma's iOS preset. */
  cornerSmoothing?: number;
  /** Ordered fill stack, bottom layer first. */
  fills?: PaintStack;
}

/**
 * Regular star inscribed in the element's box, first point at top center,
 * clockwise — Figma's star, with the same three properties. Generated at compile
 * time like the polygon, so it rides the existing path pipeline.
 *
 * `points` counts SPIKES, not vertices: a 5-point star has ten of them, which is
 * why this is not `sides`. `innerRadius` is the inherited field, read here as a
 * fraction of the outer radius (0 makes every inner point collapse onto the
 * center; 1 is a regular polygon).
 */
export interface StarElement extends BaseElement {
  type: "star";
  /** Spike count, clamped to 3..24 by normalize. */
  points: number;
  /**
   * Inner vertex radius as a fraction of the outer one, clamped 0..0.99. 0.382
   * is Figma's default; 1 is a regular polygon and 0 collapses every inner
   * vertex onto the centre. Shares the name with the ellipse field of the same
   * meaning, not the same use — that one carves a ring, this one sets the star.
   */
  innerRadius?: number;
  /**
   * How far each corner is cut back, in px — Figma's `cornerRadius`, a LENGTH,
   * distinct from `cornerSmoothing` below. Scales with the box; 0 (default) is
   * a hard-edged star.
   */
  cornerRadius?: number;
  /**
   * Corner character as a fraction, 0..1. 0 (default) rounds with a circular
   * arc; higher pushes curvature at the straight-edge junction toward zero, the
   * way a squircle is fuller than its inscribed circle. Figma's `iOS` preset is
   * 0.6. Unlike the radius this is shape-wide — there is no per-corner version.
   */
  cornerSmoothing?: number;
  fills?: PaintStack;
}

export interface PathElement extends BaseElement {
  type: "path";
  /**
   * SVG path data in the element's LOCAL box: (0,0) is the element's x/y
   * origin and width/height should enclose the drawn extents. Icons, blobs,
   * decorative shapes — anything that is not a rect/ellipse/line.
   */
  d: string;
  fills?: PaintStack;

  fillRule?: "nonzero" | "evenodd";
}

export interface LineElement extends BaseElement {
  type: "line";

  dx: number;
  dy: number;
  strokes: Stroke[];
}

export interface ArrowElement extends BaseElement {
  type: "arrow";
  /**
   * Second endpoint expressed as a delta from the first: the drawn endpoint
   * on the canvas is `(x + dx, y + dy)`. Both values may be negative.
   */
  dx: number;
  dy: number;
  strokes: Stroke[];
  /**
   * Every arrow has exactly one head, at the `(x + dx, y + dy)` end. There is
   * deliberately no `arrowStart` / `arrowEnd` / `arrowSize`: the renderer emitted
   * `markerEnd` unconditionally and sized the marker in `CanvasDefs`, so all
   * three round-tripped, saved and did nothing. A double-headed or resizable
   * arrow is a real capability, but it is a change to the renderer rather than a
   * field the document could already carry.
   */
}


/**
 * One line drawn through the text.
 *
 * They are INDEPENDENT of one another, which is the whole reason this is a list
 * and not a picker: CSS allows `underline line-through` on the same run, and so
 * does this. A struck-through link, a price shown both discounted and underlined
 * — the combination is ordinary, and the old single-value enum could not spell it
 * at all, so "underline" and "strikethrough" had to be offered as alternatives to
 * each other while `fontStyle` — which really is orthogonal — was offered as a
 * toggle. The two controls disagreed about what they were modelling.
 *
 * `none` is deliberately not a member: no lines IS the empty list, and an absent
 * `textDecoration` says the same thing.
 */
export type TextDecorationLine = "underline" | "line-through";

/**
 * CSS `line-height`, spelled the way CSS spells it.
 *
 * The unit is part of the VALUE, never guessed from its magnitude: a bare number
 * is CSS's `<number>` — a font-size MULTIPLIER that follows a later size change —
 * while `"24px"` is an absolute length that does not. A single number carrying
 * both meanings cannot be told apart at 1.5 vs 3 (is `3` three times the size, or
 * three pixels?), and the old "≤3.5 is a ratio, above is px" rule guessed wrong at
 * both ends: a 400% leading was read as 4px, and a small pinned line height was
 * floored to 1.05× by the very rule meant to protect it. Absent means the engine's
 * size-tiered default — which is also what the CSS keyword `normal` normalizes to,
 * since the engine measures a concrete px box and cannot know FontMetrics' answer.
 */
export type LineHeight = number | `${number}px`;

/**
 * CSS `letter-spacing`, spelled the way CSS spells it.
 *
 * Diverges from `LineHeight` on purpose: CSS has no unitless `letter-spacing`,
 * so the BARE number here is the absolute PIXEL spelling (the meaning this field
 * has always carried, and what every import writes), never a multiple. The
 * relative case is `em` — also CSS's own — and it follows a later font-size
 * change, which is what makes tracking scale with a type ramp.
 *
 * Figma stores `{ value, unit: "PIXELS" | "PERCENT" }` and only `%` is relative;
 * that is an inspector spelling. The file keeps `em` (`5%` ⇄ `0.05em`), because
 * `%` is invalid CSS and `em` is what a browser would compute against.
 *
 * The `"<n>px"` form is accepted input (and what a schema validates) but the
 * normalizer collapses it to the bare number — px is one value, not two.
 */
export type LetterSpacing = number | `${number}px` | `${number}em`;

export interface TextStyle {
  fontFamily: string;
  fontSize: number;
  fontWeight?: number | "normal" | "bold";
  fontStyle?: "normal" | "italic";
  /** Digits get one advance width, so a column of numbers lines up. */
  fontVariantNumeric?: "normal" | "tabular-nums";
  lineHeight?: LineHeight;
  letterSpacing?: LetterSpacing;
  align?: "left" | "center" | "right" | "justify";
  verticalAlign?: "top" | "middle" | "bottom";
  /**
   * The text's ink, as a CSS colour.
   *
   * On a LAYER this is the fallback behind `fills` — the stack is what paints
   * (see `SvgTextNode`). A text STYLE must not carry it: ink is paint, paint is
   * a fill or a paint style, and a style that also stated a colour would be a
   * second source for the same pixels with no control in the style editor to
   * edit it. `normalizeStyles` drops it and reports it; it is absent from
   * `TextStyleDeclaration`, so the compiler holds the same line.
   */
  color: string;
  /** The lines drawn through the text. Canonical order, at most one of each. */
  textDecoration?: TextDecorationLine[];
  textTransform?: "none" | "uppercase" | "lowercase" | "capitalize";
  /**
   * How many lines the box may show. Past that the text is cut, and `…` is
   * added when `textOverflow` says so. `1` is the single-line case: no wrap at
   * all, which is what a nav label or a table cell wants.
   */
  maxLines?: number;
  textOverflow?: "clip" | "ellipsis";
  /**
   * CSS `text-shadow`, accepted as INPUT only.
   *
   * The stored model has one shadow and it is `effects[]` (see `Effect`), so
   * normalize reads this string, converts it into drop shadows and drops it —
   * nothing writes it back. It stays on the type because an author (and the
   * HTML importer) spells a glow this way.
   */
  textShadow?: string;
  tokenBindings?: Record<string, string>;
}

export interface TextSpan {
  text: string;
  style?: Partial<Pick<TextStyle, "fontFamily" | "fontSize" | "fontWeight" | "fontStyle" | "letterSpacing" | "color" | "textDecoration">>;
}

/**
 * How a paint layer composites with what has already been painted beneath it —
 * the other layers of the same element's fill stack, and everything behind the
 * element. `normal` is the plain source-over and is the default.
 *
 * Kept spelled out rather than derived from `schema-enums.BLEND_MODES`: this
 * union is what an author reads, and a list element that no type names is a
 * list element nobody can use. `plus-lighter` is CSS's additive mode — the one
 * member that is not Compositing Level 1 — and it is what Figma's `LINEAR_DODGE`
 * maps to.
 */
export type BlendMode =
  | "normal"
  | "darken"
  | "multiply"
  | "color-burn"
  | "lighten"
  | "screen"
  | "plus-lighter"
  | "color-dodge"
  | "overlay"
  | "soft-light"
  | "hard-light"
  | "difference"
  | "exclusion"
  | "hue"
  | "saturation"
  | "color"
  | "luminosity";


export type MaskMode = "alpha" | "luminance";

interface PaintCommon {
  blendMode?: BlendMode;

  opacity?: number;

  enabled?: boolean;

  /**
   * The colour token (a single-solid PaintStyle id) this paint's colour follows.
   *
   * `color` stays materialised beside it: every reader — renderer, export, the
   * swatch — already paints from `color`, and a token edit updates both in the
   * same commit. A dangling id is allowed on load so the field can say "missing
   * token" instead of silently repainting black.
   */
  tokenId?: string;
}

export interface GradientStop {
  color: string;
  offset: number; // 0 to 1
  /**
   * The colour token this stop follows. `color` stays materialised beside it for
   * the same reason a paint's does: every reader paints from `color`, and a
   * token edit rewrites it in the same commit.
   */
  tokenId?: string;
}

export type PatternMotif = (typeof PATTERN_MOTIFS)[number];
export type PatternTileType = (typeof PATTERN_TILE_TYPES)[number];
export type PatternAlignment = (typeof PATTERN_ALIGNMENTS)[number];

/**
 * A procedurally drawn tiling, not a bitmap and not a reference to another
 * element. Every motif has a closed-form CSS expression, which is why the fill
 * can be written by an agent and previewed by the swatch without a renderer.
 */
export type PatternPaint = PaintCommon & {
  type: "pattern";
  motif: PatternMotif;
  /** One motif cell's authored box in px, before `scale`. */
  tile: { width: number; height: number };
  /** Figma's `scalingFactor`; 1 = the authored cell. */
  scale?: number;
  /** Gap between cells in px. Figma's `spacing`; `x` drives the horizontal repeat. */
  spacing?: { x?: number; y?: number };
  /** Figma's `tileType`. The hexagonal pair staggers alternate rows/columns. */
  tileType?: PatternTileType;
  alignment?: PatternAlignment;
  /** Stripe direction for `diagonal-stripes`, degrees clockwise from vertical. */
  angle?: number;
  /** Line weight, or the dot's diameter driver. Clamped into the cell by geometry. */
  weight?: number;
  foreground: string;
  background?: string;
};

export type Paint =
  | (PaintCommon & { type: "solid"; color: string })
  | (PaintCommon & {
    type: "linear-gradient";
    from: string;
    to: string;
    angle: number;
    fromOffset?: number;
    toOffset?: number;
    stops?: GradientStop[];

    start?: { x: number; y: number };
    end?: { x: number; y: number };
  })
  | (PaintCommon & {
    type: "radial-gradient";
    /** Colour at the centre of the shape. */
    from: string;
    /** Colour at the edge of the shape. */
    to: string;
    fromOffset?: number;
    toOffset?: number;
    stops?: GradientStop[];
    /** Centre as a fraction of the box. Default `{ x: 0.5, y: 0.5 }`. */
    center?: { x: number; y: number };
    /**
     * Circle radius in SVG `objectBoundingBox` units, so `0.5` reaches the nearer
     * edges and `0.71` the corners. Default `0.75`. The circle shorthand: when
     * `rx`/`ry` are absent this is both axes, and when they are equal it is kept
     * in sync by normalize.
     */
    radius?: number;
    /**
     * Ellipse semi-axes as fractions of the box width / height. Absent (or
     * equal, unrotated) means the circle form above; rendering then goes through
     * the plain `<radialGradient>` attributes rather than `gradientTransform`.
     */
    rx?: number;
    ry?: number;
    /** Ellipse rotation, degrees clockwise in the box's own (unrotated) space. */
    angle?: number;
  })
  | (PaintCommon & {
    type: "angular-gradient";
    /** Colour at the sweep's start angle. */
    from: string;
    /** Colour where the sweep closes back onto its start. */
    to: string;
    fromOffset?: number;
    toOffset?: number;
    stops?: GradientStop[];
    /** Centre of the sweep as a fraction of the box. Default `{ x: 0.5, y: 0.5 }`. */
    center?: { x: number; y: number };
    /**
     * Where the sweep begins, degrees clockwise from top centre — the same
     * convention `ellipse.startAngle` uses. Default `0`.
     */
    angle?: number;
  })
  | (PaintCommon & {
    type: "diamond-gradient";
    /** Colour at the centre. */
    from: string;
    /** Colour at the diamond's vertices. */
    to: string;
    fromOffset?: number;
    toOffset?: number;
    stops?: GradientStop[];
    /** Centre as a fraction of the box. Default `{ x: 0.5, y: 0.5 }`. */
    center?: { x: number; y: number };
    /**
     * Diamond semi-axis as a fraction of the box, when both are equal: `0.5`
     * puts every vertex on a box edge midpoint, `0.71` on a corner. Default
     * `0.75`. Circle shorthand for rx = ry; kept in sync by normalize.
     */
    radius?: number;
    /**
     * Diamond semi-axes as fractions of the box width / height — the distance
     * from the centre to the horizontal and vertical vertices respectively, so
     * the iso-line `|dx|/rx + |dy|/ry = 1` is the diamond itself.
     */
    rx?: number;
    ry?: number;
    /** Diamond rotation, degrees clockwise in the box's own (unrotated) space. */
    angle?: number;
  })
  | (PaintCommon & {
    type: "image";
    assetId: string;
    fit?: "cover" | "contain" | "fill" | "crop";
    /**
     * Figma's photo sliders for this layer: a colour adjustment applied to the
     * bitmap alone, before it composites onto the layers beneath it.
     *
     * An image is the only paint kind that has one — a solid has a colour to
     * write instead, and a gradient's `stops` are where its colour is stated.
     * Writing it anywhere else is refused and named in `repairs` rather than
     * kept and ignored.
     */
    adjust?: ColorFilter;
    focalPoint?: { x: number; y: number };
    /** Authoritative framing when `fit` is `"crop"`; ignored by every other mode. */
    crop?: ImageCrop;
  })
  | PatternPaint;

/**
 * Where a bitmap sits inside its box, as Figma's `imageTransform` does: the
 * bitmap's top-left in box fractions, plus a uniform multiple of the `cover`
 * scale (1 = the bitmap exactly covers the box).
 *
 * Box-relative rather than source-relative, and a single `scale` rather than a
 * width and a height, because those are the two properties the framing needs:
 * resizing the box re-frames instead of distorting, and a non-square resize
 * cannot break the bitmap's aspect ratio.
 */
export interface ImageCrop {
  x: number;
  y: number;
  scale: number;
  /** Degrees clockwise about the bitmap's own centre, in the box's space. */
  rotation?: number;
}


export type PaintStack = Paint[];

/** The one variant that names an asset. Reading `assetId` off `Paint` needs it. */
export type ImagePaint = Extract<Paint, { type: "image" }>;

export type StrokeSide = "all" | "top" | "right" | "bottom" | "left" | "custom";

export interface StrokeSideWeights {
  top?: number;
  right?: number;
  bottom?: number;
  left?: number;
}

export interface Stroke {
  color?: string;
  width: number;
  tokenId?: string;
  /** Shorthand only: an odd-length `dashArray` wins, and `dashed` without one
   *  falls back to `DEFAULT_DASH`. Kept because it is what imports emit. */
  style?: "solid" | "dashed";
  align?: "inside" | "center" | "outside";
  /** Line cap; default "butt" (SVG default). */
  cap?: "butt" | "round" | "square";
  /** Line join; default "miter" (SVG default). */
  join?: "miter" | "round" | "bevel";
  /** How far a miter may extend past the corner before it is cut back; default 4. */
  miterLimit?: number;
  /** Alternating dash and gap lengths, repeated to tile the outline. */
  dashArray?: number[];
  /** Phase along the first dash, so the pattern can be slid along the path. */
  dashOffset?: number;
  enabled?: boolean;
  opacity?: number;
  /**
   * What this row paints. A row's colour is a VALUE — or, to follow the design
   * system, `tokenId` / `paint.tokenId`.
   *
   * There is deliberately NO pointer at a fill style here. The four style kinds
   * are independent: a stroke is owned by a `StrokeStyle` (or by nothing), a
   * fill by a `PaintStyle`, and the only thing crossing between them is a
   * colour/number TOKEN. A row that named a paint style made one style own
   * another's declaration, so a stroke could be "half a fill style" — which is
   * not a thing this model has.
   */
  paint?: Paint;
  side?: StrokeSide;
  sides?: StrokeSideWeights;
}

/** The dash pattern `style: "dashed"` stands for when no `dashArray` is given. */
export const DEFAULT_DASH: readonly number[] = [6, 4];

export interface LayoutConstraints {
  preserveAspectRatio?: boolean;
  horizontal?: "left" | "right" | "center" | "stretch" | "scale";
  vertical?: "top" | "bottom" | "center" | "stretch" | "scale";
}

export type StyleType = "paint" | "text" | "effect" | "stroke";

/**
 * One entry in `doc.styles[]`: a set of DECLARATIONS a layer applies.
 *
 * A style is the CSS-rule half of the design system; a VALUE lives in
 * `doc.tokens[]`. The two are separate tables on purpose — an id lives in
 * exactly one of them, and which table an entry is in IS its role. A paint style
 * whose stack is one solid is therefore a legal style (a rule that declares one
 * colour), not a token by shape: use a colour token when the thing you are naming
 * is the colour itself.
 */
export interface BaseStyle {
  id: string;
  name: string;
  description?: string;
  styleType: StyleType;
}

export interface PaintStyle extends BaseStyle {
  styleType: "paint";
  paints: PaintStack;
}

/**
 * What a text STYLE may declare: the typography, spelled out.
 *
 * An explicit interface rather than `Omit<TextStyle, "color">`, because the set
 * is the contract: the style editor has one control per field here, the layer
 * inspector hides the same block, and `normalizeStyles` refuses anything else.
 * An `Omit` would silently admit a field the day `TextStyle` grew one.
 *
 * What is absent is absent on purpose: `color` (ink is the layer's `fills`),
 * `align` / `verticalAlign` (they place the box), `fontVariantNumeric` (figures
 * are the layer's), `maxLines` / `textOverflow` (clipping is the box's), and
 * `textShadow` (a shadow belongs to the layer or to an effect style — a text
 * style is TYPE, and nothing else).
 */
export interface TextStyleDeclaration {
  fontFamily: string;
  fontSize: number;
  fontWeight?: number | "normal" | "bold";
  fontStyle?: "normal" | "italic";
  lineHeight?: LineHeight;
  letterSpacing?: LetterSpacing;
  /** The lines drawn through the text. Canonical order, at most one of each. */
  textDecoration?: TextDecorationLine[];
  textTransform?: "none" | "uppercase" | "lowercase" | "capitalize";
  /** How `fontSize` / `lineHeight` / `letterSpacing` follow a number token. */
  tokenBindings?: Record<string, string>;
}

/**
 * A text style is TYPE and only type: every field it can own is a declaration
 * in `style`. There is deliberately no `effects` — a shadow is the layer's, or
 * an effect style's, and a text style that also owned one made the layer's
 * Effects panel a control that overwrote itself on the next sync.
 */
export interface TextStyleDefinition extends BaseStyle {
  styleType: "text";
  style: TextStyleDeclaration;
}

export interface EffectStyle extends BaseStyle {
  styleType: "effect";
  effects: Effect[];
}

export interface StrokeStyle extends BaseStyle {
  styleType: "stroke";
  strokes: Stroke[];
}

export type NumberTokenCategory = "spacing" | "radius" | "stroke" | "size" | "typography" | "effect";

export type DesignStyle = PaintStyle | TextStyleDefinition | EffectStyle | StrokeStyle;

/**
 * One entry in `doc.tokens[]`: a token is a VALUE, a style is a set of
 * declarations. The `type` tag is what a reader dispatches on, so `type ===
 * "color"` narrows `value` to `string` at every use site instead of pushing an
 * assertion into each one — which is why this is a discriminated union and not
 * one interface with `value: string | number`.
 *
 * `modes` is the multi-mode dictionary, named after `doc.modes`; the axes a
 * token may be bound to are `category`'s business, not a second `scope` field.
 */
export interface BaseToken {
  id: string;
  name: string;
  description?: string;
  /** mode id → the value in that mode. A missing entry falls back to `value`. */
  modes?: Record<string, string | number>;
}

export interface ColorToken extends BaseToken {
  type: "color";
  /** `#RRGGBB`, or `#RRGGBBAA` when the value is translucent. Never a paint. */
  value: string;
  modes?: Record<string, string>;
}

export interface NumberToken extends BaseToken {
  type: "number";
  /** px, the same unit `tokenBindings` writes onto the element. */
  value: number;
  category?: NumberTokenCategory;
  modes?: Record<string, number>;
}

export type DesignToken = ColorToken | NumberToken;

export interface AssetRef {
  id: string;
  name: string;
  uri: string;
  width?: number;
  height?: number;
  /** Video/Audio duration in seconds. */
  duration?: number;
  /** Attribution required by the source's license/API terms. */
  credit?: { name: string; url: string };
}
