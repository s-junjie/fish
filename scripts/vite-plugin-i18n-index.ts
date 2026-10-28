import path from "node:path";
import type { Plugin } from "vite";
import { en } from "../src/i18n/en";
import { flattenDictionary } from "../src/i18n/flatten";

const VIRTUAL_ID = "virtual:fish-i18n-table";
const RESOLVED_ID = "\0" + VIRTUAL_ID;
const KEY_SEPARATOR = "\u0001";

// Only a literal `t("scope.key")` is statically resolvable; a template literal
// or a key held in a table stays a string and is looked up at runtime.
const T_CALL = /\bt\(\s*(["'])((?:\\.|(?!\1)[^\\])*)\1(\s*[,)])/g;
const IMPORTS_T = /\bimport\s*\{[^}]*\bt\b[^}]*\}\s*from\s*["'][^"']*i18n["']/;

/**
 * Front-codes sorted keys: `<shared prefix length in base36>|<suffix>`, joined
 * by U+0001. Consecutive keys share most of their path, so this is ~half the
 * bytes of spelling every dotted path out. `index.ts` reverses it on the first
 * string lookup; numeric call sites never decode it.
 */
function encodeKeys(keys: string[]): string {
  let previous = "";
  return keys
    .map((key) => {
      let shared = 0;
      while (shared < key.length && shared < previous.length && key[shared] === previous[shared]) {
        shared++;
      }
      const part = `${shared.toString(36)}|${key.slice(shared)}`;
      previous = key;
      return part;
    })
    .join(KEY_SEPARATOR);
}

export function i18nIndexPlugin(): Plugin {
  const { keys, values } = flattenDictionary(en as unknown as Record<string, unknown>);
  const valueAt = new Map(keys.map((key, index) => [key, values[index]]));
  // Slot order is sorted so the key table can be front-coded; VALUES follows it.
  const sorted = [...keys].sort();
  const slots = new Map(sorted.map((key, slot) => [key, slot]));
  const orderedValues = sorted.map((key) => valueAt.get(key)!);
  let rewrite = false;
  let sourceDir = "";

  return {
    name: "fish-i18n-index",
    enforce: "pre" as const,
    configResolved(config) {
      rewrite = config.command === "build";
      sourceDir = path.resolve(config.root, "src") + path.sep;
    },
    resolveId(id: string) {
      return id === VIRTUAL_ID ? RESOLVED_ID : null;
    },
    load(id: string) {
      if (id !== RESOLVED_ID) return null;
      const keyList = JSON.stringify(encodeKeys(sorted));
      return `export const KEYS = ${keyList};\nexport const VALUES = ${JSON.stringify(orderedValues)};\n`;
    },
    transform(code: string, id: string) {
      if (!rewrite) return null;
      if (!id.startsWith(sourceDir) || id.includes("/i18n/") || id.includes("\\i18n\\")) return null;
      if (slots.size === 0 || !IMPORTS_T.test(code)) return null;
      const unknown: string[] = [];
      const compiled = code.replace(T_CALL, (call: string, _quote: string, key: string, tail: string) => {
        const slot = slots.get(key);
        if (slot === undefined) {
          unknown.push(key);
          return call;
        }
        return `t(${slot}${tail}`;
      });
      if (unknown.length > 0) {
        this.error(`${id}: t("${unknown[0]}") has no entry in src/i18n/en.ts`);
      }
      return compiled === code ? null : { code: compiled, map: null };
    }
  };
}
