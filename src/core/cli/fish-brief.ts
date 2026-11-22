import fs from "node:fs";
import path from "node:path";
import { readDocument } from "./doc-source";
import { normalizeDesignDocument } from "../dsl/normalize";
import { parseLenientJson } from "../dsl/lenient-json";
import { countElements, flattenElements } from "../geometry/tree-ops";
import { declaresFallback, splitFontStack } from "../font-stack";
import { getActivePage } from "../dsl/document-ops";
import type { TextElement } from "../dsl/types";
import type { DesignDocument, DesignElement, ComponentOverride } from "../dsl/types";

// ---------------------------------------------------------------------------
// brief — what is already here to reuse, and whether the intent was recorded
// ---------------------------------------------------------------------------

/**
 * Recon, not validation: the questions an intake has to answer are "is there a
 * token palette already", "is there a Button component", and they are answered
 * by reading the document, not by asking the user. Every answer here is one
 * question the agent does not have to ask. Styles answer a third one — "is the
 * design system actually wired up" — so each style reports the layers that bind
 * it (a master's children count; an instance's painted clones do not, but the
 * override that repaints one does), and each kind reports the stored layers
 * still unbound.
 *
 * "Unbound" splits in two, because the two are different answers to different
 * questions. A layer whose colour comes from a token IS wired up — the token is
 * the source, and a paint style would be the wrong table for a single colour —
 * so it counts as `tokenBound`. Only a layer with no source at all — a literal
 * no editor can move — counts as a gap.
 */
type Recon = {
  components: { id: string; name: string }[];
  sets: { id: string; name: string; variants: number; properties: string[] }[];
  styles: { id: string; name: string; styleType: string; bound: number }[];
  /** Painted layers with NO source: neither a style id nor a token. Drift. */
  styleGaps: { paint: number; text: number; stroke: number; effect: number };
  /** Painted layers whose source is a token rather than a style. Wired up. */
  tokenBound: { paint: number; text: number; stroke: number; effect: number };
  tokens: { color: string[]; number: string[] };
  assets: { id: string; name: string }[];
  fonts: { family: string; src: boolean; fallback: boolean }[];
  pages: number;
  elements: number;
};

