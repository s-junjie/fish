import fs from "node:fs";

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
