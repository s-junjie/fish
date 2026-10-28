/**
 * The other half of the round trip: a REST node turned back into the object a
 * Figma plugin would hand the shim.
 *
 * Written from the PLUGIN API's shape — `width`/`height` instead of `size`,
 * `data` instead of `path`, `imageHash` instead of `imageRef`, `lineHeight` as a
 * unit/value pair, per-run text instead of a per-character override array — and
 * not from `collect.js`. An inverse derived from the thing it is inverting would
 * make the parity test a tautology; derived from the API, it fails the moment the
 * two disagree, which is the only reason it is here.
 */

/**
 * Loose on purpose. This is a stand-in for a foreign API's nodes, and the whole
 * point is that its fields are whatever that API happens to report — typing it
 * strictly would mean re-declaring the plugin API here, which is a third copy of
 * the same knowledge the shim and the inverse shim already disagree about.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = Record<string, any>;

/** `figma.mixed`, as a distinct value from every real one. */
export const MIXED: unique symbol = Symbol("figma.mixed") as never;

const isObject = (v: unknown): v is Any => Boolean(v) && typeof v === "object" && !Array.isArray(v);

/**
 * A paint as the plugin reports it.
 *
 * `boundVariables` is left on deliberately: the plugin always carries it, and a
 * shim that forgot to strip it would put Figma's internal variable bindings into
 * the export, where nothing downstream expects them.
 */
function toPluginPaint(paint: Any): Any {
  const out: Any = { type: paint.type, visible: paint.visible, opacity: paint.opacity, blendMode: paint.blendMode };
  out.color = paint.color;
  out.boundVariables = {};
  if (paint.type === "IMAGE") {
    out.imageHash = paint.imageRef;
    out.scaleMode = paint.scaleMode;
    out.filters = paint.filters;
    out.rotation = paint.rotation;
    out.imageTransform = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    return out;
  }
  if (typeof paint.type === "string" && paint.type.startsWith("GRADIENT_")) {
    out.gradientStops = paint.gradientStops;
    out.gradientTransform = paint.gradientTransform;
    return out;
  }
  return out;
}

const toPluginPaints = (paints: unknown): unknown[] | undefined =>
  Array.isArray(paints) ? paints.filter(isObject).map(toPluginPaint) : undefined;

/** `lineHeightPx` / `lineHeightPercent` → `{ unit, value }`. */
function toPluginLineHeight(style: Any): Any | undefined {
  if (typeof style.lineHeightPx === "number") return { unit: "PIXELS", value: style.lineHeightPx };
  if (typeof style.lineHeightPercent === "number") return { unit: "PERCENT", value: style.lineHeightPercent };
  return undefined;
}

/**
 * A REST `TypeStyle` → the plugin's flat property bag.
 *
 * `fontWeight` and `italic` are the two fields the plugin splits apart, and it
 * keeps the slant inside `fontName.style` as prose. Reproducing that split is the
 * point: a shim that read `style.fontWeight` off the plugin would get `undefined`
 * and every label would import at weight 400.
 */
function toPluginTextProps(style: Any): Any {
  const family = style.fontFamily ?? "Inter";
  const weight = typeof style.fontWeight === "number" ? style.fontWeight : 400;
  const italic = style.italic === true;
  return {
    fontName: { family, style: fontStyleName(weight, italic), postScriptName: style.fontPostScriptName },
    fontWeight: weight,
    fontSize: style.fontSize,
    lineHeight: toPluginLineHeight(style),
    letterSpacing: typeof style.letterSpacing === "number" ? { unit: "PIXELS", value: style.letterSpacing } : undefined,
    textAlignHorizontal: style.textAlignHorizontal,
    textAlignVertical: style.textAlignVertical,
    textCase: style.textCase,
    textDecoration: style.textDecoration
  };
}

