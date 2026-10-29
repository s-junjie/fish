#!/usr/bin/env node
// Verify a published release the way the client will use it.
//
// The unit tests prove the engine verifies a manifest; this proves the server
// actually serves the bytes the manifest names, with headers a `file://` shell
// can read. It runs against the local deploy directory before upload and against
// the live origin after it.
//
//   node scripts/verify-published.mjs --dir release-site
//   node scripts/verify-published.mjs --base https://dl.fish.themindstudio.cc
//
// The CORS check is the response header, not a browser: `Access-Control-Allow-
// Origin: *` is what makes an opaque-origin `file://` page able to read it.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  APP_ID,
  CATALOG_PATH,
  DEFAULT_ORIGIN,
  HEADERS_PATH,
  STABLE_MANIFEST,
  STABLE_SHELL,
  SUMS_PATH,
  kitPath,
  manifestPath,
  parseSums,
  pluginPath,
  sha256,
  shellPath
} from "./lib/release-layout.mjs";
import { parseEnvelope, verifyManifest } from "./lib/release-manifest.mjs";
import { splitSigned } from "./lib/plugin-sign.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

const opts = {
  base: DEFAULT_ORIGIN,
  origin: DEFAULT_ORIGIN,
  dir: "",
  expect: pkg.version,
  publicKey: process.env.FISH_UPDATE_PUBLIC_KEY ?? ""
};

const args = process.argv.slice(2);
let baseGiven = false;
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--base") {
    opts.base = args[++i] ?? opts.base;
    baseGiven = true;
  } else if (arg === "--origin") opts.origin = args[++i] ?? opts.origin;
  else if (arg === "--dir") opts.dir = args[++i] ?? "";
  else if (arg === "--expect-version") opts.expect = args[++i] ?? opts.expect;
  else if (arg === "--public-key") opts.publicKey = args[++i] ?? "";
  else if (arg === "--help" || arg === "-h") {
    console.log(`Usage: node scripts/verify-published.mjs [options]

  --origin <url>          Canonical origin the manifest must name.
                          Default ${DEFAULT_ORIGIN}
  --base <url>            Where to fetch from. Defaults to --origin; set it to a
                          mirror when the signed URL and the mirror differ
  --dir <dir>             Verify a local deploy directory instead of the origin
  --expect-version <v>    Version the release must claim. Default package.json
  --public-key <jwk>      Verify the manifest signature (env FISH_UPDATE_PUBLIC_KEY)`);
    process.exit(0);
  } else {
    console.error(`error: unknown argument ${arg}`);
    process.exit(1);
  }
}

// A mirror serves the bytes under a different host than the signed manifest
// names, so the URL check follows --origin while the fetches follow --base.
if (!baseGiven) opts.base = opts.origin;

const failures = [];
const checks = [];

function pass(name, detail = "") {
  checks.push({ name, detail });
  console.log(`✔ ${name}${detail ? `  ${detail}` : ""}`);
}

function fail(name, message) {
  failures.push(`${name}: ${message}`);
  console.error(`✖ ${name}  ${message}`);
}

