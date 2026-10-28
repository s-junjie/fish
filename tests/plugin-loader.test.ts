import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  installPlugin,
  installFromFile,
  installedRecords,
  memoryStorage,
  openPlugin,
  setPluginKey,
  setPluginStorage,
  uninstallPlugin
} from "../src/core/plugins/loader";
import { assertModule, assertUsable, HOST_API_VERSION, PluginRejected, sha256Hex } from "../src/core/plugins/manifest";
import type { PluginManifest } from "../src/core/plugins/manifest";

/**
 * A plugin is a file that proves who published it. These cases are about the
 * proof, not about the panel: what a signature accepts, what it refuses, and what
 * survives being written to (and tampered with in) the browser's storage.
 */

const ALG = { name: "ECDSA", namedCurve: "P-256" };
const SIGN = { name: "ECDSA", hash: "SHA-256" };
const TRAILER = "\n//#fish-plugin:";
const CODE = "export const apiVersion = '1'; export const Component = () => null;";

async function newKey() {
  const pair = await crypto.subtle.generateKey(ALG, true, ["sign", "verify"]);
  const publicKey = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return { pair, publicKey };
}

function concat(a: Uint8Array, b: Uint8Array): ArrayBuffer {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out.buffer as ArrayBuffer;
}

function b64(bytes: ArrayBuffer | Uint8Array): string {
  return Buffer.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).toString("base64");
}

/** Exactly what `scripts/build-plugin.mjs` writes, without importing the shell. */
async function signWith(
  privateKey: CryptoKey,
  code: string,
  overrides: Partial<PluginManifest> = {}
): Promise<{ file: ArrayBuffer; manifest: PluginManifest }> {
  const codeBytes = new TextEncoder().encode(code);
  const manifest: PluginManifest = {
    id: "fish.test",
    name: "Test Plugin",
    description: "",
    category: "plugin",
    icon: "sparkles",
    version: "1.0.0",
    hostApi: HOST_API_VERSION,
    sha256: await sha256Hex(codeBytes),
    bytes: codeBytes.length,
    ...overrides
  };
  const payload = JSON.stringify(manifest);
  const sig = await crypto.subtle.sign(SIGN, privateKey, new TextEncoder().encode(payload));
  const envelope = Buffer.from(JSON.stringify({ payload, sig: b64(sig) })).toString("base64");
  return { file: concat(codeBytes, new TextEncoder().encode(`${TRAILER} ${envelope}\n`)), manifest };
}

let key: Awaited<ReturnType<typeof newKey>>;

beforeEach(async () => {
  key = await newKey();
  setPluginKey(key.publicKey);
  setPluginStorage(memoryStorage());
});

afterEach(() => {
  setPluginKey(null);
  setPluginStorage(null);
});

describe("a signed plugin file", () => {
  it("installs, and keeps only the code", async () => {
    const { file, manifest } = await signWith(key.pair.privateKey, CODE);
    const record = await installPlugin(file);
    expect(record.id).toBe("fish.test");

    const rows = await installedRecords();
    expect(rows.map((r) => r.id)).toEqual(["fish.test"]);
    // The trailer is proof, not payload: what is stored is the code alone.
    expect(new TextDecoder().decode(rows[0].bytes)).not.toContain("#fish-plugin:");
    expect(rows[0].manifest.sha256).toBe(manifest.sha256);
  });

  it("is refused when the code was edited after signing", async () => {
    const { file } = await signWith(key.pair.privateKey, CODE);
    const bytes = new Uint8Array(file);
    bytes[0] = "x".charCodeAt(0); // breaks the hash the signed manifest names
    await expect(installPlugin(bytes.buffer as ArrayBuffer)).rejects.toThrow(/fingerprint|signature/);
  });

  it("is refused when the manifest was edited after signing", async () => {
    const { file } = await signWith(key.pair.privateKey, CODE);
    // Rewrite the envelope the way a forger would: keep the code, change who
    // published it, keep the signature.
    const text = new TextDecoder().decode(file);
    const at = text.lastIndexOf(TRAILER);
    const envelope = JSON.parse(Buffer.from(text.slice(at + TRAILER.length).trim(), "base64").toString("utf8"));
    envelope.payload = envelope.payload.replace('"name":"Test Plugin"', '"name":"Somebody Else"');
    const forged =
      text.slice(0, at) + `${TRAILER} ${Buffer.from(JSON.stringify(envelope)).toString("base64")}\n`;

    await expect(installPlugin(new TextEncoder().encode(forged).buffer as ArrayBuffer)).rejects.toThrow(
      /signature is INVALID/
    );
  });

  it("is refused when it was signed by another key", async () => {
    const other = await newKey();
    const { file } = await signWith(other.pair.privateKey, CODE);
    await expect(installPlugin(file)).rejects.toBeInstanceOf(PluginRejected);
  });

  it("is refused by a build with no key at all", async () => {
    setPluginKey(null);
    const { file } = await signWith(key.pair.privateKey, CODE);
    await expect(installPlugin(file)).rejects.toThrow(/was not given a plugin key/);
  });

  it("is refused when it carries no signature", async () => {
    const raw = new TextEncoder().encode(CODE).buffer as ArrayBuffer;
    await expect(installPlugin(raw)).rejects.toThrow(/not a signed plugin/);
  });

  it("is refused when it speaks a different host API", async () => {
    const { file } = await signWith(key.pair.privateKey, CODE, { hostApi: "0" });
    await expect(installPlugin(file)).rejects.toThrow(/host API/);
  });

  it("is identified by its signature, never by the file name", async () => {
    const { file } = await signWith(key.pair.privateKey, CODE);
    // A Blob carries the name the user picked; nothing reads it.
    const pick = new File([file], "completely-misleading.js", { type: "text/javascript" });
    const record = await installFromFile(pick);
    expect(record.id).toBe("fish.test");
  });
});

describe("the installed copy", () => {
  it("is re-hashed on every open, so an edited row never becomes code", async () => {
    const { file, manifest } = await signWith(key.pair.privateKey, CODE);
    await installPlugin(file);

    setPluginStorage(
      memoryStorage([
        {
          id: manifest.id,
          manifest,
          bytes: new TextEncoder().encode(`${CODE}// extra`).buffer as ArrayBuffer,
          installedAt: Date.now()
        }
      ])
    );

    await expect(openPlugin(manifest.id)).rejects.toThrow(/no longer matches/);
    // …and the evidence is gone, not left to fail the same way every launch.
    await expect(openPlugin(manifest.id)).rejects.toThrow(/not installed/);
  });

  it("is gone after uninstall", async () => {
    const { file, manifest } = await signWith(key.pair.privateKey, CODE);
    await installPlugin(file);
    await uninstallPlugin(manifest.id);
    await expect(openPlugin(manifest.id)).rejects.toThrow(/not installed/);
  });
});

describe("the bundle contract", () => {
  it("accepts a module that exports apiVersion and Component", () => {
    expect(assertModule({ apiVersion: HOST_API_VERSION, Component: () => null }, "fish.x")).toBeTruthy();
  });

  it("rejects a module with a different API or no component", () => {
    expect(() => assertModule({ apiVersion: "0", Component: () => null }, "fish.x")).toThrow(/compatible/);
    expect(() => assertModule({ apiVersion: HOST_API_VERSION }, "fish.x")).toThrow(/compatible/);
    expect(() => assertModule(null, "fish.x")).toThrow(/compatible/);
  });

  it("requires the fields a signed manifest must never omit", () => {
    expect(() => assertUsable({ id: "", version: "1" } as PluginManifest)).toThrow(/id or version/);
  });
});
