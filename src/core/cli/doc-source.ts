import fs from "node:fs";
import { parseLenientJson } from "../dsl/lenient-json";
import { LATEST_DOCUMENT_VERSION } from "../dsl/version";
import type { NormalizationRepair } from "../dsl/normalize/shared";

export function reportRepairs(
  repairs: readonly NormalizationRepair[],
  source: string,
  hint?: string
): number {
  let lossy = 0;
  for (const repair of repairs) {
    if (repair.severity === "info") {
      console.error(`note: ${repair.path} — ${repair.message}`);
      continue;
    }
    lossy++;
    console.error(`error: ${repair.path} — ${repair.message}`);
  }
  if (lossy > 0) {
    console.error(
      `${source}: ${lossy} repair(s) changed the document — what was written is the REPAIRED one.` +
      (hint ? ` ${hint}` : "")
    );
  }
  return lossy;
}

export const DOC_BLOCK_RE = /<script\s+id=["']design-doc["'][^>]*>([\s\S]*?)<\/script>/i;


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

export function dialectMismatch(value: unknown, file: string): string | null {
  const version = (value as { version?: unknown } | null)?.version;
  if (typeof version !== "string" || version === "") return null;
  if (version === LATEST_DOCUMENT_VERSION) return null;
  return (
    `${file} is document dialect ${version}; this kit speaks ${LATEST_DOCUMENT_VERSION}, and a dialect does not migrate.\n` +
    `  Nothing was read or written: the kit and the file are not the same FISH. Re-install it ` +
    `(SKILL.md § "Get the kit") rather than translating the document.`
  );
}

export type DocRead =
  | { src: Source; value: unknown }
  | { error: string; code: 1 | 2; parseError?: string };


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
