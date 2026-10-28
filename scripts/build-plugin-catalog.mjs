#!/usr/bin/env node
// Describe the signed plugin bundles as a catalog.
//
// The catalog is informational: the shipped shell has no catalog reader, so
// this does not advertise automatic plugin updates. Every entry is read back
// from the signed trailer, which is what makes the listed sha256 the hash of the
// bytes that actually ship.
//
//   node scripts/build-plugin-catalog.mjs
//   node scripts/build-plugin-catalog.mjs --plugins dist-plugins --out dist-plugins/catalog.json

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildCatalog, readPlugins } from "./lib/plugin-catalog.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

let pluginsDir = "dist-plugins";
let out = "";
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--plugins") pluginsDir = args[++i] ?? pluginsDir;
  else if (args[i] === "--out") out = args[++i] ?? "";
  else if (args[i] === "--help" || args[i] === "-h") {
    console.log(`Usage: node scripts/build-plugin-catalog.mjs [options]

  --plugins <dir>  Signed plugin builds. Default dist-plugins
  --out <path>     Catalog path. Default dist-plugins/catalog.json`);
    process.exit(0);
  } else {
    console.error(`error: unknown argument ${args[i]}`);
    process.exit(1);
  }
}

const plugins = readPlugins(path.resolve(root, pluginsDir));
if (plugins.length === 0) {
  console.error(`error: no signed plugins under ${pluginsDir} — run "npm run plugin:build" first`);
  process.exit(1);
}

const catalog = buildCatalog(pkg.version, plugins);
const target = path.resolve(root, out || path.join(pluginsDir, "catalog.json"));
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, `${JSON.stringify(catalog, null, 2)}\n`);

console.log(`✓ ${path.relative(root, target)}  v${pkg.version}  ${plugins.length} plugins`);
for (const entry of plugins) {
  console.log(`  ${entry.manifest.id}@${entry.manifest.version}  ${entry.signedBytes} bytes`);
}
