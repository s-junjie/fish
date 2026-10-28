/**
 * The Figma plugin's export as a FOLDER: one `export.json` and an `assets/`
 * directory, in a single `.zip` the designer downloads once.
 *
 * WHY A CONTAINER AND NOT A BIGGER JSON. The single-file format inlines every
 * image as a data URI, and base64 costs a third on top of bytes that are already
 * compressed. One real export was 99.6MB of JSON for 38 photographs. Nothing
 * downstream can avoid paying that: the app has to `JSON.parse` the whole string
 * before it can decide to shrink anything, so shrinking afterwards saves the
 * stored document and nothing else. A folder makes the manifest a few KB and the
 * images arrive as `Blob`s, so the 100MB parse never happens at all.
 *
 * WHY STORED, NOT DEFLATED. The entries are PNG and JPEG — formats whose whole
 * purpose is to already be compressed — and the one compressible entry is a
 * manifest measured in kilobytes. So DEFLATE would buy nothing and cost a
 * compression library, and the shell has **7.9KB of headroom** under its 380KB
 * cap. A STORED archive is a container of offsets and a CRC: no `CompressionStream`,
 * no `DecompressionStream`, no dependency, and — because it is plain arithmetic —
 * testable in Node without a browser.
 *
 * THE FORMAT IS HALF-OPEN, ON PURPOSE. Only DEFLATE-free archives written by this
 * plugin are read. That is a deliberate limit rather than an oversight: the plugin
 * writes the archives, so the reader has exactly one writer to satisfy, and
 * `DecompressionStream` costs a browser-version floor that a pure container does
 * not.
 */

export const FISH_BUNDLE_MANIFEST = "export.json";
export const FISH_BUNDLE_ASSETS = "assets/";

/** Magic every ZIP starts with; how a dropped file is told apart from a JSON one. */
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL = 0x06054b50;

/** Ref → the archive-relative path its bytes live at. */
export type BundleImageIndex = Record<string, string>;

// ---------------------------------------------------------------------------
// CRC-32
// ---------------------------------------------------------------------------

/**
 * The CRC-32 every ZIP entry carries, so a corrupt download is caught rather than
 * decoded into a picture that is wrong in a way nobody would notice.
 *
 * The table is built once on first use rather than written out as 256 literals:
 * 1KB of source in a bundle with 7.9KB of headroom is not free, and a loop is the
 * same eight lines either way.
 */
let crcTable: Uint32Array | null = null;

function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[i] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

interface ZipEntry {
  path: string;
  bytes: Uint8Array;
  crc: number;
}

