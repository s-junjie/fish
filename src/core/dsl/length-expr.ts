import type { CornerRadius } from "./types";

/**
 * Shared CSS math & length-expression parser/evaluator (`%`, `px`, `rem`,
 * `calc()`, `min()`, `max()`, `clamp()`).
 *
 * Used once across `resolve-values` (compile-time constant folding), element
 * normalization (`width` / `height` / `min*` / `max*` / `border-radius`), and
 * runtime layout passes so dynamic percentages re-evaluate identically when a
 * container changes size.
 */

type ValueKind = "len" | "num";

export interface LinearLength {
  pct: number;
  px: number;
  isLen: boolean;
}

type Token =
  | { t: "num"; v: number }
  | { t: "px"; v: number }
  | { t: "pct"; v: number }
  | { t: "op"; v: "+" | "-" | "*" | "/" }
  | { t: "(" }
  | { t: ")" }
  | { t: "," }
  | { t: "fn"; name: "calc" | "min" | "max" | "clamp" };

type AstNode =
  | { t: "num"; v: number }
  | { t: "px"; v: number }
  | { t: "pct"; v: number }
  | { t: "neg"; inner: AstNode }
  | { t: "bin"; op: "+" | "-" | "*" | "/"; l: AstNode; r: AstNode }
  | { t: "fn"; name: "calc" | "min" | "max" | "clamp"; args: AstNode[] };

const FUNCTIONS = new Set(["calc", "min", "max", "clamp"]);

const roundNum = (n: number): number => {
  const r = Math.round(n * 1e6) / 1e6;
  return Object.is(r, -0) ? 0 : r;
};

const round2 = (n: number): number => {
  const r = Math.round(n * 100) / 100;
  return Object.is(r, -0) ? 0 : r;
};

/** Split whitespace-separated CSS tokens while keeping `calc(...)` intact. */
export function splitTopLevelWhitespace(input: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === "(") {
      depth++;
      if (start === -1) start = i;
    } else if (ch === ")") {
      depth--;
      if (start === -1) start = i;
    } else if (depth === 0 && /\s/.test(ch)) {
      if (start !== -1) {
        out.push(input.slice(start, i));
        start = -1;
      }
    } else if (start === -1) {
      start = i;
    }
  }
  if (start !== -1) out.push(input.slice(start));
  return out;
}

/** Split on top-level `/` (for `border-radius` `rx / ry`), never inside `calc()`. */
export function splitTopLevelSlash(input: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (depth === 0 && ch === "/") {
      parts.push(input.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(input.slice(start).trim());
  return parts;
}

function tokenize(input: string, rootRem: number): Token[] | undefined {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === "(" || ch === ")" || ch === ",") {
      tokens.push({ t: ch });
      i++;
      continue;
    }
    if (ch === "+" || ch === "-" || ch === "*" || ch === "/") {
      tokens.push({ t: "op", v: ch });
      i++;
      continue;
    }
    const num = /^\d*\.?\d+/.exec(input.slice(i));
    if (num) {
      const val = Number(num[0]);
      if (!Number.isFinite(val)) return undefined;
      let j = i + num[0].length;
      const tail = input.slice(j);
      const unit = /^(px|rem|%)/i.exec(tail)?.[1]?.toLowerCase();
      if (!unit) {
        // Reject unsupported unit suffixes attached directly to a number (e.g. `2em`, `50vw`).
        if (/^[a-z%]/i.test(tail)) return undefined;
        tokens.push({ t: "num", v: val });
      } else if (unit === "%") {
        tokens.push({ t: "pct", v: val });
        j += 1;
      } else {
        tokens.push({ t: "px", v: val * (unit === "rem" ? rootRem : 1) });
        j += unit.length;
      }
      i = j;
      continue;
    }
    const name = /^[a-z]+/i.exec(input.slice(i));
    if (name && FUNCTIONS.has(name[0].toLowerCase())) {
      tokens.push({ t: "fn", name: name[0].toLowerCase() as "calc" | "min" | "max" | "clamp" });
      i += name[0].length;
      continue;
    }
    return undefined;
  }
  return tokens;
}

