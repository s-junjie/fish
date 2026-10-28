import { DesignDocument, DesignElement, ComponentElement, InstanceElement, PaintStack, AssetRef, TextElement, PathElement, RectElement, EllipseElement, PolygonElement, getActivePage } from "../../core/dsl/types";
import { getShapeLocalPath, isGradientPaint } from "../../core/geometry/gradient-utils";
import { GradientDef } from "./GradientDef";
import { imagePaintImage } from "./image-paint-attrs";
import { flattenElements, isContainer } from "../../core/geometry/tree-ops";
import { ViewportBox, computeVisibleElementIds } from "../../core/geometry/cull";
import { rectToPathData } from "../../core/compile";
import type { OnPathGuide } from "../../core/geometry/on-path";
import { resolveInstanceContent, type InstanceResolveOptions } from "../../core/interactions/instance-resolve";
import { getActiveNumberMode, getActiveTheme } from "../../core/interactions/mode-ops";
import { styleTables } from "../../core/interactions/style-tables";
import { heldMaster } from "../../core/interactions/detached-masters";
import {
  resolveInstanceBox,
  resolveInstanceNumberMode,
  resolveInstanceTheme,
  resolvedPaintStack,
  InstanceBox
} from "../../core/interactions/instance-inherit";
import { isNeutralColorFilter } from "../../core/dsl/color-filter";
import { paintLayerIndex } from "../../core/dsl/paint-stack";
import { PatternPaintDef } from "./PatternPaintDef";
import { appendColorFilterNodes } from "./color-filter-nodes";
import { buildReferenceRegistry, ReferenceRegistry } from "./reference-registry";
import { maskAlphaFilterDef, maskClipDef, maskLayerDef } from "./mask-defs";
import { edgeClipDefs } from "./EdgeLayer";
import type { TearEffect } from "../../core/dsl/types";
import { Fragment } from "preact";
import { useMemo } from "preact/hooks";
import { memo } from "../memo";
import { CANVAS_MASK_CUT, CANVAS_MASK_KEEP } from "./canvas-colors";
import { paintAdjustRegion } from "./filter-region";
import { renderEffectFilterDef } from "./effect-filter-def";
import { renderLiquidGlassDef } from "./liquid-glass-def";
import { boxSize, elementStrokes } from "./def-geometry";

export {
  computeFilterRegion,
  paintAdjustRegion,
  PAINT_ADJUST_PAD_BOX,
  PAINT_ADJUST_PAD_PX
} from "./filter-region";
export type { FilterRegion, RegionFractions } from "./filter-region";

interface CanvasDefsProps {
  allElements: DesignElement[];
  viewportBox?: ViewportBox | null;
  selectedIds: Set<string>;
  /**
   * `deviceScale(zoom)`, NOT the raw zoom. The Liquid Glass bitmaps are rasters
   * laid out in user units, so this is the scale they have to be baked at, and a
   * conic fan's sector count is a chord-error budget in the same pixels — both
   * `deviceScale` rungs, and nothing between them.
   *
   * Taking the raw zoom here made every wheel tick rebuild all ten def passes
   * (`computeVisibleElementIds`, the instance resolves, ten `.map()`s) to produce
   * byte-identical `<defs>` content, because the component quantises the value
   * itself. Pass the rung and the whole subtree can be compared by value.
   *
   * Callers that paint at 1:1 — an export mirror, a thumbnail — leave it alone.
   */
  viewScale?: number;
  /**
   * `pixelScale(zoom)` — the same quantity WITHOUT the rung ceiling, because
   * `feMorphology`'s radius is capped in device pixels and the spread has to be
   * split against the real one (see `MORPHOLOGY_MAX_DEVICE_PX`). Also quantised,
   * so the subtree is still compared by value.
   */
  pixelScale?: number;
  /** Document assets, so an image fill can resolve its bitmap URI. */
  assets?: AssetRef[];
  /** The document, so a def can resolve a component master that lives on another page. */
  docRef?: { current: DesignDocument };
  /**
   * Text-on-Path guides by text element id, built by the caller and shared with
   * the renderer. A guide decides both which way the path runs and whether the
   * run's string is flipped, and the two halves are drawn by different
   * components — computed twice they agree today and diverge the first time a
   * reversal is refused, which renders the text backwards with nothing to see.
   */
  onPathGuides?: ReadonlyMap<string, OnPathGuide>;
}

