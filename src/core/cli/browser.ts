/**
 * Locating and driving a browser the machine already has.
 *
 * Shared by `export` and by the image embedder, which both need a headless
 * Chromium: one to rasterize a document, one to run the app's own image policy.
 * The sandbox handling below is not optional for either — an agent's shell is
 * exactly the process tree that trips it.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync, execSync, spawn } from "node:child_process";

export function findBrowser(): string | null {
  if (process.env.FISH_BROWSER && fs.existsSync(process.env.FISH_BROWSER)) {
    return process.env.FISH_BROWSER;
  }
  const home = os.homedir();
  const playwrightGlobs: string[] = [];
  try {
    const pwDirMac = path.join(home, "Library/Caches/ms-playwright");
    if (fs.existsSync(pwDirMac)) {
      for (const entry of fs.readdirSync(pwDirMac)) {
        if (entry.startsWith("chromium_headless_shell-")) {
          const shellMac = path.join(pwDirMac, entry, "chrome-headless-shell-mac-arm64/chrome-headless-shell");
          const shellX64 = path.join(pwDirMac, entry, "chrome-headless-shell-mac-x64/chrome-headless-shell");
          if (fs.existsSync(shellMac)) playwrightGlobs.push(shellMac);
          else if (fs.existsSync(shellX64)) playwrightGlobs.push(shellX64);
        } else if (entry.startsWith("chromium-")) {
          const testMac = path.join(pwDirMac, entry, "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing");
          const testX64 = path.join(pwDirMac, entry, "chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing");
          if (fs.existsSync(testMac)) playwrightGlobs.push(testMac);
          else if (fs.existsSync(testX64)) playwrightGlobs.push(testX64);
        }
      }
    }
    const pwDirLinux = path.join(home, ".cache/ms-playwright");
    if (fs.existsSync(pwDirLinux)) {
      for (const entry of fs.readdirSync(pwDirLinux)) {
        if (entry.startsWith("chromium_headless_shell-")) {
          const shell = path.join(pwDirLinux, entry, "chrome-headless-shell-linux/chrome-headless-shell");
          if (fs.existsSync(shell)) playwrightGlobs.push(shell);
        } else if (entry.startsWith("chromium-")) {
          const chrome = path.join(pwDirLinux, entry, "chrome-linux/chrome");
          if (fs.existsSync(chrome)) playwrightGlobs.push(chrome);
        }
      }
    }
  } catch {
    // Ignore cache scan failures
  }

  const candidates = [
    ...playwrightGlobs,
    "google-chrome",
    "google-chrome-stable",
    "chromium",
    "chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "microsoft-edge",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/c/Program Files/Google/Chrome/Application/chrome.exe",
    "/c/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "/c/Program Files/Microsoft/Edge/Application/msedge.exe"
  ];
  for (const c of candidates) {
    if (c.startsWith("/") && fs.existsSync(c)) return c;
    try {
      const resolved = execSync(`command -v "${c}" 2>/dev/null`, { encoding: "utf8" }).trim();
      if (resolved && fs.existsSync(resolved)) return resolved;
    } catch {
      // not found in PATH
    }
  }
  return null;
}

export function getChromeFlags(tmpDir: string): string[] {
  const flags = ["--headless=new", "--disable-gpu", "--hide-scrollbars"];
  if (process.platform !== "darwin") {
    const profileDir = path.join(tmpDir, "profile");
    fs.mkdirSync(profileDir, { recursive: true });
    flags.push(`--user-data-dir=${profileDir}`, "--no-sandbox");
  }
  if (process.env.FISH_CHROME_FLAGS) {
    flags.push(...process.env.FISH_CHROME_FLAGS.split(/\s+/).filter(Boolean));
  }
  return flags;
}

/**
 * Chrome nests its own sandbox inside whichever sandbox the caller already runs
 * in, and macOS refuses that from a process tree that cannot spawn a second one
 * — notably an agent's shell, which is where an agent's own `export` runs. The GPU
 * process dies first, and the browser then FATALs itself: killed by SIGTRAP, so
 * `status` is null and stdout is empty. Nothing but this text identifies it, which
 * is why stderr has to survive.
 *
 * Not every shell is such a tree — from an ordinary terminal the same flags launch
 * fine — which is exactly why this is a retry and not a default flag: the ones who
 * need it cannot be asked to know it exists, and the ones who don't should not pay
 * for it.
 */