async function check(name, fn) {
  try {
    pass(name, await fn());
  } catch (error) {
    fail(name, error instanceof Error ? error.message : String(error));
  }
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

function requireHeader(response, name, test, where) {
  const value = response.headers.get(name) ?? "";
  if (!test(value)) throw new Error(`${where} sends ${name}: "${value}"`);
  return value;
}

function isJson(value) {
  return /application\/(json|[\w.+-]+\+json)/i.test(value);
}

function isZip(value) {
  return /zip/i.test(value);
}

function payloadFrom(text) {
  return opts.publicKey ? verifyManifest(text, JSON.parse(opts.publicKey)) : JSON.parse(parseEnvelope(text).payload);
}

function assertVersion(payload) {
  expect(payload?.app === APP_ID, `manifest is for "${String(payload?.app)}", not ${APP_ID}`);
  expect(payload.version === opts.expect, `manifest names v${payload.version}, expected v${opts.expect}`);
  expect(
    payload.url === `${opts.origin.replace(/\/+$/, "")}/${shellPath(opts.expect)}`,
    `manifest url is ${payload.url}, expected ${opts.origin.replace(/\/+$/, "")}/${shellPath(opts.expect)}`
  );
}

async function main() {
  if (!opts.publicKey) console.warn("! FISH_UPDATE_PUBLIC_KEY is unset — signatures are not verified\n");
  if (opts.dir) await verifyDirectory(path.resolve(root, opts.dir));
  else await verifyOrigin(opts.base.replace(/\/+$/, ""));
}

async function verifyOrigin(base) {
  let sums;
  await check("sha256sums.txt", async () => {
    sums = await fetchSums(base);
    return `${sums.count} files`;
  });
  // Everything below is graded against the sums index, so a missing index would
  // turn each later check into a misleading pass or a TypeError.
  if (!sums) return;

  let payload;
  let manifestText;
  await check("stable manifest", async () => {
    const text = await fetchChecked(`${base}/${STABLE_MANIFEST}`, {
      label: STABLE_MANIFEST,
      contentType: isJson,
      cache: (value) => /no-store/.test(value)
    });
    manifestText = text.text;
    payload = payloadFrom(manifestText);
    assertVersion(payload);
    return `v${payload.version}`;
  });
  if (!payload) return;

  let shell;
  await check("shell bytes", async () => {
    shell = await fetchChecked(`${base}/${shellPath(opts.expect)}`, {
      label: "shell",
      contentType: (value) => /text\/html/.test(value),
      cache: (value) => /immutable/.test(value)
    });
    expect(sha256(shell.bytes) === payload.sha256, "sha256 does not match the manifest");
    const html = shell.bytes.toString("utf8");
    expect(html.includes('id="fish-rt"'), "shell carries no editor runtime");
    const stamped = new RegExp(`<meta name="fish:version" content="([^"]+)">`).exec(html)?.[1];
    expect(stamped === opts.expect, `shell stamps v${String(stamped)}`);
    sums.assertFile(shellPath(opts.expect), shell.bytes);
    return `${(shell.bytes.length / 1024).toFixed(1)} KB`;
  });
  if (!shell) return;

  await check("manifest archive", async () => {
    const archived = await fetchChecked(`${base}/${manifestPath(opts.expect)}`, {
      label: manifestPath(opts.expect),
      contentType: isJson,
      cache: (value) => /immutable/.test(value)
    });
    expect(archived.text === manifestText, `${manifestPath(opts.expect)} differs from the stable manifest`);
    sums.assertFile(manifestPath(opts.expect), archived.bytes);
    return manifestPath(opts.expect);
  });

  await check("stable download alias", async () => {
    const stable = await fetchChecked(`${base}/${STABLE_SHELL}`, {
      label: STABLE_SHELL,
      contentType: (value) => /text\/html/.test(value),
      cache: (value) => /no-store/.test(value)
    });
    expect(stable.bytes.equals(shell.bytes), "stable/fish.html is not the current shell");
    sums.assertFile(STABLE_SHELL, stable.bytes);
    return "matches the manifest shell";
  });

  let catalog;
  await check("catalog", async () => {
    const text = await fetchChecked(`${base}/${CATALOG_PATH}`, {
      label: CATALOG_PATH,
      contentType: isJson,
      cache: (value) => /no-store/.test(value)
    });
    catalog = JSON.parse(text.text);
    expect(catalog.app === APP_ID, "catalog is not for fish");
    expect(catalog.version === opts.expect, `catalog names v${catalog.version}`);
    expect(Array.isArray(catalog.plugins) && catalog.plugins.length > 0, "catalog lists no plugins");
    sums.assertFile(CATALOG_PATH, text.bytes);
    return `${catalog.plugins.length} plugins`;
  });
  if (!catalog) return;

  await check("plugin bundles", async () => {
    for (const manifest of catalog.plugins) {
      const rel = pluginPath(manifest.id, manifest.version);
      const res = await fetchChecked(`${base}/${rel}`, {
        label: rel,
        contentType: (value) => /javascript/.test(value),
        cache: (value) => /immutable/.test(value)
      });
      const split = splitSigned(res.bytes);
      expect(split, `${rel} has no signature trailer`);
      expect(sha256(Buffer.from(split.code)) === manifest.sha256, `${rel} does not match its signed sha256`);
      sums.assertFile(rel, res.bytes);
    }
    return `${catalog.plugins.length} verified`;
  });

  await check("agent kit", async () => {
    const kitRel = kitPath(opts.expect);
    const kit = await fetchChecked(`${base}/${kitRel}`, {
      label: kitRel,
      contentType: isZip,
      cache: (value) => /immutable/.test(value)
    });
    sums.assertFile(kitRel, kit.bytes);
    return `${(kit.bytes.length / 1024).toFixed(1)} KB`;
  });

  await check("_headers is not served", async () => {
    const response = await fetch(`${base}/${HEADERS_PATH}`, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; FishReleaseVerifier/0.1.0)" }
    });
    expect(response.status === 404, `origin answers ${response.status} for /${HEADERS_PATH}`);
    return "404";
  });
}

