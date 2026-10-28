/**
 * Turning a URL or a local file into an embedded asset, without owning an image
 * policy of its own.
 *
 * Raster bytes go through `tools/image-harness.js` — the app's own
 * `loadImageAsset`, run in a headless browser — so `MAX_IMAGE_EDGE` and
 * `WEBP_QUALITY` stay defined in exactly one place. Formats the app passes
 * through untouched (SVG, GIF) have no policy to apply, so Node embeds those
 * bytes byte-for-byte and needs no browser at all.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { findBrowser, getChromeFlags, runBrowserForReport } from "./browser";
import { shouldPassThrough, svgIntrinsicSize } from "../interactions/image-loader";

const FETCH_TIMEOUT_MS = 20_000;
const FETCH_MAX_BYTES = 32 * 1024 * 1024;
const HARNESS_FILE = "image-harness.js";
const HARNESS_TIMEOUT_MS = 60_000;

export interface EmbeddedImage {
  uri: string;
  width: number;
  height: number;
  mime: string;
  bytes: number;
}

function ascii(bytes: Uint8Array, at: number, len: number): string {
  let s = "";
  for (let i = 0; i < len && at + i < bytes.length; i++) s += String.fromCharCode(bytes[at + i]);
  return s;
}

/**
 * Type from the bytes, never from the header or the extension: a CDN that
 * answers `application/octet-stream` for a PNG is ordinary, and an extension is
 * a claim the file makes about itself.
 */
export function sniffMime(bytes: Uint8Array): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return "image/webp";
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(ascii(bytes, 0, 6))) return "image/gif";
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) return "image/bmp";
  if (bytes.length >= 12 && ascii(bytes, 4, 4) === "ftyp" && /^(avif|avis)/.test(ascii(bytes, 8, 4))) return "image/avif";
  const start = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  const head = ascii(bytes, start, 1024).trimStart();
  if (/^<svg[\s>]/i.test(head)) return "image/svg+xml";
  if (/^<\?xml/i.test(head) && /<svg[\s>]/i.test(head)) return "image/svg+xml";
  return null;
}

/**
 * `fetch` reports every transport failure as "fetch failed" and keeps the reason
 * in `cause`; a CLI that prints only the first word of that tells the caller
 * nothing they can act on.
 */
function fetchFailure(err: unknown): string {
  const cause = (err as { cause?: { code?: string; message?: string } } | null)?.cause;
  return cause?.code || cause?.message || (err instanceof Error ? err.message : String(err));
}

export async function fetchImage(uri: string): Promise<{ bytes: Uint8Array; contentType: string | null }> {
  let res: Response;
  try {
    res = await fetch(uri, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: "follow" });
  } catch (err) {
    throw new Error(`fetch failed: ${fetchFailure(err)}`);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const contentType = res.headers.get("content-type")?.split(";")[0]?.trim() || null;
  if (!res.body) return { bytes: new Uint8Array(await res.arrayBuffer()), contentType };

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > FETCH_MAX_BYTES) {
      await reader.cancel();
      throw new Error(`over the ${Math.round(FETCH_MAX_BYTES / 1024 / 1024)}MB fetch cap`);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.length;
  }
  return { bytes, contentType };
}

/** The media type a `data:` URI declares, which is the type the policy produced. */
export function dataUriMime(uri: string): string | null {
  if (!uri.startsWith("data:")) return null;
  const comma = uri.indexOf(",");
  const head = uri.slice(5, comma < 0 ? undefined : comma);
  const type = head.split(";")[0].trim();
  return type || null;
}

