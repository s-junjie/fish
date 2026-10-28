#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";

/**
 * Recovery for a `.fish.html` damaged by the two write bugs fixed in
 * `core/data-bridge.ts`:
 *
 * 1. `serializeSelf` used a template literal as the replacement of
 *    `String.replace`, so `$1` in the document text became a capture reference
 *    and spliced the shell's `<meta name="fish:fileId" …>` tag into the JSON.
 * 2. `writeFileSafely` asked for `keepExistingData` without truncating, so a
 *    document smaller than the file it was written into left the old file's
 *    bytes after the first `</html>`.
 *
 * (1) is reversible only for the `$1` form, which is what money labels produce.
 * `$&` / `` $` `` / `$'` splice shell text in irreversibly; if the block still
 * does not parse afterwards the file is left untouched and the reason reported.
 */

const args = process.argv.slice(2);
const inPlace = args.includes("--in-place");
const files = args.filter((a) => !a.startsWith("--"));

if (files.length === 0) {
  console.error("usage: node scripts/repair-fish-file.mjs <file.fish.html…> [--in-place]");
  process.exit(2);
}

const DOC_BLOCK = /(<script\s+id=["']design-doc["'][^>]*>)([\s\S]*?)(<\/script>)/i;
const INJECTED = /<meta name="fish:fileId" content="[^"]*">\n  /g;

function parses(json) {
  try {
    JSON.parse(json.trim());
    return true;
  } catch {
    return false;
  }
}

function repair(file) {
  const raw = readFileSync(file, "utf-8");
  const end = raw.indexOf("</html>");
  const keep = end === -1 ? raw.length : end + "</html>".length;
  let html = raw.slice(0, keep);
  const dropped = raw.length - keep;

  const match = DOC_BLOCK.exec(html);
  if (!match) return { file, ok: false, reason: "no #design-doc block" };

  let body = match[2];
  let restored = 0;
  if (!parses(body)) {
    body = body.replace(INJECTED, () => {
      restored += 1;
      return "$1";
    });
    if (!parses(body)) {
      return {
        file,
        ok: false,
        reason: `#design-doc still does not parse after ${restored} repair(s) — the damage is not the $1 form`
      };
    }
  }
  html = html.replace(DOC_BLOCK, () => match[1] + body + match[3]);

  const target = inPlace ? file : file.replace(/(\.fish)?\.html?$/i, "") + ".repaired.fish.html";
  if (target !== file) {
    writeFileSync(target, html);
  } else {
    writeFileSync(file, html);
  }
  return { file, target, ok: true, droppedBytes: dropped, restored };
}

let failed = 0;
for (const file of files) {
  const result = repair(file);
  if (!result.ok) failed += 1;
  console.log(JSON.stringify(result));
}
process.exit(failed === 0 ? 0 : 1);
