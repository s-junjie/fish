/**
 * The one reader of `t()` call sites. The build plugin rewrites from it and the
 * reachability pass decides what ships from it, so a site the lexer misreads is
 * a key that silently becomes a raw path in the UI.
 *
 * Regex was not enough: `t(cond ? "a.b" : "c.d")` and a template-literal path
 * both have to be seen, and a quote inside a string (`"can't"`) makes every
 * naive scanner pair the wrong delimiters and hide the calls in between.
 */

export interface Token {
  kind: "string" | "template" | "ident" | "punct" | "number";
  start: number;
  end: number;
  /** string: the value without quotes. template: the text before the first `${`. */
  value: string;
  /** template only: it interpolates, so its tail is not a literal any more. */
  interpolates?: boolean;
  /** How many `${}` bodies deep this token was lexed; 0 is the file itself. */
  nested?: number;
}

export interface KeyLiteral {
  start: number;
  end: number;
  key: string;
}

export interface TCall {
  /** Every string literal inside the first argument that names a dictionary key. */
  literals: KeyLiteral[];
  /**
   * The slot rewrite is safe only when the argument is a plain expression over
   * key literals. A nested call (`t(pick("a.b"))`) is left alone: its literal is
   * a string argument, not the key itself.
   */
  rewriteable: boolean;
}

export interface SourceAnalysis {
  calls: TCall[];
  /**
   * Every key literal in the file, with its span. A caller that rewrites call
   * sites needs the span; one deciding what the runtime can still look up needs
   * to tell a key that follows a variable (`labelKey: "a.b"`) from one that was
   * inlined at its only site.
   */
  literals: KeyLiteral[];
  /**
   * Static heads that can build a key at runtime. Collected from the whole file,
   * not just from inside `t()`: `const key = `a.b.${field}`; t(key)` is a real
   * path, and a head missed here is a key pruned from the table.
   */
  prefixes: string[];
  /** `t("x")` where `x` has no entry — the plugin turns these into a build error. */
  unknown: string[];
}

const REGEX_PREFIX = new Set([
  "(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", ">", "+", "-", "*", "%", "~", "^", "<",
  "=>", "return", "typeof", "instanceof", "case", "in", "of", "do", "else"
]);

function scanRegex(code: string, i: number): number {
  const n = code.length;
  i++;
  let inClass = false;
  while (i < n) {
    const c = code[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "\n") return i;
    if (inClass) {
      if (c === "]") inClass = false;
    } else if (c === "[") {
      inClass = true;
    } else if (c === "/") {
      return i + 1;
    }
    i++;
  }
  return n;
}

/** Skips a `${ ... }` body, honouring nested strings, templates and braces. */
function skipInterpolation(code: string, i: number): number {
  const n = code.length;
  let depth = 1;
  while (i < n) {
    const c = code[i];
    if (c === '"' || c === "'") {
      i++;
      while (i < n && code[i] !== c) i += code[i] === "\\" ? 2 : 1;
      i++;
      continue;
    }
    if (c === "`") {
      i++;
      while (i < n && code[i] !== "`") {
        if (code[i] === "\\") {
          i += 2;
          continue;
        }
        if (code[i] === "$" && code[i + 1] === "{") {
          i = skipInterpolation(code, i + 2);
          continue;
        }
        i++;
      }
      i++;
      continue;
    }
    if (c === "/" && code[i + 1] === "/") {
      i = code.indexOf("\n", i);
      if (i < 0) return n;
      continue;
    }
    if (c === "/" && code[i + 1] === "*") {
      const end = code.indexOf("*/", i + 2);
      i = end < 0 ? n : end + 2;
      continue;
    }
    if (c === "{" || c === "(" || c === "[") depth++;
    else if (c === "}" || c === ")" || c === "]") {
      depth--;
      if (depth === 0) return i + 1;
    }
    i++;
  }
  return n;
}

const PUNCT = "(){}[],;:?=><!+-*/%&|^~.";

