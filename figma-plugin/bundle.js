/**
 * Building the download: one `export.json` and an `assets/` folder, in a zip —
 * and the clipboard copy, which is the same envelope with the images inlined.
 *
 * WHY THE FOLDER. The single-file format inlines every photograph as a data
 * URI, and base64 adds a third to bytes that are already compressed. A real
 * export was 99.6MB of JSON for 38 images, and the app had to parse all of it
 * before it could decide to shrink anything. A folder makes the manifest a few KB
 * and lets each image travel as bytes, so that parse never happens.
 *
 * WHY THE COPY STILL EXISTS. A clipboard is text, so it cannot carry a zip; the
 * inline form is the only packaging that fits, and it is the one the app's reader
 * has always accepted. It is bounded by `COPY_TEXT_LIMIT` and offered beside the
 * file, never instead of it.
 *
 * WHY NO COMPRESSION. The entries are PNG and JPEG — formats whose entire purpose
 * is to already be compressed — and the one compressible entry is a manifest in
 * kilobytes. So every entry is STORED, and a STORED zip is a container of offsets
 * and a CRC: no `CompressionStream`, no library, and nothing that behaves
 * differently in the editor than in a test.
 *
 * The app's reader is `src/core/import/figma-bundle.ts`, and a test loads THIS
 * FILE with the same `vm` trick that loads `collect.js`, then reads its output
 * with that reader. The two halves of a wire format that cannot see each other is
 * how "the plugin writes a zip and the app silently finds no images" happens.
 */

var FISH_BUNDLE_MANIFEST = "export.json";

var CRC_TABLE = null;

/**
 * String → UTF-8 bytes, by hand.
 *
 * Figma's plugin sandbox has no `TextEncoder`. It is not there in a future version
 * either — the sandbox is a deliberately small global set with no DOM-adjacent
 * encoders — and a plugin that reaches for one fails at export time, on the
 * designer's machine, having already walked a whole document.
 *
 * Hand-rolled rather than ASCII-only, because the manifest is JSON full of layer
 * names and half the designers this is for write them in something that is not
 * English. A byte-per-char encoder would turn those into mojibake inside a file
 * that still opens, which is the worst of both.
 */
function utf8(text) {
  var bytes = [];
  for (var i = 0; i < text.length; i++) {
    var code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      var low = text.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
        i++;
      }
    }
    if (code < 0x80) bytes.push(code);
    else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f)
      );
    }
  }
  return new Uint8Array(bytes);
}