function parseAst(input: string, rootRem: number): { ast: AstNode; kind: ValueKind } | undefined {
  const tokens = tokenize(input, rootRem);
  if (!tokens || tokens.length === 0) return undefined;
  let i = 0;
  const peek = (): Token | undefined => tokens[i];

  const addSub = (): AstNode | null => {
    let left = mulDiv();
    if (!left) return null;
    for (;;) {
      const t = peek();
      if (t?.t !== "op" || (t.v !== "+" && t.v !== "-")) break;
      i++;
      const right = mulDiv();
      if (!right) return null;
      left = { t: "bin", op: t.v, l: left, r: right };
    }
    return left;
  };

  const mulDiv = (): AstNode | null => {
    let left = factor();
    if (!left) return null;
    for (;;) {
      const t = peek();
      if (t?.t !== "op" || (t.v !== "*" && t.v !== "/")) break;
      i++;
      const right = factor();
      if (!right) return null;
      left = { t: "bin", op: t.v, l: left, r: right };
    }
    return left;
  };

  const factor = (): AstNode | null => {
    const t = peek();
    if (!t) return null;
    if (t.t === "op" && (t.v === "+" || t.v === "-")) {
      i++;
      const inner = factor();
      if (!inner) return null;
      return t.v === "-" ? { t: "neg", inner } : inner;
    }
    if (t.t === "num" || t.t === "px" || t.t === "pct") {
      i++;
      return t;
    }
    if (t.t === "(") {
      i++;
      const inner = addSub();
      if (!inner || peek()?.t !== ")") return null;
      i++;
      return inner;
    }
    if (t.t === "fn") {
      i++;
      if (peek()?.t !== "(") return null;
      i++;
      const args: AstNode[] = [];
      for (;;) {
        const arg = addSub();
        if (!arg) return null;
        args.push(arg);
        if (peek()?.t === ",") {
          i++;
          continue;
        }
        break;
      }
      if (peek()?.t !== ")") return null;
      i++;
      if (t.name === "calc" && args.length !== 1) return null;
      if ((t.name === "min" || t.name === "max") && args.length === 0) return null;
      if (t.name === "clamp" && args.length !== 3) return null;
      return { t: "fn", name: t.name, args };
    }
    return null;
  };

  const ast = addSub();
  if (!ast || i !== tokens.length) return undefined;
  const kind = inferKind(ast);
  if (!kind) return undefined;
  return { ast, kind };
}

function inferKind(node: AstNode): ValueKind | undefined {
  switch (node.t) {
    case "px":
    case "pct":
      return "len";
    case "num":
      return "num";
    case "neg":
      return inferKind(node.inner);
    case "bin": {
      const l = inferKind(node.l);
      const r = inferKind(node.r);
      if (!l || !r) return undefined;
      if (node.op === "+" || node.op === "-") return l === r ? l : undefined;
      if (node.op === "*") return l === "num" ? r : r === "num" ? l : undefined;
      if (node.op === "/") {
        if (r !== "num") return undefined;
        const rv = evalAst(node.r, 100);
        return rv === undefined || rv === 0 ? undefined : l;
      }
      return undefined;
    }
    case "fn": {
      const kinds = node.args.map(inferKind);
      if (kinds.some((k) => !k)) return undefined;
      if (!kinds.every((k) => k === kinds[0])) return undefined;
      return kinds[0];
    }
  }
}

function evalAst(node: AstNode, refPx: number): number | undefined {
  switch (node.t) {
    case "px":
    case "num":
      return node.v;
    case "pct":
      return (node.v / 100) * refPx;
    case "neg": {
      const v = evalAst(node.inner, refPx);
      return v === undefined ? undefined : -v;
    }
    case "bin": {
      const l = evalAst(node.l, refPx);
      const r = evalAst(node.r, refPx);
      if (l === undefined || r === undefined) return undefined;
      if (node.op === "+") return l + r;
      if (node.op === "-") return l - r;
      if (node.op === "*") return l * r;
      return r === 0 ? undefined : l / r;
    }
    case "fn": {
      const vals = node.args.map((a) => evalAst(a, refPx));
      if (vals.some((v) => v === undefined)) return undefined;
      const nums = vals as number[];
      if (node.name === "calc") return nums[0];
      if (node.name === "min") return Math.min(...nums);
      if (node.name === "max") return Math.max(...nums);
      return Math.min(nums[2], Math.max(nums[0], nums[1]));
    }
  }
}

