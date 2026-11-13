import fs from "node:fs";
import path from "node:path";
import { sha256 } from "./release-layout.mjs";
import { splitSigned } from "./plugin-sign.mjs";

/**
 * Read the signed plugin bundles the build produced and describe them.
 *
 * The trailer is the source of truth, not `plugin.json`: the whole point of a
 * self-vouching file is that the bytes that ship carry the manifest and the hash
 * that signature covers. Reading the source metadata here would let the catalog
 * describe a file that was never built.
 */
export function readPlugins(dir) {
  if (!fs.existsSync(dir)) throw new Error(`plugin build directory not found: ${dir}`);
  const plugins = [];
  for (const id of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!id.isDirectory()) continue;
    const idDir = path.join(dir, id.name);
    for (const version of fs.readdirSync(idDir, { withFileTypes: true })) {
      if (!version.isDirectory()) continue;
      const file = path.join(idDir, version.name, "plugin.js");
      if (!fs.existsSync(file)) continue;
      const signed = fs.readFileSync(file);
      const split = splitSigned(signed);
      if (!split) throw new Error(`${file} carries no signature trailer`);
      let envelope;
      try {
        envelope = JSON.parse(Buffer.from(split.trailer, "base64").toString("utf8"));
      } catch {
        throw new Error(`${file} has a malformed signature trailer`);
      }
      let manifest;
      try {
        manifest = JSON.parse(envelope.payload);
      } catch {
        throw new Error(`${file} has a malformed signed manifest`);
      }
      const codeHash = sha256(Buffer.from(split.code));
      if (codeHash !== manifest.sha256) {
        throw new Error(`${file} does not match its signed sha256`);
      }
      if (manifest.id !== id.name || manifest.version !== version.name) {
        throw new Error(`${file} claims ${manifest.id}@${manifest.version}`);
      }
      plugins.push({ manifest, file, signedBytes: signed.length });
    }
  }
  plugins.sort((a, b) => {
    if (a.manifest.id !== b.manifest.id) return a.manifest.id.localeCompare(b.manifest.id);
    return compareNumeric(a.manifest.version, b.manifest.version);
  });
  return plugins;
}

/**
 * Every id appears once, at its newest version.
 *
 * `readPlugins` reads what is on disk, and a build directory that was never
 * cleared keeps older versions next to the new one. The resources popover keys
 * its rows by id, so a second row for the same plugin is a duplicate key and an
 * install button that would fetch an old bundle.
 */
export function buildCatalog(appVersion, plugins) {
  const newest = new Map();
  for (const entry of plugins) {
    const current = newest.get(entry.manifest.id);
    if (!current || compareNumeric(entry.manifest.version, current.manifest.version) > 0) {
      newest.set(entry.manifest.id, entry);
    }
  }
  return {
    app: "fish",
    version: appVersion,
    plugins: Array.from(newest.values(), (entry) => entry.manifest)
  };
}

export function compareNumeric(a, b) {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] || 0) - (right[i] || 0);
    if (diff) return diff;
  }
  return 0;
}
