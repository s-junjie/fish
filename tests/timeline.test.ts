import { describe, it, expect } from "vitest";
import { MemoryBackend } from "../src/core/persistence/backend";
import {
  createTimelineStore,
  applyRetention,
  type RetentionPolicy,
  type VersionRecord
} from "../src/core/persistence/timeline";
import { createAssetStore } from "../src/core/persistence/assets";
import { createRecoveryStore } from "../src/core/persistence/recovery";
import { AutosaveController } from "../src/core/persistence/autosave-controller";
import { EditorStore } from "../src/core/store/editor-store";
import type { DesignDocument, AssetRef } from "../src/core/dsl/types";

const asset = { id: "a1", name: "img", uri: "data:image/png;base64,AAAA" } as unknown as AssetRef;

function makeDoc(name: string): DesignDocument {
  return {
    fileId: "fish_test",
    id: "doc_x",
    version: "0.1",
    name,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    canvas: { width: 100, height: 100, unit: "px", background: { type: "solid", color: "#000" } },
    elements: [{ id: "r1", type: "rect", x: 0, y: 0, width: 10, height: 10 }],
    assets: [asset]
  } as unknown as DesignDocument;
}

function makeVersion(
  id: string,
  createdAt: string,
  opts: { named?: boolean; assetHashes?: string[]; sizeBytes?: number; kind?: VersionRecord["kind"] } = {}
): VersionRecord {
  return {
    id,
    docKey: "fish_test",
    forkId: "fish_test",
    fileId: "fish_test",
    kind: opts.kind ?? (opts.named ? "named" : "auto"),
    named: opts.named ?? false,
    createdAt,
    // Snapshot form: bitmaps live in the asset store, keyed by hash.
    doc: { ...makeDoc(id), assets: [] },
    assetHashes: opts.assetHashes ?? [],
    sizeBytes: opts.sizeBytes ?? 1000
  };
}

const HOUR = 3600 * 1000;

describe("applyRetention (Time-Machine gradient)", () => {
  it("keeps the newest N and thins older ones to one-per-bucket", async () => {
    const timeline = createTimelineStore(new MemoryBackend());
    const assets = createAssetStore(new MemoryBackend());
    const base = Date.parse("2026-01-01T00:00:00Z");
    // 12 versions, 20 min apart (3 per hour bucket), all unnamed.
    for (let i = 0; i < 12; i++) {
      await timeline.put(makeVersion(`v${i}`, new Date(base + (i * HOUR) / 3).toISOString()));
    }
    const policy: RetentionPolicy = { keepRecent: 3, maxVersions: 50, maxBytes: 1e9, thinMs: HOUR };
    await applyRetention(timeline, assets, "fish_test", policy);
    const kept = await timeline.list("fish_test");
    const ids = kept.map((v) => v.id);
    // newest 3 always kept
    expect(ids).toContain("v11");
    expect(ids).toContain("v10");
    expect(ids).toContain("v9");
    // older ones thinned to one per hour bucket: v8 (h2), v5 (h1), v2 (h0)
    expect(ids).toEqual(["v11", "v10", "v9", "v8", "v5", "v2"]);
  });

  it("never prunes named versions even past the cap", async () => {
    const timeline = createTimelineStore(new MemoryBackend());
    const assets = createAssetStore(new MemoryBackend());
    // 1 named (oldest) + 8 unnamed, all recent so no thinning by age alone.
    await timeline.put(makeVersion("named", new Date(Date.now() - 1000).toISOString(), { named: true }));
    for (let i = 0; i < 8; i++) {
      await timeline.put(makeVersion(`u${i}`, new Date(Date.now() + i).toISOString()));
    }
    const policy: RetentionPolicy = { keepRecent: 2, maxVersions: 4, maxBytes: 1e9, thinMs: HOUR };
    await applyRetention(timeline, assets, "fish_test", policy);
    const kept = await timeline.list("fish_test");
    expect(kept.map((v) => v.id)).toContain("named");
    expect(kept.length).toBeLessThanOrEqual(4);
  });

  it("prunes oldest unnamed first under the hard version cap", async () => {
    const backend = new MemoryBackend();
    const timeline = createTimelineStore(backend);
    const assets = createAssetStore(backend);
    for (let i = 0; i < 10; i++) {
      await timeline.put(makeVersion(`v${i}`, new Date(Date.now() + i).toISOString()));
    }
    // keepRecent >= total so thinning never engages: the hard cap is the only
    // binding constraint here.
    const policy: RetentionPolicy = { keepRecent: 10, maxVersions: 3, maxBytes: 1e9, thinMs: 1e12 };
    await applyRetention(timeline, assets, "fish_test", policy);
    const kept = await timeline.list("fish_test");
    expect(kept.length).toBe(3);
    // newest 3 survive, oldest (v0..v6) gone
    expect(kept.map((v) => v.id)).toContain("v9");
    expect(kept.map((v) => v.id)).not.toContain("v0");
  });

  it("releases asset references of pruned versions and deletes unreferenced assets", async () => {
    const backend = new MemoryBackend();
    const timeline = createTimelineStore(backend);
    const assets = createAssetStore(backend);
    // Two distinct assets, H and G. Rows are keyed by the *content hash*, so the
    // ref-count lifecycle must use the hash `put` returns, not the raw uri.
    const H = await assets.put({ id: "a", uri: "H" } as unknown as AssetRef);
    const G = await assets.put({ id: "b", uri: "G" } as unknown as AssetRef);
    // 5 versions all reference H; G referenced only by the oldest. Acquire refs
    // to simulate the commitVersion lifecycle (each version owns its hashes).
    for (let i = 0; i < 5; i++) await assets.acquire([H]);
    await assets.acquire([G]);
    for (let i = 0; i < 5; i++) {
      const hashes = i === 0 ? [H, G] : [H];
      await timeline.put(makeVersion(`v${i}`, new Date(Date.now() + i).toISOString(), { assetHashes: hashes }));
    }
    const policy: RetentionPolicy = { keepRecent: 1, maxVersions: 2, maxBytes: 1e9, thinMs: 1e12 };
    await applyRetention(timeline, assets, "fish_test", policy);
    // 3 versions pruned: their H refs released (5 -> 2 retained), G released once and deleted.
    const rows = (await backend.getAll("assets")) as { key: string; refCount: number; ref: AssetRef }[];
    const h = rows.find((r) => r.ref.uri === "H");
    expect(h?.refCount).toBe(2);
    // G was only on the pruned oldest -> deleted entirely
    expect(rows.find((r) => r.ref.uri === "G")).toBeUndefined();
  });
});

