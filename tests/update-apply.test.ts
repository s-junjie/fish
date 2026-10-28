// What an update actually does to a file, and what it refuses to do.
//
// The success path that needs a real parser (downloading and re-serialising the
// shell) is browser-only and is covered by opening the built file; everything
// here is either pure string work or a refusal that must happen BEFORE any DOM
// is involved — which is also why these tests run in plain Node, where there is
// no DOMParser to reach for by accident.

import { beforeAll, describe, expect, it, vi } from "vitest";
import { APP_VERSION } from "../src/core/version";
import { checkAtLaunch, checkForUpdate } from "../src/core/update/check";
import { buildUpdatedFile, downloadShell, assertUsableShell } from "../src/core/update/apply";
import { documentFromHtml, serializeSelf, createEmptyDocument } from "../src/core/data-bridge";
import type { ReleasePayload } from "../src/core/update";

const SHELL_V1 = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>FISH</title>
  <script id="fish-rt" type="fish/deflate-b86" data-chars="10">AAAA</script>
  <script id="design-doc" type="application/json">
  { "version": "0.1", "name": "Whatever the shell shipped with" }
  </script>
</head>
<body><div id="app"></div></body>
</html>`;

const SHELL_V2 = SHELL_V1
  .replace('data-chars="10">AAAA', 'data-chars="99">BBBB')
  .replace("Whatever the shell shipped with", "The shell's own placeholder document");

function release(over: Partial<ReleasePayload> = {}): ReleasePayload {
  return {
    app: "fish",
    version: "2.0.0",
    url: "https://example.test/fish.html",
    sha256: "0".repeat(64),
    ...over
  };
}

describe("buildUpdatedFile", () => {
  it("carries the document into the NEW shell, not the one that wrote it", () => {
    const doc = createEmptyDocument();
    doc.name = "The Design";
    doc.pages![0].children = [];

    const updated = buildUpdatedFile(doc, SHELL_V2);

    expect(updated).toContain('data-chars="99">BBBB');
    expect(updated).not.toContain('data-chars="10">AAAA');
    expect(updated).not.toContain("The shell's own placeholder document");
    expect(documentFromHtml(updated)?.name).toBe("The Design");
  });

  it("produces a file the app's own reader accepts", () => {
    const doc = createEmptyDocument();
    doc.name = "Round Trip";
    const roundTripped = documentFromHtml(buildUpdatedFile(doc, SHELL_V2));
    expect(roundTripped).toBeDefined();
    expect(roundTripped!.name).toBe("Round Trip");
    expect(roundTripped!.version).toBe(doc.version);
    // And re-saving that file changes nothing structural: the shell it now
    // carries is the one it was just upgraded to, not the one that saved it.
    expect(serializeSelf(roundTripped!, SHELL_V2)).toContain('data-chars="99">BBBB');
  });

  it("keeps the shell's own plaintext blocks — one of each, not two", () => {
    const doc = createEmptyDocument();
    const updated = buildUpdatedFile(doc, SHELL_V2);
    expect(updated.match(/id="design-doc"/g)).toHaveLength(1);
    expect(updated.match(/id="fish-rt"/g)).toHaveLength(1);
  });

  it("does not touch the document when the template is the same shell", () => {
    const doc = createEmptyDocument();
    doc.name = "Untouched";
    expect(documentFromHtml(buildUpdatedFile(doc, SHELL_V1))?.name).toBe("Untouched");
  });
});

describe("assertUsableShell", () => {
  const shellWith = (id: string | null) =>
    ({ head: {}, getElementById: (want: string) => (want === id ? {} : null) }) as unknown as Document;

  it("refuses a shell with no editor runtime, however well it hashes", () => {
    // The release is not a shell at all — the case a hash check cannot catch,
    // and the one that would otherwise produce a document that opens blank.
    expect(() => assertUsableShell(shellWith(null), "2.0.0")).toThrow(/no editor runtime/);
  });

  it("accepts a shell carrying the runtime block", () => {
    expect(() => assertUsableShell(shellWith("fish-rt"), "2.0.0")).not.toThrow();
  });
});

describe("downloadShell", () => {
  const bytes = new TextEncoder().encode(SHELL_V2);

  it("refuses a body that does not match the manifest hash", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, arrayBuffer: async () => bytes.buffer }));
    await expect(downloadShell(release(), fetchImpl)).rejects.toThrow(/does not match the release hash/);
    // Proof the hash was checked FIRST: this test runs in Node, where DOMParser
    // does not exist. Had it parsed before verifying, this would be a
    // ReferenceError instead of a refusal.
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("reports a failed download without pretending it was a bad file", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 404, arrayBuffer: async () => bytes.buffer }));
    await expect(downloadShell(release(), fetchImpl)).rejects.toThrow(/downloading the update failed \(404\)/);
  });

  it("does not cache: a stale 200 is the one answer a release server gets wrong", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: { cache?: string }) => ({
      ok: false,
      status: 500,
      arrayBuffer: async () => bytes.buffer
    }));
    await expect(downloadShell(release(), fetchImpl)).rejects.toThrow();
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ cache: "no-store" });
  });
});

const MANIFEST_URL = "https://example.test/manifest.json";

/** Generated per run, never written down — see the note in update-manifest. */
let PUBLIC_JWK: JsonWebKey;
let PRIVATE_JWK: JsonWebKey;

beforeAll(async () => {
  const pair = await globalThis.crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"]
  );
  PRIVATE_JWK = await globalThis.crypto.subtle.exportKey("jwk", pair.privateKey);
  PUBLIC_JWK = await globalThis.crypto.subtle.exportKey("jwk", pair.publicKey);
});

/** One step below and one step above this build's own version. */
function bump(version: string): [string, string] {
  const parts = version.split(".").map(Number);
  if (parts.some((n) => Number.isNaN(n))) return ["0.0.0", "99.0.0"];
  const at = (n: number) => `${parts[0]}.${parts[1]}.${n}`;
  return [at(Math.max(0, parts[2] - 1)), at(parts[2] + 1)];
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

describe("checkForUpdate", () => {
  // Sources are passed in rather than mocked, because this suite runs with
  // `isolate: false`: a module mock registered here would follow every later
  // test file in the same worker.
  const sources = () => ({ url: MANIFEST_URL, key: PUBLIC_JWK });

  async function signedManifest(payload: unknown, key: JsonWebKey = PRIVATE_JWK): Promise<string> {
    const body = JSON.stringify(payload);
    const cryptoKey = await globalThis.crypto.subtle.importKey(
      "jwk",
      key,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"]
    );
    const sig = await globalThis.crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      cryptoKey,
      new TextEncoder().encode(body)
    );
    let binary = "";
    for (const byte of new Uint8Array(sig)) binary += String.fromCharCode(byte);
    return JSON.stringify({ payload: body, sig: btoa(binary) });
  }

  function manifestFetch(text: string) {
    return vi.fn(async (_url: string, _init?: { cache?: string }) => ({
      ok: true,
      status: 200,
      text: async () => text
    }));
  }

  function manifest(version: string) {
    return signedManifest({
      app: "fish",
      version,
      url: "https://example.test/fish.html",
      sha256: "b".repeat(64)
    });
  }

  // APP_VERSION comes from the same `define` the build uses, so these are real
  // comparisons against the version this suite is running as.
  const [BELOW, ABOVE] = bump(APP_VERSION);

  it("reports a newer signed release as an update", async () => {
    const fetchImpl = manifestFetch(await manifest(ABOVE));
    const result = await checkForUpdate({ fetchImpl, sources: sources() });
    expect(result.status).toBe("update");
    if (result.status === "update") expect(result.release.version).toBe(ABOVE);
    expect(fetchImpl.mock.calls[0][0]).toBe(MANIFEST_URL);
  });

  it("reports the same version as current, and an older one as current too", async () => {
    for (const version of [APP_VERSION, BELOW]) {
      const result = await checkForUpdate({
        fetchImpl: manifestFetch(await manifest(version)),
        sources: sources()
      });
      expect(result).toEqual({ status: "current", version: APP_VERSION });
    }
  });

  it("refuses a manifest whose signature does not verify", async () => {
    const text = await signedManifest(
      { app: "fish", version: ABOVE, url: "https://evil.test/x", sha256: "b".repeat(64) },
      await anotherPrivateKey()
    );
    const result = await checkForUpdate({ fetchImpl: manifestFetch(text), sources: sources() });
    expect(result.status).toBe("error");
    if (result.status === "error") expect(result.message).toMatch(/signature is INVALID/);
  });

  it("turns a transport failure into a sentence about reachability, not a status code", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    const result = await checkForUpdate({ fetchImpl: fetchImpl as never, sources: sources() });
    expect(result.status).toBe("error");
    if (result.status === "error") expect(result.message).toMatch(/could not be reached from this file/);
  });

  it("says what the server answered when it answered something", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 503, text: async () => "" }));
    const result = await checkForUpdate({ fetchImpl: fetchImpl as never, sources: sources() });
    expect(result.status).toBe("error");
    if (result.status === "error") expect(result.message).toBe("the release server answered 503");
  });

  it("reports a launch pass as a result, so the panel can say it FAILED to check", async () => {
    // Returning null for an unreachable server would leave the panel claiming
    // the user is on the latest version — a claim it cannot make.
    await expect(
      checkAtLaunch({ fetchImpl: manifestFetch(await manifest(APP_VERSION)), sources: sources() })
    ).resolves.toEqual({ status: "current", version: APP_VERSION });
    await expect(
      checkAtLaunch({
        fetchImpl: (async () => {
          throw new TypeError("Failed to fetch");
        }) as never,
        sources: sources()
      })
    ).resolves.toMatchObject({ status: "error" });
  });

  it("runs nothing at all when there is nowhere to look", async () => {
    const fetchImpl = vi.fn();
    await expect(
      checkAtLaunch({ fetchImpl: fetchImpl as never, sources: { url: null, key: null } })
    ).resolves.toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("says the check is disabled rather than failing when there is nowhere to look", async () => {
    const fetchImpl = vi.fn();
    for (const sources of [
      { url: null, key: null },
      { url: MANIFEST_URL, key: null }
    ]) {
      const result = await checkForUpdate({ manual: true, fetchImpl: fetchImpl as never, sources });
      expect(result).toEqual({ status: "disabled", reason: "not-configured" });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
