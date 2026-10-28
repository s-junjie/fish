import fs from "node:fs";
import path from "node:path";
import { readSource } from "./doc-source";
import { normalizeDesignDocument } from "../dsl/normalize";
import { parseLenientJson } from "../dsl/lenient-json";
import { countElements } from "../geometry/tree-ops";
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
  fonts: { family: string; src: boolean }[];
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

  return {
    components,
    sets,
    styles,
    styleGaps,
    tokenBound,
    tokens,
    assets: (doc.assets ?? []).map((a) => ({ id: a.id, name: a.name })),
    fonts: (doc.fonts ?? []).map((f) => ({ family: f.family, src: Boolean(f.src) })),
    pages: doc.pages?.length || 1,
    elements: countElements(doc)
  };
}

/**
 * The project context lives in the files beside the document, not inside it: a
 * design spec that has to be revised, diffed and reviewed is text, and a
 * document that carries its own intent is a document that must be rewritten to
 * change a sentence. Located, not required — the document's tokens and styles
 * are the design system; a DESIGN.md is an optional intent record.
 */
const DESIGN_SPEC_FILE = ["DESIGN.md", "design.md"] as const;
const MOOD_FILE = ["mood.md", "MOOD.md"] as const;

function findContextFile(docFile: string, names: readonly string[]): string | null {
  for (const dir of [path.dirname(path.resolve(docFile)), process.cwd()]) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

export function brief(file: string, opts: { json: boolean }): number {
  const src = readSource(file);
  if (typeof src === "string") {
    console.error(src);
    return 2;
  }
  let value: unknown;
  try {
    value = parseLenientJson(src.text.trim() || "{}");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`${src.file}: the #design-doc block is not valid JSON — ${message}`);
    return 1;
  }

  const { document } = normalizeDesignDocument(value);
  const r = reconDocument(document);
  const context = {
    designSpec: findContextFile(src.file, DESIGN_SPEC_FILE),
    mood: findContextFile(src.file, MOOD_FILE)
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
  // emits @font-face for entries that have both.
  line("fonts", r.fonts.length ? r.fonts.map((f) => `${f.family}${f.src ? "" : " (no src — export will not carry it)"}`).join(", ") : "none");

  // Located, not interpreted: where a spec is and whether it exists is all the
  // CLI claims to know — reading it is the agent's job.
  console.log("\n  project context — beside the document, not inside it");
  line("design spec", context.designSpec ?? "none — optional; tokens/styles live in the document");
  line("mood", context.mood ?? "none — optional");
  return 0;
}