export function reconDocument(doc: DesignDocument): Recon {
  const components: Recon["components"] = [];
  const sets: Recon["sets"] = [];
  const seen = new Set<string>();
  const styleUse = new Map<string, number>();
  const styleGaps: Recon["styleGaps"] = { paint: 0, text: 0, stroke: 0, effect: 0 };
  const tokenBound: Recon["tokenBound"] = { paint: 0, text: 0, stroke: 0, effect: 0 };
  const bound = (styleId: unknown) => {
    if (typeof styleId === "string" && styleId) styleUse.set(styleId, (styleUse.get(styleId) ?? 0) + 1);
  };
  const paints = (v: unknown): boolean => Array.isArray(v) && v.length > 0;
  // A paint names a colour token either on itself or on one gradient stop, and
  // a stop is a paint of the same shape — one walk answers both.
  const namesColorToken = (p: unknown): boolean => {
    if (!p || typeof p !== "object") return false;
    const paint = p as { tokenId?: unknown; stops?: unknown };
    if (typeof paint.tokenId === "string" && paint.tokenId) return true;
    return Array.isArray(paint.stops) && paint.stops.some(namesColorToken);
  };
  const hasBindings = (v: unknown): boolean =>
    Boolean(v) && typeof v === "object" && Object.keys(v as object).length > 0;

  const walk = (els: DesignElement[] | undefined) => {
    for (const el of els ?? []) {
      const any = el as unknown as Record<string, unknown>;
      const id = String(any.id ?? "");
      if (id && !seen.has(id)) {
        seen.add(id);
        if (any.type === "component") {
          components.push({ id, name: String(any.name ?? "") });
        } else if (any.type === "componentSet") {
          const kids = (any.children ?? []) as Record<string, unknown>[];
          const props = new Set<string>();
          for (const k of kids) {
            for (const p of Object.keys((k.variantProperties ?? {}) as Record<string, unknown>)) {
              props.add(p);
            }
          }
          sets.push({ id, name: String(any.name ?? ""), variants: kids.length, properties: [...props] });
        }
      }
      bound(any.fillStyleId);
      bound(any.strokeStyleId);
      bound(any.effectStyleId);
      if (any.type === "text") {
        bound(any.textStyleId);
        // A text style is the only style a text wears; the other source its
        // type can have is a number token on `tokenBindings` (size, leading).
        if (!any.textStyleId) {
          if (hasBindings(any.tokenBindings)) tokenBound.text += 1;
          else styleGaps.text += 1;
        }
      } else if (!any.fillStyleId && paints(any.fills)) {
        if ((any.fills as unknown[]).some(namesColorToken)) tokenBound.paint += 1;
        else styleGaps.paint += 1;
      }
      if (!any.strokeStyleId && paints(any.strokes)) {
        const rows = any.strokes as { tokenId?: unknown; paint?: unknown }[];
        if (rows.some((s) => (typeof s?.tokenId === "string" && s.tokenId) || namesColorToken(s?.paint))) {
          tokenBound.stroke += 1;
        } else {
          styleGaps.stroke += 1;
        }
      }
      if (!any.effectStyleId && paints(any.effects)) {
        const rows = any.effects as { tokenId?: unknown; tokenBindings?: unknown }[];
        if (rows.some((e) => (typeof e?.tokenId === "string" && e.tokenId) || hasBindings(e?.tokenBindings))) {
          tokenBound.effect += 1;
        } else {
          styleGaps.effect += 1;
        }
      }
      // An instance clone is painted, never stored, but the override that
      // repaints it IS stored: a style only an override points at is still a
      // style the document uses.
      for (const o of (any.overrides as ComponentOverride[] | undefined) ?? []) {
        if (o.property.endsWith("StyleId") && typeof o.value === "string") bound(o.value);
      }
      walk((any.children as DesignElement[] | undefined) ?? undefined);
    }
  };

  for (const p of doc.pages ?? []) walk(p.children);

  const styles: Recon["styles"] = (doc.styles ?? []).map((s) => ({
    id: s.id,
    name: String(s.name ?? ""),
    styleType: s.styleType,
    bound: styleUse.get(s.id) ?? 0
  }));
  const tokens: Recon["tokens"] = { color: [], number: [] };
  for (const t of doc.tokens ?? []) (t.type === "color" ? tokens.color : tokens.number).push(t.name);

  const fallbackFamilies = familiesWithFallback(doc);

  return {
    components,
    sets,
    styles,
    styleGaps,
    tokenBound,
    tokens,
    assets: (doc.assets ?? []).map((a) => ({ id: a.id, name: a.name })),
    fonts: (doc.fonts ?? []).map((f) => ({
      family: f.family,
      src: Boolean(f.src),
      fallback: declaresFallback(f.family) || splitFontStack(f.family).some((n) => fallbackFamilies.has(n.toLowerCase()))
    })),
    pages: doc.pages?.length || 1,
    elements: countElements(doc)
  };
}

/**
 * Families a text stack asks to be substituted for.
 *
 * A system face is not a missing asset: `"PingFang SC, sans-serif"` is the author
 * saying what a machine without PingFang should do, and `fontDiagnostics` already
 * treats it as satisfied. Brief said "export will not carry it" about those in the
 * same breath as a webfont nobody embedded — the one state where the sentence is
 * true — so a real gap and a declared choice read identically here.
 */