function tryLinearFold(node: AstNode): LinearLength | undefined {
  switch (node.t) {
    case "px":
      return { pct: 0, px: node.v, isLen: true };
    case "pct":
      return { pct: node.v, px: 0, isLen: true };
    case "num":
      return { pct: 0, px: node.v, isLen: false };
    case "neg": {
      const inner = tryLinearFold(node.inner);
      return inner ? { pct: -inner.pct, px: -inner.px, isLen: inner.isLen } : undefined;
    }
    case "bin": {
      const l = tryLinearFold(node.l);
      const r = tryLinearFold(node.r);
      if (!l || !r) return undefined;
      if (node.op === "+" || node.op === "-") {
        if (l.isLen !== r.isLen) return undefined;
        const s = node.op === "+" ? 1 : -1;
        return { pct: l.pct + s * r.pct, px: l.px + s * r.px, isLen: l.isLen };
      }
      if (node.op === "*") {
        if (l.isLen && r.isLen) return undefined;
        if (!l.isLen && l.pct === 0) return { pct: l.px * r.pct, px: l.px * r.px, isLen: r.isLen };
        if (!r.isLen && r.pct === 0) return { pct: l.pct * r.px, px: l.px * r.px, isLen: l.isLen };
        return undefined;
      }
      if (r.isLen || r.pct !== 0 || r.px === 0) return undefined;
      return { pct: l.pct / r.px, px: l.px / r.px, isLen: l.isLen };
    }
    case "fn": {
      const args = node.args.map(tryLinearFold);
      if (args.some((a) => !a)) return undefined;
      const list = args as LinearLength[];
      if (node.name === "calc") return list[0];
      if (!list.every((a) => a.pct === 0)) return undefined;
      const vals = list.map((a) => a.px);
      const v =
        node.name === "min"
          ? Math.min(...vals)
          : node.name === "max"
            ? Math.max(...vals)
            : Math.min(vals[2], Math.max(vals[0], vals[1]));
      return { pct: 0, px: v, isLen: list[0].isLen };
    }
  }
}

function astHasPercent(node: AstNode): boolean {
  switch (node.t) {
    case "pct":
      return true;
    case "px":
    case "num":
      return false;
    case "neg":
      return astHasPercent(node.inner);
    case "bin":
      return astHasPercent(node.l) || astHasPercent(node.r);
    case "fn":
      return node.args.some(astHasPercent);
  }
}

function formatLinearInner(lin: LinearLength): string {
  const pct = roundNum(lin.pct);
  const px = roundNum(lin.px);
  if (pct === 0) return `${px}${lin.isLen ? "px" : ""}`;
  if (px === 0) return `${pct}%`;
  return `${pct}% ${px > 0 ? "+" : "-"} ${Math.abs(px)}px`;
}

function formatAst(node: AstNode): string {
  const folded = tryLinearFold(node);
  if (folded) {
    const inner = formatLinearInner(folded);
    return folded.pct !== 0 && folded.px !== 0 ? `calc(${inner})` : inner;
  }
  switch (node.t) {
    case "num":
      return String(roundNum(node.v));
    case "px":
      return `${roundNum(node.v)}px`;
    case "pct":
      return `${roundNum(node.v)}%`;
    case "neg":
      return `-${formatAst(node.inner)}`;
    case "bin": {
      const l = formatAstRaw(node.l);
      const r = formatAstRaw(node.r);
      return `calc(${l} ${node.op} ${r})`;
    }
    case "fn": {
      if (node.name === "calc") {
        const inner = formatAstRaw(node.args[0]);
        return inner.startsWith("calc(") ? inner : `calc(${inner})`;
      }
      return `${node.name}(${node.args.map(formatAstRaw).join(", ")})`;
    }
  }
}

function formatAstRaw(node: AstNode): string {
  const folded = tryLinearFold(node);
  if (folded) return formatLinearInner(folded);
  switch (node.t) {
    case "num":
      return String(roundNum(node.v));
    case "px":
      return `${roundNum(node.v)}px`;
    case "pct":
      return `${roundNum(node.v)}%`;
    case "neg":
      return `-${formatAstRaw(node.inner)}`;
    case "bin":
      return `${formatAstRaw(node.l)} ${node.op} ${formatAstRaw(node.r)}`;
    case "fn":
      return node.name === "calc"
        ? `(${formatAstRaw(node.args[0])})`
        : `${node.name}(${node.args.map(formatAstRaw).join(", ")})`;
  }
}

