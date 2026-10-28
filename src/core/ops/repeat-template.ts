import { isObj } from "./op-primitives";

// `repeat` (§3.3 of docs/LOOP_EXPRESSION_PLAN.md): the authoring-time stamping
// macro. It is a verb the CLI runs, never a field the document keeps, so the only
// surface here is the substitution and the insert it drives once per entry.
export const REPEAT_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

interface RepeatBinding {
  index: number;
  entry: unknown;
  as: string;
}

type TemplatePart = { literal: string } | { token: string[] };

/**
 * Splits a template string into literals and tokens.
 *
 * `$$` is a literal `$`, and a `$` that begins neither `$$` nor a valid
 * identifier stays literal — so `"$5"` and `"price$"` survive untouched, which is
 * what keeps ordinary text (a price, a trailing dollar sign) out of the grammar.
 */
function parseTemplateString(input: string): TemplatePart[] {
  const parts: TemplatePart[] = [];
  let literal = "";
  let i = 0;
  const flush = (): void => {
    if (literal) {
      parts.push({ literal });
      literal = "";
    }
  };
  while (i < input.length) {
    const ch = input[i];
    if (ch !== "$") {
      literal += ch;
      i += 1;
      continue;
    }
    if (input[i + 1] === "$") {
      literal += "$";
      i += 2;
      continue;
    }
    const match = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*/.exec(input.slice(i + 1));
    if (!match) {
      literal += "$";
      i += 1;
      continue;
    }
    flush();
    parts.push({ token: match[0].split(".") });
    i += 1 + match[0].length;
  }
  flush();
  return parts;
}

/** Resolves `$head.seg…` against the loop scope; throws a caller-readable reason. */
function resolveRepeatToken(path: string[], binding: RepeatBinding): unknown {
  const [head, ...rest] = path;
  const token = `$${path.join(".")}`;
  let current: unknown;
  if (head === "i") current = binding.index;
  else if (head === binding.as) current = binding.entry;
  else {
    throw new Error(`unknown token "${token}" — no binding named "${head}" (bound: $i, $${binding.as})`);
  }
  for (const seg of rest) {
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(seg) || Number(seg) >= current.length) {
        throw new Error(`token "${token}": index "${seg}" is out of range`);
      }
      current = current[Number(seg)];
    } else if (isObj(current)) {
      if (!(seg in current)) throw new Error(`token "${token}": no key "${seg}"`);
      current = current[seg];
    } else {
      throw new Error(`token "${token}": cannot read "${seg}" from ${current === null ? "null" : typeof current}`);
    }
  }
  return current;
}

/**
 * Walks the whole template, descending through nested objects and arrays so a
 * repeated frame's `children`, `fills`, etc. are stamped too. A string that is
 * exactly one token keeps its native type; a token mixed with text is spliced
 * into a string.
 */
export function substituteTemplate(value: unknown, binding: RepeatBinding): unknown {
  if (typeof value === "string") {
    const parts = parseTemplateString(value);
    if (parts.length === 1 && "token" in parts[0]) return resolveRepeatToken(parts[0].token, binding);
    let out = "";
    for (const part of parts) {
      if ("literal" in part) {
        out += part.literal;
        continue;
      }
      const resolved = resolveRepeatToken(part.token, binding);
      out += resolved === null || resolved === undefined
        ? ""
        : typeof resolved === "object"
          ? JSON.stringify(resolved)
          : String(resolved);
    }
    return out;
  }
  if (Array.isArray(value)) return value.map((item) => substituteTemplate(item, binding));
  if (isObj(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) out[key] = substituteTemplate(val, binding);
    return out;
  }
  return value;
}
