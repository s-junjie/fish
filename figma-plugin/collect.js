/**
 * Figma plugin node → the shape of `GET /v1/files/:key?geometry=paths`.
 *
 * THIS FILE IS A TRANSPORT, NOT A MAPPING. Every rule that turns a Figma node
 * into a DSL element lives in `src/core/import/figma-*.ts`, and this file is
 * forbidden from growing one: no colour conversion, no gradient angle, no
 * coordinate arithmetic, no layout interpretation. What it does is rename keys,
 * rename `data` to `path`, and drop what the plugin API cannot read — so that the
 * app has exactly one answer to "what does this Figma node become", whichever
 * door the bytes came through. `docs/FIGMA_IMPORT_PLAN.md` §0.
 *
 * WHY A SHIM AT ALL: the alternative is a second importer, and this repository has
 * already paid for that once — two copies of the gradient mapping, ninety degrees
 * apart (`docs/LESSONS_LEARNED.md` §142).
 *
 * IT IS A PLAIN SCRIPT, NOT A MODULE. Figma's sandbox evaluates `main` as a
 * classic script with no `import`/`export` and no module loader, and the plugin
 * has no build step, so the file is loaded verbatim. `tests/figma-plugin-collect
 * .test.ts` evaluates it in a `vm` context for the same reason and fails if that
 * ever stops being true — which is why the CommonJS guard at the bottom is
 * allowed to exist at all.
 */

var FISH_EXPORT_FORMAT = "fish.figma.export";
var FISH_EXPORT_VERSION = 1;

/**
 * The app cannot ask the plugin what it could not read, so the plugin says which
 * node TYPES it lost something on and the app turns that into gaps. Kept to facts
 * about the API's reach rather than judgements about the design — deciding that a
 * gap matters is the app's job, and this file does not make that call.
 */
var UNREADABLE_BY_TYPE = {
  FRAME: ["preserveRatio"],
  COMPONENT: ["preserveRatio"],
  COMPONENT_SET: ["preserveRatio"],
  INSTANCE: ["preserveRatio"]
};

/** A property whose value `figma.mixed` reports when runs disagree. */
function isMixed(value) {
  return value === figma.mixed || typeof value === "symbol";
}

/**
 * Copy `value` onto `out` only when it is worth carrying.
 *
 * Figma sends most of these fields on every node whether or not the designer
 * touched them, and the app's mapper reads absence as "the default". Emitting a
 * field the mapper does not understand is harmless; emitting a WRONG one is not,
 * so anything unreadable is dropped rather than guessed at.
 */
function put(out, key, value) {
  if (value === undefined || value === null) return out;
  if (typeof value === "symbol") return out;
  out[key] = value;
  return out;
}

function round(n) {
  return Math.round(n * 100) / 100;
}

function allEqual(values) {
  for (var i = 1; i < values.length; i++) {
    if (values[i] !== values[0]) return false;
  }
  return true;
}

/**
 * Node types the two APIs spell differently.
 *
 * The plugin calls a regular polygon `POLYGON` and REST calls it
 * `REGULAR_POLYGON`, and this is the one node type the app matches by name: the
 * plugin's `POLYGON` reached the app's switch unmatched, fell through to the
 * unknown-type branch and was dropped along with its whole page. Renaming it
 * here is the same kind of rename as `data` → `path` — it keeps the switch on
 * REST's spelling so there is one answer to "what does this node become"
 * whichever door the bytes came through.
 */
var NODE_TYPES = {
  POLYGON: "REGULAR_POLYGON"
};

// ---------------------------------------------------------------------------
// Paint
// ---------------------------------------------------------------------------

/**
 * One plugin paint → one REST paint.
 *
 * `imageHash` is renamed to `imageRef` and nothing else changes: same types, same
 * stops, same 0..1 colour floats, same bottom-first order.
 *
 * `imageTransform` DOES survive, and is the CROP framing itself: the matrix that
 * says which part of the image the layer shows. It used to be dropped here
 * because the app's mapper did not read it, and the price was every cropped image
 * in every export arriving as a plain cover; the two doors are kept in step by
 * carrying what the mapper reads, not by withholding it.
 *
 * `rotation` survives for the other half of the same idea: it is where a FILL or
 * FIT bitmap's own quarter turn lives — `imageTransform` is documented as
 * CROP-only, and `rotation` as the FILL/FIT/TILE spelling. Dropping it handed the
 * app a bitmap square to its box, which is why a photograph the designer turned
 * upright arrived a quarter turn out.
 */
