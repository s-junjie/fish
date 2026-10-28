/**
 * Bundle one plugin into the single signed file a `blob:` module can run.
 *
 * Four rules, each one the answer to a measured failure (see `docs/PLUGINS.md`):
 *
 * 1. **One file.** A `blob:` module has no base URL, so a relative chunk import
 *    fails to resolve. Code splitting stays off.
 * 2. **No framework.** `preact/jsx-runtime` is redirected to the host shim; any
 *    other `preact`/`react` import is a build error rather than a silently
 *    inlined second copy.
 * 3. **Identity is data.** Everything a panel shows about itself comes from
 *    `plugin.json`; the bundle ships only `apiVersion` and `Component`.
 * 4. **The file vouches for itself.** The manifest and its SHA-256 are signed
 *    with the project key and appended as a comment, so the shell never needs a
 *    list of plugins it might be asked to install.
 *
 *   node scripts/build-plugin.mjs icons
 *   node scripts/build-plugin.mjs --all
 */
import * as esbuild from "esbuild";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureKey, signPlugin } from "./lib/plugin-sign.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_DIR = path.join(root, "src", "plugins");
const OUT_DIR = path.join(root, "dist-plugins");
const JSX_SHIM = path.join(PLUGIN_DIR, "_host", "jsx-runtime.ts");

const HOSTED = /^(?:preact|react|react-dom)(?:[/]|$)/;

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

function listPlugins() {
  return fs
    .readdirSync(PLUGIN_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("_"))
    .filter((e) => fs.existsSync(path.join(PLUGIN_DIR, e.name, "plugin.json")))
    .map((e) => e.name);
}

function readMetadata(name) {
  const file = path.join(PLUGIN_DIR, name, "plugin.json");
  let meta;
  try {
    meta = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    fail(`${name}/plugin.json is not valid JSON: ${err.message}`);
  }
  for (const key of ["id", "name", "version", "hostApi", "category", "icon"]) {
    if (typeof meta[key] !== "string" || !meta[key]) fail(`${name}/plugin.json is missing "${key}"`);
  }
  return meta;
}

const hostOnly = {
  name: "host-only-imports",
  setup(build) {
    build.onResolve({ filter: HOSTED }, (args) => {
      if (args.path === "preact/jsx-runtime") return { path: JSX_SHIM };
      return {
        errors: [
          {
            text: `"${args.path}" must not be bundled: a plugin gets its runtime from the host (import from ../_host instead)`
          }
        ]
      };
    });
  }
};

async function buildOne(name) {
  const meta = readMetadata(name);
  const entry = path.join(PLUGIN_DIR, name, "index.tsx");
  if (!fs.existsSync(entry)) fail(`${name} has no index.tsx`);

  const result = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "chrome110",
    minify: true,
    legalComments: "none",
    jsx: "automatic",
    jsxImportSource: "preact",
    splitting: false,
    logLevel: "silent",
    plugins: [hostOnly]
  });

  const code = result.outputFiles[0].contents;
  const manifest = {
    id: meta.id,
    name: meta.name,
    description: meta.description ?? "",
    category: meta.category,
    icon: meta.icon,
    version: meta.version,
    hostApi: meta.hostApi,
    sha256: crypto.createHash("sha256").update(code).digest("hex"),
    bytes: code.length,
    ...(meta.width !== undefined ? { width: meta.width } : {}),
    ...(meta.height !== undefined ? { height: meta.height } : {}),
    ...(meta.minWidth !== undefined ? { minWidth: meta.minWidth } : {}),
    ...(meta.minHeight !== undefined ? { minHeight: meta.minHeight } : {}),
    ...(meta.resize !== undefined ? { resize: meta.resize } : {}),
    ...(meta.attribution !== undefined ? { attribution: meta.attribution } : {})
  };

  const signed = await signPlugin(code, manifest);
  const rel = path.join(meta.id, meta.version, "plugin.js");
  const outFile = path.join(OUT_DIR, rel);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, signed.file);

  return { manifest, outFile, size: code.length, signedSize: signed.file.length };
}

const args = process.argv.slice(2);
const all = args.includes("--all");
const names = all ? listPlugins() : args.filter((a) => !a.startsWith("--"));
if (names.length === 0) fail("name a plugin (icons) or pass --all");

const key = await ensureKey();
if (key.created) console.log("• generated .fish-plugin-key.json (gitignored) — the shell must be rebuilt to trust it");

for (const name of names) {
  const built = await buildOne(name);
  const kb = (built.size / 1024).toFixed(1);
  console.log(
    `✓ ${built.manifest.id}@${built.manifest.version}  ${kb} KB  ${built.manifest.sha256.slice(0, 16)}…  ${path.relative(root, built.outFile)}`
  );
}