describe("controller version timeline", () => {
  function makeTimelineController(doc: DesignDocument, extra: Record<string, unknown> = {}) {
    const backend = new MemoryBackend();
    const recovery = createRecoveryStore(backend);
    const assets = createAssetStore(backend);
    const timeline = createTimelineStore(backend);
    let current = doc;
    let applied: DesignDocument | null = null;
    const controller = new AutosaveController({
      getDoc: () => current,
      subscribe: () => () => undefined,
      recovery,
      assets,
      timeline,
      historySubscribe: () => () => undefined,
      applyDoc: (d: DesignDocument) => {
        applied = d;
      },
      fileId: () => "fish_test",
      mergeWindowMs: 0,
      ...extra
    } as never);
    return {
      controller,
      timeline,
      getApplied: () => applied,
      /** Mutate the document between commits. */
      set: (d: DesignDocument) => {
        current = d;
      }
    };
  }

  it("commitVersion creates ordered versions; named never merge", async () => {
    const doc = makeDoc("A");
    const { controller, timeline } = makeTimelineController(doc);
    await controller.commitVersion({ named: true, label: "v1" });
    await controller.commitVersion({ named: true, label: "v2" });
    const list = await timeline.list("fish_test");
    expect(list.length).toBe(2);
    expect(list[0].label).toBe("v2"); // newest first
    expect(list[1].label).toBe("v1");
  });

  it("rapid unnamed commits within the merge window throttle into one, keeping its moment", async () => {
    // The window throttles, it must not overwrite: a version the panel already
    // showed has to keep the content it was born with, otherwise restoring it
    // restores the merge moment instead of the moment it names.
    const doc = makeDoc("A");
    const { controller, timeline, set } = makeTimelineController(doc, {
      mergeWindowMs: 5 * 60 * 1000
    });
    await controller.commitVersion();
    set(makeDoc("B"));
    await controller.commitVersion();
    const list = await timeline.list("fish_test");
    expect(list.length).toBe(1);
    expect((list[0].doc as DesignDocument).name).toBe("A");
  });

  it("every version stays visible when the document changes between commits", async () => {
    // The regression: commitVersion resolved the fork per call, so each commit
    // landed on a docKey derived from that moment's content and listVersions()
    // — which reads the *current* docKey — saw at most one of them.
    const { controller, set } = makeTimelineController(makeDoc("step-0"));
    for (let i = 1; i <= 5; i++) {
      set(makeDoc(`step-${i}`));
      await controller.commitVersion();
    }
    expect(await controller.listVersions()).toHaveLength(5);
  });

  it("does not merge the pre-restore snapshot into the version being restored", async () => {
    // The pre-restore record is not an `auto` version, so the merge window must
    // not collapse it — doing so overwrote the very version the user restores
    // from, i.e. it deleted the history the snapshot exists to protect.
    const { controller, set, getApplied } = makeTimelineController(makeDoc("v1"), {
      mergeWindowMs: 5 * 60 * 1000
    });
    await controller.commitVersion({ named: true, label: "v1" });
    set(makeDoc("v2"));
    await controller.commitVersion({ named: true, label: "v2" });

    const [newest] = await controller.listVersions();
    await controller.restoreVersion(newest.id);

    expect((await controller.listVersions()).map((v) => v.label)).toEqual([
      "Before restore",
      "v2",
      "v1"
    ]);
    expect(getApplied()).not.toBeNull();
  });

  it("names the record a restore arms as the restored state", async () => {
    // A restore's apply notifies history, so the debounced record that lands
    // 800ms later IS the restored document: claiming its kind here keeps one
    // document state to one version, and the row reads "Restored" instead of
    // looking like the next autosave. The harness's `applyDoc` notifies
    // nothing, so the record it would arm is taken by hand.
    const { controller, set } = makeTimelineController(makeDoc("v1"), {
      mergeWindowMs: 5 * 60 * 1000
    });
    await controller.commitVersion({ named: true, label: "v1" });
    set(makeDoc("v2"));
    await controller.commitVersion({ named: true, label: "v2" });

    const [newest] = await controller.listVersions();
    expect(await controller.restoreVersion(newest.id)).toBe(true);

    await controller.commitVersion();
    expect((await controller.listVersions()).map((v) => v.kind)).toEqual([
      "restored",
      "pre-restore",
      "named",
      "named"
    ]);
  });

  it("restoreVersion rehydrates and applies via applyDoc", async () => {
    const doc = makeDoc("A");
    const { controller, timeline, getApplied } = makeTimelineController(doc);
    await controller.commitVersion({ named: true, label: "snapshot" });
    const list = await timeline.list("fish_test");
    await controller.restoreVersion(list[0].id);
    const applied = getApplied();
    expect(applied).not.toBeNull();
    expect((applied!.assets?.[0] as AssetRef).uri).toBe("data:image/png;base64,AAAA");
  });

  it("records a version for a plain commit, not only for a gesture", async () => {
    // The regression: `commit()` notifies history (arming the version timer)
    // immediately before notifying subscribers (which resets the recovery
    // timers). When the reset also cancelled the version timer, only drags —
    // which end without a follow-up notify — ever produced a version, so the
    // timeline stayed empty for inspector edits, renames and scripted writes.
    const store = new EditorStore(makeDoc("A"));
    const { controller } = makeTimelineController(makeDoc("A"), {
      getDoc: () => store.getDoc(),
      subscribe: (cb: (d: DesignDocument) => void) => store.subscribe(cb),
      historySubscribe: (cb: (d: DesignDocument) => void) => store.onHistory(cb)
    });
    controller.enable();

    store.commit({ ...store.getDoc(), name: "Edited" } as DesignDocument);
    await new Promise((r) => setTimeout(r, 1000));

    expect(await controller.listVersions()).toHaveLength(1);
    controller.disable();
  });

  it("exportVersion writes a standalone file via the save picker", async () => {
    const doc = makeDoc("A");
    const writes: string[] = [];
    const fakeHandle = {
      createWritable: async () => ({
        write: async (s: string) => writes.push(s),
        close: async () => undefined
      })
    };
    (globalThis as { showSaveFilePicker?: unknown }).showSaveFilePicker = async () => fakeHandle;
    const { controller, timeline } = makeTimelineController(doc);
    await controller.commitVersion({ named: true, label: "v1" });
    const list = await timeline.list("fish_test");
    const res = await controller.exportVersion(list[0].id);
    expect(res.ok).toBe(true);
    expect(writes.length).toBe(1);
    expect(writes[0]).toContain("design-doc");
    delete (globalThis as { showSaveFilePicker?: unknown }).showSaveFilePicker;
  });
});
