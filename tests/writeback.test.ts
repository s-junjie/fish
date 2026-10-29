import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { DesignDocument } from "../src/core/dsl/types";
import { setFileHandle, getFileHandle, payloadHashFromHtml } from "../src/core/data-bridge";
import { stubDocument } from "./helpers/fake-document";
import {
  writeBackFile,
  persistHandle,
  loadHandle,
  pickWritebackFile,
  saveAsCopyName,
  verifyPickedFile,
  verifyRestoredHandle,
  queryWritebackPermission,
  requestWritebackPermission
} from "../src/core/persistence/writeback";

function makeDoc(): DesignDocument {
  return {
    docId: "fish_test",
    id: "doc_x",
    version: "0.1",
    name: "My Design",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    canvas: { width: 100, height: 100, unit: "px", background: { type: "solid", color: "#000" } },
    pages: [
      {
        id: "page_1",
        name: "Page 1",
        canvas: { width: 100, height: 100, unit: "px", background: { type: "solid", color: "#000" } },
        children: [{ id: "r1", type: "rect", x: 0, y: 0, width: 10, height: 10 }]
      }
    ],
    activePageId: "page_1",
    assets: []
  } as unknown as DesignDocument;
}

let captured = "";
let savedDoc = makeDoc();

function fakeHandle(permission: PermissionState): any {
  return {
    name: "my.fish.html",
    queryPermission: async () => permission,
    requestPermission: async () => permission,
    // A real FileSystemFileHandle always has getFile, and the write-back path
    // needs it: it is what takes the pre-write copy. A stub without one models
    // an impossible handle and silently skips the safety net.
    getFile: async () => ({ text: async () => "<html>PREVIOUS CONTENTS</html>" }),
    // A real FileSystemWritableFileStream takes a Blob as readily as a string,
    // and the writer hands it one so the document is not encoded twice.
    createWritable: async () => ({
      write: async (data: string | Blob) => {
        captured = typeof data === "string" ? data : await data.text();
      },
      close: async () => undefined
    })
  };
}

const realDocument = (globalThis as any).document;
beforeEach(() => {
  captured = "";
  savedDoc = makeDoc();
  stubDocument();
  setFileHandle(null);
});
afterEach(() => {
  (globalThis as any).document = realDocument;
  setFileHandle(null);
});

describe("writeBackFile", () => {
  it("returns no-handle when there is no active handle", async () => {
    setFileHandle(null);
    const res = await writeBackFile(savedDoc);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("no-handle");
  });

  it("atomically rewrites the file when permission is granted", async () => {
    setFileHandle(fakeHandle("granted"));
    const res = await writeBackFile(savedDoc);
    expect(res.ok).toBe(true);
    expect(captured).toContain('<script id="design-doc"');
    expect(captured).toContain("My Design");
  });

  it("refuses when permission is denied", async () => {
    setFileHandle(fakeHandle("denied"));
    const res = await writeBackFile(savedDoc);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("permission:denied");
  });

  it("writes into an empty file on the first activation", async () => {
    // A freshly created file has no contents to back up. Treating that as
    // "backup unavailable" refused the very first write into it.
    setFileHandle({
      ...fakeHandle("granted"),
      getFile: async () => ({ text: async () => "" })
    });
    const res = await writeBackFile(savedDoc);
    expect(res.ok).toBe(true);
    expect(captured).toContain('<script id="design-doc"');
  });

  it("refuses to overwrite when the pre-write copy cannot be taken", async () => {
    // Auto-save is unprompted: it rewrites the file every few seconds whether or
    // not the user touches anything. Overwriting on top of no recoverable copy is
    // the one combination that can lose work with no user action at all, so the
    // write is refused and the file is left exactly as it was.
    setFileHandle({
      ...fakeHandle("granted"),
      getFile: async () => {
        throw new Error("QuotaExceededError");
      }
    });
    const res = await writeBackFile(savedDoc);
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/^backup-unavailable:/);
    expect(captured).toBe("");
  });
});

describe("saveAsCopyName", () => {
  it("appends the copy suffix for both document spellings", () => {
    expect(saveAsCopyName("design.fish.html")).toBe("design-copy.fish.html");
    expect(saveAsCopyName("design.html")).toBe("design-copy.fish.html");
    // `.htm` was missed by the old `\.html$` regex, so Save As offered the
    // original name and overwrote the file it meant to copy.
    expect(saveAsCopyName("design.htm")).toBe("design-copy.fish.html");
  });
});