function collectPaint(paint) {
  if (!paint || typeof paint !== "object") return null;
  if (isMixed(paint)) return null;

  var out = { type: paint.type };
  put(out, "visible", paint.visible);
  put(out, "opacity", paint.opacity);
  put(out, "blendMode", paint.blendMode);
  put(out, "color", paint.color);

  if (paint.type === "IMAGE") {
    put(out, "imageRef", paint.imageHash);
    put(out, "scaleMode", paint.scaleMode);
    put(out, "rotation", paint.rotation);
    put(out, "imageTransform", paint.imageTransform);
    // `filters` is the photo-adjustment set (exposure/contrast/saturation/
    // temperature/tint/highlights/shadows). It is spelled the same on both APIs
    // and REST calls it `filters` too, so it crosses unchanged.
    if (paint.filters && typeof paint.filters === "object") out.filters = paint.filters;
    return out.imageRef ? out : null;
  }

  if (paint.type === "VIDEO") {
    // A video fill crosses WHOLE — `videoHash` renamed, `scaleMode` / `rotation` /
    // `filters` beside it — and no bytes come with it, because the API publishes
    // the hash and no way to read behind it: there is no `getVideoByHash`, only
    // `figma.createVideoAsync` in the other direction. So the paint is carried
    // for what it SAYS (this layer is a clip, and here is its hash) rather than
    // dropped here, where the app would report a bare "VIDEO" with no account of
    // it. `unreadable.videoBytes` is the count that goes with this.
    put(out, "videoRef", paint.videoHash);
    put(out, "scaleMode", paint.scaleMode);
    put(out, "rotation", paint.rotation);
    if (paint.filters && typeof paint.filters === "object") out.filters = paint.filters;
    return out;
  }

  if (typeof paint.type === "string" && paint.type.indexOf("GRADIENT_") === 0) {
    put(out, "gradientStops", paint.gradientStops);
    put(out, "gradientTransform", paint.gradientTransform);
    return out;
  }

  return out;
}

function collectPaints(paints) {
  if (!Array.isArray(paints) || isMixed(paints)) return undefined;
  var out = [];
  for (var i = 0; i < paints.length; i++) {
    var paint = collectPaint(paints[i]);
    if (paint) out.push(paint);
  }
  return out.length > 0 ? out : undefined;
}

/**
 * The four per-side stroke weights, or nothing.
 *
 * REST sends `individualStrokeWeights` only when the designer set the sides
 * individually; the plugin API has four separate numbers that are ALWAYS present.
 * Passing them through unconditionally would put every ordinary uniformly-bordered
 * box onto the app's mixed-weight stroke path — `mapFigmaStroke` calls that out by
 * name, and the symptom is a heavier border on every rectangle in the file. So the
 * "all four equal" case is dropped here, which is exactly the case REST omits.
 */
function collectIndividualStrokeWeights(node) {
  var sides = ["strokeTopWeight", "strokeRightWeight", "strokeBottomWeight", "strokeLeftWeight"];
  var weights = [];
  for (var i = 0; i < sides.length; i++) {
    var w = node[sides[i]];
    if (typeof w !== "number") return undefined;
    weights.push(w);
  }
  var distinct = {};
  for (var j = 0; j < weights.length; j++) distinct[weights[j]] = true;
  if (Object.keys(distinct).length <= 1) return undefined;
  return { top: weights[0], right: weights[1], bottom: weights[2], left: weights[3] };
}

/**
 * The four corner radii as REST's one array, or nothing when they agree.
 *
 * The plugin keeps them as four numbers named per corner and REST keeps them as
 * `rectangleCornerRadii: [TL, TR, BR, BL]`, in that order. Same suppression rule
 * as the stroke weights above, and the same reason: the all-equal case is
 * exactly the one REST omits.
 */
function collectCornerRadii(node) {
  var sides = ["topLeftRadius", "topRightRadius", "bottomRightRadius", "bottomLeftRadius"];
  var radii = [];
  for (var i = 0; i < sides.length; i++) {
    var r = node[sides[i]];
    if (typeof r !== "number") return undefined;
    radii.push(r);
  }
  return allEqual(radii) ? undefined : radii;
}

/**
 * The per-effect fields that are not shadows and blurs.
 *
 * `GLASS` is here because it is the one effect kind whose whole identity is a
 * parameter set: copy only `type` and the shim has decided the designer's glass
 * is made of defaults, which imports as a plausible-looking plate that is not
 * the designer's. REST does not publish glass at all yet, so this is the only
 * door it can arrive through.
 */
