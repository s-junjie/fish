/**
 * Whether a paint's colour string names a colour at all.
 *
 * The value goes straight into an SVG `fill` / `stroke`, and SVG's answer to a
 * value it cannot parse is BLACK — not "no paint", not a console warning. A
 * typo therefore produces a solid black box that every downstream reader agrees
 * about: the paint type is legal, the document round-trips, `check` is clean,
 * and only a screenshot shows it. That is the one class of mistake this gate
 * exists to stop, and it is why the normalizer refuses the value by name
 * instead of storing it and hoping.
 *
 * It answers "is this a colour SPELLING", not "is this colour valid": a
 * well-formed `rgb(1 2)` with the wrong arity passes here and is refused by the
 * browser. Parsing every function's arguments is a different job, done by
 * `geometry/css-color-space`, and duplicating it here would create the second
 * opinion this file is trying to avoid.
 */

/** CSS-wide keywords and the two spellings that mean "no paint here". */
const KEYWORDS: ReadonlySet<string> = new Set([
  "transparent",
  "currentcolor",
  "none",
  "inherit",
  "initial",
  "unset",
  "revert",
  "revert-layer"
]);

const COLOR_FUNCTIONS: ReadonlySet<string> = new Set([
  "rgb",
  "rgba",
  "hsl",
  "hsla",
  "hwb",
  "lab",
  "lch",
  "oklab",
  "oklch",
  "color",
  "color-mix",
  "light-dark",
  "device-cmyk"
]);

/**
 * CSS's 148 named colours. A table rather than a shape rule, because "any word
 * is a colour" is exactly the assumption that let `fills: ["#FFF → #000"]`
 * through: it looks like an identifier and paints black.
 */
const NAMED: ReadonlySet<string> = new Set(
  (
    "aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown " +
    "burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan " +
    "darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid " +
    "darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet " +
    "deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro " +
    "ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki " +
    "lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow " +
    "lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray " +
    "lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine " +
    "mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise " +
    "mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab " +
    "orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru " +
    "pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown " +
    "seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan " +
    "teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen"
  ).split(" ")
);

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/;

export function isColorValue(raw: string): boolean {
  const value = raw.trim();
  if (!value) return false;
  const lower = value.toLowerCase();
  // Unresolved indirection belongs to another reader: `$token` is materialised
  // document-wide before elements are normalized, and `var()` is expanded by the
  // same pass. A leftover one is already that pass's finding, and refusing it
  // here would report one mistake twice.
  if (value.startsWith("$") || lower.includes("var(")) return true;
  if (KEYWORDS.has(lower)) return true;
  if (lower.startsWith("#")) return HEX.test(lower);
  const call = /^([a-z-]+)\(/.exec(lower);
  if (call) return COLOR_FUNCTIONS.has(call[1]);
  return NAMED.has(lower);
}