/** The weight names the plugin reports, which are words rather than numbers. */
function fontStyleName(weight: number, italic: boolean): string {
  const base =
    weight >= 900 ? "Black" : weight >= 800 ? "Extra Bold" : weight >= 700 ? "Bold" : weight >= 600 ? "Semi Bold" : weight >= 500 ? "Medium" : weight >= 400 ? "Regular" : "Light";
  return italic ? `${base} Italic` : base;
}

/**
 * Rebuild the runs a REST per-character override array describes.
 *
 * The plugin reports runs and REST reports characters, so the array is collapsed
 * into maximal same-key spans. The shim has to expand them again; if it emitted
 * the run indexes directly, the app would read a run index as a character offset
 * and every span after the first would be wrong.
 */
function styleOf(props: Any): Any {
  return {
    fontFamily: props.fontName?.family,
    fontWeight: props.fontWeight,
    italic: /italic|oblique/i.test(props.fontName?.style ?? ""),
    fontSize: props.fontSize,
    lineHeightPx: props.lineHeight?.unit === "PIXELS" ? props.lineHeight.value : undefined,
    lineHeightPercent: props.lineHeight?.unit === "PERCENT" ? props.lineHeight.value : undefined,
    letterSpacing: props.letterSpacing?.unit === "PIXELS" ? props.letterSpacing.value : undefined,
    textAlignHorizontal: props.textAlignHorizontal,
    textAlignVertical: props.textAlignVertical,
    textCase: props.textCase,
    textDecoration: props.textDecoration
  };
}

function runsFromOverrides(characters: string, overrides: number[], table: Record<string, Any>, base: Any): Any[] {
  const runs: Any[] = [];
  let start = 0;
  for (let i = 0; i <= overrides.length; i++) {
    const key = i < overrides.length ? overrides[i] : null;
    if (i === overrides.length || key !== overrides[start]) {
      const override = key === 0 || key === null ? {} : (table[String(key)] ?? {});
      runs.push({ characters: characters.slice(start, i), start, end: i, ...base, ...toPluginTextProps({ ...styleOf(base), ...override }) });
      start = i;
    }
  }
  return runs;
}

function toPluginText(node: Any): Any {
  const style = isObject(node.style) ? node.style : {};
  const base = toPluginTextProps(style);
  const characters = typeof node.characters === "string" ? node.characters : "";
  const overrides = Array.isArray(node.characterStyleOverrides) ? node.characterStyleOverrides : [];
  const table = isObject(node.styleOverrideTable) ? (node.styleOverrideTable as Record<string, Any>) : {};

  const segments =
    overrides.length > 0 && Object.keys(table).length > 0 ? runsFromOverrides(characters, overrides, table, base) : [{ characters, start: 0, end: characters.length, ...base }];

  return {
    ...base,
    characters,
    textAutoResize: node.textAutoResize,
    // The plugin API carries truncation on the TEXT NODE, where REST keeps it in
    // `TypeStyle` beside the font. That placement difference is the rename the
    // shim has to make in the other direction, so it is modelled here rather than
    // copied: reading it off the REST node's own top level found nothing, and the
    // two doors then agreed about a truncated label by agreeing on nothing.
    textTruncation: style.textTruncation,
    maxLines: style.maxLines,
    getStyledTextSegments: () => segments
  };
}

/**
 * One REST node → the object `figma` would hand `collectNode`.
 *
 * The fields the plugin ALWAYS reports are reported here too, including the ones
 * REST only sends conditionally. That asymmetry is the whole risk: a uniform
 * one-pixel border reaches the shim as four equal stroke weights, and only the
 * shim knows REST would have sent nothing at all.
 */