var EFFECT_FIELDS = [
  "lightIntensity",
  "lightAngle",
  "refraction",
  "depth",
  "dispersion",
  "splay",
  "noiseSizeVector",
  "clipToShape"
];

function collectEffects(effects) {
  if (!Array.isArray(effects) || isMixed(effects)) return undefined;
  var out = [];
  for (var i = 0; i < effects.length; i++) {
    var e = effects[i];
    if (!e || typeof e !== "object") continue;
    var mapped = { type: e.type };
    put(mapped, "visible", e.visible);
    put(mapped, "blendMode", e.blendMode);
    put(mapped, "color", e.color);
    put(mapped, "radius", e.radius);
    put(mapped, "spread", e.spread);
    if (e.offset) mapped.offset = { x: e.offset.x, y: e.offset.y };
    for (var f = 0; f < EFFECT_FIELDS.length; f++) put(mapped, EFFECT_FIELDS[f], e[EFFECT_FIELDS[f]]);
    out.push(mapped);
  }
  return out.length > 0 ? out : undefined;
}

function collectVectorPaths(paths) {
  if (!Array.isArray(paths)) return undefined;
  var out = [];
  for (var i = 0; i < paths.length; i++) {
    var p = paths[i];
    // `data` is the plugin's name for what REST calls `path`. This is the single
    // rename in the file that loses geometry outright when it is wrong: the app
    // reads `fillGeometry[0].path`, finds nothing, and imports a blank shape.
    if (p && typeof p.data === "string") out.push({ path: p.data, windingRule: p.windingRule });
  }
  return out.length > 0 ? out : undefined;
}

/**
 * One grid track → `{ type, value }`, or null when it cannot cross.
 *
 * A track's `type` is `FLEX` / `FIXED` / `HUG` and `value` is only meaningful
 * for `FIXED`. `figma.mixed` is a symbol and `JSON.stringify` would turn it into
 * `{}`, so a mixed track is DROPPED rather than emitted — the app then sees a
 * shorter track list than Figma has, which it handles the same way it handles any
 * other short list (the whole list fails `resolveTracks` and the measured px are
 * written instead). Emitting a wrong track is the one failure the app cannot
 * detect, so nothing here is guessed.
 */
/**
 * One variable alias, or null.
 *
 * Kept to the two members the app reads — Figma's own object carries more, and
 * `valuesByMode` on the variable it points at says everything else. A property
 * whose runs disagree is `figma.mixed`, a symbol, and a symbol stringifies to
 * `null`, so it is dropped here rather than shipped as a binding to nothing.
 */
function collectAlias(value) {
  if (!value || typeof value !== "object" || typeof value.id !== "string") return null;
  return { type: "VARIABLE_ALIAS", id: value.id };
}

/**
 * A node's variable bindings, verbatim in Figma's own shape.
 *
 * Not a mapping: an alias names a variable and the app is the side that decides
 * which FISH token that becomes — and what a binding to a variable this export
 * does not carry means. A scalar property holds one alias and a paint channel
 * (`fills` / `strokes` / `effects`) holds an array of them, indexed by paint,
 * which is the only thing the app needs to line the two up.
 */
function collectBoundVariables(node) {
  var raw = node.boundVariables;
  if (!raw || typeof raw !== "object") return undefined;
  var out = {};
  var kept = 0;
  for (var key in raw) {
    if (Array.isArray(raw[key])) {
      // Positions are KEPT, null and all: an alias list is indexed by paint, so
      // compacting it would slide every binding after an unbound layer onto the
      // wrong one — a card whose second fill is bound would bind its first.
      var list = [];
      var any = false;
      for (var i = 0; i < raw[key].length; i++) {
        var alias = collectAlias(raw[key][i]);
        if (alias) any = true;
        list.push(alias);
      }
      if (!any) continue;
      out[key] = list;
      kept += 1;
      continue;
    }
    var single = collectAlias(raw[key]);
    if (!single) continue;
    out[key] = single;
    kept += 1;
  }
  return kept > 0 ? out : undefined;
}

