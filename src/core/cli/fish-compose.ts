import fs from "node:fs";
import path from "node:path";
import { parseLenientJson } from "../dsl/lenient-json";
import { normalizeDesignDocument } from "../dsl/normalize";
import { compactDocumentJson, documentJson } from "../document-json";
import { embedLocalDocumentAssets } from "./fish-assets";
import { dialectMismatch, DOC_BLOCK_RE, injectDocumentBlock } from "./doc-source";
import { resolveTemplatePath } from "./template-path";
import { laidOutDocument } from "../layout-report";

// ---------------------------------------------------------------------------
// compose
// ---------------------------------------------------------------------------

export async function compose(jsonFile: string, templateFile: string, opts: { out?: string; compact?: boolean }): Promise<number> {
  let raw: string;
  if (jsonFile === "-") {
    try {
      raw = fs.readFileSync(0, "utf8");
    } catch (err) {
      console.error(`stdin: failed to read — ${err instanceof Error ? err.message : err}`);
      return 1;
    }
  } else {
    if (!fs.existsSync(jsonFile)) {
      console.error(`no such file: ${jsonFile}`);
      return 2;
    }
    raw = fs.readFileSync(jsonFile, "utf8");
  }

  const resolvedTemplate = resolveTemplatePath(templateFile);
  if (!resolvedTemplate) {
    console.error(`no such file: ${templateFile}`);
    return 2;
  }

  let doc: unknown;
  try {
    doc = parseLenientJson(raw);
  } catch (err) {
    console.error(`${jsonFile}: not valid JSON — ${err instanceof Error ? err.message : err}`);
    return 1;
  }

  // A design handed to `compose` is a document too, and injected verbatim: it
  // never passes through `readDocument`, so the dialect gate has to be asked for
  // here as well.
  const mismatch = dialectMismatch(doc, jsonFile);
  if (mismatch) {
    console.error(mismatch);
    return 2;
  }

  const templateContent = fs.readFileSync(resolvedTemplate, "utf8");
  if (!DOC_BLOCK_RE.test(templateContent)) {
    console.error(`${resolvedTemplate}: no #design-doc block found in template`);
    return 2;
  }

  const baseDir = jsonFile === "-" ? process.cwd() : path.dirname(path.resolve(jsonFile));
  const embedded = await embedLocalDocumentAssets(doc, baseDir);
  if (embedded.error) {
    console.error(embedded.error);
    return 2;
  }

  // Both branches go through the same generator: the pretty one used to
  // re-print the file it had just parsed, so a document that needed normalizing
  // was written back un-normalized — a different dialect on disk than the
  // clipboard would have produced.
  const canonical = normalizeDesignDocument(doc).document;
  const serialized = opts.compact ? compactDocumentJson(canonical) : documentJson(canonical);
  const jsonStr = serialized.replace(/<\//g, "\\u003c/");
  const target = opts.out ?? resolvedTemplate;
  const assembled = injectDocumentBlock(templateContent, jsonStr);

  // Printed, not rewritten: a coordinate the flow ignores is the author's to keep
  // or delete, and this is the moment they can still see it. Nothing here changes
  // the bytes that are written.
  for (const finding of laidOutDocument(canonical, doc).findings) {
    console.error(`warning: ${finding.elementId ? `${finding.elementId}: ` : ""}${finding.message}`);
  }

  fs.writeFileSync(target, assembled);
  const note = embedded.count > 0 ? `, embedded ${embedded.count} local asset(s)` : "";
  console.log(`composed ${jsonFile} into ${target} (${assembled.length} bytes${note})`);
  return 0;
}
