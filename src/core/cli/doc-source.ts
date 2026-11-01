import fs from "node:fs";
import { parseLenientJson } from "../dsl/lenient-json";
import { LATEST_DOCUMENT_VERSION } from "../dsl/version";

export const DOC_BLOCK_RE = /<script\s+id=["']design-doc["'][^>]*>([\s\S]*?)<\/script>/i;

/**
 * Replace the shell's `#design-doc` block with `json`.
 *
 * The replacement is a function, never a string: `$1`, `$&`, `` $` `` and `$'`
 * in a document's text are replacement patterns, and a string would expand them
 * against this regex's captures instead of writing the document.
 */
export function injectDocumentBlock(html: string, json: string): string {
  return html.replace(
    DOC_BLOCK_RE,
    () => `<script id="design-doc" type="application/json">\n${json}\n  </script>`
  );
}

export type Source = { file: string; html: boolean; text: string; source: string };

export function readSource(file: string): Source | string {
  if (!fs.existsSync(file)) return `no such file: ${file}`;
  const source = fs.readFileSync(file, "utf8");
  if (file.endsWith(".json")) return { file, html: false, text: source, source };
  const match = DOC_BLOCK_RE.exec(source);
  if (!match) return `no #design-doc block in ${file} — not a FISH document`;
  return { file, html: true, text: match[1], source };
}

/**
 * The one mismatch no later check can report.
 *
 * A dialect does not migrate (`docs/ARCHITECTURE.md` §1.2): a change in what a
 * stored value *means* edits the dialect in place. So a document from another
 * dialect is not older or newer, it is a different language — `normalize` reads
 * it without complaint and writes back values this engine has never seen the
 * meaning of, which is a silent rewrite rather than an error. Refused before the
 * document is parsed into anything, because after that point nothing knows the
 * difference.
 */
export function dialectMismatch(value: unknown, file: string): string | null {
  const version = (value as { version?: unknown } | null)?.version;
  if (typeof version !== "string" || version === "") return null;
  if (version === LATEST_DOCUMENT_VERSION) return null;
  return (
    `${file} is document dialect ${version}; this kit speaks ${LATEST_DOCUMENT_VERSION}, and a dialect does not migrate.\n` +
    `  Nothing was read or written: this skill predates the app that saved the file. Re-install it ` +
    `(SKILL.md § "Get the kit") rather than translating the document.`
  );
}

export type DocRead =
  | { src: Source; value: unknown }
  | { error: string; code: 1 | 2; parseError?: string };

/**
 * Read, parse and gate a document in the order the failure is cheapest to
 * explain: no file (2), not JSON (1), wrong dialect (2). Every command that
 * touches `#design-doc` goes through here so a new one cannot skip the gate by
 * reading the block itself.
 */
export function readDocument(file: string): DocRead {
  const src = readSource(file);
  if (typeof src === "string") return { error: src, code: 2 };

  let value: unknown;
  try {
    value = parseLenientJson(src.text.trim() || "{}");
  } catch (err) {
    const parseError = err instanceof Error ? err.message : String(err);
    return { error: `${src.file}: the #design-doc block is not valid JSON — ${parseError}`, code: 1, parseError };
  }

  const mismatch = dialectMismatch(value, src.file);
  if (mismatch) return { error: mismatch, code: 2 };

  return { src, value };
}
