import { describe, it, expect, afterEach } from "vitest";
import {
  EXTERNAL_FETCH_TIMEOUT_MS,
  externalFetch,
  isAbortFailure,
  publicProxyUrl,
  timeoutSignal
} from "../src/core/net/external-fetch";

describe("publicProxyUrl", () => {
  it("passes a plain public https URL through", () => {
    expect(publicProxyUrl("https://cdn.example.com/hero.png")).toBe(
      `https://wsrv.nl/?url=${encodeURIComponent("https://cdn.example.com/hero.png")}`
    );
  });

  it("refuses unencrypted URLs, so the proxy never sees what the origin would not encrypt", () => {
    expect(publicProxyUrl("http://example.com/hero.png")).toBeNull();
  });

  it("refuses every address that names a machine on the user's own network", () => {
    for (const url of [
      "https://localhost/hero.png",
      "https://app.localhost/hero.png",
      "https://127.0.0.1/hero.png",
      "https://10.1.2.3/hero.png",
      "https://172.20.0.4/hero.png",
      "https://192.168.1.5/hero.png",
      "https://169.254.169.254/latest/meta-data",
      "https://100.64.0.1/hero.png",
      "https://nas/hero.png",
      "https://build.internal/hero.png",
      "https://printer.local/hero.png",
      "https://[::1]/hero.png",
      "https://[fd00::1]/hero.png",
      "https://[fe80::1]/hero.png"
    ]) {
      expect(publicProxyUrl(url), url).toBeNull();
    }
  });

  it("refuses URLs that are credentials in disguise", () => {
    for (const url of [
      "https://user:pass@example.com/hero.png",
      "https://bucket.s3.amazonaws.com/hero.png?X-Amz-Signature=abc&X-Amz-Credential=def",
      "https://cdn.example.com/hero.png?token=secret",
      "https://cdn.example.com/hero.png?sig=abc",
      "https://cdn.example.com/hero.png?Expires=1700000000",
      "https://storage.example.com/hero.png?key=abc"
    ]) {
      expect(publicProxyUrl(url), url).toBeNull();
    }
  });

  it("keeps query strings that only describe the image", () => {
    expect(publicProxyUrl("https://cdn.example.com/hero.png?w=1200&fmt=webp")).not.toBeNull();
  });

  it("refuses anything that does not parse as a URL", () => {
    expect(publicProxyUrl("not a url")).toBeNull();
  });
});

describe("externalFetch", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("gives up on a request that never answers", async () => {
    // The failure this exists for: a half-open connection leaves the caller's
    // promise unsettled forever, so the row that started it never leaves its
    // loading state and nothing can retry it.
    globalThis.fetch = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject((init.signal as AbortSignal).reason));
      })) as unknown as typeof fetch;

    await expect(externalFetch("https://example.com/hero.png", { timeoutMs: 10 })).rejects.toMatchObject({
      name: "TimeoutError"
    });
  });

  it("lets the caller's own signal cancel, and reports it as a cancellation", async () => {
    globalThis.fetch = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject((init.signal as AbortSignal).reason));
      })) as unknown as typeof fetch;

    const controller = new AbortController();
    const pending = externalFetch("https://example.com/hero.png", { signal: controller.signal });
    controller.abort(new DOMException("Withdrawn", "AbortError"));
    const err = await pending.catch((e: unknown) => e);
    expect(isAbortFailure(err)).toBe(true);
  });

  it("uses a fifteen second deadline by default", () => {
    expect(EXTERNAL_FETCH_TIMEOUT_MS).toBe(15_000);
    expect(timeoutSignal()).toBeInstanceOf(AbortSignal);
  });
});

describe("isAbortFailure", () => {
  it("separates a cancellation from a refusal", () => {
    expect(isAbortFailure(new DOMException("x", "AbortError"))).toBe(true);
    expect(isAbortFailure(new DOMException("x", "TimeoutError"))).toBe(true);
    expect(isAbortFailure(new TypeError("Failed to fetch"))).toBe(false);
    expect(isAbortFailure(new Error("404"))).toBe(false);
    expect(isAbortFailure(null)).toBe(false);
  });
});
