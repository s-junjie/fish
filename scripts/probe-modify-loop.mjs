/**
 * The read -> modify metric that gates storing layout keys under their CSS name.
 *
 * Structural assertions prove the rename is COMPLETE; they cannot prove it was
 * WORTH making. The modify loop is where the stored spelling pays off: the agent
 * reads a stored document and writes a patch. A CSS name it already knows costs
 * nothing; a DSL name it has to translate costs a rework on every pass.
 *
 * This replays a fixed corpus of critique -> patch rounds against TWO stores of
 * the same geometry:
 *
 *   - the DSL store the engine keeps today, and
 *   - a CSS-named store, via `scripts/lib/modify-loop-shim.mjs` (designed: the
 *     agent reads `display:flex` / `font-size` / `position`, and the patch it
 *     writes in CSS is translated back to DSL by the shim, standing in for the
 *     readers a CSS-named store would need).
 *
 * Per round it counts the patch entries the store fails to honour, split into
 * these classes:
 *   - wrongLevel    — honoured only after a nesting repair (`did you mean …`)
 *   - unrecognized  — dropped, with a repair saying so
 *   - silent        — not honoured and nothing reported at all
 *   - divergence    — legal CSS the engine never honours in EITHER vocabulary
 *
 * The delta (DSL rework − CSS rework) is the rename's price. Small delta: a
 * CSS-named store does not earn its keep.
 *
 *   node scripts/probe-modify-loop.mjs
 *   npm run probe:modify-loop
 */

import * as esbuild from "esbuild";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { toCssStore, toDslStore } from "./lib/modify-loop-shim.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const corpusPath = path.join(root, "scripts/fixtures/modify-loop-corpus.json");

// ---------------------------------------------------------------------------
// load the normalizer (the engine's own reader) as a runnable module
// ---------------------------------------------------------------------------

