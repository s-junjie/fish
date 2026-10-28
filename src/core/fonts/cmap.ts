import { FontParseError, SfntFont, requireTable } from "./sfnt";

/**
 * `cmap`: code point -> glyph id.
 *
 * Formats 4 (BMP) and 12 (full Unicode) cover every font a design tool meets.
 * When neither is present the error names the formats the font did offer —
 * returning glyph 0 for everything is how a whole text layer becomes tofu
 * without anyone noticing.
 */

const FORMAT_4 = 4;
const FORMAT_12 = 12;

export function buildCmap(font: SfntFont): (codePoint: number) => number {
  const table = requireTable(font.tables, font.bytes, "cmap");
  const view = font.view;
  const count = view.getUint16(table.offset + 2);

  let best: { format: number; offset: number; score: number } | null = null;
  const seen: number[] = [];

  for (let i = 0; i < count; i++) {
    const record = table.offset + 4 + i * 8;
    const platform = view.getUint16(record);
    const encoding = view.getUint16(record + 2);
    const offset = table.offset + view.getUint32(record + 4);
    const format = view.getUint16(offset);
    if (!seen.includes(format)) seen.push(format);

    const unicode = platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10));
    const breadth = format === FORMAT_12 ? 2 : format === FORMAT_4 ? 1 : 0;
    const score = breadth * 2 + (unicode ? 1 : 0);
    if (breadth > 0 && (!best || score > best.score)) best = { format, offset, score };
  }

  if (!best) {
    throw new FontParseError(
      "malformed",
      `no usable cmap subtable (formats present: ${seen.join(", ") || "none"})`
    );
  }

  const { format, offset } = best;
  return format === FORMAT_12
    ? (codePoint) => lookupFormat12(view, offset, codePoint)
    : (codePoint) => lookupFormat4(view, offset, codePoint);
}

function lookupFormat4(view: DataView, offset: number, codePoint: number): number {
  if (codePoint > 0xffff) return 0;
  const segCount = view.getUint16(offset + 6) / 2;
  const endCodes = offset + 14;
  const startCodes = endCodes + segCount * 2 + 2;
  const deltas = startCodes + segCount * 2;
  const rangeOffsets = deltas + segCount * 2;

  for (let i = 0; i < segCount; i++) {
    if (codePoint > view.getUint16(endCodes + i * 2)) continue;
    const start = view.getUint16(startCodes + i * 2);
    if (codePoint < start) return 0;
    const delta = view.getInt16(deltas + i * 2);
    const rangeOffset = view.getUint16(rangeOffsets + i * 2);
    if (rangeOffset === 0) return (codePoint + delta) & 0xffff;
    // idRangeOffset is measured from its own slot, not from the subtable start.
    const at = rangeOffsets + i * 2 + rangeOffset + (codePoint - start) * 2;
    const glyphId = view.getUint16(at);
    return glyphId === 0 ? 0 : (glyphId + delta) & 0xffff;
  }
  return 0;
}

function lookupFormat12(view: DataView, offset: number, codePoint: number): number {
  let lo = 0;
  let hi = view.getUint32(offset + 12) - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const group = offset + 16 + mid * 12;
    const start = view.getUint32(group);
    const end = view.getUint32(group + 4);
    if (codePoint < start) hi = mid - 1;
    else if (codePoint > end) lo = mid + 1;
    else return view.getUint32(group + 8) + (codePoint - start);
  }
  return 0;
}
