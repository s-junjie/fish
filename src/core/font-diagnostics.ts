/**
 * Font families the document names but does not carry.
 *
 * The canvas resolves a family from whatever the machine has installed, so a
 * document that names `Inter` renders in Helvetica on a machine without it —
 * silently, with every line re-wrapped. `exportCanvasSvg` closes half the gap by
 * emitting `@font-face` for entries that have a `src`, which leaves exactly one
 * state nobody reports: a family named by text that no `fonts[]` entry carries.
 *
 * Kept out of `validateDocument` on purpose, beside `assetDiagnostics` in the
 * CLI: a dangling token is a document that is wrong, while a family the file does
 * not carry is a document that travels badly — the same distinction that keeps a
 * convention about the files beside the document out of the engine's rules.
 * Every document authored before this check existed names a bare `Inter`,
 * because that is the DSL default; a warning in the editor would fire on all of
 * them for a defect the format itself created.
 *
 * A stack that declares a generic fallback (`"Inter, sans-serif"`) is not
 * reported: that is the author saying what a substitution should look like, and
 * the substitution is the design. Only a bare family is a claim the file cannot
 * keep. Newer documents store the bare family for that reason — the fallback is
 * appended at paint time (`resolveStack`), so it is no longer part of the file.
 */

import type { CompileDiagnostic } from "./compile";
import type { DesignDocument, DesignElement, TextElement } from "./dsl/types";
import { getActivePage } from "./dsl/types";
import { flattenElements } from "./geometry/tree-ops";
import { DEFAULT_FONT_FAMILY, declaresFallback, splitFontStack } from "./font-stack";

const carriedFamilies = (doc: DesignDocument): Set<string> => {
  const carried = new Set<string>();
  for (const font of doc.fonts ?? []) {
    // Only a `src` makes the family travel with the file; without one it is just
    // a name the reader's machine is expected to have, which is the state this
    // check exists to report.
    if (!font?.src || !font.family) continue;
    for (const name of splitFontStack(font.family)) carried.add(name.toLowerCase());
  }
  return carried;
};

/** Family stacks a text paints with: its own, plus each span's override. */
const textFamilies = (el: TextElement): string[] => {
  const own = el.style?.fontFamily || DEFAULT_FONT_FAMILY;
  const spans = (el.spans ?? [])
    .map((span) => span?.style?.fontFamily)
    .filter((family): family is string => typeof family === "string" && family.trim().length > 0);
  return [own, ...spans];
};

/**
 * `strict` is the CLI's `--strict-assets`: the flag already means "this file has
 * to stand on its own", which is exactly the claim a bare family cannot keep.
 */
export function fontDiagnostics(doc: DesignDocument, strict = false): CompileDiagnostic[] {
  const carried = carriedFamilies(doc);
  const missing = new Map<string, { family: string; count: number; firstId: string }>();

  const roots: DesignElement[] = doc.pages?.length
    ? doc.pages.flatMap((page) => page.children ?? [])
    : getActivePage(doc).children ?? [];

  for (const el of flattenElements(roots)) {
    if (el.type !== "text") continue;
    const text = el as TextElement;
    if (text.visible === false) continue;
    for (const family of textFamilies(text)) {
      if (declaresFallback(family)) continue;
      const unclaimed = splitFontStack(family).filter((name) => !carried.has(name.toLowerCase()));
      if (unclaimed.length === 0) continue;
      const key = unclaimed.join(", ").toLowerCase();
      const seen = missing.get(key);
      if (seen) seen.count++;
      else missing.set(key, { family: unclaimed.join(", "), count: 1, firstId: text.id });
    }
  }

  return [...missing.values()].map((entry) => ({
    level: strict ? ("warning" as const) : ("info" as const),
    elementId: entry.firstId,
    message:
      `Font "${entry.family}" is used by ${entry.count} text(s) but no fonts[] entry carries it with a "src" — ` +
      `the canvas resolves it from this machine, so elsewhere every line re-wraps and the export embeds no @font-face. ` +
      `Fix: add fonts: [{ family: "${entry.family}", src: "data:font/woff2;base64,…" }], or name a fallback ` +
      `("${entry.family}, sans-serif") to say the substitution is intended.`
  }));
}
