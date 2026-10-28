// Daily-loop test runner: run only the unit tests that touch what you changed.
//
//   node scripts/test-fast.mjs            auto-detect changed src/ files
//   node scripts/test-fast.mjs <file...>  run explicit vitest targets
//
// Mapping rule: a changed src/foo/bar.ts runs every tests/**/bar*.test.ts.
// A change under src/core/ ripples widely, so it falls back to the full unit
// suite (safe, still skips tsc + e2e). No src changes -> full unit for safety.
// This intentionally never runs tsc or the Playwright e2e suite; use
// `npm run verify` for the pre-commit gate.

import { execSync } from "node:child_process";
import path from "node:path";

const root = process.cwd();
const vitest = path.resolve(root, "node_modules/.bin/vitest");

function gitChanged() {
  let modified = [];
  let untracked = [];
  try {
    modified = execSync("git diff --name-only HEAD", { cwd: root })
      .toString().split("\n").map((s) => s.trim()).filter(Boolean);
  } catch {}
  try {
    untracked = execSync("git ls-files --others --exclude-standard", { cwd: root })
      .toString().split("\n").map((s) => s.trim()).filter(Boolean);
  } catch {}
  return [...new Set([...modified, ...untracked])];
}

function findTestsFor(name) {
  try {
    return execSync(`find tests -name '${name}*.test.ts'`, { cwd: root })
      .toString().split("\n").map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function run(args) {
  const cmd = `"${vitest}" run --no-coverage ${args.join(" ")}`.trim();
  console.log(`\n$ ${cmd}\n`);
  try {
    execSync(cmd, { cwd: root, stdio: "inherit" });
  } catch {
    process.exit(1);
  }
}

const argv = process.argv.slice(2);
if (argv.length) {
  console.log("→ explicit targets given, running targeted unit tests");
  run(argv);
  process.exit(0);
}

const changed = gitChanged();
const srcChanged = changed.filter(
  (f) => f.startsWith("src/") && (f.endsWith(".ts") || f.endsWith(".tsx"))
);

if (!srcChanged.length) {
  console.log("→ no src changes detected (clean tree?). Running full unit suite for safety.");
  run([]);
  process.exit(0);
}

if (srcChanged.some((f) => f.startsWith("src/core/"))) {
  console.log("→ src/core/ change detected (ripples widely). Running full unit suite.");
  run([]);
  process.exit(0);
}

const matched = new Set();
for (const f of srcChanged) {
  const base = path.basename(f).replace(/\.(ts|tsx)$/, "");
  for (const t of findTestsFor(base)) matched.add(t);
}

if (!matched.size) {
  console.log("→ changed src files have no name-matched tests. Running full unit suite.");
  run([]);
  process.exit(0);
}

console.log(
  `→ running ${matched.size} targeted test file(s) for ${srcChanged.length} changed source file(s):`
);
for (const t of matched) console.log("   " + t);
run([...matched]);
process.exit(0);
