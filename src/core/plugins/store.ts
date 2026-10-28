/**
 * The plugin list as the UI sees it: what is installed, nothing else.
 *
 * This replaces the module-level `Map` that `plugin-registry.ts` filled at import
 * time. That form could not answer a question the UI now asks — "did the copy I
 * just installed show up?" — because it was written once, before anything the user
 * does, and nothing subscribed to it.
 *
 * There is deliberately no "available" list here. The shell does not know which
 * plugins exist; it learns one at a time, from a file that proves it.
 */
import { installedRecords, installFromFile, uninstallPlugin } from "./loader";
import type { PluginManifest } from "./manifest";

export interface PluginListSnapshot {
  items: PluginManifest[];
  /** False until the first read of the store has finished. */
  ready: boolean;
  error: string | null;
}

let installed: PluginManifest[] = [];
let ready = false;
let error: string | null = null;
let snapshot: PluginListSnapshot = { items: [], ready: false, error: null };

const listeners = new Set<() => void>();

function rebuild(): void {
  snapshot = { items: installed, ready, error };
  for (const fn of listeners) fn();
}

export function getPluginList(): PluginListSnapshot {
  return snapshot;
}

export function subscribePlugins(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Called once at boot; a failed read is retried the next time it is asked for. */
export async function hydratePlugins(): Promise<void> {
  if (ready && !error) return;
  try {
    const records = await installedRecords();
    installed = records.map((r) => r.manifest).sort((a, b) => a.id.localeCompare(b.id));
    error = null;
  } catch (err) {
    // A storage failure is a state the panel can show, not a reason to leave the
    // list stuck at "ready: false" forever.
    error = err instanceof Error ? err.message : String(err);
    installed = [];
  }
  ready = true;
  rebuild();
}

export async function installPluginFile(file: Blob): Promise<PluginManifest> {
  const record = await installFromFile(file);
  installed = [...installed.filter((m) => m.id !== record.id), record.manifest].sort((a, b) =>
    a.id.localeCompare(b.id)
  );
  error = null;
  rebuild();
  return record.manifest;
}

export async function removePlugin(id: string): Promise<void> {
  await uninstallPlugin(id);
  installed = installed.filter((m) => m.id !== id);
  rebuild();
}

/** Tests only: drop the module-level state between cases. */
export function __resetPluginStore(): void {
  installed = [];
  ready = false;
  error = null;
  listeners.clear();
  rebuild();
}