function collectGridTrack(track) {
  if (!track || typeof track !== "object") return null;
  if (isMixed(track.type)) return null;
  if (track.type !== "FLEX" && track.type !== "FIXED" && track.type !== "HUG") return null;
  var out = { type: track.type };
  put(out, "value", track.value);
  return out;
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

/** `lineHeight` is `{unit, value}` in the plugin API and two flat fields in REST. */
function collectLineHeight(style) {
  if (!style || !style.lineHeight || isMixed(style.lineHeight)) return {};
  var out = {};
  if (style.lineHeight.unit === "PIXELS") out.lineHeightPx = round(style.lineHeight.value);
  else if (style.lineHeight.unit === "PERCENT") out.lineHeightPercent = round(style.lineHeight.value);
  return out;
}

/**
 * `letterSpacing` is `{unit, value}` here and a px number in REST.
 *
 * PERCENT is relative to the font size, so it cannot be carried as a raw number:
 * emitting the percentage would letter-space a 13px label by 50px. REST's own
 * responses store the resolved pixel value, which is what the DSL stores too.
 */
function collectLetterSpacing(style) {
  if (!style || !style.letterSpacing || isMixed(style.letterSpacing)) return undefined;
  if (style.letterSpacing.unit === "PIXELS") return round(style.letterSpacing.value);
  if (style.letterSpacing.unit === "PERCENT" && typeof style.fontSize === "number") {
    return round((style.fontSize * style.letterSpacing.value) / 100);
  }
  return undefined;
}

var FONT_STYLE_ITALIC = /italic|oblique/i;

/**
 * A plugin text property bag → a REST `TypeStyle`.
 *
 * `fontName.style` is where the plugin keeps the weight AND the slant as prose
 * ("Bold", "Semi Bold Italic"); REST splits them into `fontWeight` and `italic`.
 * The numeric `fontWeight` is preferred when the node carries one, because
 * parsing "Semi Bold" into 600 is a guess the app would then have to reproduce.
 */
function collectTypeStyle(props) {
  if (!props) return undefined;
  var out = {};
  var name = props.fontName;
  if (name && !isMixed(name)) {
    put(out, "fontFamily", name.family);
    put(out, "fontPostScriptName", name.postScriptName);
    if (FONT_STYLE_ITALIC.test(name.style || "")) out.italic = true;
  }
  if (typeof props.fontWeight === "number" && !isMixed(props.fontWeight)) out.fontWeight = props.fontWeight;
  else if (name && !isMixed(name) && /bold/i.test(name.style || "")) out.fontWeight = 700;
  put(out, "fontSize", props.fontSize);
  var spacing = collectLetterSpacing(props);
  if (spacing !== undefined) out.letterSpacing = spacing;
  var merged = collectLineHeight(props);
  for (var key in merged) out[key] = merged[key];
  put(out, "textAlignHorizontal", props.textAlignHorizontal);
  put(out, "textAlignVertical", props.textAlignVertical);
  put(out, "textCase", props.textCase);
  put(out, "textDecoration", props.textDecoration);
  return out;
}

/**
 * One published style, WITH its values.
 *
 * REST's `file.styles` is only a directory — `{ key, name, styleType }` per id —
 * because on that door the values live on the layers that use them. A style
 * without values cannot become a FISH style without inventing them, so this is
 * the door that makes style import possible at all.
 *
 * A style's own colour can be bound to a variable — that is what makes a colour
 * style follow a semantic token — and for a style the binding exists only ON the
 * paint, never on the style. So it travels there.
 */
var STYLE_TYPES = { PAINT: "PAINT", FILL: "PAINT", TEXT: "TEXT", EFFECT: "EFFECT", GRID: "GRID" };

function collectStyleDef(style) {
  if (!style || typeof style.id !== "string") return null;
  var type = STYLE_TYPES[String(style.type || style.styleType || "")];
  if (!type) return null;

  var out = { id: style.id, styleType: type };
  put(out, "key", style.key);
  put(out, "name", style.name);
  if (style.remote === true) out.remote = true;

  if (type === "PAINT") {
    var paints = collectStylePaints(style.paints);
    if (paints) out.paints = paints;
  } else if (type === "EFFECT") {
    var effects = collectStyleEffects(style.effects);
    if (effects) out.effects = effects;
  } else if (type === "TEXT") {
    var typeStyle = collectTypeStyle(style);
    if (typeStyle) {
      for (var key in typeStyle) out[key] = typeStyle[key];
    }
    // A text style publishes its ink as `fills`, the same channel a text node
    // uses — which is why the app's text mapper can read both unchanged.
    var ink = collectStylePaints(style.fills);
    if (ink) out.fills = ink;
  }

  // Style-level bindings: a text style's `fontSize` is the one that exists.
  var bound = collectBoundVariables(style);
  if (bound) out.boundVariables = bound;
  return out;
}

function collectStyles(styles) {
  if (!Array.isArray(styles)) return undefined;
  var out = [];
  for (var i = 0; i < styles.length; i++) {
    var def = collectStyleDef(styles[i]);
    if (def) out.push(def);
  }
  return out.length > 0 ? out : undefined;
}

function collectStylePaints(paints) {
  if (!Array.isArray(paints) || isMixed(paints)) return undefined;
  var out = [];
  for (var i = 0; i < paints.length; i++) {
    var paint = collectPaint(paints[i]);
    if (!paint) continue;
    var bound = paints[i] && paints[i].boundVariables;
    var alias = bound && bound.color ? collectAlias(bound.color) : null;
    if (alias) paint.boundVariables = { color: alias };
    out.push(paint);
  }
  return out.length > 0 ? out : undefined;
}

var EFFECT_TOKEN_FIELDS = ["radius", "spread"];

/** `collectEffects` keeps hidden effects, so its indexes still line up. */
function collectStyleEffects(effects) {
  var out = collectEffects(effects);
  if (!out) return undefined;
  for (var i = 0; i < out.length; i++) {
    var bound = effects[i] && effects[i].boundVariables;
    if (!bound) continue;
    var aliases = {};
    var color = collectAlias(bound.color);
    if (color) aliases.color = color;
    for (var k = 0; k < EFFECT_TOKEN_FIELDS.length; k++) {
      var alias = collectAlias(bound[EFFECT_TOKEN_FIELDS[k]]);
      if (alias) aliases[EFFECT_TOKEN_FIELDS[k]] = alias;
    }
    if (Object.keys(aliases).length > 0) out[i].boundVariables = aliases;
  }
  return out;
}

/**
 * The styles a node points at, one id per channel.
 *
 * The plugin keeps these as five flat `…StyleId` fields; REST keeps them in one
 * `styles` object. Renaming them here is what lets the app read one shape.
 */
var STYLE_CHANNELS = [
  ["fill", "fillStyleId"],
  ["stroke", "strokeStyleId"],
  ["text", "textStyleId"],
  ["effect", "effectStyleId"],
  ["grid", "gridStyleId"]
];

function collectStyleChannels(node) {
  var out = null;
  for (var i = 0; i < STYLE_CHANNELS.length; i++) {
    var id = node[STYLE_CHANNELS[i][1]];
    if (typeof id !== "string" || !id) continue;
    out = out || {};
    out[STYLE_CHANNELS[i][0]] = id;
  }
  return out;
}

/** The fields a per-run override may carry, matching what the app reads back. */var SEGMENT_FIELDS = [
  "fontName",
  "fontWeight",
  "fontSize",
  "letterSpacing",
  "lineHeight",
  "textAlignHorizontal",
  "textAlignVertical",
  "textCase",
  "textDecoration"
];

function sameStyle(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Per-run styling → REST's `characterStyleOverrides` + `styleOverrideTable`.
 *
 * REST's array has ONE ENTRY PER CHARACTER, where `0` means "same as the node's
 * own style" and any other value is a key into the table. The plugin reports RUNS,
 * so the array is expanded here — one entry per character — or the app's run
 * splitter would read the run indexes as character offsets and land every span in
 * the wrong place.
 */
function collectTextOverrides(textNode, nodeStyle) {
  if (typeof textNode.getStyledTextSegments !== "function") return {};
  var segments;
  try {
    segments = textNode.getStyledTextSegments(SEGMENT_FIELDS) || [];
  } catch (err) {
    return {};
  }
  if (segments.length <= 1) return {};

  var characters = textNode.characters || "";
  var table = {};
  var overrides = [];
  for (var i = 0; i < characters.length; i++) overrides.push(0);

  for (var s = 0; s < segments.length; s++) {
    var segment = segments[s];
    var style = collectTypeStyle(segment);
    if (!style || sameStyle(style, nodeStyle)) continue;
    var key = null;
    for (var existing in table) {
      if (sameStyle(table[existing], style)) {
        key = Number(existing);
        break;
      }
    }
    if (key === null) {
      key = Object.keys(table).length + 1;
      table[key] = style;
    }
    for (var c = segment.start; c < segment.end && c < overrides.length; c++) overrides[c] = key;
  }

  if (Object.keys(table).length === 0) return {};
  return { characterStyleOverrides: overrides, styleOverrideTable: table };
}

// ---------------------------------------------------------------------------
// Node
// ---------------------------------------------------------------------------

/**
 * One plugin `SceneNode` → one REST-shaped node.
 *
 * Pure and synchronous: every plugin value it cannot read synchronously — an
 * instance's main component — is passed in through `ctx.componentIds`, which
 * `code.js` resolves with `getMainComponentAsync()` before the walk. That split is
 * what lets this file run under `vm` in a test with no Figma at all.
 */
function collectNode(node, ctx) {
  if (!node || typeof node !== "object") return null;
  var options = ctx || {};

  var out = { id: node.id, type: NODE_TYPES[node.type] || node.type };
  put(out, "name", node.name);
  put(out, "visible", node.visible);
  put(out, "opacity", node.opacity);
  put(out, "blendMode", node.blendMode);

  // `absoluteBoundingBox` is the bound of the shape AFTER rotation on both APIs,
  // which is why the app pairs it with the node's own size before drawing a
  // rotated leaf. `width`/`height` are that own size, and REST spells it `size`.
  var box = node.absoluteBoundingBox;
  if (box) {
    out.absoluteBoundingBox = { x: box.x, y: box.y, width: box.width, height: box.height };
    out.size = { x: node.width, y: node.height };
  }

  // Degrees on both APIs, -180..180 here. No conversion, and none wanted: this
  // is the field a future reader is most likely to "fix" into radians.
  put(out, "rotation", node.rotation);
  put(out, "relativeTransform", node.relativeTransform);

  if (node.constraints) {
    out.constraints = { horizontal: node.constraints.horizontal, vertical: node.constraints.vertical };
  }
  put(out, "isMask", node.isMask);
  put(out, "maskType", node.maskType);
  put(out, "clipsContent", node.clipsContent);

  // A slide's transition lives on a METHOD, and on a SLIDE only — asking anything
  // else, or asking in Figma Design where the method does not exist, is a
  // TypeError rather than an absent value. Carried VERBATIM, under Figma's own
  // field names, because REST has no spelling for this and inventing one here
  // would be a mapping, which is the app's job (`figma-slide.ts`).
  //
  // Only when the slide says something: `NONE` + `ON_CLICK` is Figma's default,
  // and a deck that sets no transitions has to keep serializing as it did.
  if (node.type === "SLIDE" && typeof node.getSlideTransition === "function") {
    try {
      var transition = node.getSlideTransition();
      var styled = transition && transition.style && transition.style !== "NONE";
      var timed = transition && transition.timing && transition.timing.type === "AFTER_DELAY";
      if (styled || timed) out.slideTransition = transition;
    } catch (err) {
      // One unreadable transition must not cost the other two hundred slides.
    }
  }

  var fills = collectPaints(node.fills);
  if (fills) out.fills = fills;
  var strokes = collectPaints(node.strokes);
  if (strokes) out.strokes = strokes;
  put(out, "strokeWeight", node.strokeWeight);
  put(out, "strokeAlign", node.strokeAlign);
  put(out, "strokeCap", node.strokeCap);
  put(out, "strokeJoin", node.strokeJoin);
  // The plugin spells this `dashPattern` and REST spells it `strokeDashes`;
  // the numbers are the same list of alternating dash and gap lengths. Reading
  // REST's name off the plugin found nothing, so a dashed stroke imported solid.
  var dashes = Array.isArray(node.dashPattern) ? node.dashPattern : node.strokeDashes;
  if (Array.isArray(dashes) && dashes.length > 0) out.strokeDashes = dashes;
  var individual = collectIndividualStrokeWeights(node);
  if (individual) out.individualStrokeWeights = individual;

  var effects = collectEffects(node.effects);
  if (effects) out.effects = effects;

  // Same asymmetry as the stroke weights: the plugin reports four corner radii
  // unconditionally, under four separate NAMES, and REST sends
  // `rectangleCornerRadii` only where the corners disagree. Emitting
  // `[12,12,12,12]` where REST sends `12` would give every rounded box in the
  // file a four-value radius the app then treats as a custom-corner shape
  // rather than a plain one. There is no `rectangleCornerRadii` on the plugin
  // node at all — reading it there is what made four independently set corners
  // import as one flat radius.
  var radius = collectCornerRadii(node);
  if (radius) out.rectangleCornerRadii = radius;
  else if (typeof node.cornerRadius === "number" && !isMixed(node.cornerRadius)) {
    out.cornerRadius = node.cornerRadius;
  }
  put(out, "cornerSmoothing", node.cornerSmoothing);

  var fillGeometry = collectVectorPaths(node.fillGeometry);
  if (fillGeometry) out.fillGeometry = fillGeometry;
  var strokeGeometry = collectVectorPaths(node.strokeGeometry);
  if (strokeGeometry) out.strokeGeometry = strokeGeometry;
  put(out, "fillWeight", node.fillWeight);

  if (node.type === "TEXT") {
    out.characters = node.characters || "";
    var style = collectTypeStyle(node);
    if (style) out.style = style;
    put(out, "textAutoResize", node.textAutoResize);
    put(out, "textTruncation", node.textTruncation);
    put(out, "maxLines", node.maxLines);
    var overrides = collectTextOverrides(node, style);
    if (overrides.characterStyleOverrides) out.characterStyleOverrides = overrides.characterStyleOverrides;
    if (overrides.styleOverrideTable) out.styleOverrideTable = overrides.styleOverrideTable;
  }

  if (node.layoutMode && node.layoutMode !== "NONE") {
    out.layoutMode = node.layoutMode;
    put(out, "itemSpacing", node.itemSpacing);
    put(out, "counterAxisSpacing", node.counterAxisSpacing);
    put(out, "paddingTop", node.paddingTop);
    put(out, "paddingRight", node.paddingRight);
    put(out, "paddingBottom", node.paddingBottom);
    put(out, "paddingLeft", node.paddingLeft);
    put(out, "primaryAxisAlignItems", node.primaryAxisAlignItems);
    put(out, "counterAxisAlignItems", node.counterAxisAlignItems);
    put(out, "primaryAxisAlignContent", node.primaryAxisAlignContent);
    put(out, "primaryAxisSizingMode", node.primaryAxisSizingMode);
    put(out, "counterAxisSizingMode", node.counterAxisSizingMode);
    put(out, "layoutWrap", node.layoutWrap);
    // `INHERIT` is a plugin-only value with no REST counterpart; the app reads it
    // as "no alignment", so it is omitted rather than passed through as a key
    // that would silently mean something else there.
    if (node.layoutAlign && node.layoutAlign !== "INHERIT") out.layoutAlign = node.layoutAlign;
    put(out, "layoutGrow", node.layoutGrow);
    put(out, "layoutPositioning", node.layoutPositioning);
    put(out, "layoutSizingHorizontal", node.layoutSizingHorizontal);
    put(out, "layoutSizingVertical", node.layoutSizingVertical);
    put(out, "minWidth", node.minWidth);
    put(out, "maxWidth", node.maxWidth);
    put(out, "minHeight", node.minHeight);
    put(out, "maxHeight", node.maxHeight);
  }

  // GRID auto-layout. These are a THIRD mode, not a variant of the two above, and
  // they are read only on a grid frame: the properties live on Figma's
  // `GridLayoutMixin`, which a horizontal or vertical frame does not have, and
  // reading one there is a throw rather than a default. `put` still guards each
  // one, because a `figma.mixed` reads as a symbol.
  //
  // Every field here has the SAME NAME on both APIs (`GridLayoutMixin` in the
  // plugin typings, `TypeLayoutGrid` in the REST OpenAPI) except the per-track
  // sizing: REST publishes `gridColumnsSizing` / `gridRowsSizing` as CSS
  // strings and does not carry the structured form at all, so `gridRowSizes` /
  // `gridColumnSizes` are this door's OWN addition and are passed through
  // verbatim rather than renamed. The app reads either.
  if (node.layoutMode === "GRID") {
    put(out, "gridRowCount", node.gridRowCount);
    put(out, "gridColumnCount", node.gridColumnCount);
    put(out, "gridRowGap", node.gridRowGap);
    put(out, "gridColumnGap", node.gridColumnGap);
    put(out, "gridAutoTracks", node.gridAutoTracks);
    put(out, "gridItemsPositioning", node.gridItemsPositioning);
    if (Array.isArray(node.gridRowSizes) && node.gridRowSizes.length > 0) {
      out.gridRowSizes = node.gridRowSizes.map(collectGridTrack).filter(Boolean);
    }
    if (Array.isArray(node.gridColumnSizes) && node.gridColumnSizes.length > 0) {
      out.gridColumnSizes = node.gridColumnSizes.map(collectGridTrack).filter(Boolean);
    }
    if (!out.gridRowSizes) delete out.gridRowSizes;
    if (!out.gridColumnSizes) delete out.gridColumnSizes;
  }

  // A grid child's own cell: anchors are 0-based on BOTH APIs and the app
  // re-bases them, so they cross unchanged — the same as `rotation` and
  // `absoluteBoundingBox`, which are also identical and equally un-normalised.
  put(out, "gridChildHorizontalAlign", node.gridChildHorizontalAlign);
  put(out, "gridChildVerticalAlign", node.gridChildVerticalAlign);
  put(out, "gridColumnSpan", node.gridColumnSpan);
  put(out, "gridRowSpan", node.gridRowSpan);
  put(out, "gridColumnAnchorIndex", node.gridColumnAnchorIndex);
  put(out, "gridRowAnchorIndex", node.gridRowAnchorIndex);

  if (node.type === "INSTANCE") {
    var componentId = (options.componentIds || {})[node.id];
    if (componentId) out.componentId = componentId;
  }

  // Last, so a binding is carried for exactly the fields that crossed: a fill
  // the mapper dropped is a paint index it will never ask about.
  var bound = collectBoundVariables(node);
  if (bound) out.boundVariables = bound;

  var styles = collectStyleChannels(node);
  if (styles) out.styles = styles;

  if (Array.isArray(node.children) && node.children.length > 0) {
    var children = [];
    for (var i = 0; i < node.children.length; i++) {
      var child = collectNode(node.children[i], options);
      if (child) children.push(child);
    }
    if (children.length > 0) out.children = children;
  }

  return out;
}

/**
 * Wrap collected nodes in the `DOCUMENT` → `CANVAS` shell the app's page builder
 * expects — ONE CANVAS PER GROUP, because that is what a Figma file response is.
 *
 * The groups are Figma's own pages (`{ id, name, nodes, backgroundColor }`), and
 * they are passed in already resolved: a `PageNode` is not a thing the shim can
 * serialise, because it has no `absoluteBoundingBox` and therefore no box at all.
 * Handing one over produces a node the app drops along with everything under it —
 * an export that parses cleanly and imports as an empty document.
 *
 * Synthesising the shell here rather than teaching the app a second document shape
 * is what keeps `importFigmaFile` the only door: `buildFigmaPages` turns every
 * `CANVAS` under a `DOCUMENT` into a FISH page, so a five-page Figma file arrives
 * as five FISH pages with no special case anywhere.
 */
function buildExport(groups, meta) {
  var info = meta || {};
  var canvases = [];
  for (var g = 0; g < (groups || []).length; g++) {
    var group = groups[g] || {};
    var children = [];
    var nodes = group.nodes || [];
    for (var i = 0; i < nodes.length; i++) {
      var node = collectNode(nodes[i], info.ctx);
      if (node) children.push(node);
    }
    canvases.push({
      id: group.id || "fish:" + (g + 1),
      name: group.name || "Page " + (g + 1),
      type: "CANVAS",
      backgroundColor: group.backgroundColor,
      children: children
    });
  }

  var out = {
    format: FISH_EXPORT_FORMAT,
    version: FISH_EXPORT_VERSION,
    source: {
      plugin: "FISH Export",
      api: typeof figma !== "undefined" && figma.apiVersion ? figma.apiVersion : "1.0.0",
      scope: info.scope || "selection",
      exportedAt: info.exportedAt || null
    },
    document: {
      id: info.documentId || "fish:0",
      name: info.documentName || "Figma export",
      type: "DOCUMENT",
      children: canvases
    },
    images: info.images || {},
    unreadable: info.unreadable || {}
  };

  // The file's design system, beside the document rather than inside it: a
  // variable is a file-level thing a layer only points at, and putting it on
  // every node would be the same table repeated two thousand times.
  //
  // Verbatim, in Figma's own shape. Which mode a value belongs to is the
  // collection's business and which token a variable becomes is the app's, and
  // both are decided on the other side of this file.
  if (info.variables && info.variables.length > 0) out.variables = info.variables;
  if (info.variableCollections && info.variableCollections.length > 0) {
    out.variableCollections = info.variableCollections;
  }
  // Beside the document for the same reason the variables are: a style is a
  // file-level thing a layer only points at, and the full definitions are what
  // let the app build a style rather than guess one.
  var styleDefs = collectStyles(info.styles);
  if (styleDefs) out.styles = styleDefs;
  return out;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    FISH_EXPORT_FORMAT: FISH_EXPORT_FORMAT,
    FISH_EXPORT_VERSION: FISH_EXPORT_VERSION,
    UNREADABLE_BY_TYPE: UNREADABLE_BY_TYPE,
    collectNode: collectNode,
    collectPaint: collectPaint,
    collectPaints: collectPaints,
    collectEffects: collectEffects,
    collectIndividualStrokeWeights: collectIndividualStrokeWeights,
    collectCornerRadii: collectCornerRadii,
    collectVectorPaths: collectVectorPaths,
    collectGridTrack: collectGridTrack,
    collectAlias: collectAlias,
    collectBoundVariables: collectBoundVariables,
    collectStyleDef: collectStyleDef,
    collectStyles: collectStyles,
    collectTypeStyle: collectTypeStyle,
    collectLineHeight: collectLineHeight,
    collectLetterSpacing: collectLetterSpacing,
    collectTextOverrides: collectTextOverrides,
    buildExport: buildExport
  };
}
