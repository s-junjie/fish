/**
 * The two shapes an override VALUE can take beyond "one value".
 *
 * They are shared by both halves of the instance machinery — the resolve pass
 * merges a bag onto a clone, the write pass diffs a bag against the master — and
 * neither module owns them, which is why they live here rather than being
 * spelled once per side and drifting.
 */

/**
 * A bag of sub-keys, as opposed to one value: `style` and `tokenBindings` are
 * written and diffed per key so an instance keeps following its master for every
 * axis the user never touched.
 */
export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** An empty run set means "no runs", which is what an absent `spans` says. */
export function emptyAsUndefined<T>(value: T[] | undefined): T[] | undefined {
  return Array.isArray(value) && value.length === 0 ? undefined : value;
}
