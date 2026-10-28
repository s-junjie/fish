/**
 * The Pixabay key is a per-device credential, not plugin data. It lives under
 * one namespaced localStorage key so "Clear key" has exactly one thing to
 * remove, and it never touches the document, the plugin bundle or the build.
 *
 * localStorage is deliberately the whole story: the host offers no secret
 * store, and a key encrypted with a key stored beside it only hides the value
 * from someone who was not going to read the code anyway. The panel states the
 * actual boundary instead.
 */
const STORAGE_KEY = "fish.pixabay.api-key";

export function readApiKey(): string {
  try {
    return globalThis.localStorage?.getItem(STORAGE_KEY)?.trim() ?? "";
  } catch {
    return "";
  }
}

export function saveApiKey(value: string): void {
  const clean = value.trim();
  try {
    if (clean) globalThis.localStorage?.setItem(STORAGE_KEY, clean);
    else globalThis.localStorage?.removeItem(STORAGE_KEY);
  } catch {
    // A blocked storage quota leaves the key usable for this session only;
    // the panel reads its own state, so that is still a working key.
  }
}

export function clearApiKey(): void {
  try {
    globalThis.localStorage?.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to clear if storage is unavailable.
  }
}
