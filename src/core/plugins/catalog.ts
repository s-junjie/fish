import { pluginPublicKey } from "./plugin-key";
import { installPlugin } from "./loader";
import type { PluginManifest } from "./manifest";

export const CATALOG_URL_KEY = "fish:pluginCatalogUrl";
export const DEFAULT_CATALOG_ORIGIN = "https://dl.fish.themindstudio.cc";

declare const __FISH_PLUGIN_CATALOG_URL__: string;

export interface PluginCatalog {
  app: string;
  version: string;
  plugins: PluginManifest[];
}

function readStorage(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function defaultCatalogUrl(): string {
  const builtIn = typeof __FISH_PLUGIN_CATALOG_URL__ === "string" ? __FISH_PLUGIN_CATALOG_URL__.trim() : "";
  if (builtIn) return builtIn;
  return `${DEFAULT_CATALOG_ORIGIN}/catalog.json`;
}

export function catalogUrl(): string {
  const override = readStorage(CATALOG_URL_KEY)?.trim();
  if (override) {
    try {
      if (/^https?:$/.test(new URL(override).protocol)) return override;
    } catch {
      // Fall back to default
    }
  }
  return defaultCatalogUrl();
}

export function pluginBundleUrl(manifest: PluginManifest, catalogBaseUrl?: string): string {
  const base = (catalogBaseUrl ?? catalogUrl()).replace(/\/catalog\.json(\?.*)?$/i, "");
  return `${base}/plugins/${manifest.id}/${manifest.version}/plugin.js`;
}

export async function fetchPluginCatalog(
  url: string = catalogUrl(),
  fetchImpl?: typeof globalThis.fetch
): Promise<PluginCatalog> {
  const doFetch = fetchImpl ?? globalThis.fetch;
  const res = await doFetch(url, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`failed to fetch plugin catalog from ${url} (status ${res.status})`);
  }
  const data = (await res.json()) as PluginCatalog;
  if (!data || data.app !== "fish" || !Array.isArray(data.plugins)) {
    throw new Error("malformed plugin catalog format");
  }
  return data;
}

export async function installPluginFromCatalog(
  manifest: PluginManifest,
  options?: {
    catalogBaseUrl?: string;
    fetchImpl?: typeof globalThis.fetch;
  }
): Promise<PluginManifest> {
  const url = pluginBundleUrl(manifest, options?.catalogBaseUrl);
  const doFetch = options?.fetchImpl ?? globalThis.fetch;
  const res = await doFetch(url);
  if (!res.ok) {
    throw new Error(`failed to download plugin bundle from ${url} (status ${res.status})`);
  }
  const bytes = await res.arrayBuffer();
  const record = await installPlugin(bytes);
  return record.manifest;
}