describe("pickWritebackFile", () => {
  const install = (impl: unknown) => {
    (globalThis as any).showOpenFilePicker = impl;
    return () => {
      delete (globalThis as any).showOpenFilePicker;
    };
  };

  it("opens an existing file instead of creating one, and does not adopt it yet", async () => {
    // Two regressions at once. Activation used `saveInPlace` →
    // `showSaveFilePicker`, so turning auto-save on silently saved a *copy* and
    // then wrote to that copy forever while the tab showed the original. And the
    // handle must stay uninstalled until the content check passes: adopting it
    // first would let one wrong click redirect every later auto-save.
    let savePickerCalled = false;
    (globalThis as any).showSaveFilePicker = () => {
      savePickerCalled = true;
      return Promise.resolve(fakeHandle("granted"));
    };
    const restore = install(() => Promise.resolve([fakeHandle("granted")]));
    try {
      const res = await pickWritebackFile();
      expect(res.ok).toBe(true);
      expect(res.name).toBe("my.fish.html");
      expect(res.handle).toBeTruthy();
      expect(savePickerCalled).toBe(false);
      expect(getFileHandle()).toBeNull();
    } finally {
      restore();
      delete (globalThis as any).showSaveFilePicker;
    }
  });

  it("reports the browser cannot pick a file rather than falling back to save-as", async () => {
    const restore = install(undefined);
    try {
      const res = await pickWritebackFile();
      expect(res.ok).toBe(false);
      expect(res.reason).toBe("no-open-picker");
      expect(getFileHandle()).toBeNull();
    } finally {
      restore();
    }
  });

  it("treats a cancelled picker as a no-op", async () => {
    const restore = install(() => Promise.reject(Object.assign(new Error("nope"), { name: "AbortError" })));
    try {
      const res = await pickWritebackFile();
      expect(res.ok).toBe(false);
      expect(res.reason).toBe("aborted");
      expect(getFileHandle()).toBeNull();
    } finally {
      restore();
    }
  });
});

describe("verifyPickedFile", () => {
  const wrap = (body: string) =>
    `<!DOCTYPE html><html><head>\n<script id="design-doc" type="application/json">\n${body}\n</script>\n</head><body></body></html>`;

  const handleWith = (text: string) => ({
    name: "picked.fish.html",
    getFile: async () => ({ text: async () => text })
  }) as any;

  const docHtml = (doc: DesignDocument) => wrap(JSON.stringify(doc, null, 2).replace(/</g, "\\u003c"));
  // The baseline `verifyPickedFile` holds a pick against is the tab's own file
  // text — see `payloadHashFromHtml`.
  const hashOf = (html: string) => payloadHashFromHtml(html);
  const EMPTY_BLOCK = '<script id="design-doc" type="application/json"></script>';

  it("accepts this tab's document under this tab's name", async () => {
    const html = docHtml(makeDoc());
    const res = await verifyPickedFile(handleWith(html), hashOf(html), "picked.fish.html");
    expect(res.ok).toBe(true);
  });

  it("refuses a file holding a different document", async () => {
    // The point of the whole check: picking the wrong file must not silently
    // become the write-back target.
    const other = { ...makeDoc(), name: "Somebody Else's Design" } as DesignDocument;
    const res = await verifyPickedFile(handleWith(docHtml(other)), hashOf(docHtml(makeDoc())));
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("content-mismatch");
  });

  it("accepts the same file after an external tool rewrote it", async () => {
    // A CLI `fish apply` or an editor changes the bytes but leaves the shell's
    // `fish:fileId` stamp. Refusing that made the user's own file unlinkable;
    // the stamp plus the name is the proof it is still the same file.
    const modified = docHtml({ ...makeDoc(), name: "Edited by CLI" });
    const stamped = modified.replace("<head>", '<head><meta name="fish:fileId" content="file_same">');
    const baseline = hashOf(docHtml(makeDoc()));
    const res = await verifyPickedFile(
      handleWith(stamped),
      baseline,
      "picked.fish.html",
      "file_same"
    );
    expect(res.ok).toBe(true);
  });

  it("still refuses a file whose embedded id is another file's", async () => {
    const modified = docHtml({ ...makeDoc(), name: "Edited by CLI" });
    const stamped = modified.replace("<head>", '<head><meta name="fish:fileId" content="file_other">');
    const res = await verifyPickedFile(
      handleWith(stamped),
      hashOf(docHtml(makeDoc())),
      "picked.fish.html",
      "file_same"
    );
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("content-mismatch");
  });

  it("still enforces the name when the id matches", async () => {
    const modified = docHtml({ ...makeDoc(), name: "Edited by CLI" });
    const stamped = modified.replace("<head>", '<head><meta name="fish:fileId" content="file_same">');
    const res = await verifyPickedFile(
      handleWith(stamped),
      hashOf(docHtml(makeDoc())),
      "another.fish.html",
      "file_same"
    );
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("name-mismatch");
  });

  it("refuses something that is not a FISH document", async () => {
    const res = await verifyPickedFile(handleWith("<html><body>hello</body></html>"), "abc123");
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("not-a-fish-file");
  });

  it("refuses when the file cannot be read", async () => {
    const res = await verifyPickedFile({ name: "x.fish.html" } as any, "abc123");
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("cannot-read");
  });

  it("has nothing to prove when there is no baseline at all", async () => {
    // Only reachable outside a browser; a real page always has one.
    expect((await verifyPickedFile({ name: "x.fish.html" } as any, undefined)).ok).toBe(true);
  });

  it("an empty shell refuses a file that already has work in it", async () => {
    // The regression this whole check exists for: opening the freshly built
    // shell and picking any `.fish.html` on disk used to adopt it — and then
    // overwrite it — because an empty document gave us no baseline to compare.
    const res = await verifyPickedFile(handleWith(docHtml(makeDoc())), hashOf(EMPTY_BLOCK));
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("content-mismatch");
  });

  it("an empty shell accepts another empty shell of the same name", async () => {
    const res = await verifyPickedFile(handleWith(EMPTY_BLOCK), hashOf(EMPTY_BLOCK), "picked.fish.html");
    expect(res.ok).toBe(true);
  });

  it("an empty shell refuses an equally empty file under another name", async () => {
    // The regression: content proves "the same document", not "the same file",
    // and every empty shell hashes alike — so without the name the shell could
    // adopt and silently overwrite any empty file on disk, while a
    // content-bearing file could only ever adopt itself.
    const res = await verifyPickedFile(handleWith(EMPTY_BLOCK), hashOf(EMPTY_BLOCK), "index.html");
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("name-mismatch");
  });

  it("refuses a handle carrying no name when one is required", async () => {
    // A handle without a name cannot be shown to be this file. Real File System
    // Access handles always carry one; this guards the stand-ins too.
    const res = await verifyPickedFile(
      {
        getFile: async () => ({ text: async () => EMPTY_BLOCK })
      } as any,
      hashOf(EMPTY_BLOCK),
      "index.html"
    );
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("name-mismatch");
  });

  it("skips the name check when the tab is not a real file", async () => {
    // The dev bundle route (`/__fish_bundle__`) has no file name to hold against
    // — checking against a route name would refuse every pick in dev.
    const res = await verifyPickedFile(handleWith(EMPTY_BLOCK), hashOf(EMPTY_BLOCK));
    expect(res.ok).toBe(true);
  });
});