export function CanvasDefs({ allElements, viewportBox, selectedIds, viewScale = 1, pixelScale = 1, assets, docRef, onPathGuides }: CanvasDefsProps) {
  // Keyed on the rendered elements, not the document: the index is built from
  // every page but is only read through an element on this one.
  //
  // The catch is not guarding `buildReferenceRegistry` — it is what lets a test
  // call `CanvasDefs` as a plain function. `useMemo` needs a component on the
  // stack; `shadow-spread` mocks it away, but that mock only holds while no
  // earlier file has cached the real `preact/hooks` (`isolate: false`), so this
  // path has to survive the memo being live.
  let registry: ReferenceRegistry | undefined;
  try {
    registry = useMemo(
      () => (docRef ? buildReferenceRegistry(docRef.current) : undefined),
      [allElements, docRef]
    );
  } catch {
    registry = docRef ? buildReferenceRegistry(docRef.current) : undefined;
  }

  // A def is only reachable through a rendered element, so offscreen elements can
  // be skipped entirely. Selected elements and mask stencils stay because the
  // renderer keeps painting those outside the viewport.
  //
  // Culling must be driven by the WORLD bounds of each element's TOP-LEVEL
  // ancestor, not by the element's own (local) `subtreeBounds`. The renderer
  // only culls top-level elements (SvgElementRenderer): once a top-level element
  // passes the viewport test it paints its ENTIRE subtree, so every descendant's
  // defs (gradients, image patterns, filters, clips) must be emitted whenever
  // that top-level ancestor is in view. `subtreeBounds` returns coordinates in
  // the element's local space, so comparing it directly to the world
  // `viewportBox` mis-culls nested elements: a frame placed away from the origin
  // keeps rendering while its nested image/gradient defs get dropped, making
  // those fills vanish (then reappear as you zoom/pan the origin through the
  // viewport). Gate defs by top-level-ancestor visibility instead — correct and
  // O(n).
  const visibleIds = computeVisibleElementIds(allElements, viewportBox, selectedIds);
  const visibleKey = Array.from(visibleIds).join("\0");

  const buildDefs = () => {
    const visible = allElements.filter((el) => visibleIds.has(el.id));

    const byId = new Map<string, DesignElement>();
    for (const el of allElements) byId.set(el.id, el);

    const themeMap = new Map<string, string>();
    const numberModeMap = new Map<string, string>();
    const themeTables = docRef ? styleTables(docRef.current) : undefined;
    const activeTheme = docRef ? getActiveTheme(docRef.current) : "default";
    const activeNumberMode = docRef ? getActiveNumberMode(docRef.current) : "default";

    const findMaster = (componentId: string): ComponentElement | null => {
      const fromRegistry = (registry?.getComponent(componentId) ?? heldMaster(componentId)) as ComponentElement | null;
      if (fromRegistry) return fromRegistry;
      const el = byId.get(componentId);
      return el && el.type === "component" ? (el as ComponentElement) : null;
    };

    if (docRef) {
      const collectThemes = (elements: DesignElement[], inherited: string, inheritedNumber: string) => {
        for (const el of elements) {
          // An instance takes its master's mode until it declares one — the same
          // inheritance `SvgNodeRenderer` applies, and the two have to agree: a
          // def emitted from the light palette is a gradient painted onto a dark
          // box, and only when the master itself is themed.
          const master = el.type === "instance" ? findMaster((el as InstanceElement).componentId) : null;
          const theme =
            el.type === "instance"
              ? resolveInstanceTheme(el as InstanceElement, master, inherited)
              : el.themeMode || inherited;
          themeMap.set(el.id, theme);
          // The number axis walks the same tree with the same rule, on its own
          // map: a def does not care about density, but the instance box it is
          // measured against does.
          const numberMode =
            el.type === "instance"
              ? resolveInstanceNumberMode(el as InstanceElement, master, inheritedNumber)
              : el.numberMode || inheritedNumber;
          numberModeMap.set(el.id, numberMode);
          if (isContainer(el)) collectThemes(el.children || [], theme, numberMode);
        }
      };
      const doc = docRef.current;
      const pages = doc.pages?.length ? doc.pages : [getActivePage(doc)];
      for (const page of pages) collectThemes(page.children || [], activeTheme, activeNumberMode);
    }

    /**
     * The theme an instance resolves under.
     *
     * `el.themeMode` comes FIRST because an override may have written it onto the
     * node itself — a resolved clone whose own mode was overridden carries the
     * value by the time this runs, and reading the table first would emit its
     * gradient defs from the mode the instance used to be in. A clone with no row
     * of its own answers with the theme of the instance that minted it, which is
     * the context its colours were already materialised in.
     */
    const themeOptions = (el: DesignElement): InstanceResolveOptions | undefined => {
      if (!themeTables) return undefined;
      const owner = (el as { __instanceId?: string }).__instanceId;
      const theme =
        (el as { themeMode?: string }).themeMode ??
        themeMap.get(el.id) ??
        (owner ? themeMap.get(owner) : undefined) ??
        activeTheme;
      const numberMode =
        (el as { numberMode?: string }).numberMode ??
        numberModeMap.get(el.id) ??
        (owner ? numberModeMap.get(owner) : undefined) ??
        activeNumberMode;
      return { theme, numberMode, tables: themeTables };
    };

    const boxCache = new Map<string, InstanceBox | null>();
    const fillsCache = new Map<string, PaintStack>();

    /**
     * Every node the painter can ask a def for: the stored tree, plus the resolved
     * clone of every instance in it — through EVERY instance level.
     *
     * One level is not enough. `SvgNodeRenderer` recurses, so a nested instance
     * paints its own resolved children and asks for their `pat_` / `grad_fill_` /
     * `filter_` / `clip_` ids — while this walk stopped at the first crossing and
     * never emitted them. An SVG paint server that does not exist paints nothing,
     * which is how a component inside a component lost its photograph, its ramp
     * and its shadow while keeping its type (text needs no def).
     */
    const defElements: DesignElement[] = [...visible];
    const addClones = (clones: DesignElement[]) => {
      for (const el of clones) {
        defElements.push(el);
        if (el.type === "instance") {
          const master = findMaster((el as InstanceElement).componentId);
          // `resolveInstanceContent` cuts a cycle on `__masterChain`, so this
          // terminates even for a document that somehow nested itself.
          if (master) addClones(resolveInstanceContent(el as InstanceElement, master, themeOptions(el)).children);
          continue;
        }
        if (isContainer(el)) addClones(el.children || []);
      }
    };
    for (const el of visible) {
      if (el.type !== "instance") continue;
      const master = findMaster((el as InstanceElement).componentId);
      if (master) addClones(resolveInstanceContent(el as InstanceElement, master, themeOptions(el)).children);
    }
    for (const el of defElements) byId.set(el.id, el);

    const instanceBox = (el: DesignElement): InstanceBox | null => {
      if (el.type !== "instance") return null;
      if (boxCache.has(el.id)) return boxCache.get(el.id) ?? null;
      const master = findMaster((el as InstanceElement).componentId);
      if (!master || master.type !== "component") {
        boxCache.set(el.id, null);
        return null;
      }
      const content = resolveInstanceContent(el as InstanceElement, master as ComponentElement, themeOptions(el));
      const b = resolveInstanceBox(el as InstanceElement, master as ComponentElement, content, themeOptions(el));
      boxCache.set(el.id, b);
      return b;
    };

    const resolvedFills = (el: DesignElement): PaintStack => {
      const cached = fillsCache.get(el.id);
      if (cached) return cached;
      const stack = resolvedPaintStack(el, instanceBox(el));
      fillsCache.set(el.id, stack);
      return stack;
    };

    const shared: DefsShared = { boxOf: instanceBox, fillsOf: resolvedFills };

    /**
     * The path a text-on-path element is laid along, if any.
     *
     * Passed to the element's own defs so the comparator can see when the TARGET
     * moved: the guide def carries the target's translation, and a text element
     * whose own identity is unchanged still needs new markup when the path under
     * it is dragged. Read here, from the document-wide index, because the target
     * may be a sibling of the element's own root and not its ancestor.
     */
    const guideTargetOf = (el: DesignElement): DesignElement | undefined => {
      if (el.type !== "text") return undefined;
      const pathId = (el as TextElement).onPath?.pathId;
      return pathId ? byId.get(pathId) : undefined;
    };

    return (
      <defs>
        {/* One marker for every arrow, painted in the referencing line's own stroke.
        * A fixed colour here is a second writer of the arrow's colour: this was
        * `#FFFFFF`, which only ever looked right because an arrow used to be born
        * white — the moment a line's default became ink, every arrowhead stayed
        * white and a black arrow lost its head on white paper. `context-stroke`
        * is what makes the head inherit `stroke` from the element that references
        * the marker, so the two cannot disagree. */}
        <marker
          id="arrowhead"
          markerWidth="10"
          markerHeight="7"
          refX="10"
          refY="3.5"
          orient="auto"
        >
          <polygon points="0 0, 10 3.5, 0 7" fill="context-stroke" />
        </marker>

        {defElements.filter(emitsDefs).map((el) => (
          <ElementDefs
            key={el.id}
            el={el}
            viewScale={viewScale}
            pixelScale={pixelScale}
            assets={assets}
            master={el.type === "instance" ? findMaster((el as InstanceElement).componentId) : null}
            guide={el.type === "text" ? onPathGuides?.get(el.id) : undefined}
            guideTarget={guideTargetOf(el)}
            shared={shared}
          />
        ))}
      </defs>
    );
  };

  try {
    return useMemo(
      buildDefs,
      [allElements, visibleKey, viewScale, pixelScale, assets, docRef, onPathGuides]
    );
  } catch {
    return buildDefs();
  }
}