async function fetchSums(base) {
  const response = await fetchChecked(`${base}/${SUMS_PATH}`, {
    label: SUMS_PATH,
    contentType: (value) => /text\/plain/.test(value),
    cache: (value) => /no-store/.test(value)
  });
  const entries = parseSums(response.text);
  const byPath = new Map(entries.map((entry) => [entry.path, entry.hash]));
  expect(entries.length > 0, "no entries");
  return {
    count: entries.length,
    assertFile(rel, bytes) {
      const expected = byPath.get(rel);
      expect(expected, `${rel} is not listed in ${SUMS_PATH}`);
      expect(sha256(bytes) === expected, `${rel} does not match ${SUMS_PATH}`);
    }
  };
}

async function fetchChecked(url, { label, contentType, cache }) {
  const response = await fetch(url, {
    cache: "no-store",
    headers: { "User-Agent": "Mozilla/5.0 (compatible; FishReleaseVerifier/0.1.0)" }
  });
  expect(response.ok, `${label} answered ${response.status}`);
  requireHeader(response, "access-control-allow-origin", (value) => value === "*", label);
  if (contentType) requireHeader(response, "content-type", contentType, label);
  if (cache) requireHeader(response, "cache-control", cache, label);
  const bytes = Buffer.from(await response.arrayBuffer());
  return { bytes, text: bytes.toString("utf8") };
}

