import { describe, it, expect } from "vitest";
import { saveInPlace, clearFileHandle, setFileHandle } from "../src/core/data-bridge";
import { saveDocAsNewFile } from "../src/core/persistence/writeback";
import { stubDocument } from "./helpers/fake-document";

// saveInPlace's FSA path needs a browser-ish global surface but not a real DOM.
// Stub just enough so the save resolves through the File System Access branch
// without touching the download branch (which needs document.createElement).
function withFsStubs<T>(fn: () => Promise<T>): Promise<T> {
  const prevDocument = (globalThis as any).document;
  const prevWindow = (globalThis as any).window;
  stubDocument({}, 0, "<html><head></head><body></body></html>");
  (globalThis as any).window = {
    location: {},
    showSaveFilePicker: async () => ({
      name: "out.fish.html",
      createWritable: async () => ({ write() {}, close() {} })
    })
  };
  return fn().finally(() => {
    (globalThis as any).document = prevDocument;
    (globalThis as any).window = prevWindow;
    clearFileHandle();
  });
}

describe("saveInPlace immutability", () => {
  it("does not mutate the live document passed in", async () => {
    await withFsStubs(async () => {
      const doc: any = {
        $schema: "x",
        docId: "d1",
        version: "0.1",
        id: "d1",
        name: "n",
        createdAt: "2020-01-01T00:00:00Z",
        updatedAt: "2020-01-01T00:00:00Z",
        canvas: { width: 100, height: 100 },
        elements: []
      };
      const before = doc.updatedAt;
      const res = await saveInPlace(doc);
      expect(res.success).toBe(true);
      // The input object must stay untouched: undo snapshots reference the same
      // live doc, so an in-place updatedAt write would silently rewrite history.
      expect(doc.updatedAt).toBe(before);
    });
  });

  it("reuses an existing currentFileHandle without calling showSaveFilePicker", async () => {
    await withFsStubs(async () => {
      let pickerCalled = false;
      (globalThis as any).window.showSaveFilePicker = async () => {
        pickerCalled = true;
        return { name: "picker.fish.html", createWritable: async () => ({ write() {}, close() {} }) };
      };

      let written = false;
      const existingHandle = {
        name: "existing.fish.html",
        queryPermission: async () => "granted",
        createWritable: async () => ({
          write() { written = true; },
          close() {}
        })
      };
      setFileHandle(existingHandle);

      const doc: any = {
        docId: "d1",
        version: "0.1",
        id: "d1",
        name: "n",
        createdAt: "2020-01-01T00:00:00Z",
        updatedAt: "2020-01-01T00:00:00Z",
        canvas: { width: 100, height: 100 },
        elements: []
      };

      const res = await saveInPlace(doc);
      expect(res.success).toBe(true);
      expect(res.filename).toBe("existing.fish.html");
      expect(pickerCalled).toBe(false);
      expect(written).toBe(true);
    });
  });

  it("requests permission when existing handle permission is prompt", async () => {
    await withFsStubs(async () => {
      let requested = false;
      let pickerCalled = false;
      (globalThis as any).window.showSaveFilePicker = async () => {
        pickerCalled = true;
        return { name: "picker.fish.html", createWritable: async () => ({ write() {}, close() {} }) };
      };

      const promptHandle = {
        name: "prompt.fish.html",
        queryPermission: async () => "prompt",
        requestPermission: async () => {
          requested = true;
          return "granted";
        },
        createWritable: async () => ({
          write() {},
          close() {}
        })
      };
      setFileHandle(promptHandle);

      const doc: any = {
        docId: "d1",
        version: "0.1",
        id: "d1",
        name: "n",
        createdAt: "2020-01-01T00:00:00Z",
        updatedAt: "2020-01-01T00:00:00Z",
        canvas: { width: 100, height: 100 },
        elements: []
      };

      const res = await saveInPlace(doc);
      expect(res.success).toBe(true);
      expect(requested).toBe(true);
      expect(pickerCalled).toBe(false);
    });
  });

  it("falls back to showSaveFilePicker when existing handle permission is denied", async () => {
    await withFsStubs(async () => {
      let pickerCalled = false;
      (globalThis as any).window.showSaveFilePicker = async () => {
        pickerCalled = true;
        return { name: "fallback.fish.html", createWritable: async () => ({ write() {}, close() {} }) };
      };

      const deniedHandle = {
        name: "denied.fish.html",
        queryPermission: async () => "prompt",
        requestPermission: async () => "denied",
        createWritable: async () => ({ write() {}, close() {} })
      };
      setFileHandle(deniedHandle);

      const doc: any = {
        docId: "d1",
        version: "0.1",
        id: "d1",
        name: "n",
        createdAt: "2020-01-01T00:00:00Z",
        updatedAt: "2020-01-01T00:00:00Z",
        canvas: { width: 100, height: 100 },
        elements: []
      };

      const res = await saveInPlace(doc);
      expect(res.success).toBe(true);
      expect(pickerCalled).toBe(true);
      expect(res.filename).toBe("fallback.fish.html");
    });
  });
});