async function loadNormalizer() {
  const bundle = await esbuild.build({
    stdin: {
      contents: `export { normalizeDesignDocument } from "./src/core/dsl/normalize";`,
      resolveDir: root,
      sourcefile: "modify-loop-entry.ts",
      loader: "ts"
    },
    bundle: true,
    format: "esm",
    platform: "node",
    target: "es2022",
    write: false,
    logLevel: "warning"
  });
  const tmp = path.join(os.tmpdir(), `fish-modify-loop-${process.pid}.mjs`);
  fs.writeFileSync(tmp, bundle.outputFiles[0].text);
  try {
    const mod = await import(pathToFileURL(tmp).href);
    return mod.normalizeDesignDocument;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

// ---------------------------------------------------------------------------
// tiny tree helpers
// ---------------------------------------------------------------------------

const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

function replaceInChildren(node, id, replacement) {
  if (!Array.isArray(node.children)) return node;
  return {
    ...node,
    children: node.children.map((child) => (child.id === id ? replacement : replaceInChildren(child, id, replacement)))
  };
}

function replaceById(doc, id, replacement) {
  return { ...doc, pages: (doc.pages || []).map((page) => replaceInChildren({ ...page }, id, replacement)) };
}

function findById(doc, id) {
  const walk = (node) => {
    if (!node) return undefined;
    if (node.id === id) return node;
    for (const child of node.children || []) {
      const hit = walk(child);
      if (hit) return hit;
    }
    return undefined;
  };
  for (const page of doc.pages || []) {
    const hit = walk(page);
    if (hit) return hit;
  }
  return undefined;
}

const readPath = (obj, dotted) =>
  dotted.split(".").reduce((acc, key) => (acc === undefined || acc === null ? undefined : acc[key]), obj);

const repairKey = (r) => `${r.kind}|${r.path}|${r.message}`;

/**
 * Remove a patch property's existing home from the store before the flat patch is
 * merged.
 *
 * The patch is written in CSS spelling — the agent thinks in CSS — so it names a
 * property the element may already carry under another spelling (`gap` next to
 * `layout.gap = 8`, `font-size` next to `style.fontSize = 20`). Merging the flat
 * key leaves BOTH, and the engine's own "already set" rule then drops the flat
 * entry: the round reads as rework when the edit was simply overridden. A real
 * editor SETS the property, so clear its home first and merge the patch as the
 * override it is. `toDslStore` names each home from the same map the CSS
 * column uses, so the two columns stay symmetric.
 */
function clearPatchHomes(el, homes) {
  for (const [key, value] of Object.entries(homes)) {
    if (key === "id" || key === "type" || key === "children") continue;
    if (isObject(value)) {
      if (isObject(el[key])) for (const inner of Object.keys(value)) delete el[key][inner];
    } else {
      delete el[key];
    }
  }
}


function claimRepairs(normalizer, doc, element, id, baseRepairs) {
  const { document, repairs } = normalizer(replaceById(doc, id, element));
  const baseSet = new Set(baseRepairs.map(repairKey));
  return {
    claims: repairs.filter((r) => r.severity !== "info" && !baseSet.has(repairKey(r))),
    element: findById(document, id)
  };
}

// ---------------------------------------------------------------------------
// the two stores
// ---------------------------------------------------------------------------

const STORES = {
  dsl: { label: "DSL", toStore: (el) => el, fromStore: (el) => el },
  css: { label: "CSS", toStore: (el) => toCssStore(el), fromStore: (el) => toDslStore(el) }
};

function runStore(normalizer, corpus, store) {
  const totals = { honoured: 0, wrongLevel: 0, unrecognized: 0, silent: 0, divergence: 0, rework: 0 };

  for (const round of corpus.rounds) {
    // A fresh clone per round: normalization and the patch both touch the tree,
    // and a mutated base would let one round's edit leak into the next.
    const base = structuredClone(corpus.base);
    const baseEl = findById(base, round.target);
    if (!baseEl) throw new Error(`corpus target "${round.target}" not in base`);

    const storeEl = store.toStore(baseEl);
    const dslBaseEl = store.fromStore(storeEl);
    const baseRepairs = normalizer(replaceById(base, round.target, dslBaseEl)).repairs;

    if (round.divergence) {
      totals.divergence += 1;
      continue;
    }

    // The agent WRITES in CSS spelling; the store may already hold the property
    // under another spelling. Clear that home so the patch overrides it instead of
    // colliding with the engine's "already set" drop rule (see `clearPatchHomes`).
    clearPatchHomes(storeEl, toDslStore({ ...round.patch, type: storeEl.type }));
    const patched = { ...storeEl, ...round.patch };
    const dslPatched = store.fromStore(patched);
    const { claims, element: normalizedEl } = claimRepairs(normalizer, base, dslPatched, round.target, baseRepairs);

    for (const { path: dotted, equals } of round.intent || []) {
      if (readPath(normalizedEl, dotted) === equals) {
        totals.honoured += 1;
        continue;
      }
      totals.rework += 1;
      if (claims.length === 0) totals.silent += 1;
      else if (claims.some((r) => r.message.includes("did you mean"))) totals.wrongLevel += 1;
      else totals.unrecognized += 1;
    }
  }
  return totals;
}

// ---------------------------------------------------------------------------

async function main() {
  const raw = fs.readFileSync(corpusPath);
  const hash = crypto.createHash("sha256").update(raw).digest("hex").slice(0, 12);
  const corpus = JSON.parse(raw.toString("utf-8"));
  const normalizeDesignDocument = await loadNormalizer();

  const results = { dsl: runStore(normalizeDesignDocument, corpus, STORES.dsl), css: runStore(normalizeDesignDocument, corpus, STORES.css) };

  const rows = [
    ["store", "honoured", "wrongLevel", "unrecognized", "silent", "divergence", "rework"],
    ...["dsl", "css"].map((k) => [
      STORES[k].label,
      results[k].honoured,
      results[k].wrongLevel,
      results[k].unrecognized,
      results[k].silent,
      results[k].divergence,
      results[k].rework
    ])
  ];
  const width = rows[0].map((_, col) => Math.max(...rows.map((row) => String(row[col]).length)));
  const render = (row) => row.map((cell, col) => String(cell).padEnd(width[col])).join("  ");

  console.log(`\nmodify-loop corpus: ${corpus.rounds.length} rounds  (sha256:${hash})`);
  const sentences = String(corpus.note).split(". ").map((s) => s.trim()).filter(Boolean);
  console.log(`  ${sentences[0].replace(/\.$/, "")}.\n`);
  // The verdict is only as strong as the corpus. A synthetic placeholder must say
  // so on stdout, not only in the JSON note — a reader who sees only the delta
  // line would take "gate does NOT open" as a finding when it is a placeholder.
  const synthetic = sentences.find((s) => /synthetic placeholder/i.test(s));
  if (synthetic) console.log(`  WARNING: ${synthetic.replace(/\.$/, "")}.\n`);
  for (const row of rows) console.log("  " + render(row));

  const delta = results.dsl.rework - results.css.rework;
  console.log(`\n  delta (DSL rework − CSS rework): ${delta}`);
  console.log(
    delta > 0
      ? `  verdict: a CSS-named store removes ${delta} rework(s) over absorbed input alone — the rename earns its keep on this corpus.`
      : `  verdict: a CSS-named store removes nothing absorbed input does not — the rename does not earn its keep on this corpus.`
  );
  console.log(`\n  Remember: the corpus is a fixed hash (sha256:${hash}); re-record it, do not edit it to move the number.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
