import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { DesignDocument } from "../src/core/dsl/types";
import { getActivePage } from "../src/core/dsl/types";
import { normalizeDesignDocument } from "../src/core/dsl/normalize/document";
import { withActivePageViewport } from "../src/core/interactions/page-ops";
import { MAX_ZOOM } from "../src/core/geometry/viewport";
import { AutosaveController } from "../src/core/persistence/autosave-controller";
import { createRecoveryStore, computeContentHash } from "../src/core/persistence/recovery";
import { createAssetStore } from "../src/core/persistence/assets";
import { MemoryBackend } from "../src/core/persistence/backend";
import { setFileHandle } from "../src/core/data-bridge";
import { stubDocument } from "./helpers/fake-document";

function makeDoc(pages = 1): DesignDocument {
  const canvas = { width: 100, height: 100, unit: "px", background: { type: "solid", color: "#000" } };
  return {
    docId: "fish_test",
    id: "doc_x",
    version: "0.1",
    name: "My Design",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    canvas,
    pages: Array.from({ length: pages }, (_, i) => ({
      id: `page_${i + 1}`,
      name: `Page ${i + 1}`,
      canvas,
      children: [{ id: `r${i + 1}`, type: "rect", x: 0, y: 0, width: 10, height: 10 }]
    })),
    activePageId: "page_1",
    assets: []
  } as unknown as DesignDocument;
}

const camera = { x: 120, y: -40, zoom: 0.35 };

describe("withActivePageViewport", () => {
  it("files the camera under the page the user is on", () => {
    const saved = withActivePageViewport(makeDoc(), camera);
    expect(getActivePage(saved).metadata?.viewport).toEqual(camera);
  });

  it("leaves the other pages' cameras alone", () => {
    const saved = withActivePageViewport(makeDoc(3), camera);
    expect(saved.pages[0].metadata?.viewport).toEqual(camera);
    expect(saved.pages[1].metadata?.viewport).toBeUndefined();
    expect(saved.pages[2].metadata?.viewport).toBeUndefined();
  });

  it("returns the document unchanged rather than one carrying a broken camera", () => {
    // `translate(NaN px)` paints nothing, so a corrupt camera is not a view to
    // restore — and a save must not turn a usable file into one that cannot open.
    const doc = makeDoc();
    expect(withActivePageViewport(doc, { x: Number.NaN, y: 0, zoom: 1 })).toBe(doc);
    expect(withActivePageViewport(doc, { x: 0, y: 0, zoom: Number.POSITIVE_INFINITY })).toBe(doc);
  });

  it("writes a zoom the normalizer will accept rather than one it throws out", () => {
    const saved = withActivePageViewport(makeDoc(), { x: 0, y: 0, zoom: 1000 });
    expect(getActivePage(saved).metadata?.viewport?.zoom).toBe(MAX_ZOOM);
  });

  it("does not touch the document it was given", () => {
    const doc = makeDoc();
    withActivePageViewport(doc, camera);
    expect(doc.pages[0].metadata).toBeUndefined();
  });
});

describe("the camera survives a save", () => {
  it("comes back out of the file a save wrote", () => {
    // The round trip a reopen really is: normalize on the way out, normalize on
    // the way in — the same two steps `toDocumentText` and `loadInitialDocument`.
    const written = normalizeDesignDocument(withActivePageViewport(makeDoc(), camera), {
      preserveUnknown: true
    }).document;
    const reopened = normalizeDesignDocument(JSON.parse(JSON.stringify(written)), {
      preserveUnknown: true
    }).document;
    expect(getActivePage(reopened).metadata?.viewport).toEqual(camera);
    expect(reopened.activePageId).toBe("page_1");
  });
});

describe("computeContentHash", () => {
  it("ignores the camera, so a pan is not an unsaved edit", () => {
    const doc = makeDoc();
    expect(computeContentHash(withActivePageViewport(doc, camera))).toBe(computeContentHash(doc));
  });

  it("still sees a real edit through a moved camera", () => {
    const doc = makeDoc();
    const edited = { ...doc, name: "Renamed" } as DesignDocument;
    expect(computeContentHash(withActivePageViewport(edited, camera))).not.toBe(
      computeContentHash(withActivePageViewport(doc, camera))
    );
  });
});

describe("autosave write-back", () => {
  let captured = "";
  const realDocument = (globalThis as any).document;

  beforeEach(() => {
    captured = "";
    stubDocument();
    setFileHandle({
      name: "my.fish.html",
      queryPermission: async () => "granted",
      requestPermission: async () => "granted",
      getFile: async () => ({ text: async () => "<html>PREVIOUS</html>" }),
      // A Blob is what the writer hands the stream; read it like the file would.
      createWritable: async () => ({
        write: async (data: string | Blob) => {
          captured = typeof data === "string" ? data : await data.text();
        },
        close: async () => undefined
      })
    } as any);
  });

  afterEach(() => {
    (globalThis as any).document = realDocument;
    setFileHandle(null);
  });

  it("stamps the camera into the file but not into the recovery snapshot", async () => {
    const backend = new MemoryBackend();
    const recovery = createRecoveryStore(backend);
    const controller = new AutosaveController({
      getDoc: () => makeDoc(),
      getWritebackDoc: () => withActivePageViewport(makeDoc(), camera),
      subscribe: () => () => undefined,
      recovery,
      assets: createAssetStore(backend),
      fileId: () => "fish_test",
      writebackEnabled: true
    });
    await controller.ready();
    await controller.flushNow();

    const block = /<script id="design-doc"[^>]*>([\s\S]*?)<\/script>/.exec(captured)?.[1] ?? "";
    const inFile = JSON.parse(block.replace(/\\u003c\//g, "</")).pages[0].metadata?.viewport;
    expect(inFile).toEqual(camera);

    // The snapshot answers "has the content changed", and a camera that moved on
    // its own is not that — so it must stay a snapshot of the document alone.
    const snapshot = await recovery.load("fish_test");
    expect((snapshot?.doc as DesignDocument).pages[0].metadata?.viewport).toBeUndefined();
    expect(computeContentHash(snapshot?.doc as DesignDocument)).toBe(computeContentHash(makeDoc()));
  });
});
