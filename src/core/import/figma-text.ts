/**
 * Figma `TEXT` → a DSL text element.
 *
 * Split out of `figma-node.ts` because text is the one Figma node type with its
 * own SECOND layer — a per-run override table on top of the node's own style —
 * and because it is the only branch whose output is a document style object
 * rather than geometry. Keeping it here leaves the walk in `figma-node.ts`
 * reading as one switch over node types.
 */

import type { LineHeight, TextDecorationLine, TextElement, TextStyle } from "../dsl/types";
import { figmaColor } from "./figma-paint";
import { figmaGeometry } from "./figma-geometry";
import type { FigmaGap, FigmaNode, FigmaPaint, FigmaTypeStyle } from "./figma-types";
import type { Draft, NodeWalkState } from "./figma-node";
import { DEFAULT_FONT_FAMILY } from "../font-stack";

const TEXT_ALIGN: Record<string, TextStyle["align"]> = {
  LEFT: "left",
  CENTER: "center",
  RIGHT: "right",
  JUSTIFIED: "justify"
};

const TEXT_VALIGN: Record<string, TextStyle["verticalAlign"]> = { TOP: "top", CENTER: "middle", BOTTOM: "bottom" };

const TEXT_CASE: Record<string, NonNullable<TextStyle["textTransform"]>> = {
  UPPER: "uppercase",
  LOWER: "lowercase",
  TITLE: "capitalize"
};

/**
 * Figma's `textDecoration` → the DSL's lines.
 *
 * Figma names the line differently from CSS: `STRIKETHROUGH` is CSS's
 * `line-through`. Lowercasing the enum produced `"strikethrough"`, which is not a
 * member of `TextDecorationLine` and not a CSS keyword either — it survived the
 * `as TextDecorationLine[]` cast and was then dropped by `normalizeTextDecoration`
 * with nothing recorded, so a struck-through label imported as a plain one. The
 * cast is what made it silent, which is why the mapping is a table of the two
 * names rather than a spelling rule.
 */
const DECORATION: Record<string, TextDecorationLine> = {
  UNDERLINE: "underline",
  STRIKETHROUGH: "line-through"
};

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Figma's `lineHeight` as the DSL's tagged value, unit preserved.
 *
 * `PIXELS` is an absolute length → `"<n>px"`; `PERCENT` is a share of the font
 * size → a bare multiplier (`150%` → `1.5`), which is the DSL's spelling for a
 * ratio and what CSS itself means by a unitless line height. `AUTO` carries
 * neither field, and the two doors agree on that: the plugin's `lineHeight` is
 * `{ unit: "PIXELS" | "PERCENT" }` when set, and the shim transports the REST
 * `lineHeightPx` / `lineHeightPercent` under the same names. Reading only the px
 * field dropped a percentage entirely and the text imported at the default
 * leading — so both are read, and the percentage is no longer collapsed to a px
 * that would stop following a font-size change.
 */
function figmaLineHeight(style: FigmaTypeStyle): LineHeight | undefined {
  if (typeof style.lineHeightPx === "number" && style.lineHeightPx > 0) {
    return `${round2(style.lineHeightPx)}px` as LineHeight;
  }
  const percent = style.lineHeightPercent;
  if (typeof percent === "number" && percent > 0) return round2(percent / 100);
  return undefined;
}

export function textStyleOf(style: FigmaTypeStyle, fillColor: string | undefined): TextStyle {
  const out: TextStyle = {
    fontFamily: style.fontFamily || DEFAULT_FONT_FAMILY,
    fontSize: style.fontSize ?? 16,
    color: fillColor ?? "#000000"
  };
  if (style.fontWeight) out.fontWeight = style.fontWeight;
  if (style.italic) out.fontStyle = "italic";
  if (style.letterSpacing) out.letterSpacing = style.letterSpacing;
  const lineHeight = figmaLineHeight(style);
  if (lineHeight !== undefined) out.lineHeight = lineHeight;
  const align = TEXT_ALIGN[style.textAlignHorizontal ?? ""];
  if (align) out.align = align;
  const valign = TEXT_VALIGN[style.textAlignVertical ?? ""];
  if (valign) out.verticalAlign = valign;
  const transform = TEXT_CASE[style.textCase ?? ""];
  if (transform) out.textTransform = transform;
  // Figma's enum carries ONE decoration, so the DSL's list is at most one entry.
  const decoration = DECORATION[style.textDecoration ?? ""];
  if (decoration) out.textDecoration = [decoration];
  return out;
}

/**
 * `characterStyleOverrides` is Figma's per-run override table: index `i` is the
 * style for run `i`, and `0` means "the node's own `style`". Runs are carried as
 * `spans`, which is what the DSL already models — a bold word inside a heading is
 * the single most common thing a real file does to a text node.
 */
