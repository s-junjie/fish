// RFC 1951 inflate, raw (no zlib/gzip wrapper), in plain JavaScript.
//
// Why this exists instead of `DecompressionStream`: that API needs Safari 16.4 /
// Firefox 113 / Chrome 80, and a shell that a user opens by double-clicking must
// not have a browser floor. It is also promise-based, so the runtime would mount
// in a later task — in a document that is hidden or rendered off-screen, timers
// are throttled and no frame is delivered, so nothing paints until whoever is
// looking has looked. Decoding synchronously inside the loader's own
// parser-inserted script mounts the app before DOMContentLoaded, exactly as the
// uncompressed build does.
//
// Huffman decoding follows zlib's `puff`: canonical codes walked one bit at a
// time against per-length symbol counts. It is not the fastest inflate there is,
// but it is short enough to read, and `tests/shell-compression.test.ts` holds it
// against node's zlib over every stored/fixed/dynamic block shape.
//
// The `export` is stripped by scripts/compress-shell.mjs when inlining this into
// the shell, so the loader needs no module system.

const MAX_BITS = 15;

const LENGTH_BASE = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131,
  163, 195, 227, 258
];
const LENGTH_EXTRA = [
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0
];
const DIST_BASE = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537,
  2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577
];
const DIST_EXTRA = [
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13
];
const CODE_LENGTH_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

function buildTree(lengths, n) {
  const count = new Int32Array(MAX_BITS + 1);
  for (let i = 0; i < n; i++) count[lengths[i]]++;
  count[0] = 0;
  const next = new Int32Array(MAX_BITS + 1);
  let total = 0;
  for (let len = 1; len <= MAX_BITS; len++) {
    next[len] = total;
    total += count[len];
  }
  const symbols = new Int32Array(total);
  for (let sym = 0; sym < n; sym++) {
    if (lengths[sym]) symbols[next[lengths[sym]]++] = sym;
  }
  return { count, symbols };
}

let fixedLiteral = null;
let fixedDistance = null;
function fixedTrees() {
  if (fixedLiteral) return;
  const lit = new Uint8Array(288);
  for (let i = 0; i < 144; i++) lit[i] = 8;
  for (let i = 144; i < 256; i++) lit[i] = 9;
  for (let i = 256; i < 280; i++) lit[i] = 7;
  for (let i = 280; i < 288; i++) lit[i] = 8;
  fixedLiteral = buildTree(lit, 288);
  fixedDistance = buildTree(new Uint8Array(30).fill(5), 30);
}

function getBit(state) {
  if (state.bitCount === 0) {
    if (state.pos >= state.src.length) throw new Error("inflate: out of input");
    state.bitBuffer = state.src[state.pos++];
    state.bitCount = 8;
  }
  const bit = state.bitBuffer & 1;
  state.bitBuffer >>= 1;
  state.bitCount--;
  return bit;
}

function getBits(state, n) {
  let value = 0;
  for (let i = 0; i < n; i++) value |= getBit(state) << i;
  return value;
}

function decodeSymbol(state, tree) {
  let code = 0;
  let first = 0;
  let index = 0;
  for (let len = 1; len <= MAX_BITS; len++) {
    code |= getBit(state);
    const count = tree.count[len];
    if (code - count < first) return tree.symbols[index + (code - first)];
    index += count;
    first = (first + count) << 1;
    code <<= 1;
  }
  throw new Error("inflate: invalid Huffman code");
}

function reserve(state, n) {
  if (state.outPos + n <= state.out.length) return;
  let capacity = state.out.length || 4096;
  while (capacity < state.outPos + n) capacity *= 2;
  const grown = new Uint8Array(capacity);
  grown.set(state.out.subarray(0, state.outPos));
  state.out = grown;
}

