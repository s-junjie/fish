import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { DesignDocument } from "../src/core/dsl/types";
import { setFileHandle } from "../src/core/data-bridge";
import { pickWritebackFile, saveDocAsNewFile } from "../src/core/persistence/writeback";
import { pickDocumentJson, saveDocumentJson } from "../src/core/persistence/json-file";
import { mediaPickerOptions, pickMediaFile } from "../src/ui/toolbar/media-picker";
import { stubDocument } from "./helpers/fake-document";

type PickerOptions = { types?: { accept?: Record<string, string[]> }[]; startIn?: string };

function makeDoc(): DesignDocument {
  return {
    docId: "fish_test",
    id: "doc_x",
    version: "0.1",
    name: "My Design",
    createdAt: "2020-01-01T00:00:00Z",
    updatedAt: "2020-01-01T00:00:00Z",
    canvas: { width: 100, height: 100, unit: "px", background: { type: "solid", color: "#000" } },
    pages: [
      {
        id: "page_1",
        name: "Page 1",
        canvas: { width: 100, height: 100, unit: "px", background: { type: "solid", color: "#000" } },
        children: []
      }
    ],
    activePageId: "page_1",
    assets: []
  } as unknown as DesignDocument;
}

function fakeHandle(name: string): any {
  return {
    name,
    getFile: async () => ({ text: async () => "<html></html>" }),
    createWritable: async () => ({ write: async () => undefined, close: async () => undefined })
  };
}

let globalPicker: unknown;

beforeEach(() => {
  stubDocument();
  globalPicker = (globalThis as { showOpenFilePicker?: unknown }).showOpenFilePicker;
});

afterEach(() => {
  setFileHandle(null);
  (globalThis as { showOpenFilePicker?: unknown }).showOpenFilePicker = globalPicker;
  delete (globalThis as { showSaveFilePicker?: unknown }).showSaveFilePicker;
});

describe("file picker accept lists", () => {
  it("omits `types` when picking a write-back target so macOS NSOpenPanel never greys out the open .fish.html", async () => {
    // Passing `types` makes Chromium's `SelectFileDialogBridge` set
    // `_dialog.allowedFileTypes` on `NSOpenPanel`, which intermittently greys
    // out a `.fish.html` just opened from Finder on first launch while leaving
    // other `.html` files enabled. `verifyPickedFile` already enforces exact
    // identity, so the OS picker must leave `allowedFileTypes = nil`.
    let opts: PickerOptions | undefined;
    (globalThis as any).showOpenFilePicker = async (o: PickerOptions) => {
      opts = o;
      return [fakeHandle("my.fish.html")];
    };
    await pickWritebackFile();
    expect(opts?.types).toBeUndefined();
  });

  it("offers the same single-dot HTML extensions on save-as", async () => {
    let opts: PickerOptions | undefined;
    (globalThis as any).showSaveFilePicker = async (o: PickerOptions) => {
      opts = o;
      return fakeHandle("saved-as.fish.html");
    };
    await saveDocAsNewFile(makeDoc(), "saved-as.fish.html");
    expect(opts?.types?.[0]?.accept).toEqual({ "text/html": [".html", ".htm"] });
  });

  it("offers only `.json` for a document export", async () => {
    let opts: PickerOptions | undefined;
    (globalThis as any).showSaveFilePicker = async (o: PickerOptions) => {
      opts = o;
      return fakeHandle("doc.fish.json");
    };
    await saveDocumentJson(makeDoc());
    expect(opts?.types?.[0]?.accept).toEqual({ "application/json": [".json"] });
  });

  it("opens save-as in the folder of the file it is editing", async () => {
    const handle = fakeHandle("poster.fish.html");
    setFileHandle(handle);
    let opts: PickerOptions | undefined;
    (globalThis as any).showSaveFilePicker = async (o: PickerOptions) => {
      opts = o;
      return fakeHandle("poster-copy.fish.html");
    };
    await saveDocAsNewFile(makeDoc(), "poster-copy.fish.html");
    expect(opts?.startIn).toBe(handle);
  });

  it("uses a well-known folder only when the file sits directly in it", async () => {
    const pickerStart = async (pathname: string) => {
      const previous = (globalThis as any).window;
      (globalThis as any).window = { location: { protocol: "file:", pathname } };
      try {
        let opts: PickerOptions | undefined;
        (globalThis as any).showSaveFilePicker = async (o: PickerOptions) => {
          opts = o;
          return fakeHandle("poster.fish.json");
        };
        await saveDocumentJson(makeDoc());
        return opts?.startIn;
      } finally {
        (globalThis as any).window = previous;
      }
    };
    expect(await pickerStart("/Users/someone/Downloads/poster.fish.html")).toBe("downloads");
    // `~/Documents` is a parent here, not the folder: naming it would open the
    // picker three levels away from the file, which is the bug this replaces.
    expect(await pickerStart("/Users/someone/Documents/repo/demo/poster.fish.html")).toBeUndefined();
  });

  it("offers only `.json` for a document import", async () => {
    let opts: PickerOptions | undefined;
    (globalThis as any).showOpenFilePicker = async (o: PickerOptions) => {
      opts = o;
      return [
        {
          ...fakeHandle("doc.fish.json"),
          getFile: async () => ({ text: async () => JSON.stringify(makeDoc()) })
        }
      ];
    };
    await pickDocumentJson();
    expect(opts?.types?.[0]?.accept).toEqual({ "application/json": [".json"] });
  });

  it("configures descriptive accept options for Figma plugin zip import", () => {
    const opts = mediaPickerOptions("figma-import");
    expect(opts.multiple).toBe(false);
    expect(opts.types[0].description).toMatch(/Figma plugin exported zip file/i);
    expect(opts.types[0].accept).toEqual({
      "application/zip": [".zip"]
    });
  });

  it("configures descriptive accept options for HTML import", () => {
    const opts = mediaPickerOptions("html-import");
    expect(opts.multiple).toBe(false);
    expect(opts.types[0].description).toMatch(/HTML document/i);
    expect(opts.types[0].accept).toEqual({
      "text/html": [".html", ".htm"]
    });
  });

  it("pickMediaFile delegates to showOpenFilePicker and invokes callback with picked file", async () => {
    let capturedOpts: any;
    const testFile = new File(["dummy"], "export.zip", { type: "application/zip" });
    (globalThis as any).showOpenFilePicker = async (o: any) => {
      capturedOpts = o;
      return [{ getFile: async () => testFile }];
    };

    let deliveredFile: File | null = null;
    await pickMediaFile("figma-import", null, (f) => {
      deliveredFile = f;
    });

    expect(capturedOpts?.types?.[0]?.description).toMatch(/Figma plugin/i);
    expect(deliveredFile).toBe(testFile);
  });
});
