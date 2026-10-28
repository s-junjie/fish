/**
 * The export folder: `export.json` plus `assets/`, in a zip.
 *
 * Two things are worth testing here and one of them is the whole point.
 *
 * The container is arithmetic, so a round trip proves little on its own. What it
 * proves is the WIRE: `figma-plugin/bundle.js` is written by hand as a classic
 * script and read here by a different hand-written reader in a different module,
 * and the only thing that has ever connected them is a designer noticing that
 * their photographs went missing. So this loads the plugin's file with the same
 * `vm` trick that loads `collect.js`, builds an archive with IT, and reads it with
 * the app's reader. If the two disagree about a header offset, this is red.
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  FISH_BUNDLE_MANIFEST,
  buildStoredZip,
  looksLikeZip,
  readFigmaBundle,
  readStoredZip,
  FigmaBundleError
} from "../src/core/import/figma-bundle";
import { parseFigmaExport } from "../src/core/import/figma-export";
import { FIGMA_SANDBOX_GLOBALS, loadPluginSource } from "./helpers/figma-plugin-runtime";

const ROOT = path.resolve(import.meta.dirname, "..");

/** A real 1×1 PNG, so the bytes are an image and not a stand-in for one. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

interface PluginBundle {
  buildBundle(envelope: Record<string, unknown>, imageBytes: Record<string, Uint8Array>): Uint8Array;
  buildStoredZip(entries: Array<{ path: string; bytes: Uint8Array }>): Uint8Array;
  assetPath(ref: string, bytes: Uint8Array): string;
}

/** `figma-plugin/bundle.js` under the sandbox's globals — see the helper for why. */
function loadPluginBundle(): PluginBundle {
  return loadPluginSource("bundle.js") as unknown as PluginBundle;
}

const envelopeWith = (images: Record<string, string>): Record<string, unknown> => ({
  format: "fish.figma.export",
  version: 1,
  document: { id: "0:0", name: "Kit", type: "DOCUMENT", children: [] },
  images,
  unreadable: {}
});

describe("the container", () => {
  it("round-trips entries through a STORED archive", async () => {
    const entries = [
      { path: "export.json", bytes: new TextEncoder().encode('{"a":1}') },
      { path: "assets/one.png", bytes: new Uint8Array(PNG) }
    ];
    const read = await readStoredZip(buildStoredZip(entries));
    expect([...read.keys()]).toEqual(["export.json", "assets/one.png"]);
    expect(new TextDecoder().decode(read.get("export.json"))).toBe('{"a":1}');
    expect(read.get("assets/one.png")).toEqual(new Uint8Array(PNG));
  });

  it("keeps a zero-byte entry, which an empty file is", async () => {
    const read = await readStoredZip(buildStoredZip([{ path: "assets/empty.png", bytes: new Uint8Array(0) }]));
    expect(read.get("assets/empty.png")).toEqual(new Uint8Array(0));
  });

  it("refuses an archive with no directory rather than returning nothing", async () => {
    const broken = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
    await expect(readStoredZip(new Blob([broken as BlobPart]))).rejects.toThrow(FigmaBundleError);
  });

  it("catches a truncated download by its CRC, which is what a half-written file is", async () => {
    const archive = new Uint8Array(await buildStoredZip([{ path: "assets/one.png", bytes: new Uint8Array(PNG) }]).arrayBuffer());
    // Flip a byte inside the payload — a network that dropped a packet changes
    // the data, it does not change the length, so a size check would pass this.
    const at = archive.indexOf(0x89, 40);
    archive[at] = archive[at] ^ 0xff;
    await expect(readStoredZip(new Blob([archive as BlobPart]))).rejects.toThrow(/damaged/);
  });

  it("refuses a compressed archive in words, because ours are the only STORED ones it will ever meet", async () => {
    const archive = new Uint8Array(await buildStoredZip([{ path: "export.json", bytes: new TextEncoder().encode("{}") }]).arrayBuffer());
    const view = new DataView(archive.buffer);
    const count = view.getUint16(archive.length - 12, true);
    let at = view.getUint32(archive.length - 6, true);
    view.setUint16(at + 10, 8, true); // method 8 = DEFLATE
    expect(count).toBeGreaterThan(0);
    await expect(readStoredZip(new Blob([archive as BlobPart]))).rejects.toThrow(/compressed/);
  });

  it("tells a zip from a JSON by its first four bytes, not by its name", () => {
    expect(looksLikeZip(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0]))).toBe(true);
    expect(looksLikeZip(new TextEncoder().encode('{"format"'))).toBe(false);
  });
});

