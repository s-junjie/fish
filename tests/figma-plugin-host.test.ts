/**
 * The sandbox half, driven the way Figma drives it.
 *
 * `collect.js` and `bundle.js` are pure and tested as such; `host.js` is the half
 * that touches `figma`, and it had no test — which is how `resolveComponentIds`
 * came to call `findAll` on a top-level node with no guard while `countUnder` and
 * `countUnreadable` beside it both had one. `findAll` lives on ChildrenMixin and
 * exists on CONTAINER nodes only, so any canvas with a stray rectangle, text or
 * vector at its top level exported "Current page" and "Whole file" as
 * "nodes[i].findAll is not a function", with the counts beside those options
 * still perfectly correct. This file loads the shipped `plugin.js` under a figma
 * double whose leaves have no `findAll`, exactly as the real API does.
 *
 * The clipboard copy is driven here too, and judged by the APP's own reader: the
 * text the plugin puts on the wire has to parse as the same envelope the picker
 * reads, images inlined, or the paste door is a second importer with a second
 * opinion.
 */

import { describe, expect, it } from "vitest";
import { readFigmaBundle } from "../src/core/import/figma-bundle";
import { parseFigmaExport } from "../src/core/import/figma-export";
import { loadPluginContext } from "./helpers/figma-plugin-runtime";

type Any = Record<string, any>;

/** Every DESCENDANT matching `fn`, the node itself excluded — ChildrenMixin's contract. */
const findAll = function (this: Any, fn: (n: Any) => boolean): Any[] {
  const out: Any[] = [];
  const walk = (n: Any) => {
    for (const child of n.children ?? []) {
      if (fn(child)) out.push(child);
      walk(child);
    }
  };
  walk(this);
  return out;
};

/** A container node: the only kind that carries `findAll`. */
function container(id: string, name: string, children: Any[] = []): Any {
  return {
    id,
    name,
    type: "FRAME",
    visible: true,
    opacity: 1,
    absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 100 },
    width: 100,
    height: 100,
    rotation: 0,
    relativeTransform: [[1, 0, 0], [0, 1, 0]],
    fills: [],
    strokes: [],
    strokeWeight: 1,
    cornerRadius: 0,
    topLeftRadius: 0,
    topRightRadius: 0,
    bottomRightRadius: 0,
    bottomLeftRadius: 0,
    strokeTopWeight: 1,
    strokeRightWeight: 1,
    strokeBottomWeight: 1,
    strokeLeftWeight: 1,
    children,
    findAll
  };
}

/**
 * A leaf node. It has NO `findAll`, because a RectangleNode does not compose
 * ChildrenMixin — modelling that absence is the entire point of this file.
 */
function leaf(id: string, name: string, type = "RECTANGLE"): Any {
  return {
    id,
    name,
    type,
    visible: true,
    opacity: 1,
    absoluteBoundingBox: { x: 0, y: 0, width: 40, height: 40 },
    width: 40,
    height: 40,
    rotation: 0,
    relativeTransform: [[1, 0, 0], [0, 1, 0]],
    fills: [{ type: "SOLID", color: { r: 1, g: 0, b: 0, a: 1 }, visible: true }],
    strokes: [],
    strokeWeight: 1,
    cornerRadius: 0,
    topLeftRadius: 0,
    topRightRadius: 0,
    bottomRightRadius: 0,
    bottomLeftRadius: 0,
    strokeTopWeight: 1,
    strokeRightWeight: 1,
    strokeBottomWeight: 1,
    strokeLeftWeight: 1,
    children: undefined
  };
}

function instance(id: string): Any {
  return {
    ...container(id, "Button", [leaf(`${id}-label`, "Label", "TEXT")]),
    type: "INSTANCE",
    getMainComponentAsync: async () => ({ id: `${id}-master` })
  };
}

/**
 * A frame filled with a photograph: the image the two packagings carry
 * differently — `assets/` bytes in the zip, a data URI on the clipboard.
 */
const PHOTO_HASH = "abc123photo";
const PHOTO_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 8, 7, 6]);

function photoFrame(id: string): Any {
  return {
    ...container(id, "Photo", []),
    fills: [{ type: "IMAGE", imageHash: PHOTO_HASH, scaleMode: "FILL" }]
  };
}

/** What `exportAsync` hands back for a clip's poster: PNG magic, then pixels. */
const POSTER_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

