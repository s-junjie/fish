#!/usr/bin/env node
// Emits `dist/fish-agent-kit/` — the folder an external agent needs to create and
// verify a document, co-located with the engine that will load it.
//
// It is a build output, not a checked-in bundle, for the same reason the shell is:
// a second hand-maintained copy of SKILL.md drifts from the engine within a
// release, and an agent that trusts the copy writes against an API that is not
// there. Copying at build time makes that impossible — the kit is by
// construction the docs for the binary beside it.
//
// Nothing here reaches the shipped file: the kit is a directory beside
// `dist/index.html`, not part of it, and these are copies of files the build
// already produced.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { renderSkill, skillVariables } from "./lib/skill-render.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const kit = path.join(root, "dist", "fish-agent-kit");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

// One place to point the skill at its release. `kit.config.json` is the
// committed default; `FISH_KIT_URL` overrides it in CI without editing a file.
const configPath = path.join(root, "kit.config.json");
let configuredUrl = "";
if (fs.existsSync(configPath)) {
  try {
    configuredUrl = String(JSON.parse(fs.readFileSync(configPath, "utf-8")).url ?? "").trim();
  } catch (err) {
    console.error(`kit.config.json is not valid JSON: ${err.message}`);
    process.exit(2);
  }
}
const kitUrl = (process.env.FISH_KIT_URL?.trim() || configuredUrl).trim();
if (kitUrl) {
  let parsed;
  try {
    parsed = new URL(kitUrl);
  } catch {
    console.error(`KIT_URL is not an absolute URL: ${kitUrl}`);
    process.exit(2);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    console.error(`KIT_URL must be http(s), got ${parsed.protocol}`);
    process.exit(2);
  }
}

/**
 * Nothing in the kit may need installing. `shot.sh` uses bash, coreutils and a
 * browser the machine already has; the earlier Playwright path meant a
 * `package.json` here purely to declare the dependency, plus a 215 MB download, in
 * exchange for driving a browser that was already present.
 *
 * The source of the kit is `agent-kit/`, and it mirrors this directory exactly:
 * `SKILL.md` is the same file the skill publishes, and `references/` sits beside
 * it, so an author reading the repo sees the documentation half of the kit they
 * will receive (the binary half — `tools/`, `templates/` — exists only here).
 * Keeping the entry point at the repository root instead left the two halves in
 * two places, and made the "beside this file" instruction in `SKILL.md` false
 * wherever it was read from the source tree.
 *
 * The kit is kept to the files an author needs; the blank shell is most of its size:
 * - Reference documents live under `references/`.
 * - Templates live under `templates/` (`templates/blank.fish.html`).
 * - Examples are not emitted: the kit's `blank.fish.html` is the template a
 *   document starts from.
 */
const FILES = [
  { from: "agent-kit/SKILL.md", to: "SKILL.md" },
  { from: "src/core/dsl/fish.schema.json", to: "tools/fish.schema.json" },
  { from: "dist/index.html", to: "templates/blank.fish.html" },
  { from: "scripts/shot.sh", to: "tools/shot.sh" },
  { from: "scripts/shot.ps1", to: "tools/shot.ps1" }
];

const DIRS = [{ from: "agent-kit/references", to: "references" }];

/**
 * Compiled rather than copied.
 *
 * `fish check` runs normalize and validate — the same pure core the browser runs
 * — so an agent can ask "did the engine change my document" without booting a
 * browser at all. It has to be a build output for the reason everything else
 * here is: a checked-in copy of the CLI would be a second implementation to keep
 * in step with the engine. esbuild inlines the core, so the result still needs
 * nothing installed beyond the Node already on the machine.
 */
const BUNDLES = [
  { from: "src/core/cli/fish.ts", to: "tools/fish.cjs" },
  { from: "scripts/fish-launcher.sh", to: "tools/fish" }
];

/**
 * The browser half of `fish assets import|embed`.
 *
 * Compiled for the browser rather than for Node, because the policy it applies is
 * the app's own — `MAX_IMAGE_EDGE` / `WEBP_QUALITY` in `image-loader.ts` — and
 * applying it means decoding and re-encoding, which only a canvas can do. It is a
 * sibling of the CLI rather than inlined into it so `fish.cjs` stays a CLI that
 * reads as one, and so this can be opened and read on its own.
 */
const BROWSER_BUNDLES = [
  { from: "src/core/cli/image-harness.ts", to: "tools/image-harness.js" },
  { from: "src/core/cli/html-harness.ts", to: "tools/html-harness.js" }
];

const missing = [...FILES, ...DIRS, ...BUNDLES, ...BROWSER_BUNDLES].filter((f) =>
  !fs.existsSync(path.join(root, f.from))
);
if (missing.length > 0) {
  console.error(
    `agent kit not written — missing build inputs:\n${missing.map((f) => `  ${f.from}`).join("\n")}\n` +
      `Run \`npm run build\` first.`
  );
  process.exit(2);
}

fs.rmSync(kit, { recursive: true, force: true });
fs.mkdirSync(kit, { recursive: true });

for (const { from, to } of FILES) {
  const dest = path.join(kit, to);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(path.join(root, from), dest);
  // copyFileSync takes the default mode, so a script that was executable in the repo
  // arrives here not executable — and `./shot.sh` is the first thing anyone runs.
  fs.chmodSync(dest, fs.statSync(path.join(root, from)).mode & 0o777);
}

for (const { from, to } of DIRS) {
  fs.cpSync(path.join(root, from), path.join(kit, to), { recursive: true });
}

const skillSource = fs.readFileSync(path.join(root, "agent-kit/SKILL.md"), "utf-8");
const skillText = kitUrl
  ? renderSkill(
      skillSource,
      skillVariables({
        origin: new URL(kitUrl).origin,
        version: pkg.version,
        kitFile: new URL(kitUrl).pathname.replace(/^\/+/, ""),
        kitUrl
      })
    )
  : skillSource;
fs.writeFileSync(path.join(kit, "SKILL.md"), skillText);

for (const { from, to } of BUNDLES) {
  const dest = path.join(kit, to);
  if (from.endsWith(".ts")) {
    await build({
      entryPoints: [path.join(root, from)],
      outfile: dest,
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node18",
      legalComments: "none",
      logLevel: "warning"
    });
  } else {
    fs.copyFileSync(path.join(root, from), dest);
  }
  fs.chmodSync(dest, 0o755);
}

for (const { from, to } of BROWSER_BUNDLES) {
  await build({
    entryPoints: [path.join(root, from)],
    outfile: path.join(kit, to),
    bundle: true,
    platform: "browser",
    format: "iife",
    target: "chrome100",
    legalComments: "none",
    logLevel: "warning"
  });
  fs.chmodSync(path.join(kit, to), 0o644);
}

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

const emitted = [
  ...FILES.map((f) => path.join(kit, f.to)),
  ...DIRS.flatMap((d) => walk(path.join(kit, d.to))),
  ...BUNDLES.map((f) => path.join(kit, f.to)),
  ...BROWSER_BUNDLES.map((f) => path.join(kit, f.to))
];
const bytes = emitted.reduce((sum, file) => sum + fs.statSync(file).size, 0);
console.log(
  `\n  kit    dist/fish-agent-kit  ${(bytes / 1024).toFixed(1)} KB, ${emitted.length} files ` +
    `(shell 2 ×)`
);
console.log(
  kitUrl
    ? `  skill  SKILL.md pinned to ${kitUrl}\n`
    : `  skill  KIT_URL unset — SKILL.md keeps its placeholders\n`
);