function readDynamicTrees(state) {
  const nLiteral = getBits(state, 5) + 257;
  const nDistance = getBits(state, 5) + 1;
  const nCode = getBits(state, 4) + 4;
  if (nLiteral > 286 || nDistance > 30) throw new Error("inflate: too many codes");

  const codeLengths = new Uint8Array(19);
  for (let i = 0; i < nCode; i++) codeLengths[CODE_LENGTH_ORDER[i]] = getBits(state, 3);
  const codeTree = buildTree(codeLengths, 19);

  const lengths = new Uint8Array(nLiteral + nDistance);
  const total = nLiteral + nDistance;
  let i = 0;
  while (i < total) {
    const symbol = decodeSymbol(state, codeTree);
    if (symbol < 16) {
      lengths[i++] = symbol;
    } else if (symbol === 16) {
      if (i === 0) throw new Error("inflate: repeat with no previous length");
      const previous = lengths[i - 1];
      let repeat = 3 + getBits(state, 2);
      while (repeat-- > 0 && i < total) lengths[i++] = previous;
    } else if (symbol === 17) {
      let repeat = 3 + getBits(state, 3);
      while (repeat-- > 0 && i < total) lengths[i++] = 0;
    } else {
      let repeat = 11 + getBits(state, 7);
      while (repeat-- > 0 && i < total) lengths[i++] = 0;
    }
  }
  return {
    literal: buildTree(lengths.subarray(0, nLiteral), nLiteral),
    distance: buildTree(lengths.subarray(nLiteral), nDistance)
  };
}

function inflateBlock(state, literalTree, distanceTree) {
  for (;;) {
    const symbol = decodeSymbol(state, literalTree);
    if (symbol < 256) {
      reserve(state, 1);
      state.out[state.outPos++] = symbol;
    } else if (symbol === 256) {
      return;
    } else {
      const lengthIndex = symbol - 257;
      if (lengthIndex >= LENGTH_BASE.length) throw new Error("inflate: invalid length symbol");
      const length = LENGTH_BASE[lengthIndex] + getBits(state, LENGTH_EXTRA[lengthIndex]);
      const distanceSymbol = decodeSymbol(state, distanceTree);
      if (distanceSymbol >= DIST_BASE.length) throw new Error("inflate: invalid distance symbol");
      const distance = DIST_BASE[distanceSymbol] + getBits(state, DIST_EXTRA[distanceSymbol]);
      if (distance > state.outPos) throw new Error("inflate: distance reaches before the output start");
      reserve(state, length);
      // byte at a time: length may exceed distance, which is the overlap case
      let from = state.outPos - distance;
      for (let i = 0; i < length; i++) state.out[state.outPos++] = state.out[from++];
    }
  }
}

function inflateStored(state) {
  state.bitBuffer = 0;
  state.bitCount = 0;
  if (state.pos + 4 > state.src.length) throw new Error("inflate: truncated stored block header");
  const length = state.src[state.pos] | (state.src[state.pos + 1] << 8);
  const inverse = state.src[state.pos + 2] | (state.src[state.pos + 3] << 8);
  if ((length ^ 0xffff) !== inverse) throw new Error("inflate: stored block length check failed");
  state.pos += 4;
  if (state.pos + length > state.src.length) throw new Error("inflate: truncated stored block");
  reserve(state, length);
  state.out.set(state.src.subarray(state.pos, state.pos + length), state.outPos);
  state.outPos += length;
  state.pos += length;
}

export function inflateRaw(src) {
  if (!(src instanceof Uint8Array)) throw new Error("inflate: expected a Uint8Array");
  const state = {
    src,
    pos: 0,
    bitBuffer: 0,
    bitCount: 0,
    out: new Uint8Array(Math.max(4096, src.length * 4)),
    outPos: 0
  };

  let final = 0;
  do {
    final = getBit(state);
    const type = getBits(state, 2);
    if (type === 0) {
      inflateStored(state);
    } else if (type === 1) {
      fixedTrees();
      inflateBlock(state, fixedLiteral, fixedDistance);
    } else if (type === 2) {
      const trees = readDynamicTrees(state);
      inflateBlock(state, trees.literal, trees.distance);
    } else {
      throw new Error("inflate: reserved block type 3");
    }
  } while (!final);

  return state.out.slice(0, state.outPos);
}