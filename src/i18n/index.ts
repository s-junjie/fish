import { en } from "./en";
import { formatMessage, usesIcu } from "./format";
import { KEYS, VALUES } from "virtual:fish-i18n-table";

export { en };
export type Dict = typeof en;

// The build plugin rewrites `t("typography.decorationStrikethrough")` to
// `t(142)`, so a call site carries an array slot instead of a key path. Only
// dynamic keys (`t(REFUSAL[key])`) arrive as strings; they resolve through this
// index once, lazily, so the common path never splits or hashes.
const KEY_SEPARATOR = "\u0001";

let currentLang = "en";
const dictionaries: Record<string, string[]> = { en: VALUES };

let keysInOrder: string[] | null = null;
let keyIndex: Map<string, number> | null = null;

function decodeKeys(): string[] {
  if (keysInOrder) return keysInOrder;
  const keys: string[] = [];
  let previous = "";
  for (const part of KEYS.split(KEY_SEPARATOR)) {
    const bar = part.indexOf("|");
    const shared = parseInt(part.slice(0, bar), 36);
    previous = previous.slice(0, shared) + part.slice(bar + 1);
    keys.push(previous);
  }
  keysInOrder = keys;
  return keys;
}

function indexOf(path: string): number | undefined {
  if (!keyIndex) {
    keyIndex = new Map(decodeKeys().map((key, index) => [key, index]));
  }
  return keyIndex.get(path);
}

function nested(dict: Record<string, unknown>, path: string): string | undefined {
  let node: unknown = dict;
  for (const key of path.split(".")) {
    if (!node || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return typeof node === "string" ? node : undefined;
}

export function getLanguage(): string {
  return currentLang;
}

export function setLanguage(lang: string): void {
  if (dictionaries[lang]) {
    currentLang = lang;
  }
}

/**
 * A locale is a value array in English key order; a nested object is accepted
 * only so a caller can hand over a dictionary that reads like `en.ts`. A
 * missing translation keeps the English string, never the key path.
 */
export function registerLanguage(lang: string, dict: Record<string, unknown> | string[]): void {
  dictionaries[lang] = Array.isArray(dict)
    ? dict
    : decodeKeys().map((key, index) => nested(dict, key) ?? VALUES[index]);
}

export function t(path: string | number, vars?: Record<string, string | number>): string {
  const values = dictionaries[currentLang] || VALUES;
  const index = typeof path === "number" ? path : indexOf(path);
  const out = index === undefined ? String(path) : values[index] ?? VALUES[index] ?? String(path);
  if (!vars) return out;
  if (usesIcu(out)) return formatMessage(out, vars, currentLang);
  return out.replace(/\{(\w+)\}/g, (match, key) => (key in vars ? String(vars[key]) : match));
}