function crcTable() {
  if (CRC_TABLE) return CRC_TABLE;
  var table = new Uint32Array(256);
  for (var i = 0; i < 256; i++) {
    var c = i;
    for (var k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  CRC_TABLE = table;
  return table;
}

function crc32(bytes) {
  var table = crcTable();
  var crc = 0xffffffff;
  for (var i = 0; i < bytes.length; i++) crc = table[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  return {
    time: ((date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1)) & 0xffff,
    date: (((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()) & 0xffff
  };
}

/**
 * A STORED archive from named byte arrays, as one `Uint8Array`.
 *
 * Bytes rather than a `Blob` because this runs in the sandbox, where a `Blob` is
 * not something to rely on — and because the archive is POSTED to the UI iframe in
 * chunks rather than handed over whole. A 70MB export in one `postMessage` is how
 * the iframe stops responding; the UI collects the chunks into one `Blob` and
 * writes the file, which is the only half that can.
 */
function buildStoredZip(entries, now) {
  var stamp = dosDateTime(now || new Date());
  var parts = [];
  var central = [];
  var offset = 0;

  for (var i = 0; i < entries.length; i++) {
    var entry = entries[i];
    var name = utf8(entry.path);
    var crc = crc32(entry.bytes);

    var header = new Uint8Array(30 + name.length);
    var view = new DataView(header.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, 0, true);
    view.setUint16(8, 0, true); // STORED
    view.setUint16(10, stamp.time, true);
    view.setUint16(12, stamp.date, true);
    view.setUint32(14, crc, true);
    view.setUint32(18, entry.bytes.length, true);
    view.setUint32(22, entry.bytes.length, true);
    view.setUint16(26, name.length, true);
    header.set(name, 30);

    var directory = new Uint8Array(46 + name.length);
    var dir = new DataView(directory.buffer);
    dir.setUint32(0, 0x02014b50, true);
    dir.setUint16(4, 20, true);
    dir.setUint16(6, 20, true);
    dir.setUint16(8, 0, true);
    dir.setUint16(10, 0, true);
    dir.setUint16(12, stamp.time, true);
    dir.setUint16(14, stamp.date, true);
    dir.setUint32(16, crc, true);
    dir.setUint32(20, entry.bytes.length, true);
    dir.setUint32(24, entry.bytes.length, true);
    dir.setUint16(28, name.length, true);
    dir.setUint32(42, offset, true);
    directory.set(name, 46);

    parts.push(header, entry.bytes);
    central.push(directory);
    offset += header.length + entry.bytes.length;
  }

  var centralSize = 0;
  for (var c = 0; c < central.length; c++) centralSize += central[c].length;

  var end = new Uint8Array(22);
  var endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, central.length, true);
  endView.setUint16(10, central.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, offset, true);

  var total = parts.reduce(function (sum, part) { return sum + part.length; }, 0) + centralSize + end.length;
  var out = new Uint8Array(total);
  var at = 0;
  for (var i = 0; i < parts.length; i++) { out.set(parts[i], at); at += parts[i].length; }
  for (var j = 0; j < central.length; j++) { out.set(central[j], at); at += central[j].length; }
  out.set(end, at);
  return out;
}

/**
 * The asset extension for these bytes: PNG unless the magic says otherwise.
 *
 * The sniff the zip's filenames and the clipboard's MIME both read, so the two
 * packagings name the same bytes the same way.
 */
function imageExt(bytes) {
  if (bytes && bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8) return "jpg";
  if (bytes && bytes.length > 3 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return "gif";
  return "png";
}

var IMAGE_MIMES = { png: "image/png", jpg: "image/jpeg", gif: "image/gif" };

/** `assets/<ref>.<ext>` — the ref is a hash, so it is already a safe filename. */
function assetPath(ref, bytes) {
  return "assets/" + ref + "." + imageExt(bytes);
}

/**
 * The whole archive: `export.json` plus `assets/`.
 *
 * The manifest is the SAME envelope the single-file format used, with one
 * substitution — each image value becomes the path its bytes sit at instead of a
 * data URI. That is the entire difference between the two packagings, and it is
 * why the app's envelope reader does not change: an image value is a locator
 * either way, and the reader turns one form into the other before anything else
 * looks at it.
 */
function buildBundle(envelope, imageBytes) {
  var entries = [];
  for (var ref in envelope.images) {
    var bytes = imageBytes[ref];
    if (!bytes) continue;
    envelope.images[ref] = assetPath(ref, bytes);
    entries.push({ path: envelope.images[ref], bytes: bytes });
  }

  var manifest = utf8(JSON.stringify(envelope));
  entries.unshift({ path: FISH_BUNDLE_MANIFEST, bytes: manifest });
  return buildStoredZip(entries);
}

/**
 * How much text the clipboard is asked to carry.
 *
 * Not a limit of the transport — the chunked posting below moves any size — but
 * of the CLIPBOARD: browsers disagree about how large a text paste they accept,
 * and a copy that silently fails on the far side is the one failure a designer
 * cannot act on. Past this the honest answer is "use Export file", said before
 * the copy is attempted rather than after it is lost.
 */
var COPY_TEXT_LIMIT = 8 * 1024 * 1024;

/**
 * The clipboard packaging: the SAME envelope, each image inlined as a data URI.
 *
 * This is the single-file format the app's reader has always accepted, and it is
 * the only packaging a clipboard can carry — a zip is bytes and the clipboard is
 * text. The cost is the one the folder was built to avoid (base64 is a third
 * again on bytes that are already compressed), which is what `COPY_TEXT_LIMIT`
 * is for: it is a knob, not a silent downgrade, and the plugin's UI offers the
 * folder the moment the number says so.
 *
 * A ref whose bytes never arrived is DROPPED rather than left as a locator that
 * points nowhere: the app reports an unresolved image for it either way, and
 * "pending" is a word only this file knows.
 */
function buildCopyText(envelope, imageBytes) {
  for (var ref in envelope.images) {
    var bytes = imageBytes[ref];
    if (!bytes) {
      delete envelope.images[ref];
      continue;
    }
    envelope.images[ref] = "data:" + IMAGE_MIMES[imageExt(bytes)] + ";base64," + encodeBase64(bytes);
  }
  return JSON.stringify(envelope);
}

/**
 * The receiving half of the same protocol, and the reason this file is shared.
 *
 * It lives HERE, next to the sender, and is inlined into `ui.html` by the build —
 * because the sandbox and the iframe cannot see each other's code, and every
 * version of this transport that had its two halves written separately had a bug
 * in one of them that the other could not have caught. One file, one protocol,
 * and a test that drives both halves against each other.
 *
 * ORDER IS NOT ASSUMED. The first version required each piece to arrive exactly
 * where the last one ended, and reported "arrived out of order" on the first
 * export from a real file — which is a statement about delivery order that
 * nothing had established. Pieces are keyed by offset and assembled at the end,
 * so delivery order is irrelevant and a piece that never arrives is a GAP, named
 * as one, rather than an ordering complaint.
 *
 * A gap is recoverable: the receiver asks for the range again and the sender
 * re-sends from there. Whether Figma drops a large message, reorders two, or does
 * neither is not something this code should have to know in advance — asking is
 * cheaper than being wrong.
 */
function createArchiveReceiver(post) {
  var pieces = {};
  var total = 0;
  var asked = -1;

  function accept(msg) {
    total = msg.total || total;
    if (typeof msg.chunk !== "string" || typeof msg.offset !== "number") return;
    if (pieces[msg.offset]) return;
    pieces[msg.offset] = decodeBase64(msg.chunk);
  }

  /** What is missing between 0 and `total`, as the offset to resume from. */
  function firstGap() {
    var at = 0;
    while (at < total && pieces[at]) at += pieces[at].length;
    return at;
  }

  return {
    chunk: accept,

    /**
     * The finished archive, or a sentence.
     *
     * Asking first and assembling second is deliberate: a piece in flight when
     * `exported` lands is a piece that has not arrived YET, not one that will
     * never arrive, and the first version treated it as the latter and failed an
     * export that was about to succeed.
     */
    exported: function (msg) {
      var size = msg.size || total;
      var gap = firstGap();
      if (gap < size) {
        // One request per piece, so a storm of chunks does not become a storm of
        // requests for the same range.
        if (asked !== gap) {
          asked = gap;
          post({ type: "archive-need", from: gap });
        }
        return null;
      }

      var out = [];
      var at = 0;
      while (at < size) {
        out.push(pieces[at]);
        at += pieces[at].length;
      }
      return out;
    },

    /** How far it got, for a status line that cannot lie. */
    received: function () {
      var n = 0;
      for (var key in pieces) n += pieces[key].length;
      return { bytes: n, total: total, parts: Object.keys(pieces).length };
    },

    reset: function () {
      pieces = {};
      total = 0;
      asked = -1;
    }
  };
}

/** base64 → bytes. The counterpart of `encodeBase64`, and the only decoder here. */
function decodeBase64(text) {
  var binary = atob(text);
  var bytes = new Uint8Array(binary.length);
  for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * The archive, in pieces, as STRINGS.
 *
 * BASE64, NOT A TYPED ARRAY. This cost one export to find out: the archive was
 * posted as `archive.subarray(...)` and nothing arrived — no download, and an
 * error the designer had to notice to report. `postMessage` is not a structured-
 * clone channel here and a `Uint8Array` does not survive it. A string always
 * does: the first export that worked moved 99.6MB of base64 across this same
 * boundary.
 *
 * So the 33% is paid on the SANDBOX→IFRAME hop and nowhere else. The file the
 * designer downloads is still a STORED archive of the original bytes; the base64
 * is decoded away in the iframe before the `Blob` is built.
 *
 * `post` is passed in rather than reached for, so this is a function of two
 * arguments and can be tested without a `figma` object in sight — which is the
 * only reason the failure above would not have happened again.
 *
 * `doneType` names the message that closes the transfer. It is "exported" for
 * the file — whose UI half builds a download — and "copied" for the clipboard,
 * whose half decodes the same pieces back into text. One transport, two endings,
 * because the clipboard copy is the file copy with a different last step rather
 * than a second protocol.
 */
var POST_CHUNK = 3 * 1024 * 1024;

function postArchive(post, archive, imageCount, from, chunkSize, doneType) {
  // The piece size is a SENDER-SIDE choice and the receiver is told none of it:
  // it keys every piece by its offset, so 3MB and 300 bytes are the same protocol.
  // Which is why this is a parameter rather than a constant to monkey-patch — the
  // receiver genuinely does not depend on it.
  var size = chunkSize || POST_CHUNK;
  var parts = Math.ceil(archive.length / size);
  var start = from || 0;
  if (start === 0) {
    post({ type: "archive-begin", total: archive.length, parts: parts });
  }
  for (var offset = start; offset < archive.length; offset += size) {
    post({
      type: "archive-chunk",
      offset: offset,
      total: archive.length,
      chunk: encodeBase64(archive.subarray(offset, Math.min(offset + size, archive.length)))
    });
  }
  post({ type: doneType || "exported", images: imageCount, size: archive.length, parts: parts });
}

/** Bytes → base64, in slices, because `String.fromCharCode` has an argument limit. */
function encodeBase64(bytes) {
  var CHUNK = 0x8000;
  var binary = "";
  for (var i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    FISH_BUNDLE_MANIFEST: FISH_BUNDLE_MANIFEST,
    POST_CHUNK: POST_CHUNK,
    COPY_TEXT_LIMIT: COPY_TEXT_LIMIT,
    createArchiveReceiver: createArchiveReceiver,
    decodeBase64: decodeBase64,
    postArchive: postArchive,
    encodeBase64: encodeBase64,
    utf8: utf8,
    buildStoredZip: buildStoredZip,
    buildBundle: buildBundle,
    buildCopyText: buildCopyText,
    assetPath: assetPath,
    imageExt: imageExt,
    crc32: crc32
  };
}
