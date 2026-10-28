// The update path's refusals, and the one thing it must never do: check anyway
// without a trust root. Everything here runs in Node — the crypto is WebCrypto,
// which Node has — so no browser and no published endpoint is needed.

import { beforeAll, describe, expect, it, vi } from "vitest";
import { compareVersions, isNewer, sha256Hex, verifyEnvelope, UpdateError } from "../src/core/update";
import { checkForUpdate } from "../src/core/update/check";
import { isConfigured } from "../src/core/update/config";

/**
 * The signing key is generated per run and never written down.
 *
 * A hard-coded JWK here would be a private key in the repository forever, and a
 * test key that outlives the suite is exactly how a real one ends up committed
 * by accident. Nothing this suite signs has to survive the process.
 */
let PRIVATE_JWK: JsonWebKey;
let PUBLIC_JWK: JsonWebKey;

beforeAll(async () => {
  const pair = await globalThis.crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"]
  );
  PRIVATE_JWK = await globalThis.crypto.subtle.exportKey("jwk", pair.privateKey);
  PUBLIC_JWK = await globalThis.crypto.subtle.exportKey("jwk", pair.publicKey);
});

async function sign(payload: unknown, key: JsonWebKey = PRIVATE_JWK): Promise<string> {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  const subtle = globalThis.crypto.subtle;
  const cryptoKey = await subtle.importKey("jwk", key as JsonWebKey, { name: "ECDSA", namedCurve: "P-256" }, false, [
    "sign"
  ]);
  const sig = await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, cryptoKey, new TextEncoder().encode(body));
  let binary = "";
  for (const byte of new Uint8Array(sig)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** A real second keypair: a fabricated `d` is rejected at import, not at verify. */
async function anotherPrivateKey(): Promise<JsonWebKey> {
  const pair = await globalThis.crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"]
  );
  return globalThis.crypto.subtle.exportKey("jwk", pair.privateKey);
}

async function envelope(payload: unknown, key: JsonWebKey = PRIVATE_JWK): Promise<string> {
  const body = JSON.stringify(payload);
  return JSON.stringify({ payload: body, sig: await sign(body, key) });
}

const VALID = { app: "fish", version: "9.9.9", url: "https://example.test/fish.html", sha256: "a".repeat(64) };

describe("compareVersions", () => {
  it("compares segment by segment as numbers, not as text", () => {
    expect(compareVersions("0.10.0", "0.9.0")).toBeGreaterThan(0);
    expect(compareVersions("1.2.0", "1.10.0")).toBeLessThan(0);
  });

  it("treats a missing trailing segment as zero", () => {
    expect(compareVersions("1.2", "1.2.0")).toBe(0);
    expect(compareVersions("1.2.1", "1.2")).toBeGreaterThan(0);
    expect(compareVersions("1.2", "1.2.1")).toBeLessThan(0);
  });

  it("refuses a downgrade as an update", () => {
    expect(isNewer("0.0.1", "0.1.0")).toBe(false);
    expect(isNewer("0.0.1", "0.0.1")).toBe(false);
  });
});

describe("sha256Hex", () => {
  it("hashes the empty input to the known digest", async () => {
    await expect(sha256Hex(new Uint8Array(0))).resolves.toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
  });

  it("is lowercase hex of the right length", async () => {
    const digest = await sha256Hex(new TextEncoder().encode("fish"));
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("verifyEnvelope", () => {
  it("returns the payload when the signature is ours", async () => {
    await expect(verifyEnvelope(await envelope(VALID), PUBLIC_JWK)).resolves.toEqual(VALID);
  });

  it("refuses a signature made by another key", async () => {
    const text = await envelope(VALID, await anotherPrivateKey());
    await expect(verifyEnvelope(text, PUBLIC_JWK)).rejects.toThrow(/signature is INVALID/);
  });

  it("refuses a payload edited after signing", async () => {
    // The classic downgrade: the manifest that was signed said 1.0.0, and
    // someone with write access to the response replaced it with 0.0.1.
    const signed = JSON.stringify({ ...VALID, version: "1.0.0" });
    const sig = await sign(signed);
    const tampered = JSON.stringify({ payload: JSON.stringify({ ...VALID, version: "0.0.1" }), sig });
    await expect(verifyEnvelope(tampered, PUBLIC_JWK)).rejects.toThrow(/signature is INVALID/);
  });

  it("refuses a manifest for another app even when it is correctly signed", async () => {
    const text = await envelope({ ...VALID, app: "someone-elses-app" });
    await expect(verifyEnvelope(text, PUBLIC_JWK)).rejects.toThrow(/not fish/);
  });

  it("refuses a manifest whose url is not http(s)", async () => {
    for (const url of ["file:///tmp/x.html", "javascript:alert(1)", "not-a-url"]) {
      const text = await envelope({ ...VALID, url });
      await expect(verifyEnvelope(text, PUBLIC_JWK)).rejects.toThrow(/no downloadable url/);
    }
  });

  it("refuses a manifest with no usable hash", async () => {
    const text = await envelope({ ...VALID, sha256: "nope" });
    await expect(verifyEnvelope(text, PUBLIC_JWK)).rejects.toThrow(/no usable sha256/);
  });

  it("reports malformed envelopes as such rather than as a bad signature", async () => {
    await expect(verifyEnvelope("{", PUBLIC_JWK)).rejects.toThrow(/not valid JSON/);
    await expect(verifyEnvelope(JSON.stringify({ payload: 1, sig: 2 }), PUBLIC_JWK)).rejects.toThrow(
      /malformed/
    );
  });

  it("signs the payload string, so whitespace in the file cannot break it", async () => {
    // The signature covers the exact bytes of `payload`. Re-indenting the file
    // around it is fine; changing the payload's own spacing is not, and that is
    // the property that lets the shell verify without re-serialising anything.
    const pretty = await envelope(VALID, PRIVATE_JWK);
    const parsed = JSON.parse(pretty);
    const reflowed = JSON.stringify({ payload: parsed.payload, sig: parsed.sig }, null, 4);
    await expect(verifyEnvelope(reflowed, PUBLIC_JWK)).resolves.toEqual(VALID);
  });

  it("throws UpdateError, so a caller can tell a refusal from a crash", async () => {
    await expect(verifyEnvelope("{}", PUBLIC_JWK)).rejects.toBeInstanceOf(UpdateError);
  });
});
describe("the shipped default", () => {
  it("has no release endpoint, because none is published yet", () => {
    // This build was given neither define, which is the state of every build
    // made before a release address exists. It is asserted rather than assumed:
    // a build that quietly grew a key in `vite.config.ts` would change what
    // "no endpoint" means.
    expect(isConfigured()).toBe(false);
  });

  it("refuses to check at all, and reaches for the network not once", async () => {
    // The load-bearing one. An absent key is not "check anyway": it would accept
    // whatever the network answered, which is worse than never updating.
    const fetchImpl = vi.fn();
    const result = await checkForUpdate({ manual: true, fetchImpl: fetchImpl as never });
    expect(result).toEqual({ status: "disabled", reason: "not-configured" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