export function toPluginNode(node: Any): Any {
  if (!isObject(node)) return node;
  // The plugin calls a regular polygon `POLYGON`; REST calls it
  // `REGULAR_POLYGON`. Spelling it the plugin's way here is the whole point of
  // this file — the shim has to be the thing that knows the difference.
  const out: Any = {
    id: node.id,
    name: node.name,
    type: node.type === "REGULAR_POLYGON" ? "POLYGON" : node.type,
    visible: node.visible,
    opacity: node.opacity,
    blendMode: node.blendMode
  };

  const box = node.absoluteBoundingBox;
  if (isObject(box)) {
    out.absoluteBoundingBox = { ...box };
    const size = isObject(node.size) ? node.size : box;
    out.width = size.x;
    out.height = size.y;
  }

  out.rotation = node.rotation ?? 0;
  out.relativeTransform = node.relativeTransform;
  out.constraints = node.constraints;
  out.isMask = node.isMask;
  out.maskType = node.maskType;
  out.clipsContent = node.clipsContent;

  const fills = toPluginPaints(node.fills);
  if (fills) out.fills = fills;
  const strokes = toPluginPaints(node.strokes);
  if (strokes) out.strokes = strokes;

  out.strokeWeight = node.strokeWeight;
  out.strokeAlign = node.strokeAlign;
  out.strokeCap = node.strokeCap;
  out.strokeJoin = node.strokeJoin;
  // `dashPattern`, not `strokeDashes`: the plugin's name for the same numbers.
  out.dashPattern = node.strokeDashes;

  // The plugin has four numbers where REST has an object it omits when the four
  // agree. A uniform border therefore arrives as `1,1,1,1` and the REST shape it
  // must become has no `individualStrokeWeights` key at all.
  const individual = isObject(node.individualStrokeWeights) ? node.individualStrokeWeights : null;
  const uniform = typeof node.strokeWeight === "number" ? node.strokeWeight : 1;
  out.strokeTopWeight = individual ? individual.top : uniform;
  out.strokeRightWeight = individual ? individual.right : uniform;
  out.strokeBottomWeight = individual ? individual.bottom : uniform;
  out.strokeLeftWeight = individual ? individual.left : uniform;

  if (Array.isArray(node.effects)) out.effects = node.effects;
  out.cornerRadius = node.cornerRadius ?? 0;
  // Four separate numbers, not REST's one array. The plugin API has no
  // `rectangleCornerRadii` at all — a helper that invented one made the shim's
  // wrong field name look right, and four independently set corners imported as
  // one flat radius for as long as the test agreed with the bug.
  const radii = Array.isArray(node.rectangleCornerRadii) ? node.rectangleCornerRadii : null;
  out.topLeftRadius = radii ? radii[0] : node.cornerRadius ?? 0;
  out.topRightRadius = radii ? radii[1] : node.cornerRadius ?? 0;
  out.bottomRightRadius = radii ? radii[2] : node.cornerRadius ?? 0;
  out.bottomLeftRadius = radii ? radii[3] : node.cornerRadius ?? 0;
  out.cornerSmoothing = node.cornerSmoothing ?? 0;

  if (Array.isArray(node.fillGeometry)) {
    out.fillGeometry = node.fillGeometry.map((p: Any) => ({ data: p.path, windingRule: p.windingRule }));
  }
  if (Array.isArray(node.strokeGeometry)) {
    out.strokeGeometry = node.strokeGeometry.map((p: Any) => ({ data: p.path, windingRule: p.windingRule }));
  }
  out.fillWeight = node.fillWeight;

  if (node.type === "TEXT") Object.assign(out, toPluginText(node));

  for (const key of [
    "layoutMode",
    "itemSpacing",
    "counterAxisSpacing",
    "paddingTop",
    "paddingRight",
    "paddingBottom",
    "paddingLeft",
    "primaryAxisAlignItems",
    "counterAxisAlignItems",
    "primaryAxisAlignContent",
    "primaryAxisSizingMode",
    "counterAxisSizingMode",
    "layoutWrap",
    "layoutAlign",
    "layoutGrow",
    "layoutPositioning",
    "layoutSizingHorizontal",
    "layoutSizingVertical",
    "minWidth",
    "maxWidth",
    "minHeight",
    "maxHeight"
  ]) {
    if (node[key] !== undefined) out[key] = node[key];
  }

  // GRID auto-layout. The counts, gaps and every per-child field have the SAME
  // name on both APIs (`GridLayoutMixin` / `AutoLayoutChildrenMixin` against
  // `TypeLayoutGrid`), so they cross in the shared list. Only the per-track
  // sizing differs, and it is the one that must be CONVERTED rather than copied:
  // REST spells it as the CSS string `gridColumnsSizing` and has no structured
  // form at all, where the plugin has a `GridTrackSize[]`. Copying the string
  // through would leave one door with data the other cannot have, and the parity
  // assertion below would be comparing a real value against nothing.
  //
  // The per-CHILD fields are read unconditionally: a grid child carries no
  // `layoutMode` of its own — it inherits being in a grid from its parent — so
  // gating them on `layoutMode === "GRID"` drops every one of them and the two
  // doors then agree only because the plugin door has nothing to disagree with.
  for (const key of [
    "gridChildHorizontalAlign",
    "gridChildVerticalAlign",
    "gridRowSpan",
    "gridColumnSpan",
    "gridRowAnchorIndex",
    "gridColumnAnchorIndex"
  ]) {
    if (node[key] !== undefined) out[key] = node[key];
  }
  if (node.layoutMode === "GRID") {
    for (const key of ["gridRowCount", "gridColumnCount", "gridRowGap", "gridColumnGap"]) {
      if (node[key] !== undefined) out[key] = node[key];
    }
    const rows = tracksFromCss(node.gridRowsSizing);
    const columns = tracksFromCss(node.gridColumnsSizing);
    if (rows) out.gridRowSizes = rows;
    if (columns) out.gridColumnSizes = columns;
  }

  if (Array.isArray(node.children)) out.children = node.children.map(toPluginNode);
  return out;
}

