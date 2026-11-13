/**
 * Where updates come from, and whether there is anything to check against.
 *
 * FISH has no installer and no update server of its own: a "release" is a shell
 * file published at some URL, and this build has to be told which one to trust.
 * That is two build-time values and nothing else —
 *
 *   __FISH_UPDATE_MANIFEST_URL__  the manifest to fetch
 *   __FISH_UPDATE_PUBLIC_KEY__    the P-256 public key that signed it
 *
 * Both are empty in a build with no release endpoint, and an absent key is not
 * treated as "check anyway": a check with no trust root would accept whatever
 * the network returned, which is the one outcome worse than not checking. So
 * `isConfigured()` gates the whole feature and the panel says so out loud.
 *
 * The `localStorage` override exists for a self-hosted mirror and for testing a
 * candidate release before it is the default. It replaces the URL; it does not
 * relax anything else — there is no override that turns verification off, because
 * the downgrade that invites is the one that must not exist.
 */

declare const __FISH_UPDATE_MANIFEST_URL__: string;
declare const __FISH_UPDATE_PUBLIC_KEY__: string;

export const MANIFEST_URL_KEY = "fish:updateManifestUrl";
export const AUTO_CHECK_KEY = "fish:updateAutoCheck";
/** Set once an update has been written, so the reload that follows it is not nagged at. */
export const JUST_UPDATED_KEY = "fish:updateJustInstalled";

function builtInManifestUrl(): string {
  return typeof __FISH_UPDATE_MANIFEST_URL__ === "string" ? __FISH_UPDATE_MANIFEST_URL__ : "";
}

function builtInPublicKeyJson(): string {
  return typeof __FISH_UPDATE_PUBLIC_KEY__ === "string" ? __FISH_UPDATE_PUBLIC_KEY__ : "";
}

function readStorage(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    // A file:// document in a locked-down profile throws SecurityError on
    // localStorage access rather than returning null.
    return null;
  }
}

function writeStorage(key: string, value: string | null): void {
  try {
    if (value === null) globalThis.localStorage?.removeItem(key);
    else globalThis.localStorage?.setItem(key, value);
  } catch {
    // Nothing to persist into; the preference lasts this session only.
  }
}

function readSessionStorage(key: string): string | null {
  try {
    return globalThis.sessionStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function writeSessionStorage(key: string, value: string | null): void {
  try {
    if (value === null) globalThis.sessionStorage?.removeItem(key);
    else globalThis.sessionStorage?.setItem(key, value);
  } catch {
    // Ignore when sessionStorage is unavailable.
  }
}

let cachedKey: { json: string; key: JsonWebKey | null } | null = null;

/**
 * The verification key, or null when this build carries none (or carries one it
 * cannot read — a malformed key is a build error, so it is treated as absent
 * rather than as a key that fails later with a confusing message).
 */
export function releasePublicKey(): JsonWebKey | null {
  const json = builtInPublicKeyJson();
  if (!json) return null;
  if (cachedKey?.json === json) return cachedKey.key;
  let key: JsonWebKey | null = null;
  try {
    const parsed = JSON.parse(json);
    if (parsed && typeof parsed === "object") key = parsed as JsonWebKey;
  } catch {
    key = null;
  }
  cachedKey = { json, key };
  return key;
}

/** The manifest to fetch, or null. An override must be an absolute http(s) URL. */
export function manifestUrl(): string | null {
  const override = readStorage(MANIFEST_URL_KEY)?.trim();
  if (override) {
    try {
      if (/^https?:$/.test(new URL(override).protocol)) return override;
    } catch {
      // fall through to the built-in value
    }
  }
  const builtIn = builtInManifestUrl().trim();
  return builtIn || null;
}

/** Both halves present. Nothing in the update path runs without this. */
export function isConfigured(): boolean {
  return manifestUrl() !== null && releasePublicKey() !== null;
}

/**
 * On unless the user turned it off — a check that has to be enabled before it
 * can ever run is a check nobody turns on.
 */
export function autoCheckEnabled(): boolean {
  return readStorage(AUTO_CHECK_KEY) !== "off";
}

export function setAutoCheckEnabled(on: boolean): void {
  writeStorage(AUTO_CHECK_KEY, on ? null : "off");
}

/**
 * The version that was just written in place, if this tab is the one that wrote
 * it. Stored in sessionStorage so file:// tabs do not bleed across files, and
 * cleared on read so a single reload settles the state.
 */
export function consumeJustUpdated(): string | null {
  const sessionValue = readSessionStorage(JUST_UPDATED_KEY);
  const legacyValue = readStorage(JUST_UPDATED_KEY);
  if (sessionValue) writeSessionStorage(JUST_UPDATED_KEY, null);
  if (legacyValue) writeStorage(JUST_UPDATED_KEY, null);
  return sessionValue ?? legacyValue;
}

export function rememberJustUpdated(version: string): void {
  writeSessionStorage(JUST_UPDATED_KEY, version);
}

/** WebCrypto is the floor for the whole feature: no key, no verify, no update. */
export function canVerify(): boolean {
  return typeof globalThis.crypto?.subtle?.importKey === "function";
}

/** True when this document has no usable origin of its own (a `file://` shell). */
export function isOpaqueOrigin(): boolean {
  try {
    if (typeof location !== "undefined" && location.protocol === "file:") return true;
    const origin =
      typeof self !== "undefined" && typeof self.origin === "string"
        ? self.origin
        : typeof location !== "undefined"
          ? location.origin
          : "null";
    return origin === "null";
  } catch {
    return true;
  }
}

/**
 * A shell opened inside someone else's page. The frame's author, not the file,
 * would be the one telling us a release exists, so the check stands down.
 */
export function isEmbedded(): boolean {
  try {
    return typeof self !== "undefined" && typeof top !== "undefined" && self !== top;
  } catch {
    // A cross-origin frame throws on the comparison itself, which is the answer.
    return true;
  }
}