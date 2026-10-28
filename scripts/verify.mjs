// Pre-commit verification gate: type check + build + full unit + all e2e.
//
// This is the heavy path that test:fast deliberately skips on every edit.
// Run it once before a commit / PR, not during iteration.
//
//   node scripts/verify.mjs
//   npm run verify

import { execSync } from "node:child_process";
import path from "node:path";

const root = process.cwd();
const vitest = path.resolve(root, "node_modules/.bin/vitest");

function step(name, cmd) {
  console.log(`\n=== ${name} ===`);
  console.log(`$ ${cmd}\n`);
  try {
    execSync(cmd, { cwd: root, stdio: "inherit" });
  } catch {
    console.error(`\n✖ ${name} failed — aborting verify.`);
    process.exit(1);
  }
}

// Unit tests run AFTER the build on purpose: the suites that grade the built
// shell (compression, the splice contract, the dialect check on `dist/`) skip
// themselves when there is no artifact, so testing first silently ran the gate
// without ever looking at the file that ships.
step("Type check (tsc --noEmit)", "npx tsc --noEmit");
step("Build", "npm run build");
step("Unit tests (full)", `"${vitest}" run --no-coverage`);
step("E2E (real Chromium)", "node scripts/run-e2e.mjs");

console.log("\n✅ verify passed: typecheck + build + unit + e2e");
