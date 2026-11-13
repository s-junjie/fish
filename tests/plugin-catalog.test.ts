import { describe, it, expect } from "vitest";
import { pluginBundleUrl, DEFAULT_CATALOG_ORIGIN } from "../src/core/plugins/catalog";
import { pluginPath } from "../scripts/lib/release-layout.mjs";
import { buildCatalog } from "../scripts/lib/plugin-catalog.mjs";

/**
 * The catalog the client reads and the site the release writes must agree on
 * where a bundle lives. They are two files with no import between them, so the
 * consequence of drifting is a 404 only a release would show — and the dev
 * server serves the same shape, which makes this the one place the shape is
 * pinned.
 */
describe("plugin bundle URL", () => {
  const manifest = { id: "fish.icons", version: "1.1.0" } as never;

  it("derives the published path from the default catalog origin", () => {
    expect(pluginBundleUrl(manifest)).toBe(
      `${DEFAULT_CATALOG_ORIGIN}/${pluginPath("fish.icons", "1.1.0")}`
    );
  });

  it("treats the catalog URL as a directory, query and all", () => {
    expect(pluginBundleUrl(manifest, "https://example.test/catalog.json?t=1")).toBe(
      `https://example.test/${pluginPath("fish.icons", "1.1.0")}`
    );
    expect(pluginBundleUrl(manifest, "https://example.test/")).toBe(
      `https://example.test/${pluginPath("fish.icons", "1.1.0")}`
    );
  });
});

/**
 * `readPlugins` reads the build directory as it is, and that directory keeps
 * every version ever built. A catalog with two rows for one id is two install
 * buttons that fetch different bytes, keyed by the same id.
 */
describe("catalog rows", () => {
  const entry = (id: string, version: string) => ({ manifest: { id, version }, file: "", signedBytes: 0 });

  it("lists one row per id, at the newest version", () => {
    const catalog = buildCatalog("0.0.0", [
      entry("fish.icons", "1.0.0"),
      entry("fish.icons", "1.1.0"),
      entry("fish.icons", "1.9.9"),
      entry("fish.openverse", "1.1.0")
    ]);
    expect(catalog.plugins.map((m: { id: string; version: string }) => `${m.id}@${m.version}`)).toEqual([
      "fish.icons@1.9.9",
      "fish.openverse@1.1.0"
    ]);
  });
});
