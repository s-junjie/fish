/**
 * Concatenate the plugin's source files into the one file Figma will run.
 *
 * A Figma plugin's sandbox evaluates a single `main` script with no module
 * loader, so the files on disk cannot both be `main`. Rather than duplicate the
 * transport — which is how this repository ended up with two gradient mappings
 * ninety degrees apart — the sources stay separate and real, and this writes the
 * concatenation. `tests/figma-plugin-collect.test.ts` asserts the generated file
 * still equals the concatenation, so it cannot drift.
 *
 * It emits the INSTALLABLE plugin under `dist-plugins/figma-plugin/` — the files
 * Figma's "import from manifest" wants plus the listing icon. The source
 * directory stays sources only: `plugin.js` and `ui.html` are build outputs, and
 * `tests/figma-plugin-collect.test.ts` reads the built copies to prove they still
 * equal the concatenation.
 *
 *   node scripts/build-figma-plugin.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = path.join(root, "figma-plugin");

export const PLUGIN_SOURCES = ["collect.js", "host.js", "bundle.js"];
export const PLUGIN_OUTPUT = "plugin.js";
export const UI_TEMPLATE = "ui.src.html";
export const UI_OUTPUT = "ui.html";
export const PLUGIN_OUTPUT_DIR = path.join(root, "dist-plugins", "figma-plugin");

/** The 128 px brand mark Chrome already ships; Figma's listing wants the same file. */
const ICON_SOURCE = path.join(root, "chrome-extension", "icons", "icon128.png");

/** Where `bundle.js` goes inside the UI template. */
const BUNDLE_MARKER = "      // @@FISH_BUNDLE@@";

export function buildPlugin(sources = PLUGIN_SOURCES) {
  const parts = sources.map((name) => {
    const body = fs.readFileSync(path.join(dir, name), "utf8").trimEnd();
    return `// ---- ${name} ${"-".repeat(Math.max(0, 60 - name.length))}\n${body}`;
  });
  return `${parts.join("\n\n")}\n`;
}

/**
 * The UI, with the archive transport inlined.
 *
 * Figma gives the sandbox and the iframe no way to see each other's code, and
 * every version of this transport written as two files had a bug in one half that
 * the other half could not have caught — a typed array that did not survive
 * postMessage, then an ordering assumption that nothing had established. So the
 * transport lives in `bundle.js` ONCE and is inlined here, the same file the
 * sandbox runs, and `tests/figma-plugin-collect.test.ts` drives both halves
 * against each other.
 */
export function buildUi() {
  const template = fs.readFileSync(path.join(dir, UI_TEMPLATE), "utf8");
  if (!template.includes(BUNDLE_MARKER)) {
    throw new Error(`${UI_TEMPLATE} has no ${BUNDLE_MARKER} marker — the archive transport cannot be inlined.`);
  }
  const bundle = fs
    .readFileSync(path.join(dir, "bundle.js"), "utf8")
    .trimEnd()
    .split("\n")
    .map((line) => (line.trim() ? `      ${line}` : line))
    .join("\n");
  return template.replace(BUNDLE_MARKER, bundle);
}

fs.mkdirSync(PLUGIN_OUTPUT_DIR, { recursive: true });
for (const [out, next] of [
  [PLUGIN_OUTPUT, buildPlugin()],
  [UI_OUTPUT, buildUi()]
]) {
  const outPath = path.join(PLUGIN_OUTPUT_DIR, out);
  const current = fs.existsSync(outPath) ? fs.readFileSync(outPath, "utf8") : null;
  if (current !== next) {
    fs.writeFileSync(outPath, next);
    console.log(`wrote ${path.relative(root, outPath)} (${next.length} bytes)`);
  } else {
    console.log(`${path.relative(root, outPath)} is up to date`);
  }
}

/**
 * The installable plugin, beside the shell.
 *
 * Figma imports a plugin from its manifest, so the artifact is the FOLDER of
 * manifest, main, ui and icon, and copying it is the whole delivery step.
 * `dist-plugins/` is where every plugin artifact lives; the source tree stays
 * sources only.
 */
for (const [from, to] of [
  [path.join(dir, "manifest.json"), "manifest.json"],
  [ICON_SOURCE, "icon.png"]
]) {
  fs.copyFileSync(from, path.join(PLUGIN_OUTPUT_DIR, to));
}
console.log(`wrote ${path.relative(root, PLUGIN_OUTPUT_DIR)}/ (manifest.json, ${PLUGIN_OUTPUT}, ${UI_OUTPUT}, icon.png)`);