/**
 * A lone rectangle with a video fill — the shape dragging a clip into Figma
 * makes, and the one that carries no `findAll`.
 *
 * `exportAsync` is on the node because that is how a poster is taken, and it is
 * the ONLY thing the plugin can do with a clip: there is no `getVideoByHash`.
 */
function videoClip(id: string, opts: { poster?: boolean; videoHash?: string } = {}): Any {
  const node: Any = { ...leaf(id, "Clip"), fills: [{ type: "VIDEO", videoHash: opts.videoHash ?? "vid123", scaleMode: "FILL" }] };
  if (opts.poster !== false) node.exportAsync = async (settings: Any) => (settings?.format === "PNG" ? POSTER_BYTES : null);
  return node;
}

function page(id: string, name: string, children: Any[], selection: Any[] = []): Any {
  return {
    id,
    name,
    type: "PAGE",
    children,
    selection,
    backgrounds: [],
    findAll
  };
}

/** Load the shipped plugin under a figma double; return what the UI would receive. */
function loadHost(pages: Any[]): {
  posted: Any[];
  ui: { onmessage: (m: Any) => Promise<void> };
  sandbox: Record<string, unknown>;
} {
  const posted: Any[] = [];
  const ui = { onmessage: async (_m: Any) => {}, postMessage: (m: Any) => { if (m !== undefined) posted.push(m); } };
  const figma: Any = {
    apiVersion: "1.0.0",
    editorType: "figma",
    mixed: Symbol("figma.mixed"),
    root: { id: "0:0", name: "Mock file", type: "DOCUMENT", children: pages },
    currentPage: pages[0],
    loadAllPagesAsync: async () => {},
    getImageByHash: (hash: string) =>
      hash === PHOTO_HASH ? { getBytesAsync: async () => PHOTO_BYTES } : null,
    showUI: () => {},
    ui,
    closePlugin: () => {}
  };
  const { sandbox } = loadPluginContext("plugin.js", { figma, __html__: "<html></html>" });
  return { posted, ui, sandbox };
}

/** A canvas whose top level holds a leaf beside a container — the shape that failed. */
const world = () => [
  page("0:1", "Screens", [container("0:10", "Card", [instance("0:11")]), leaf("0:12", "Stray rect"), photoFrame("0:13")], [leaf("0:12", "Stray rect")]),
  page("0:2", "Archive", [leaf("0:20", "Loose label", "TEXT")])
];

const exportScope = async (pages: Any[], scope: string, images = false) => {
  const { posted, ui } = loadHost(pages);
  await Promise.resolve();
  await Promise.resolve();
  await ui.onmessage({ type: "export", scope, images });
  await Promise.resolve();
  await Promise.resolve();
  return posted;
};

const copyScope = async (pages: Any[], scope: string, images = true) => {
  const { posted, ui } = loadHost(pages);
  await ui.onmessage({ type: "copy", scope, images });
  return posted;
};

