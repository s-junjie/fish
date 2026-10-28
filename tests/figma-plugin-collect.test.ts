/**
 * The plugin's shim, field by field.
 *
 * The whole reason a plugin exists instead of a second importer is that there is
 * exactly one answer to "what does this Figma node become", so every one of these
 * is a statement about the transport: this key is renamed, this unit is split,
 * this value is dropped because the API cannot read it. A test here is a test of
 * `collect.js` ALONE — nothing here may encode what a node means, or it would be
 * the second mapping this line exists to prevent.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildPlugin, buildUi, generatedPlugin, generatedUi, loadCollect, loadPluginSource, PLUGIN_DIR, pluginBundle } from "./helpers/figma-plugin-runtime";
import { MIXED, toPluginNode } from "./helpers/figma-plugin-nodes";

const collect = loadCollect();

interface BundleApi {
  POST_CHUNK: number;
  COPY_TEXT_LIMIT: number;
  postArchive(post: (m: Record<string, unknown>) => void, archive: Uint8Array, images: number, from?: number, chunkSize?: number, doneType?: string): void;
  buildCopyText(envelope: Record<string, unknown>, imageBytes: Record<string, Uint8Array>): string;
  createArchiveReceiver(post: (m: Record<string, unknown>) => void): {
    chunk(msg: Record<string, unknown>): void;
    exported(msg: Record<string, unknown>): Uint8Array[] | null;
    received(): { bytes: number; total: number; parts: number };
    reset(): void;
  };
}

describe("the shipped plugin", () => {
  it("is the two sources concatenated, so it cannot become a third copy of anything", () => {
    expect(generatedPlugin()).toBe(buildPlugin());
  });

  it("is a classic script, because Figma's sandbox has no module loader", () => {
    for (const { name, body } of pluginBundle()) {
      expect(body, `${name} must not use ESM syntax`).not.toMatch(/^\s*(import|export)\s/m);
    }
  });

  it("sends the archive as base64 STRINGS, because postMessage is not a typed-array channel", () => {
    // The one that cost an export: the archive went over as `archive.subarray(...)`
    // and nothing arrived. A string is what is KNOWN to survive this boundary —
    // the first export that worked moved 99.6MB of base64 across it.
    const bundle = loadPluginSource("bundle.js") as unknown as BundleApi;
    const posted: Record<string, unknown>[] = [];
    const PIECE = 1024;
    const bytes = new Uint8Array(PIECE * 2 + 300);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;

    bundle.postArchive((m) => posted.push(m), bytes, 7, 0, PIECE);

    const chunks = posted.filter((m) => m.type === "archive-chunk");
    expect(posted[0]).toMatchObject({ type: "archive-begin", total: bytes.length });
    expect(chunks).toHaveLength(3);
    expect(posted[posted.length - 1]).toMatchObject({ type: "exported", images: 7, size: bytes.length, parts: 3 });
    for (const chunk of chunks) {
      expect(chunk.bytes, "a typed array does not survive postMessage here").toBeUndefined();
      expect(typeof chunk.chunk).toBe("string");
    }
    expect(chunks.map((c) => c.offset)).toEqual([0, PIECE, PIECE * 2]);
  });

  it("assembles the archive whatever order the pieces arrive in", () => {
    // The first version required each piece to land exactly where the last one
    // ended and said "arrived out of order" on the first real export — a claim
    // about delivery order that nothing had established. Keying by offset makes
    // order irrelevant, and turns a lost piece into a GAP, which is a thing that
    // can be named and asked for again.
    const bundle = loadPluginSource("bundle.js") as unknown as BundleApi;
    const PIECE = 512;
    const archive = new Uint8Array(PIECE * 3 + 200);
    for (let i = 0; i < archive.length; i++) archive[i] = (i * 7) % 253;

    const sent: Record<string, unknown>[] = [];
    bundle.postArchive((m) => sent.push(m), archive, 3, 0, PIECE);
    const pieces = sent.filter((m) => m.type === "archive-chunk");
    const done = sent[sent.length - 1];

    const receiver = bundle.createArchiveReceiver(() => {});
    for (const piece of [...pieces].reverse()) receiver.chunk(piece);
    const assembled = receiver.exported(done);

    expect(assembled, "reversed delivery must still assemble").not.toBeNull();
    const parts = assembled as Uint8Array[];
    expect(parts).toHaveLength(4);
    expect(Buffer.concat(parts.map((b) => Buffer.from(b)))).toEqual(Buffer.from(archive));
  });

  it("asks for a piece that never arrived, and completes when it is sent", () => {
    // Whether Figma drops a large message, reorders two, or does neither is not
    // something the transport should have to know in advance. Asking is cheaper
    // than being wrong, and it turns the failure mode from "silent" into
    // "self-healing".
    const bundle = loadPluginSource("bundle.js") as unknown as BundleApi;
    const PIECE = 512;
    const archive = new Uint8Array(PIECE * 3);
    for (let i = 0; i < archive.length; i++) archive[i] = i % 251;

    const sent: Record<string, unknown>[] = [];
    bundle.postArchive((m) => sent.push(m), archive, 1, 0, PIECE);
    const pieces = sent.filter((m) => m.type === "archive-chunk");
    const done = sent[sent.length - 1];

    // The UI's side and the sandbox's side, wired to each other: a gap asks, and
    // the ask is answered by re-running the sender from that offset.
    const asked: Array<{ type: string; from?: number }> = [];
    const receiver = bundle.createArchiveReceiver((m) => asked.push(m as { type: string; from?: number }));
    for (const piece of pieces) if (piece.offset !== PIECE) receiver.chunk(piece);

    expect(receiver.exported(done), "a missing middle piece must not assemble").toBeNull();
    expect(asked).toContainEqual({ type: "archive-need", from: PIECE });

    bundle.postArchive((m) => receiver.chunk(m), archive, 1, PIECE, PIECE);
    const assembled = receiver.exported(done) as Uint8Array[] | null;
    expect(assembled).not.toBeNull();
    expect(assembled).toHaveLength(3);
    expect(Buffer.concat((assembled as Uint8Array[]).map((b) => Buffer.from(b)))).toEqual(Buffer.from(archive));
  });

  it("does not ask twice for the same gap, which would be a storm of requests", () => {
    const bundle = loadPluginSource("bundle.js") as unknown as BundleApi;
    const PIECE = 512;
    const archive = new Uint8Array(PIECE * 2);
    const sent: Record<string, unknown>[] = [];
    bundle.postArchive((m) => sent.push(m), archive, 0, 0, PIECE);
    const done = sent[sent.length - 1];

    const asked: unknown[] = [];
    const receiver = bundle.createArchiveReceiver((m) => asked.push(m));
    receiver.chunk({ type: "archive-chunk", offset: PIECE, total: archive.length, chunk: sent[1].chunk });
    expect(receiver.exported(done)).toBeNull();
    expect(receiver.exported(done)).toBeNull();
    expect(receiver.exported(done)).toBeNull();
    expect(asked).toEqual([{ type: "archive-need", from: 0 }]);
  });

  it("closes the transfer with the message the caller named, so one transport serves two packagings", () => {
    // The file downloads on "exported" and the clipboard decodes text on
    // "copied". A final message that answered to both would be both.
    const bundle = loadPluginSource("bundle.js") as unknown as BundleApi;
    const sent: Record<string, unknown>[] = [];
    bundle.postArchive((m) => sent.push(m), new Uint8Array(16), 3, 0, 512, "copied");
    expect(sent[sent.length - 1]).toMatchObject({ type: "copied", images: 3, size: 16 });
  });

  it("inlines each image as a data URI for the clipboard, and drops the ones with no bytes", () => {
    const bundle = loadPluginSource("bundle.js") as unknown as BundleApi;
    const envelope: Record<string, unknown> = { images: { png: "pending", jpg: "pending", gone: "pending" } };
    const text = bundle.buildCopyText(envelope, {
      png: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      jpg: new Uint8Array([0xff, 0xd8, 0xff, 0xd9])
    });
    const out = JSON.parse(text) as { images: Record<string, string> };
    expect(out.images.png).toMatch(/^data:image\/png;base64,/);
    expect(out.images.jpg).toMatch(/^data:image\/jpeg;base64,/);
    // A ref with no bytes is dropped rather than left as a locator that points
    // nowhere: the app reports an unresolved image for it either way, and
    // "pending" is a word only this file knows.
    expect(out.images.gone).toBeUndefined();
  });

  it("uses no global Figma's sandbox does not have", () => {
    // The one that bit: `bundle.js` reached for `TextEncoder`, which the sandbox
    // does not provide. Every test here passed — because the `vm` context DID
    // provide it, so the plugin was being tested somewhere more capable than
    // Figma, and the failure landed on the designer's machine at export time
    // instead of in this suite.
    //
    // So the list is the sandbox's real one, and anything outside it is an error
    // here rather than there. Comments and string literals are stripped first,
    // since this file NAMES several of these in prose.
    // `btoa` / `atob` are DELIBERATELY absent from this list. They are in the
    // sandbox — the first export that worked moved 99.6MB of base64 across this
    // boundary — and banning a global that is genuinely there would block working
    // code on the strength of a guess. The other fourteen are measured absences:
    // `TextEncoder` is the one that actually bit.
    const BANNED = [
      "TextEncoder",
      "TextDecoder",
      "Blob",
      "File",
      "FileReader",
      "fetch",
      "XMLHttpRequest",
      "document",
      "window",
      "localStorage",
      "Image",
      "OffscreenCanvas",
      "URL",
      "crypto"
    ];
    for (const { name, body } of pluginBundle()) {
      const code = body
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .replace(/^\s*\/\/.*$/gm, " ");
      for (const global of BANNED) {
        // Neither a property nor a key: `envelope.document` and `document:` are
        // the export envelope's own shape, not the DOM. A rule that flagged those
        // is a rule nobody keeps.
        const used = new RegExp(`(?<![\\w$.])\\b${global}\\b(?![\\w$]*\\s*:)`).test(code);
        expect(used, `${name} uses ${global}, which the sandbox lacks`).toBe(false);
      }
    }
  });

  it("ships a ui.html that is the template with the transport inlined, so the two halves cannot drift", () => {
    // Figma gives the sandbox and the iframe no way to see each other's code, and
    // every version of this transport written as two files had a bug in one half
    // the other could not have caught. So `ui.html` is GENERATED from
    // `ui.src.html` + `bundle.js` — the same file the sandbox runs — and this is
    // what stops the generated copy going stale.
    expect(generatedUi()).toBe(buildUi());
    const html = generatedUi();
    expect(html).toContain("createArchiveReceiver");
    expect(html).not.toContain("@@FISH_BUNDLE@@");
  });

  it("ships a manifest that asks for no network and runs as a dynamic-page plugin", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, "manifest.json"), "utf8"));
    expect(manifest.documentAccess).toBe("dynamic-page");
    expect(manifest.networkAccess.allowedDomains).toEqual(["none"]);
    expect(manifest.main).toBe("plugin.js");
    expect(manifest.ui).toBe("ui.html");
  });
});

describe("collectNode — geometry", () => {
  it("carries a slide's transition VERBATIM, because only this door can read one", () => {
    // It lives on a METHOD (`getSlideTransition`) that exists on a SLIDE and
    // nowhere else, so a plugin that never asks loses every transition in every
    // deck — and REST, which the app's mapper is otherwise written against, has no
    // spelling to rename it into. So Figma's own field names cross as they are and
    // `figma-slide.ts` gives them their meaning.
    const transition = {
      style: "PUSH_FROM_LEFT",
      duration: 0.5,
      curve: "EASE_OUT",
      timing: { type: "ON_CLICK", delay: 0 }
    };
    const slide = (t: unknown, withMethod = true) => {
      const node: Any = {
        id: "1:2",
        type: "SLIDE",
        width: 1920,
        height: 1080,
        absoluteBoundingBox: { x: 0, y: 0, width: 1920, height: 1080 },
        fills: []
      };
      if (withMethod) node.getSlideTransition = () => t;
      return node;
    };

    expect(collect.collectNode(slide(transition))?.slideTransition).toEqual(transition);

    // Figma's default says nothing, and a deck that sets no transitions has to
    // keep exporting exactly as it did.
    expect(collect.collectNode(slide({ style: "NONE", duration: 0.3, timing: { type: "ON_CLICK" } }))?.slideTransition).toBeUndefined();
    // …but a timer is not nothing: an auto-advancing slide is worth reporting.
    expect(collect.collectNode(slide({ style: "NONE", timing: { type: "AFTER_DELAY", delay: 5 } }))?.slideTransition).toBeDefined();
    // A node without the method — anything in Figma Design, and every other node
    // type in Slides — must not be asked for one.
    expect(collect.collectNode({ ...slide(transition), type: "FRAME" })?.slideTransition).toBeUndefined();
  });

  it("survives a transition the API refuses to hand over", () => {
    const node: Any = {
      id: "1:2",
      type: "SLIDE",
      width: 1920,
      height: 1080,
      absoluteBoundingBox: { x: 0, y: 0, width: 1920, height: 1080 },
      fills: [],
      getSlideTransition: () => {
        throw new Error("detached node");
      }
    };
    expect(collect.collectNode(node)?.slideTransition).toBeUndefined();
  });

  it("renames `data` to `path`, which is the rename that silently empties every vector", () => {
    const out = collect.collectNode({
      id: "1:2",
      type: "VECTOR",
      width: 16,
      height: 12,
      absoluteBoundingBox: { x: 4, y: 6, width: 16, height: 12 },
      fillGeometry: [{ data: "M0 0 L16 0 L16 12 Z", windingRule: "EVENODD" }]
    });
    expect(out?.fillGeometry).toEqual([{ path: "M0 0 L16 0 L16 12 Z", windingRule: "EVENODD" }]);
  });

  it("carries `width`/`height` as `size`, which is what a rotated leaf is drawn from", () => {
    const out = collect.collectNode({
      id: "1:2",
      type: "VECTOR",
      width: 50,
      height: 50,
      absoluteBoundingBox: { x: 100, y: 100, width: 70.71, height: 70.71 },
      rotation: 45
    });
    expect(out?.size).toEqual({ x: 50, y: 50 });
    expect(out?.absoluteBoundingBox).toEqual({ x: 100, y: 100, width: 70.71, height: 70.71 });
    expect(out?.rotation).toBe(45);
  });

  it("leaves rotation in DEGREES, which is the unit both APIs use", () => {
    const out = collect.collectNode({
      id: "1:2",
      type: "RECTANGLE",
      width: 10,
      height: 10,
      absoluteBoundingBox: { x: 0, y: 0, width: 10, height: 10 },
      rotation: -30
    });
    expect(out?.rotation).toBe(-30);
  });

  it("omits the box entirely when there is none, rather than inventing a zero one", () => {
    const out = collect.collectNode({ id: "1:2", type: "RECTANGLE", width: 0, height: 0, absoluteBoundingBox: null });
    expect(out).not.toBeNull();
    expect(out?.absoluteBoundingBox).toBeUndefined();
    expect(out?.size).toBeUndefined();
  });
});

describe("collectNode — paint", () => {
  it("renames `imageHash` to `imageRef`, the key the asset store looks up", () => {
    const out = collect.collectNode({
      id: "1:2",
      type: "RECTANGLE",
      width: 4,
      height: 4,
      absoluteBoundingBox: { x: 0, y: 0, width: 4, height: 4 },
      fills: [{ type: "IMAGE", imageHash: "abc123", scaleMode: "FIT" }]
    });
    expect(out?.fills).toEqual([{ type: "IMAGE", imageRef: "abc123", scaleMode: "FIT" }]);
  });

  it("drops an image paint with no hash, which the app would resolve to nothing", () => {
    const paint = collect.collectPaint({ type: "IMAGE", imageHash: null, scaleMode: "FILL" });
    expect(paint).toBeNull();
  });

  it("keeps an image's `rotation`, the FILL/FIT spelling of turning the bitmap", () => {
    // `imageTransform` is CROP-only, so `rotation` is the only field a FILL or FIT
    // bitmap's own turn survives in. Dropping it handed the app a bitmap square to
    // its box, which reads as the photograph being a quarter turn out.
    const paint = collect.collectPaint({ type: "IMAGE", imageHash: "abc123", scaleMode: "FILL", rotation: 90 });
    expect(paint).toEqual({ type: "IMAGE", imageRef: "abc123", scaleMode: "FILL", rotation: 90 });
  });

  it("carries a video fill WHOLE, because the hash is all the API will ever say", () => {
    // There is no `getVideoByHash` — a clip's bytes are readable only by handing
    // them TO Figma — so nothing here can fetch the video. What it can do is not
    // throw away what it read: the paint crosses like an image's does, and the
    // app names the clip it lost instead of reporting a layershort it cannot
    // account for.
    const paint = collect.collectPaint({
      type: "VIDEO",
      videoHash: "vid123",
      scaleMode: "FILL",
      rotation: 90,
      filters: { exposure: 0.2 }
    });
    expect(paint).toEqual({
      type: "VIDEO",
      videoRef: "vid123",
      scaleMode: "FILL",
      rotation: 90,
      filters: { exposure: 0.2 }
    });
  });

  it("keeps a video fill that names no clip, unlike an image", () => {
    // A null `imageHash` is "nothing to draw", so an IMAGE paint with one is
    // dropped. A video fill is still a clip-shaped layer even unnamed, and
    // dropping it here would hide the layer from the report entirely.
    expect(collect.collectPaint({ type: "VIDEO", videoHash: null, scaleMode: "FILL" })).toEqual({
      type: "VIDEO",
      scaleMode: "FILL"
    });
  });

  it("passes a gradient's transform through untouched, because the angle is computed app-side", () => {
    const out = collect.collectNode({
      id: "1:2",
      type: "RECTANGLE",
      width: 4,
      height: 4,
      absoluteBoundingBox: { x: 0, y: 0, width: 4, height: 4 },
      fills: [
        {
          type: "GRADIENT_LINEAR",
          gradientTransform: [
            [0, 1, 0],
            [-1, 0, 1]
          ],
          gradientStops: [
            { position: 0, color: { r: 0, g: 0, b: 0, a: 1 } },
            { position: 1, color: { r: 1, g: 1, b: 1, a: 1 } }
          ]
        }
      ]
    });
    // A shim that "normalised" the matrix here would rotate every gradient in the
    // file, and only the app's own angle mapping could tell.
    expect((out?.fills as Any[])[0].gradientTransform).toEqual([
      [0, 1, 0],
      [-1, 0, 1]
    ]);
  });

  it("drops `figma.mixed` rather than stringifying it into a paint with no colour", () => {
    expect(collect.collectPaint({ type: "SOLID", color: MIXED })).toEqual({ type: "SOLID" });
    expect(collect.collectPaint(MIXED)).toBeNull();
  });

  it("carries a shadow's spread, which the app folds into the offset rather than dropping", () => {
    const out = collect.collectNode({
      id: "1:2",
      type: "FRAME",
      width: 10,
      height: 10,
      absoluteBoundingBox: { x: 0, y: 0, width: 10, height: 10 },
      effects: [{ type: "DROP_SHADOW", color: { r: 0, g: 0, b: 0, a: 0.2 }, offset: { x: 0, y: 2 }, radius: 4, spread: 1, visible: true }]
    });
    expect((out?.effects as Any[])[0]).toMatchObject({ type: "DROP_SHADOW", radius: 4, spread: 1, offset: { x: 0, y: 2 } });
  });
});

describe("collectNode — strokes", () => {
  it("suppresses four equal stroke weights, which is the case REST never sends", () => {
    // Every uniform border reaches the plugin as four numbers. Passing them on
    // would put every ordinary box on the app's mixed-weight stroke path.
    expect(collect.collectIndividualStrokeWeights({ strokeTopWeight: 1, strokeRightWeight: 1, strokeBottomWeight: 1, strokeLeftWeight: 1 })).toBeUndefined();
    expect(collect.collectIndividualStrokeWeights({ strokeTopWeight: 4, strokeRightWeight: 1, strokeBottomWeight: 1, strokeLeftWeight: 1 })).toEqual({
      top: 4,
      right: 1,
      bottom: 1,
      left: 1
    });
  });

  it("reports nothing at all for a node with no per-side weights", () => {
    expect(collect.collectIndividualStrokeWeights({ strokeWeight: 2 })).toBeUndefined();
  });
});

describe("collectNode — text", () => {
  it("splits `{unit, value}` line height into the two flat fields the app reads", () => {
    expect(collect.collectLineHeight({ lineHeight: { unit: "PIXELS", value: 16.4 } })).toEqual({ lineHeightPx: 16.4 });
    expect(collect.collectLineHeight({ lineHeight: { unit: "PERCENT", value: 150 } })).toEqual({ lineHeightPercent: 150 });
    expect(collect.collectLineHeight({ lineHeight: MIXED })).toEqual({});
  });

  it("resolves percentage letter spacing against the font size, which REST stores in px", () => {
    expect(collect.collectLetterSpacing({ letterSpacing: { unit: "PERCENT", value: 50 }, fontSize: 13 })).toBe(6.5);
    expect(collect.collectLetterSpacing({ letterSpacing: { unit: "PIXELS", value: 1.2 } })).toBe(1.2);
    expect(collect.collectLetterSpacing({ letterSpacing: { unit: "PERCENT", value: 50 } })).toBeUndefined();
  });

  it("reads the weight from the numeric field and the slant from the font name", () => {
    const style = collect.collectTypeStyle({
      fontName: { family: "Inter", style: "Semi Bold Italic" },
      fontWeight: 600,
      fontSize: 13
    });
    expect(style).toMatchObject({ fontFamily: "Inter", fontWeight: 600, italic: true, fontSize: 13 });
  });

  it("expands runs into one override entry PER CHARACTER, which is what REST stores", () => {
    // "ab" bold, "cd" regular. REST's array is indexed by character; run indexes
    // would put the second run's style on the wrong characters entirely.
    const overrides = collect.collectTextOverrides(
      {
        characters: "abcd",
        getStyledTextSegments: () => [
          { characters: "ab", start: 0, end: 2, fontName: { family: "Inter", style: "Bold" }, fontWeight: 700, fontSize: 13 },
          { characters: "cd", start: 2, end: 4, fontName: { family: "Inter", style: "Regular" }, fontWeight: 400, fontSize: 13 }
        ]
      },
      { fontFamily: "Inter", fontWeight: 400, fontSize: 13 }
    );
    expect(overrides.characterStyleOverrides).toEqual([1, 1, 0, 0]);
    expect(Object.keys(overrides.styleOverrideTable as object)).toEqual(["1"]);
  });

  it("reports nothing when every run already matches the node's own style", () => {
    const nodeStyle = { fontFamily: "Inter", fontWeight: 700, fontSize: 13 };
    const overrides = collect.collectTextOverrides(
      {
        characters: "ab",
        getStyledTextSegments: () => [
          { characters: "a", start: 0, end: 1, fontName: { family: "Inter", style: "Bold" }, fontWeight: 700, fontSize: 13 },
          { characters: "b", start: 1, end: 2, fontName: { family: "Inter", style: "Bold" }, fontWeight: 700, fontSize: 13 }
        ]
      },
      nodeStyle
    );
    expect(overrides).toEqual({});
  });

  it("survives a node that has no segment reader at all", () => {
    expect(collect.collectTextOverrides({ characters: "abc" }, {})).toEqual({});
  });
});

describe("collectNode — layout", () => {
  it("passes auto-layout through field for field and drops NONE", () => {
    const out = collect.collectNode({
      id: "1:2",
      type: "FRAME",
      width: 100,
      height: 100,
      absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 100 },
      layoutMode: "VERTICAL",
      itemSpacing: 8,
      counterAxisSpacing: 24,
      paddingTop: 1,
      paddingRight: 2,
      paddingBottom: 3,
      paddingLeft: 4,
      primaryAxisAlignItems: "SPACE_BETWEEN",
      counterAxisAlignItems: "CENTER",
      layoutWrap: "WRAP"
    });
    expect(out).toMatchObject({
      layoutMode: "VERTICAL",
      itemSpacing: 8,
      counterAxisSpacing: 24,
      paddingTop: 1,
      paddingRight: 2,
      paddingBottom: 3,
      paddingLeft: 4,
      primaryAxisAlignItems: "SPACE_BETWEEN",
      counterAxisAlignItems: "CENTER",
      layoutWrap: "WRAP"
    });
  });

  it("keeps GRID, so the app can name it rather than map it onto flex", () => {
    const out = collect.collectNode({
      id: "1:2",
      type: "FRAME",
      width: 10,
      height: 10,
      absoluteBoundingBox: { x: 0, y: 0, width: 10, height: 10 },
      layoutMode: "GRID"
    });
    expect(out?.layoutMode).toBe("GRID");
  });

  it("omits `INHERIT`, which is a plugin-only alignment with no REST counterpart", () => {
    const out = collect.collectNode({
      id: "1:2",
      type: "FRAME",
      width: 10,
      height: 10,
      absoluteBoundingBox: { x: 0, y: 0, width: 10, height: 10 },
      layoutMode: "HORIZONTAL",
      layoutAlign: "INHERIT"
    });
    expect(out).not.toHaveProperty("layoutAlign");
  });
});

describe("buildExport", () => {
  const frame = (id: string, name: string): Record<string, unknown> => ({
    id,
    name,
    type: "FRAME",
    width: 10,
    height: 10,
    absoluteBoundingBox: { x: 0, y: 0, width: 10, height: 10 }
  });

  it("wraps each page group in its own CANVAS, the way a file response does", () => {
    const envelope = collect.buildExport(
      [
        { id: "0:1", name: "Screens", nodes: [frame("1:1", "A"), frame("1:2", "B")] },
        { id: "0:2", name: "Flows", nodes: [frame("2:1", "C")] }
      ],
      { documentName: "Kit" }
    );
    expect(envelope.format).toBe("fish.figma.export");
    expect(envelope.version).toBe(1);
    const canvases = (envelope.document as Any).children;
    expect(canvases.map((c: Any) => [c.type, c.name, c.children.length])).toEqual([
      ["CANVAS", "Screens", 2],
      ["CANVAS", "Flows", 1]
    ]);
  });

  it("keeps a page that has nothing on it, because Figma has that page too", () => {
    // A whole-file export of a file with one empty page must arrive with one empty
    // page. `buildFigmaPages` states the same reason from the other side: a file
    // with an empty page importing as no page reads as a failure rather than as
    // an empty board.
    const envelope = collect.buildExport(
      [
        { id: "0:1", name: "Screens", nodes: [frame("1:1", "A")] },
        { id: "0:2", name: "Scratch", nodes: [] }
      ],
      {}
    );
    const canvases = (envelope.document as Any).children;
    expect(canvases.map((c: Any) => c.name)).toEqual(["Screens", "Scratch"]);
    expect(canvases[1].children).toEqual([]);
  });

  it("never emits a node without a box, which is what a serialised PageNode looks like", () => {
    // The regression this pins: the page scope handed the plugin's own `PageNode`
    // over as a node, it has no `absoluteBoundingBox`, and the app's `boxOf`
    // dropped it together with all 5323 nodes beneath it. The export parsed
    // cleanly and imported as a document with no layers.
    const envelope = collect.buildExport([{ id: "0:1", name: "Screens", nodes: [frame("1:1", "A")] }], {});
    const walk = (node: Any): void => {
      // Only leaves are required to have a box; the CANVAS itself never has one,
      // which is exactly why a page node cannot stand in for a canvas here.
      if (node.type !== "CANVAS" && node.type !== "DOCUMENT") {
        expect(node.absoluteBoundingBox, `${node.type} ${node.id} has no box`).toBeTruthy();
      }
      for (const child of node.children ?? []) walk(child);
    };
    walk(envelope.document as Any);
  });

  it("takes an instance's master id from the context, because mainComponent cannot be read synchronously", () => {
    const out = collect.collectNode(
      { id: "9:9", type: "INSTANCE", width: 10, height: 10, absoluteBoundingBox: { x: 0, y: 0, width: 10, height: 10 } },
      { componentIds: { "9:9": "4:4" } }
    );
    expect(out?.componentId).toBe("4:4");
    expect(collect.collectNode({ id: "9:9", type: "INSTANCE", width: 1, height: 1, absoluteBoundingBox: { x: 0, y: 0, width: 1, height: 1 } })?.componentId).toBeUndefined();
  });

  it("round-trips a REST node through the plugin shape without losing a field the app reads", () => {
    const rest = {
      id: "1:2",
      name: "Card",
      type: "FRAME",
      clipsContent: true,
      cornerRadius: 12,
      absoluteBoundingBox: { x: 10, y: 20, width: 300, height: 200 },
      size: { x: 300, y: 200 },
      fills: [{ type: "SOLID", color: { r: 1, g: 1, b: 1, a: 1 }, opacity: 0.5, blendMode: "NORMAL" }],
      strokes: [{ type: "SOLID", color: { r: 0, g: 0, b: 0, a: 1 } }],
      strokeWeight: 1,
      individualStrokeWeights: { top: 4, right: 1, bottom: 1, left: 1 },
      strokeAlign: "INSIDE",
      strokeDashes: [4, 2],
      layoutMode: "HORIZONTAL",
      itemSpacing: 8,
      children: [
        {
          id: "1:3",
          type: "VECTOR",
          absoluteBoundingBox: { x: 20, y: 30, width: 16, height: 16 },
          size: { x: 16, y: 16 },
          fillGeometry: [{ path: "M0 0 L16 16 Z", windingRule: "EVENODD" }],
          fills: [{ type: "IMAGE", imageRef: "deadbeef", scaleMode: "FILL" }]
        }
      ]
    };
    const out = collect.collectNode(toPluginNode(rest));
    expect(out).toMatchObject({
      clipsContent: true,
      cornerRadius: 12,
      strokeAlign: "INSIDE",
      strokeDashes: [4, 2],
      layoutMode: "HORIZONTAL",
      itemSpacing: 8,
      individualStrokeWeights: { top: 4, right: 1, bottom: 1, left: 1 }
    });
    expect((out?.children as Any[])[0].fillGeometry).toEqual([{ path: "M0 0 L16 16 Z", windingRule: "EVENODD" }]);
    // `imageTransform` rides along: it IS a CROP's framing, the app reads it, and
    // dropping it here was how every cropped image in every export arrived as a
    // plain cover. REST spells it 3×3 and the plugin 2×3; the mapper reads the
    // first two rows, which is the whole of the matrix on both sides.
    expect((out?.children as Any[])[0].fills).toEqual([
      {
        type: "IMAGE",
        imageRef: "deadbeef",
        scaleMode: "FILL",
        imageTransform: [
          [1, 0, 0],
          [0, 1, 0],
          [0, 0, 1]
        ]
      }
    ]);
  });
});

type Any = Record<string, any>;
