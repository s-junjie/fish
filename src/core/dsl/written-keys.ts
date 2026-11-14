import { CANONICAL_KEYS } from "./normalize/element";
import { CSS_KEY_MAP, FLAT_STYLE_KEYS, NO_CSS_EQUIVALENT } from "./css-spelling";

/**
 * The keys an author may WRITE, as opposed to every spelling the reader accepts.
 *
 * `CANONICAL_KEYS` is the input vocabulary: it names aliases too, because the
 * normalizer has to recognise them to fold them away. The published surface is
 * narrower — one spelling per concept, and that spelling is the one
 * `applyCssSpelling` leaves on disk. Deriving it from the same three tables that
 * drive the writer keeps the contract and the file from growing two answers.
 */

const inputOnlyWhy = "an input spelling: normalize folds it into another field and never writes it back";

/** Lower-case aliases `css-spelling.test.ts` cannot classify by camelCase. */
const ABSORBED_ALIASES = [
  "blend", "radius", "filter", "path", "characters", "text", "href", "asset"
];

export const INPUT_ONLY_KEYS: ReadonlySet<string> = new Set([
  ...Object.entries(NO_CSS_EQUIVALENT)
    .filter(([, why]) => why === inputOnlyWhy)
    .map(([key]) => key),
  ...ABSORBED_ALIASES
]);

/** Keys the writer emits that are not a rename of any canonical key. */
const GENERATED_KEYS = [
  "overflow", "overflow-x", "overflow-y", "scroll-x", "scroll-y",
  "min-width", "max-width", "min-height", "max-height", "visibility",
  "border-radius", "rotate", "scale", "transform", ...Object.values(FLAT_STYLE_KEYS)
];

export const WRITTEN_ELEMENT_KEYS: ReadonlySet<string> = new Set(
  [...CANONICAL_KEYS]
    .filter((key) => !INPUT_ONLY_KEYS.has(key))
    .map((key) => CSS_KEY_MAP[key] ?? key)
    .filter((key) => key !== "(flattened)")
    .concat(GENERATED_KEYS)
);

export function isWrittenKey(key: string): boolean {
  return WRITTEN_ELEMENT_KEYS.has(key);
}

/** The spelling an input alias resolves to, when the writer does rename it. */
export function writtenKeyOf(key: string): string | null {
  if (isWrittenKey(key)) return key;
  const renamed = CSS_KEY_MAP[key];
  if (renamed && renamed !== "(flattened)" && isWrittenKey(renamed)) return renamed;
  const twin = key.includes("-")
    ? key.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())
    : key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
  return isWrittenKey(twin) ? twin : null;
}
