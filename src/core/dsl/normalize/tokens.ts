/**
 * `doc.tokens[]` — one value per entry, the document's CSS-custom-property half.
 *
 * A token is either a colour or a number and the `type` tag says which, so the
 * reader dispatches on it instead of inferring a role from the shape of a paint
 * stack. An entry whose value does not fit its `type` is DROPPED with a repair:
 * keeping it would leave the document claiming a token that every reader then
 * has to re-validate, and the plan's rule is that a visible failure beats a
 * silent rewrite of a value the author did not write in this form.
 */

import type { ColorToken, DesignToken, NumberToken, NumberTokenCategory } from "../types";
import { isValidHex } from "../../geometry/color-utils";
import { isPlainObject, NormalizationRepair } from "./shared";

const NUMBER_CATEGORIES: readonly NumberTokenCategory[] = [
  "spacing",
  "radius",
  "stroke",
  "size",
  "typography",
  "effect"
];

/**
 * A colour token value: `#RGB`, `#RRGGBB`, `#RRGGBBAA`, or `transparent`.
 *
 * `isValidHex` also accepts `#RGBA`, which this dialect does not: the stored
 * encoding for alpha is the 8-digit form and nothing else, so that a reader
 * needs exactly one rule. The hex is lower-cased because it is a value, not a
 * spelling — two files writing `#FFFFFF` and `#ffffff` mean the same colour.
 */
export function normalizeTokenColor(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const value = raw.trim();
  if (value.toLowerCase() === "transparent") return "transparent";
  if (!isValidHex(value)) return undefined;
  const digits = value.replace(/^#/, "");
  if (digits.length !== 3 && digits.length !== 6 && digits.length !== 8) return undefined;
  return `#${digits.toLowerCase()}`;
}

function normalizeTokenModes(
  raw: unknown,
  read: (value: unknown) => string | number | undefined,
  path: string,
  repairs: NormalizationRepair[]
): Record<string, string> | Record<string, number> | undefined {
  if (!isPlainObject(raw)) return undefined;
  const out: Record<string, string | number> = {};
  for (const [mode, value] of Object.entries(raw)) {
    if (!mode) continue;
    // A mode key no `doc.modes` declares is kept — `validateTokenRefs` warns
    // about it, and the mode may simply be declared in the sibling file the
    // author is about to paste. Only a value of the wrong type is dropped here.
    const kept = read(value);
    if (kept === undefined) {
      repairs.push({
        kind: "document",
        path: `${path}/modes/${mode}`,
        message: `token mode "${mode}" has a value that does not match the token type; dropped`
      });
      continue;
    }
    out[mode] = kept;
  }
  return Object.keys(out).length > 0 ? (out as Record<string, string> & Record<string, number>) : undefined;
}

const finiteNumber = (raw: unknown): number | undefined =>
  typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;

function numberCategory(raw: unknown): NumberTokenCategory | undefined {
  return typeof raw === "string" && (NUMBER_CATEGORIES as readonly string[]).includes(raw)
    ? (raw as NumberTokenCategory)
    : undefined;
}

/**
 * Repair paths point at the SOURCE index, not the output index, so a dropped
 * entry does not renumber every later message.
 */
export function normalizeTokens(raw: unknown, repairs?: NormalizationRepair[]): DesignToken[] {
  if (!Array.isArray(raw)) return [];
  const out: DesignToken[] = [];
  const seen = new Set<string>();
  raw.forEach((item, index) => {
    if (!isPlainObject(item)) return;
    const path = `/tokens/${index}`;
    const type = item.type;
    if (type !== "color" && type !== "number") {
      repairs?.push({
        kind: "document",
        path: `${path}/type`,
        message: `token "type" ${type === undefined ? "was missing" : `"${String(type)}" is not supported`}; expected "color" or "number", entry dropped`
      });
      return;
    }
    const id = typeof item.id === "string" && item.id.trim() ? item.id.trim() : `tok_${out.length + 1}`;
    if (seen.has(id)) {
      repairs?.push({
        kind: "document",
        path: `${path}/id`,
        message: `token id "${id}" is already declared; duplicate dropped`
      });
      return;
    }
    const name = typeof item.name === "string" && item.name.trim() ? item.name.trim() : id;
    const description =
      typeof item.description === "string" && item.description.trim() ? item.description.trim() : undefined;

    if (type === "color") {
      const value = normalizeTokenColor(item.value);
      if (value === undefined) {
        repairs?.push({
          kind: "document",
          path: `${path}/value`,
          message: `colour token "${name}" has the value ${JSON.stringify(item.value ?? null)}, which is not a 3/6/8-digit hex or "transparent"; entry dropped`
        });
        return;
      }
      const modes = normalizeTokenModes(item.modes, normalizeTokenColor, path, repairs ?? []) as
        | Record<string, string>
        | undefined;
      const token: ColorToken = { id, name, type: "color", value, ...(description ? { description } : {}) };
      if (modes) token.modes = modes;
      seen.add(id);
      out.push(token);
      return;
    }

    const value = typeof item.value === "number" && Number.isFinite(item.value) ? item.value : undefined;
    if (value === undefined) {
      repairs?.push({
        kind: "document",
        path: `${path}/value`,
        message: `number token "${name}" has the value ${JSON.stringify(item.value ?? null)}, which is not a finite number; entry dropped`
      });
      return;
    }
    const category = numberCategory(item.category);
    const modes = normalizeTokenModes(item.modes, finiteNumber, path, repairs ?? []) as
      | Record<string, number>
      | undefined;
    const token: NumberToken = {
      id,
      name,
      type: "number",
      value,
      ...(category ? { category } : {}),
      ...(description ? { description } : {})
    };
    if (modes) token.modes = modes;
    seen.add(id);
    out.push(token);
  });
  return out;
}