const BROWSER_SANDBOX_FAILURE_RE =
  /sandbox initialization failed|GPU process isn't usable|bootstrap_check_in|MachPortRendezvousServer|Operation not permitted|Permission denied|RegisterApplication|launchservicesd|ASN|Abort trap/i;

/**
 * `execFileSync`, not `spawnSync`: a browser that outlives its own work — `--no-sandbox`
 * next to a fresh profile does exactly that, on macOS — keeps the stdout pipe open,
 * and a `spawnSync` caller waits for EOF on it forever. `execFileSync` inherits the
 * same fds but the timeout below is what bounds it.
 */
const BROWSER_TIMEOUT_MS = 120_000;

export type BrowserRun = { stdout: string; status: number | null; signal: string | null; stderr: string };

function runBrowserOnce(browser: string, args: string[], maxBuffer: number): BrowserRun {
  try {
    const stdout = execFileSync(browser, args, {
      maxBuffer,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: BROWSER_TIMEOUT_MS
    });
    return { stdout, status: 0, signal: null, stderr: "" };
  } catch (err: any) {
    return {
      stdout: "",
      status: typeof err?.status === "number" ? err.status : null,
      signal: typeof err?.signal === "string" ? err.signal : null,
      stderr: typeof err?.stderr === "string" ? err.stderr : ""
    };
  }
}

function lastLines(text: string, limit = 10): string {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() !== "");
  return lines
    .slice(Math.max(0, lines.length - limit))
    .map((l) => `    ${l}`)
    .join("\n");
}

function browserFailed(step: string, run: BrowserRun, note?: string): Error {
  const outcome = run.signal ? `exit=${run.status ?? "?"}, signal=${run.signal}` : `exit=${run.status ?? "?"}`;
  const tail = lastLines(run.stderr);
  return new Error(
    [
      `${step} failed (${outcome})`,
      tail ? `  browser stderr:\n${tail}` : "  browser stderr: (empty)",
      ...(note ? [`  ${note}`] : [])
    ].join("\n")
  );
}

/**
 * Runs the browser and returns stdout, retrying once with `--no-sandbox` when the
 * first launch died of a sandbox denial so that an agent running inside its own
 * sandbox gets a picture instead of a crash report.
 *
 * The retry carries no new profile deliberately: on macOS a fresh
 * `--user-data-dir` next to `--no-sandbox` writes its output and then never exits,
 * so a synchronous caller waits out its whole timeout on work that is already done
 * — turning the one case this exists to rescue into the slowest way to fail.
 */
export function runBrowser(
  browser: string,
  args: string[],
  opts: { step: string; maxBuffer: number; wroteFile?: () => boolean }
): string {
  const produced = (run: BrowserRun) => run.status === 0 && (!opts.wroteFile || opts.wroteFile());

  const first = runBrowserOnce(browser, args, opts.maxBuffer);
  if (produced(first)) return first.stdout;

  // A clean exit that wrote nothing is the hand-off case: another browser owns this
  // profile, so the new process opened a tab there and this one rendered off-screen.
  const handedOff = first.status === 0 && !!opts.wroteFile;
  const sandboxDenied = BROWSER_SANDBOX_FAILURE_RE.test(first.stderr);
  if (args.includes("--no-sandbox") || (!sandboxDenied && !handedOff)) {
    throw browserFailed(opts.step, first, handedOff ? "no image written" : undefined);
  }

  const retry = runBrowserOnce(browser, [...args, "--no-sandbox"], opts.maxBuffer);
  if (!produced(retry)) {
    throw browserFailed(
      `${opts.step} (retried with --no-sandbox)`,
      retry,
      opts.wroteFile && !opts.wroteFile() ? "no image written" : undefined
    );
  }
  return retry.stdout;
}

type SpawnOutcome =
  | { kind: "report"; report: string; stderr: string }
  | { kind: "exit"; stderr: string; status: number | null; signal: NodeJS.Signals | null }
  | { kind: "timeout"; stderr: string }
  | { kind: "spawn-error"; stderr: string; reason: string };

