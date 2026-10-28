import { beforeEach, describe, expect, it } from "vitest";
import type { DesignDocument, DesignElement } from "../src/core/dsl/types";
import {
  fontStatusOf,
  fontStatusSnapshot,
  noteWebFontFamily,
  refreshFontStatus,
  resetFontStatus,
  setFontWidthProbe,
  subscribeFontStatus,
  textFontStatus
} from "../src/core/fonts/font-status";

/**
 * A stand-in for the machine's font list.
 *
 * It resolves a stack the way CSS does — first name that exists, else the next —
 * so a probe of `"Nope", monospace` answers with monospace's width and the
 * module under test has to work out that nothing was substituted.
 */
const BASELINE: Record<string, number> = {
  monospace: 100,
  serif: 90,
  "sans-serif": 70,
  "system-ui": 70
};

function fakeProbe(installed: Record<string, number>) {
  const table = { ...BASELINE, ...installed };
  const calls: string[] = [];
  const probe = (cssFont: string): number => {
    calls.push(cssFont);
    const stack = cssFont.replace(/^\S+\s+\S+\s+/, "");
    for (const raw of stack.split(",")) {
      const name = raw.trim().replace(/^"|"$/g, "").replace(/\\"/g, '"');
      const width = table[name];
      if (width !== undefined) return width;
    }
    // What a browser does with a name it cannot resolve: the default sans.
    return table["sans-serif"];
  };
  return { probe, calls };
}

const doc = (elements: DesignElement[], fonts?: { family: string; src?: string }[]): DesignDocument =>
  ({
    version: "0.1",
    name: "Fonts",
    canvas: { width: 375, height: 400 },
    pages: [{ id: "page_1", name: "Page 1", canvas: { width: 375, height: 400 }, children: elements }],
    activePageId: "page_1",
    ...(fonts ? { fonts } : {})
  }) as unknown as DesignDocument;

const text = (id: string, style: Record<string, unknown>, spans?: unknown[]): DesignElement =>
  ({
    id,
    name: id,
    type: "text",
    x: 0,
    y: 0,
    width: 200,
    height: 24,
    content: "Hello",
    style: { fontSize: 16, ...style },
    ...(spans ? { spans } : {})
  }) as unknown as DesignElement;

beforeEach(() => {
  resetFontStatus();
  setFontWidthProbe(null);
});

describe("fontStatusOf", () => {
  it("never asks about a generic keyword, which resolves by definition", () => {
    const { probe, calls } = fakeProbe({});
    setFontWidthProbe(probe);
    expect(fontStatusOf("system-ui")).toBe("installed");
    expect(fontStatusOf("sans-serif")).toBe("installed");
    expect(fontStatusOf("-apple-system")).toBe("installed");
    expect(calls).toEqual([]);
  });

  it("reads an installed face off the two-baseline probe", () => {
    setFontWidthProbe(fakeProbe({ Inter: 71.3, "PingFang SC": 66 }).probe);
    expect(fontStatusOf("Inter")).toBe("installed");
    expect(fontStatusOf("PingFang SC")).toBe("installed");
  });

  it("calls a family installed when it repeats the OS default's width", () => {
    // The case a single baseline cannot answer: `SF Pro` measures exactly like
    // `sans-serif` on this machine, and comparing against a generic would mark
    // the one face every macOS document is set in as missing.
    setFontWidthProbe(fakeProbe({ "SF Pro": 70 }).probe);
    expect(fontStatusOf("SF Pro")).toBe("installed");
  });

  it("calls a name that resolves to nothing missing", () => {
    setFontWidthProbe(fakeProbe({ Inter: 71.3 }).probe);
    expect(fontStatusOf("Nope Sans")).toBe("missing");
  });

  it("does not fire the probe twice for the same family", () => {
    const { probe, calls } = fakeProbe({ Inter: 71.3 });
    setFontWidthProbe(probe);
    fontStatusOf("Inter");
    fontStatusOf("Inter");
    // Two measurements per decision (one per baseline), not four.
    expect(calls).toHaveLength(4);
  });

  it("prefers no answer to a wrong one when the platform cannot measure", () => {
    // A false `missing` blocks editing (Phase 3); a false `installed` costs a
    // substitute nobody promised to replace.
    setFontWidthProbe(() => null);
    expect(fontStatusOf("Nope Sans")).toBe("installed");
  });

  it("treats a family the web service has as remote, not missing", () => {
    setFontWidthProbe(fakeProbe({}).probe);
    noteWebFontFamily("Ghost", "remote");
    expect(fontStatusOf("Ghost")).toBe("remote");
    noteWebFontFamily("Ghost", "absent");
    expect(fontStatusOf("Ghost")).toBe("missing");
  });
});

describe("the document's families", () => {
  it("collects element styles, span overrides and text styles", () => {
    setFontWidthProbe(fakeProbe({ Inter: 71.3, "PingFang SC": 66 }).probe);
    const document = doc(
      [
        text("a", { fontFamily: "Inter" }),
        text("b", { fontFamily: "Inter" }, [{ text: "run", style: { fontFamily: "Nope Sans" } }]),
        text("c", { fontFamily: "PingFang SC" })
      ],
      []
    );
    (document as any).styles = [{ id: "s1", styleType: "text", style: { fontFamily: "Inter" } }];

    refreshFontStatus(document);

    const snapshot = Object.fromEntries(fontStatusSnapshot().map((entry) => [entry.family, entry]));
    expect(snapshot.Inter).toMatchObject({ status: "installed", texts: 2, spans: 0, styles: 1 });
    expect(snapshot["Nope Sans"]).toMatchObject({ status: "missing", texts: 0, spans: 1 });
    expect(snapshot["PingFang SC"]).toMatchObject({ status: "installed", texts: 1 });
  });

  it("reads the family a pre-split stack names, not its fallback", () => {
    setFontWidthProbe(fakeProbe({ Inter: 71.3 }).probe);
    refreshFontStatus(doc([text("a", { fontFamily: "Inter, sans-serif" })]));
    expect(fontStatusSnapshot().map((entry) => entry.family)).toEqual(["Inter"]);
  });

  it("treats a family the file carries with a src as installed", () => {
    setFontWidthProbe(fakeProbe({}).probe);
    refreshFontStatus(
      doc([text("a", { fontFamily: "Carried" })], [{ family: "Carried", src: "data:font/woff2;base64,AA" }])
    );
    expect(fontStatusSnapshot()[0].status).toBe("installed");
  });

  it("tells subscribers only when an answer moved", () => {
    setFontWidthProbe(fakeProbe({ Inter: 71.3 }).probe);
    let calls = 0;
    const off = subscribeFontStatus(() => calls++);
    const document = doc([text("a", { fontFamily: "Inter" })]);
    refreshFontStatus(document);
    refreshFontStatus(document);
    expect(calls).toBe(1);
    refreshFontStatus(doc([text("a", { fontFamily: "Nope Sans" })]));
    expect(calls).toBe(2);
    off();
  });

  it("drops a family that left the document", () => {
    setFontWidthProbe(fakeProbe({ Inter: 71.3 }).probe);
    refreshFontStatus(doc([text("a", { fontFamily: "Nope Sans" })]));
    expect(fontStatusSnapshot()).toHaveLength(1);
    refreshFontStatus(doc([text("a", { fontFamily: "Inter" })]));
    expect(fontStatusSnapshot().map((entry) => entry.family)).toEqual(["Inter"]);
  });

  it("tells subscribers when a family leaves the list, even with no status moving", () => {
    // The list is a panel's content: a row that outlives the family it names is
    // a replacement that looks like it did not happen.
    setFontWidthProbe(fakeProbe({ Inter: 71.3 }).probe);
    let calls = 0;
    const off = subscribeFontStatus(() => calls++);
    refreshFontStatus(doc([text("a", { fontFamily: "Nope One" }), text("b", { fontFamily: "Nope Two" })]));
    expect(calls).toBe(1);
    refreshFontStatus(doc([text("a", { fontFamily: "Nope One" })]));
    expect(calls).toBe(2);
    expect(fontStatusSnapshot()).toHaveLength(1);
    off();
  });

  it("tells subscribers when the count behind a family changes", () => {
    setFontWidthProbe(fakeProbe({ Inter: 71.3 }).probe);
    let calls = 0;
    const off = subscribeFontStatus(() => calls++);
    refreshFontStatus(doc([text("a", { fontFamily: "Nope Sans" }), text("b", { fontFamily: "Nope Sans" })]));
    expect(calls).toBe(1);
    refreshFontStatus(doc([text("a", { fontFamily: "Nope Sans" }), text("b", { fontFamily: "Inter" })]));
    expect(calls).toBe(2);
    expect(fontStatusSnapshot().find((entry) => entry.family === "Nope Sans")?.texts).toBe(1);
    off();
  });

  it("stays quiet when a rebuild says exactly the same thing", () => {
    setFontWidthProbe(fakeProbe({ Inter: 71.3 }).probe);
    let calls = 0;
    const off = subscribeFontStatus(() => calls++);
    refreshFontStatus(doc([text("a", { fontFamily: "Nope Sans" })]));
    refreshFontStatus(doc([text("a", { fontFamily: "Nope Sans" })]));
    expect(calls).toBe(1);
    off();
  });
});

describe("textFontStatus", () => {
  it("says nothing about a text every one of its families can paint", () => {
    setFontWidthProbe(fakeProbe({ Inter: 71.3 }).probe);
    expect(textFontStatus(text("a", { fontFamily: "Inter" }))).toBeNull();
  });

  it("names the layer's family before a span's", () => {
    // A span stacks ON the layer: when the layer's own family is gone the whole
    // paragraph is a substitute, and reporting the span would name the smaller of
    // two problems.
    setFontWidthProbe(fakeProbe({ Inter: 71.3 }).probe);
    const el = text("a", { fontFamily: "Nope Sans" }, [{ text: "run", style: { fontFamily: "Also Nope" } }]);
    expect(textFontStatus(el)).toEqual({ family: "Nope Sans", status: "missing" });
  });

  it("finds a span the layer does not mention", () => {
    setFontWidthProbe(fakeProbe({ Inter: 71.3 }).probe);
    const el = text("a", { fontFamily: "Inter" }, [{ text: "run", style: { fontFamily: "Nope Sans" } }]);
    expect(textFontStatus(el)).toEqual({ family: "Nope Sans", status: "missing" });
  });

  it("stays silent about a stack that declared its own fallback", () => {
    // A pre-split document wrote `"Inter, sans-serif"` by hand: it says what a
    // substitution should look like, so the substitution IS the design. The same
    // boundary `fontDiagnostics` draws, from the same predicate — one question,
    // one answer. Files written since the split store the bare family, which is
    // what makes a family the author actually picked detectable.
    setFontWidthProbe(fakeProbe({}).probe);
    expect(textFontStatus(text("a", { fontFamily: "Nope Sans, sans-serif" }))).toBeNull();
  });

  it("ignores anything that is not a text", () => {
    const frame = { id: "f", type: "frame", x: 0, y: 0, width: 10, height: 10, children: [] } as DesignElement;
    expect(textFontStatus(frame)).toBeNull();
  });
});
