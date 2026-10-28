// base86 — the densest ASCII carrier that is safe inside an HTML script block by
// construction, for the deflated runtime payloads.
//
// Alphabet: printable ASCII 0x21–0x7E (94 symbols) minus `<` `>` `&` `"` `'`
// `\` `-` and `{` — 86 symbols. Every one of `</script`, `<!--`, `-->`, `]]>`
// and `${` needs a character from that excluded set, so the payload text cannot
// express any of them whatever bytes it carries. Quotes, ampersand and backslash
// go so the text is also safe inside an attribute or a JS string; space is out so
// a run of payload never wraps or tokenises.
//
// Groups: 4 bytes → 5 chars (86^5 = 4,704,270,176 > 2^32). log2(86) = 6.43 bits
// per char against 6.4 achieved, and 7 bytes → 9 chars would be *worse* (6.22),
// so 4→5 is the densest grouping here and 32-bit arithmetic is all a decoder
// needs. That is ×1.25 on the wire against base64's ×1.333.
//
// Tail: the last partial group of n bytes (1–3) is zero-padded, encoded, and
// n+1 chars emitted; a decoder pads the missing chars with the highest symbol and
// keeps the first n bytes. The padding is maximal on purpose: it rounds the
// reconstructed value UP, and the true value sits at the bottom of its byte
// bucket, so the first n bytes come back correct (the Ascii85 rule).

export const ALPHABET = (() => {
  let s = "";
  for (let c = 0x21; c <= 0x7e; c++) {
    const ch = String.fromCharCode(c);
    if ("<>&\"'\\-{".includes(ch)) continue;
    s += ch;
  }
  return s;
})();

export const BASE = ALPHABET.length;
if (BASE !== 86) throw new Error(`b86: alphabet is ${BASE} symbols, expected 86`);

const VALUE = new Int16Array(128).fill(-1);
for (let i = 0; i < BASE; i++) VALUE[ALPHABET.charCodeAt(i)] = i;

export const FORBIDDEN = ["</script", "<!--", "-->", "]]>", "${"];

/** Uint8Array → base86 text. */
export function encode(bytes) {
  const out = [];
  const n = bytes.length;
  let i = 0;
  for (; i + 4 <= n; i += 4) {
    let v = ((bytes[i] << 24) >>> 0) + (bytes[i + 1] << 16) + (bytes[i + 2] << 8) + bytes[i + 3];
    const c4 = v % BASE;
    v = (v - c4) / BASE;
    const c3 = v % BASE;
    v = (v - c3) / BASE;
    const c2 = v % BASE;
    v = (v - c2) / BASE;
    const c1 = v % BASE;
    v = (v - c1) / BASE;
    out.push(ALPHABET[v], ALPHABET[c1], ALPHABET[c2], ALPHABET[c3], ALPHABET[c4]);
  }
  const rest = n - i;
  if (rest) {
    let v = 0;
    for (let k = 0; k < 4; k++) v = v * 256 + (k < rest ? bytes[i + k] : 0);
    const chars = new Array(5);
    for (let k = 4; k >= 0; k--) {
      chars[k] = ALPHABET[v % BASE];
      v = (v - (v % BASE)) / BASE;
    }
    for (let k = 0; k <= rest; k++) out.push(chars[k]);
  }
  return out.join("");
}

/** base86 text → Uint8Array. */
export function decode(text) {
  const bytes = [];
  const n = text.length;
  if (n === 0) return new Uint8Array(0);
  let i = 0;
  for (; i + 5 <= n; i += 5) {
    let v = 0;
    for (let k = 0; k < 5; k++) {
      const d = VALUE[text.charCodeAt(i + k)];
      if (d < 0) throw new Error(`b86: character outside the alphabet: ${JSON.stringify(text[i + k])}`);
      v = v * BASE + d;
    }
    // division rather than shifts: a corrupt group can exceed 2^32, and 86^5 does
    bytes.push(
      Math.floor(v / 16777216) % 256,
      Math.floor(v / 65536) % 256,
      Math.floor(v / 256) % 256,
      v % 256
    );
  }
  const rem = n - i;
  if (rem === 1) throw new Error("b86: lone trailing character");
  if (rem > 0) {
    let v = 0;
    for (let k = 0; k < 5; k++) {
      const d = k < rem ? VALUE[text.charCodeAt(i + k)] : BASE - 1;
      if (d < 0) throw new Error("b86: character outside the alphabet");
      v = v * BASE + d;
    }
    // keep the first rem-1 bytes of the reconstructed group
    for (let k = 0; k < rem - 1; k++) {
      bytes.push(Math.floor(v / Math.pow(256, 3 - k)) % 256);
    }
  }
  return new Uint8Array(bytes);
}

/**
 * The same decoder as a string, for inlining into the shell's loader.
 *
 * It is a separate copy rather than a serialisation of the one above because the
 * loader has no module system: it runs as a classic script inside a file that must
 * work from `file://`. `tests/shell-compression.test.ts` asserts the two agree
 * byte for byte, so this copy cannot drift without the suite going red.
 */
export const LOADER_DECODER = `
var FISH_B86_ALPHABET=${JSON.stringify(ALPHABET)};
var FISH_B86_BASE=FISH_B86_ALPHABET.length;
var FISH_B86_VALUE=new Int16Array(128).fill(-1);
for(var i=0;i<FISH_B86_BASE;i++)FISH_B86_VALUE[FISH_B86_ALPHABET.charCodeAt(i)]=i;
function fishB86Decode(text){
  var bytes=[],n=text.length,i=0;
  if(!n)return new Uint8Array(0);
  for(;i+5<=n;i+=5){
    var v=0;
    for(var k=0;k<5;k++){var d=FISH_B86_VALUE[text.charCodeAt(i+k)];if(d<0)throw new Error('b86: bad character');v=v*FISH_B86_BASE+d}
    bytes.push(Math.floor(v/16777216)%256,Math.floor(v/65536)%256,Math.floor(v/256)%256,v%256);
  }
  var rem=n-i;
  if(rem===1)throw new Error('b86: lone trailing character');
  if(rem>0){
    var v2=0;
    for(var k2=0;k2<5;k2++){var d2=k2<rem?FISH_B86_VALUE[text.charCodeAt(i+k2)]:FISH_B86_BASE-1;if(d2<0)throw new Error('b86: bad character');v2=v2*FISH_B86_BASE+d2}
    var four=[Math.floor(v2/16777216)%256,Math.floor(v2/65536)%256,Math.floor(v2/256)%256,v2%256];
    for(var k3=0;k3<rem-1;k3++)bytes.push(four[k3]);
  }
  return new Uint8Array(bytes);
}
`;