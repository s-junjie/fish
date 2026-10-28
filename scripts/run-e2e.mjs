import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const rootDir = process.cwd();
const distHtml = path.resolve(rootDir, "dist/index.html");

if (!fs.existsSync(distHtml)) {
  console.error("dist/index.html not found! Run 'npm run build' first.");
  process.exit(1);
}

/**
 * Each spec gets its OWN COPY of the shell, in its own directory.
 *
 * The app can write the document back to the file it was loaded from, and every
 * spec sharing one `dist/index.html` means the first spec to do that replaces the
 * shell every later spec then loads — a failure that looks like the app under
 * test is broken when the artifact is simply no longer the artifact. A per-spec
 * copy removes the whole class: nothing a spec does can reach the build, and
 * `file://` still gets a stable origin per copy.
 *
 * A fresh directory per spec also means the `fish-autosave` IndexedDB and the
 * recovery record start empty, instead of one spec's auto-save becoming the next
 * spec's restore input (LESSONS §28 — `file://` is one shared origin). That
 * isolation is per DIRECTORY, which is what makes the run below safe to fan out.
 */
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "fish-e2e-"));
/** The build as it was when this run started — the only thing a spec may load. */
const pristine = path.join(workDir, "index.html");
fs.cpSync(distHtml, pristine);

const e2eDir = path.resolve(rootDir, "tests/e2e");
const specs = fs
  .readdirSync(e2eDir)
  .filter((f) => f.endsWith(".spec.mjs"))
  .sort();

/**
 * How many specs run at once.
 *
 * The suite is not CPU-bound — a full serial run spends about a third of one
 * core, the rest waiting on Chromium start — so several browsers fit on a laptop
 * without slowing each other down much. Measured here over 80 specs: serial
 * 5m17s, 4-wide 1m31s, 6-wide 1m11s, 8-wide 55s, with each spec taking 13–26%
 * longer than it does alone. Six is the default because that is past where the
 * wall clock stops paying, and it leaves a 10-core machine room for the editor.
 * Above it the gain is real but the contention is the suite's flake budget.
 *
 * The floor is the machine: two cores cannot carry six browsers, and a run that
 * crawls teaches people to reach for `--serial` instead. `--serial` and
 * `FISH_E2E_CONCURRENCY` both override; `--serial` is what to re-run a failure
 * under, since contention is the one thing here that can turn a pass into a
 * flake and a flake back into a pass.
 */
const argConcurrency = (() => {
  if (process.argv.includes("--serial")) return 1;
  const env = Number(process.env.FISH_E2E_CONCURRENCY);
  if (Number.isFinite(env) && env >= 1) return Math.floor(env);
  return Math.max(2, Math.min(6, os.cpus().length - 2));
})();
const concurrency = Math.max(1, Math.min(argConcurrency, specs.length));

console.log(
  `\n=== Running ${specs.length} E2E Test Suites, ${concurrency} at a time ` +
    `(isolated copies of dist/index.html) ===\n`
);

let passedSuites = 0;
let failedSuites = 0;
const failures = [];

/**
 * One spec, buffered.
 *
 * The output is captured rather than inherited because at concurrency > 1 four
 * specs share one terminal and their `PASS <check>` lines interleave into
 * something nobody can read — including on failure, which is the one time the
 * output is the point. A passing spec prints one line; a failing one prints all
 * of it, after the verdict, so the reason is never behind a wall of noise.
 */
function runSpec(spec) {
  return new Promise((resolve) => {
    const specPath = path.join(e2eDir, spec);
    const specDir = path.join(workDir, spec.replace(/\.spec\.mjs$/, ""));
    fs.mkdirSync(specDir, { recursive: true });
    const shell = path.join(specDir, "index.html");
    // From the snapshot taken at startup, never from `dist/index.html` again. The
    // artifact is not stable while the suite runs — an open tab auto-saves to it,
    // and a concurrent `vite build` empties `outDir` outright — so reading it per
    // spec makes the suite fail on whoever else is touching the tree. This is the
    // snapshot the restore below and the header above both talk about.
    fs.cpSync(pristine, shell);

    const start = Date.now();
    const child = spawn("node", [specPath, shell], { cwd: rootDir, stdio: ["ignore", "pipe", "pipe"] });

    // Accumulated, never awaited mid-run: the pipe has to keep draining or a
    // chatty spec blocks on a full buffer while the runner waits on it.
    let output = "";
    child.stdout.on("data", (c) => { output += c; });
    child.stderr.on("data", (c) => { output += c; });

    // `error` and `close` are not exclusive — a spawn that fails to start emits
    // both — so the verdict is recorded once and the worker is released once.
    let settled = false;
    const finish = (status, note = "") => {
      if (settled) return;
      settled = true;
      const duration = ((Date.now() - start) / 1000).toFixed(2);
      if (status === 0) {
        passedSuites++;
        console.log(`✔ [${spec}] PASSED (${duration}s)\n`);
      } else {
        failedSuites++;
        failures.push(spec);
        console.error(`✖ [${spec}] FAILED${note} (${duration}s)\n`);
        if (output.trim()) console.error(output.trimEnd() + "\n");
      }
      resolve();
    };

    child.on("error", (err) => {
      output += `\n${err.stack || err}`;
      finish(-1, " (could not start)");
    });
    child.on("close", (code, signal) => {
      // A signalled spec has no exit code, and reporting it as 0 because the
      // code happens to be null is how a killed run reads as a passing one.
      if (signal) finish(-1, ` (killed by ${signal})`);
      else finish(code);
    });
  });
}

/**
 * A fixed pool rather than one promise per spec: 80 Chromium launches at once
 * is a different machine, and the thing that decides a good number is how many
 * browsers fit, not how many specs there are.
 */
async function runAll() {
  let next = 0;
  const worker = async () => {
    while (next < specs.length) {
      const spec = specs[next++];
      console.log(`▶ [${spec}]`);
      await runSpec(spec);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
}

await runAll();

/**
 * Restore the artifact if anything rewrote it, and say so.
 *
 * A warning, not a failure: the app auto-saves back to the file it was loaded
 * from, so anyone who has `dist/index.html` open in a browser is continuously
 * rewriting it while the suite runs. That is a normal state for this repo, and it
 * cannot affect the results — every spec loaded `pristine`, snapshotted before the
 * run started. It DOES matter afterwards, so the snapshot is put back; without it
 * the next build's output is measured against a serialized document and every
 * spec that reads the artifact loads a page with no app in it.
 *
 * A *missing* artifact is deliberately left alone: that is a concurrent
 * `vite build` between `emptyOutDir` and its own write, and copying the snapshot
 * back would overwrite the build the other run is still producing.
 */
if (!fs.existsSync(distHtml)) {
  console.warn("\n! dist/index.html is gone (a concurrent build emptied outDir) — left for it to finish.\n");
} else if (fs.statSync(distHtml).size !== fs.statSync(pristine).size) {
  console.warn("\n! dist/index.html changed while the suite ran (an open tab auto-saves to it) — restored.\n");
  fs.cpSync(pristine, distHtml);
}

fs.rmSync(workDir, { recursive: true, force: true });

console.log(`===============================================`);
console.log(`E2E Summary: ${passedSuites} passed, ${failedSuites} failed`);
if (failures.length) console.log(`Failed: ${failures.join(", ")}`);
console.log(`===============================================\n`);

if (failedSuites > 0) {
  process.exit(1);
}