/**
 * Whether an element can produce ANY def.
 *
 * One `<ElementDefs>` per element is the point — but an element with no clip, no
 * paint server, no filter and no mask produces nothing, and on the measured
 * document that is most of them. Wrapping those anyway costs more than the tree
 * it was meant to save: 1,841 component vnodes are built and asked
 * `shouldComponentUpdate` on every commit, which measured slower than emitting
 * the handful of real defs inline did.
 *
 * Deliberately conservative: an unknown effect or a stroke that might paint
 * counts as "yes", because a wrong `false` here is a missing def and a missing
 * def paints nothing at all.
 */
function emitsDefs(el: DesignElement): boolean {
  if (el.isMask) return true;
  if (isContainer(el) && el.clipContent) return true;
  // An instance takes its clip, its fills and its strokes from its master.
  if (el.type === "instance") return true;
  if (el.type === "text" && (el as TextElement).onPath?.pathId) return true;
  for (const effect of el.effects ?? []) if (effect.enabled !== false) return true;
  for (const fill of (el.fills ?? []) as any[]) {
    if (!fill) continue;
    if (isGradientPaint(fill) || fill.type === "image" || fill.type === "pattern" || fill.adjust) return true;
  }
  for (const stroke of ((el as any).strokes ?? []) as any[]) {
    if (!stroke || stroke.enabled === false) continue;
    if (stroke.width > 0 || stroke.side === "custom") return true;
    const paint = stroke.paint;
    if (paint && (isGradientPaint(paint) || paint.type === "pattern")) return true;
  }
  return false;
}

