/**
 * `doc.tokens[]` — one value (or alias `{ ref }`) per entry, the document's
 * CSS-custom-property half.
 *
 * A token is either a colour or a number and the `type` tag says which, so the
 * reader dispatches on it instead of inferring a role from the shape of a paint
 * stack. An entry whose value does not fit its `type` is DROPPED with a repair:
 * keeping it would leave the document claiming a token that every reader then
 * has to re-validate, and the plan's rule is that a visible failure beats a
 * silent rewrite of a value the author did not write in this form.
 */

import type {
  ColorToken,
  ColorTokenValue,
  DesignToken,
  NumberToken,
  NumberTokenCategory,
  NumberTokenValue,
  TokenAliasRef
} from "../types";
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

const SHORTHAND_REF = /^\$([A-Za-z0-9._/-]+)$/;
const slugOf = (name: string): string => name.trim().toLowerCase().replace(/[\s/]+/g, "-");

interface PendingRef {
  __pendingRef: string;
}

function isPendingRef(v: unknown): v is PendingRef {
  return Boolean(v) && typeof v === "object" && typeof (v as PendingRef).__pendingRef === "string";
}

function readAliasOrShorthand(raw: unknown): TokenAliasRef | PendingRef | undefined {
  if (isPlainObject(raw) && typeof raw.ref === "string" && raw.ref.trim()) {
    return { ref: raw.ref.trim() };
  }
  if (typeof raw === "string") {
    const match = SHORTHAND_REF.exec(raw.trim());
    if (match) return { __pendingRef: match[1] };
  }
  return undefined;
}

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

function normalizeColorSlot(raw: unknown): ColorTokenValue | PendingRef | undefined {
  return readAliasOrShorthand(raw) ?? normalizeTokenColor(raw);
}

function normalizeNumberSlot(raw: unknown): NumberTokenValue | PendingRef | undefined {
  return readAliasOrShorthand(raw) ?? finiteNumber(raw);
}

function normalizeTokenModes<T>(
  raw: unknown,
  read: (value: unknown) => T | undefined,
  path: string,
  repairs: NormalizationRepair[]
): Record<string, T> | undefined {
  if (!isPlainObject(raw)) return undefined;
  const out: Record<string, T> = {};
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
  return Object.keys(out).length > 0 ? out : undefined;
}

const finiteNumber = (raw: unknown): number | undefined =>
  typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;

function numberCategory(raw: unknown): NumberTokenCategory | undefined {
  return typeof raw === "string" && (NUMBER_CATEGORIES as readonly string[]).includes(raw)
    ? (raw as NumberTokenCategory)
    : undefined;
}

function resolvePendingRef(
  ref: string,
  expectedType: "color" | "number",
  byId: Map<string, DesignToken>,
  byName: Map<string, DesignToken[]>,
  bySlug: Map<string, DesignToken[]>
): { ref?: string; error?: string } {
  const exactId = byId.get(ref);
  if (exactId) {
    return exactId.type === expectedType
      ? { ref: exactId.id }
      : { error: `"$${ref}" is a ${exactId.type} token, expected ${expectedType}` };
  }
  const matches = byName.get(ref) ?? bySlug.get(slugOf(ref)) ?? [];
  if (matches.length === 0) return { error: `"$${ref}" names no token` };
  const typed = matches.filter((m) => m.type === expectedType);
  if (typed.length === 1) return { ref: typed[0].id };
  if (typed.length === 0) return { error: `"$${ref}" is not a ${expectedType} token` };
  return { error: `"$${ref}" matches more than one ${expectedType} token by name` };
}

/**
 * Repair paths point at the SOURCE index, not the output index, so a dropped
 * entry does not renumber every later message.
 */
