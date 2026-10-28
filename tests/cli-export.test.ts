/**
 * `fish export` is the one command that leaves Node, so it is also the one whose
 * failures arrive without a stack trace: a browser that refuses to start reports
 * itself in stderr and an exit status, and for a long time neither survived to the
 * caller. These tests are here because the symptom — "export produced nothing,
 * and nothing said why" — looks identical whether the document, the engine, or the
 * browser is at fault, and only the last of those three is usually true.
 *
 * The browser is replaced wholesale. Nothing here depends on one being installed.
 */

import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { writeDemoFixture } from "./helpers/demo-fixture";

const root = path.resolve(__dirname, "..");
const cli = path.join(root, "dist/fish-agent-kit/tools/fish.cjs");
const shell = path.join(root, "dist/index.html");
const kitBuilt = fs.existsSync(cli) && fs.existsSync(shell);
const doc = kitBuilt ? writeDemoFixture(fs.readFileSync(shell, "utf-8")) : "";

/** A stand-in browser. `$0 continue` means "exit 0 after the first call". */
function writeFakeBrowser(dir: string, name: string, body: string): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`);
  fs.chmodSync(file, 0o755);
  return file;
}

function runCli(args: string[], env: Record<string, string>) {
  try {
    const stdout = execFileSync(process.execPath, [cli, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...env }
    });
    return { code: 0, out: stdout + "" };
  } catch (err: any) {
    return {
      code: typeof err?.status === "number" ? err.status : -1,
      out: `${err?.stdout ?? ""}${err?.stderr ?? ""}`
    };
  }
}

describe("fish export", () => {
  let tmp: string;
  let argLog: string;

  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fish-cli-export-"));
    argLog = path.join(tmp, "argv.log");
  });

  afterEach(() => {
    fs.rmSync(argLog, { force: true });
  });

  // These two need no browser at all: rejecting the request before launching one
  // is the point, so a caller learns it wrote the wrong extension rather than
  // waiting through a launch that can only fail.
  (kitBuilt ? it : it.skip)("refuses a format it does not write, without starting a browser", () => {
    const res = runCli(["export", doc, "--format", "svg", "--out", path.join(tmp, "x.png")], {
      FISH_BROWSER: "/nonexistent/browser"
    });
    expect(res.code).toBe(2);
    expect(res.out).toMatch(/PNG only|writes PNG only/);
  });

  (kitBuilt ? it : it.skip)("refuses a non-.png output path", () => {
    const res = runCli(["export", doc, "--out", path.join(tmp, "x.svg")], {
      FISH_BROWSER: "/nonexistent/browser"
    });
    expect(res.code).toBe(2);
    expect(res.out).toMatch(/not a \.png path/);
  });

  // The regression: Chrome killed by a signal has no exit code, and everything it
  // tried to say is in stderr. Dropping it turns "add --no-sandbox" into a mystery.
  (kitBuilt ? it : it.skip)("reports the browser's own exit status and stderr", () => {
    const fake = writeFakeBrowser(
      tmp,
      "failing-browser.sh",
      'echo "Could not create a sandbox: Operation not permitted" >&2\nexit 133\n'
    );
    const res = runCli(["export", doc, "--out", path.join(tmp, "never.png")], { FISH_BROWSER: fake });
    expect(res.code).toBe(1);
    expect(res.out).toMatch(/exit=133/);
    expect(res.out).toMatch(/Could not create a sandbox/);
  });

  // The page answers `ok: false` when the id is not there, precisely so a caller
  // does not crop to a rectangle that does not exist. Treating that as a hint and
  // carrying on photographs the whole page at the default window and calls it an
  // export — a plausible picture of the wrong region.
  (kitBuilt ? it : it.skip)("fails on an element the page says it cannot find", () => {
    const fake = writeFakeBrowser(
      tmp,
      "report-false.sh",
      'echo \'<html><body><script id="fish-report" type="application/json">{"ok":false,"error":"no element with id \\"nope\\" in this document"}</script></body></html>\''
    );
    const res = runCli(["export", doc, "--element", "nope", "--out", path.join(tmp, "never.png")], {
      FISH_BROWSER: fake
    });
    expect(res.code).toBe(1);
    expect(res.out).toMatch(/cannot crop to "nope"/);
    expect(res.out).toMatch(/no element with id/);
  });

  (kitBuilt ? it : it.skip)("refuses to crop when the shell publishes no report channel", () => {
    const fake = writeFakeBrowser(tmp, "no-report.sh", 'echo "<html><body>nothing to report</body></html>"');
    const res = runCli(["export", doc, "--element", "anything", "--out", path.join(tmp, "never.png")], {
      FISH_BROWSER: fake
    });
    expect(res.code).toBe(1);
    expect(res.out).toMatch(/no \?report channel/);
  });

  // The repair: a launch denied its own sandbox is retried with `--no-sandbox`, so
  // an agent running inside a sandbox needs to know nothing about Chromium flags.
  // The private profile joins nothing here — on macOS it turns this very retry
  // into a hang, which would be worse than the crash it exists to rescue.
  (kitBuilt && process.platform === "darwin" ? it : it.skip)("retries a sandbox-denied launch with --no-sandbox", () => {
    const fake = writeFakeBrowser(
      tmp,
      "sandbox-then-ok.sh",
      [
        'printf "%s\\n" "$*" >> "' + argLog + '"',
        'if [ ! -f "' + argLog + '.sent" ]; then',
        '  touch "' + argLog + '.sent"',
        '  echo "sandbox initialization failed: Operation not permitted" >&2',
        "  exit 133",
        "fi",
        "exit 0"
      ].join("\n")
    );
    runCli(["export", doc, "--out", path.join(tmp, "never.png")], { FISH_BROWSER: fake });

    const calls = fs.readFileSync(argLog, "utf8").split("\n").filter(Boolean);
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls[calls.length - 1]).toContain("--no-sandbox");
    fs.rmSync(`${argLog}.sent`, { force: true });
  });
});