/** What every element's defs need from the document, shared across the tree. */
interface DefsShared {
  boxOf: (el: DesignElement) => InstanceBox | null;
  fillsOf: (el: DesignElement) => PaintStack;
}

export interface ElementDefsProps {
  el: DesignElement;
  /** `deviceScale(zoom)` — a bake rung, so a def is only rebuilt when it moves. */
  viewScale: number;
  /** `pixelScale(zoom)` — the same quantity with no ceiling, for `feMorphology`. */
  pixelScale: number;
  assets?: AssetRef[];
  /** The component an instance resolves against; its defs follow the master. */
  master: ComponentElement | null;
  /** The text-on-path guide, and the path element it was measured against. */
  guide?: OnPathGuide;
  guideTarget?: DesignElement;
  shared: DefsShared;
}

/**
 * Every def one element needs, emitted as a unit.
 *
 * These passes used to run over the whole document on every render, inside a
 * memo keyed on `allElements` — so a drag, which produces a new array per frame,
 * re-emitted and re-diffed about a thousand vnodes to move one layer. Rendering
 * `<defs>` as `null` took the same drag from 76 frames to 47, which is what this
 * is recovering.
 *
 * The comparator lists what a def actually depends on, all of it local: its own
 * element, the two raster-scale rungs, the asset list, the master it resolves
 * against, and the path its text follows. Everything else — a different page, a
 * selection, the camera — leaves the markup byte-identical, and the emitted
 * fragment is kept.
 *
 * Order within the fragment is the order the old passes used per element. Across
 * elements it does not matter: every def is reached by `url(#id)`, never by
 * position.
 */
