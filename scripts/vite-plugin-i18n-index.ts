import fs from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";
import { en } from "../src/i18n/en";
import { flattenDictionary } from "../src/i18n/flatten";
import { analyzeSource, expandPrefixes } from "./i18n-keys";

const VIRTUAL_ID = "virtual:fish-i18n-table";
const RESOLVED_ID = "\0" + VIRTUAL_ID;
const KEY_SEPARATOR = "\u0001";

const IMPORTS_T = /\bimport\s*\{[^}]*\bt\b[^}]*\}\s*from\s*["'][^"']*i18n["']/;

export interface I18nTable {
  /** key → slot, only for the keys a call site can only spell out at runtime. */
  keys: Map<string, number>;
  /** English values in slot order. */
  values: string[];
  /** Every key the shipped table answers to, inlined and runtime alike. */
  slots: Map<string, number>;
}

export interface I18nScan {
  table: I18nTable;
  /** Keys with no call site and no runtime prefix — dead weight in `en.ts`. */
  orphans: string[];
}

/**
 * Front-codes the runtime keys as `<slot delta>|<shared prefix length>|<suffix>`
 * joined by U+0001. Consecutive keys share most of their path and the slots walk
 * up in order, so an entry costs little more than its own suffix. `index.ts`
 * reverses it on the first string lookup; numeric call sites never decode.
 */
export function encodeKeys(keys: Map<string, number>): string {
  let previous = "";
  let lastSlot = 0;
  return [...keys.entries()]
    .sort((a, b) => a[1] - b[1])
    .map(([key, slot]) => {
      let shared = 0;
      while (shared < key.length && shared < previous.length && key[shared] === previous[shared]) {
        shared++;
      }
      const entry = `${(slot - lastSlot).toString(36)}|${shared.toString(36)}|${key.slice(shared)}`;
      previous = key;
      lastSlot = slot;
      return entry;
    })
    .join(KEY_SEPARATOR);
}

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "i18n" ? [] : sourceFiles(file);
    return /\.(ts|tsx)$/.test(entry.name) ? [file] : [];
  });
}

const scans = new Map<string, I18nScan>();

/** Memoised per root: the build scans once, and the rigs share that scan. */
export function scanI18n(sourceDir: string): I18nScan {
  const cached = scans.get(sourceDir);
  if (cached) return cached;
  const scan = readSourceTree(sourceDir);
  scans.set(sourceDir, scan);
  return scan;
}

/**
 * The shipped table holds only what the UI can reach. A key is reachable when a
 * `t()` argument names it, when it survives as a literal anywhere in `src` (a
 * table that `t(x)` indexes), or when a runtime-built path can land on it.
 * Slot order is sorted, so the table does not depend on file order.
 */
function readSourceTree(sourceDir: string): I18nScan {
  const { keys: allKeys, values: allValues } = flattenDictionary(en as unknown as Record<string, unknown>);
  const valueAt = new Map(allKeys.map((key, index) => [key, allValues[index]]));
  const known = new Set(allKeys);

  const literals = new Set<string>();
  const prefixes = new Set<string>();
  /**
   * A key that survives as a bare string — a `labelKey: "a.b"` fed to
   * `t(item.labelKey)` — has to stay in `KEYS` even when another file inlined it.
   */
  const deferred = new Set<string>();

  for (const file of sourceFiles(sourceDir)) {
    const code = fs.readFileSync(file, "utf-8");
    const analysis = analyzeSource(code, (key) => known.has(key));
    const inlinedHere = new Set<number>();
    if (IMPORTS_T.test(code)) {
      for (const call of analysis.calls) {
        if (call.rewriteable) for (const literal of call.literals) inlinedHere.add(literal.start);
      }
    }
    for (const literal of analysis.literals) {
      literals.add(literal.key);
      if (!inlinedHere.has(literal.start)) deferred.add(literal.key);
    }
    for (const prefix of analysis.prefixes) prefixes.add(prefix);
  }

  const runtimeKeys = expandPrefixes(prefixes, known);
  const reachable = new Set([...literals, ...runtimeKeys]);
  const sorted = [...reachable].sort();
  const slots = new Map(sorted.map((key, slot) => [key, slot]));

  const keys = new Map<string, number>();
  for (const key of sorted) {
    if (runtimeKeys.has(key) || deferred.has(key)) keys.set(key, slots.get(key)!);
  }

  return {
    table: { keys, values: sorted.map((key) => valueAt.get(key)!), slots },
    orphans: allKeys.filter((key) => !reachable.has(key)).sort()
  };
}

export function i18nIndexPlugin(): Plugin {
  const { keys: allKeys, values: allValues } = flattenDictionary(en as unknown as Record<string, unknown>);
  const sortedAll = [...allKeys].sort();
  const valueAt = new Map(allKeys.map((key, index) => [key, allValues[index]]));
  let rewrite = false;
  let sourceDir = "";
  let shipped: I18nScan | null = null;

  /**
   * `serve` keeps every key: nothing is rewritten there, so every `t("a.b")`
   * arrives as a string and the map has to answer for all of them.
   */
  function fullTable(): I18nTable {
    const slots = new Map(sortedAll.map((key, slot) => [key, slot]));
    return { keys: slots, values: sortedAll.map((key) => valueAt.get(key)!), slots };
  }

  function shippedTable(): I18nTable {
    shipped ??= scanI18n(sourceDir);
    return shipped.table;
  }

  return {
    name: "fish-i18n-index",
    enforce: "pre" as const,
    configResolved(config) {
      rewrite = config.command === "build";
      sourceDir = path.resolve(config.root, "src");
    },
    resolveId(id: string) {
      return id === VIRTUAL_ID ? RESOLVED_ID : null;
    },
    load(id: string) {
      if (id !== RESOLVED_ID) return null;
      const table = rewrite ? shippedTable() : fullTable();
      return `export const KEYS = ${JSON.stringify(encodeKeys(table.keys))};\nexport const VALUES = ${JSON.stringify(table.values)};\n`;
    },
    transform(code: string, id: string) {
      if (!rewrite) return null;
      if (!id.startsWith(sourceDir + path.sep) || id.includes(`${path.sep}i18n${path.sep}`)) return null;
      if (!IMPORTS_T.test(code)) return null;

      const analysis = analyzeSource(code, (key) => valueAt.has(key));
      if (analysis.unknown.length > 0) {
        this.error(`${id}: t("${analysis.unknown[0]}") has no entry in src/i18n/en.ts`);
      }

      const slots = shippedTable().slots;
      const edits: { start: number; end: number; slot: number }[] = [];
      for (const call of analysis.calls) {
        if (!call.rewriteable) continue;
        for (const literal of call.literals) {
          const slot = slots.get(literal.key);
          if (slot === undefined) {
            this.error(`${id}: t("${literal.key}") is missing from the shipped table`);
            continue;
          }
          edits.push({ start: literal.start, end: literal.end, slot });
        }
      }
      if (edits.length === 0) return null;

      edits.sort((a, b) => b.start - a.start);
      let out = code;
      for (const edit of edits) out = out.slice(0, edit.start) + edit.slot + out.slice(edit.end);
      return { code: out, map: null };
    }
  };
}