function familiesWithFallback(doc: DesignDocument): Set<string> {
  const out = new Set<string>();
  const roots = doc.pages?.length ? doc.pages.flatMap((page) => page.children ?? []) : getActivePage(doc).children ?? [];
  for (const el of flattenElements(roots)) {
    if (el.type !== "text") continue;
    const text = el as TextElement;
    const stacks = [text.style?.fontFamily, ...(text.spans ?? []).map((span) => span?.style?.fontFamily)];
    for (const stack of stacks) {
      if (!declaresFallback(stack)) continue;
      for (const name of splitFontStack(stack)) out.add(name.toLowerCase());
    }
  }
  return out;
}

/**
 * The intent lives in a file beside the document, not inside it: text that has to
 * be revised, diffed and reviewed cannot live in a block the editor rewrites.
 * Located, not required — tokens and styles inside the document are the design
 * system, and this file is one screen of prose about what it is for.
 *
 * Named `intent.md` rather than `design.md` on purpose: nearly every project
 * already has a `DESIGN.md` meaning "the design system", and a second file with
 * that name beside a document reads as a copy of it.
 */
const INTENT_FILE = ["intent.md", "INTENT.md"] as const;

/**
 * Material a project may already hold before any document exists.
 *
 * Names and sizes only. Reading a brand manual is the agent's job and asking is
 * the intake's, but "there is a logo.svg and a brand-2026.pdf in this directory"
 * is recon: it turns the one question no document can answer into a question
 * with an answer already on disk.
 */
const MATERIAL_EXT = new Set([
  ".svg", ".png", ".jpg", ".jpeg", ".webp", ".avif", ".gif",
  ".pdf", ".ai", ".eps", ".fig", ".sketch", ".psd",
  ".ttf", ".otf", ".woff", ".woff2"
]);
const MATERIAL_LIMIT = 12;

type Material = { name: string; bytes: number };
type ProjectContext = { intent: string | null; material: Material[] };

/**
 * Matched against the directory listing, not `existsSync`: on a case-insensitive
 * filesystem `DESIGN.md` "exists" for a file spelled `design.md`, and a path the
 * CLI reports with the wrong case is a path that fails on the machine the
 * document is sent to.
 */
function findIn(dir: string, names: readonly string[]): string | null {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return null;
  }
  for (const name of names) {
    if (entries.includes(name)) return path.join(dir, name);
  }
  return null;
}

function findContextFile(docFile: string, names: readonly string[]): string | null {
  const beside = path.dirname(path.resolve(docFile));
  return findIn(beside, names) ?? (beside === process.cwd() ? null : findIn(process.cwd(), names));
}