function spansOf(node: FigmaNode): TextElement["spans"] {
  const overrides = node.characterStyleOverrides;
  const table = node.styleOverrideTable;
  if (!Array.isArray(overrides) || overrides.length === 0 || !table) return undefined;

  const chars = node.characters ?? "";
  const spans: NonNullable<TextElement["spans"]> = [];
  let runStart = 0;
  const push = (from: number, to: number, key: string | number) => {
    const text = chars.slice(from, to);
    if (!text) return;
    // A run's colour comes from the override's own fill where it has one, and
    // from the node's fill otherwise — the override table carries type only.
    const override = table[String(key)];
    spans.push(
      key === 0 || !override
        ? { text }
        : { text, style: textStyleOf(override, firstSolidColor(node.fills)) }
    );
  };
  for (let i = 0; i < overrides.length; i++) {
    push(runStart, i, overrides[i]);
    runStart = i;
  }
  push(runStart, chars.length, overrides[overrides.length - 1] ?? 0);

  // One run is not mixed content; emitting a single span would make the DSL
  // re-wrap the text through the override path for no gain.
  return spans.length <= 1 ? undefined : spans;
}

function firstSolidColor(fills: FigmaPaint[] | undefined): string | undefined {
  const paint = (fills ?? []).find((f) => f.visible !== false);
  if (!paint || paint.type !== "SOLID" || !paint.color) return undefined;
  return figmaColor(paint.color, paint.opacity ?? 1);
}

/**
 * The glyph outline Figma already measured for this text, in the node's own
 * coordinates — `fillGeometry`, the same field a `path` node is built from.
 *
 * It is carried so a text can act as GEOMETRY. That is not a nicety: a mask can
 * only hold a path (a `foreignObject`, which is how every text node here is
 * drawn, paints nothing inside a `<mask>`), so a fill-less mask frame holding
 * words had nothing to clip to and fell back to masking by its own box —
 * Figma's standard "tint an icon" idiom arriving as a coloured block over the
 * icon.
 *
 * Two caps, because the cost is per character and a paragraph is not an icon:
 * a long text's outline is tens of kilobytes of path data for something no mask
 * in a real file uses. Both drops are reported — a silently absent outline is
 * indistinguishable from Figma not having one.
 */
const OUTLINE_MAX_CHARS = 64;
const OUTLINE_MAX_PATH_CHARS = 12000;

function outlineOf(node: FigmaNode, state?: NodeWalkState): TextElement["outline"] | undefined {
  const geometry = figmaGeometry(node.fillGeometry);
  const characters = (node.characters ?? "").trim();
  if (!geometry) return undefined;

  const report = (property: string, value: string): void => {
    state?.gaps.push({ id: node.id, name: node.name || node.type, property, value });
  };

  if (characters.length > OUTLINE_MAX_CHARS) {
    report(
      "text:outline:tooLong",
      `${characters.length} characters: the glyph outline is not carried, so a mask holding this text clips to the layer's box instead of the glyphs`
    );
    return undefined;
  }
  if (geometry.d.length > OUTLINE_MAX_PATH_CHARS) {
    report(
      "text:outline:tooLarge",
      `a ${geometry.d.length}-character path for ${characters.length} characters is not carried, so a mask holding this text clips to the layer's box`
    );
    return undefined;
  }

  return {
    d: geometry.d,
    ...(geometry.fillRule ? { fillRule: geometry.fillRule } : {})
  };
}

/**
 * Build the element from an already-built base, so this module owns only what is
 * specific to text and the walk keeps owning geometry, ids and the measured box.
 */
export function fillTextElement(out: Draft, node: FigmaNode, state?: NodeWalkState): Draft {
  out.type = "text";
  out.content = node.characters ?? "";
  out.style = textStyleOf(node.style ?? {}, firstSolidColor(node.fills));
  const spans = spansOf(node);
  if (spans) out.spans = spans;
  const outline = outlineOf(node, state);
  if (outline) out.outline = outline;
  // Figma auto-width text re-measures to its content; without this the DSL
  // treats the authored box as fixed and a later edit wraps where Figma did not.
  if (node.textAutoResize === "WIDTH_AND_HEIGHT") out.sizing = { width: "fit-content", height: "fit-content" };

  // Truncation is two Figma fields that mean one DSL thing. `TRUNCATE` is the
  // mode, `maxLines` is the count, and `textTruncation: "ENDING"` is the
  // ellipsis. Figma clips at the box with no marker by default, so the ellipsis
  // has to be asked for separately or every truncated label arrives cut mid-glyph.
  //
  // Both fields are read from the node AND from its `style`, because the two APIs
  // put them in different places: REST carries them in `TypeStyle` (beside the
  // font), while the plugin API carries them on the text node itself, and the
  // shim transports them where its own API has them. Reading only the style
  // dropped the ellipsis and the line count on the plugin door — a truncated
  // label arrived as one clipped line — with nothing in the report.
  const style = node.style ?? {};
  const truncation = node.textTruncation ?? style.textTruncation;
  const lineCount = node.maxLines ?? style.maxLines;
  const truncating = node.textAutoResize === "TRUNCATE" || truncation === "ENDING";
  if (truncating) {
    const maxLines = typeof lineCount === "number" && lineCount > 0 ? lineCount : 1;
    out.style = { ...(out.style as TextStyle), maxLines, textOverflow: truncation === "ENDING" ? "ellipsis" : "clip" };
  }
  return out;
}