async function verifyDirectory(dir) {
  const sumsPath = path.join(dir, SUMS_PATH);
  expect(fs.existsSync(sumsPath), `${SUMS_PATH} not found — run "npm run release:assemble" first`);
  const entries = parseSums(fs.readFileSync(sumsPath, "utf8"));
  const byPath = new Map(entries.map((entry) => [entry.path, entry.hash]));

  await check("sha256sums.txt", () => {
    expect(entries.length > 0, "no entries");
    for (const entry of entries) {
      const file = path.join(dir, entry.path);
      expect(fs.existsSync(file), `${entry.path} is listed but missing`);
      expect(sha256(fs.readFileSync(file)) === entry.hash, `${entry.path} does not match its hash`);
    }
    const listed = new Set(entries.map((entry) => entry.path));
    const extras = [];
    const walk = (current) => {
      for (const item of fs.readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, item.name);
        if (item.isDirectory()) walk(full);
        else {
          const rel = path.relative(dir, full).split(path.sep).join("/");
          if (rel !== SUMS_PATH && rel !== HEADERS_PATH && !listed.has(rel)) extras.push(rel);
        }
      }
    };
    walk(dir);
    expect(extras.length === 0, `not listed in ${SUMS_PATH}: ${extras.join(", ")}`);
    return `${entries.length} files`;
  });

  let payload;
  await check("stable manifest", () => {
    const text = fs.readFileSync(path.join(dir, STABLE_MANIFEST), "utf8");
    payload = payloadFrom(text);
    assertVersion(payload);
    return `v${payload.version}`;
  });

  await check("shell bytes", () => {
    const bytes = fs.readFileSync(path.join(dir, shellPath(opts.expect)));
    expect(sha256(bytes) === payload.sha256, "sha256 does not match the manifest");
    const html = bytes.toString("utf8");
    expect(html.includes('id="fish-rt"'), "shell carries no editor runtime");
    const stamped = new RegExp(`<meta name="fish:version" content="([^"]+)">`).exec(html)?.[1];
    expect(stamped === opts.expect, `shell stamps v${String(stamped)}`);
    return `${(bytes.length / 1024).toFixed(1)} KB`;
  });

  await check("stable download alias", () => {
    const stable = fs.readFileSync(path.join(dir, STABLE_SHELL));
    const shell = fs.readFileSync(path.join(dir, shellPath(opts.expect)));
    expect(stable.equals(shell), "stable/fish.html is not the current shell");
    return "matches the manifest shell";
  });

  let catalog;
  await check("catalog", () => {
    catalog = JSON.parse(fs.readFileSync(path.join(dir, CATALOG_PATH), "utf8"));
    expect(catalog.app === APP_ID, "catalog is not for fish");
    expect(catalog.version === opts.expect, `catalog names v${catalog.version}`);
    expect(Array.isArray(catalog.plugins) && catalog.plugins.length > 0, "catalog lists no plugins");
    return `${catalog.plugins.length} plugins`;
  });

  await check("plugin bundles", () => {
    for (const manifest of catalog.plugins) {
      const bytes = fs.readFileSync(path.join(dir, pluginPath(manifest.id, manifest.version)));
      const split = splitSigned(bytes);
      expect(split, `${manifest.id} has no signature trailer`);
      expect(sha256(Buffer.from(split.code)) === manifest.sha256, `${manifest.id} does not match its signed sha256`);
      expect(byPath.get(pluginPath(manifest.id, manifest.version)), `${manifest.id} is not listed in ${SUMS_PATH}`);
    }
    return `${catalog.plugins.length} verified`;
  });

  await check("agent kit", () => {
    const file = path.join(dir, kitPath(opts.expect));
    expect(fs.existsSync(file), `${kitPath(opts.expect)} is missing`);
    return `${(fs.statSync(file).size / 1024).toFixed(1)} KB`;
  });

  await check("_headers policy", () => {
    const text = fs.readFileSync(path.join(dir, HEADERS_PATH), "utf8");
    for (const [rule, header] of [
      ["/*", "Access-Control-Allow-Origin: *"],
      ["/stable/*", "Cache-Control: no-store"],
      ["/catalog.json", "Cache-Control: no-store"],
      ["/shell/*", "immutable"],
      ["/plugins/*", "immutable"],
      ["/kit/*", "immutable"]
    ]) {
      expect(text.includes(rule), `_headers has no rule for ${rule}`);
      expect(text.includes(header), `_headers has no "${header}"`);
    }
    return "CORS, no-store and immutable rules present";
  });

  await check("manifest archive", () => {
    const archived = fs.readFileSync(path.join(dir, manifestPath(opts.expect)), "utf8");
    const stable = fs.readFileSync(path.join(dir, STABLE_MANIFEST), "utf8");
    expect(archived === stable, `${manifestPath(opts.expect)} differs from the stable manifest`);
    return manifestPath(opts.expect);
  });
}

try {
  await main();
} catch (error) {
  fail("verify", error instanceof Error ? error.message : String(error));
}

console.log(`\n${checks.length} checks passed, ${failures.length} failed`);
if (failures.length) {
  for (const failure of failures) console.error(`  ✖ ${failure}`);
  process.exit(1);
}