export function renderElementDefs(props: ElementDefsProps) {
  const { el, assets, viewScale, pixelScale, guide, guideTarget, shared } = props;
  const box = shared.boxOf(el);

  // ---- clip path: a frame or instance that clips its content ----
  let clip = false;
  let clipPathD = "";
  if (isContainer(el)) {
    clip = Boolean(el.clipContent);
    if (clip) clipPathD = getShapeLocalPath(el);
  } else if (el.type === "instance") {
    clip = Boolean(box?.clipContent);
    if (clip) {
      clipPathD = rectToPathData({
        width: box ? box.width : el.width,
        height: box ? box.height : el.height,
        borderRadius: box ? box.borderRadius : (el as any).borderRadius,
        cornerSmoothing: box?.cornerSmoothing ?? (el as any).cornerSmoothing
      } as RectElement);
    }
  }

  // ---- broken edges: one clip per layer that declares `edge` ----
  const edgeEffects = (el.effects ?? []).filter((ef) => ef.type === "tear" && ef.enabled !== false);

  // ---- fill defs: gradients, image tiles, pattern tiles, colour adjusts ----
  const fills = shared.fillsOf(el);
  const { w, h } = boxSize(el, box);

  const gradients = fills
    .map((fill, fIdx) => {
      if (!fill || !isGradientPaint(fill)) return null;
      return (
        <GradientDef
          key={`g${fIdx}`}
          id={`grad_fill_${el.id}_${fIdx}`}
          paint={fill}
          width={w}
          height={h}
          viewScale={viewScale}
        />
      );
    })
    .filter(Boolean);
  const imageTiles = fills
    .map((f, fIdx) => {
      if (!f || f.type !== "image" || f.enabled === false) return null;
      const asset = assets?.find((a) => a.id === f.assetId);
      if (!asset?.uri) return null;
      const img = imagePaintImage(f, { width: w, height: h }, asset);
      if (!img) return null;
      return (
        <pattern
          key={`img${fIdx}`}
          id={`pat_${el.id}_${fIdx}`}
          patternUnits="userSpaceOnUse"
          patternContentUnits="userSpaceOnUse"
          x={0}
          y={0}
          width={w}
          height={h}
        >
          <image {...img} />
        </pattern>
      );
    })
    .filter(Boolean);
  const patternTiles = fills
    .map((f, fIdx) => {
      if (!f || f.type !== "pattern" || f.enabled === false) return null;
      return (
        <PatternPaintDef
          key={`pat${fIdx}`}
          id={`pat_${el.id}_${paintLayerIndex(fills, f, fIdx)}`}
          paint={f}
          width={w}
          height={h}
        />
      );
    })
    .filter(Boolean);
  const paintFilters = fills
    .map((f, fIdx) => {
      if (!f || f.type !== "image" || !f.adjust || isNeutralColorFilter(f.adjust)) return null;
      const primitives: any[] = [];
      appendColorFilterNodes(primitives, f.adjust, "SourceGraphic", `pcf-${el.id}-${fIdx}`);
      if (primitives.length === 0) return null;
      const region = paintAdjustRegion(box?.width ?? el.width ?? 100, box?.height ?? el.height ?? 100);
      return (
        <filter
          key={`pf${fIdx}`}
          id={`paintfilter_${el.id}_${fIdx}`}
          x={`${region.x * 100}%`}
          y={`${region.y * 100}%`}
          width={`${region.width * 100}%`}
          height={`${region.height * 100}%`}
          colorInterpolationFilters="sRGB"
        >
          {primitives}
        </filter>
      );
    })
    .filter(Boolean);

  // ---- stroke defs: paint along the outline, plus the inside/outside clip ----
  const paintStrokes = (el as any).strokes || [];
  const outlineStrokes = elementStrokes(el, box);
  const strokeTiles = paintStrokes
    .map((s: any, sIdx: number) => {
      const strokePaint = s?.paint;
      if (!strokePaint || strokePaint.type !== "pattern" || s.enabled === false) return null;
      return (
        <PatternPaintDef
          key={`spat${sIdx}`}
          id={`pat_stroke_${el.id}_${paintLayerIndex(paintStrokes, s, sIdx)}`}
          paint={strokePaint}
          width={w}
          height={h}
        />
      );
    })
    .filter(Boolean);
  const strokeGradients = paintStrokes
    .map((s: any, sIdx: number) => {
      const strokePaint = s?.paint;
      if (!strokePaint || !isGradientPaint(strokePaint)) return null;
      // A pattern clips to its tile, and a centre- or outside-aligned stroke
      // paints past the element's box, so the tile has to reach as far as the
      // stroke does or the gradient repeats at the edge.
      const pad = Math.max(0, Number(s?.width) || 0);
      return (
        <GradientDef
          key={`sg${sIdx}`}
          id={`grad_stroke_${el.id}_${sIdx}`}
          paint={strokePaint}
          width={w}
          height={h}
          pad={pad}
        />
      );
    })
    .filter(Boolean);
  const hasActiveStroke = outlineStrokes.some((s: any) => {
    if (!s || s.enabled === false) return false;
    if (s.width > 0) return true;
    if (s.side === "custom" && s.sides) {
      return Object.values(s.sides).some((v: any) => typeof v === "number" && v > 0);
    }
    return false;
  });
  let outline: any = null;
  if (hasActiveStroke) {
    const pathD =
      el.type === "instance"
        ? rectToPathData({
            width: box ? box.width : el.width,
            height: box ? box.height : el.height,
            borderRadius: box ? box.borderRadius : (el as any).borderRadius,
            cornerSmoothing: box?.cornerSmoothing ?? (el as any).cornerSmoothing
          } as RectElement)
        : getShapeLocalPath(el);
    if (pathD) {
      let maxStrokeW = 1;
      for (const s of outlineStrokes) {
        if (!s || s.enabled === false) continue;
        if (typeof s.width === "number" && s.width > maxStrokeW) maxStrokeW = s.width;
        if (s.side === "custom" && s.sides) {
          for (const v of Object.values(s.sides)) {
            if (typeof v === "number" && v > maxStrokeW) maxStrokeW = v;
          }
        }
      }
      const pad = Math.ceil(maxStrokeW * 2 + 16);
      const mx = -pad;
      const my = -pad;
      const mw = Math.ceil(w + pad * 2);
      const mh = Math.ceil(h + pad * 2);
      outline = (
        <Fragment key={`stroke_outline_${el.id}`}>
          <clipPath id={`clip_stroke_in_${el.id}`}>
            <path d={pathD} />
          </clipPath>
          <mask id={`mask_stroke_out_${el.id}`} maskUnits="userSpaceOnUse" x={mx} y={my} width={mw} height={mh}>
            <rect x={mx} y={my} width={mw} height={mh} fill={CANVAS_MASK_KEEP} />
            <path d={pathD} fill={CANVAS_MASK_CUT} />
          </mask>
        </Fragment>
      );
    }
  }

  return (
    <>
      {clip ? (
        <clipPath key={`clip_${el.id}`} id={`clip_${el.id}`} clipPathUnits="userSpaceOnUse">
          <path d={clipPathD} />
        </clipPath>
      ) : null}

      {edgeEffects.length > 0
        ? edgeClipDefs(el, edgeEffects as TearEffect[], box ? box.width : el.width, box ? box.height : el.height)
        : null}

      {/* A mask's alpha adapter has to be defined before it is referenced, so
          both go out together. A mask that is pure geometry goes out as a
          `clipPath` instead — see `maskIsClip` — because a `<mask>` ancestor is a
          backdrop root and would blank the backdrop blur of every layer it
          covers. */}
      {el.isMask
        ? (() => {
            const maskClip = maskClipDef(el, box);
            if (maskClip) return <Fragment key={`mask_${el.id}`}>{maskClip}</Fragment>;
            return (
              <Fragment key={`mask_${el.id}`}>
                {maskAlphaFilterDef(el, box)}
                {maskLayerDef(el, { box, fills })}
              </Fragment>
            );
          })()
        : null}

      {gradients.length > 0 || imageTiles.length > 0 || patternTiles.length > 0 || paintFilters.length > 0 ? (
        <Fragment key={`fill_defs_${el.id}`}>
          {gradients}
          {imageTiles}
          {patternTiles}
          {paintFilters}
        </Fragment>
      ) : null}

      {strokeTiles.length > 0 || strokeGradients.length > 0 || outline ? (
        <Fragment key={`stroke_defs_${el.id}`}>
          {strokeTiles}
          {strokeGradients}
          {outline}
        </Fragment>
      ) : null}

      {/* Filter effects ride the element <filter>; see `renderEffectFilterDef`. */}
      {renderEffectFilterDef(el, box, pixelScale)}

      {/* Liquid Glass edge lensing; see `renderLiquidGlassDef`. */}
      {renderLiquidGlassDef(el, box, viewScale)}

      {/* Render target paths for Text on Path, looping for closed shapes */}
      {guide && guideTarget ? (
        <path
          key={`guide_${el.id}`}
          id={`guide_path_${el.id}`}
          d={guide.d}
          transform={`translate(${guideTarget.x}, ${guideTarget.y})`}
        />
      ) : null}
    </>
  );
}

/**
 * One element's defs, kept across renders when nothing about them changed.
 *
 * Exported alongside `renderElementDefs` because a def tree has two audiences: a
 * browser, which wants the memo, and a test, which wants the markup and cannot
 * see through a component boundary.
 */
export const ElementDefs = memo(renderElementDefs, (prev, next) =>
  prev.el === next.el &&
  prev.viewScale === next.viewScale &&
  prev.pixelScale === next.pixelScale &&
  prev.assets === next.assets &&
  prev.master === next.master &&
  prev.guide === next.guide &&
  prev.guideTarget === next.guideTarget
);