export function lex(code: string): Token[] {
  const out: Token[] = [];
  const n = code.length;
  let i = 0;
  while (i < n) {
    const c = code[i];
    if (c === "\n" || c === " " || c === "\t" || c === "\r") {
      i++;
      continue;
    }
    if (c === "/" && code[i + 1] === "/") {
      const end = code.indexOf("\n", i);
      i = end < 0 ? n : end;
      continue;
    }
    if (c === "/" && code[i + 1] === "*") {
      const end = code.indexOf("*/", i + 2);
      i = end < 0 ? n : end + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      const start = i;
      i++;
      let value = "";
      while (i < n && code[i] !== c && code[i] !== "\n") {
        if (code[i] === "\\") {
          value += code[i + 1] ?? "";
          i += 2;
          continue;
        }
        value += code[i++];
      }
      if (code[i] === c) i++;
      out.push({ kind: "string", start, end: i, value });
      continue;
    }
    if (c === "`") {
      const start = i;
      i++;
      let head = "";
      let interpolates = false;
      while (i < n) {
        if (code[i] === "\\") {
          if (!interpolates) head += code[i + 1] ?? "";
          i += 2;
          continue;
        }
        if (code[i] === "`") {
          i++;
          break;
        }
        if (code[i] === "$" && code[i + 1] === "{") {
          interpolates = true;
          const end = skipInterpolation(code, i + 2);
          // Code inside `${}` is code: `\`${t("a.b")}\`` is a call site, and a
          // call site this reader cannot see is a key the table would drop.
          for (const inner of lex(code.slice(i + 2, end - 1))) {
            out.push({ ...inner, nested: (inner.nested ?? 0) + 1, start: inner.start + i + 2, end: inner.end + i + 2 });
          }
          i = end;
          continue;
        }
        if (!interpolates) head += code[i];
        i++;
      }
      out.push({ kind: "template", start, end: i, value: head, interpolates });
      continue;
    }
    if (c === "/") {
      // A JSX tag's `/>` and `</` are not division: read as a regex, the scan
      // runs to the next slash and swallows every call site in between, which
      // reads downstream as "key referenced nowhere".
      if (code[i + 1] === ">") {
        out.push({ kind: "punct", start: i, end: i + 2, value: "/>" });
        i += 2;
        continue;
      }
      if (code[i - 1] === "<") {
        out.push({ kind: "punct", start: i, end: i + 1, value: "</" });
        i++;
        continue;
      }
      const previous = out[out.length - 1];
      const regexAllowed =
        !previous || (previous.kind === "punct" && REGEX_PREFIX.has(previous.value)) ||
        (previous.kind === "ident" && REGEX_PREFIX.has(previous.value));
      if (regexAllowed) {
        const start = i;
        i = scanRegex(code, i);
        out.push({ kind: "punct", start, end: i, value: "/regex/" });
        continue;
      }
      out.push({ kind: "punct", start: i, end: i + 1, value: "/" });
      i++;
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      const start = i;
      while (i < n && /[A-Za-z0-9_$]/.test(code[i])) i++;
      out.push({ kind: "ident", start, end: i, value: code.slice(start, i) });
      continue;
    }
    if (/[0-9]/.test(c)) {
      const start = i;
      while (i < n && /[0-9a-zA-Z_.]/.test(code[i])) i++;
      out.push({ kind: "number", start, end: i, value: code.slice(start, i) });
      continue;
    }
    if (PUNCT.includes(c)) {
      out.push({ kind: "punct", start: i, end: i + 1, value: c });
      i++;
      continue;
    }
    i++;
  }
  return out;
}

function isPunct(token: Token | undefined, value: string): boolean {
  return !!token && token.kind === "punct" && token.value === value;
}

/**
 * The keys a runtime-built path can reach. A head only counts where the key
 * continues at a word boundary — `pen.mode` → `pen.modeText` is a path, `pat` →
 * `pattern.fill` is a coincidental substring of an unrelated literal.
 */