describe("the plugin's archive, read by the app", () => {
  const plugin = loadPluginBundle();
  const refs = ["edce0ff8101985c", "b1bc42cf39417ed0"];

  it("produces something the app's reader can open", async () => {
    const imageBytes: Record<string, Uint8Array> = {};
    for (const ref of refs) imageBytes[ref] = new Uint8Array(PNG);

    const envelope = envelopeWith(Object.fromEntries(refs.map((r) => [r, "data:image/png;base64,x"])));
    const archive = plugin.buildBundle(envelope, imageBytes);

    expect(looksLikeZip(archive)).toBe(true);
    const bundle = await readFigmaBundle(new Blob([archive as BlobPart]));
    // Spread, not `Object.keys` — a Map has no own enumerable properties, so the
    // other spelling asserts `[] === [refs]` and fails for a reason that has
    // nothing to do with the bundle.
    expect([...bundle.images.keys()]).toEqual(refs);
    expect(bundle.missing).toEqual([]);
    expect(bundle.images.get(refs[0])?.type).toBe("image/png");
  });

  it("carries the manifest under the name the app looks for", async () => {
    const archive = plugin.buildBundle(envelopeWith({}), {});
    const entries = await readStoredZip(new Blob([archive as BlobPart]));
    expect([...entries.keys()]).toEqual([FISH_BUNDLE_MANIFEST]);
  });

  it("rewrites each image value into the path its bytes sit at", async () => {
    // The single substitution that makes one envelope serve two packagings: an
    // image value stops being a data URI and becomes a locator in the folder. If
    // it stayed a data URI the app would look for an entry named `data:image/...`
    // and find nothing, which is a file that imports with every photo missing and
    // nothing in the report to explain it.
    const archive = plugin.buildBundle(envelopeWith({ abc123: "data:image/png;base64,x" }), {
      abc123: new Uint8Array(PNG)
    });
    const bundle = await readFigmaBundle(new Blob([archive as BlobPart]));
    const manifest = bundle.manifest as { images: Record<string, string> };
    expect(manifest.images.abc123).toMatch(/^assets\/abc123\.png$/);
  });

  it("files a JPEG under .jpg, decided by its magic bytes rather than assumed", async () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
    expect(plugin.assetPath("abc", jpeg)).toBe("assets/abc.jpg");
    expect(plugin.assetPath("abc", new Uint8Array([0x47, 0x49, 0x46, 0x38]))).toBe("assets/abc.gif");
    expect(plugin.assetPath("abc", new Uint8Array(PNG))).toBe("assets/abc.png");
  });

  it("unpacks to bytes the app's envelope reader takes UNCHANGED", async () => {
    // One envelope, two packagings: the reader cannot tell which it was handed,
    // and that is the property that keeps there from being two importers.
    const archive = plugin.buildBundle(
      {
        format: "fish.figma.export",
        version: 1,
        document: {
          id: "0:0",
          name: "Deck",
          type: "DOCUMENT",
          children: [{ id: "0:1", name: "Deck", type: "CANVAS", children: [] }]
        },
        images: {},
        unreadable: {}
      },
      {}
    );
    const bundle = await readFigmaBundle(new Blob([archive as BlobPart]));
    expect(() => parseFigmaExport(bundle.manifest)).not.toThrow();
  });

  it("names a ref the manifest promised but the archive does not carry", async () => {
    // A truncated or hand-edited bundle must not import with a silent blank
    // rectangle: the gap is counted and rides out in the toast.
    const archive = plugin.buildBundle(envelopeWith({ present: "x", absent: "y" }), {
      present: new Uint8Array(PNG)
    });
    const bundle = await readFigmaBundle(new Blob([archive as BlobPart]));
    expect(bundle.missing).toEqual(["absent"]);
    expect([...bundle.images.keys()]).toEqual(["present"]);
  });

  it("opens the checked-in fixture the e2e import spec drops", async () => {
    // The fixture is generated by `scripts/make-figma-bundle-fixture.ts` with the
    // app's own writer, and nothing else keeps it honest. A stale one would make
    // the e2e assert against a document the reader can no longer produce, and the
    // e2e would fail for a reason that has nothing to do with what it is testing.
    const fixture = path.join(ROOT, "scripts/fixtures/figma-bundle-sample.zip");
    expect(fs.existsSync(fixture), "run scripts/make-figma-bundle-fixture.ts").toBe(true);
    const bundle = await readFigmaBundle(new Blob([new Uint8Array(fs.readFileSync(fixture)) as BlobPart]));
    expect(bundle.missing).toEqual([]);
    expect(bundle.images.size).toBeGreaterThan(0);
    expect(() => parseFigmaExport(bundle.manifest)).not.toThrow();
  });

  it("refuses an archive that is not a FISH export", async () => {
    const archive = plugin.buildStoredZip([{ path: "readme.txt", bytes: new TextEncoder().encode("hi") }]);
    await expect(readFigmaBundle(new Blob([archive as BlobPart]))).rejects.toThrow(/export\.json/);
  });
});