/** The archive the UI half would assemble, from the chunks the sandbox posted. */
function archiveBytes(posted: Any[]): Uint8Array {
  const chunks = (posted.filter((m) => m.type === "archive-chunk") as Any[]).sort((a, b) => a.offset - b.offset);
  const parts = chunks.map((c) => Uint8Array.from(atob(c.chunk), (ch) => ch.charCodeAt(0)));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** The text the UI half decodes off the transport — what the clipboard would get. */
const copyText = (posted: Any[]): string => new TextDecoder().decode(archiveBytes(posted));

const copiedEnvelope = (posted: Any[]): Any => JSON.parse(copyText(posted));

describe("the sandbox export", () => {
  it("counts every scope before anyone commits to one", async () => {
    const { posted, ui } = loadHost(world());
    await Promise.resolve();
    await Promise.resolve();
    await ui.onmessage({ type: "scopes" });
    await Promise.resolve();
    await Promise.resolve();
    const message = posted.find((m) => m.type === "scopes");
    expect(message?.scopes).toEqual([
      { id: "selection", unit: "layer", count: 1, pages: 1, empty: false },
      { id: "page", unit: "layer", count: 5, pages: 1, empty: false },
      { id: "file", unit: "layer", count: 6, pages: 2, empty: false }
    ]);
  });

  it("exports Current page when a leaf sits at the canvas top level", async () => {
    const posted = await exportScope(world(), "page");
    expect(posted.filter((m) => m.type === "failed").map((m) => m.message)).toEqual([]);
    expect(posted.some((m) => m.type === "exported")).toBe(true);
  });

  it("exports Whole file when a leaf sits at any page's top level", async () => {
    const posted = await exportScope(world(), "file");
    expect(posted.filter((m) => m.type === "failed").map((m) => m.message)).toEqual([]);
    expect(posted.some((m) => m.type === "exported")).toBe(true);
  });

  it("exports a selection that is itself a leaf", async () => {
    const posted = await exportScope(world(), "selection");
    expect(posted.filter((m) => m.type === "failed").map((m) => m.message)).toEqual([]);
    expect(posted.some((m) => m.type === "exported")).toBe(true);
  });

  it("still resolves an instance's master through the container walk", async () => {
    const posted = await exportScope(world(), "page");
    const exported = posted.find((m) => m.type === "exported");
    expect(exported).toBeTruthy();
    const chunks = posted.filter((m) => m.type === "archive-chunk");
    expect(chunks.length).toBeGreaterThan(0);
  });

  it("declares the video fills it cannot read, root rectangle included", async () => {
    // A clip's bytes are unreachable from a plugin (no `getVideoByHash`), so this
    // count is the whole of what the export can say about one — and it has to
    // cover the case a designer actually makes: dragging a video into Figma
    // produces a lone rectangle with a video fill, and a rectangle carries no
    // `findAll`, so a walk that only descends misses exactly the video.
    const clip = videoClip("0:12", { poster: false });
    const posted = await copyScope([page("0:1", "Screens", [clip])], "page", false);

    const parsed = parseFigmaExport(copiedEnvelope(posted));
    expect(parsed.unreadable).toEqual([{ property: "videoBytes", count: 1, value: expect.stringContaining("hash") }]);
  });

  it("ships a poster frame for every clip, under the clip's own ref", async () => {
    // Not the clip, which cannot travel — a still of the layer, which can, and
    // which is what the app paints in the layer's place. It rides the image table
    // because that is the one the app already resolves a picture through.
    const posted = await copyScope([page("0:1", "Screens", [videoClip("0:12")])], "page", true);

    const envelope = copiedEnvelope(posted);
    expect(envelope.images.vid123).toMatch(/^data:image\/png;base64,/);
    const parsed = parseFigmaExport(envelope);
    expect(parsed.imageFills).toMatchObject({ vid123: expect.stringContaining("base64") });
    // The clip still counts as unreadable: what arrived is a frame, not the clip.
    expect(parsed.unreadable).toEqual([{ property: "videoBytes", count: 1, value: expect.any(String) }]);
  });

  it("shares one poster between two layers that use the same clip", async () => {
    let renders = 0;
    const counting = (id: string) => {
      const node = videoClip(id);
      node.exportAsync = async () => {
        renders += 1;
        return POSTER_BYTES;
      };
      return node;
    };
    const posted = await copyScope([page("0:1", "Screens", [counting("0:12"), counting("0:13")])], "page", true);

    expect(renders).toBe(1);
    expect(Object.keys(copiedEnvelope(posted).images)).toEqual(["vid123"]);
  });

  it("keeps the clip's layer when the poster cannot be rendered, rather than failing the export", async () => {
    const clip = videoClip("0:12");
    clip.exportAsync = async () => {
      throw new Error("this node type cannot be exported");
    };
    const posted = await copyScope([page("0:1", "Screens", [clip])], "page", true);

    expect(posted.filter((m) => m.type === "failed")).toEqual([]);
    const envelope = copiedEnvelope(posted);
    expect(envelope.images).toEqual({});
    expect(parseFigmaExport(envelope).unreadable[0]).toMatchObject({ property: "videoBytes", count: 1 });
  });

  it("reports no video count for a file that has none", async () => {
    const parsed = parseFigmaExport(copiedEnvelope(await copyScope(world(), "page", false)));
    expect(parsed.unreadable.map((u) => u.property)).not.toContain("videoBytes");
  });
});

/**
 * The clipboard copy.
 *
 * Everything above drives the FILE door; these drive the copy, and the judge is
 * the app's own reader. A clipboard text `parseFigmaExport` refuses is a paste
 * that arrives as an error, and a copy that walks the document differently from
 * the file is the second mapping this plugin exists to prevent.
 */
describe("the clipboard copy", () => {
  it("puts the single-file envelope on the wire, with the image inlined", async () => {
    const posted = await copyScope(world(), "page");
    const copied = posted.find((m) => m.type === "copied");
    expect(copied).toBeTruthy();

    const envelope = copiedEnvelope(posted);
    const parsed = parseFigmaExport(envelope);
    expect(parsed.document.type).toBe("DOCUMENT");
    expect((parsed.document.children as Any[]).map((c) => c.name)).toEqual(["Screens"]);
    // Inline, as a data URI: the only form a clipboard can carry, and the form
    // the reader has always accepted.
    expect(envelope.images[PHOTO_HASH]).toMatch(/^data:image\/png;base64,/);
  });

  it("carries the same document the file packaging carries, byte for byte", async () => {
    const fromFile = await exportScope(world(), "page", true);
    const fromCopy = await copyScope(world(), "page");

    const bundle = await readFigmaBundle(new Blob([archiveBytes(fromFile) as BlobPart]));
    const copy = copiedEnvelope(fromCopy);

    expect((bundle.manifest as Any).document).toEqual(copy.document);
    expect(bundle.missing).toEqual([]);

    // The same bytes, whichever box they arrived in: the zip carries them as an
    // `assets/` entry, the clipboard as base64 inside the envelope.
    const uri = /^data:image\/png;base64,(.+)$/.exec(copy.images[PHOTO_HASH] as string)?.[1];
    expect(uri).toBeTruthy();
    expect(Uint8Array.from(atob(uri as string), (ch) => ch.charCodeAt(0))).toEqual(PHOTO_BYTES);
    const zipped = bundle.images.get(PHOTO_HASH);
    expect(zipped).toBeTruthy();
    expect(new Uint8Array(await (zipped as Blob).arrayBuffer())).toEqual(PHOTO_BYTES);
  });

  it("travels as base64 strings over the same transport as the file", async () => {
    // One protocol, two endings: the copy is not a second channel, so it pays
    // the same rules — pieces keyed by offset, a final message of its own type.
    const posted = await copyScope(world(), "page");
    const begin = posted.find((m) => m.type === "archive-begin") as Any;
    const chunks = posted.filter((m) => m.type === "archive-chunk");
    const done = posted.find((m) => m.type === "copied");
    expect(begin).toBeTruthy();
    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) expect(typeof chunk.chunk).toBe("string");
    expect(done).toMatchObject({ type: "copied", size: begin.total });
    // Not the file's ending: the UI half downloads on "exported" and decodes
    // text on "copied", and a message that answered to both would be both.
    expect(posted.some((m) => m.type === "exported")).toBe(false);
  });

  it("copies without images when the box is unticked", async () => {
    const posted = await copyScope(world(), "page", false);
    const envelope = copiedEnvelope(posted);
    expect(envelope.images).toEqual({});
    // The paint still names its ref — the app reports an unresolved image for
    // it, which is the honest outcome of a copy made without the bytes.
    const paints = JSON.stringify(envelope.document);
    expect(paints).toContain(PHOTO_HASH);
  });

  it("refuses a copy too big for the clipboard, and says what to do instead", async () => {
    // The limit is a module-level `var` in the shipped script; poking it is how
    // the branch is reached without an 8MB fixture.
    const { posted, ui, sandbox } = loadHost(world());
    sandbox.COPY_TEXT_LIMIT = 10;
    await ui.onmessage({ type: "copy", scope: "page", images: false });

    const refused = posted.find((m) => m.type === "copy-too-big") as Any;
    expect(refused).toBeTruthy();
    expect(refused.limit).toBe(10);
    expect(refused.size).toBeGreaterThan(10);
    // Refused BEFORE anything was sent: a half-posted copy is a clipboard with
    // junk on it.
    expect(posted.some((m) => m.type === "archive-chunk")).toBe(false);
    expect(posted.some((m) => m.type === "copied")).toBe(false);
  });

  it("re-sends a piece of the copy the UI asks for", async () => {
    // The receiver asks AFTER `runCopy` has returned, so the text has to be
    // remembered — this is the ask-and-resend half of the transport's contract,
    // without which a dropped piece is a copy that hangs at "asking again".
    const { posted, ui } = loadHost(world());
    await ui.onmessage({ type: "copy", scope: "page", images: false });
    const before = posted.filter((m) => m.type === "archive-chunk").length;

    await ui.onmessage({ type: "archive-need", from: 0 });

    const after = posted.filter((m) => m.type === "archive-chunk");
    expect(after.length).toBeGreaterThan(before);
    // The re-sent pieces still assemble into the same text.
    expect(copyText(posted)).toContain("fish.figma.export");
  });
});
