#!/usr/bin/env node
// Build the directory that `wrangler deploy` publishes to dl.fish.themindstudio.cc.
//
// A static-assets deploy replaces the whole site, so this script first carries
// forward everything the live origin already serves (`sha256sums.txt` is the
// index), then adds the release it was given. That is what keeps an old shell's
// URL alive after a new release, without committing binaries to the repository.
//
//   node scripts/assemble-site.mjs --origin https://dl.fish.themindstudio.cc
//   node scripts/assemble-site.mjs --promote 0.1.0 --origin https://dl.fish.themindstudio.cc
//
// Versioned paths are write-once: a second run with different bytes refuses
// instead of silently replacing a published artifact. Pointers under `stable/`
// are the only files allowed to change between deploys.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  APP_ID,
  CATALOG_PATH,
  DEFAULT_ORIGIN,
  HEADERS,
  HEADERS_PATH,
  STABLE_MANIFEST,
  STABLE_SHELL,
  SUMS_PATH,
  assertSafeRelative,
  kitPath,
  manifestPath,
  parseSums,
  pluginPath,
  sha256,
  shellPath,
  toPosix
} from "./lib/release-layout.mjs";
import { assertPayload, parseEnvelope, verifyManifest } from "./lib/release-manifest.mjs";
import { buildCatalog, readPlugins } from "./lib/plugin-catalog.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

const opts = {
  out: "release-site",
  origin: DEFAULT_ORIGIN,
  version: "",
  shell: "dist/index.html",
  manifest: "dist/manifest.json",
  plugins: "dist-plugins",
  kit: "",
  carryFrom: DEFAULT_ORIGIN,
  promote: "",
  publicKey: process.env.FISH_UPDATE_PUBLIC_KEY ?? ""
};

const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--out") opts.out = args[++i] ?? opts.out;
  else if (arg === "--origin") opts.origin = args[++i] ?? opts.origin;
  else if (arg === "--version") opts.version = args[++i] ?? "";
  else if (arg === "--shell") opts.shell = args[++i] ?? opts.shell;
  else if (arg === "--manifest") opts.manifest = args[++i] ?? opts.manifest;
  else if (arg === "--plugins") opts.plugins = args[++i] ?? opts.plugins;
  else if (arg === "--kit") opts.kit = args[++i] ?? opts.kit;
  else if (arg === "--carry-from") opts.carryFrom = args[++i] ?? opts.carryFrom;
  else if (arg === "--promote") opts.promote = args[++i] ?? "";
  else if (arg === "--public-key") opts.publicKey = args[++i] ?? "";
  else if (arg === "--help" || arg === "-h") usage();
  else fail(`unknown argument ${arg}`);
}

function usage() {
  console.log(`Usage: node scripts/assemble-site.mjs [options]

  --out <dir>          Output directory. Default release-site
  --origin <url>       Published origin. Default ${DEFAULT_ORIGIN}
  --version <semver>   Release version. Default package.json version
  --shell <path>       Shell to publish. Default dist/index.html
  --manifest <path>    Signed manifest. Default dist/manifest.json
  --plugins <dir>      Signed plugin builds. Default dist-plugins
  --kit <path>         Kit zip. Default dist/fish-agent-kit-<version>.zip
  --carry-from <url>   Carry forward what the live origin serves, or "off"
  --promote <semver>   Re-point stable/ at an already published version
  --public-key <jwk>   Verify the manifest signature (env FISH_UPDATE_PUBLIC_KEY)

A publish is additive: versioned paths are write-once, and stable/ is the only
part that moves.`);
  process.exit(0);
}

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

const origin = opts.origin.replace(/\/+$/, "");
try {
  const parsed = new URL(origin);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error();
} catch {
  fail(`--origin is not an absolute http(s) URL: ${opts.origin}`);
}

const outDir = path.resolve(root, opts.out);
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

const carried = opts.carryFrom === "off" ? { files: 0, note: "carry disabled" } : await carry(outDir, opts.carryFrom.replace(/\/+$/, ""));

function walk(dir) {
  const files = [];
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) visit(full);
      else files.push(full);
    }
  };
  visit(dir);
  return files.map((file) => toPosix(path.relative(dir, file))).sort();
}

function writeVersioned(rel, bytes) {
  assertSafeRelative(rel);
  const target = path.join(outDir, rel);
  if (fs.existsSync(target)) {
    const existing = fs.readFileSync(target);
    if (!existing.equals(bytes)) {
      fail(`${rel} is already published with different bytes — versions are write-once`);
    }
    return false;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes);
  return true;
}

function writePointer(rel, bytes) {
  assertSafeRelative(rel);
  const target = path.join(outDir, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes);
}

function writeSums() {
  const files = walk(outDir).filter((rel) => rel !== SUMS_PATH && rel !== HEADERS_PATH);
  const lines = files.map((rel) => `${sha256(fs.readFileSync(path.join(outDir, rel)))}  ${rel}`);
  fs.writeFileSync(path.join(outDir, SUMS_PATH), `${lines.join("\n")}\n`);
  return files.length;
}

function parseManifestText(text) {
  if (opts.publicKey) return verifyManifest(text, JSON.parse(opts.publicKey));
  return JSON.parse(parseEnvelope(text).payload);
}

function assertSignatureKey() {
  if (opts.publicKey) return;
  console.warn("! FISH_UPDATE_PUBLIC_KEY is unset — the manifest signature was not verified");
}