describe("restored handle identity", () => {
  const wrap = (body: string) =>
    `<!DOCTYPE html><html><head>\n<script id="design-doc" type="application/json">\n${body}\n</script>\n</head><body></body></html>`;
  const htmlOf = (name: string) =>
    wrap(JSON.stringify({ ...makeDoc(), name }, null, 2).replace(/</g, "\\u003c"));
  const handleFor = (file: string, name: string) =>
    ({ name, getFile: async () => ({ text: async () => file }) }) as any;

  it("keeps a restored handle that really is this tab's file", async () => {
    const file = htmlOf("Mine");
    setFileHandle(handleFor(file, "copy.fish.html"));
    const res = await verifyRestoredHandle(
      "file_keep",
      payloadHashFromHtml(file),
      "copy.fish.html"
    );
    expect(res.ok).toBe(true);
    expect(getFileHandle()).not.toBeNull();
  });

  it("drops a restored handle that belongs to the file this one was copied from", async () => {
    // The regression: the `fish:fileId` stamp travels with the bytes, so a copy
    // looks up the original's handle — and re-arming write-back on it rewrote
    // the original on the next auto-save. Content cannot separate the two yet
    // (nothing has been edited), so the name is the only signal.
    const copy = htmlOf("Original");
    setFileHandle(handleFor(copy, "original.fish.html"));
    await persistHandle("file_copy");
    const res = await verifyRestoredHandle("file_copy", payloadHashFromHtml(copy), "copy.fish.html");
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("name-mismatch");
    expect(getFileHandle()).toBeNull();
    // Forgotten, not merely uninstalled: leaving the row behind would re-arm
    // the same wrong target on the next reload.
    await loadHandle("file_copy");
    expect(getFileHandle()).toBeNull();
  });

  it("drops a restored handle whose file has moved on", async () => {
    setFileHandle(handleFor(htmlOf("Edited elsewhere"), "same-name.fish.html"));
    const res = await verifyRestoredHandle(
      "file_moved",
      payloadHashFromHtml(htmlOf("As opened here")),
      "same-name.fish.html"
    );
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("content-mismatch");
    expect(getFileHandle()).toBeNull();
  });

  it("drops a restored handle it cannot read", async () => {
    // Such a handle cannot take the pre-write backup either, so auto-save was
    // never going to write through it.
    setFileHandle({ name: "gone.fish.html" } as any);
    const res = await verifyRestoredHandle(
      "file_gone",
      payloadHashFromHtml(htmlOf("x")),
      "gone.fish.html"
    );
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("cannot-read");
    expect(getFileHandle()).toBeNull();
  });

  it("has nothing to verify when no handle was restored", async () => {
    expect(await verifyRestoredHandle("file_none", "hash", "a.fish.html")).toEqual({
      ok: false,
      reason: "no-handle"
    });
  });
});

describe("handle persistence", () => {
  it("persists and restores a handle across the session", async () => {
    const h = fakeHandle("granted");
    setFileHandle(h);
    await persistHandle("fish_test");
    setFileHandle(null);
    expect(getFileHandle()).toBeNull();
    await loadHandle("fish_test");
    expect(getFileHandle()).not.toBeNull();
  });

  it("query/request permission reflect the handle state", async () => {
    setFileHandle(fakeHandle("prompt"));
    expect(await queryWritebackPermission()).toBe("prompt");
    expect(await requestWritebackPermission()).toBe("prompt");
    setFileHandle(null);
    expect(await queryWritebackPermission()).toBe("unsupported");
  });
});