/** DOS time/date. The plugin writes the real timestamp; this is only a fallback. */
function dosDateTime(date: Date): { time: number; date: number } {
  return {
    time: ((date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1)) & 0xffff,
    date: (((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()) & 0xffff
  };
}

/**
 * A STORED archive from named byte arrays.
 *
 * Written in one pass with an offset the writer owns, so there is no seeking and
 * no second copy of the payload: the entries are already in memory as `Blob`s and
 * this only concatenates them once.
 */
export function buildStoredZip(entries: Array<{ path: string; bytes: Uint8Array }>, now = new Date()): Blob {
  const { time, date } = dosDateTime(now);
  const prepared: ZipEntry[] = entries.map((e) => ({ path: e.path, bytes: e.bytes, crc: crc32(e.bytes) }));

  const encoder = new TextEncoder();
  const chunks: BlobPart[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const entry of prepared) {
    const name = encoder.encode(entry.path);
    const header = new Uint8Array(30 + name.length);
    const view = new DataView(header.buffer);
    view.setUint32(0, LOCAL_HEADER, true);
    view.setUint16(4, 20, true); // version needed
    view.setUint16(6, 0, true); // flags
    view.setUint16(8, 0, true); // method: STORED
    view.setUint16(10, time, true);
    view.setUint16(12, date, true);
    view.setUint32(14, entry.crc, true);
    view.setUint32(18, entry.bytes.length, true); // compressed size == size
    view.setUint32(22, entry.bytes.length, true);
    view.setUint16(26, name.length, true);
    view.setUint16(28, 0, true); // extra length
    header.set(name, 30);

    chunks.push(header as BlobPart, entry.bytes as BlobPart);

    const directory = new Uint8Array(46 + name.length);
    const dir = new DataView(directory.buffer);
    dir.setUint32(0, CENTRAL_HEADER, true);
    dir.setUint16(4, 20, true); // version made by
    dir.setUint16(6, 20, true); // version needed
    dir.setUint16(8, 0, true);
    dir.setUint16(10, 0, true); // method: STORED
    dir.setUint16(12, time, true);
    dir.setUint16(14, date, true);
    dir.setUint32(16, entry.crc, true);
    dir.setUint32(20, entry.bytes.length, true);
    dir.setUint32(24, entry.bytes.length, true);
    dir.setUint16(28, name.length, true);
    dir.setUint32(42, offset, true); // relative offset of local header
    directory.set(name, 46);
    central.push(directory);

    offset += header.length + entry.bytes.length;
  }

  const centralSize = central.reduce((sum, c) => sum + c.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, END_OF_CENTRAL, true);
  endView.setUint16(8, central.length, true);
  endView.setUint16(10, central.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, offset, true);

  return new Blob([...chunks, ...(central as BlobPart[]), end as BlobPart], { type: "application/zip" });
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export class FigmaBundleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FigmaBundleError";
  }
}

/** Whether these bytes open a ZIP, which is the only way to tell a bundle from a JSON. */
export function looksLikeZip(bytes: Uint8Array): boolean {
  return ZIP_MAGIC.every((b, i) => bytes[i] === b);
}

/**
 * The central directory, read from the end.
 *
 * From the end rather than by walking local headers, because a STORED entry's
 * local header does not carry the offset of the next one — the only place the
 * directory lives is the tail, which is why every zip reader starts there.
 */
function readCentralDirectory(view: DataView): Array<{ path: string; offset: number; size: number; crc: number }> {
  let end = -1;
  // The comment field can be up to 64KB, so scan rather than trust the last 22.
  const floor = Math.max(0, view.byteLength - 22 - 0xffff);
  for (let i = view.byteLength - 22; i >= floor; i--) {
    if (view.getUint32(i, true) === END_OF_CENTRAL) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new FigmaBundleError("That archive has no directory — it is truncated or not a zip.");

  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const decoder = new TextDecoder();
  const out: Array<{ path: string; offset: number; size: number; crc: number }> = [];

  for (let i = 0; i < count; i++) {
    if (view.getUint32(at, true) !== CENTRAL_HEADER) {
      throw new FigmaBundleError("That archive's directory is damaged.");
    }
    if (view.getUint16(at + 10, true) !== 0) {
      throw new FigmaBundleError("That archive is compressed — re-export it with the FISH Export plugin.");
    }
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    out.push({
      path: decoder.decode(new Uint8Array(view.buffer, at + 46, nameLength)),
      offset: view.getUint32(at + 42, true),
      size,
      crc: view.getUint32(at + 16, true)
    });
    at += 46 + nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
  }
  return out;
}

/** Every entry of a STORED archive, as a `path → bytes` map. */
export async function readStoredZip(file: Blob): Promise<Map<string, Uint8Array>> {
  const buffer = new Uint8Array(await file.arrayBuffer());
  if (!looksLikeZip(buffer)) throw new FigmaBundleError("That file is not a zip archive.");
  const view = new DataView(buffer.buffer);

  const out = new Map<string, Uint8Array>();
  for (const entry of readCentralDirectory(view)) {
    if (view.getUint32(entry.offset, true) !== LOCAL_HEADER) {
      throw new FigmaBundleError(`"${entry.path}" points at the wrong place in the archive.`);
    }
    const nameLength = view.getUint16(entry.offset + 26, true);
    const extraLength = view.getUint16(entry.offset + 28, true);
    const start = entry.offset + 30 + nameLength + extraLength;
    const bytes = buffer.slice(start, start + entry.size);
    if (crc32(bytes) !== entry.crc) {
      throw new FigmaBundleError(`"${entry.path}" is damaged — the download did not finish.`);
    }
    out.set(entry.path, bytes);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The bundle itself
// ---------------------------------------------------------------------------

export interface ParsedFigmaBundle {
  /** The `export.json` envelope, with `images` still holding the paths. */
  manifest: unknown;
  /** `imageRef` → its bytes, as the same `Blob` the asset pipeline wants. */
  images: Map<string, Blob>;
  /** Refs the manifest named but the archive does not carry. */
  missing: string[];
}

/**
 * Unpack a bundle into what `importFigmaFile` wants.
 *
 * The manifest is handed back UNTOUCHED. `parseFigmaExport` does not know or care
 * whether an image value is a data URI or a path into a sibling file — that is the
 * whole trick of reusing one envelope for two packagings — so the two formats meet
 * exactly once, here, and nowhere else.
 */
export async function readFigmaBundle(file: Blob): Promise<ParsedFigmaBundle> {
  const entries = await readStoredZip(file);
  const manifestBytes = entries.get(FISH_BUNDLE_MANIFEST);
  if (!manifestBytes) {
    throw new FigmaBundleError(`That archive has no ${FISH_BUNDLE_MANIFEST} — it is not a FISH export.`);
  }

  const manifest = JSON.parse(new TextDecoder().decode(manifestBytes));
  const index = (manifest as { images?: BundleImageIndex }).images ?? {};

  const images = new Map<string, Blob>();
  const missing: string[] = [];
  for (const [ref, path] of Object.entries(index)) {
    const bytes = entries.get(path);
    if (!bytes) {
      missing.push(ref);
      continue;
    }
    images.set(ref, new Blob([bytes as BlobPart], { type: guessMime(path) }));
  }

  return { manifest, images, missing };
}

function guessMime(path: string): string {
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase();
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "gif") return "image/gif";
  if (ext === "webp") return "image/webp";
  if (ext === "svg") return "image/svg+xml";
  return "image/png";
}
