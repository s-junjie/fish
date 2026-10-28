#!/usr/bin/env node
// Pack the agent kit as a byte-reproducible zip.
//
// The kit is a directory of committed and built files with no compression need,
// so entries are stored (not deflated), timestamps are pinned, and the Unix mode
// travels with each entry. Two builds of the same commit produce the same
// SHA-256, which is what `SKILL.md` can pin.
//
//   node scripts/pack-agent-kit.mjs
//   node scripts/pack-agent-kit.mjs --dir dist/fish-agent-kit --out dist/fish-agent-kit-0.1.0.zip

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createZip } from "./lib/zip.mjs";
import { sha256, toPosix } from "./lib/release-layout.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

let sourceDir = "dist/fish-agent-kit";
let out = "";
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--dir") sourceDir = args[++i] ?? sourceDir;
  else if (args[i] === "--out") out = args[++i] ?? "";
  else if (args[i] === "--help" || args[i] === "-h") {
    console.log(`Usage: node scripts/pack-agent-kit.mjs [options]

  --dir <dir>    Built kit directory. Default dist/fish-agent-kit
  --out <path>   Zip path. Default dist/fish-agent-kit-<version>.zip`);
    process.exit(0);
  } else {
    console.error(`error: unknown argument ${args[i]}`);
    process.exit(1);
  }
}

const source = path.resolve(root, sourceDir);
if (!fs.existsSync(source)) {
  console.error(`error: ${sourceDir} not found — run "npm run build" first`);
  process.exit(1);
}

function walk(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const full = path.join(dir, entry.name);
      return entry.isDirectory() ? walk(full) : [full];
    });
}

const entries = walk(source).map((file) => ({
  path: toPosix(path.relative(source, file)),
  data: fs.readFileSync(file),
  mode: fs.statSync(file).mode & 0o111 ? 0o755 : 0o644
}));

if (entries.length === 0) {
  console.error(`error: ${sourceDir} is empty`);
  process.exit(1);
}

const target = path.resolve(root, out || `dist/fish-agent-kit-${pkg.version}.zip`);
const zip = createZip(entries);
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, zip);

console.log(`✓ ${path.relative(root, target)}`);
console.log(`  files   ${entries.length}`);
console.log(`  bytes   ${zip.length}`);
console.log(`  sha256  ${sha256(zip)}`);