/**
 * A CSS track list → the plugin's `GridTrackSize[]`.
 *
 * The inverse of what a designer wrote, written FROM THE STRING rather than
 * from a parse of the app's own output: a round trip through the code under test
 * would agree with itself however wrong it was. A `FLEX` track's `value` is its
 * fractional WEIGHT (the typings call it "equivalent to the CSS `fr` unit"), so
 * `2fr` is `{ type: "FLEX", value: 2 }` and omitting the number would collapse a
 * 1:2 ratio into a 1:1 one. Anything else is dropped rather than guessed — an
 * unrepresentable track must not become a confident wrong one.
 */
function tracksFromCss(raw: unknown): Any[] | undefined {
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  const tracks: Any[] = [];
  for (const token of raw.trim().split(/\s+/)) {
    const px = /^(-?[\d.]+)px$/i.exec(token);
    const fr = /^(-?[\d.]+)fr$/i.exec(token);
    if (px) tracks.push({ type: "FIXED", value: Number(px[1]) });
    else if (fr) tracks.push({ type: "FLEX", value: Number(fr[1]) });
  }
  return tracks.length > 0 ? tracks : undefined;
}

/**
 * A whole file response as the plugin would report it.
 *
 * As GROUPS — one per `CANVAS`, each holding that page's content — because that is
 * what the plugin hands `buildExport`. The page's own id, name and backdrop travel
 * with it so the export's `CANVAS` is the `CANVAS` the REST response had, and the
 * golden diff can compare page for page.
 *
 * The page node itself is not among `nodes`, and that is the point: a `PageNode`
 * has no `absoluteBoundingBox`, so serialising one produces a boxless node the app
 * drops along with its whole subtree. A first export did exactly that and arrived
 * as a document with no layers at all.
 */
export function toPluginGroups(response: Any): { groups: Any[]; meta: Any } {
  const document = response.document as Any;
  const groups = (document.children as Any[]).map((canvas) => ({
    id: canvas.id,
    name: canvas.name,
    backgroundColor: canvas.backgroundColor,
    nodes: (canvas.children ?? []).map(toPluginNode)
  }));
  return {
    groups,
    meta: { documentId: document.id, documentName: document.name }
  };
}
