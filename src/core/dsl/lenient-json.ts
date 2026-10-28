/**
 * JSON the way an author actually types it: `//` and `/* *\/` comments, and a
 * comma left dangling before `}` / `]`.
 *
 * Hand-written `#design-doc` blocks are the authoring format, and strict JSON is
 * hostile to editing one — a missing comma is the single most common reason an
 * agent rewrites the whole block instead of patching a number. Everything the
 * app writes is still strict JSON, so this only widens what can be *read*.
 *
 * Removed characters become spaces rather than disappearing, so `JSON.parse`
 * still reports the line and column the author is looking at.
 */

export function relaxJson(text: string): string {
  let out = "";
  let i = 0;

  const copyString = (): void => {
    out += text[i];
    i += 1;
    while (i < text.length) {
      const ch = text[i];
      if (ch === "\\") {
        out += text.slice(i, i + 2);
        i += 2;
        continue;
      }
      out += ch;
      i += 1;
      if (ch === '"') return;
    }
  };

  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      copyString();
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") {
        out += " ";
        i += 1;
      }
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      out += "  ";
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) {
        out += text[i] === "\n" ? "\n" : " ";
        i += 1;
      }
      if (i < text.length) {
        out += "  ";
        i += 2;
      }
      continue;
    }
    out += ch;
    i += 1;
  }

  // Trailing commas, in a second pass so a comma inside a removed comment cannot
  // reach it.
  let relaxed = "";
  let j = 0;
  while (j < out.length) {
    const ch = out[j];
    if (ch === '"') {
      const start = j;
      j += 1;
      while (j < out.length) {
        const s = out[j];
        if (s === "\\") {
          j += 2;
          continue;
        }
        j += 1;
        if (s === '"') break;
      }
      relaxed += out.slice(start, j);
      continue;
    }
    if (ch === ",") {
      let k = j + 1;
      while (k < out.length && /\s/.test(out[k])) k += 1;
      if (out[k] === "}" || out[k] === "]") {
        relaxed += " ";
        j += 1;
        continue;
      }
    }
    relaxed += ch;
    j += 1;
  }
  return relaxed;
}

/** `JSON.parse` over `relaxJson`. Throws `SyntaxError` with real offsets. */
export function parseLenientJson<T = unknown>(text: string): T {
  return JSON.parse(relaxJson(text)) as T;
}