/** Constant px/unitless evaluator matching `resolve-values` (`undefined` when `%` appears). */
export function evalConstantPx(input: string, rootRem = 16): number | undefined {
  const parsed = parseAst(input.trim(), rootRem);
  if (!parsed || astHasPercent(parsed.ast)) return undefined;
  return evalAst(parsed.ast, 0);
}

/** Simplifies constant arithmetic / `rem` / `var` inside a single length or math expression. */
export function simplifyLengthExpr(input: string, rootRem = 16): string | undefined {
  const parsed = parseAst(input.trim(), rootRem);
  if (!parsed) return undefined;
  const lin = tryLinearFold(parsed.ast);
  if (lin) {
    if (Math.abs(lin.pct) < 1e-9) return `${roundNum(lin.px)}px`;
    if (Math.abs(lin.px) < 1e-9) return `${roundNum(lin.pct)}%`;
    return `calc(${roundNum(lin.pct)}% ${lin.px > 0 ? "+" : "-"} ${roundNum(Math.abs(lin.px))}px)`;
  }
  return formatAst(parsed.ast);
}

/** Evaluate any CSS length expression against a container dimension in px. */
export function evalLengthExpr(expr: string, refPx: number, rootRem = 16): number | undefined {
  if (!Number.isFinite(refPx)) return undefined;
  const parsed = parseAst(expr.trim(), rootRem);
  if (!parsed) return undefined;
  if (parsed.kind !== "len") {
    const v = evalAst(parsed.ast, refPx);
    return v === 0 ? 0 : undefined;
  }
  return evalAst(parsed.ast, refPx);
}

export interface ParsedDynamicLength {
  hasPercent: boolean;
  expr?: string;
  constantPx?: number;
}

/**
 * Parses `width` / `height` / `min*` / `max*` CSS values that contain `%` or
 * `calc`/`min`/`max`/`clamp` expressions. Pure `px`/`rem`/constant numbers
 * fold into `constantPx`; `%`-bearing expressions keep canonical `expr`.
 */
export function parseDynamicLength(raw: unknown, rootRem = 16): ParsedDynamicLength | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const parsed = parseAst(trimmed, rootRem);
  if (!parsed) return undefined;
  if (parsed.kind !== "len") {
    const v = evalAst(parsed.ast, 0);
    if (v === 0) return { hasPercent: false, constantPx: 0 };
    return undefined;
  }
  const lin = tryLinearFold(parsed.ast);
  if (lin) {
    if (Math.abs(lin.pct) < 1e-9) {
      if (lin.px < 0) return undefined;
      return { hasPercent: false, constantPx: round2(lin.px) };
    }
    // Reject purely negative percentage expressions like `"-50%"`.
    if (lin.pct < 0 && lin.px <= 0) return undefined;
    const expr =
      Math.abs(lin.px) < 1e-9
        ? `${roundNum(lin.pct)}%`
        : `calc(${roundNum(lin.pct)}% ${lin.px > 0 ? "+" : "-"} ${roundNum(Math.abs(lin.px))}px)`;
    return { hasPercent: true, expr };
  }
  // Non-linear (`min`/`max`/`clamp` mixing `%` and `px`): reject only if
  // definitively negative across sample box widths.
  const s1 = evalAst(parsed.ast, 10);
  const s2 = evalAst(parsed.ast, 1000);
  if (s1 === undefined || s2 === undefined || (s1 < 0 && s2 < 0)) return undefined;
  return { hasPercent: true, expr: formatAst(parsed.ast) };
}

function expandFourCorners<T>(values: readonly T[]): [T, T, T, T] {
  if (values.length === 1) return [values[0], values[0], values[0], values[0]];
  if (values.length === 2) return [values[0], values[1], values[0], values[1]];
  if (values.length === 3) return [values[0], values[1], values[2], values[1]];
  return [values[0], values[1], values[2], values[3]];
}

export function cornerRadiusEqual(a: CornerRadius | undefined, b: CornerRadius | undefined): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === 4 && b.length === 4 && a.every((v, i) => v === b[i]);
  }
  return false;
}