describe("saveDocAsNewFile context return", () => {
  it("returns handle, name, fileId and payloadHash upon successful save", async () => {
    await withFsStubs(async () => {
      let writtenContent = "";
      const customHandle = {
        name: "saved-as.fish.html",
        createWritable: async () => ({
          async write(data: string) { writtenContent = data; },
          async close() {}
        })
      };
      (globalThis as any).window.showSaveFilePicker = async () => customHandle;

      const doc: any = {
        docId: "doc_original",
        version: "0.1",
        id: "d1",
        name: "My Design",
        createdAt: "2020-01-01T00:00:00Z",
        updatedAt: "2020-01-01T00:00:00Z",
        canvas: { width: 100, height: 100 },
        elements: []
      };

      const res = await saveDocAsNewFile(doc, "saved-as.fish.html", undefined, { freshFileId: true });
      expect(res.ok).toBe(true);
      expect(res.handle).toBe(customHandle);
      expect(res.name).toBe("saved-as.fish.html");
      expect(res.fileId).toBeTruthy();
      expect(res.payloadHash).toBeTruthy();
      expect(writtenContent).toContain(`content="${res.fileId}"`);
    });
  });
});

describe("launchQueue file adoption", () => {
  it("launchQueue setConsumer passes the FileSystemFileHandle", async () => {
    let consumerFn: ((params: any) => Promise<void>) | null = null;
    const fakeLaunchQueue = {
      setConsumer(fn: (params: any) => Promise<void>) {
        consumerFn = fn;
      }
    };

    fakeLaunchQueue.setConsumer(async (params) => {
      const h = params.files[0];
      expect(h.name).toBe("launched.fish.html");
      const file = await h.getFile();
      const text = await file.text();
      expect(text).toContain("fid_123");
    });

    const fakeHandle = {
      name: "launched.fish.html",
      getFile: async () => ({
        text: async () =>
          '<!DOCTYPE html><html><head><meta name="fish:fileId" content="fid_123"><script id="design-doc" type="application/json">{"version":"0.1","docId":"d1","name":"Launched Doc","canvas":{"width":100,"height":100},"elements":[]}</script></head><body></body></html>'
      })
    };

    expect(consumerFn).toBeTruthy();
    await consumerFn!({ files: [fakeHandle] });
  });
});

/**
 * A save-as can land on a file that already exists — the picker suggests the
 * current name, and choosing that same file is how "replace this" is spelled.
 * `createWritable()` truncates it to zero bytes before `write` is called, so
 * without the atomic pair a failed write leaves the user with nothing.
 */
describe("saveDocAsNewFile writes atomically", () => {
  const overwriteDoc = () =>
    ({
      docId: "doc_1",
      version: "0.1",
      id: "d1",
      name: "Overwrite",
      createdAt: "2020-01-01T00:00:00Z",
      updatedAt: "2020-01-01T00:00:00Z",
      canvas: { width: 100, height: 100 },
      elements: []
    }) as any;

  it("keeps existing data and cuts the file to the bytes it wrote", async () => {
    await withFsStubs(async () => {
      const seen: { opts?: unknown; truncatedTo?: number; closed: boolean; aborted: boolean } = {
        closed: false,
        aborted: false
      };
      let written = "";
      (globalThis as any).window.showSaveFilePicker = async () => ({
        name: "overwrite.fish.html",
        createWritable: async (opts?: unknown) => {
          seen.opts = opts;
          return {
            write: async (s: string) => {
              written = s;
            },
            truncate: async (size: number) => {
              seen.truncatedTo = size;
            },
            close: async () => {
              seen.closed = true;
            },
            abort: async () => {
              seen.aborted = true;
            }
          };
        }
      });

      const res = await saveDocAsNewFile(overwriteDoc(), "overwrite.fish.html");
      expect(res.ok).toBe(true);
      expect(seen.opts).toEqual({ keepExistingData: true });
      // Bytes, not characters, and not the file's previous length: the tail of
      // a longer document would otherwise survive the write.
      expect(seen.truncatedTo).toBe(new TextEncoder().encode(written).byteLength);
      expect(seen.closed).toBe(true);
      expect(seen.aborted).toBe(false);
    });
  });

  it("aborts the temp file instead of committing a failed write", async () => {
    await withFsStubs(async () => {
      let aborted = false;
      (globalThis as any).window.showSaveFilePicker = async () => ({
        name: "overwrite.fish.html",
        createWritable: async () => ({
          write: async () => {
            throw new Error("quota exceeded");
          },
          truncate: async () => undefined,
          close: async () => undefined,
          abort: async () => {
            aborted = true;
          }
        })
      });

      const res = await saveDocAsNewFile(overwriteDoc(), "overwrite.fish.html");
      expect(res.ok).toBe(false);
      expect(res.reason).toBe("quota exceeded");
      expect(aborted).toBe(true);
    });
  });
});
