/** What `plugin-catalog.mjs` reads back from signed trailers, for typed callers (vite config, tests). */
export interface CatalogManifest {
  id: string;
  version: string;
  [field: string]: unknown;
}

export interface PluginEntry {
  manifest: CatalogManifest;
  file: string;
  signedBytes: number;
}

export function readPlugins(dir: string): PluginEntry[];
export function buildCatalog(
  appVersion: string,
  plugins: PluginEntry[]
): { app: string; version: string; plugins: CatalogManifest[] };
export function compareNumeric(a: string, b: string): number;
