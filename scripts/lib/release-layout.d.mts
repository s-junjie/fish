/**
 * The published layout, for the type-checked side (`vite.config.ts`, `tests/`).
 * `assemble-site.mjs` writes these paths and `verify-published.mjs` reads them
 * back; a test that grades the client's URL against them has to see the same
 * strings, so this mirror must stay complete.
 */
export const DEFAULT_ORIGIN: string;
export const APP_ID: string;
export const SHELL_DIR: string;
export const MANIFEST_DIR: string;
export const STABLE_MANIFEST: string;
export const STABLE_SHELL: string;
export const CATALOG_PATH: string;
export const KIT_DIR: string;
export const SKILL_DIR: string;
export const STABLE_SKILL: string;
export const STABLE_KIT: string;
export const SUMS_PATH: string;
export const HEADERS_PATH: string;
export const HEADERS: string;

export function shellPath(version: string): string;
export function manifestPath(version: string): string;
export function kitPath(version: string): string;
export function skillPath(version: string): string;
export function skillRefPath(version: string, name: string): string;
export function pluginPath(id: string, version: string): string;
export function sha256(bytes: Uint8Array | Buffer | string): string;
export function toPosix(value: string): string;
export function assertSafeRelative(value: string): string;
export function parseSums(text: string): Array<{ hash: string; path: string }>;
