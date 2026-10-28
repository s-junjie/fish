import { describe, it, expect } from "vitest";
import { normalizeDesignDocument } from "../src/core/dsl/normalize";
import { MemoryBackend } from "../src/core/persistence/backend";
import { createTimelineStore } from "../src/core/persistence/timeline";
import { createAssetStore } from "../src/core/persistence/assets";
import { createRecoveryStore } from "../src/core/persistence/recovery";
import { AutosaveController } from "../src/core/persistence/autosave-controller";
import { EditorStore } from "../src/core/store/editor-store";
import type { DesignDocument, DesignStyle, PaintStyle } from "../src/core/dsl/types";

const PAINT_STYLES: DesignStyle[] = [
  {
    id: "s_solid",
    name: "Brand",
    styleType: "paint",
    paints: [
      { type: "solid", color: "#3E63DD" },
      { type: "linear-gradient", from: "#FF0000", to: "#00FF00", angle: 45 }
    ]
  }
];

function makeDoc(): DesignDocument {
  return {
    fileId: "fish_test",
    id: "doc_x",
    version: "0.1",
    name: "d",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    canvas: { width: 100, height: 100, unit: "px", background: { type: "solid", color: "#000" } },
    elements: [
      {
        id: "r1",
        type: "rect",
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        fillStyleId: "s_solid",
        fills: JSON.parse(JSON.stringify((PAINT_STYLES[0] as PaintStyle).paints))
      }
    ],
    styles: JSON.parse(JSON.stringify(PAINT_STYLES))
  } as unknown as DesignDocument;
}

describe("paint style colour survives normalization (load / restore / edit)", () => {
  it("keeps solid + gradient colours intact", () => {
    const { document: doc } = normalizeDesignDocument(makeDoc());
    const solid = doc.styles!.find((s) => s.id === "s_solid")! as PaintStyle;

    expect(solid.paints).toHaveLength(2);
    expect((solid.paints[0] as any).color).toBe("#3E63DD");
    expect((solid.paints[1] as any).type).toBe("linear-gradient");
    expect((solid.paints[1] as any).from).toBe("#FF0000");
    expect((solid.paints[1] as any).to).toBe("#00FF00");
    expect((solid.paints[1] as any).angle).toBe(45);
  });

  it("restore (version commit + recover) keeps the paint style colours", async () => {
    const backend = new MemoryBackend();
    const store = new EditorStore(makeDoc());
    const controller = new AutosaveController({
      getDoc: () => store.getDoc(),
      subscribe: (cb: (doc: DesignDocument) => void) => store.subscribe(cb),
      recovery: createRecoveryStore(backend),
      assets: createAssetStore(backend),
      timeline: createTimelineStore(backend),
      historySubscribe: (cb: (doc: DesignDocument) => void) => store.onHistory(cb),
      applyDoc: (doc: DesignDocument) => store.commit(doc),
      fileId: () => "fish_test",
      mergeWindowMs: 0
    } as never);

    await controller.commitVersion({ named: true, label: "with color styles" });

    // Mutate the live doc so a restore has something to undo.
    const stripped = makeDoc();
    delete (stripped as any).styles;
    store.commit(stripped);
    expect(store.getDoc().styles).toBeUndefined();

    const versions = await controller.listVersions();
    const target = versions.find((v) => v.label === "with color styles")!;
    await controller.restoreVersion(target.id);

    const restored = store.getDoc();
    const solid = restored.styles!.find((s) => s.id === "s_solid")! as PaintStyle;
    expect(solid.paints).toHaveLength(2);
    expect((solid.paints[0] as any).color).toBe("#3E63DD");
    expect((solid.paints[1] as any).type).toBe("linear-gradient");
    expect((solid.paints[1] as any).from).toBe("#FF0000");
  });
});