async function spawnBrowserOnce(
  browser: string,
  args: string[],
  report: Promise<string>,
  timeoutMs: number
): Promise<SpawnOutcome> {
  const proc = spawn(browser, args, { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  proc.stderr.setEncoding("utf8");
  proc.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const exit = { status: null as number | null, signal: null as NodeJS.Signals | null };
  const exited = new Promise<"exit">((resolve) => {
    proc.once("exit", (status, signal) => {
      exit.status = status;
      exit.signal = signal;
      resolve("exit");
    });
  });

  // A spawn that never started — a stale FISH_BROWSER, or a path removed between
  // the search and the launch — reports through `error`, not `exit`, and an
  // unhandled `error` event takes the whole CLI down with a Node stack trace
  // instead of a sentence.
  const spawnFailed = new Promise<string>((resolve) => {
    proc.once("error", (err) => resolve(err.message));
  });

  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });

  const outcome = await Promise.race([
    report.then((body) => ({ kind: "report" as const, body })),
    exited,
    spawnFailed.then((reason) => ({ kind: "spawn-error" as const, reason })),
    timedOut
  ]);
  if (timer) clearTimeout(timer);
  proc.kill("SIGKILL");
  // A browser launches helper processes that inherit these pipes. One survivor
  // holds them open, and an open stdio stream is enough to keep Node's event loop
  // alive — the CLI writes its answer, then appears to hang until the caller's
  // own timeout. Nothing reads them again once the outcome is known.
  proc.stdout?.destroy();
  proc.stderr?.destroy();
  proc.unref();

  if (outcome === "timeout") return { kind: "timeout", stderr };
  if (outcome === "exit") return { kind: "exit", stderr, status: exit.status, signal: exit.signal };
  if (typeof outcome === "object" && outcome.kind === "spawn-error") {
    return { kind: "spawn-error", stderr, reason: outcome.reason };
  }
  return { kind: "report", report: (outcome as { body: string }).body, stderr };
}

/**
 * Runs the browser and waits for the page to POST its result back, rather than
 * for `--dump-dom`.
 *
 * `--dump-dom` cannot be used for this: the dump fires when the virtual-time
 * budget expires, and virtual time advances while the renderer is idle — which
 * is exactly the window a multi-megabyte `createImageBitmap` spends decoding, so
 * the dump arrives before the work does, at any budget. A page that reports over
 * HTTP decides when it is finished, and the result never has to fit through a
 * stdout pipe either.
 *
 * Retries once with `--no-sandbox` for the reason `runBrowser` does: an agent's
 * own shell is the process tree that trips Chrome's nested sandbox.
 */
export async function runBrowserForReport(
  browser: string,
  args: string[],
  report: Promise<string>,
  opts: { step: string; timeoutMs: number }
): Promise<string> {
  const describe = (outcome: SpawnOutcome) =>
    outcome.kind === "exit"
      ? { stdout: "", status: outcome.status, signal: outcome.signal, stderr: outcome.stderr }
      : { stdout: "", status: null, signal: null, stderr: outcome.stderr };

  const first = await spawnBrowserOnce(browser, args, report, opts.timeoutMs);
  if (first.kind === "report") return first.report;
  if (first.kind === "spawn-error") {
    // A browser that would not start is not a sandbox problem, so there is
    // nothing for the retry to change.
    throw new Error(`${opts.step} failed: could not launch ${browser} — ${first.reason}`);
  }

  const note =
    first.kind === "timeout" ? "the page never reported a result (timed out)" : "the page never reported a result";
  const sandboxDenied = BROWSER_SANDBOX_FAILURE_RE.test(first.stderr);
  if (args.includes("--no-sandbox") || !sandboxDenied) {
    throw browserFailed(opts.step, describe(first), note);
  }

  const retry = await spawnBrowserOnce(browser, [...args, "--no-sandbox"], report, opts.timeoutMs);
  if (retry.kind === "report") return retry.report;
  if (retry.kind === "spawn-error") {
    throw new Error(`${opts.step} failed: could not launch ${browser} — ${retry.reason}`);
  }
  throw browserFailed(`${opts.step} (retried with --no-sandbox)`, describe(retry), note);
}
