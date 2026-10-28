#!/usr/bin/env node
/**
 * Re-shell a saved `.fish.html`: keep its document and its assets, replace the
 * frozen editor inside it with the one a fresh build produced.
 *
 * A saved file carries the runtime it was written with as a compressed payload
 * (`docs/lessons/state-persistence.md` §7). Opening an old file therefore runs
 * the old engine, however new the checkout is — which is exactly the wrong thing
 * for a fixture you are profiling, and the reason this exists as a step of its
 * own rather than as "save it again from the editor".
 *
 * Only the runtime blocks are touched. `#design-doc` and `#fish-assets` are
 * verified byte-identical before anything is written, and the original is kept
 * beside the result.
 *
 * Usage: node scripts/reshell.mjs <file.fish.html…> [--shell dist/index.html] [--dry-run]
 */

import { readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { resolve } from "node:path";
import { decode } from "./lib/b86.mjs";
import { inflateRaw } from "./lib/inflate-raw.js";
import { scanElements, blockById } from "./lib/html-blocks.mjs";

const PAYLOAD_TYPE = "fish/deflate-b86";
const LOADER_MARK = "__fishBooted";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
let shellPath = "dist/index.html";
const targets = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--shell") {
    shellPath = args[++i];
  } else if (args[i] !== "--dry-run") {
    targets.push(args[i]);
  }
}

if (targets.length === 0) {
  console.error("usage: node scripts/reshell.mjs <file.fish.html…> [--shell dist/index.html] [--dry-run]");
  process.exit(2);
}

/**
 * The pieces of a shell a saved file borrows: its payload blocks and the loader
 * that unpacks them. Identified by behaviour, not by position — a build may emit
 * one stylesheet or two, and only the loader knows how to inflate what it finds.
 */
function runtimeOf(html, source) {
  const elements = [...scanElements(html)];
  const payloads = elements
    .filter((el) => el.tag === "script" && el.attr("type") === PAYLOAD_TYPE)
    .map((el) => source.slice(el.start, el.end));
  const loader = elements.find((el) => el.tag === "script" && el.text.includes(LOADER_MARK));
  if (payloads.length === 0 || !loader) return null;
  return { payloads, loader: source.slice(loader.start, loader.end), elements };
}

function verifyPayloads(payloads) {
  for (const tag of payloads) {
    const body = /^<script[^>]*>([\s\S]*?)<\/script>$/.exec(tag)?.[1] ?? "";
    const want = Number(/\bdata-chars="(\d+)"/.exec(tag)?.[1]);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(inflateRaw(decode(body)));
    if (text.length !== want) throw new Error(`payload does not decode to ${want} chars (got ${text.length})`);
  }
}

function reshell(file) {
  const original = readFileSync(file, "utf-8");
  const doc = blockById(original, "design-doc");
  const assets = blockById(original, "fish-assets");
  if (!doc) return { file, ok: false, reason: "no #design-doc block — not a saved FISH file" };

  const shellSource = readFileSync(shellPath, "utf-8");
  const shell = runtimeOf(shellSource, shellSource);
  if (!shell) return { file, ok: false, reason: `${shellPath} carries no runtime payload` };

  const current = runtimeOf(original, original);
  if (!current) return { file, ok: false, reason: "the file carries no runtime payload to replace" };

  // Everything the old engine consisted of, by span, newest-first so the splices
  // do not shift each other.
  const stale = current.elements
    .filter(
      (el) =>
        (el.tag === "script" && el.attr("type") === PAYLOAD_TYPE) ||
        (el.tag === "script" && el.text.includes(LOADER_MARK))
    )
    .sort((a, b) => b.start - a.start);

  let next = original;
  for (const el of stale) next = next.slice(0, el.start) + next.slice(el.end);
  const bodyClose = next.lastIndexOf("</body>");
  if (bodyClose < 0) return { file, ok: false, reason: "no </body>" };
  const injected = [...shell.payloads, shell.loader].join("\n  ");
  next = next.slice(0, bodyClose) + injected + "\n  " + next.slice(bodyClose);

  // The document and its bitmaps are the user's work. A re-shell that moved
  // either one would be silently rewriting the thing it was asked to preserve.
  for (const [id, before] of [["design-doc", doc], ["fish-assets", assets]]) {
    if (!before) continue;
    const after = blockById(next, id);
    if (!after || after.text !== before.text) {
      return { file, ok: false, reason: `the #${id} block changed` };
    }
  }
  // A browser ends an element at the first `</script` anywhere in the file, so
  // the element count and the close count have to agree.
  for (const tag of ["script", "style"]) {
    const elements = [...scanElements(next)].filter((el) => el.tag === tag).length;
    const closes = (next.match(new RegExp(`</${tag}`, "gi")) ?? []).length;
    if (elements !== closes) return { file, ok: false, reason: `${elements} <${tag}> vs ${closes} closers` };
  }
  try {
    verifyPayloads([...shell.payloads]);
  } catch (e) {
    return { file, ok: false, reason: e instanceof Error ? e.message : String(e) };
  }

  const before = Buffer.byteLength(original);
  const after = Buffer.byteLength(next);
  if (!dryRun) {
    copyFileSync(file, `${file}.bak`);
    writeFileSync(file, next);
  }
  return { file, ok: true, replaced: stale.length, before, after };
}

let failed = 0;
for (const target of targets) {
  const report = reshell(resolve(target));
  if (!report.ok) {
    failed++;
    console.error(`${report.file}: ${report.reason}`);
    continue;
  }
  const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
  console.log(
    `${report.file}\n  runtime blocks replaced ${report.replaced}\n  size ${kb(report.before)} → ${kb(report.after)}` +
      (dryRun ? "\n  (dry run — nothing written)" : `\n  original kept at ${report.file}.bak`)
  );
}
if (failed > 0) process.exit(1);
