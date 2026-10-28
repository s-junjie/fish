import { describe, expect, it } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { paintImageUri } from "../src/ui/inspector/paint-preview";
import { paintStackLayers } from "../src/core/geometry/gradient-utils";
import type { DesignDocument, Paint } from "../src/core/dsl/types";

/**
 * An image fill previewed as an empty checkerboard, twice.
 *
 * `paintStackLayers` skips an image layer it cannot resolve, so a preview that
 * renders a stack without an asset lookup is not wrong in a visible way: it draws
 * the checker underneath and nothing else, which reads as "this style has no
 * colour" rather than "this preview forgot the bitmap". The style editor's banner
 * and the style cards both did exactly that, so saving an image fill as a colour
 * style showed a blank plate.
 */

const SRC = join(__dirname, "..", "src");

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return sourceFiles(full);
      return /\.tsx?$/.test(entry.name) ? [full] : [];
    })
  );
  return nested.flat();
}

/**
 * Every source file, read once and in parallel.
 *
 * Read sequentially, the two scans below spent ~40ms per file on this machine —
 * 25s of a 30s budget for the same 640 files — so they failed on a busy box and
 * passed on an idle one. Reading concurrently (the convention every other scan
 * rig here follows) makes the test measure the code, not the disk.
 */
let sourceCache: Promise<{ rel: string; text: string }[]> | null = null;
const allSources = (): Promise<{ rel: string; text: string }[]> =>
  (sourceCache ??= sourceFiles(SRC).then((files) =>
    Promise.all(
      files.map(async (file) => ({ rel: file.slice(SRC.length + 1), text: await readFile(file, "utf-8") }))
    )
  ));

const docWith = (assets: Array<{ id: string; uri: string }>): DesignDocument =>
  ({ assets } as unknown as DesignDocument);

const imagePaint = (assetId: string): Paint => ({ type: "image", assetId, fit: "cover" } as Paint);

describe("an image paint's preview URI", () => {
  it("resolves through the document's own asset table", () => {
    const doc = docWith([{ id: "a1", uri: "data:image/png;base64,AAA" }]);
    expect(paintImageUri(doc)(imagePaint("a1"))).toBe("data:image/png;base64,AAA");
  });

  it("is undefined for an asset the document no longer holds", () => {
    const doc = docWith([{ id: "a1", uri: "data:image/png;base64,AAA" }]);
    expect(paintImageUri(doc)(imagePaint("gone"))).toBeUndefined();
    expect(paintImageUri(undefined)(imagePaint("a1"))).toBeUndefined();
  });

  it("leaves paints that name no bitmap alone", () => {
    const doc = docWith([{ id: "a1", uri: "data:image/png;base64,AAA" }]);
    expect(paintImageUri(doc)({ type: "solid", color: "#FF0000" } as Paint)).toBeUndefined();
  });

  it("produces the layer the banner draws", () => {
    const doc = docWith([{ id: "a1", uri: "data:image/png;base64,AAA" }]);
    const layers = paintStackLayers([imagePaint("a1")], paintImageUri(doc));
    expect(layers).toHaveLength(1);
    expect(layers[0].background).toContain('url("data:image/png;base64,AAA")');
    expect(layers[0].background).toContain("cover");
  });
});

describe("every paint preview goes through that one lookup", () => {
  it("never reaches into doc.assets for a URI outside the helper", async () => {
    const offenders: string[] = [];
    for (const { rel, text } of await allSources()) {
      if (rel === "ui/inspector/paint-preview.ts") continue;
      if (!/paint-preview"/.test(text)) continue;
      text.split("\n").forEach((line, i) => {
        if (/\bassets\b/.test(line) && /\.uri\b/.test(line)) offenders.push(`${rel}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it("never composes a stack without a way to resolve its images", async () => {
    const offenders: string[] = [];
    for (const { rel, text } of await allSources()) {
      for (const match of text.matchAll(/paintStackLayers\(([^)]*)\)/g)) {
        if (!/imageUri/.test(match[1])) offenders.push(`${rel}: ${match[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

/**
 * The colour panel is the third surface with the same hole: it renders an image
 * layer's own body (bitmap dropdown, preview, upload), and a host that forgot
 * `assets` made every one of those say "Missing image" — including the panel the
 * style editor opens on a draft, which is where saving an image fill as a colour
 * style begins. `tabs` is the exception clause: a caller that does not offer the
 * image kind has nothing to resolve.
 */
describe("a colour panel that can pick an image is given the document's assets", () => {
  it("passes assets wherever the image tab is reachable", async () => {
    const ts = await import("typescript");
    const offenders: string[] = [];
    for (const file of await sourceFiles(SRC)) {
      if (!file.endsWith(".tsx")) continue;
      const rel = file.slice(SRC.length + 1);
      const text = await readFile(file, "utf-8");
      if (!text.includes("<ColorPanel")) continue;
      const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TSX);
      const visit = (node: import("typescript").Node): void => {
        if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
          if (node.tagName.getText(sf) === "ColorPanel") {
            const attrs = node.attributes.properties;
            const attr = (name: string) =>
              attrs.find(
                (a): a is import("typescript").JsxAttribute =>
                  ts.isJsxAttribute(a) && a.name.getText(sf) === name
              );
            const tabs = attr("tabs")?.initializer?.getText(sf);
            // No `tabs` means the default, which includes the image kind.
            const offersImage = !tabs || /"image"|ALL_PAINT_TABS/.test(tabs);
            if (offersImage && !attr("assets")) {
              const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
              offenders.push(`${rel}:${line}`);
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }
    expect(offenders).toEqual([]);
  });
});
