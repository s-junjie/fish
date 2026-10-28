/**
 * What an installed plugin IS, as opposed to what it DOES.
 *
 * The catalog carries every field here and the module carries none of them, so a
 * bundle cannot claim to be a plugin it is not: the loader reads `id`, `version`
 * and `sha256` from the signed/baked catalog and only then executes the bytes it
 * hashed. `Component` is the one thing that has to come from the code.
 */
import type { JSX } from "preact";
import type { PluginHostContext, PluginResizeMode, PluginAttribution } from "./plugin-contract";

/** Bumped when the host surface in `host-bridge.ts` stops being compatible. */
export const HOST_API_VERSION = "1";

export interface PluginManifest {
  id: string;
  name: string;
  description: string;
  category: "plugin" | "asset";
  icon: "scissors" | "sparkles" | "icons" | "image";
  version: string;
  hostApi: string;
  /** Lowercase hex SHA-256 of the exact bytes this manifest names. */
  sha256: string;
  /** Size of the bundle, for the install row and for a cheap sanity check. */
  bytes: number;
  width?: number;
  height?: number;
  minWidth?: number;
  minHeight?: number;
  resize?: PluginResizeMode;
  attribution?: PluginAttribution | PluginAttribution[];
}

/** The only two members a plugin bundle is allowed to export. */
export interface PluginModule {
  apiVersion: string;
  Component: (props: { context: PluginHostContext }) => JSX.Element;
}

export class PluginRejected extends Error {
  constructor(
    message: string,
    readonly reason: "fingerprint" | "host-api" | "shape" | "corrupt" | "signature"
  ) {
    super(message);
    this.name = "PluginRejected";
  }
}

const HEX_256 = /^[0-9a-f]{64}$/;

/** Appended by `scripts/build-plugin.mjs`; a comment, so the file stays runnable. */
const TRAILER = "\n//#fish-plugin:";

export function sha256Hex(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return Promise.reject(new PluginRejected("this browser cannot hash (no WebCrypto)", "shape"));
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  // `digest` copies into the crypto engine, but a detachable buffer would still
  // throw here — a slice is the one form that is always a plain ArrayBuffer.
  return subtle.digest("SHA-256", view.slice().buffer).then((d) =>
    Array.from(new Uint8Array(d))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
  );
}

/** Text search from the end: a plugin may contain the marker in a string. */
function splitSigned(bytes: Uint8Array): { code: Uint8Array; trailer: string } | null {
  const marker = new TextEncoder().encode(TRAILER);
  for (let i = bytes.length - marker.length; i >= 0; i--) {
    let hit = true;
    for (let j = 0; j < marker.length; j++) {
      if (bytes[i + j] !== marker[j]) {
        hit = false;
        break;
      }
    }
    if (!hit) continue;
    return {
      code: bytes.slice(0, i),
      trailer: new TextDecoder().decode(bytes.slice(i + marker.length)).trim()
    };
  }
  return null;
}

function base64ToBytes(b64: string): ArrayBuffer {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out.buffer as ArrayBuffer;
}

function isJwk(value: unknown): value is JsonWebKey {
  const k = value as JsonWebKey | null;
  return Boolean(k && k.kty === "EC" && k.crv === "P-256" && k.x && k.y);
}

/**
 * Verify a signed plugin file and return the two things it proves.
 *
 * Two checks, in this order, because each one alone is insufficient: the
 * signature says *we* published this manifest, and the hash inside the manifest
 * says the code travelled with it unchanged. A missing key is a refusal, never a
 * downgrade — a build with no key cannot install anything at all.
 */
export async function verifyPluginFile(
  bytes: ArrayBuffer,
  publicKey: JsonWebKey | null
): Promise<{ manifest: PluginManifest; code: ArrayBuffer }> {
  if (!publicKey || !isJwk(publicKey)) {
    throw new PluginRejected("this build was not given a plugin key, so it cannot verify one", "signature");
  }
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new PluginRejected("this browser cannot verify a plugin (no WebCrypto)", "shape");

  const split = splitSigned(new Uint8Array(bytes));
  if (!split) throw new PluginRejected("this file is not a signed plugin", "signature");

  let envelope: { payload?: unknown; sig?: unknown };
  try {
    // The trailer is base64 of the envelope, so the trailer line itself can never
    // be read as code by a tool that does not know the convention.
    envelope = JSON.parse(new TextDecoder().decode(base64ToBytes(split.trailer))) as {
      payload?: unknown;
      sig?: unknown;
    };
  } catch {
    throw new PluginRejected("the plugin signature block is not readable", "signature");
  }
  if (typeof envelope.payload !== "string" || typeof envelope.sig !== "string") {
    throw new PluginRejected("the plugin signature block is malformed", "signature");
  }

  let key: CryptoKey;
  try {
    key = await subtle.importKey("jwk", publicKey, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  } catch {
    throw new PluginRejected("the built-in plugin key is not a usable P-256 JWK", "signature");
  }
  const valid = await subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    base64ToBytes(envelope.sig),
    new TextEncoder().encode(envelope.payload)
  );
  if (!valid) throw new PluginRejected("this plugin's signature is INVALID — refusing it", "signature");

  let manifest: PluginManifest;
  try {
    manifest = JSON.parse(envelope.payload) as PluginManifest;
  } catch {
    throw new PluginRejected("the signed manifest is not valid JSON", "shape");
  }
  assertUsable(manifest);

  const hex = await sha256Hex(split.code);
  if (hex !== manifest.sha256) {
    throw new PluginRejected(`${manifest.id}'s code does not match its signed fingerprint`, "fingerprint");
  }

  return { manifest, code: split.code.slice().buffer as ArrayBuffer };
}

/**
 * `assertUsable` is deliberately strict about the fields a *remote* manifest
 * cannot be trusted to have: a missing `sha256` would otherwise read as
 * "nothing to compare", which is the one value that must never pass.
 */
export function assertUsable(m: PluginManifest): void {
  if (!m || typeof m.id !== "string" || !m.id || typeof m.version !== "string") {
    throw new PluginRejected("plugin manifest is missing an id or version", "shape");
  }
  if (typeof m.sha256 !== "string" || !HEX_256.test(m.sha256)) {
    throw new PluginRejected(`plugin ${m.id} has no usable SHA-256`, "fingerprint");
  }
  if (m.hostApi !== HOST_API_VERSION) {
    throw new PluginRejected(
      `plugin ${m.id} targets host API ${m.hostApi}, this build speaks ${HOST_API_VERSION}`,
      "host-api"
    );
  }
}

export function assertModule(mod: unknown, id: string): PluginModule {
  const m = mod as Partial<PluginModule> | null;
  if (!m || m.apiVersion !== HOST_API_VERSION || typeof m.Component !== "function") {
    throw new PluginRejected(`plugin ${id} did not export a compatible Component`, "shape");
  }
  return m as PluginModule;
}
