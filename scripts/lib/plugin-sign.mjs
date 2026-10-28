/**
 * Signing for plugin bundles.
 *
 * A plugin file carries its own identity and proof:
 *
 *     <code bytes>
 *     \n//#fish-plugin: <base64 of {payload, sig}>
 *
 * `payload` is the manifest (id, name, version, sha256 of the code, …) and `sig`
 * is an ECDSA P-256 signature over that exact string. The shell is built with
 * nothing but the matching public key, so it does not know which plugins exist —
 * it only knows who is allowed to have written one. That is what makes an
 * offline sideload work without a baked list: the file vouches for itself.
 *
 * The trailer is a comment, so a signed file is still a runnable ES module.
 *
 * The private key lives in `.fish-plugin-key.json` at the repo root and is
 * gitignored. Losing it only means signing the next release with a new key, which
 * costs a shell rebuild — the same trade the release key already makes.
 *
 * CI supplies `FISH_PLUGIN_PRIVATE_KEY` instead: the same JSON shape as the file
 * (or a bare private JWK). It is read, never written, and the public half is
 * derived when the variable does not carry one — a release cannot publish a
 * plugin whose key the shell was not built to trust.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const KEY_FILE = path.resolve(process.cwd(), ".fish-plugin-key.json");
export const TRAILER = "\n//#fish-plugin:";
const TRAILER_BYTES = new TextEncoder().encode(TRAILER);
const ALG = { name: "ECDSA", namedCurve: "P-256" };

function b64(bytes) {
  return Buffer.from(bytes).toString("base64");
}

/** The CI key, or null when the variable is unset. Throws on a malformed value. */
export function envKey() {
  const raw = process.env.FISH_PLUGIN_PRIVATE_KEY;
  if (!raw) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("FISH_PLUGIN_PRIVATE_KEY is not valid JSON");
  }
  const privateKey = parsed?.privateKey ?? parsed;
  if (!privateKey?.d) throw new Error("FISH_PLUGIN_PRIVATE_KEY carries no private JWK");
  const publicKey =
    parsed?.publicKey ??
    crypto.createPublicKey({ key: privateKey, format: "jwk" }).export({ format: "jwk" });
  return { privateKey, publicKey };
}

export function keyExists() {
  return Boolean(process.env.FISH_PLUGIN_PRIVATE_KEY) || fs.existsSync(KEY_FILE);
}

/**
 * Read the keypair, creating it on first use. `--init` is only about being able
 * to say "created" in the output; the build is allowed to bootstrap too, because
 * a build without a key produces a shell that accepts no plugins at all — a
 * worse surprise than generating one.
 */
export async function ensureKey() {
  const fromEnv = envKey();
  if (fromEnv) return { ...fromEnv, created: false };
  if (keyExists()) {
    return { ...JSON.parse(fs.readFileSync(KEY_FILE, "utf8")), created: false };
  }
  const pair = await crypto.subtle.generateKey(ALG, true, ["sign", "verify"]);
  const priv = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const pub = await crypto.subtle.exportKey("jwk", pair.publicKey);
  // Keep only what is needed to sign: the JWK `key_ops`/`ext` fields add noise.
  const key = {
    createdAt: new Date().toISOString(),
    privateKey: { kty: priv.kty, crv: priv.crv, x: priv.x, y: priv.y, d: priv.d },
    publicKey: { kty: pub.kty, crv: pub.crv, x: pub.x, y: pub.y }
  };
  fs.writeFileSync(KEY_FILE, `${JSON.stringify(key, null, 2)}\n`);
  return { ...key, created: true };
}

export async function signPlugin(codeBytes, manifest) {
  const key = await ensureKey();
  const payload = JSON.stringify(manifest);
  const privateKey = await crypto.subtle.importKey("jwk", key.privateKey, ALG, false, ["sign"]);
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    new TextEncoder().encode(payload)
  );
  const envelope = b64(JSON.stringify({ payload, sig: b64(sig) }));
  return {
    file: concat(codeBytes, new TextEncoder().encode(`${TRAILER} ${envelope}\n`)),
    publicKey: key.publicKey
  };
}

function concat(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** Split a signed file into code + envelope. Shared with the runtime verifier's tests. */
export function splitSigned(bytes) {
  const view = new Uint8Array(bytes);
  for (let i = view.length - TRAILER_BYTES.length; i >= 0; i--) {
    let hit = true;
    for (let j = 0; j < TRAILER_BYTES.length; j++) {
      if (view[i + j] !== TRAILER_BYTES[j]) {
        hit = false;
        break;
      }
    }
    if (!hit) continue;
    const code = view.slice(0, i);
    const trailer = new TextDecoder().decode(view.slice(i + TRAILER_BYTES.length)).trim();
    return { code, trailer };
  }
  return null;
}
