import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { DesignDocument } from "../src/core/dsl/types";
import { MemoryBackend } from "../src/core/persistence/backend";
import { createRecoveryStore } from "../src/core/persistence/recovery";
import { createAssetStore } from "../src/core/persistence/assets";
import { AutosaveController, type AutosaveStatus } from "../src/core/persistence/autosave-controller";
import { clearFileHandle, saveInPlace, setFileHandle } from "../src/core/data-bridge";
import { writeBackFile } from "../src/core/persistence/writeback";
import { FILE_CHANGED_REASON, fileStamp, setFileStamp } from "../src/core/persistence/file-stamp";
import { inspectExternalUpdate } from "../src/core/persistence/external-update";
import { stubDocument } from "./helpers/fake-document";

function makeDoc(name = "Mine"): DesignDocument {
  return {
    docId: "fish_test",
    id: "doc_x",
    version: "0.1",
    name,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
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

/**
 * A handle whose `lastModified` moves the way a real file's does: `close()`
 * commits the write, so the file the tab reads back is newer than the one it
 * compared against. Modelling that is the whole point — a stub that never moves
 * would make "we refuse our own next write" invisible.
 */
function fileHandle(mtime: number) {
  const state = { mtime, text: "<html>THEIR VERSION</html>", writes: 0 };
  return {
    state,
    handle: {
      name: "fish_test.fish.html",
      queryPermission: async () => "granted",
      requestPermission: async () => "granted",
      getFile: async () => ({ lastModified: state.mtime, text: async () => state.text }),
      createWritable: async () => ({
        write: async () => {
          state.writes++;
        },
        truncate: async () => undefined,
        close: async () => {
          state.mtime += 1000;
        }
      })
    }
  };
}

let restoreDocument: (() => void) | null = null;

beforeEach(() => {
  restoreDocument = stubDocument();
  setFileStamp(undefined);
  setFileHandle(null);
});

afterEach(() => {
  restoreDocument?.();
  restoreDocument = null;
  clearFileHandle();
  setFileStamp(undefined);
});

describe("a file changed by another program", () => {
  it("is not overwritten by auto-save", async () => {
    const { state, handle } = fileHandle(2_000);
    setFileHandle(handle);
    // What this tab last wrote. Anything else on disk since then came from
    // somewhere else: a sync client, another editor, an agent.
    setFileStamp(1_000);

    const res = await writeBackFile(makeDoc());

    expect(res.ok).toBe(false);
    expect(res.reason).toBe(FILE_CHANGED_REASON);
    expect(state.writes, "the other program's change is still on disk").toBe(0);
  });

  it("is overwritten only when the user says so", async () => {
    const { state, handle } = fileHandle(2_000);
    setFileHandle(handle);
    setFileStamp(1_000);

    const res = await writeBackFile(makeDoc(), { force: true });

    expect(res.ok).toBe(true);
    expect(state.writes).toBe(1);
  });

  it("does not block a write when the file still holds what this tab wrote", async () => {
    const { state, handle } = fileHandle(1_000);
    setFileHandle(handle);
    setFileStamp(1_000);

    expect((await writeBackFile(makeDoc())).ok).toBe(true);
    expect(state.writes).toBe(1);
  });

  it("does not block a write with no baseline to compare against", async () => {
    // A session that has neither written nor proved a handle knows nothing about
    // the file. Refusing there would turn one missing fact into a dead
    // auto-save for good.
    const { state, handle } = fileHandle(9_999);
    setFileHandle(handle);
    setFileStamp(undefined);

    expect((await writeBackFile(makeDoc())).ok).toBe(true);
    expect(state.writes).toBe(1);
  });

  it("moves the baseline with its own write, so the next flush is not a false conflict", async () => {
    // The failure this guards: record the stamp before the write, read a newer
    // mtime afterwards, and every single flush after the first reports a
    // conflict nobody can clear.
    const { handle } = fileHandle(1_000);
    setFileHandle(handle);
    setFileStamp(1_000);

    expect((await writeBackFile(makeDoc())).ok).toBe(true);
    expect(fileStamp()).toBe(2_000);

    expect((await writeBackFile(makeDoc())).ok).toBe(true);
  });

  it("is not overwritten by ⌘S either", async () => {
    // The guard lives in the writer because three paths reach it. This is the
    // one the auto-save layer does not own.
    const previousWindow = (globalThis as any).window;
    (globalThis as any).window = {
      location: {},
      showSaveFilePicker: async () => {
        throw new Error("the picker must not open: this tab already has its handle");
      }
    };
    try {
      const { state, handle } = fileHandle(2_000);
      setFileHandle(handle);
      setFileStamp(1_000);

      const res = await saveInPlace(makeDoc());

      expect(res.success).toBe(false);
      expect(res.error).toBe(FILE_CHANGED_REASON);
      expect(state.writes).toBe(0);
    } finally {
      (globalThis as any).window = previousWindow;
    }
  });
});

describe("the auto-save controller on a changed file", () => {
  function setup() {
    const backend = new MemoryBackend();
    const statuses: AutosaveStatus[] = [];
    const { state, handle } = fileHandle(2_000);
    setFileHandle(handle);
    setFileStamp(1_000);
    const controller = new AutosaveController({
      getDoc: () => makeDoc(),
      subscribe: () => () => undefined,
      recovery: createRecoveryStore(backend),
      assets: createAssetStore(backend),
      fileId: () => "fish_test",
      writebackEnabled: true,
      onStatus: (status) => statuses.push(status)
    });
    return { backend, controller, statuses, state };
  }

  it("stops writing and reports the conflict", async () => {
    const { backend, controller, statuses, state } = setup();
    await controller.ready();
    await controller.flushNow();

    expect(statuses.some((s) => s.kind === "file-conflict")).toBe(true);
    expect(state.writes).toBe(0);
    // Standing down is not the same as giving up the work: the snapshot the
    // same flush wrote is the only copy of these edits.
    expect(await backend.getAll("recovery")).toHaveLength(1);
  });

  it("stays stopped instead of retrying the same write", async () => {
    const { controller, state } = setup();
    await controller.ready();
    await controller.flushNow();
    expect(controller.isWritebackEnabled()).toBe(false);

    await controller.flushNow();

    expect(state.writes).toBe(0);
  });
});

describe("focus-time disk update inspection", () => {
  it("reports updated when local edits are clean and disk moved", async () => {
    const { handle } = fileHandle(2_000);
    const res = await inspectExternalUpdate({
      handle,
      baselineStamp: 1_000,
      dismissedMtime: null,
      hasLocalEdits: false
    });
    expect(res).toEqual({ status: "updated", mtime: 2_000 });
  });

  it("escalates to conflict when local edits exist", async () => {
    const { handle } = fileHandle(2_000);
    const res = await inspectExternalUpdate({
      handle,
      baselineStamp: 1_000,
      dismissedMtime: null,
      hasLocalEdits: true
    });
    expect(res).toEqual({ status: "conflict", mtime: 2_000 });
  });

  it("remembers dismissal per mtime and re-prompts when disk moves again", async () => {
    const { state, handle } = fileHandle(2_000);
    expect(
      await inspectExternalUpdate({
        handle,
        baselineStamp: 1_000,
        dismissedMtime: 2_000,
        hasLocalEdits: false
      })
    ).toEqual({ status: "dismissed", mtime: 2_000 });

    state.mtime = 3_000;
    expect(
      await inspectExternalUpdate({
        handle,
        baselineStamp: 1_000,
        dismissedMtime: 2_000,
        hasLocalEdits: false
      })
    ).toEqual({ status: "updated", mtime: 3_000 });
  });

  it("skips silently without prompting when read permission is not granted", async () => {
    const { handle } = fileHandle(2_000);
    handle.queryPermission = async () => "prompt";
    expect(
      await inspectExternalUpdate({
        handle,
        baselineStamp: 1_000,
        dismissedMtime: null,
        hasLocalEdits: false
      })
    ).toEqual({ status: "unchanged" });
  });
});