function readMaterial(dir: string): Material[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && MATERIAL_EXT.has(path.extname(e.name).toLowerCase()))
    .map((e) => ({ name: e.name, bytes: fs.statSync(path.join(dir, e.name)).size }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function projectContext(dir: string): ProjectContext {
  return {
    intent: findIn(dir, INTENT_FILE),
    material: readMaterial(dir)
  };
}

function sizeLabel(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * Rendered, not returned as data: both modes print this block, and the one
 * difference — a document exists or it does not — is the header. A caller that
 * had to reassemble the rows would be a second rendering free to drift.
 */
export function contextReport(ctx: ProjectContext, mode: "new" | "doc"): string {
  const row = (label: string, body: string) => `    ${label.padEnd(15)}${body}`;
  const material = ctx.material.length
    ? ctx.material.slice(0, MATERIAL_LIMIT).map((m) => `${m.name} (${sizeLabel(m.bytes)})`).join(", ") +
      (ctx.material.length > MATERIAL_LIMIT ? `, +${ctx.material.length - MATERIAL_LIMIT} more` : "") +
      "\n" + " ".repeat(19) + "found here, not opened — ask before using"
    : mode === "new"
      ? "none here — ask the user, then search (`references/assets.md`)"
      : "none beside the document";

  const lines =
    mode === "new"
      ? [
          "",
          "  no document yet — the intent goes beside it before the first element",
          row("intent", ctx.intent ?? "none — write intent.md: goal, audience, format, material, bets"),
          row("material here", material),
          "",
          "  next            write intent.md, then: ./fish compose design.json --out design.fish.html"
        ]
      : [
          "",
          "  project context — beside the document, not inside it",
          row("intent", ctx.intent ?? "none — optional; tokens and styles live in the document"),
          row("material here", material)
        ];
  return lines.join("\n");
}

/**
 * No document is the state a new design starts in, and the state the intake
 * runs in. Refusing there was the one answer that taught an agent to skip recon:
 * a usage error on the first command of a project says "this is not how you
 * start", when the directory is exactly what should be reported.
 */
export function brief(file: string | null, opts: { json: boolean }): number {
  if (!file) {
    const ctx = projectContext(process.cwd());
    if (opts.json) {
      console.log(JSON.stringify({ file: null, cwd: process.cwd(), ...ctx }, null, 2));
      return 0;
    }
    console.log(contextReport(ctx, "new"));
    return 0;
  }

  const read = readDocument(file);
  if ("error" in read) {
    console.error(read.error);
    return read.code;
  }
  const { src, value } = read;

  const { document } = normalizeDesignDocument(value);
  const r = reconDocument(document);
  const context: ProjectContext = {
    intent: findContextFile(src.file, INTENT_FILE),
    material: readMaterial(path.dirname(path.resolve(src.file)))
  };

  if (opts.json) {
    console.log(JSON.stringify({ file: src.file, recon: r, ...context }, null, 2));
    return 0;
  }

  console.log(`${src.file}\n  v${document.version} · canvas ${document.canvas?.width}×${document.canvas?.height} · ${r.elements} elements · ${r.pages} page(s)`);
  console.log("\n  already here — reuse before rebuilding");
  const line = (label: string, body: string) =>
    console.log(`    ${label.padEnd(15)}${body}`);
  line("components", r.components.length ? r.components.map((c) => c.name || c.id).join(", ") : "none");
  for (const s of r.sets) {
    line("  in set", `${s.name || s.id} — ${s.variants} variants${s.properties.length ? ` (${s.properties.join(", ")})` : ""}`);
  }
  for (const kind of ["paint", "text", "effect", "stroke"]) {
    const entries = r.styles.filter((s) => s.styleType === kind);
    const gap = r.styleGaps[kind as keyof Recon["styleGaps"]];
    const token = r.tokenBound[kind as keyof Recon["tokenBound"]];
    if (!entries.length && !gap && !token) continue;
    const named = entries.map((s) => `${s.name || s.id} (${s.bound})`).join(", ");
    line(
      `${kind} styles`,
      [
        named || "none",
        // Two different numbers on purpose: one is drift, the other is the
        // system working. Reporting both as "without a style" made a token-bound
        // document read as an unwired one.
        gap ? `${gap} with literals` : "",
        token ? `${token} token-bound` : ""
      ].filter(Boolean).join(" — ")
    );
  }
  if (r.tokens.color.length) line("color tokens", r.tokens.color.join(", "));
  if (r.tokens.number.length) line("number tokens", r.tokens.number.join(", "));
  line("assets", r.assets.length ? r.assets.map((a) => a.name || a.id).join(", ") : "none");
  // A font with no `src` is a font the export cannot carry: exportCanvasSvg only
  // emits @font-face for entries that have both. What that costs depends on
  // whether a substitute was declared — a system face with a generic fallback is
  // a decision, a bare family nobody embedded is a gap.
  line(
    "fonts",
    r.fonts.length
      ? r.fonts
          .map((f) =>
            f.src
              ? f.family
              : f.fallback
                ? `${f.family} (no src, generic fallback declared — the substitute is the design)`
                : `${f.family} (no src, no fallback — a machine without it re-wraps silently)`
          )
          .join(", ")
      : "none"
  );

  // Located, not interpreted: where a spec is and whether it exists is all the
  // CLI claims to know — reading it is the agent's job.
  console.log(contextReport(context, "doc"));
  return 0;
}