export function expandPrefixes(prefixes: Iterable<string>, keys: Iterable<string>): Set<string> {
  const out = new Set<string>();
  const sorted = [...keys].sort();
  for (const prefix of prefixes) {
    if (!prefix) continue;
    // Matches are contiguous in a sorted list, so the head locates the range and
    // the walk only visits the keys it is about to keep.
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid] < prefix) lo = mid + 1;
      else hi = mid;
    }
    for (let i = lo; i < sorted.length && sorted[i].startsWith(prefix); i++) {
      const key = sorted[i];
      const tail = key[prefix.length];
      if (tail === undefined || prefix.endsWith(".") || (tail >= "A" && tail <= "Z")) out.add(key);
    }
  }
  return out;
}

export function analyzeSource(code: string, isKey: (key: string) => boolean): SourceAnalysis {
  const tokens = lex(code);
  const calls: TCall[] = [];
  const literals: KeyLiteral[] = [];
  const prefixes = new Set<string>();
  const unknown = new Set<string>();

  for (const token of tokens) {
    if (token.kind === "string") {
      if (isKey(token.value)) literals.push({ start: token.start, end: token.end, key: token.value });
      if (token.value.endsWith(".")) prefixes.add(token.value);
    } else if (token.kind === "template" && token.interpolates && token.value) {
      prefixes.add(token.value);
    }
  }

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.kind !== "ident" || token.value !== "t") continue;
    if (i > 0 && isPunct(tokens[i - 1], ".")) continue;
    if (!isPunct(tokens[i + 1], "(")) continue;

    // A call inside `${}` is its own site: tokens from a deeper body belong to
    // it, not to this argument.
    const level = token.nested ?? 0;
    let depth = 0;
    let close = -1;
    let argEnd = -1;
    for (let j = i + 1; j < tokens.length; j++) {
      const tk = tokens[j];
      if ((tk.nested ?? 0) !== level) continue;
      if (tk.kind !== "punct") continue;
      if (tk.value === "(" || tk.value === "[" || tk.value === "{") depth++;
      else if (tk.value === ")" || tk.value === "]" || tk.value === "}") {
        depth--;
        if (depth === 0) {
          close = j;
          break;
        }
      } else if (tk.value === "," && depth === 1) {
        argEnd = j;
        break;
      }
    }
    if (close < 0 && argEnd < 0) continue;

    const arg = tokens.slice(i + 2, argEnd < 0 ? close : argEnd).filter((tk) => (tk.nested ?? 0) === level);
    const call: TCall = { literals: [], rewriteable: false };
    let nestedCall = false;
    let allKeys = true;
    // Only a value position holds a key. `t(cond === "x" ? "a.b" : "c.d")` has
    // three literals and one map to rewrite; a branch is the token after a
    // top-level `?` or `:` (or the whole argument, when it is one literal).
    let nesting = 0;
    let valuePosition = arg.length === 1 && arg[0].kind === "string";
    for (const tk of arg) {
      if (tk.kind === "punct") {
        if (tk.value === "(" || tk.value === "[" || tk.value === "{") nesting++;
        else if (tk.value === ")" || tk.value === "]" || tk.value === "}") nesting--;
        else if (nesting === 0 && (tk.value === "?" || tk.value === ":")) valuePosition = true;
        else if (nesting === 0) valuePosition = false;
        if (tk.value === "(") nestedCall = true;
        continue;
      }
      if (tk.kind === "string") {
        if (valuePosition) {
          if (isKey(tk.value)) call.literals.push({ start: tk.start, end: tk.end, key: tk.value });
          else {
            allKeys = false;
            unknown.add(tk.value);
          }
        }
      }
      valuePosition = false;
    }
    call.rewriteable = call.literals.length > 0 && allKeys && !nestedCall;
    calls.push(call);
  }

  return {
    calls,
    literals,
    prefixes: [...prefixes],
    unknown: [...unknown]
  };
}
