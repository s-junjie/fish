/**
 * The SFNT container: the table directory every TrueType/OpenType file starts
 * with, plus the header tables the outline reader needs.
 *
 * `ttcf` is rejected by name: a collection has no single offset table to read,
 * and the browser path never produces one (Chrome splits them). `OTTO` is not an
 * error — it means the glyphs live in `CFF ` rather than `glyf`, which
 * `outlineFormat` reports.
 */

const SIGNATURE_TRUETYPE = 0x00010000;
const SIGNATURE_APPLE_TRUE = 0x74727565;
const SIGNATURE_CFF = 0x4f54544f;
const SIGNATURE_COLLECTION = 0x74746366;

export type FontErrorCode = "unsupported-collection" | "malformed";

export class FontParseError extends Error {
  readonly code: FontErrorCode;

  constructor(code: FontErrorCode, message: string) {
    super(message);
    this.name = "FontParseError";
    this.code = code;
  }
}

export interface SfntTable {
  offset: number;
  length: number;
}

export interface SfntFont {
  bytes: Uint8Array;
  view: DataView;
  tables: Map<string, SfntTable>;
  unitsPerEm: number;
  /** `head.indexToLocFormat`: 0 = 16-bit `loca` offsets, 1 = 32-bit. */
  indexToLocFormat: number;
  numGlyphs: number;
  ascender: number;
  descender: number;
  numberOfHMetrics: number;
  /** Which table the glyph outlines live in. */
  outlineFormat: "glyf" | "cff";
}

export function parseSfnt(bytes: Uint8Array): SfntFont {
  if (bytes.length < 12) throw new FontParseError("malformed", "shorter than an SFNT header");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const signature = view.getUint32(0);

  if (signature === SIGNATURE_COLLECTION) {
    throw new FontParseError(
      "unsupported-collection",
      "TrueType collection (.ttc); Chrome's queryLocalFonts already splits these"
    );
  }
  if (
    signature !== SIGNATURE_TRUETYPE &&
    signature !== SIGNATURE_APPLE_TRUE &&
    signature !== SIGNATURE_CFF
  ) {
    throw new FontParseError("malformed", `unknown SFNT signature 0x${signature.toString(16)}`);
  }

  const numTables = view.getUint16(4);
  const tables = new Map<string, SfntTable>();
  for (let i = 0; i < numTables; i++) {
    const base = 12 + i * 16;
    if (base + 16 > bytes.length) {
      throw new FontParseError("malformed", "table directory runs past the file");
    }
    const tag = String.fromCharCode(bytes[base], bytes[base + 1], bytes[base + 2], bytes[base + 3]);
    tables.set(tag, { offset: view.getUint32(base + 8), length: view.getUint32(base + 12) });
  }

  const head = requireTable(tables, bytes, "head");
  const maxp = requireTable(tables, bytes, "maxp");
  const hhea = requireTable(tables, bytes, "hhea");

  const unitsPerEm = view.getUint16(head.offset + 18);
  if (unitsPerEm === 0) throw new FontParseError("malformed", "head.unitsPerEm is zero");

  return {
    bytes,
    view,
    tables,
    unitsPerEm,
    indexToLocFormat: view.getInt16(head.offset + 50),
    numGlyphs: view.getUint16(maxp.offset + 4),
    ascender: view.getInt16(hhea.offset + 4),
    descender: view.getInt16(hhea.offset + 6),
    numberOfHMetrics: view.getUint16(hhea.offset + 34),
    outlineFormat: signature === SIGNATURE_CFF ? "cff" : "glyf"
  };
}

export function requireTable(
  tables: Map<string, SfntTable>,
  bytes: Uint8Array,
  tag: string
): SfntTable {
  const table = tables.get(tag);
  if (!table) throw new FontParseError("malformed", `missing required table "${tag}"`);
  if (table.offset + table.length > bytes.length) {
    throw new FontParseError("malformed", `table "${tag}" runs past the file`);
  }
  return table;
}
