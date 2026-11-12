import fs from "node:fs";
import { readDocument, DOC_BLOCK_RE } from "./doc-source";
import { parseLenientJson } from "../dsl/lenient-json";
import { normalizeDesignDocument } from "../dsl/normalize";
import { applyOps } from "../ops/apply-ops";
import { compactDocumentJson, documentJson } from "../document-json";

// ---------------------------------------------------------------------------
// apply
// ---------------------------------------------------------------------------

export function apply(opsArg: string, file: string, opts: { json: boolean; out?: string; compact?: boolean }): number {
  const read = readDocument(file);
  if ("error" in read) {
    console.error(read.error);
    return read.code;
  }
  const { src, value: doc } = read;

  let ops: unknown;
  try {
    ops = parseLenientJson(opsArg.trim().startsWith("[") || opsArg.trim().startsWith("{") ? opsArg : fs.readFileSync(opsArg, "utf8"));
  } catch (err) {
    console.error(`ops: not valid JSON — ${err instanceof Error ? err.message : err}`);
    return 1;
  }

  // `#design-doc` is the CSS-spelled dialect: `x: "320px"`, `overflow`, not the
  // stored field names. Every op below does arithmetic on these fields, so the
  // document is read once here exactly as the app reads it on load.
  const normalized = normalizeDesignDocument(doc).document;
  const result = applyOps(normalized, ops);
  const serialized = opts.compact ? compactDocumentJson(result.doc) : documentJson(result.doc);
  const json = serialized.replace(/<\//g, "\\u003c/");
  const target = opts.out ?? src.file;
  const next = src.html
    ? src.source.replace(DOC_BLOCK_RE, (_m, _body: string) => `<script id="design-doc" type="application/json">\n${json}\n  </script>`)
    : json;
  fs.writeFileSync(target, next);

  const failed = result.outcomes.filter((o) => !o.ok);
  if (opts.json) {
    console.log(JSON.stringify({ ok: failed.length === 0, file: target, outcomes: result.outcomes }, null, 2));
  } else {
    console.log(`${target}`);
    for (const o of result.outcomes) {
      console.log(`  ${o.ok ? "ok  " : "FAIL"} ${o.op}${o.id ? ` ${o.id}` : ""} — ${o.detail}`);
    }
  }
  return failed.length === 0 ? 0 : 1;
}
