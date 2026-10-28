/**
 * The release manifest: what a FISH update is, and how one is proved.
 *
 * The shell is not installed over anything — it IS the file. An update is
 * therefore "fetch a newer empty shell, pour this document into it, write that
 * file", so the only thing that travels between releases is the document, and
 * the only thing an attacker could substitute is the shell. Hence the two gates:
 * a signature over the manifest (so the URL and the hash are not themselves
 * chosen by whoever answers the request), and a SHA-256 over the downloaded
 * bytes (so the file that answers is the file the manifest named).
 *
 * Both are all-or-nothing. There is deliberately no "verify if you can" path:
 * a fallback that accepts an unsigned manifest is a downgrade an attacker can
 * simply trigger by stripping the signature, so an unusable key disables the
 * check instead of weakening it (`config.isConfigured`).
 */

export const RELEASE_APP_ID = "fish";

export interface ReleasePayload {
  app: string;
  version: string;
  /** Absolute http(s) URL of the shell to download. */
  url: string;
  /** Lowercase hex SHA-256 of the bytes at `url`. */
  sha256: string;
}

interface SignedEnvelope {
  payload: string;
  sig: string;
}

/** Every failure here is a refusal, and each one says what it refused. */
export class UpdateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UpdateError";
  }
}

function isHex256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/i.test(value);
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return /^https?:$/.test(new URL(value).protocol);
  } catch {
    return false;
  }
}

/**
 * Dotted-numeric compare, so `0.10.0 > 0.9.0`. Segments are compared left to
 * right as numbers and a missing segment is 0, which makes `1.2` and `1.2.0`
 * the same version rather than an accidental downgrade.
 */
export function compareVersions(a: string, b: string): number {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] || 0) - (right[i] || 0);
    if (diff) return diff;
  }
  return 0;
}

export function isNewer(remote: string, local: string): boolean {
  return compareVersions(remote, local) > 0;
}

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function toHex(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let out = "";
  for (const byte of view) out += byte.toString(16).padStart(2, "0");
  return out;
}

export async function sha256Hex(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new UpdateError("this browser cannot verify downloads (no WebCrypto)");
  // Copied rather than passed through: `digest` takes a `BufferSource`, and a
  // Uint8Array over a SharedArrayBuffer is not one.
  const source = bytes instanceof Uint8Array ? Uint8Array.from(bytes) : new Uint8Array(bytes);
  return toHex(await subtle.digest("SHA-256", source));
}

/**
 * Check the bytes against the hash the manifest named. Separate from
 * {@link sha256Hex} so the "the file has moved under us" case is a distinct
 * message from "this browser cannot check" — one is a server problem, the other
 * is a platform floor, and the panel says different things for each.
 */
export async function verifyDigest(
  bytes: ArrayBuffer | Uint8Array,
  expected: string
): Promise<void> {
  const actual = await sha256Hex(bytes);
  if (actual !== expected.toLowerCase()) {
    throw new UpdateError("the downloaded shell does not match the release hash — refusing it");
  }
}

/**
 * Verify the envelope and return its payload.
 *
 * The signature covers the payload STRING, not the parsed object: re-serialising
 * it would make verification depend on key order and spacing, which is exactly
 * the kind of thing that turns into an intermittent failure nobody can
 * reproduce.
 */
export async function verifyEnvelope(text: string, publicKey: JsonWebKey): Promise<ReleasePayload> {
  let envelope: SignedEnvelope;
  try {
    envelope = JSON.parse(text) as SignedEnvelope;
  } catch {
    throw new UpdateError("the release manifest is not valid JSON");
  }
  if (typeof envelope?.payload !== "string" || typeof envelope?.sig !== "string") {
    throw new UpdateError("the release manifest is malformed");
  }
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new UpdateError("this browser cannot verify the manifest (no WebCrypto)");
  let key: CryptoKey;
  try {
    key = await subtle.importKey("jwk", publicKey, { name: "ECDSA", namedCurve: "P-256" }, false, [
      "verify"
    ]);
  } catch {
    throw new UpdateError("the built-in release key is not a usable P-256 JWK");
  }
  const valid = await subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    base64ToBytes(envelope.sig),
    new TextEncoder().encode(envelope.payload)
  );
  if (!valid) throw new UpdateError("the release manifest signature is INVALID — refusing it");

  let payload: ReleasePayload;
  try {
    payload = JSON.parse(envelope.payload) as ReleasePayload;
  } catch {
    throw new UpdateError("the release manifest payload is not valid JSON");
  }
  // A manifest signed for another app, or one whose fields do not type-check, is
  // refused rather than repaired: it means the key or the file is not what this
  // build expects, and guessing which field to trust is how a downgrade ships.
  if (payload?.app !== RELEASE_APP_ID) {
    throw new UpdateError(`the release manifest is for "${String(payload?.app)}", not fish`);
  }
  if (typeof payload.version !== "string" || !payload.version) {
    throw new UpdateError("the release manifest has no version");
  }
  if (!isHttpUrl(payload.url)) {
    throw new UpdateError("the release manifest has no downloadable url");
  }
  if (!isHex256(payload.sha256)) {
    throw new UpdateError("the release manifest has no usable sha256");
  }
  return { ...payload, sha256: payload.sha256.toLowerCase() };
}