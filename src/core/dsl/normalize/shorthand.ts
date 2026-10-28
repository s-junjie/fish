import { asNumber, canonicalKey, isPlainObject, FONT_WEIGHT_WORDS, SIZE_MODE_ALIASES } from "./shared";

/**
 * Expands a compact element `sizing` string shorthand into `{ width, height }`.
 *
 * Examples:
 * - `"fill"` -> `{ width: "fill", height: "fill" }`
 * - `"hug"` / `"fit-content"` -> `{ width: "fit-content", height: "fit-content" }`
 * - `"max-content"` -> `{ width: "max-content", height: "fit-content" }`
 * - `"fill hug"` -> `{ width: "fill", height: "fit-content" }`
 */
export function expandSizingShorthand(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  const parts = raw.trim().split(/[\s,/]+/).filter(Boolean);
  if (parts.length === 1) {
    const mode = SIZE_MODE_ALIASES[canonicalKey(parts[0])];
    if (!mode) return raw;
    return {
      width: mode,
      height: mode === "max-content" ? "fit-content" : mode
    };
  }
  if (parts.length === 2) {
    const w = SIZE_MODE_ALIASES[canonicalKey(parts[0])];
    const h = SIZE_MODE_ALIASES[canonicalKey(parts[1])];
    if (!w || !h) return raw;
    return {
      width: w,
      height: h === "max-content" ? "fit-content" : h
    };
  }
  return raw;
}

const COLOR_TOKEN_RE = /^(#[0-9a-fA-F]{3,8}|rgba?\([^)]+\)|hsla?\([^)]+\)|oklch\([^)]+\))$/i;
const SIZE_LINE_TOKEN_RE = /^(\d+(?:\.\d+)?)(?:px)?(?:\/(\d+(?:\.\d+)?%?))?$/i;

/**
 * Expands a compact text `style` string shorthand into a `TextStyle` input object.
 *
 * Examples:
 * - `"700 24/1.2 Inter #FFFFFF"`
 * - `"600 14/1.4 #9BA4AB center uppercase"`
 * - `"16 #ECF3F8"`
 */
export function expandTextStyleShorthand(raw: unknown): Record<string, unknown> {
  if (isPlainObject(raw)) return raw;
  if (typeof raw !== "string" || !raw.trim()) return {};

  const out: Record<string, unknown> = {};
  const tokens = raw.trim().match(/(?:rgba?|hsla?|oklch)\([^)]+\)|"[^"]+"|'[^']+'|\S+/gi) ?? [];
  const familyParts: string[] = [];

  // Pre-scan to see how many pure numeric/size tokens exist so "700 20" assigns
  // 700 to weight and 20 to fontSize, whereas a single "20" assigns 20 to fontSize.
  const sizeLikeIndices: number[] = [];
  tokens.forEach((tok, idx) => {
    if (SIZE_LINE_TOKEN_RE.test(tok)) sizeLikeIndices.push(idx);
  });

  tokens.forEach((tok, idx) => {
    const clean = tok.replace(/^['"]|['"]$/g, "");
    const lower = canonicalKey(clean);

    if (COLOR_TOKEN_RE.test(clean)) {
      out.color = clean;
      return;
    }
    if (lower === "left" || lower === "center" || lower === "right" || lower === "justify") {
      out.align = lower;
      return;
    }
    if (lower === "top" || lower === "middle" || lower === "bottom") {
      out.verticalAlign = lower;
      return;
    }
    if (lower === "uppercase" || lower === "lowercase" || lower === "capitalize") {
      out.textTransform = lower;
      return;
    }
    if (lower === "italic") {
      out.fontStyle = "italic";
      return;
    }
    if (lower === "tabular-nums" || lower === "tabular") {
      out.fontVariantNumeric = "tabular-nums";
      return;
    }
    if (lower === "underline" || lower === "line-through") {
      out.textDecoration = [lower];
      return;
    }
    if (lower === "bold" || lower === "normal" || lower in FONT_WEIGHT_WORDS) {
      out.fontWeight = lower === "bold" || lower === "normal" ? lower : FONT_WEIGHT_WORDS[lower];
      return;
    }
    if (lower.startsWith("ls=")) {
      const ls = asNumber(lower.slice(3));
      if (ls !== undefined) out.letterSpacing = ls;
      return;
    }

    const sizeMatch = SIZE_LINE_TOKEN_RE.exec(clean);
    if (sizeMatch) {
      const n = Number(sizeMatch[1]);
      const lh = sizeMatch[2];
      // Treat a multiple of 100 (100..900) with no `/lineHeight` as fontWeight
      // when another size token follows it.
      if (
        !lh &&
        !clean.toLowerCase().endsWith("px") &&
        n >= 100 &&
        n <= 900 &&
        n % 100 === 0 &&
        sizeLikeIndices.length > 1 &&
        idx === sizeLikeIndices[0] &&
        out.fontWeight === undefined
      ) {
        out.fontWeight = n;
        return;
      }
      out.fontSize = n;
      if (lh !== undefined) out.lineHeight = lh;
      return;
    }

    familyParts.push(clean);
  });

  if (familyParts.length > 0) {
    out.fontFamily = familyParts.join(" ");
  }

  return out;
}
