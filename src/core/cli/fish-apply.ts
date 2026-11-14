import fs from "node:fs";
import { readDocument, DOC_BLOCK_RE, reportRepairs } from "./doc-source";
import { parseLenientJson } from "../dsl/lenient-json";
import { normalizeDesignDocument } from "../dsl/normalize";
import type { NormalizationRepair } from "../dsl/normalize/shared";
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
  // Serializing is where a value the patch could not express is finally dropped:
  // the text is the canonical document, so the loss is invisible to anything that
  // reads the file afterwards. Collected here so the op cannot report `ok` for a
  // declaration that never landed.
  const repairs: NormalizationRepair[] = [];
  const serialized = opts.compact
    ? compactDocumentJson(result.doc, (repair) => repairs.push(repair))
    : documentJson(result.doc, (repair) => repairs.push(repair));
  const json = serialized.replace(/<\//g, "\\u003c/");
  const target = opts.out ?? src.file;
  const next = src.html
    ? src.source.replace(DOC_BLOCK_RE, (_m, _body: string) => `<script id="design-doc" type="application/json">\n${json}\n  </script>`)
    : json;
  fs.writeFileSync(target, next);

  const failed = result.outcomes.filter((o) => !o.ok);
  // Outcomes first, then what the write dropped: `ok patch …` directly above an
  // error about the same op reads as a contradiction, and the error is the one
  // that decides the exit code.
  if (!opts.json) {
    console.log(`${target}`);
    for (const o of result.outcomes) {
      console.log(`  ${o.ok ? "ok  " : "FAIL"} ${o.op}${o.id ? ` ${o.id}` : ""} — ${o.detail}`);
    }
  }
  const lossy = reportRepairs(repairs, target, "Fix the op and apply it again.");
  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          ok: failed.length === 0 && lossy === 0,
          file: target,
          outcomes: result.outcomes,
          ...(repairs.length > 0 ? { repairs } : {})
        },
        null,
        2
      )
    );
  }
  return failed.length === 0 && lossy === 0 ? 0 : 1;
}
