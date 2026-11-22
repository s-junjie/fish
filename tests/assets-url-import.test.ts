import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { creditFrom } from "../src/core/cli/fish-assets";

/**
 * `assets import <url>` is the door for sources the CLI does not ship — Unsplash,
 * a client CDN, a press kit. It is graded without the network: a local server
 * answers with an image and with a photo page, which are the two things an agent
 * will paste.
 */
const ROOT = path.resolve(__dirname, "..");
const FISH = path.join(ROOT, "dist/fish-agent-kit/tools/fish.cjs");
const TEMPLATE = path.join(ROOT, "dist/fish-agent-kit/templates/blank.fish.html");
const built = fs.existsSync(FISH) && fs.existsSync(TEMPLATE);

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><rect width="24" height="24" fill="#f00"/></svg>';

describe("an attribution is two halves", () => {
  it("takes a name and a page together", () => {
    expect(creditFrom("Annie Spratt · Unsplash", "https://unsplash.com/photos/x")).toEqual({
      credit: { name: "Annie Spratt · Unsplash", url: "https://unsplash.com/photos/x" }
    });
  });

  // A name with no page cannot be checked; a page with no author credits nobody.
  it("refuses half of one", () => {
    expect(creditFrom("Annie").error).toMatch(/go together/);
    expect(creditFrom(undefined, "https://unsplash.com/photos/x").error).toMatch(/go together/);
  });

  it("requires a page that can be opened", () => {
    expect(creditFrom("Annie", "unsplash.com/photos/x").error).toMatch(/http/);
  });

  it("is absent when nothing was given", () => {
    expect(creditFrom()).toEqual({});
  });
});

const whenBuilt = built ? describe : describe.skip;

whenBuilt("a URL from a source the kit does not ship", () => {
  let server: http.Server;
  let origin = "";

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === "/icon.svg") {
        res.writeHead(200, { "content-type": "image/svg+xml" });
        res.end(SVG);
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<html><body>a photo page</body></html>");
    });
    // A port that cannot be bound rejects the hook instead of leaving it to the
    // 30 s timeout — an `error` nobody listens for is an unhandled event.
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    origin = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  });

  afterAll(async () => {
    if (!server || !server.listening) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function doc(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fish-url-asset-"));
    const file = path.join(dir, "d.fish.html");
    fs.copyFileSync(TEMPLATE, file);
    return file;
  }

  // Async on purpose: `spawnSync` blocks the event loop this file's server runs
  // on, so the CLI's request would never be answered and both processes hang.
  function run(args: string[]): Promise<{ status: number | null; out: string; err: string }> {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [FISH, ...args]);
      let out = "";
      let err = "";
      child.stdout.on("data", (chunk) => (out += chunk));
      child.stderr.on("data", (chunk) => (err += chunk));
      child.on("close", (status) => resolve({ status, out, err }));
    });
  }

  it("fetches it once, embeds the bytes and keeps the credit", async () => {
    const result = await run([
      "assets", "import", `${origin}/icon.svg`, doc(),
      "--name", "Mark",
      "--credit-name", "Jane Doe · Unsplash",
      "--credit-url", "https://unsplash.com/photos/x",
      "--json"
    ]);
    expect(result.err).toBe("");
    expect(result.status).toBe(0);
    const json = JSON.parse(result.out) as { asset: { name: string; uri: string; credit?: unknown } };
    expect(json.asset.name).toBe("Mark");
    expect(json.asset.uri.startsWith("data:image/svg+xml")).toBe(true);
    expect(json.asset.credit).toEqual({ name: "Jane Doe · Unsplash", url: "https://unsplash.com/photos/x" });
  });

  // The mistake this catches: pasting the page you were reading instead of the
  // file. "not an image" says what went wrong; a decoder error reads as a
  // corrupt download.
  it("says so when the URL is a page, not a file", async () => {
    const result = await run(["assets", "import", `${origin}/photos/x`, doc()]);
    expect(result.status).toBe(1);
    expect(result.err).toContain("not an image");
    expect(result.err).toContain("text/html");
  });

  it("refuses half an attribution before it fetches anything", async () => {
    const result = await run(["assets", "import", `${origin}/icon.svg`, doc(), "--credit-name", "Jane Doe"]);
    expect(result.status).toBe(2);
    expect(result.err).toContain("go together");
  });
});