if (opts.promote) {
  promote(opts.promote);
} else {
  release();
}

function promote(version) {
  const manifestRel = manifestPath(version);
  const shellRel = shellPath(version);
  const manifestFile = path.join(outDir, manifestRel);
  const shellFile = path.join(outDir, shellRel);
  if (!fs.existsSync(manifestFile) || !fs.existsSync(shellFile)) {
    fail(
      `v${version} is not on the origin and not in the carry set.\n` +
        `       Restore it from the GitHub Release archive first, then promote.`
    );
  }
  const bytes = fs.readFileSync(shellFile);
  const payload = parseManifestText(fs.readFileSync(manifestFile, "utf8"));
  assertPayload(payload, {
    version,
    url: `${origin}/${shellRel}`,
    sha256: sha256(bytes)
  });
  assertSignatureKey();
  writePointer(STABLE_MANIFEST, fs.readFileSync(manifestFile));
  writePointer(STABLE_SHELL, bytes);
  finish(version, { mode: "promote" });
}

function release() {
  const version = opts.version || pkg.version;
  if (version !== pkg.version) {
    fail(`--version ${version} does not match package.json ${pkg.version} — the package is the single source`);
  }

  const shellFile = path.resolve(root, opts.shell);
  if (!fs.existsSync(shellFile)) fail(`${opts.shell} not found — run "npm run build" first`);
  const bytes = fs.readFileSync(shellFile);
  const digest = sha256(bytes);
  const url = `${origin}/${shellPath(version)}`;

  const manifestFile = path.resolve(root, opts.manifest);
  if (!fs.existsSync(manifestFile)) {
    fail(`${opts.manifest} not found — run "npm run release:manifest" first`);
  }
  const manifestText = fs.readFileSync(manifestFile, "utf8");
  const payload = parseManifestText(manifestText);
  if (payload.app !== APP_ID) fail(`manifest is for "${String(payload.app)}", not ${APP_ID}`);
  assertPayload(payload, { version, url, sha256: digest });
  assertSignatureKey();

  const plugins = readPlugins(path.resolve(root, opts.plugins));
  if (plugins.length === 0) fail(`no signed plugins under ${opts.plugins}`);

  const kitFile = path.resolve(root, opts.kit || `dist/fish-agent-kit-${version}.zip`);
  if (!fs.existsSync(kitFile)) fail(`${path.relative(root, kitFile)} not found — run "npm run release:kit" first`);
  const kitBytes = fs.readFileSync(kitFile);

  // Immutable artifacts first; the catalog next; the two pointers last.
  writeVersioned(shellPath(version), bytes);
  writeVersioned(manifestPath(version), Buffer.from(manifestText));
  for (const entry of plugins) {
    writeVersioned(pluginPath(entry.manifest.id, entry.manifest.version), fs.readFileSync(entry.file));
  }
  writePointer(CATALOG_PATH, Buffer.from(`${JSON.stringify(buildCatalog(version, plugins), null, 2)}\n`));
  writeVersioned(kitPath(version), kitBytes);
  writePointer(STABLE_MANIFEST, Buffer.from(manifestText));
  writePointer(STABLE_SHELL, bytes);

  finish(version, { mode: "release", plugins: plugins.length, kitBytes: kitBytes.length });
}

function finish(version, extra) {
  fs.writeFileSync(path.join(outDir, HEADERS_PATH), HEADERS);
  const count = writeSums();
  const total = walk(outDir).reduce((sum, rel) => sum + fs.statSync(path.join(outDir, rel)).size, 0);
  console.log(`✓ ${opts.out}  v${version}  ${extra.mode}`);
  console.log(`  origin       ${origin}`);
  console.log(`  files        ${count}  ${(total / 1024).toFixed(1)} KB`);
  console.log(`  carried      ${carried.files}${carried.note ? `  (${carried.note})` : ""}`);
  if (extra.plugins !== undefined) console.log(`  plugins      ${extra.plugins} signed bundles`);
  console.log(`  sums         ${SUMS_PATH}`);
}

async function carry(dir, from) {
  let response;
  try {
    response = await fetch(`${from}/${SUMS_PATH}`, { cache: "no-store" });
  } catch (error) {
    return { files: 0, note: `origin not reachable (${error.message}) — initial release` };
  }
  if (response.status === 404) return { files: 0, note: "origin has no release yet" };
  if (!response.ok) fail(`${from}/${SUMS_PATH} answered ${response.status}`);

  const entries = parseSums(await response.text()).filter(
    (entry) => entry.path !== SUMS_PATH && entry.path !== HEADERS_PATH && !entry.path.startsWith("stable/")
  );
  let files = 0;
  let next = 0;

  async function worker() {
    while (next < entries.length) {
      const entry = entries[next++];
      assertSafeRelative(entry.path);
      const target = path.join(dir, entry.path);
      if (fs.existsSync(target)) continue;
      const res = await fetch(`${from}/${entry.path}`, { cache: "no-store" });
      if (!res.ok) fail(`carrying ${entry.path}: ${res.status}`);
      const bytes = Buffer.from(await res.arrayBuffer());
      if (sha256(bytes) !== entry.hash) fail(`carrying ${entry.path}: hash does not match sha256sums.txt`);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, bytes);
      files++;
    }
  }

  await Promise.all(Array.from({ length: Math.min(4, Math.max(1, entries.length)) }, worker));
  return { files };
}
