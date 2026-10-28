// AGENTS.md §3 and §4, enforced. A lint plugin nobody installs is a comment; this
// runs in the same `vitest run` as everything else, so a new ad-hoc hex or a
// hardcoded user-facing string fails the suite the moment it is written.
//
// Both rules are deliberately narrow — they flag the SHAPE of the mistake, not
// taste:
//
//   §3  a hex literal inside a Tailwind colour utility (`bg-[#1a1a1a]`). Tailwind
//       compiles it to a value no token can restyle or override. Inline styles are
//       not matched: `paint-row-style.ts` holds a conic gradient that cannot be
//       expressed as a utility at all, which §3 itself says.
//   §4  a user-facing English literal in an attribute whose job is to show a
//       string, or in JSX text.
//
// Two limits worth knowing, stated rather than hidden:
//
//   - A single-WORD JSX label ("Fill", "Stroke", "Size") is not detected. Telling
//     one apart from a TypeScript generic (`Set<string>`) by text alone is not
//     reliable, and a check that cries wolf gets deleted. The multi-word form is
//     caught, and so is every `title` / `placeholder` / `aria-label`.
//   - `label` is not in the attribute set: in this codebase `label` is a
//     component prop far more often than it is markup.

import { readdirSync, readFileSync, statSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

const UI_DIR = path.resolve(process.cwd(), "src/ui");

/** `hover:bg-[#1a1a1a]` — a Tailwind colour utility whose value is a raw hex. */
const HEX_UTILITY =
  /\b(?:hover:|focus:|active:|disabled:|group-hover:|peer-hover:|dark:)*[a-z-]*(?:bg|text|border|ring|divide|outline|from|via|to|shadow|fill|stroke|caret|accent|decoration)-\[(#[0-9a-fA-F]{3,8})\]/g;

/** Attributes whose entire purpose is to display a string to a person. */
const SHOWS_A_STRING = new Set(["title", "placeholder", "aria-label", "alt"]);

/**
 * Text between `>` and `<` that reads like prose: letters, digits, spaces and the
 * punctuation a sentence actually uses. Anything with a `;`, `:`, `=`, `|` or a
 * bracket is TypeScript that happened to sit between two angle brackets, and is
 * dropped by the class alone.
 */
const PROSE = /^[A-Za-z0-9][A-Za-z0-9 .,·()/'—–-]*$/;

/**
 * Files allowed to name a hex or a string in English, with why.
 *
 * `fonts.ts` is a data table of CSS font stacks — the values ARE the payload.
 * `paint-row-style.ts` holds the checkerboard's inline style.
 */
const ALLOW: Record<string, string> = {
  "fonts.ts": "a font-stack data table",
  "paint-row-style.ts": "an inline conic gradient Tailwind cannot express as a utility",
  // The two style modules that exist precisely to hold a value Tailwind cannot
  // express as a named utility. Naming the file is the point: the alternative
  // was the same literal copied into five call sites.
  "ring-style.ts": "the shared 1px dark ring",
  "slider-style.ts": "the shared slider knob and track metrics",
  // The canvas paints with SVG presentation attributes, where a token cannot
  // reach. Its palette therefore lives in one named module — and this allowlist
  // entry is what lets the SVG-hex check cover the whole canvas instead of
  // skipping it.
  "canvas-colors.ts": "the canvas SVG palette (a token cannot reach an SVG attribute)"
};

/** Comments and template literals, gone: neither can hold markup. */
function stripNonCode(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ")
    .replace(/`(?:\\.|[^`\\])*`/g, '""');
}

/**
 * Stock Tailwind palette utilities, e.g. `text-gray-400` or `bg-blue-500`.
 *
 * The theme defines semantic tokens (`ink`, `brand`, `rule`, …) precisely so a
 * surface can be restyled by editing `tailwind.config.js`. A raw palette step
 * compiles to a literal value no token can reach, so a token refactor silently
 * misses it — that is how the panel ended up with 432 call sites spread across
 * four greys and five blues, none of them restyleable together.
 *
 * `bg-black/NN` is exempt: it is a scrim over content whose colour is unknown
 * at author time, where neutral black is the only correct choice.
 */
/**
 * Utility classes that must resolve against the theme.
 *
 * LESSONS §31 is the reason this exists as a test rather than a convention:
 * Tailwind JIT emits an unmapped utility as nothing at all — no error, no
 * warning, just a transparent surface. `surface-elevated` was a dead
 * `bg-surface-elevated/40` at AutosaveBadge for exactly that long.
 *
 * Read from the config so adding a token needs no change here, and a typo'd
 * token name fails the suite the moment it is written.
 */
function themeColorNames(): Set<string> {
  const config = readFileSync(path.resolve(process.cwd(), "tailwind.config.js"), "utf8");
  const colors = config.slice(config.indexOf("colors:"));
  const names = new Set<string>();
  for (const m of colors.matchAll(/^\s{8}"?([a-zA-Z][a-zA-Z0-9-]*)"?:/gm)) names.add(m[1]);
  // Tailwind resolves a nested key under any prefix: `text: { dim }` yields
  // both `text-text-dim` and `bg-text-dim`, so a bare group name must also
  // register its leaves.
  for (const m of colors.matchAll(/^\s{8}([a-zA-Z][a-zA-Z0-9-]*):\s*\{([^}]*)\}/gm)) {
    names.add(m[1]);
    for (const leaf of m[2].matchAll(/"?([a-zA-Z][a-zA-Z0-9-]*)"?:/g)) {
      names.add(`${m[1]}-${leaf[1]}`);
    }
  }
  return names;
}

/** Drop `hover:` / `group-hover:` / `focus:` … so the base token can be checked. */
function stripVariants(token: string): string {
  return token.replace(/^(?:[a-z-]+:)+/, "");
}

/**
 * A stock palette step inside one class token: `bg-blue-500`, `text-gray-400`.
 *
 * `bg-black/NN` is excluded — it is a scrim over content whose colour is not
 * known at author time, where neutral black is the only correct value.
 *
 * `placeholder` is in the prefix list even though the sanctioned form is the
 * VARIANT `placeholder:text-ink-muted` (which `stripVariants` has already
 * reduced to `text-…`): the misspelling `placeholder-gray-600` carries no
 * colon, so nothing strips it and the token reaches this test whole.
 */
const STOCK_COLOR =
  /^(?:bg|text|border|ring|shadow|fill|stroke|divide|outline|decoration|from|via|to|placeholder)-(?:white|black|gray|grey|blue|red|green|yellow|purple|pink|slate|zinc|neutral|stone|orange|amber|lime|emerald|cyan|sky|violet|fuchsia|rose|indigo)(?:-\d+)?(?:\/\d+)?$/;

/** A colour utility of any kind, capturing the colour name. */
const COLOR_UTILITY =
  /^(?:bg|text|border|ring|shadow|fill|stroke|divide|outline|decoration|from|via|to|placeholder)-([a-zA-Z][a-zA-Z0-9-]*)(?:\/\d+)?$/;

/**
 * Utilities that are NOT colour names, even though they follow a colour
 * prefix. Three families:
 *
 *  - Tailwind's own scales and keyword utilities (`text-xs`, `rounded-lg`).
 *  - The theme's NON-colour token scales, which `themeColorNames` does not
 *    know about because they live under `fontSize` / `borderRadius` /
 *    `boxShadow`: `text-micro`, `rounded-panel`, `shadow-popover`. Missing
 *    these made the check report its own theme as broken.
 *  - Genuine keywords: `transparent`, `current`, `inherit`.
 */
const THEME_SCALES = new Set([
  // fontSize — the type scale. Every step carries its own tracking, so a size
  // name is never interchangeable with a bare `text-[Npx]`.
  "micro", "ui", "readout", "display", "displaySm",
  "row", "tab", "unit", "code", "meta", "tag",
  // borderRadius
  "panel", "ctl", "swatch", "pill", "dock", "dock-ctl",
  // boxShadow
  "popover", "modal",
]);

const NOT_A_COLOR = new RegExp(
  "^(?:" +
    [
      "xs", "sm", "base", "lg", "xl", "2xl", "3xl", "4xl", "5xl", "6xl", "7xl", "8xl", "9xl",
      "full", "screen", "min", "max", "fit", "auto",
      "current", "inherit", "transparent", "none",
      "left", "center", "right", "justify", "start", "end",
      "uppercase", "lowercase", "capitalize", "normal", "truncate", "nowrap", "wrap",
      "ellipsis", "clip", "top", "middle", "bottom", "baseline",
      "thin", "medium", "semibold", "bold", "italic",
      "underline", "line-through", "no-underline",
      "hidden", "block", "inline", "flex", "grid", "table", "contents",
      "fixed", "absolute", "relative", "static", "sticky",
      "tight", "loose", "wider", "widest", "tighter",
      "white", "black", "inset", "outline", "visible", "collapse",
      "separation", "spacing", "break", "continue", "ltr", "rtl",
      "contain", "cover", "dashed", "dotted", "double", "hidden",
    ].join("|") +
  ")$"
);

/** Line-style and shadow keywords that share a prefix. */
const NOT_A_SHADOW = /^(?:none|sm|md|lg|xl|2xl|inner|dashed|dotted|double)$/;

/**
 * Tailwind's gradient direction utilities.
 *
 * `bg-gradient-to-r` wears the `bg-` prefix but its "colour" slot is a
 * DIRECTION, not a colour — the actual stops come from `from-*` / `to-*`, which
 * are checked normally. Without this the leader rule's gradient read as an
 * unmapped token.
 */
const GRADIENT_DIRECTION = /^gradient-to-(?:t|tr|r|br|b|bl|l|tl)$/;

/* ── The four rules added once the sweeps were done ──────────────────────────
 *
 * Each one exists because the mistake it prevents was actually made and
 * measured, and each names the count it retired:
 *
 *  - WEIGHT: 40 `font-medium` + 9 `font-bold` call sites, all of which were
 *    un-considered. `font-medium` is 500, which Segoe UI does not ship — the
 *    browser synthesises it and small text smears (DESIGN.md §Font weights).
 *  - SIZE: 61 `text-xs`, whose 12px is a different object from `text-ui`'s 12px
 *    (no tracking, a 16px line-height). The scale is eleven steps; a stock size
 *    is not one of them.
 *  - RADIUS: 159 bare `rounded` (= 4px = `rounded-ctl`, visually identical but
 *    untokenized) and 5 `rounded-[Npx]` outside the scale.
 *  - SHADOW: 18 stock `shadow-sm|lg|xl|2xl`, which Tailwind resolves to RGB
 *    shadows with their own alphas — a fourth and fifth depth tier next to the
 *    three the theme defines. Arbitrary `shadow-[…]` is banned for the same
 *    reason a coloured one is: a shadow is not a place for a hex.
 */
const BANNED_WEIGHT = /^font-(?:thin|extralight|light|extrabold|black)$/;

const STOCK_SIZE = /^text-(?:xs|sm|base|lg|xl|[2-9]xl)$/;

/** An arbitrary type size: `text-[13px]` cannot be reviewed against the scale. */
const ARBITRARY_SIZE = /^text-\[[^\]]+\]$/;

/**
 * Two arbitrary radii survive on purpose:
 *
 *  - `rounded-[1px]` — the slider knob and its track. The track is 3px tall, so any
 *    token radius (3px and up) would be a semicircle on a straight line; the knob
 *    is a square with a 1px softening, which is the shape DESIGN.md describes.
 *  - `rounded-[inherit]` — a mark that must take its container's radius, which is
 *    the definition of following it.
 */
const ARBITRARY_RADIUS = /^rounded-\[[^\]]+\]$/;

/** The two survivors of the check above, named so a third one has to be argued for. */
const RADIUS_ALLOWED = new Set(["rounded-[1px]", "rounded-[inherit]"]);

/** Bare `rounded` — Tailwind's default 4px, i.e. `rounded-ctl` written alone. */
const BARE_RADIUS = /^rounded$/;

const STOCK_SHADOW = /^shadow-(?:sm|md|lg|xl|2xl|inner)$/;

/**
 * Arbitrary shadows. The two that survive are in `paint-row-style.ts` (a neutral
 * 1px ring on a drop indicator) and `slider-style.ts` — both listed in ALLOW.
 * A coloured or glowing shadow is banned outright by DESIGN.md §Shapes.
 */
const ARBITRARY_SHADOW = /^shadow-\[[^\]]+\]$/;

/** A hex literal inside an inline `style={{ … }}`. */
const INLINE_STYLE_HEX = /style=\{\{[^}]*#[0-9a-fA-F]{3,8}[^}]*\}\}/g;

/**
 * A colour literal in an SVG presentation attribute — `fill="#3B82F6"` AND
 * `fill="rgba(59, 130, 246, 0.15)"`.
 *
 * The functional form was in the hole for as long as this check existed, and
 * that is where the canvas's off-palette blue came from: every one of them was a
 * Tailwind palette step spelled as `rgba(59, 130, 246, …)` = blue-500, sitting
 * one line under a `stroke={CANVAS_SELECT}` that named the right colour. So the
 * `rgba?`/`hsla?` arms are load-bearing, not belt-and-braces — remove them and
 * the same defects walk straight back in. Composed values
 * (`fill={withAlpha(CANVAS_SELECT, 0.15)}`) are the sanctioned form: they carry
 * no literal to match and re-derive from the token.
 */
const SVG_ATTR_COLOUR =
  /\b(?:fill|stroke|stopColor|floodColor|lightingColor)=["'](?:#[0-9a-fA-F]{3,8}|(?:rgb|rgba|hsl|hsla)\([^"']*\))["']/g;

/**
 * The same literals, but quoted INSIDE a JSX expression: `fill={… ? A : "#888"}`.
 *
 * A conditional paint is the most likely place for a literal to survive, because
 * the honest branch is a token and the fallback is whatever was typed first —
 * which is how a frame title came out in a bare `#888888` while the palette had
 * been naming `CANVAS_GUIDE` all along.
 */
const SVG_ATTR_EXPR_COLOUR =
  /\b(?:fill|stroke|stopColor|floodColor|lightingColor)=\{[^}]*["'](?:#[0-9a-fA-F]{3,8}|(?:rgb|rgba|hsl|hsla)\([^"']*\))["']/g;

/**
 * A side with a size: `border-l-0`, `rounded-t-lg`, `inset-x-2`.
 *
 * `border-l` IS a theme colour (a rule) but `border-l-0` is not — it is the
 * same utility with a zero width, which is how a conditional first-child
 * border is removed. Matching the side alone made `border-l-0` look like the
 * colour `l-0`.
 */
const SIDE_WITH_SIZE = /^(?:[trblxy]|x|y|s|e|w|n|ne|nw|se|sw)-(?:\d+|auto|full|px|none)$/;

/** Direction and side utilities: `border-b`, `-mt-1`, `rounded-t`. */
const SIDE_OR_EDGE = /^(?:[trblxy]?|x|y|s|e|w|n|ne|nw|se|sw)$/;

/**
 * Every `className` value in the source, as a list of its tokens.
 *
 * Scoped deliberately. An earlier version of this check matched colour-shaped
 * text anywhere in the file and reported `border-b` as the colour `b` and
 * `text-on-path` as `t`, because the regex had no idea where a class list
 * ended. Extracting className values first is what makes the check mean
 * anything — and it has to be honest about strings: `text-on-path` is a TOOL
 * NAME that can appear inside a className, while `border-b` there is real
 * markup, and only the extraction tells the two apart.
 */
function classNameTokens(code: string): string[] {
  const bodies: string[] = [];
  for (const m of code.matchAll(/className="([^"\n]*)"/g)) bodies.push(m[1]);
  // A template literal's ${…} holds expressions, not class names.
  for (const m of code.matchAll(/className=\{`([^`]*)`\}/g)) {
    bodies.push(m[1].replace(/\$\{[^}]*\}/g, " "));
  }
  const tokens: string[] = [];
  for (const body of bodies) {
    for (const raw of body.split(/\s+/)) {
      const tok = raw.trim();
      if (tok && !tok.includes("${")) tokens.push(tok);
    }
  }
  return tokens;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith(".tsx") || full.endsWith(".ts")) out.push(full);
  }
  return out;
}

function attributeLiterals(code: string): string[] {
  const out: string[] = [];
  const re = /\b([a-zA-Z-]+)\s*=\s*"([^"{}]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    if (!SHOWS_A_STRING.has(m[1])) continue;
    const v = m[2].trim();
    if (v && /[A-Za-z]/.test(v)) out.push(`${m[1]}="${v}"`);
  }
  return out;
}

function proseLiterals(code: string): string[] {
  const out: string[] = [];
  const re = />([^<>{}]+)</g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    const raw = m[1].replace(/\s+/g, " ").trim();
    // Multi-word only — see the note at the top about single-word labels.
    if (raw.includes(" ") && PROSE.test(raw)) out.push(raw);
  }
  return out;
}

describe("ui tokenization and i18n (AGENTS.md §3, §4)", () => {
  const files = walk(UI_DIR);
  const themeColors = themeColorNames();

  it("scans the whole ui tree", () => {
    expect(files.length).toBeGreaterThan(30);
  });

  it("has parsed the theme's colour tokens", () => {
    // A silently empty set would make the check below vacuously true.
    expect(themeColors.size).toBeGreaterThan(20);
  });

  for (const file of files) {
    const rel = path.relative(process.cwd(), file);
    const allowReason = ALLOW[path.basename(file)];
    const raw = readFileSync(file, "utf8");
    // Two views of the same file, on purpose:
    //   `code`  — comments and template literals removed, for the two checks
    //             that match raw source text. A template literal's BODY is
    //             class markup and `code` erases it, which is right for a
    //             prose check and wrong for a class check.
    //   `raw`   — the untouched source, for the two class-token checks. Most
    //             classNames here are template literals, so running those
    //             checks against `code` made them pass vacuously: a check that
    //             cannot fail is worse than no check, because it reads as
    //             coverage.
    const code = stripNonCode(raw);

    describe(rel, () => {
      it("uses no ad-hoc hex colour utility", () => {
        if (allowReason) return;
        const hits = [...code.matchAll(HEX_UTILITY)].map((m) => m[0]);
        expect(hits, `${rel}: use a tailwind.config.js token (AGENTS.md §3)`).toEqual([]);
      });

      it("uses no stock Tailwind palette utility", () => {
        if (allowReason) return;
        const hits = classNameTokens(raw)
          .map(stripVariants)
          // `bg-black/NN` is a scrim over content whose colour is unknown at
          // author time; neutral black is the only correct value there.
          .filter((t) => STOCK_COLOR.test(t) && !/^bg-black\//.test(t));
        expect(
          hits,
          `${rel}: use a semantic token — a raw palette step compiles to a value no token can restyle (AGENTS.md §3)`
        ).toEqual([]);
      });

      it("names only colour utilities the theme defines", () => {
        const unresolved = classNameTokens(raw)
          .map(stripVariants)
          .filter((t) => COLOR_UTILITY.test(t))
          .map((t) => t.replace(COLOR_UTILITY, "$1"))
          .filter(
            (name) =>
              !THEME_SCALES.has(name) &&
              !NOT_A_COLOR.test(name) &&
              !SIDE_OR_EDGE.test(name) &&
              !SIDE_WITH_SIZE.test(name) &&
              !NOT_A_SHADOW.test(name) &&
              !GRADIENT_DIRECTION.test(name) &&
              !themeColors.has(name)
          );
        expect(
          [...new Set(unresolved)],
          `${rel}: these utilities resolve to nothing. LESSONS §31 — an unmapped Tailwind utility is emitted as an empty rule, so the surface silently disappears`
        ).toEqual([]);
      });

      it("routes user-facing strings through t()", () => {
        const hits = [...attributeLiterals(code), ...proseLiterals(code)];
        expect(hits, `${rel}: use t("scope.key") (AGENTS.md §4)`).toEqual([]);
      });

      it("sets only real font weights", () => {
        const hits = classNameTokens(raw).map(stripVariants).filter((t) => BANNED_WEIGHT.test(t));
        expect(
          [...new Set(hits)],
          `${rel}: 400 / 600 / 700 only — 500 is synthesised on Segoe UI and smears (DESIGN.md §Font weights)`
        ).toEqual([]);
      });

      it("sizes text from the theme's scale", () => {
        const hits = classNameTokens(raw)
          .map(stripVariants)
          .filter((t) => STOCK_SIZE.test(t) || ARBITRARY_SIZE.test(t));
        expect(
          [...new Set(hits)],
          `${rel}: a stock size is not a step — it carries no tracking and its own line-height, so the same 12px is two objects`
        ).toEqual([]);
      });

      it("rounds corners on the radius scale", () => {
        if (allowReason) return;
        const hits = classNameTokens(raw)
          .map(stripVariants)
          .filter(
            (t) => (BARE_RADIUS.test(t) || ARBITRARY_RADIUS.test(t)) && !RADIUS_ALLOWED.has(t)
          );
        expect(
          [...new Set(hits)],
          `${rel}: bare \`rounded\` is \`rounded-ctl\` spelled out; an arbitrary radius is a value no theme change can reach`
        ).toEqual([]);
      });

      it("casts depth from the three theme tiers", () => {
        if (allowReason) return;
        const hits = classNameTokens(raw)
          .map(stripVariants)
          .filter((t) => STOCK_SHADOW.test(t) || ARBITRARY_SHADOW.test(t));
        expect(
          [...new Set(hits)],
          `${rel}: shadow-popover / -panel / -modal are the three tiers; a stock or arbitrary shadow adds a fourth`
        ).toEqual([]);
      });

      it("keeps hex out of inline styles", () => {
        if (allowReason) return;
        const hits = [...code.matchAll(INLINE_STYLE_HEX)].map((m) => m[0]);
        expect(hits, `${rel}: an inline hex is a colour no token can restyle`).toEqual([]);
      });

      it("keeps colour literals out of SVG presentation attributes", () => {
        // The whole canvas is in scope. It used to be skipped wholesale, which is
        // how forty hard-coded `#3B82F6` overlays survived every other check;
        // the palette now has a home (`canvas-colors.ts`) and this file is the
        // only place a hex is allowed to live. `rgba` is matched too — see
        // SVG_ATTR_COLOUR for what got through without it.
        if (allowReason) return;
        const hits = [...code.matchAll(SVG_ATTR_COLOUR)].map((m) => m[0]);
        expect(hits, `${rel}: an SVG fill needs a token too`).toEqual([]);
      });

      it("keeps colour literals out of a conditional paint", () => {
        if (allowReason) return;
        const hits = [...code.matchAll(SVG_ATTR_EXPR_COLOUR)].map((m) => m[0]);
        expect(hits, `${rel}: a fallback branch of fill={…} needs a token too`).toEqual([]);
      });
    });
  }
});
