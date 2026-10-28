/**
 * The only thing this build knows about plugins: who is allowed to publish one.
 *
 * `scripts/build-plugin.mjs` mints the matching keypair; the public half is
 * compiled in from `FISH_PLUGIN_PUBLIC_KEY`, or from `.fish-plugin-key.json` on a
 * developer's machine. No id, no name, no list — a plugin's identity arrives
 * inside the file it signs, so the same shell can be handed a plugin that did not
 * exist when it shipped.
 *
 * An empty key is a refusal, not a downgrade: without it the install path is
 * closed rather than unverified.
 */
declare const __FISH_PLUGIN_PUBLIC_KEY__: string;

export function pluginPublicKey(): JsonWebKey | null {
  const raw = typeof __FISH_PLUGIN_PUBLIC_KEY__ === "string" ? __FISH_PLUGIN_PUBLIC_KEY__ : "";
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as JsonWebKey;
    return parsed?.kty === "EC" && parsed?.crv === "P-256" ? parsed : null;
  } catch {
    return null;
  }
}

export function hasPluginKey(): boolean {
  return pluginPublicKey() !== null;
}
