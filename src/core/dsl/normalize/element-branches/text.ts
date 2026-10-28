import { isPlainObject, asNumber, lengthUnit, pxLength } from "../shared";
import { resolveDynamicLineHeight } from "../../../layout/text-sizing";
import { normalizeFillStack } from "../paint";
import { DEFAULT_FONT_SIZE, normalizeTextStyle, normalizeTextSpans } from "../text-sizing";
import { takeTextShadow } from "../effects";
import { topPaint } from "../../paint-stack";
import type { Effect } from "../../types";
import type { ElementBranch } from "./shared";

export const normalizeText: ElementBranch = ({ el, base, path, repairs, sizing }) => {
  // `content` / `text` are the DSL spellings; `characters` is Figma's.
  // It is absorbed and reported so the alias is visible rather than a silent read.
  const rawContent =
    typeof el.content === "string"
      ? el.content
      : typeof el.text === "string"
        ? el.text
        : typeof el.characters === "string"
          ? el.characters
          : "";
  if (el.content === undefined && el.text === undefined && typeof el.characters === "string") {
    repairs.push({ kind: "text", path: `${path}/characters`, severity: "info", message: '"characters" (Figma) normalized to text' });
  }
  const normalizedSpansResult = normalizeTextSpans(el.spans, rawContent, path, repairs);
  base.content = normalizedSpansResult.content;
  if (normalizedSpansResult.spans && normalizedSpansResult.spans.length > 0) {
    base.spans = normalizedSpansResult.spans;
  }
  // Text carries a fill stack like every other element, and the renderer
  // reads the top fill FIRST (`style.color` is only the fallback). Skipping
  // normalization here dropped `fills` on every load / restore / edit, so
  // any text colour set through the fill inspector silently reverted to the
  // `style.color` default while its `fillStyleId` marker survived — the style
  // pill still read as bound, which made the element look unbound-but-white.
  const fills = normalizeFillStack(el, path, repairs);
  const topFill = topPaint(fills);
  // `fills` is a DECISION even when it is empty: `[]`, `fill: false` and
  // `fillEnabled: false` all say "paint nothing" and have to survive the
  // round trip. Only the missing key has no opinion — and reading the
  // resulting stack with `!topFill` treated those two answers as one, so a
  // text the author had deliberately emptied came back as black glyphs
  // (LESSONS_LEARNED §206).
  if (fills !== undefined) base.fills = fills;
  // The two colour stores must never disagree: a solid top fill is what the
  // eye sees, so it is the value `style.color` reports. With no stack
  // written at all the reverse holds, and the colour becomes the paint —
  // `style.color` is the field the DSL documents text colour in, and the
  // agent guide writes it there, so a text that carries only that must
  // still paint.
  let style = normalizeTextStyle(el.style, el, path, repairs);
  if (topFill && topFill.type === "solid") {
    style = { ...style, color: topFill.color };
  } else if (fills === undefined && style.color) {
    base.fills = [{ type: "solid", color: style.color }];
  }
  // `text-shadow` is an input alias for a drop shadow (see `takeTextShadow`).
  // The effects pass has already run by the time this branch is reached, so the
  // converted shadows are appended to the stack it built.
  const shadow = takeTextShadow(style);
  style = shadow.style;
  if (shadow.effects.length > 0) {
    base.effects = [...((base.effects as Effect[] | undefined) ?? []), ...shadow.effects];
    repairs.push({
      kind: "effect",
      path: `${path}/style/textShadow`,
      severity: "info",
      message: 'CSS "textShadow" moved into effects[] as drop shadows'
    });
  }
  base.style = style;
  const textStyleId = typeof el.textStyleId === "string" ? el.textStyleId.trim() : undefined;
  if (textStyleId) base.textStyleId = textStyleId;
  else if (el.textStyleId === null) base.textStyleId = null;

  // Ensure text element has sensible non-zero bounds so SVG <foreignObject>
  // is never dropped by browser layout engines when width or height is 0.
  const fontSize = style.fontSize || DEFAULT_FONT_SIZE;
  const contentLen = Math.max(1, (base.content as string).length);
  // The line box the renderer and `validate` both measure, not an approximation
  // of it. A 1.3x estimate here against the 1.38x line box there is a box 1px
  // shorter than the single line it holds, so every text that left `height`
  // unwritten came back from `check` as "33px exceeds 32px" — the engine
  // disagreeing with itself, reported as an authoring mistake.
  const estLineHeight = resolveDynamicLineHeight(fontSize, style.lineHeight);

  if ((base.width as number) <= 0) {
    if (sizing.width === "max-content") {
      base.width = Math.max(40, Math.ceil(contentLen * fontSize * 0.7));
    } else {
      base.width = Math.max(200, Math.ceil(contentLen * fontSize * 0.7));
    }
  }
  if ((base.height as number) <= 0) {
    base.height = estLineHeight;
  }

  // The glyph outline, kept as authored geometry: a mask can only carry a
  // path (this engine paints text through a `foreignObject`, which a mask
  // renders as nothing), so a document that carries one loses its mask
  // geometry on the first load otherwise. Only a real path string and a
  // known fill rule survive; anything else is dropped rather than kept as a
  // shape nothing can draw.
  const outline = el.outline;
  if (isPlainObject(outline) && typeof (outline as { d?: unknown }).d === "string" && (outline as { d: string }).d.trim()) {
    const rule = (outline as { fillRule?: unknown }).fillRule;
    base.outline = {
      d: (outline as { d: string }).d,
      ...(rule === "evenodd" || rule === "nonzero" ? { fillRule: rule } : {})
    };
  }

  // Text-on-path reference. Only a well-formed { pathId, startOffset? }
  // survives; anything else is dropped silently (plain text rendering).
  const onPath = el.onPath;
  if (isPlainObject(onPath) && typeof onPath.pathId === "string" && onPath.pathId.trim()) {
    const startOffsetRaw = onPath.startOffset;
    const unit = lengthUnit(startOffsetRaw);
    const startOffset =
      unit === "" || unit === "%" ? asNumber(startOffsetRaw) : undefined;
    if (startOffsetRaw !== undefined && startOffset === undefined) {
      repairs.push({
        kind: "text",
        path: `${path}/onPath/startOffset`,
        message: `startOffset ${JSON.stringify(startOffsetRaw)} is not a path-length percentage (0–100 or "<n>%");${unit ? ` it carries "${unit}";` : ""} dropped`
      });
    }
    const rawSide = onPath.side;
    const side = rawSide === "in" || rawSide === "out" ? rawSide : undefined;
    if (rawSide !== undefined && side === undefined) {
      repairs.push({
        kind: "text",
        path: `${path}/onPath/side`,
        message: `onPath.side ${JSON.stringify(rawSide)} is not one of in | out; dropped`
      });
    }
    base.onPath = {
      pathId: onPath.pathId.trim(),
      ...(startOffset !== undefined && startOffset > 0 ? { startOffset } : {}),
      ...(side ? { side } : {})
    };
  }
};
