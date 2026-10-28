export interface FlatDictionary {
  /** Dot-joined paths, in the order the authored object declares them. */
  keys: string[];
  /** The English string for `keys[i]`. */
  values: string[];
}

/**
 * The single traversal every consumer agrees on: the build plugin indexes call
 * sites by it and `registerLanguage` lays a translation out by it, so a locale
 * is a value array with the English key order, never a second nested tree.
 */
export function flattenDictionary(
  dict: Record<string, unknown>,
  prefix = "",
  out: FlatDictionary = { keys: [], values: [] }
): FlatDictionary {
  for (const key of Object.keys(dict)) {
    const value = dict[key];
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") {
      out.keys.push(path);
      out.values.push(value);
    } else if (value && typeof value === "object") {
      flattenDictionary(value as Record<string, unknown>, path, out);
    }
  }
  return out;
}
