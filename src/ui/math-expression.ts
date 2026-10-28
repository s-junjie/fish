/**
 * The arithmetic a person typed into a numeric field — `1000/2` → 500.
 *
 * Hand-written rather than `eval` / `new Function`: the string comes straight off
 * a text field, and this bundle is a single file whose payload must stay small
 * and evaluator-free.
 *
 * `null` means "not a complete expression" — the caller keeps the value it had.
 */

/** A lone number, returned untouched so `0.123456789` never comes back rounded. */
const BARE_NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
/** Sticky: matches a number literal at exactly `lastIndex`. */
const NUMBER_AT = /(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;

/** The digits a 12px field can show without the tail being cut off. */
const DISPLAY_PRECISION = 1e6;

export function evaluateMathExpression(raw: string): number | null {
  const src = raw.trim();
  if (!src) return null;

  if (BARE_NUMBER.test(src)) {
    const bare = Number(src);
    return Number.isFinite(bare) ? bare : null;
  }

  let i = 0;
  let complete = true;

  function skip() {
    while (src[i] === " " || src[i] === "\t") i++;
  }

  function fail(): number {
    complete = false;
    return 0;
  }

  function expression(): number {
    let left = term();
    for (;;) {
      skip();
      const op = src[i];
      if (op !== "+" && op !== "-") return left;
      i++;
      const right = term();
      left = op === "+" ? left + right : left - right;
    }
  }

  function term(): number {
    let left = unary();
    for (;;) {
      skip();
      const op = src[i];
      if (op !== "*" && op !== "/") return left;
      i++;
      const right = unary();
      left = op === "*" ? left * right : left / right;
    }
  }

  function unary(): number {
    skip();
    const sign = src[i];
    if (sign === "+" || sign === "-") {
      i++;
      const operand = unary();
      return sign === "-" ? -operand : operand;
    }
    return power();
  }

  function power(): number {
    const base = primary();
    skip();
    if (src[i] !== "^") return base;
    i++;
    return base ** unary();
  }

  function primary(): number {
    skip();
    if (src[i] === "(") {
      i++;
      const inner = expression();
      skip();
      if (src[i] !== ")") return fail();
      i++;
      return inner;
    }
    NUMBER_AT.lastIndex = i;
    const match = NUMBER_AT.exec(src);
    if (!match) return fail();
    i = NUMBER_AT.lastIndex;
    return Number(match[0]);
  }

  const result = expression();
  skip();
  if (!complete || i !== src.length || !Number.isFinite(result)) return null;

  // `0.1 + 0.2` is 0.30000000000000004, which no field can show. Only an
  // expression is cleaned — a bare number returned above never reaches here.
  return Math.round(result * DISPLAY_PRECISION) / DISPLAY_PRECISION;
}
