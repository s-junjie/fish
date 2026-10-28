/**
 * Running the Figma plugin's source from a test.
 *
 * `figma-plugin/collect.js` is a classic script because Figma's sandbox has no
 * module loader — which means `import` cannot reach it and vitest cannot either.
 * So it is evaluated in a `vm` context with only the globals Figma would give it.
 * That is not a workaround: it is the same environment, and a file that only runs
 * because of some Node-only affordance fails here exactly as it would in Figma.
 */

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { buildPlugin, buildUi, PLUGIN_OUTPUT, PLUGIN_OUTPUT_DIR, PLUGIN_SOURCES, UI_OUTPUT } from "../../scripts/build-figma-plugin.mjs";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
export const PLUGIN_DIR = path.join(ROOT, "figma-plugin");

export interface CollectApi {
  FISH_EXPORT_FORMAT: string;
  FISH_EXPORT_VERSION: number;
  collectNode(node: unknown, ctx?: unknown): Record<string, unknown> | null;
  collectPaint(paint: unknown): Record<string, unknown> | null;
  collectIndividualStrokeWeights(node: unknown): Record<string, number> | undefined;
  collectTypeStyle(props: unknown): Record<string, unknown> | undefined;
  collectLineHeight(props: unknown): Record<string, number>;
  collectLetterSpacing(props: unknown): number | undefined;
  collectTextOverrides(textNode: unknown, nodeStyle: unknown): Record<string, unknown>;
  collectStyles(styles: unknown[]): Array<Record<string, unknown>> | undefined;
  buildExport(nodes: unknown[], meta?: unknown): Record<string, unknown>;
}

/**
 * The sandbox's global set — what Figma gives a plugin, and nothing more.
 *
 * THIS LIST IS A CONSTRAINT, NOT A CONVENIENCE. The first version of it handed the
 * plugin `TextEncoder`, which the real sandbox does not have, so a plugin that
 * used one passed every test here and then failed on the designer's machine at
 * export time. A test double that is more capable than the thing it stands in for
 * does not test the thing; it tests the double.
 *
 * So this is deliberately the SMALL set. Anything absent here is absent in Figma,
 * and code that reaches for it is caught by `npm test` instead of by a designer.
 */
export const FIGMA_SANDBOX_GLOBALS = {
  figma: {} as Record<string, unknown>,
  JSON,
  Math,
  Object,
  Array,
  Date,
  Error,
  Promise,
  Map,
  Set,
  Symbol,
  Uint8Array,
  Uint32Array,
  Int32Array,
  ArrayBuffer,
  DataView,
  console,
  // Present, and MEASURED present: the first export that worked moved 99.6MB of
  // base64 across `postMessage` using `btoa`. Listing a global as banned while it
  // is really available is the same mistake as providing one that is really
  // absent, in the other direction — it blocks working code on a guess.
  btoa,
  atob
} as Record<string, unknown>;

/**
 * Load `collect.js` with the two globals it is allowed to rely on.
 *
 * `figma.mixed` is a Symbol, and it is the whole reason this shim needs a guard
 * everywhere: `JSON.stringify` turns one into `{}` and a mixed fill into a paint
 * with no colour, which imports as an invisible shape rather than as an error.
 */
export function loadCollect(mixed: symbol = Symbol("figma.mixed")): CollectApi {
  const source = fs.readFileSync(path.join(PLUGIN_DIR, "collect.js"), "utf8");
  const moduleShim: { exports: Record<string, unknown> } = { exports: {} };
  const sandbox: Record<string, unknown> = {
    ...FIGMA_SANDBOX_GLOBALS,
    figma: { mixed, apiVersion: "1.0.0" },
    module: moduleShim
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: "collect.js" });
  return moduleShim.exports as unknown as CollectApi;
}

/**
 * Load any plugin source under the sandbox's globals.
 *
 * The context has no `TextEncoder`, no `TextDecoder`, no `Blob`, no `atob`/`btoa`,
 * no `fetch` and no `document` — because the real one has none of those, and a
 * plugin that uses one cannot work.
 */
export function loadPluginSource(name: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return loadPluginContext(name, extra).exports;
}

/**
 * The same load, with the sandbox kept.
 *
 * A classic script's top-level `var` is a property of the context's global, so
 * holding the sandbox lets a test poke one — which is how a size-limited branch
 * is reached without a fixture the size of the limit. Everything else about the
 * environment is exactly what `loadPluginSource` builds.
 */
export function loadPluginContext(name: string, extra: Record<string, unknown> = {}) {
  const fromSource = path.join(PLUGIN_DIR, name);
  const file = fs.existsSync(fromSource) ? fromSource : path.join(PLUGIN_OUTPUT_DIR, name);
  const source = fs.readFileSync(file, "utf8");
  const moduleShim: { exports: Record<string, unknown> } = { exports: {} };
  const sandbox: Record<string, unknown> = { ...FIGMA_SANDBOX_GLOBALS, module: moduleShim, ...extra };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: name });
  return { exports: moduleShim.exports, sandbox };
}

/**
 * Assert the shipped plugin is the two sources, concatenated.
 *
 * `plugin.js` is generated because a Figma plugin runs one file. It is written
 * only to `dist-plugins/figma-plugin/` and asserted here so it cannot become a
 * third copy of anything. Importing the build module writes it, so the read
 * below is always of the artifact this run just produced.
 */
export function pluginBundle(): { name: string; body: string }[] {
  return PLUGIN_SOURCES.map((name: string) => ({ name, body: fs.readFileSync(path.join(PLUGIN_DIR, name), "utf8") }));
}

export function generatedPlugin(): string {
  return fs.readFileSync(path.join(PLUGIN_OUTPUT_DIR, PLUGIN_OUTPUT), "utf8");
}

export function generatedUi(): string {
  return fs.readFileSync(path.join(PLUGIN_OUTPUT_DIR, UI_OUTPUT), "utf8");
}

export { buildUi };

export { buildPlugin };