export function collapseCorners(corners: readonly [number, number, number, number]): CornerRadius {
  return corners.every((v) => v === corners[0]) ? Math.max(0, corners[0]) : [
    Math.max(0, corners[0]),
    Math.max(0, corners[1]),
    Math.max(0, corners[2]),
    Math.max(0, corners[3])
  ];
}

interface ParsedCornerToken {
  expr: string;
  hasPercent: boolean;
  constantPx?: number;
}

function parseRadiusToken(token: string, rootRem: number): ParsedCornerToken | undefined {
  const dyn = parseDynamicLength(token, rootRem);
  if (dyn) {
    if (!dyn.hasPercent && dyn.constantPx !== undefined) {
      return { expr: dyn.constantPx === 0 ? "0" : `${dyn.constantPx}px`, hasPercent: false, constantPx: dyn.constantPx };
    }
    if (dyn.expr) return { expr: dyn.expr, hasPercent: true };
    return undefined;
  }
  const trimmed = token.trim();
  if (/^\d*\.?\d+$/.test(trimmed)) {
    const v = round2(Number(trimmed));
    if (Number.isFinite(v) && v >= 0) {
      return { expr: v === 0 ? "0" : `${v}px`, hasPercent: false, constantPx: v };
    }
  }
  return undefined;
}

export interface ResolvedBorderRadiusSpec {
  radius: CornerRadius;
  radiusY?: CornerRadius;
  expr?: string;
}

/**
 * Parses and evaluates a CSS `border-radius` expression (including `/`
 * elliptical radii `rx / ry`, 1-4 corner shorthand, `%`, `px`, `rem`, and
 * `calc`/`min`/`max`/`clamp`) against `{ width, height }`.
 */
export function resolveDynamicBorderRadius(
  raw: string,
  box: { width: number; height: number },
  rootRem = 16
): ResolvedBorderRadiusSpec | undefined {
  const slashParts = splitTopLevelSlash(raw.trim());
  if (slashParts.length === 0 || slashParts.length > 2) return undefined;
  const hRawTokens = splitTopLevelWhitespace(slashParts[0]);
  if (hRawTokens.length < 1 || hRawTokens.length > 4) return undefined;
  const hParsed = hRawTokens.map((t) => parseRadiusToken(t, rootRem));
  if (hParsed.some((p) => !p)) return undefined;
  const hTokens = hParsed as ParsedCornerToken[];

  let vTokens = hTokens;
  if (slashParts.length === 2) {
    const vRawTokens = splitTopLevelWhitespace(slashParts[1]);
    if (vRawTokens.length < 1 || vRawTokens.length > 4) return undefined;
    const vParsed = vRawTokens.map((t) => parseRadiusToken(t, rootRem));
    if (vParsed.some((p) => !p)) return undefined;
    vTokens = vParsed as ParsedCornerToken[];
  }

  const hasPercent = hTokens.some((t) => t.hasPercent) || vTokens.some((t) => t.hasPercent);
  const evalCorner = (tok: ParsedCornerToken, ref: number): number => {
    if (!tok.hasPercent && tok.constantPx !== undefined) return Math.max(0, round2(tok.constantPx));
    if (!tok.expr) return 0;
    const v = evalLengthExpr(tok.expr, ref, rootRem);
    return v !== undefined && Number.isFinite(v) ? Math.max(0, round2(v)) : 0;
  };

  const rx4 = expandFourCorners(hTokens).map((t) => evalCorner(t, box.width)) as [number, number, number, number];
  const ry4 = expandFourCorners(vTokens).map((t) => evalCorner(t, box.height)) as [number, number, number, number];
  const rx = collapseCorners(rx4);
  const ry = collapseCorners(ry4);

  const hExprStr = hTokens.map((t) => t.expr).join(" ");
  const vExprStr = vTokens.map((t) => t.expr).join(" ");
  const expr = hasPercent
    ? (slashParts.length === 2 ? `${hExprStr} / ${vExprStr}` : hExprStr)
    : undefined;

  return {
    radius: rx,
    ...(cornerRadiusEqual(rx, ry) ? {} : { radiusY: ry }),
    ...(expr !== undefined ? { expr } : {})
  };
}
