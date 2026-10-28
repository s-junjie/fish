/**
 * Figma's names for the things a variant set generates, and nothing else.
 *
 * Separated from the operations that use them because these three rules are the
 * part of the feature a user notices first and questions most: "Property 1" is not
 * a typo, "Default" is not a state, and the member called `State=Hover` is named
 * after its coordinates rather than after the set it lives in.
 *
 * The strings are passed in rather than imported. They are user-facing (AGENTS.md
 * §4), and a leaf module that reached into `i18n` could not be tested without a
 * locale — so the caller supplies them and the algorithm stays here.
 */

/**
 * The next unused variant property name: `Property 1`, `Property 2`, …
 *
 * Sequential and numbered from 1, and that is a considered choice rather than a
 * lazy one. Figma tried naming the first property `Variant`, then `State`, and
 * shipped neither: users read a system word as a claim that the axis IS states,
 * and then modelled everything else — colour, size, layout — as a value of it. A
 * visibly generic name is a label asking to be replaced.
 */
export function nextVariantPropertyName(
  taken: readonly string[],
  label: (n: number) => string
): string {
  for (let n = 1; ; n++) {
    const candidate = label(n);
    if (!taken.includes(candidate)) return candidate;
  }
}

/**
 * The next unused value on one property: `Default`, then `Variant 2`,
 * `Variant 3`, …
 *
 * Two details are load-bearing. The first value is `Default` and the rest are
 * numbered from 2, because that is the sequence Figma ships and the one a user has
 * already seen in every file they have opened. And an UNUSED name is what gets
 * picked, not the next index: a set whose first value was renamed to `Hover`
 * still offers `Default` for the next member, which is the difference between a
 * name that is free and one that merely looks free.
 */
export function nextVariantValueName(
  taken: readonly string[],
  labels: { first: string; nth: (n: number) => string }
): string {
  if (!taken.includes(labels.first)) return labels.first;
  for (let n = 2; ; n++) {
    const candidate = labels.nth(n);
    if (!taken.includes(candidate)) return candidate;
  }
}

/**
 * A variant's node name — Figma's `Property=Value`, comma separated once there is
 * more than one.
 *
 * The set's name is NOT part of it. Figma keeps the two apart, and so does this:
 * the set is named after what it makes (`Button`) and each member after where it
 * sits in the matrix (`Size=Small, State=Hover`). That is also what makes renaming
 * a set free — it rewrites no layer name, because no layer name mentions it.
 *
 * `fallback` covers the member of a set that declares no properties at all, which
 * is a set of one and is better named after itself than after an empty string.
 */
export function variantName(
  properties: Record<string, string> | undefined,
  fallback: string
): string {
  const parts = Object.entries(properties ?? {});
  return parts.length > 0 ? parts.map(([k, v]) => `${k}=${v}`).join(", ") : fallback;
}

/**
 * Reads Figma's variant coordinates back out of a node name, for a document whose
 * members were named before they were given a `variantProperties` map.
 *
 * Strictly `Property=Value` pairs and nothing else. The old reader accepted any
 * substring before an `=`, which turned a layer called `Button copy 3 = draft`
 * into a property called `Button copy 3 `; an author who meant a literal name
 * would rather have no axis than a wrong one.
 */
export function parseVariantName(name: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of name.split(",")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key && value) out[key] = value;
  }
  return out;
}

/**
 * Splits a component name on `/` the way Figma's "Combine as variants" does.
 *
 * The text before the first slash becomes the set's name and every later segment
 * becomes a value on its own property — so `Button/Primary/Large` combines into a
 * set called `Button` with `Property 1=Primary` and `Property 2=Large`. That is
 * the whole convention Figma inherited from design systems that used to encode
 * hierarchy in layer names, and it is the reason a combined set usually needs no
 * renaming afterwards.
 *
 * Returns no properties for a name with no slash, because a single unnamed
 * component carries no coordinates: Figma still creates `Property 1`, it just has
 * nothing to seed the value list from, so the caller falls back to the member
 * names.
 */
export function parseSlashNaming(
  names: readonly string[]
): { setName: string; propertyValues: string[][] } {
  const segments = names.map((n) => n.split("/").map((s) => s.trim()));
  const setName = segments[0]?.[0] ?? "";
  // Every member needs the same number of segments for the columns to line up —
  // Figma says so outright, and a ragged split is a property with a value on some
  // rows and not others, which is a hole nobody asked for.
  const depth = Math.min(...segments.map((s) => s.length));
  const propertyValues: string[][] = [];
  for (let column = 1; column < depth; column++) {
    const values: string[] = [];
    for (const s of segments) {
      const v = s[column];
      if (v && !values.includes(v)) values.push(v);
    }
    propertyValues.push(values);
  }
  return { setName, propertyValues };
}