export function normalizeTokens(raw: unknown, repairs?: NormalizationRepair[]): DesignToken[] {
  if (!Array.isArray(raw)) return [];
  const staged: Array<{ token: DesignToken; sourceIndex: number }> = [];
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
    const id = typeof item.id === "string" && item.id.trim() ? item.id.trim() : `tok_${staged.length + 1}`;
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
      const value = normalizeColorSlot(item.value);
      if (value === undefined) {
        repairs?.push({
          kind: "document",
          path: `${path}/value`,
          message: `colour token "${name}" has the value ${JSON.stringify(item.value ?? null)}, which is not a 3/6/8-digit hex, "transparent", or alias ref; entry dropped`
        });
        return;
      }
      const modes = normalizeTokenModes(item.modes, normalizeColorSlot, path, repairs ?? []) as
        | Record<string, ColorTokenValue>
        | undefined;
      const token: ColorToken = {
        id,
        name,
        type: "color",
        value: value as ColorTokenValue,
        ...(description ? { description } : {})
      };
      if (modes) token.modes = modes;
      seen.add(id);
      staged.push({ token, sourceIndex: index });
      return;
    }

    const value = normalizeNumberSlot(item.value);
    if (value === undefined) {
      repairs?.push({
        kind: "document",
        path: `${path}/value`,
        message: `number token "${name}" has the value ${JSON.stringify(item.value ?? null)}, which is not a finite number or alias ref; entry dropped`
      });
      return;
    }
    const category = numberCategory(item.category);
    const modes = normalizeTokenModes(item.modes, normalizeNumberSlot, path, repairs ?? []) as
      | Record<string, NumberTokenValue>
      | undefined;
    const token: NumberToken = {
      id,
      name,
      type: "number",
      value: value as NumberTokenValue,
      ...(category ? { category } : {}),
      ...(description ? { description } : {})
    };
    if (modes) token.modes = modes;
    seen.add(id);
    staged.push({ token, sourceIndex: index });
  });

  // Pass 2: resolve authoring-time `$name` alias shorthands against the full table.
  const hasPending = staged.some(
    ({ token }) =>
      isPendingRef(token.value) ||
      (token.modes && Object.values(token.modes).some(isPendingRef))
  );
  if (!hasPending) return staged.map((s) => s.token);

  const byId = new Map<string, DesignToken>();
  const byName = new Map<string, DesignToken[]>();
  const bySlug = new Map<string, DesignToken[]>();
  for (const { token } of staged) {
    byId.set(token.id, token);
    const nameList = byName.get(token.name) ?? [];
    nameList.push(token);
    byName.set(token.name, nameList);
    const slug = slugOf(token.name);
    const slugList = bySlug.get(slug) ?? [];
    slugList.push(token);
    bySlug.set(slug, slugList);
  }

  const out: DesignToken[] = [];
  for (const { token, sourceIndex } of staged) {
    const path = `/tokens/${sourceIndex}`;
    let nextValue: ColorTokenValue | NumberTokenValue = token.value;
    if (isPendingRef(token.value)) {
      const resolved = resolvePendingRef(token.value.__pendingRef, token.type, byId, byName, bySlug);
      if (!resolved.ref) {
        repairs?.push({
          kind: "document",
          path: `${path}/value`,
          message: `token "${token.name}" alias ${resolved.error}; entry dropped`
        });
        continue;
      }
      nextValue = { ref: resolved.ref };
    }

    let nextModes = token.modes;
    if (token.modes) {
      const cleaned: Record<string, ColorTokenValue | NumberTokenValue> = {};
      for (const [mode, val] of Object.entries(token.modes)) {
        if (isPendingRef(val)) {
          const resolved = resolvePendingRef(val.__pendingRef, token.type, byId, byName, bySlug);
          if (!resolved.ref) {
            repairs?.push({
              kind: "document",
              path: `${path}/modes/${mode}`,
              message: `token "${token.name}" mode "${mode}" alias ${resolved.error}; dropped`
            });
            continue;
          }
          cleaned[mode] = { ref: resolved.ref };
        } else {
          cleaned[mode] = val;
        }
      }
      nextModes =
        Object.keys(cleaned).length > 0
          ? (cleaned as Record<string, ColorTokenValue> | Record<string, NumberTokenValue>)
          : undefined;
    }

    const { modes: _prevModes, ...baseToken } = token;
    out.push({
      ...baseToken,
      value: nextValue as never,
      ...(nextModes ? { modes: nextModes as never } : {})
    } as DesignToken);
  }
  return out;
}
