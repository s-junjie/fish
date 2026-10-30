/**
 * The published layout of the update origin, in one place.
 *
 * `assemble-site.mjs` writes these paths and `verify-published.mjs` reads them
 * back, so the two cannot disagree about where a release lives. The origin is a
 * rolling site: the current release plus everything carried forward from the
 * previous deploy, because a static-assets deploy is a whole-site snapshot.
 */
import { createHash } from "node:crypto";

export const DEFAULT_ORIGIN = "https://dl.fish.themindstudio.cc";
export const APP_ID = "fish";

export const SHELL_DIR = "shell";
export const MANIFEST_DIR = "manifests";
export const STABLE_MANIFEST = "stable/manifest.json";
export const STABLE_SHELL = "stable/fish.html";
export const CATALOG_PATH = "catalog.json";
export const KIT_DIR = "kit";
export const SKILL_DIR = "skill";
export const STABLE_SKILL = "skill.md";
export const STABLE_KIT = "stable/fish-agent-kit.zip";
export const SUMS_PATH = "sha256sums.txt";
export const HEADERS_PATH = "_headers";

export function shellPath(version) {
  return `${SHELL_DIR}/${version}/index.html`;
}

export function manifestPath(version) {
  return `${MANIFEST_DIR}/${version}.json`;
}

export function kitPath(version) {
  return `${KIT_DIR}/fish-agent-kit-${version}.zip`;
}

/**
 * The skill as a readable page, not only as an archive member.
 *
 * A `*`-splat in `_headers` cannot also be a pointer, so the versioned copy is
 * immutable and the unversioned `skill.md` sits at the root where it gets its
 * own `no-store` rule. The page is what a user @-mentions; the zip is what an
 * installer downloads.
 */
export function skillPath(version) {
  return `${SKILL_DIR}/${version}/SKILL.md`;
}

export function skillRefPath(version, name) {
  return `${SKILL_DIR}/${version}/references/${name}`;
}

export function pluginPath(id, version) {
  return `plugins/${id}/${version}/plugin.js`;
}

/**
 * `_headers` rules. One splat per pattern is a Cloudflare limitation, which is
 * why the catalog sits at the root instead of under `/plugins/`: a rule for
 * `/plugins/*` must not also match a pointer that needs `no-store`.
 *
 * Every matching rule contributes its headers, and two values for the same
 * header are joined with a comma — so no path appears twice with a Cache-Control
 * value.
 */
export const HEADERS = `# FISH update origin. Read by Workers static assets; the file itself is never served.
/*
  Access-Control-Allow-Origin: *
  Access-Control-Allow-Methods: GET, HEAD, OPTIONS
  X-Content-Type-Options: nosniff

# A version is in the path, so these bytes are immutable by construction.
/shell/*
  Cache-Control: public, max-age=31536000, immutable

/manifests/*
  Cache-Control: public, max-age=31536000, immutable

/plugins/*
  Cache-Control: public, max-age=31536000, immutable

/kit/*
  Cache-Control: public, max-age=31536000, immutable

/skill/*
  Cache-Control: public, max-age=31536000, immutable

# Pointers are read on every check and must never be served stale.
/stable/*
  Cache-Control: no-store

/skill.md
  Cache-Control: no-store

/catalog.json
  Cache-Control: no-store

/sha256sums.txt
  Cache-Control: no-store
`;

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function toPosix(value) {
  return value.split("\\").join("/");
}

/** Reject a path that could escape the output directory or confuse a URL. */
export function assertSafeRelative(value) {
  if (typeof value !== "string" || !value) throw new Error(`unsafe path: ${String(value)}`);
  if (value.startsWith("/") || value.includes("\\") || value.includes("..")) {
    throw new Error(`unsafe path: ${value}`);
  }
  if (!/^[A-Za-z0-9._/-]+$/.test(value)) throw new Error(`unsafe path: ${value}`);
  return value;
}

/** `sha256sums.txt` lines, sorted by path, without the file that holds them. */
export function parseSums(text) {
  const entries = [];
  for (const line of text.split("\n")) {
    const match = /^([0-9a-f]{64})\s{2}(.+)$/.exec(line.trimEnd());
    if (match) entries.push({ hash: match[1], path: match[2] });
  }
  return entries;
}
