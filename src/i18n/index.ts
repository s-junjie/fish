import { en } from "./en";
import { formatMessage, usesIcu } from "./format";
import { KEYS, VALUES } from "virtual:fish-i18n-table";

export { en };
export type Dict = typeof en;

// The build rewrites `t("typography.decorationStrikethrough")` to `t(142)`, so a
// call site carries an array slot instead of a key path. Only a key the source
// can name at runtime — a template path, or a `labelKey` in a table that
// `t(item.labelKey)` reads — arrives as a string, and only those keys are in
// `KEYS`. Decoding waits for the first of them; the common path never sees it.
const KEY_SEPARATOR = "\u0001";

let currentLang = "en";
const dictionaries: Record<string, string[]> = { en: VALUES };

let keySlots: Map<string, number> | null = null;

function decodeKeys(): Map<string, number> {
  if (keySlots) return keySlots;
  const slots = new Map<string, number>();
  let previous = "";
  let slot = 0;
  for (const entry of KEYS.split(KEY_SEPARATOR)) {
    const head = entry.indexOf("|");
    const bar = entry.indexOf("|", head + 1);
    slot += parseInt(entry.slice(0, head), 36);
    previous = previous.slice(0, parseInt(entry.slice(head + 1, bar), 36)) + entry.slice(bar + 1);
    slots.set(previous, slot);
  }
  keySlots = slots;
  return slots;
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
 * A locale is a value array in slot order; a nested object is accepted only so a
 * caller can hand over a dictionary that reads like `en.ts`, and it lays out the
 * keys the shipped table kept. A missing translation keeps the English string,
 * never the key path.
 */
export function registerLanguage(lang: string, dict: Record<string, unknown> | string[]): void {
  if (Array.isArray(dict)) {
    dictionaries[lang] = dict;
    return;
  }
  const values: string[] = [];
  for (const [key, slot] of decodeKeys()) values[slot] = nested(dict, key) ?? VALUES[slot];
  dictionaries[lang] = values;
}

export function t(path: string | number, vars?: Record<string, string | number>): string {
  const values = dictionaries[currentLang] || VALUES;
  const index = typeof path === "number" ? path : decodeKeys().get(path);
  if (typeof index !== "number") return String(path);
  const out = values[index] ?? VALUES[index] ?? String(path);
  if (!vars) return out;
  if (usesIcu(out)) return formatMessage(out, vars, currentLang);
  return out.replace(/\{(\w+)\}/g, (match, key) => (key in vars ? String(vars[key]) : match));
}