/** Decoded payload bytes of a `data:` URI, or null when it is not one. */
export function dataUriBytes(uri: string): number | null {
  if (!uri.startsWith("data:")) return null;
  const comma = uri.indexOf(",");
  if (comma < 0) return null;
  const payload = uri.slice(comma + 1);
  if (!/;base64/i.test(uri.slice(0, comma))) return payload.length;
  const pad = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
  return Math.floor((payload.length * 3) / 4) - pad;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function findHarness(): string | null {
  const here = process.argv[1] ? path.dirname(process.argv[1]) : "";
  const candidates = [
    process.env.FISH_IMAGE_HARNESS,
    here && path.join(here, HARNESS_FILE),
    path.join(process.cwd(), HARNESS_FILE)
  ].filter((c): c is string => Boolean(c));
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}

/**
 * The page is served over HTTP rather than opened as a `file://` document so the
 * report POST is same-origin, and so the bytes can arrive as a request body
 * instead of being pasted into markup.
 */
function harnessPage(source: string, name: string, mime: string, b64: string): string {
  const inline = source.replace(/<\/(script)/gi, "<\\/$1");
  return `<!doctype html><meta charset="utf-8"><body>
<script>${inline}</script>
<script>
const report = (payload) =>
  fetch("/report", { method: "POST", body: JSON.stringify(payload) }).catch(() => {});
window.addEventListener("error", (e) => report({ ok: false, error: String(e.message) }));
(async () => {
  try {
    const r = await window.fishOptimizeImage(${JSON.stringify(name)}, ${JSON.stringify(mime)}, ${JSON.stringify(b64)});
    await report(Object.assign({ ok: true }, r));
  } catch (err) {
    await report({ ok: false, error: (err && err.message) || String(err) });
  }
})();
</script>
`;
}

interface ReportServer {
  port: number;
  report: Promise<string>;
  close: () => void;
}

function startReportServer(page: string): Promise<ReportServer> {
  return new Promise((resolve, reject) => {
    let settle: (body: string) => void = () => {};
    const report = new Promise<string>((res) => {
      settle = res;
    });
    const server = http.createServer((req, res) => {
      if (req.method !== "POST") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page);
        return;
      }
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        res.writeHead(204).end();
        settle(Buffer.concat(chunks).toString("utf8"));
      });
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      resolve({ port: (server.address() as AddressInfo).port, report, close: () => server.close() });
    });
  });
}

async function embedViaHarness(bytes: Uint8Array, mime: string, name: string): Promise<EmbeddedImage> {
  const browser = findBrowser();
  if (!browser) {
    throw new Error(
      "No Chrome / Chromium / Edge found on this machine, and raster images are resized by the app's own " +
        "policy, which needs one. Set FISH_BROWSER or install a browser."
    );
  }
  const harness = findHarness();
  if (!harness) {
    throw new Error(`${HARNESS_FILE} is missing beside the CLI — rebuild the kit with \`npm run build\``);
  }

  const page = harnessPage(fs.readFileSync(harness, "utf8"), name, mime, Buffer.from(bytes).toString("base64"));
  const server = await startReportServer(page);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fish-embed-"));

  try {
    const body = await runBrowserForReport(
      browser,
      [...getChromeFlags(tmpDir), `http://127.0.0.1:${server.port}/`],
      server.report,
      { step: "image embed", timeoutMs: HARNESS_TIMEOUT_MS }
    );
    let parsed: { ok: boolean; uri?: string; width?: number; height?: number; error?: string };
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new Error("the harness reported something that is not JSON");
    }
    if (!parsed.ok || !parsed.uri) throw new Error(parsed.error || "the harness produced no image");
    return {
      uri: parsed.uri,
      width: parsed.width ?? 0,
      height: parsed.height ?? 0,
      // The policy decides the output type, so it is read back off the URI rather
      // than assumed to be the type that went in.
      mime: dataUriMime(parsed.uri) ?? mime,
      bytes: dataUriBytes(parsed.uri) ?? 0
    };
  } finally {
    server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/** Intrinsic size of a pass-through format, or null when only a decoder can say. */
function passThroughSize(bytes: Uint8Array, mime: string): { width: number; height: number } | null {
  if (mime === "image/svg+xml") {
    try {
      return svgIntrinsicSize(new TextDecoder().decode(bytes));
    } catch {
      return null;
    }
  }
  if (mime === "image/gif" && bytes.length >= 10) {
    // GIF87a/89a carry the logical screen size in the header, which is what a
    // decoder reports for any frame-complete file.
    return { width: bytes[6] | (bytes[7] << 8), height: bytes[8] | (bytes[9] << 8) };
  }
  return null;
}

export async function embedImageBytes(bytes: Uint8Array, declaredMime: string | null, name: string): Promise<EmbeddedImage> {
  const mime = sniffMime(bytes) ?? declaredMime ?? "";
  // The app's own pass-through rule, called rather than restated. Only `.type` is
  // read, so a stand-in object is the whole contract — and asking the real
  // function is what keeps the two lists from drifting apart.
  const passThrough = shouldPassThrough({ type: mime } as Blob);
  if (passThrough) {
    const size = passThroughSize(bytes, mime);
    if (size) {
      return {
        uri: `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`,
        width: size.width,
        height: size.height,
        mime,
        bytes: bytes.length
      };
    }
  }
  return embedViaHarness(bytes, mime, name);
}

export async function embedImageUri(uri: string, name: string): Promise<EmbeddedImage> {
  const { bytes, contentType } = await fetchImage(uri);
  return embedImageBytes(bytes, contentType, name);
}
